use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{require_project_claims, ErrorBody},
    domain::repository,
    events::{EventType, RuntimeEvent},
    AppState,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

#[derive(Debug, Deserialize, Default)]
struct AgentHistoryQuery {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    agent_id: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct AgentEventsQuery {
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    event_type: Option<String>,
}

pub fn agents_router() -> Router<AppState> {
    Router::new()
        .route("/agents/:project_id/:role/history", get(agent_history))
        .route("/agents/:project_id/:role/events", get(agent_events))
}

async fn agent_history(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, role)): Path<(String, String)>,
    Query(query): Query<AgentHistoryQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let limit = clamp_limit(query.limit, 50, 200);
    let events = repository::list_events_for_project(&state.pool, &project_id, (limit * 6) as i64)
        .await
        .map_err(internal_error)?;

    let mut rows = Vec::new();
    let mut seen = HashSet::new();
    for event in events {
        if !event_matches_scope(&event, &role, query.agent_id.as_deref()) {
            continue;
        }
        let Some(row) = history_row_from_event(&event) else {
            continue;
        };
        let row_id = row
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if row_id.is_empty() || seen.contains(&row_id) {
            continue;
        }
        seen.insert(row_id);
        rows.push(row);
        if rows.len() >= limit {
            break;
        }
    }

    Ok(Json(rows))
}

async fn agent_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, role)): Path<(String, String)>,
    Query(query): Query<AgentEventsQuery>,
) -> ApiResult<Json<Vec<Value>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let limit = clamp_limit(query.limit, 50, 200);
    let events = repository::list_events_for_project(&state.pool, &project_id, (limit * 6) as i64)
        .await
        .map_err(internal_error)?;

    let mut rows = Vec::new();
    for event in events {
        if !event_matches_scope(&event, &role, query.agent_id.as_deref()) {
            continue;
        }
        for row in event_rows_from_runtime_event(&event, &role) {
            if let Some(filter) = query.event_type.as_deref() {
                let matches = row
                    .get("event_type")
                    .and_then(Value::as_str)
                    .map(|value| value == filter)
                    .unwrap_or(false);
                if !matches {
                    continue;
                }
            }
            rows.push(row);
            if rows.len() >= limit {
                return Ok(Json(rows));
            }
        }
    }

    Ok(Json(rows))
}

fn clamp_limit(raw: Option<usize>, default: usize, max: usize) -> usize {
    raw.unwrap_or(default).clamp(1, max)
}

fn payload_map(event: &RuntimeEvent) -> HashMap<&str, &Value> {
    event
        .payload
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(key, value)| (key.as_str(), value))
                .collect()
        })
        .unwrap_or_default()
}

fn payload_string<'a>(payload: &'a HashMap<&str, &'a Value>, key: &str) -> Option<&'a str> {
    payload.get(key).and_then(|value| value.as_str())
}

fn role_matches(payload: &HashMap<&str, &Value>, role: &str) -> bool {
    [
        "role_label",
        "agent_role",
        "from_role",
        "to_role",
        "assigned_role_label",
        "approver_role_label",
        "approval_role_label",
        "requested_by_role",
    ]
    .iter()
    .any(|key| payload_string(payload, key) == Some(role))
}

fn agent_matches(payload: &HashMap<&str, &Value>, agent_id: Option<&str>) -> bool {
    let Some(agent_id) = agent_id else {
        return true;
    };
    [
        "agent_id",
        "assigned_to",
        "instance_id",
        "to_instance_id",
        "from_instance_id",
        "requested_by",
    ]
    .iter()
    .any(|key| payload_string(payload, key) == Some(agent_id))
}

fn event_matches_scope(event: &RuntimeEvent, role: &str, agent_id: Option<&str>) -> bool {
    let payload = payload_map(event);
    role_matches(&payload, role) && agent_matches(&payload, agent_id)
}

