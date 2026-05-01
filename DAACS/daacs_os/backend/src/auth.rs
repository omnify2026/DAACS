use aes_gcm_siv::{
    aead::{Aead, KeyInit},
    Aes256GcmSiv, Nonce,
};
use axum::extract::Path;
use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{domain::repository, jwt, AppState};

#[derive(Deserialize)]
pub struct RegisterBody {
    pub email: String,
    pub password: String,
    #[serde(default)]
    pub project_name: Option<String>,
    #[serde(default)]
    pub billing_track: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub email: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct ByokBody {
    #[serde(default)]
    pub byok_claude_key: Option<String>,
    #[serde(default)]
    pub byok_openai_key: Option<String>,
}

#[derive(Serialize)]
pub struct AuthUserInfo {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub agent_slots: i64,
    pub custom_agent_count: i64,
    pub billing_track: String,
    pub byok_has_claude_key: bool,
    pub byok_has_openai_key: bool,
}

#[derive(Serialize)]
pub struct ProjectMembershipInfo {
    pub project_id: String,
    pub project_name: String,
    pub role: String,
    pub is_owner: bool,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub user: AuthUserInfo,
    pub memberships: Vec<ProjectMembershipInfo>,
    pub access_token: String,
}

#[derive(Serialize)]
pub struct ErrorBody {
    pub detail: String,
}

#[derive(Serialize)]
pub struct ByokSaveResponse {
    pub status: String,
    pub billing_track: String,
    pub byok_has_claude_key: bool,
    pub byok_has_openai_key: bool,
    pub updated: serde_json::Value,
}

#[derive(Serialize)]
pub struct ByokStatusResponse {
    pub billing_track: String,
    pub byok_has_claude_key: bool,
    pub byok_has_openai_key: bool,
}

fn normalize_email(in_email: &str) -> String {
    in_email.trim().to_lowercase()
}

fn normalize_project_name(in_name: Option<&str>) -> String {
    let name = in_name.map(|s| s.trim()).unwrap_or("").trim();
    if name.is_empty() {
        "Default Project".to_string()
    } else {
        name.to_string()
    }
}

fn normalize_billing_track(in_track: Option<&str>) -> String {
    match in_track.map(str::trim).map(|track| track.to_lowercase()) {
        Some(track) if track == "byok" => "byok".to_string(),
        _ => "project".to_string(),
    }
}

fn canonical_billing_track(in_track: impl AsRef<str>) -> String {
    match in_track.as_ref().trim().to_lowercase().as_str() {
        "byok" => "byok".to_string(),
        _ => "project".to_string(),
    }
}

fn hash_password(in_password: &str) -> Result<String, argon2::password_hash::Error> {
    use argon2::password_hash::{PasswordHasher, SaltString};
    use rand_core::OsRng;
    let salt = SaltString::generate(&mut OsRng);
    let argon = argon2::Argon2::default();
    argon
        .hash_password(in_password.as_bytes(), &salt)
        .map(|h| h.to_string())
}

fn verify_password(in_password: &str, in_hash: &str) -> bool {
    use argon2::PasswordVerifier;
    let parsed = match argon2::PasswordHash::new(in_hash) {
        Ok(p) => p,
        Err(_) => return false,
    };
    argon2::Argon2::default()
        .verify_password(in_password.as_bytes(), &parsed)
        .is_ok()
}

fn issue_token(user_id: &str, email: &str, billing_track: &str) -> infra_error::AppResult<String> {
    let secret = jwt::jwt_secret()?;
    jwt::create_access_token_with_billing_track(
        user_id,
        email,
        Some(&canonical_billing_track(billing_track)),
        &secret,
    )
}

fn normalize_optional_secret(value: Option<&str>) -> Option<String> {
    let trimmed = value.map(str::trim).unwrap_or("");
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

const BYOK_CIPHERTEXT_VERSION: u8 = 1;
const BYOK_NONCE_LEN: usize = 12;

fn byok_encryption_key() -> infra_error::AppResult<[u8; 32]> {
    let secret = jwt::jwt_secret()?;
    let mut hasher = Sha256::new();
    hasher.update(secret.as_slice());
    hasher.update(b":daacs:byok-storage:v1");
    let digest = hasher.finalize();
    let mut key = [0_u8; 32];
    key.copy_from_slice(&digest);
    Ok(key)
}

fn encrypt_byok_secret(secret: &str) -> infra_error::AppResult<Vec<u8>> {
    let key = byok_encryption_key()?;
    let cipher = Aes256GcmSiv::new_from_slice(&key)
        .map_err(|e| infra_error::AppError::Message(format!("invalid BYOK cipher key: {e}")))?;
    let mut nonce = [0_u8; BYOK_NONCE_LEN];
    rand_core::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), secret.as_bytes())
        .map_err(|e| infra_error::AppError::Message(format!("BYOK encryption failed: {e}")))?;

    let mut stored = Vec::with_capacity(1 + BYOK_NONCE_LEN + ciphertext.len());
    stored.push(BYOK_CIPHERTEXT_VERSION);
    stored.extend_from_slice(&nonce);
    stored.extend_from_slice(&ciphertext);
    Ok(stored)
}

