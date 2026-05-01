use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post, put},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tracing::info;

use crate::{
    auth::{require_project_claims, ErrorBody},
    domain::{
        blueprint::AgentBlueprint,
        instance::AgentInstance,
        repository,
        runtime::{CompanyRuntime, ExecutionMode},
    },
    AppState,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

#[derive(Debug, Deserialize, Default)]
struct RuntimeListQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct BootstrapRuntimeBody {
    company_name: Option<String>,
    blueprint_ids: Option<Vec<String>>,
    execution_mode: Option<ExecutionMode>,
}

#[derive(Debug, Deserialize)]
struct CreateInstanceBody {
    blueprint_id: String,
    assigned_team: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateOfficeProfileBody {
    office_profile: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct RuntimeBundleResponse {
    runtime: CompanyRuntime,
    instances: Vec<AgentInstance>,
    blueprints: Vec<AgentBlueprint>,
}

pub fn runtime_router() -> Router<AppState> {
    Router::new()
        .route("/runtimes", get(list_runtimes))
        .route("/runtimes/:runtime_id", get(get_runtime_by_id))
        .route("/runtimes/:runtime_id/agents", get(list_runtime_agents))
        .route("/projects/:project_id/runtime", get(get_project_runtime))
        .route(
            "/projects/:project_id/runtime/office-profile",
            put(update_project_office_profile),
        )
        .route(
            "/projects/:project_id/runtime/bootstrap",
            post(bootstrap_runtime),
        )
        .route("/projects/:project_id/clock-in", post(clock_in_project))
        .route("/projects/:project_id/clock-out", post(clock_out_project))
        .route(
            "/projects/:project_id/instances",
            get(list_project_instances).post(create_project_instance),
        )
}

async fn clock_in_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    Ok(Json(json!({
        "status": "clocked_in",
        "project_id": project_id,
    })))
}

async fn clock_out_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    Ok(Json(json!({
        "status": "clocked_out",
        "project_id": project_id,
    })))
}

async fn list_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<RuntimeListQuery>,
) -> ApiResult<Json<Vec<CompanyRuntime>>> {
    let project_id = query
        .project_id
        .as_deref()
        .ok_or_else(|| bad_request("project_id is required"))?;
    require_project_claims(&state.pool, &headers, project_id).await?;

    let runtime = repository::get_runtime_for_project(&state.pool, project_id)
        .await
        .map_err(internal_error)?;
    Ok(Json(runtime.into_iter().collect()))
}

