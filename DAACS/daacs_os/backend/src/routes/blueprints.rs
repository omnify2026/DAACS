use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::get,
    Json, Router,
};

use crate::{
    auth::{require_claims, ErrorBody},
    domain::{
        blueprint::{AgentBlueprint, BlueprintInput},
        repository,
    },
    AppState,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

pub fn blueprints_router() -> Router<AppState> {
    Router::new()
        .route("/blueprints", get(list_blueprints).post(create_blueprint))
        .route(
            "/blueprints/:blueprint_id",
            get(get_blueprint)
                .put(update_blueprint)
                .delete(delete_blueprint),
        )
}

async fn list_blueprints(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<AgentBlueprint>>> {
    let claims = require_claims(&headers)?;
    let blueprints = repository::list_blueprints_for_user(&state.pool, &claims.sub)
        .await
        .map_err(internal_error)?;
    Ok(Json(blueprints))
}

async fn get_blueprint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(blueprint_id): Path<String>,
) -> ApiResult<Json<AgentBlueprint>> {
    let claims = require_claims(&headers)?;
    let blueprint = repository::get_blueprint_for_user(&state.pool, &blueprint_id, &claims.sub)
        .await
        .map_err(internal_error)?;
    match blueprint {
        Some(item) => Ok(Json(item)),
        None => Err(not_found("Blueprint not found")),
    }
}

async fn create_blueprint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(input): Json<BlueprintInput>,
) -> ApiResult<impl IntoResponse> {
    validate_blueprint_input(&input)?;
    let claims = require_claims(&headers)?;
    let blueprint = repository::create_blueprint(&state.pool, &claims.sub, &input)
        .await
        .map_err(internal_error)?;
    Ok((StatusCode::CREATED, Json(blueprint)))
}

async fn update_blueprint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(blueprint_id): Path<String>,
    Json(input): Json<BlueprintInput>,
) -> ApiResult<Json<AgentBlueprint>> {
    validate_blueprint_input(&input)?;
    let claims = require_claims(&headers)?;
    let blueprint = repository::update_blueprint(&state.pool, &blueprint_id, &claims.sub, &input)
        .await
        .map_err(internal_error)?;
    match blueprint {
        Some(item) => Ok(Json(item)),
        None => Err(not_found("Blueprint not found or not editable")),
    }
}

async fn delete_blueprint(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(blueprint_id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let claims = require_claims(&headers)?;
    let deleted = repository::delete_blueprint(&state.pool, &blueprint_id, &claims.sub)
        .await
        .map_err(internal_error)?;
    if deleted {
        Ok(Json(serde_json::json!({
            "status": "deleted",
            "blueprint_id": blueprint_id,
        })))
    } else {
        Err(not_found("Blueprint not found or not deletable"))
    }
}

fn validate_blueprint_input(input: &BlueprintInput) -> ApiResult<()> {
    if input.name.trim().is_empty() {
        return Err(bad_request("Blueprint name is required"));
    }
    if input.role_label.trim().is_empty() {
        return Err(bad_request("Role label is required"));
    }
    Ok(())
}

fn internal_error(err: infra_error::AppError) -> (StatusCode, Json<ErrorBody>) {
    tracing::warn!("blueprints route error: {}", err);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            detail: "Server error".into(),
        }),
    )
}

fn bad_request(detail: &str) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ErrorBody {
            detail: detail.to_string(),
        }),
    )
}

fn not_found(detail: &str) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorBody {
            detail: detail.to_string(),
        }),
    )
}

#[cfg(test)]
mod tests {
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
        domain::{seed::seed_builtin_blueprints, skills::load_shared_skill_loader},
        events::EventBus,
        jwt,
        routes::api_router,
        AppState,
    };

    use super::AgentBlueprint;

    #[tokio::test]
    async fn create_and_list_blueprints_are_scoped_to_the_authenticated_user() {
        let pool = test_pool().await;
        seed_builtin_blueprints(&pool).await.unwrap();
        sqlx::query(
            r#"
            INSERT INTO agent_blueprints (
                id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
                tool_policy, permission_policy, memory_policy, collaboration_policy,
                approval_policy, ui_profile, is_builtin, owner_user_id
            ) VALUES (?, ?, ?, '[]', NULL, '[]', '{}', '{}', '{}', '{}', '{}', '{}', 1, 'system')
            "#,
        )
        .bind("builtin-retired-developer")
        .bind("Retired Developer")
        .bind("developer")
        .execute(&pool)
        .await
        .unwrap();
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_user(&pool, "user-2", "user2@example.com").await;

        let app = test_app(pool.clone());
        let token_user_1 =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();
        let token_user_2 =
            jwt::create_access_token("user-2", "user2@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/blueprints")
                    .header("authorization", format!("Bearer {}", token_user_1))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": "Research Strategist",
                            "role_label": "research_strategist",
                            "capabilities": ["research", "summary"],
                            "ui_profile": {
                                "display_name": "Research Strategist",
                                "title": "Research Strategist",
                                "accent_color": "#22C55E",
                                "icon": "Search",
                                "home_zone": "war_room",
                                "team_affinity": "research_team",
                                "authority_level": 4,
                                "primary_widgets": ["sources", "summary"],
                                "secondary_widgets": ["logs"]
                            }
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(create_response.status(), StatusCode::CREATED);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: AgentBlueprint = serde_json::from_slice(&create_body).unwrap();
        assert_eq!(created.owner_user_id, "user-1");
        assert!(!created.is_builtin);

        let list_user_1 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/blueprints")
                    .header("authorization", format!("Bearer {}", token_user_1))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_user_1.status(), StatusCode::OK);
        let list_user_1_body = to_bytes(list_user_1.into_body(), usize::MAX).await.unwrap();
        let items_user_1: Vec<AgentBlueprint> = serde_json::from_slice(&list_user_1_body).unwrap();
        assert_eq!(items_user_1.len(), 4);
        assert_core_builtin_blueprints_present(&items_user_1);
        assert!(items_user_1
            .iter()
            .any(|item| item.name == "Research Strategist"));

        let list_user_2 = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/blueprints")
                    .header("authorization", format!("Bearer {}", token_user_2))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_user_2.status(), StatusCode::OK);
        let list_user_2_body = to_bytes(list_user_2.into_body(), usize::MAX).await.unwrap();
        let items_user_2: Vec<AgentBlueprint> = serde_json::from_slice(&list_user_2_body).unwrap();
        assert_eq!(items_user_2.len(), 3);
        assert_core_builtin_blueprints_present(&items_user_2);
        assert!(!items_user_2
            .iter()
            .any(|item| item.name == "Research Strategist"));
    }

    fn assert_core_builtin_blueprints_present(items: &[AgentBlueprint]) {
        let mut roles: Vec<_> = items
            .iter()
            .filter(|item| item.is_builtin)
            .map(|item| item.role_label.as_str())
            .collect();
        roles.sort_unstable();

        assert_eq!(roles, vec!["pm", "reviewer", "verifier"]);
    }

    #[tokio::test]
    async fn create_blueprint_requires_authentication() {
        let pool = test_pool().await;
        seed_builtin_blueprints(&pool).await.unwrap();
        let app = test_app(pool);

        let response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/blueprints")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({
                            "name": "Unauthorized Blueprint",
                            "role_label": "unauthorized"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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

    fn test_app(pool: sqlx::SqlitePool) -> Router {
        std::env::set_var(
            "DAACS_JWT_SECRET",
            "test-daacs-jwt-secret-for-routes-32chars",
        );
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
}