fn decrypt_byok_secret(raw: &[u8]) -> infra_error::AppResult<Option<String>> {
    if raw.is_empty() {
        return Ok(None);
    }

    if raw[0] != BYOK_CIPHERTEXT_VERSION {
        return Ok(std::str::from_utf8(raw)
            .ok()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string));
    }

    if raw.len() <= 1 + BYOK_NONCE_LEN {
        return Err(infra_error::AppError::Message(
            "BYOK ciphertext is truncated".into(),
        ));
    }

    let key = byok_encryption_key()?;
    let cipher = Aes256GcmSiv::new_from_slice(&key)
        .map_err(|e| infra_error::AppError::Message(format!("invalid BYOK cipher key: {e}")))?;
    let nonce_start = 1;
    let ciphertext_start = nonce_start + BYOK_NONCE_LEN;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&raw[nonce_start..ciphertext_start]),
            &raw[ciphertext_start..],
        )
        .map_err(|e| infra_error::AppError::Message(format!("BYOK decryption failed: {e}")))?;
    let secret = String::from_utf8(plaintext)
        .map_err(|e| infra_error::AppError::Message(format!("BYOK plaintext UTF-8 error: {e}")))?;

    Ok(Some(secret))
}

fn byok_present(raw: Option<&[u8]>) -> infra_error::AppResult<bool> {
    Ok(match raw {
        Some(bytes) => decrypt_byok_secret(bytes)?.is_some(),
        None => false,
    })
}

fn auth_user_info(
    id: String,
    email: String,
    plan: String,
    billing_track: String,
    byok_has_claude_key: bool,
    byok_has_openai_key: bool,
) -> AuthUserInfo {
    AuthUserInfo {
        id,
        email,
        plan,
        agent_slots: 3,
        custom_agent_count: 0,
        billing_track: canonical_billing_track(billing_track),
        byok_has_claude_key,
        byok_has_openai_key,
    }
}

fn byok_status_response(
    billing_track: String,
    byok_has_claude_key: bool,
    byok_has_openai_key: bool,
) -> ByokStatusResponse {
    ByokStatusResponse {
        billing_track: canonical_billing_track(billing_track),
        byok_has_claude_key,
        byok_has_openai_key,
    }
}

fn byok_save_response(
    status: String,
    billing_track: String,
    byok_has_claude_key: bool,
    byok_has_openai_key: bool,
    updated: serde_json::Value,
) -> ByokSaveResponse {
    ByokSaveResponse {
        status,
        billing_track: canonical_billing_track(billing_track),
        byok_has_claude_key,
        byok_has_openai_key,
        updated,
    }
}

pub(crate) fn require_claims(
    headers: &HeaderMap,
) -> Result<jwt::Claims, (StatusCode, Json<ErrorBody>)> {
    let token = bearer_token(headers).ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "Missing or invalid authorization".into(),
            }),
        )
    })?;

    let secret = jwt::jwt_secret().map_err(|e| {
        tracing::error!("jwt configuration error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Authentication is not configured".into(),
            }),
        )
    })?;

    jwt::decode_access_token(token, &secret).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "Invalid or expired token".into(),
            }),
        )
    })
}

/// Canonical guard for project-scoped routes.
///
/// JWT authentication alone is not sufficient for endpoints like
/// `POST /api/auth/ws-ticket/:project_id`; callers must also hold a stored
/// membership for the requested project.
pub(crate) async fn require_project_claims(
    pool: &sqlx::SqlitePool,
    headers: &HeaderMap,
    project_id: &str,
) -> Result<jwt::Claims, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(headers)?;
    let is_member = repository::is_user_project_member(pool, &claims.sub, project_id)
        .await
        .map_err(|e| {
            tracing::warn!("project membership lookup failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;

    if !is_member {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorBody {
                detail: "Project access denied".into(),
            }),
        ));
    }

    Ok(claims)
}

async fn register(
    State(state): State<AppState>,
    Json(in_body): Json<RegisterBody>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorBody>)> {
    let email = normalize_email(&in_body.email);
    if email.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "Invalid email".into(),
            }),
        ));
    }
    let password = in_body.password.trim();
    if password.len() < 8 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "Password must be at least 8 characters".into(),
            }),
        ));
    }

    let billing_track = normalize_billing_track(in_body.billing_track.as_deref());

    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE email = ?")
        .bind(&email)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("register db error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;
    if existing.is_some() {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorBody {
                detail: "Email already registered".into(),
            }),
        ));
    }

    let user_id = Uuid::new_v4().to_string();
    let hashed = hash_password(password).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Password hashing failed".into(),
            }),
        )
    })?;

    sqlx::query(
        "INSERT INTO users (id, email, hashed_password, plan, billing_track) VALUES (?, ?, ?, 'free', ?)",
    )
        .bind(&user_id)
        .bind(&email)
        .bind(&hashed)
        .bind(&billing_track)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("register insert user: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;

    let project_name = normalize_project_name(in_body.project_name.as_deref());
    let project_id = Uuid::new_v4().to_string();
    let membership_id = Uuid::new_v4().to_string();

    sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
        .bind(&project_id)
        .bind(&project_name)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("register insert project: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;

    sqlx::query("INSERT INTO project_memberships (id, project_id, user_id, role, is_owner) VALUES (?, ?, ?, 'owner', 1)")
        .bind(&membership_id)
        .bind(&project_id)
        .bind(&user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("register insert membership: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { detail: "Server error".into() }))
        })?;

    let access_token = issue_token(&user_id, &email, &billing_track).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Token creation failed".into(),
            }),
        )
    })?;

    let user = auth_user_info(
        user_id.clone(),
        email.clone(),
        "free".into(),
        billing_track,
        false,
        false,
    );
    let memberships = vec![ProjectMembershipInfo {
        project_id: project_id.clone(),
        project_name,
        role: "owner".into(),
        is_owner: true,
    }];

    tracing::info!("register success email={}", email);
    Ok(Json(AuthResponse {
        user,
        memberships,
        access_token,
    }))
}