async fn get_runtime_by_id(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(runtime_id): Path<String>,
) -> ApiResult<Json<CompanyRuntime>> {
    let project_id = repository::find_project_id_for_runtime(&state.pool, &runtime_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let runtime = repository::get_runtime(&state.pool, &runtime_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    Ok(Json(runtime))
}

async fn list_runtime_agents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(runtime_id): Path<String>,
) -> ApiResult<Json<Vec<AgentInstance>>> {
    let project_id = repository::find_project_id_for_runtime(&state.pool, &runtime_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    Ok(Json(instances))
}

async fn get_project_runtime(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<RuntimeBundleResponse>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    let bundle = build_runtime_bundle_response(&state.pool, runtime, instances)
        .await
        .map_err(internal_error)?;

    Ok(Json(bundle))
}

async fn bootstrap_runtime(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<BootstrapRuntimeBody>,
) -> ApiResult<impl IntoResponse> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let BootstrapRuntimeBody {
        company_name,
        blueprint_ids,
        execution_mode,
    } = input;

    if let Some(runtime) = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
    {
        let instances = repository::list_instances_for_project(&state.pool, &project_id)
            .await
            .map_err(internal_error)?;
        let bundle = build_runtime_bundle_response(&state.pool, runtime, instances)
            .await
            .map_err(internal_error)?;
        return Ok((StatusCode::OK, Json(bundle)));
    }

    let blueprints = load_requested_blueprints(&state.pool, blueprint_ids.as_deref())
        .await
        .map_err(internal_error)?;
    if blueprints.is_empty() {
        return Err(bad_request("At least one blueprint is required"));
    }

    let mut instances = Vec::with_capacity(blueprints.len());
    for blueprint in &blueprints {
        let instance = repository::create_instance(
            &state.pool,
            &blueprint.id,
            &project_id,
            Some(blueprint.ui_profile.team_affinity.as_str()),
        )
        .await
        .map_err(internal_error)?;
        instances.push(instance);
    }

    let instance_ids = instances
        .iter()
        .map(|instance| instance.instance_id.clone())
        .collect::<Vec<_>>();
    let company_name = match company_name {
        Some(name) if !name.trim().is_empty() => name,
        _ => repository::get_project_name(&state.pool, &project_id)
            .await
            .map_err(internal_error)?
            .unwrap_or_else(|| "DAACS Runtime".to_string()),
    };

    let runtime = repository::create_runtime(
        &state.pool,
        &project_id,
        &company_name,
        &json!({
            "project_id": project_id.clone(),
            "agents": blueprints
                .iter()
                .map(|blueprint| json!({
                    "blueprint_id": blueprint.id.clone(),
                    "role_label": blueprint.role_label.clone(),
                    "team_affinity": blueprint.ui_profile.team_affinity.clone(),
                }))
                .collect::<Vec<_>>(),
        }),
        &instance_ids,
        &json!({
            "meeting_style": "runtime_aware",
            "default_facilitator": "pm",
        }),
        &json!({
            "owner_gate": blueprints
                .iter()
                .filter(|blueprint| blueprint.ui_profile.authority_level >= 8)
                .map(|blueprint| blueprint.role_label.clone())
                .collect::<Vec<_>>(),
        }),
        &json!({
            "artifacts": [],
            "channels": ["planning", "execution", "review"],
        }),
        &execution_mode.unwrap_or(ExecutionMode::Assisted),
        &json!({
            "status": "idle",
            "pending_approvals": [],
        }),
    )
    .await
    .map_err(internal_error)?;

    let bundle = build_runtime_bundle_response(&state.pool, runtime, instances)
        .await
        .map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(bundle)))
}

async fn list_project_instances(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Vec<AgentInstance>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    Ok(Json(instances))
}

async fn create_project_instance(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<CreateInstanceBody>,
) -> ApiResult<impl IntoResponse> {
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let blueprint = repository::get_blueprint_by_id(&state.pool, &input.blueprint_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Blueprint not found"))?;

    let assigned_team = input
        .assigned_team
        .clone()
        .or_else(|| Some(blueprint.ui_profile.team_affinity.clone()));
    let instance = repository::create_instance(
        &state.pool,
        &input.blueprint_id,
        &project_id,
        assigned_team.as_deref(),
    )
    .await
    .map_err(internal_error)?;

    if let Some(runtime) = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
    {
        let mut instance_ids = runtime.agent_instance_ids.clone();
        if !instance_ids.iter().any(|id| id == &instance.instance_id) {
            instance_ids.push(instance.instance_id.clone());
            let _ = repository::update_runtime_agent_instance_ids(
                &state.pool,
                &runtime.runtime_id,
                &instance_ids,
            )
            .await
            .map_err(internal_error)?;
        }
    }

    Ok((StatusCode::CREATED, Json(instance)))
}

async fn update_project_office_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<UpdateOfficeProfileBody>,
) -> ApiResult<Json<RuntimeBundleResponse>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let next_org_graph =
        merge_office_profile_into_org_graph(&runtime.org_graph, &input.office_profile)
            .map_err(internal_error)?;
    let updated_runtime =
        repository::update_runtime_org_graph(&state.pool, &runtime.runtime_id, &next_org_graph)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| not_found("Runtime not found"))?;
    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    let bundle = build_runtime_bundle_response(&state.pool, updated_runtime.clone(), instances)
        .await
        .map_err(internal_error)?;

    repository::append_execution_event(
        &state.pool,
        &project_id,
        &updated_runtime.runtime_id,
        None,
        None,
        None,
        &crate::events::EventType::RuntimeUpdated,
        &json!({
            "runtime_id": updated_runtime.runtime_id,
            "office_profile_id": office_profile_id(&input.office_profile),
            "office_profile_updated_at": office_profile_updated_at(&input.office_profile),
        }),
    )
    .await
    .and_then(|event| {
        info!("updated office profile for project {}", project_id);
        state.event_bus.emit(event.clone())?;
        Ok(event)
    })
    .map_err(internal_error)?;

    Ok(Json(bundle))
}

