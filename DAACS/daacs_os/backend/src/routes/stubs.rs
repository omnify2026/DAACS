use axum::{
    extract::{Path, State},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::AppState;

pub fn stubs_router() -> Router<AppState> {
    Router::new()
        .route("/agents/:project_id", get(agents_list))
        .route("/agents/:project_id/:role", get(agent_get))
        .route("/agents/:project_id/:role/command", post(agent_command))
        .route("/agents/:project_id/:role/task", post(agent_task))
        .route("/agents/:project_id/:role/stream-task", post(agent_stream_task))
        .route("/agents/:project_id/:role/task/:task_id", get(agent_task_get))
        .route("/agents/:project_id/:role/history", get(agent_history))
        .route("/agents/:project_id/:role/events", get(agent_events))
        .route("/agents/:project_id/server-status", get(agents_server_status))
        .route("/agents/:project_id/start-parallel", post(agents_start_parallel))
        .route("/agents/:project_id/stop-parallel", post(agents_stop_parallel))
        .route("/agents/:project_id/parallel-status", get(agents_parallel_status))
        .route("/agents/:project_id/broadcast", post(agents_broadcast))
        .route("/projects/:project_id/clock-in", post(projects_clock_in))
        .route("/projects/:project_id/clock-out", post(projects_clock_out))
        .route("/projects/:project_id/llm-settings", get(projects_llm_settings).put(projects_llm_settings_put))
        .route("/teams", get(teams_list))
        .route("/teams/:project_id/task", post(teams_task))
        .route("/teams/:project_id/parallel", post(teams_parallel))
        .route("/workflows/:project_id/start", post(workflows_start))
        .route("/workflows/:project_id", get(workflows_list))
        .route("/workflows/:project_id/:workflow_id", get(workflows_get))
        .route("/workflows/:project_id/:workflow_id/stop", post(workflows_stop))
        .route("/workflows/:project_id/overnight", post(overnight_start))
        .route("/workflows/:project_id/overnight/:run_id", get(overnight_get))
        .route("/workflows/:project_id/overnight/:run_id/stop", post(overnight_stop))
        .route("/workflows/:project_id/overnight/:run_id/resume", post(overnight_resume))
        .route("/workflows/:project_id/overnight/:run_id/report", get(overnight_report))
        .route("/presets", get(presets_list))
        .route("/presets/:preset_id", get(presets_get))
        .route("/skills/catalog", get(skills_catalog))
        .route("/skills/bundles", get(skills_bundles))
        .route("/skills/:project_id/custom", post(skills_custom))
        .route("/skills/:project_id/:role", get(skills_agent))
        .route("/dashboard/:project_id/:role", get(dashboard_role))
        .route("/dashboard/:project_id/cost-report", get(dashboard_cost_report))
        .route("/dashboard/:project_id/safety-report", get(dashboard_safety_report))
        .route("/dashboard/:project_id/worktree", get(dashboard_worktree))
        .route("/dashboard/:project_id/ide/tree", get(dashboard_ide_tree))
        .route("/dashboard/:project_id/ide/file", get(dashboard_ide_file))
        .route("/agent-factory/:project_id/create", post(agent_factory_create))
        .route("/agent-factory/:project_id/unlock-slot", post(agent_factory_unlock_slot))
        .route("/agent-factory/:project_id/list", get(agent_factory_list))
        .route("/collaboration/:project_id/sessions", post(collaboration_sessions_post))
        .route("/collaboration/:project_id/sessions/:session_id", get(collaboration_session_get))
        .route("/collaboration/:project_id/sessions/:session_id/stop", post(collaboration_session_stop))
        .route("/collaboration/:project_id/sessions/:session_id/rounds", post(collaboration_rounds_post))
        .route("/ops/:project_id/status", get(ops_status))
        .route("/ops/:project_id/decisions", get(ops_decisions).post(ops_decisions_post))
}

async fn agents_list(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

async fn agent_get(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "role": "", "status": "idle" }))
}

async fn agent_command(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn agent_task(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "task_id": "", "status": "pending" }))
}

async fn agent_stream_task(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "task_id": "", "status": "pending" }))
}

async fn agent_task_get(Path((_project_id, _role, _task_id)): Path<(String, String, String)>) -> Json<Value> {
    Json(json!({ "id": "", "status": "pending" }))
}

async fn agent_history(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!([]))
}

async fn agent_events(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!([]))
}

async fn agents_server_status(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "running": false }))
}

async fn agents_start_parallel(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn agents_stop_parallel(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn agents_parallel_status(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "active": false }))
}

async fn agents_broadcast(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn projects_clock_in(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "clocked_in", "project_id": "" }))
}

async fn projects_clock_out(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "clocked_out" }))
}

async fn projects_llm_settings(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "codex_only": false, "role_overrides": {} }))
}

async fn projects_llm_settings_put(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "saved" }))
}

async fn teams_list() -> Json<Value> {
    Json(json!([]))
}

async fn teams_task(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "team_submitted", "task_ids": [] }))
}