async fn login(
    State(state): State<AppState>,
    Json(in_body): Json<LoginBody>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorBody>)> {
    let email = normalize_email(&in_body.email);
    if email.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "Invalid email".into(),
            }),
        ));
    }

    let row: Option<(String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>)> =
        sqlx::query_as(
            "SELECT id, hashed_password, plan, billing_track, byok_claude_key, byok_openai_key FROM users WHERE email = ?",
        )
            .bind(&email)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| {
                tracing::warn!("login db error: {}", e);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorBody {
                        detail: "Server error".into(),
                    }),
                )
            })?;

    let (user_id, hashed_password, plan, billing_track, byok_claude_key, byok_openai_key) =
        match row {
            Some(r) => r,
            None => {
                return Err((
                    StatusCode::UNAUTHORIZED,
                    Json(ErrorBody {
                        detail: "Invalid credentials".into(),
                    }),
                ));
            }
        };

    if !verify_password(in_body.password.trim(), &hashed_password) {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "Invalid credentials".into(),
            }),
        ));
    }

    let memberships: Vec<(String, String, String, i32)> = sqlx::query_as(
        "SELECT pm.project_id, p.name, pm.role, pm.is_owner FROM project_memberships pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? ORDER BY pm.created_at",
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("login memberships: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { detail: "Server error".into() }))
    })?;

    let access_token = issue_token(&user_id, &email, &billing_track).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Token creation failed".into(),
            }),
        )
    })?;

    let byok_has_claude_key = byok_present(byok_claude_key.as_deref()).map_err(|e| {
        tracing::warn!("login BYOK decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;
    let byok_has_openai_key = byok_present(byok_openai_key.as_deref()).map_err(|e| {
        tracing::warn!("login BYOK decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let user = auth_user_info(
        user_id.clone(),
        email.clone(),
        plan,
        billing_track,
        byok_has_claude_key,
        byok_has_openai_key,
    );
    let memberships: Vec<ProjectMembershipInfo> = memberships
        .into_iter()
        .map(
            |(project_id, project_name, role, is_owner)| ProjectMembershipInfo {
                project_id,
                project_name,
                role,
                is_owner: is_owner != 0,
            },
        )
        .collect();

    tracing::info!("login success email={}", email);
    Ok(Json(AuthResponse {
        user,
        memberships,
        access_token,
    }))
}

async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;

    let user_id = claims.sub;

    let row: Option<(String, String, String, String, Option<Vec<u8>>, Option<Vec<u8>>)> =
        sqlx::query_as(
            "SELECT id, email, plan, billing_track, byok_claude_key, byok_openai_key FROM users WHERE id = ?",
        )
        .bind(&user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("me db error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;

    let (_, email, plan, billing_track, byok_claude_key, byok_openai_key) = match row {
        Some(r) => r,
        None => {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(ErrorBody {
                    detail: "User not found".into(),
                }),
            ))
        }
    };

    let memberships: Vec<(String, String, String, i32)> = sqlx::query_as(
        "SELECT pm.project_id, p.name, pm.role, pm.is_owner FROM project_memberships pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? ORDER BY pm.created_at",
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("me memberships: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { detail: "Server error".into() }))
    })?;

    let access_token = issue_token(&user_id, &email, &billing_track).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Token creation failed".into(),
            }),
        )
    })?;

    let byok_has_claude_key = byok_present(byok_claude_key.as_deref()).map_err(|e| {
        tracing::warn!("me BYOK decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;
    let byok_has_openai_key = byok_present(byok_openai_key.as_deref()).map_err(|e| {
        tracing::warn!("me BYOK decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let user = auth_user_info(
        user_id,
        email.clone(),
        plan,
        billing_track,
        byok_has_claude_key,
        byok_has_openai_key,
    );
    let memberships: Vec<ProjectMembershipInfo> = memberships
        .into_iter()
        .map(
            |(project_id, project_name, role, is_owner)| ProjectMembershipInfo {
                project_id,
                project_name,
                role,
                is_owner: is_owner != 0,
            },
        )
        .collect();

    Ok(Json(AuthResponse {
        user,
        memberships,
        access_token,
    }))
}

async fn logout(State(_): State<AppState>) -> impl IntoResponse {
    Json(serde_json::json!({ "status": "logged_out" }))
}

async fn list_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<ProjectMembershipInfo>>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;
    let rows: Vec<(String, String, String, i32)> = sqlx::query_as(
        "SELECT pm.project_id, p.name, pm.role, pm.is_owner FROM project_memberships pm JOIN projects p ON p.id = pm.project_id WHERE pm.user_id = ? ORDER BY pm.created_at",
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("list_projects db error: {}", e);
        (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { detail: "Server error".into() }))
    })?;
    let out = rows
        .into_iter()
        .map(
            |(project_id, project_name, role, is_owner)| ProjectMembershipInfo {
                project_id,
                project_name,
                role,
                is_owner: is_owner != 0,
            },
        )
        .collect();
    Ok(Json(out))
}

#[derive(Deserialize)]
struct CreateProjectBody {
    #[serde(default)]
    project_name: Option<String>,
}

async fn create_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(in_body): Json<CreateProjectBody>,
) -> Result<Json<ProjectMembershipInfo>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;
    let project_name = normalize_project_name(in_body.project_name.as_deref());
    let project_id = Uuid::new_v4().to_string();
    let membership_id = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
        .bind(&project_id)
        .bind(&project_name)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("create_project insert project: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;
    sqlx::query("INSERT INTO project_memberships (id, project_id, user_id, role, is_owner) VALUES (?, ?, ?, 'owner', 1)")
        .bind(&membership_id)
        .bind(&project_id)
        .bind(&user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            tracing::warn!("create_project insert membership: {}", e);
            (StatusCode::INTERNAL_SERVER_ERROR, Json(ErrorBody { detail: "Server error".into() }))
        })?;
    Ok(Json(ProjectMembershipInfo {
        project_id,
        project_name,
        role: "owner".into(),
        is_owner: true,
    }))
}