async fn load_requested_blueprints(
    pool: &sqlx::SqlitePool,
    blueprint_ids: Option<&[String]>,
) -> infra_error::AppResult<Vec<AgentBlueprint>> {
    match blueprint_ids {
        Some(ids) if !ids.is_empty() => {
            let mut blueprints = Vec::with_capacity(ids.len());
            for blueprint_id in ids {
                if let Some(blueprint) = repository::get_blueprint_by_id(pool, blueprint_id).await?
                {
                    blueprints.push(blueprint);
                }
            }
            Ok(blueprints)
        }
        _ => repository::list_builtin_blueprints(pool).await,
    }
}

async fn load_blueprints_for_instances(
    pool: &sqlx::SqlitePool,
    instances: &[AgentInstance],
) -> infra_error::AppResult<Vec<AgentBlueprint>> {
    let mut blueprints = Vec::with_capacity(instances.len());
    for instance in instances {
        if let Some(blueprint) =
            repository::get_blueprint_by_id(pool, &instance.blueprint_id).await?
        {
            blueprints.push(blueprint);
        }
    }
    Ok(blueprints)
}

async fn build_runtime_bundle_response(
    pool: &sqlx::SqlitePool,
    runtime: CompanyRuntime,
    instances: Vec<AgentInstance>,
) -> infra_error::AppResult<RuntimeBundleResponse> {
    let blueprints = load_blueprints_for_instances(pool, &instances).await?;
    Ok(RuntimeBundleResponse {
        runtime,
        instances,
        blueprints,
    })
}

fn merge_office_profile_into_org_graph(
    org_graph: &Value,
    office_profile: &Value,
) -> infra_error::AppResult<Value> {
    let mut merged = match org_graph {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    };
    merged.insert("office_profile".into(), office_profile.clone());
    merged.insert("zones".into(), office_profile_zones_map(office_profile)?);
    Ok(Value::Object(merged))
}

fn office_profile_zones_map(office_profile: &Value) -> infra_error::AppResult<Value> {
    let Some(zones) = office_profile.get("zones").and_then(Value::as_array) else {
        return Ok(Value::Object(Map::new()));
    };

    let mut mapped = Map::new();
    for zone in zones {
        let Some(zone_id) = zone.get("id").and_then(Value::as_str) else {
            continue;
        };
        mapped.insert(
            zone_id.to_string(),
            json!({
                "label": zone.get("label").cloned().unwrap_or(Value::Null),
                "accent_color": zone.get("accent_color").cloned().unwrap_or(Value::Null),
                "row": zone.get("row").cloned().unwrap_or(Value::Null),
                "col": zone.get("col").cloned().unwrap_or(Value::Null),
                "row_span": zone.get("row_span").cloned().unwrap_or(Value::Null),
                "col_span": zone.get("col_span").cloned().unwrap_or(Value::Null),
                "preset": zone.get("preset").cloned().unwrap_or(Value::Null),
                "label_position": zone.get("label_position").cloned().unwrap_or(Value::Null),
            }),
        );
    }
    Ok(Value::Object(mapped))
}