async fn teams_parallel(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "ok", "task_ids": [] }))
}

async fn workflows_start(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "id": "", "workflow_name": "feature_development", "status": "created" }))
}

async fn workflows_list(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

async fn workflows_get(Path((_project_id, _workflow_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "id": "", "status": "created", "steps": [] }))
}

async fn workflows_stop(Path((_project_id, _workflow_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "status": "stopped" }))
}

async fn overnight_start(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "run_id": "", "status": "pending" }))
}

async fn overnight_get(Path((_project_id, _run_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "run_id": "", "status": "pending" }))
}

async fn overnight_stop(Path((_project_id, _run_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "status": "stopped" }))
}

async fn overnight_resume(Path((_project_id, _run_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "status": "resumed" }))
}

async fn overnight_report(Path((_project_id, _run_id)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "report": {} }))
}

async fn presets_list() -> Json<Value> {
    Json(json!([]))
}

async fn presets_get(Path(_preset_id): Path<String>) -> Json<Value> {
    Json(json!({ "id": "", "name": "" }))
}

async fn skills_catalog(State(state): State<AppState>) -> Json<Value> {
    let loader = state.skill_loader.lock().await;
    Json(json!(loader.get_skill_catalog()))
}

async fn skills_bundles(State(state): State<AppState>) -> Json<Value> {
    let loader = state.skill_loader.lock().await;
    Json(loader.get_bundle_summary())
}

#[derive(Debug, Deserialize)]
struct SkillsCustomRequest {
    role: String,
    skill_ids: Vec<String>,
}

async fn skills_agent(
    Path((_project_id, role)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Json<Value> {
    let mut loader = state.skill_loader.lock().await;
    let bundle_role = crate::domain::skills::normalize_bundle_role(&role);
    let bundle = loader.load_bundle(&bundle_role);
    let skills: Vec<String> = bundle
        .core_skills
        .iter()
        .chain(bundle.support_skills.iter())
        .chain(bundle.shared_skills.iter())
        .map(|skill| skill.name.clone())
        .collect();

    Json(json!({
        "role": role,
        "bundle_role": bundle_role,
        "skills": skills,
        "system_prompt": bundle.to_system_prompt(true),
        "loaded": !skills.is_empty(),
    }))
}

async fn skills_custom(
    Path((_project_id,)): Path<(String,)>,
    State(state): State<AppState>,
    Json(payload): Json<SkillsCustomRequest>,
) -> Json<Value> {
    let mut loader = state.skill_loader.lock().await;
    let bundle = loader.load_custom_skills(&payload.skill_ids, &payload.role);
    let skills: Vec<String> = bundle
        .core_skills
        .iter()
        .chain(bundle.shared_skills.iter())
        .map(|skill| skill.name.clone())
        .collect();

    Json(json!({
        "role": payload.role,
        "skill_ids": payload.skill_ids,
        "skills": skills,
        "system_prompt": bundle.to_system_prompt(true),
        "loaded": !skills.is_empty(),
    }))
}

async fn dashboard_role(Path((_project_id, _role)): Path<(String, String)>) -> Json<Value> {
    Json(json!({ "role": "", "status": "idle", "tabs": [] }))
}

async fn dashboard_cost_report(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "spent_usd": 0.0, "daily_cap_usd": 1.0 }))
}

async fn dashboard_safety_report(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "turn_limit": {}, "spend_cap": {} }))
}

async fn dashboard_worktree(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

async fn dashboard_ide_tree(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

async fn dashboard_ide_file(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "path": "", "content": "" }))
}

async fn agent_factory_create(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "created", "agent": {} }))
}

async fn agent_factory_unlock_slot(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "unavailable" }))
}

async fn agent_factory_list(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

#[derive(Debug, Deserialize)]
struct CollaborationSessionRequest {
    #[serde(default)]
    shared_goal: String,
    #[serde(default)]
    participants: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CollaborationRoundRequest {
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    teams: Vec<String>,
    #[serde(default)]
    project_cwd: Option<String>,
}

fn collaboration_session_key(project_id: &str, session_id: &str) -> String {
    format!("{}:{}", project_id.trim(), session_id.trim())
}

async fn collaboration_sessions_post(
    Path(project_id): Path<String>,
    State(state): State<AppState>,
    Json(payload): Json<CollaborationSessionRequest>,
) -> Json<Value> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let key = collaboration_session_key(&project_id, &session_id);
    let session = json!({
        "status": "ok",
        "session_id": session_id,
        "shared_goal": payload.shared_goal,
        "participants": payload.participants,
        "stopped": false,
        "stop_reason": null,
        "last_round_id": null,
        "last_round_created_at": null,
    });
    state
        .collaboration_sessions
        .lock()
        .await
        .insert(key, session.clone());
    Json(session)
}

async fn collaboration_session_get(
    Path((project_id, session_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Json<Value> {
    let key = collaboration_session_key(&project_id, &session_id);
    let stored = state
        .collaboration_sessions
        .lock()
        .await
        .get(&key)
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "status": "missing",
                "session_id": session_id,
                "shared_goal": "",
                "participants": [],
                "stopped": false,
                "stop_reason": null,
                "last_round_id": null,
                "last_round_created_at": null,
            })
        });
    Json(stored)
}