fn history_row_from_event(event: &RuntimeEvent) -> Option<Value> {
    let payload = payload_map(event);
    let id = event
        .step_id
        .clone()
        .or_else(|| payload_string(&payload, "intent_id").map(ToOwned::to_owned))
        .unwrap_or_else(|| event.event_id.clone());
    let description = payload_string(&payload, "label")
        .or_else(|| payload_string(&payload, "step_label"))
        .or_else(|| payload_string(&payload, "title"))
        .or_else(|| payload_string(&payload, "description"))
        .unwrap_or("Activity");

    let (status, result_summary, result_value, started_at, completed_at) = match event.event_type {
        EventType::StepStatusChanged => {
            let status = match payload_string(&payload, "status").unwrap_or("pending") {
                "completed" | "approved" => "completed",
                "failed" => "failed",
                "in_progress" | "awaiting_approval" => "running",
                _ => "queued",
            };
            let result_summary =
                payload_string(&payload, "summary").or_else(|| payload_string(&payload, "error"));
            let result_value = payload
                .get("output")
                .cloned()
                .cloned()
                .unwrap_or_else(|| json!({}));
            let started_at = if status == "running" {
                Some(event.created_at.clone())
            } else {
                None
            };
            let completed_at = if status == "completed" || status == "failed" {
                Some(event.created_at.clone())
            } else {
                None
            };
            (
                status,
                result_summary,
                result_value,
                started_at,
                completed_at,
            )
        }
        EventType::ExecutionIntentCreated => ("queued", None, json!(payload), None, None),
        EventType::ExecutionIntentStatusChanged => {
            let status = match payload_string(&payload, "status").unwrap_or("pending_approval") {
                "rejected" => "failed",
                "approved" => "queued",
                "executing" => "running",
                "completed" => "completed",
                "failed" => "failed",
                _ => "queued",
            };
            (
                status,
                payload_string(&payload, "result_summary"),
                json!(payload),
                if status == "running" {
                    Some(event.created_at.clone())
                } else {
                    None
                },
                if status == "completed" || status == "failed" {
                    Some(event.created_at.clone())
                } else {
                    None
                },
            )
        }
        EventType::ConnectorExecutionStarted => (
            "running",
            None,
            payload
                .get("result_payload")
                .cloned()
                .cloned()
                .unwrap_or_else(|| json!(payload)),
            Some(event.created_at.clone()),
            None,
        ),
        EventType::ConnectorExecutionCompleted => (
            "completed",
            payload_string(&payload, "result_summary"),
            payload
                .get("result_payload")
                .cloned()
                .cloned()
                .unwrap_or_else(|| json!(payload)),
            None,
            Some(event.created_at.clone()),
        ),
        EventType::ConnectorExecutionFailed => (
            "failed",
            payload_string(&payload, "result_summary"),
            payload
                .get("result_payload")
                .cloned()
                .cloned()
                .unwrap_or_else(|| json!(payload)),
            None,
            Some(event.created_at.clone()),
        ),
        _ => return None,
    };

    Some(json!({
        "id": id,
        "status": status,
        "description": description,
        "result_summary": result_summary,
        "result": result_value,
        "created_at": event.created_at,
        "started_at": started_at,
        "completed_at": completed_at,
    }))
}

fn event_rows_from_runtime_event(event: &RuntimeEvent, role: &str) -> Vec<Value> {
    let payload = payload_map(event);
    match event.event_type {
        EventType::AgentHandoff => {
            let mut rows = Vec::new();
            let from_role = payload_string(&payload, "from_role").unwrap_or_default();
            let to_role = payload_string(&payload, "to_role").unwrap_or_default();
            let content = format!(
                "{} -> {}",
                payload_string(&payload, "from_step_id").unwrap_or("step"),
                payload_string(&payload, "to_step_id").unwrap_or("next")
            );

            if from_role == role {
                rows.push(json!({
                    "id": format!("{}:sent", event.event_id),
                    "event_type": "message_sent",
                    "data": {
                        "from": from_role,
                        "to": to_role,
                        "content": content,
                    },
                    "created_at": event.created_at,
                }));
            }
            if to_role == role {
                rows.push(json!({
                    "id": format!("{}:received", event.event_id),
                    "event_type": "message_received",
                    "data": {
                        "from": from_role,
                        "to": to_role,
                        "content": content,
                    },
                    "created_at": event.created_at,
                }));
            }
            rows
        }
        EventType::StepStatusChanged if payload_string(&payload, "status") == Some("failed") => {
            vec![json!({
                "id": format!("{}:error", event.event_id),
                "event_type": "error",
                "data": {
                    "error": payload_string(&payload, "error").unwrap_or("Step failed"),
                },
                "created_at": event.created_at,
            })]
        }
        EventType::ConnectorExecutionFailed => vec![json!({
            "id": format!("{}:error", event.event_id),
            "event_type": "error",
            "data": {
                "error": payload_string(&payload, "result_summary").unwrap_or("Connector execution failed"),
            },
            "created_at": event.created_at,
        })],
        _ => Vec::new(),
    }
}

fn internal_error(err: infra_error::AppError) -> (StatusCode, Json<ErrorBody>) {
    tracing::warn!("agents route error: {}", err);
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorBody {
            detail: "Server error".into(),
        }),
    )
}