fn office_profile_id(office_profile: &Value) -> Option<String> {
    office_profile
        .get("office_profile_id")
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn office_profile_updated_at(office_profile: &Value) -> Option<String> {
    office_profile
        .get("metadata")
        .and_then(Value::as_object)
        .and_then(|metadata| metadata.get("updated_at"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
}

fn internal_error(err: infra_error::AppError) -> (StatusCode, Json<ErrorBody>) {
    tracing::warn!("runtime route error: {}", err);
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
        domain::{repository, runtime::ExecutionMode, skills::load_shared_skill_loader},
        events::{EventBus, EventType},
        jwt,
        routes::api_router,
        AppState,
    };

    use super::RuntimeBundleResponse;

    #[tokio::test]
    async fn update_project_office_profile_persists_runtime_org_graph() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let runtime = repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &serde_json::json!({ "zones": {} }),
            &Vec::<String>::new(),
            &serde_json::json!({ "meeting_style": "runtime_aware" }),
            &serde_json::json!({ "owner_gate": [] }),
            &serde_json::json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &serde_json::json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();
        let body = serde_json::to_vec(&serde_json::json!({
            "office_profile": {
                "office_profile_id": "office-project-1",
                "project_id": "project-1",
                "name": "Project One Office",
                "theme": {
                    "theme_id": "custom",
                    "shell_color": "#000000",
                    "floor_color": "#111111",
                    "panel_color": "#222222",
                    "accent_color": "#333333"
                },
                "zones": [
                    {
                        "id": "lobby",
                        "label": "Main Lobby",
                        "accent_color": "#94A3B8",
                        "row": 0,
                        "col": 0,
                        "row_span": 1,
                        "col_span": 1,
                        "preset": "lobby",
                        "label_position": "top-left"
                    }
                ],
                "desks": [],
                "furniture": [],
                "agent_assignments": [],
                "routing": {
                    "algorithm": "a_star_grid",
                    "cell_size": 24,
                    "blocked_cells": [],
                    "preferred_zone_costs": { "lobby": 0.9 }
                },
                "metadata": {
                    "source": "customized",
                    "runtime_id": runtime.runtime_id,
                    "updated_at": "2026-04-07T09:00:00.000Z"
                }
            }
        }))
        .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/projects/project-1/runtime/office-profile")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let bundle: RuntimeBundleResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(bundle.runtime.runtime_id, runtime.runtime_id);
        assert_eq!(
            bundle
                .runtime
                .org_graph
                .get("office_profile")
                .and_then(|value| value.get("office_profile_id"))
                .and_then(|value| value.as_str()),
            Some("office-project-1")
        );
        assert_eq!(
            bundle
                .runtime
                .org_graph
                .get("zones")
                .and_then(|value| value.get("lobby"))
                .and_then(|value| value.get("label"))
                .and_then(|value| value.as_str()),
            Some("Main Lobby")
        );

        let events = repository::list_events_for_project(&pool, "project-1", 8)
            .await
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.event_type == EventType::RuntimeUpdated),
            "office profile update should emit runtime_updated",
        );
    }

    #[tokio::test]
    async fn clock_in_project_requires_membership_and_returns_status() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_user(&pool, "user-2", "user2@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let app = test_app(pool);
        let owner_token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();
        let outsider_token =
            jwt::create_access_token("user-2", "user2@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let owner_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/clock-in")
                    .header("authorization", format!("Bearer {}", owner_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(owner_response.status(), StatusCode::OK);
        let body = to_bytes(owner_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["status"], "clocked_in");
        assert_eq!(payload["project_id"], "project-1");

        let outsider_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/clock-out")
                    .header("authorization", format!("Bearer {}", outsider_token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(outsider_response.status(), StatusCode::FORBIDDEN);
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

    async fn insert_project_membership(
        pool: &sqlx::SqlitePool,
        project_id: &str,
        project_name: &str,
        user_id: &str,
    ) {
        sqlx::query("INSERT INTO projects (id, name) VALUES (?, ?)")
            .bind(project_id)
            .bind(project_name)
            .execute(pool)
            .await
            .unwrap();

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