async fn collaboration_session_stop(
    Path((project_id, session_id)): Path<(String, String)>,
    State(state): State<AppState>,
) -> Json<Value> {
    let key = collaboration_session_key(&project_id, &session_id);
    let mut sessions = state.collaboration_sessions.lock().await;
    let current = sessions.get(&key).cloned().unwrap_or_else(|| {
        json!({
            "status": "ok",
            "session_id": session_id,
            "shared_goal": "",
            "participants": [],
            "stopped": false,
            "stop_reason": null,
            "last_round_id": null,
            "last_round_created_at": null,
        })
    });
    let updated = json!({
        "status": "stopped",
        "session_id": current.get("session_id").cloned().unwrap_or_else(|| json!(session_id)),
        "shared_goal": current.get("shared_goal").cloned().unwrap_or_else(|| json!("")),
        "participants": current.get("participants").cloned().unwrap_or_else(|| json!([])),
        "stopped": true,
        "stop_reason": "user_requested",
        "last_round_id": current.get("last_round_id").cloned().unwrap_or(Value::Null),
        "last_round_created_at": current.get("last_round_created_at").cloned().unwrap_or(Value::Null),
    });
    sessions.insert(key, updated.clone());
    Json(updated)
}

async fn collaboration_rounds_post(
    Path((project_id, session_id)): Path<(String, String)>,
    State(state): State<AppState>,
    Json(payload): Json<CollaborationRoundRequest>,
) -> Json<Value> {
    let key = collaboration_session_key(&project_id, &session_id);
    let mut sessions = state.collaboration_sessions.lock().await;
    let existing = sessions.get(&key).cloned().unwrap_or_else(|| {
        json!({
            "status": "ok",
            "session_id": session_id,
            "shared_goal": "",
            "participants": [],
            "stopped": false,
            "stop_reason": null,
            "last_round_id": null,
            "last_round_created_at": null,
        })
    });
    let stopped = existing
        .get("stopped")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    if stopped {
        return Json(json!({
            "status": "stopped",
            "session_id": session_id,
            "round": { "round_id": "", "created_at": 0 },
            "artifact": {
                "session_id": session_id,
                "round_id": "",
                "decision": "Collaboration session is stopped.",
                "open_questions": [],
                "next_actions": ["Session stopped by user"],
                "contributions": [],
            }
        }));
    }

    let round_id = uuid::Uuid::new_v4().to_string();
    let created_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0);
    let summary = payload.prompt.trim();
    let goal_summary = if summary.is_empty() {
        "공유 목표".to_string()
    } else {
        summary.chars().take(180).collect()
    };
    let project_cwd = payload
        .project_cwd
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_string();
    let workspace_action = if project_cwd.is_empty() {
        "데스크톱/Tauri 앱에서 워크스페이스 경로를 저장한 뒤 실제 provider 라운드를 다시 실행하세요.".to_string()
    } else {
        format!(
            "데스크톱/Tauri 앱에서 실제 provider 라운드를 다시 실행하세요. 저장된 워크스페이스: {}",
            project_cwd
        )
    };
    let updated = json!({
        "status": "incomplete",
        "session_id": session_id,
        "shared_goal": existing.get("shared_goal").cloned().unwrap_or_else(|| json!("")),
        "participants": existing.get("participants").cloned().unwrap_or_else(|| json!([])),
        "stopped": false,
        "stop_reason": null,
        "last_round_id": round_id,
        "last_round_created_at": created_at,
    });
    sessions.insert(key, updated);

    Json(json!({
        "status": "incomplete",
        "session_id": session_id,
        "round": { "round_id": round_id, "status": "incomplete", "created_at": created_at },
        "artifact": {
            "session_id": session_id,
            "round_id": round_id,
            "status": "incomplete",
            "decision": format!("웹 API collaboration stub은 실제 LLM/provider 실행 경로가 아닙니다. 요청 \"{}\"은(는) 기록만 되었고, 실제 PM/구현/reviewer/verifier 라운드는 desktop/Tauri Prompting Sequencer에서 실행해야 합니다.", goal_summary),
            "open_questions": ["웹 서버 collaboration runtime은 아직 stub입니다."],
            "next_actions": [
                workspace_action,
                "3차 후보 증거는 Goal Meeting의 live-provider evidence JSON에서 저장하세요.",
                format!("요청된 팀 힌트: {}", payload.teams.join(", ")),
            ],
            "contributions": [],
        }
    }))
}

async fn ops_status(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "idle" }))
}

async fn ops_decisions(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!([]))
}

async fn ops_decisions_post(Path(_project_id): Path<String>) -> Json<Value> {
    Json(json!({ "status": "ok" }))
}
