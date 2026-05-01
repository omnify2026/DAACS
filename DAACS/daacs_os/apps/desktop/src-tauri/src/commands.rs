use reqwest::Client;
use serde::{Deserialize, Serialize};

const DEFAULT_API_BASE: &str = "http://127.0.0.1:8001";

fn api_base() -> String {
    std::env::var("DAACS_API_URL").unwrap_or_else(|_| DEFAULT_API_BASE.to_string())
}

fn client() -> Client {
    static CLIENT: std::sync::OnceLock<Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(Client::new).clone()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthUser {
    pub id: String,
    pub email: String,
    pub plan: String,
    pub agent_slots: i64,
    pub custom_agent_count: i64,
    pub billing_track: String,
    pub byok_has_claude_key: bool,
    pub byok_has_openai_key: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ProjectMembership {
    pub project_id: String,
    pub project_name: String,
    pub role: String,
    pub is_owner: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AuthResponse {
    pub user: AuthUser,
    pub memberships: Vec<ProjectMembership>,
    pub access_token: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiError {
    pub detail: String,
}

#[tauri::command]
pub async fn auth_login(email: String, password: String) -> Result<AuthResponse, String> {
    let base = api_base();
    tracing::info!("auth_login invoked for {}", email);
    let res = client()
        .post(format!("{}/api/auth/login", base))
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| {
            let message = e.to_string();
            tracing::error!("auth_login request failed for {}: {}", email, message);
            message
        })?;
    if !res.status().is_success() {
        let err: ApiError = res.json().await.unwrap_or_else(|_| ApiError {
            detail: "Login failed".to_string(),
        });
        tracing::warn!("auth_login backend rejected {}: {}", email, err.detail);
        return Err(err.detail);
    }
    let data: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
    tracing::info!("auth_login succeeded for {}", email);
    Ok(data)
}

#[tauri::command]
pub async fn auth_register(
    email: String,
    password: String,
    project_name: Option<String>,
) -> Result<AuthResponse, String> {
    let base = api_base();
    tracing::info!(
        "auth_register invoked for {} with project {:?}",
        email,
        project_name.as_deref().unwrap_or("Default Project")
    );
    let body = serde_json::json!({
        "email": email,
        "password": password,
        "project_name": project_name.unwrap_or_else(|| "Default Project".to_string())
    });
    let res = client()
        .post(format!("{}/api/auth/register", base))
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            let message = e.to_string();
            tracing::error!("auth_register request failed: {}", message);
            message
        })?;
    if !res.status().is_success() {
        let err: ApiError = res.json().await.unwrap_or_else(|_| ApiError {
            detail: "Register failed".to_string(),
        });
        tracing::warn!("auth_register backend rejected {}: {}", email, err.detail);
        return Err(err.detail);
    }
    let data: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
    tracing::info!("auth_register succeeded for {}", email);
    Ok(data)
}

#[tauri::command]
pub async fn auth_me(access_token: String) -> Result<AuthResponse, String> {
    let base = api_base();
    let res = client()
        .get(format!("{}/api/auth/me", base))
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err("Invalid or expired token".to_string());
    }
    let data: AuthResponse = res.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
pub async fn auth_logout(access_token: String) -> Result<(), String> {
    let base = api_base();
    let _ = client()
        .post(format!("{}/api/auth/logout", base))
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn auth_list_projects(access_token: String) -> Result<Vec<ProjectMembership>, String> {
    let base = api_base();
    let res = client()
        .get(format!("{}/api/auth/projects", base))
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err("Failed to list projects".to_string());
    }
    let data: Vec<ProjectMembership> = res.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
pub async fn auth_create_project(
    access_token: String,
    project_name: Option<String>,
) -> Result<ProjectMembership, String> {
    let base = api_base();
    let body = serde_json::json!({
        "project_name": project_name.unwrap_or_else(|| "Default Project".to_string())
    });
    let res = client()
        .post(format!("{}/api/auth/projects", base))
        .header("Authorization", format!("Bearer {}", access_token))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let err: ApiError = res.json().await.unwrap_or_else(|_| ApiError {
            detail: "Failed to create project".to_string(),
        });
        return Err(err.detail);
    }
    let data: ProjectMembership = res.json().await.map_err(|e| e.to_string())?;
    Ok(data)
}

#[tauri::command]
pub async fn auth_ws_ticket(access_token: String, project_id: String) -> Result<String, String> {
    let base = api_base();
    let res = client()
        .post(format!("{}/api/auth/ws-ticket/{}", base, project_id))
        .header("Authorization", format!("Bearer {}", access_token))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err("Failed to get WS ticket".to_string());
    }
    let data: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let ticket = data
        .get("ticket")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(ticket)
}
