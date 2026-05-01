use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{require_claims, ErrorBody};
use crate::AppState;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// 조회 응답 — api_key는 보안상 포함하지 않음
#[derive(Serialize)]
pub struct LlmConfigResponse {
    pub id: String,
    pub provider_name: String,
    pub base_url: String,
    pub is_active: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 설정 저장 요청
#[derive(Deserialize)]
pub struct SaveLlmConfigBody {
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
}

/// 프록시 요청
#[derive(Deserialize)]
pub struct LlmProxyBody {
    pub provider_name: String,
    pub payload: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// GET /llm/settings — 인증된 사용자의 활성 LLM 설정 목록 조회
async fn get_llm_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<LlmConfigResponse>>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;

    let rows: Vec<(String, String, String, i64, String, String)> = sqlx::query_as(
        "SELECT id, provider_name, base_url, is_active, created_at, updated_at \
         FROM llm_configs WHERE user_id = ? AND is_active = 1",
    )
    .bind(&user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("get_llm_settings db error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let configs: Vec<LlmConfigResponse> = rows
        .into_iter()
        .map(
            |(id, provider_name, base_url, is_active, created_at, updated_at)| LlmConfigResponse {
                id,
                provider_name,
                base_url,
                is_active: is_active != 0,
                created_at,
                updated_at,
            },
        )
        .collect();

    Ok(Json(configs))
}

/// POST /llm/settings — LLM 설정 upsert (provider_name 기준)
async fn save_llm_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SaveLlmConfigBody>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;

    // base_url 검증
    if !body.base_url.starts_with("http://") && !body.base_url.starts_with("https://") {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "base_url must start with http:// or https://".into(),
            }),
        ));
    }

    // api_key 비어있지 않음 확인
    if body.api_key.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "api_key must not be empty".into(),
            }),
        ));
    }

    // provider_name 비어있지 않음 확인
    if body.provider_name.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                detail: "provider_name must not be empty".into(),
            }),
        ));
    }

    let id = Uuid::new_v4().to_string();

    sqlx::query(
        "INSERT INTO llm_configs (id, user_id, provider_name, base_url, api_key) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(user_id, provider_name) DO UPDATE SET \
           base_url = excluded.base_url, \
           api_key = excluded.api_key, \
           updated_at = datetime('now')",
    )
    .bind(&id)
    .bind(&user_id)
    .bind(&body.provider_name)
    .bind(&body.base_url)
    .bind(&body.api_key)
    .execute(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("save_llm_settings db error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    Ok((
        StatusCode::CREATED,
        Json(serde_json::json!({ "status": "saved", "provider_name": body.provider_name })),
    ))
}

/// POST /llm/proxy — 외부 LLM API 프록시
async fn llm_proxy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LlmProxyBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorBody>)> {
    let claims = require_claims(&headers)?;
    let user_id = claims.sub;

    // DB에서 사용자의 활성 config 조회
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT base_url, api_key FROM llm_configs \
         WHERE user_id = ? AND provider_name = ? AND is_active = 1",
    )
    .bind(&user_id)
    .bind(&body.provider_name)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| {
        tracing::warn!("llm_proxy db error: {}", e);
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorBody {
                detail: "Server error".into(),
            }),
        )
    })?;

    let (base_url, api_key) = match row {
        Some(r) => r,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorBody {
                    detail: format!(
                        "No active LLM config found for provider '{}'",
                        body.provider_name
                    ),
                }),
            ));
        }
    };

    // 외부 LLM API 호출
    let response = state
        .http_client
        .post(&base_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&body.payload)
        .send()
        .await
        .map_err(|e| {
            tracing::warn!("llm_proxy reqwest error: {}", e);
            (
                StatusCode::BAD_GATEWAY,
                Json(ErrorBody {
                    detail: "Failed to reach LLM provider".into(),
                }),
            )
        })?;

    // 외부 응답 상태 확인
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let err_body = response.text().await.unwrap_or_default();
        tracing::warn!(
            "llm_proxy upstream error: status={} body={}",
            status,
            err_body
        );
        return Err((
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody {
                detail: format!("LLM provider returned status {}", status),
            }),
        ));
    }

    let result: serde_json::Value = response.json().await.map_err(|e| {
        tracing::warn!("llm_proxy response parse error: {}", e);
        (
            StatusCode::BAD_GATEWAY,
            Json(ErrorBody {
                detail: "Failed to parse LLM provider response".into(),
            }),
        )
    })?;

    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// LLM 설정 및 프록시 라우터
pub fn llm_router() -> Router<AppState> {
    Router::new()
        .route(
            "/llm/settings",
            get(get_llm_settings).post(save_llm_settings),
        )
        .route("/llm/proxy", post(llm_proxy))
}