async fn update_byok(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(in_body): Json<ByokBody>,
) -> Result<Json<ByokSaveResponse>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;

    let byok_claude_key = normalize_optional_secret(in_body.byok_claude_key.as_deref());
    let byok_openai_key = normalize_optional_secret(in_body.byok_openai_key.as_deref());

    if byok_claude_key.is_none() && byok_openai_key.is_none() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "No key payload provided".into(),
            }),
        ));
    }

    let updated = serde_json::json!({
        "byok_claude_key": byok_claude_key.is_some(),
        "byok_openai_key": byok_openai_key.is_some(),
    });

    let encrypted_byok_claude_key = byok_claude_key
        .as_deref()
        .map(encrypt_byok_secret)
        .transpose()
        .map_err(|e| {
            tracing::warn!("BYOK encrypt error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;
    let encrypted_byok_openai_key = byok_openai_key
        .as_deref()
        .map(encrypt_byok_secret)
        .transpose()
        .map_err(|e| {
            tracing::warn!("BYOK encrypt error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Server error".into(),
                }),
            )
        })?;

    let result = sqlx::query(
        "UPDATE users SET byok_claude_key = COALESCE(?, byok_claude_key), byok_openai_key = COALESCE(?, byok_openai_key), billing_track = 'byok', updated_at = datetime('now') WHERE id = ?",
    )
    .bind(encrypted_byok_claude_key)
    .bind(encrypted_byok_openai_key)
    .bind(&user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("byok update error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    if result.rows_affected() == 0 {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "User not found".into(),
            }),
        ));
    }

    let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT billing_track, byok_claude_key, byok_openai_key FROM users WHERE id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("byok fetch error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let (billing_track, byok_claude_key, byok_openai_key) = row.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "User not found".into(),
            }),
        )
    })?;

    let byok_has_claude_key = byok_present(byok_claude_key.as_deref()).map_err(|e| {
        tracing::warn!("BYOK save decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;
    let byok_has_openai_key = byok_present(byok_openai_key.as_deref()).map_err(|e| {
        tracing::warn!("BYOK save decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    Ok(Json(byok_save_response(
        "ok".into(),
        billing_track,
        byok_has_claude_key,
        byok_has_openai_key,
        updated,
    )))
}

async fn get_byok_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ByokStatusResponse>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;

    let row: Option<(String, Option<Vec<u8>>, Option<Vec<u8>>)> = sqlx::query_as(
        "SELECT billing_track, byok_claude_key, byok_openai_key FROM users WHERE id = ?",
    )
    .bind(&user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("byok status fetch error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let (billing_track, byok_claude_key, byok_openai_key) = row.ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(ErrorBody {
                detail: "User not found".into(),
            }),
        )
    })?;

    let byok_has_claude_key = byok_present(byok_claude_key.as_deref()).map_err(|e| {
        tracing::warn!("BYOK status decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;
    let byok_has_openai_key = byok_present(byok_openai_key.as_deref()).map_err(|e| {
        tracing::warn!("BYOK status decode error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    Ok(Json(byok_status_response(
        billing_track,
        byok_has_claude_key,
        byok_has_openai_key,
    )))
}

#[derive(Serialize)]
struct WsTicketResponse {
    ticket: String,
    token_type: String,
    expires_in: u64,
}

const WS_TICKET_TTL_SECS: u64 = 30;

async fn ws_ticket(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<Json<WsTicketResponse>, (StatusCode, Json<ErrorBody>)> {
    // WebSocket tickets stay project-scoped: JWT auth must still be paired with
    // a stored membership check for the requested project before minting.
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    let ticket = crate::core::issue_ws_ticket(&claims.sub, &project_id, WS_TICKET_TTL_SECS)
        .map_err(|e| {
            tracing::warn!("ws_ticket issue error: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    detail: "Failed to issue ticket".into(),
                }),
            )
        })?;
    Ok(Json(WsTicketResponse {
        ticket,
        token_type: "ws-ticket".into(),
        expires_in: WS_TICKET_TTL_SECS,
    }))
}

pub(crate) fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let v = headers.get(header::AUTHORIZATION)?;
    let s = v.to_str().ok()?;
    let s = s.strip_prefix("Bearer ")?;
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub fn auth_router() -> Router<AppState> {
    Router::new()
        .route("/register", post(register))
        .route("/login", post(login))
        .route("/me", get(me))
        .route("/logout", post(logout))
        .route("/projects", get(list_projects).post(create_project))
        .route("/byok", get(get_byok_status).post(update_byok))
        .route("/ws-ticket/:project_id", post(ws_ticket))
}

#[cfg(test)]
mod tests {
    use super::{decrypt_byok_secret, encrypt_byok_secret, hash_password};
    use axum::{
        body::{to_bytes, Body},
        http::{Request, StatusCode},
        Router,
    };
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::Mutex;
    use tower::ServiceExt;
    use uuid::Uuid;

    use crate::{
        auth::WS_TICKET_TTL_SECS, core::consume_ws_ticket,
        domain::skills::load_shared_skill_loader, events::EventBus, jwt, routes::api_router,
        AppState,
    };

    #[tokio::test]
    async fn register_normalizes_legacy_billing_track_inputs_in_response_and_token() {
        let pool = test_pool().await;
        let app = test_app(pool.clone());

        let (project_status, project_payload) = request_register(
            &app,
            serde_json::json!({
                "email": "project@example.com",
                "password": "password123",
                "billing_track": "enterprise"
            }),
        )
        .await;

        assert_eq!(project_status, StatusCode::OK);
        assert_eq!(
            project_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("project")
        );
        assert_access_token_billing_track(
            project_payload
                .get("access_token")
                .and_then(|value| value.as_str()),
            Some("project"),
        );

        let stored_project: (String,) =
            sqlx::query_as("SELECT billing_track FROM users WHERE email = ?")
                .bind("project@example.com")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_project.0, "project");

        let (byok_status, byok_payload) = request_register(
            &app,
            serde_json::json!({
                "email": "byok@example.com",
                "password": "password123",
                "billing_track": "  ByOk  "
            }),
        )
        .await;

        assert_eq!(byok_status, StatusCode::OK);
        assert_eq!(
            byok_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_access_token_billing_track(
            byok_payload
                .get("access_token")
                .and_then(|value| value.as_str()),
            Some("byok"),
        );

        let stored_byok: (String,) =
            sqlx::query_as("SELECT billing_track FROM users WHERE email = ?")
                .bind("byok@example.com")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(stored_byok.0, "byok");
    }

    #[tokio::test]
    async fn login_normalizes_legacy_stored_billing_track_in_response_and_token() {
        let pool = test_pool().await;
        insert_user_with_password(
            &pool,
            "user-1",
            "user1@example.com",
            "password123",
            "enterprise",
        )
        .await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let app = test_app(pool);

        let (status, payload) = request_login(
            &app,
            serde_json::json!({
                "email": "user1@example.com",
                "password": "password123"
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("project")
        );
        assert_access_token_billing_track(
            payload.get("access_token").and_then(|value| value.as_str()),
            Some("project"),
        );
    }

    #[tokio::test]
    async fn me_normalizes_legacy_stored_billing_track_in_response_and_token() {
        let pool = test_pool().await;
        insert_user_with_byok(
            &pool,
            "user-1",
            "user1@example.com",
            "  ByOk  ",
            Some("claude-secret"),
            None,
        )
        .await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_me(&app, &token).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            payload
                .get("user")
                .and_then(|value| value.get("byok_has_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_access_token_billing_track(
            payload.get("access_token").and_then(|value| value.as_str()),
            Some("byok"),
        );
    }

    #[tokio::test]
    async fn ws_ticket_denies_cross_project_request_for_authenticated_non_member() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;
        insert_project(&pool, "project-2", "Project Two").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, error) = request_ws_ticket(&app, &token, "project-2").await;

        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            error.get("detail").and_then(|value| value.as_str()),
            Some("Project access denied")
        );
        assert!(error.get("ticket").is_none());
        assert!(error.get("token_type").is_none());
        assert!(error.get("expires_in").is_none());
    }

    #[tokio::test]
    async fn ws_ticket_denies_other_project_member_but_allows_authorized_member() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_user(&pool, "user-2", "user2@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;
        insert_project_membership(&pool, "project-2", "Project Two", "user-2").await;

        let app = test_app(pool);
        let outsider_token = access_token("user-1", "user1@example.com");
        let member_token = access_token("user-2", "user2@example.com");

        let (denied_status, denied_payload) =
            request_ws_ticket(&app, &outsider_token, "project-2").await;

        assert_eq!(denied_status, StatusCode::FORBIDDEN);
        assert_eq!(
            denied_payload
                .get("detail")
                .and_then(|value| value.as_str()),
            Some("Project access denied")
        );
        assert!(denied_payload.get("ticket").is_none());

        let (allowed_status, allowed_payload) =
            request_ws_ticket(&app, &member_token, "project-2").await;

        assert_eq!(allowed_status, StatusCode::OK);
        let ticket = allowed_payload
            .get("ticket")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();
        assert!(ticket.starts_with("wst_"));

        let consumed = consume_ws_ticket(&ticket, "project-2").unwrap();
        assert_eq!(consumed.as_deref(), Some("user-2"));
    }

    #[tokio::test]
    async fn ws_ticket_issues_consumable_ticket_for_valid_project_member() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_ws_ticket(&app, &token, "project-1").await;

        assert_eq!(status, StatusCode::OK);
        let ticket = payload
            .get("ticket")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();
        assert_eq!(
            payload.get("token_type").and_then(|value| value.as_str()),
            Some("ws-ticket")
        );
        assert_eq!(
            payload.get("expires_in").and_then(|value| value.as_u64()),
            Some(WS_TICKET_TTL_SECS)
        );
        assert!(ticket.starts_with("wst_"));
        assert!(
            payload.get("detail").is_none(),
            "successful ticket minting should not return an error payload"
        );

        let consumed = consume_ws_ticket(&ticket, "project-1").unwrap();
        assert_eq!(consumed.as_deref(), Some("user-1"));
    }

    #[tokio::test]
    async fn ws_ticket_rejects_ticket_consumption_for_other_project() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;
        insert_project(&pool, "project-2", "Project Two").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_ws_ticket(&app, &token, "project-1").await;

        assert_eq!(status, StatusCode::OK);
        let ticket = payload
            .get("ticket")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();

        let cross_project_consumed = consume_ws_ticket(&ticket, "project-2").unwrap();
        assert_eq!(cross_project_consumed, None);
    }

    #[tokio::test]
    async fn ws_ticket_is_single_use_after_successful_project_bound_consumption() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_ws_ticket(&app, &token, "project-1").await;

        assert_eq!(status, StatusCode::OK);
        let ticket = payload
            .get("ticket")
            .and_then(|value| value.as_str())
            .unwrap()
            .to_string();

        let first_consumed = consume_ws_ticket(&ticket, "project-1").unwrap();
        assert_eq!(first_consumed.as_deref(), Some("user-1"));

        let second_consumed = consume_ws_ticket(&ticket, "project-1").unwrap();
        assert_eq!(second_consumed, None);
    }

    #[tokio::test]
    async fn byok_status_returns_expected_client_contract() {
        let pool = test_pool().await;
        insert_user_with_byok(
            &pool,
            "user-1",
            "user1@example.com",
            "project",
            Some("claude-secret"),
            None,
        )
        .await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_byok_status(&app, Some(&token)).await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("project")
        );
        assert_eq!(
            payload
                .get("byok_has_claude_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("byok_has_openai_key")
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert!(payload.get("status").is_none());
        assert!(payload.get("updated").is_none());
    }

    #[tokio::test]
    async fn byok_status_normalizes_legacy_stored_billing_track_values() {
        let pool = test_pool().await;
        insert_user_with_byok(
            &pool,
            "user-1",
            "user1@example.com",
            "enterprise",
            Some("claude-secret"),
            None,
        )
        .await;

        let app = test_app(pool.clone());
        let token = access_token("user-1", "user1@example.com");

        let (project_status, project_payload) = request_byok_status(&app, Some(&token)).await;

        assert_eq!(project_status, StatusCode::OK);
        assert_eq!(
            project_payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("project")
        );

        sqlx::query("UPDATE users SET billing_track = ? WHERE id = ?")
            .bind("  ByOk  ")
            .bind("user-1")
            .execute(&pool)
            .await
            .unwrap();

        let (byok_status, byok_payload) = request_byok_status(&app, Some(&token)).await;

        assert_eq!(byok_status, StatusCode::OK);
        assert_eq!(
            byok_payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("byok")
        );
    }

    #[tokio::test]
    async fn byok_status_requires_authentication() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;

        let app = test_app(pool);

        let (status, payload) = request_byok_status(&app, None).await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            payload.get("detail").and_then(|value| value.as_str()),
            Some("Missing or invalid authorization")
        );
    }

    #[tokio::test]
    async fn byok_post_requires_authentication() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;

        let app = test_app(pool);

        let (status, payload) = request_byok_update(
            &app,
            None,
            serde_json::json!({
                "byok_claude_key": "claude-secret"
            }),
        )
        .await;

        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(
            payload.get("detail").and_then(|value| value.as_str()),
            Some("Missing or invalid authorization")
        );
    }

    #[tokio::test]
    async fn byok_post_rejects_empty_or_whitespace_payloads() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_byok_update(
            &app,
            Some(&token),
            serde_json::json!({
                "byok_claude_key": "   ",
                "byok_openai_key": ""
            }),
        )
        .await;

        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            payload.get("detail").and_then(|value| value.as_str()),
            Some("No key payload provided")
        );
    }

    #[tokio::test]
    async fn byok_post_preserves_existing_keys_and_reports_updated_flags() {
        let pool = test_pool().await;
        insert_user_with_byok(
            &pool,
            "user-1",
            "user1@example.com",
            "project",
            Some("claude-existing"),
            None,
        )
        .await;

        let app = test_app(pool.clone());
        let token = access_token("user-1", "user1@example.com");

        let (status, payload) = request_byok_update(
            &app,
            Some(&token),
            serde_json::json!({
                "byok_openai_key": "openai-new"
            }),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            payload.get("status").and_then(|value| value.as_str()),
            Some("ok")
        );
        assert_eq!(
            payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            payload
                .get("byok_has_claude_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("byok_has_openai_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            payload
                .get("updated")
                .and_then(|value| value.get("byok_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(false)
        );
        assert_eq!(
            payload
                .get("updated")
                .and_then(|value| value.get("byok_openai_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );

        let stored: (String, Option<Vec<u8>>, Option<Vec<u8>>) = sqlx::query_as(
            "SELECT billing_track, byok_claude_key, byok_openai_key FROM users WHERE id = ?",
        )
        .bind("user-1")
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(stored.0, "byok");
        assert_eq!(
            decrypt_byok_secret(stored.1.as_deref().unwrap())
                .unwrap()
                .as_deref(),
            Some("claude-existing")
        );
        assert_eq!(
            decrypt_byok_secret(stored.2.as_deref().unwrap())
                .unwrap()
                .as_deref(),
            Some("openai-new")
        );
    }

    #[tokio::test]
    async fn byok_post_stores_ciphertext_at_rest_and_get_status_remains_compatible() {
        let pool = test_pool().await;
        insert_user_with_password(
            &pool,
            "user-1",
            "user1@example.com",
            "password123",
            "project",
        )
        .await;

        let app = test_app(pool.clone());
        let token = access_token("user-1", "user1@example.com");

        let claude_secret = "claude-secret-live";
        let openai_secret = "openai-secret-live";

        let (post_status, post_payload) = request_byok_update(
            &app,
            Some(&token),
            serde_json::json!({
                "byok_claude_key": claude_secret,
                "byok_openai_key": openai_secret
            }),
        )
        .await;

        assert_eq!(post_status, StatusCode::OK);
        assert_eq!(
            post_payload.get("status").and_then(|value| value.as_str()),
            Some("ok")
        );
        assert_eq!(
            post_payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            post_payload
                .get("byok_has_claude_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            post_payload
                .get("byok_has_openai_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            post_payload
                .get("updated")
                .and_then(|value| value.get("byok_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            post_payload
                .get("updated")
                .and_then(|value| value.get("byok_openai_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );

        let stored: (String, Option<Vec<u8>>, Option<Vec<u8>>) = sqlx::query_as(
            "SELECT billing_track, byok_claude_key, byok_openai_key FROM users WHERE id = ?",
        )
        .bind("user-1")
        .fetch_one(&pool)
        .await
        .unwrap();

        assert_eq!(stored.0, "byok");

        let stored_claude = stored.1.expect("expected stored claude key");
        let stored_openai = stored.2.expect("expected stored openai key");

        assert_ne!(stored_claude, claude_secret.as_bytes());
        assert_ne!(stored_openai, openai_secret.as_bytes());
        assert_eq!(
            decrypt_byok_secret(&stored_claude).unwrap().as_deref(),
            Some(claude_secret)
        );
        assert_eq!(
            decrypt_byok_secret(&stored_openai).unwrap().as_deref(),
            Some(openai_secret)
        );

        let (get_status, get_payload) = request_byok_status(&app, Some(&token)).await;

        assert_eq!(get_status, StatusCode::OK);
        assert_eq!(
            get_payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            get_payload
                .get("byok_has_claude_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            get_payload
                .get("byok_has_openai_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(get_payload.get("status").is_none());
        assert!(get_payload.get("updated").is_none());
    }

    #[tokio::test]
    async fn login_and_me_report_byok_flags_from_encrypted_storage() {
        ensure_test_jwt_secret();
        let pool = test_pool().await;
        insert_user_with_password(
            &pool,
            "user-1",
            "user1@example.com",
            "password123",
            "  ByOk  ",
        )
        .await;
        sqlx::query("UPDATE users SET byok_claude_key = ?, byok_openai_key = ? WHERE id = ?")
            .bind(Some(encrypt_byok_secret("claude-secret").unwrap()))
            .bind(Some(encrypt_byok_secret("openai-secret").unwrap()))
            .bind("user-1")
            .execute(&pool)
            .await
            .unwrap();

        let app = test_app(pool);
        let token = access_token("user-1", "user1@example.com");

        let (login_status, login_payload) = request_login(
            &app,
            serde_json::json!({
                "email": "user1@example.com",
                "password": "password123"
            }),
        )
        .await;

        assert_eq!(login_status, StatusCode::OK);
        assert_eq!(
            login_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            login_payload
                .get("user")
                .and_then(|value| value.get("byok_has_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            login_payload
                .get("user")
                .and_then(|value| value.get("byok_has_openai_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_access_token_billing_track(
            login_payload
                .get("access_token")
                .and_then(|value| value.as_str()),
            Some("byok"),
        );

        let (me_status, me_payload) = request_me(&app, &token).await;

        assert_eq!(me_status, StatusCode::OK);
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("byok_has_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("byok_has_openai_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_access_token_billing_track(
            me_payload
                .get("access_token")
                .and_then(|value| value.as_str()),
            Some("byok"),
        );
    }

    #[tokio::test]
    async fn register_post_byok_and_me_preserve_live_contract() {
        let pool = test_pool().await;
        let app = test_app(pool);

        let (register_status, register_payload) = request_register(
            &app,
            serde_json::json!({
                "email": "step3-contract@example.com",
                "password": "password123",
                "project_name": "Step 3 Contract",
                "billing_track": "  ByOk  "
            }),
        )
        .await;

        assert_eq!(register_status, StatusCode::OK);
        assert_eq!(
            register_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );

        let token = register_payload
            .get("access_token")
            .and_then(|value| value.as_str())
            .expect("register token");

        let (post_status, post_payload) = request_byok_update(
            &app,
            Some(token),
            serde_json::json!({
                "byok_claude_key": "sk-ant-live",
                "byok_openai_key": "sk-openai-live"
            }),
        )
        .await;

        assert_eq!(post_status, StatusCode::OK);
        assert_eq!(
            post_payload.get("status").and_then(|value| value.as_str()),
            Some("ok")
        );
        assert_eq!(
            post_payload
                .get("billing_track")
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            post_payload
                .get("byok_has_claude_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            post_payload
                .get("byok_has_openai_key")
                .and_then(|value| value.as_bool()),
            Some(true)
        );

        let (me_status, me_payload) = request_me(&app, token).await;

        assert_eq!(me_status, StatusCode::OK);
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("billing_track"))
                .and_then(|value| value.as_str()),
            Some("byok")
        );
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("byok_has_claude_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert_eq!(
            me_payload
                .get("user")
                .and_then(|value| value.get("byok_has_openai_key"))
                .and_then(|value| value.as_bool()),
            Some(true)
        );
        assert!(me_payload
            .get("memberships")
            .and_then(|value| value.as_array())
            .is_some_and(|memberships| !memberships.is_empty()));
        assert_access_token_billing_track(
            me_payload
                .get("access_token")
                .and_then(|value| value.as_str()),
            Some("byok"),
        );
    }

    async fn request_ws_ticket(
        app: &Router,
        token: &str,
        project_id: &str,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/auth/ws-ticket/{}", project_id))
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn request_register(
        app: &Router,
        body_json: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/register")
                    .header("content-type", "application/json")
                    .body(Body::from(body_json.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn request_login(
        app: &Router,
        body_json: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/auth/login")
                    .header("content-type", "application/json")
                    .body(Body::from(body_json.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn request_me(app: &Router, token: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/auth/me")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn request_byok_status(
        app: &Router,
        token: Option<&str>,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder().method("GET").uri("/api/auth/byok");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {}", token));
        }

        let response = app
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn request_byok_update(
        app: &Router,
        token: Option<&str>,
        body_json: serde_json::Value,
    ) -> (StatusCode, serde_json::Value) {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/auth/byok")
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {}", token));
        }

        let response = app
            .clone()
            .oneshot(request.body(Body::from(body_json.to_string())).unwrap())
            .await
            .unwrap();

        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let payload = serde_json::from_slice(&body).unwrap();
        (status, payload)
    }

    async fn test_pool() -> sqlx::SqlitePool {
        let database_url = format!("sqlite:file:{}?mode=memory&cache=shared", Uuid::new_v4());
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(&database_url)
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        pool
    }

    fn ensure_test_jwt_secret() {
        std::env::set_var(
            "DAACS_JWT_SECRET",
            "test-daacs-jwt-secret-for-routes-32chars",
        );
    }

    fn test_app(pool: sqlx::SqlitePool) -> Router {
        ensure_test_jwt_secret();
        Router::new()
            .nest("/api", api_router())
            .with_state(AppState {
                pool,
                event_bus: EventBus::new(16),
                skill_loader: load_shared_skill_loader().unwrap(),
                http_client: reqwest::Client::new(),
                collaboration_sessions: Arc::new(Mutex::new(HashMap::new())),
            })
    }

    fn access_token(user_id: &str, email: &str) -> String {
        ensure_test_jwt_secret();
        jwt::create_access_token(user_id, email, &jwt::jwt_secret().unwrap()).unwrap()
    }

    fn assert_access_token_billing_track(token: Option<&str>, expected: Option<&str>) {
        ensure_test_jwt_secret();
        let claims = jwt::decode_access_token(
            token.expect("expected access token"),
            &jwt::jwt_secret().unwrap(),
        )
        .unwrap();

        assert_eq!(claims.billing_track.as_deref(), expected);
    }

    async fn insert_user(pool: &sqlx::SqlitePool, user_id: &str, email: &str) {
        sqlx::query(
            "INSERT INTO users (id, email, hashed_password, plan, billing_track) VALUES (?, ?, '!', 'free', 'byok')",
        )
        .bind(user_id)
        .bind(email)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_user_with_password(
        pool: &sqlx::SqlitePool,
        user_id: &str,
        email: &str,
        password: &str,
        billing_track: &str,
    ) {
        let hashed = hash_password(password).unwrap().to_string();
        sqlx::query(
            "INSERT INTO users (id, email, hashed_password, plan, billing_track) VALUES (?, ?, ?, 'free', ?)",
        )
        .bind(user_id)
        .bind(email)
        .bind(hashed)
        .bind(billing_track)
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_user_with_byok(
        pool: &sqlx::SqlitePool,
        user_id: &str,
        email: &str,
        billing_track: &str,
        byok_claude_key: Option<&str>,
        byok_openai_key: Option<&str>,
    ) {
        ensure_test_jwt_secret();
        sqlx::query(
            "INSERT INTO users (id, email, hashed_password, plan, billing_track, byok_claude_key, byok_openai_key) VALUES (?, ?, '!', 'free', ?, ?, ?)",
        )
        .bind(user_id)
        .bind(email)
        .bind(billing_track)
        .bind(
            byok_claude_key
                .map(encrypt_byok_secret)
                .transpose()
                .unwrap(),
        )
        .bind(
            byok_openai_key
                .map(encrypt_byok_secret)
                .transpose()
                .unwrap(),
        )
        .execute(pool)
        .await
        .unwrap();
    }

    async fn insert_project(pool: &sqlx::SqlitePool, project_id: &str, project_name: &str) {
        sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
            .bind(project_id)
            .bind(project_name)
            .execute(pool)
            .await
            .unwrap();
    }

    async fn insert_project_membership(
        pool: &sqlx::SqlitePool,
        project_id: &str,
        project_name: &str,
        user_id: &str,
    ) {
        insert_project(pool, project_id, project_name).await;
        sqlx::query(
            "INSERT INTO project_memberships (id, project_id, user_id, role, is_owner) VALUES (?, ?, ?, 'owner', 1)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(project_id)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    }
}
