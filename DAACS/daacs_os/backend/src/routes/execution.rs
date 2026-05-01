use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    auth::{require_project_claims, ErrorBody},
    domain::{
        blueprint::AgentBlueprint,
        execution::{
            ExecutionIntent, ExecutionIntentKind, ExecutionIntentStatus, ExecutionPlan,
            ExecutionStep, NewExecutionIntent, PlanStatus, StepStatus,
        },
        instance::{AgentInstance, RuntimeStatus},
        repository,
    },
    events::{EventBus, EventType, RuntimeEvent},
    executor::{
        AgentExecutor, ConnectorExecutor, ContextSnapshot, RuntimeContext, ServerConnectorExecutor,
        StepHandoff, StepOutput, StepTransition,
    },
    planner::PmPlanner,
    AppState,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ErrorBody>)>;

#[derive(Debug, Deserialize, Default)]
struct ExecutionPlansQuery {
    runtime_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreatePlanBody {
    goal: String,
}

#[derive(Debug, Deserialize, Default)]
struct StartWorkflowBody {
    #[serde(default = "default_legacy_workflow_name")]
    workflow_name: String,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct LegacyWorkflowResponse {
    workflow_id: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct LegacyWorkflowStatusResponse {
    id: String,
    name: String,
    workflow_name: String,
    status: String,
    current_step: usize,
    total_steps: usize,
    steps: Vec<serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct LegacyOvernightConstraints {
    #[serde(default = "default_overnight_runtime_minutes")]
    max_runtime_minutes: i64,
    #[serde(default = "default_overnight_max_spend_usd")]
    max_spend_usd: f64,
    #[serde(default = "default_overnight_max_iterations")]
    max_iterations: i64,
    #[serde(default)]
    allowed_tools: Vec<String>,
    #[serde(default)]
    blocked_commands: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct StartOvernightBody {
    #[serde(default = "default_legacy_workflow_name")]
    workflow_name: String,
    #[serde(default)]
    goal: Option<String>,
    #[serde(default)]
    constraints: LegacyOvernightConstraints,
    #[serde(default)]
    definition_of_done: Vec<String>,
    #[serde(default = "default_overnight_verification_profile")]
    verification_profile: String,
    #[serde(default = "default_overnight_quality_threshold")]
    quality_threshold: i64,
    #[serde(default)]
    params: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize, Default)]
struct ResumeOvernightBody {
    #[serde(default)]
    additional_budget_usd: Option<f64>,
    #[serde(default)]
    additional_time_minutes: Option<i64>,
    #[serde(default)]
    additional_iterations: Option<i64>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum ExecutionTrack {
    LocalCli,
    #[default]
    Server,
}

#[derive(Debug, Deserialize, Default)]
struct ExecutePlanBody {
    execution_track: Option<ExecutionTrack>,
}

#[derive(Debug, Deserialize, Default)]
struct ApproveStepBody {
    note: Option<String>,
    execution_track: Option<ExecutionTrack>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum StepCompletionStatus {
    #[default]
    Completed,
    Failed,
}

#[derive(Debug, Deserialize, Default)]
struct CompleteStepBody {
    #[serde(default)]
    input: Option<serde_json::Value>,
    #[serde(default)]
    output: serde_json::Value,
    #[serde(default)]
    status: StepCompletionStatus,
}

#[derive(Debug, Serialize)]
struct StepListResponse {
    plan_id: String,
    steps: Vec<ExecutionStep>,
}

#[derive(Debug, Deserialize, Default)]
struct ExecutionIntentQuery {
    agent_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateExecutionIntentBody {
    agent_id: String,
    agent_role: String,
    kind: ExecutionIntentKind,
    title: String,
    description: String,
    target: String,
    connector_id: String,
    #[serde(default)]
    payload: serde_json::Value,
    #[serde(default = "default_requires_approval")]
    requires_approval: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExecutionIntentDecisionAction {
    Approved,
    Hold,
    Rejected,
}

#[derive(Debug, Deserialize)]
struct DecideExecutionIntentBody {
    action: ExecutionIntentDecisionAction,
    note: Option<String>,
    execution_track: Option<ExecutionTrack>,
}

#[derive(Debug, Deserialize, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
enum ConnectorCompletionStatus {
    #[default]
    Completed,
    Failed,
}

#[derive(Debug, Deserialize, Default)]
struct CompleteExecutionIntentBody {
    #[serde(default)]
    status: ConnectorCompletionStatus,
    result_summary: String,
    #[serde(default)]
    result_payload: Option<serde_json::Value>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Clone, Copy)]
struct EventContext<'a> {
    project_id: &'a str,
    runtime_id: &'a str,
    plan_id: Option<&'a str>,
    step_id: Option<&'a str>,
    actor_id: Option<&'a str>,
}

const COLLABORATION_SPEECH_DURATION_MS: u64 = 1400;
const COLLABORATION_ARRIVAL_BUFFER_MS: u64 = 120;

fn default_requires_approval() -> bool {
    true
}

fn default_legacy_workflow_name() -> String {
    "feature_development".to_string()
}

fn default_overnight_runtime_minutes() -> i64 {
    480
}

fn default_overnight_max_spend_usd() -> f64 {
    5.0
}

fn default_overnight_max_iterations() -> i64 {
    20
}

fn default_overnight_verification_profile() -> String {
    "default".to_string()
}

fn default_overnight_quality_threshold() -> i64 {
    7
}

fn resolve_legacy_workflow_goal(workflow_name: &str, goal: Option<&str>) -> String {
    let trimmed = goal.unwrap_or_default().trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }
    format!("Execute workflow '{workflow_name}' successfully.")
}

fn legacy_workflow_status(status: &PlanStatus) -> String {
    match status {
        PlanStatus::Draft => "created",
        PlanStatus::Active => "running",
        PlanStatus::Paused => "paused",
        PlanStatus::Completed => "completed",
        PlanStatus::Failed => "failed",
    }
    .to_string()
}

fn legacy_workflow_progress(plan: &ExecutionPlan) -> usize {
    let completed = plan
        .steps
        .iter()
        .filter(|step| {
            matches!(
                step.status,
                StepStatus::Completed | StepStatus::Approved | StepStatus::Skipped
            )
        })
        .count();

    if completed >= plan.steps.len() || plan.steps.is_empty() {
        completed
    } else {
        completed + 1
    }
}

fn legacy_workflow_steps(steps: &[ExecutionStep]) -> Vec<serde_json::Value> {
    steps
        .iter()
        .map(|step| {
            json!({
                "id": step.step_id,
                "label": step.label,
                "description": step.description,
                "status": step.status,
                "assigned_to": step.assigned_to,
                "depends_on": step.depends_on,
                "approval_required_by": step.approval_required_by,
                "input": step.input,
                "output": step.output,
                "started_at": step.started_at,
                "completed_at": step.completed_at,
            })
        })
        .collect()
}

fn legacy_workflow_from_plan(plan: &ExecutionPlan) -> LegacyWorkflowStatusResponse {
    let workflow_name = if plan.workflow_name.trim().is_empty() {
        default_legacy_workflow_name()
    } else {
        plan.workflow_name.clone()
    };

    LegacyWorkflowStatusResponse {
        id: plan.plan_id.clone(),
        name: workflow_name.clone(),
        workflow_name,
        status: legacy_workflow_status(&plan.status),
        current_step: legacy_workflow_progress(plan),
        total_steps: plan.steps.len(),
        steps: legacy_workflow_steps(&plan.steps),
    }
}

pub fn execution_router() -> Router<AppState> {
    Router::new()
        .route("/execution-plans", get(list_execution_plans))
        .route("/execution-plans/:plan_id", get(get_execution_plan))
        .route("/workflows/:project_id/start", post(start_legacy_workflow))
        .route("/workflows/:project_id", get(list_legacy_workflows))
        .route(
            "/workflows/:project_id/overnight",
            post(start_legacy_overnight),
        )
        .route(
            "/workflows/:project_id/overnight/:run_id",
            get(get_legacy_overnight_status),
        )
        .route(
            "/workflows/:project_id/overnight/:run_id/stop",
            post(stop_legacy_overnight),
        )
        .route(
            "/workflows/:project_id/overnight/:run_id/resume",
            post(resume_legacy_overnight),
        )
        .route(
            "/workflows/:project_id/overnight/:run_id/report",
            get(get_legacy_overnight_report),
        )
        .route(
            "/workflows/:project_id/:workflow_id",
            get(get_legacy_workflow),
        )
        .route(
            "/workflows/:project_id/:workflow_id/stop",
            post(stop_legacy_workflow),
        )
        .route(
            "/projects/:project_id/plans",
            get(list_project_plans).post(create_project_plan),
        )
        .route(
            "/projects/:project_id/plans/:plan_id",
            get(get_project_plan),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/events",
            get(list_project_plan_events),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/steps",
            get(list_project_plan_steps),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/ready-steps",
            get(list_project_ready_steps),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/execute",
            post(execute_project_plan),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/steps/:step_id/complete",
            post(complete_project_step),
        )
        .route(
            "/projects/:project_id/plans/:plan_id/steps/:step_id/approve",
            post(approve_project_step),
        )
        .route(
            "/projects/:project_id/execution-intents",
            get(list_project_execution_intents).post(create_project_execution_intent),
        )
        .route(
            "/projects/:project_id/execution-intents/:intent_id",
            get(get_project_execution_intent),
        )
        .route(
            "/projects/:project_id/execution-intents/:intent_id/decision",
            post(decide_project_execution_intent),
        )
        .route(
            "/projects/:project_id/execution-intents/:intent_id/complete",
            post(complete_project_execution_intent),
        )
}

async fn start_legacy_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<StartWorkflowBody>,
) -> ApiResult<Json<LegacyWorkflowResponse>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    if instances.is_empty() {
        return Err(bad_request("Runtime has no agent instances"));
    }
    let blueprints = load_blueprints_for_instances(&state.pool, &instances)
        .await
        .map_err(internal_error)?;

    let workflow_name = input.workflow_name.trim();
    let workflow_name = if workflow_name.is_empty() {
        default_legacy_workflow_name()
    } else {
        workflow_name.to_string()
    };
    let goal = resolve_legacy_workflow_goal(&workflow_name, input.goal.as_deref());
    let _legacy_params = input.params;

    let mut plan = PmPlanner::new()
        .plan(&goal, &runtime, &instances, &blueprints)
        .await
        .map_err(internal_error)?;
    plan.workflow_name = workflow_name.clone();
    let saved = repository::insert_plan(&state.pool, &plan)
        .await
        .map_err(internal_error)?;
    emit_plan_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &saved.runtime_id,
            plan_id: Some(&saved.plan_id),
            step_id: None,
            actor_id: Some(&saved.created_by),
        },
        EventType::PlanCreated,
        json!({
            "status": saved.status.clone(),
            "goal": saved.goal.clone(),
            "planner_version": saved.planner_version.clone(),
            "planning_mode": saved.planning_mode.clone(),
            "revision": saved.revision,
            "workflow_name": workflow_name,
        }),
    )
    .await
    .map_err(internal_error)?;

    let executed =
        execute_plan_internal(&state.pool, &state.event_bus, &project_id, &saved.plan_id)
            .await
            .map_err(internal_error)?;

    Ok(Json(LegacyWorkflowResponse {
        workflow_id: executed.plan_id.clone(),
        status: legacy_workflow_status(&executed.status),
    }))
}

async fn list_legacy_workflows(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Vec<LegacyWorkflowStatusResponse>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    let plans = match runtime {
        Some(runtime) => repository::list_plans_for_runtime(&state.pool, &runtime.runtime_id)
            .await
            .map_err(internal_error)?,
        None => vec![],
    };

    Ok(Json(
        plans
            .iter()
            .map(legacy_workflow_from_plan)
            .collect::<Vec<_>>(),
    ))
}

async fn get_legacy_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, workflow_id)): Path<(String, String)>,
) -> ApiResult<Json<LegacyWorkflowStatusResponse>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &workflow_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Workflow not found"))?;

    Ok(Json(legacy_workflow_from_plan(&plan)))
}

async fn stop_legacy_workflow(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, workflow_id)): Path<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &workflow_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Workflow not found"))?;

    let updated = if matches!(plan.status, PlanStatus::Completed | PlanStatus::Failed) {
        plan
    } else {
        repository::update_plan_status(&state.pool, &workflow_id, &PlanStatus::Paused)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| not_found("Workflow not found"))?
    };

    Ok(Json(json!({
        "status": legacy_workflow_status(&updated.status),
    })))
}

async fn start_legacy_overnight(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<StartOvernightBody>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    if let Some(active_run) =
        crate::overnight::get_active_overnight_run_for_project(&state.pool, &project_id)
            .await
            .map_err(internal_error)?
    {
        return Err(conflict(&format!(
            "Another overnight run is already active (id={}, status={}).",
            active_run.run_id, active_run.status
        )));
    }

    let workflow_name = input.workflow_name.trim();
    let workflow_name = if workflow_name.is_empty() {
        default_legacy_workflow_name()
    } else {
        workflow_name.to_string()
    };
    let goal = resolve_legacy_workflow_goal(&workflow_name, input.goal.as_deref());
    let config = json!({
        "mode": "overnight",
        "constraints": {
            "max_runtime_minutes": input.constraints.max_runtime_minutes,
            "max_spend_usd": input.constraints.max_spend_usd,
            "max_iterations": input.constraints.max_iterations,
            "allowed_tools": input.constraints.allowed_tools,
            "blocked_commands": input.constraints.blocked_commands,
        },
        "definition_of_done": input.definition_of_done,
        "verification_profile": input.verification_profile,
        "quality_threshold": input.quality_threshold,
        "params": input.params,
        "gate_results": [],
        "resume_policy": {
            "max_retries_per_gate": 3,
            "max_total_retries": 12,
        },
    });
    let run = crate::overnight::start_overnight_run(
        &state.pool,
        &project_id,
        &workflow_name,
        &goal,
        &config,
    )
    .await
    .map_err(internal_error)?;

    Ok(Json(json!({
        "status": "started",
        "project_id": project_id,
        "run_id": run.run_id.clone(),
        "workflow_name": workflow_name,
        "goal": goal,
        "deadline_at": run.deadline_at,
        "task_id": run.task_id,
    })))
}

async fn get_legacy_overnight_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, run_id)): Path<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;

    let run = crate::overnight::get_overnight_run(&state.pool, &project_id, &run_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Overnight run not found"))?;

    Ok(Json(json!({
        "run_id": run.run_id,
        "project_id": run.project_id,
        "workflow_name": run.workflow_name,
        "status": run.status,
        "goal": run.goal,
        "spent_usd": run.spent_usd,
        "deadline_at": run.deadline_at,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
        "overnight_config": run.overnight_config,
        "steps": run.steps,
    })))
}

async fn stop_legacy_overnight(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, run_id)): Path<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let run = crate::overnight::stop_overnight_run(&state.pool, &project_id, &run_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Overnight run not found"))?;

    Ok(Json(json!({
        "status": run.status,
        "run_id": run.run_id,
        "project_id": run.project_id,
        "workflow_name": run.workflow_name,
        "updated_at": run.updated_at,
    })))
}

async fn resume_legacy_overnight(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, run_id)): Path<(String, String)>,
    Json(input): Json<ResumeOvernightBody>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let current = crate::overnight::get_overnight_run(&state.pool, &project_id, &run_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Overnight run not found"))?;
    if !matches!(
        current.status.as_str(),
        "recovering" | "needs_human" | "stopped_with_report"
    ) {
        return Err(conflict(&format!(
            "Run status '{}' is not resumable",
            current.status
        )));
    }
    let run = crate::overnight::resume_overnight_run(
        &state.pool,
        &project_id,
        &run_id,
        crate::overnight::ResumeOvernightUpdate {
            additional_budget_usd: input.additional_budget_usd,
            additional_time_minutes: input.additional_time_minutes,
            additional_iterations: input.additional_iterations,
        },
    )
    .await
    .map_err(internal_error)?
    .ok_or_else(|| not_found("Overnight run not found"))?;

    Ok(Json(json!({
        "status": run.status,
        "run_id": run.run_id,
        "project_id": run.project_id,
        "workflow_name": run.workflow_name,
        "task_id": run.task_id,
        "created_at": run.created_at,
        "updated_at": run.updated_at,
    })))
}

async fn get_legacy_overnight_report(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, run_id)): Path<(String, String)>,
) -> ApiResult<Json<serde_json::Value>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;

    let report = crate::overnight::get_overnight_report(&state.pool, &project_id, &run_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Overnight run not found"))?;

    Ok(Json(report))
}

async fn list_execution_plans(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ExecutionPlansQuery>,
) -> ApiResult<Json<Vec<ExecutionPlan>>> {
    let runtime_id = query
        .runtime_id
        .as_deref()
        .ok_or_else(|| bad_request("runtime_id is required"))?;
    let project_id = repository::find_project_id_for_runtime(&state.pool, runtime_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let plans = repository::list_plans_for_runtime(&state.pool, runtime_id)
        .await
        .map_err(internal_error)?;
    Ok(Json(plans))
}

async fn get_execution_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(plan_id): Path<String>,
) -> ApiResult<Json<ExecutionPlan>> {
    let project_id = repository::find_project_id_for_plan(&state.pool, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    require_project_claims(&state.pool, &headers, &project_id).await?;

    let plan = repository::get_plan(&state.pool, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    Ok(Json(plan))
}

async fn list_project_plans(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> ApiResult<Json<Vec<ExecutionPlan>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;

    let plans = match runtime {
        Some(runtime) => repository::list_plans_for_runtime(&state.pool, &runtime.runtime_id)
            .await
            .map_err(internal_error)?,
        None => vec![],
    };
    Ok(Json(plans))
}

async fn create_project_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<CreatePlanBody>,
) -> ApiResult<impl IntoResponse> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    if input.goal.trim().is_empty() {
        return Err(bad_request("goal is required"));
    }

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;
    let instances = repository::list_instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    if instances.is_empty() {
        return Err(bad_request("Runtime has no agent instances"));
    }
    let blueprints = load_blueprints_for_instances(&state.pool, &instances)
        .await
        .map_err(internal_error)?;

    let plan = PmPlanner::new()
        .plan(&input.goal, &runtime, &instances, &blueprints)
        .await
        .map_err(internal_error)?;
    let saved = repository::insert_plan(&state.pool, &plan)
        .await
        .map_err(internal_error)?;
    emit_plan_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &saved.runtime_id,
            plan_id: Some(&saved.plan_id),
            step_id: None,
            actor_id: Some(&saved.created_by),
        },
        EventType::PlanCreated,
        json!({
            "status": saved.status.clone(),
            "goal": saved.goal.clone(),
            "planner_version": saved.planner_version.clone(),
            "planning_mode": saved.planning_mode.clone(),
            "revision": saved.revision,
        }),
    )
    .await
    .map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(saved)))
}

async fn get_project_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id)): Path<(String, String)>,
) -> ApiResult<Json<ExecutionPlan>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;

    let plan = repository::get_plan(&state.pool, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    Ok(Json(plan))
}

async fn list_project_plan_steps(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id)): Path<(String, String)>,
) -> ApiResult<Json<StepListResponse>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;

    Ok(Json(StepListResponse {
        plan_id,
        steps: plan.steps,
    }))
}

async fn list_project_ready_steps(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id)): Path<(String, String)>,
) -> ApiResult<Json<Vec<ExecutionStep>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;

    let ready_steps = plan
        .steps
        .iter()
        .filter(|step| matches!(step.status, StepStatus::Pending | StepStatus::Blocked))
        .filter(|step| step.approval_required_by.is_none())
        .filter(|step| StepHandoff::dependencies_satisfied(&plan, step))
        .cloned()
        .collect();

    Ok(Json(ready_steps))
}

async fn list_project_plan_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id)): Path<(String, String)>,
) -> ApiResult<Json<Vec<RuntimeEvent>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;

    let events = repository::list_events_for_plan(&state.pool, &plan_id)
        .await
        .map_err(internal_error)?;
    Ok(Json(events))
}

async fn list_project_execution_intents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Query(query): Query<ExecutionIntentQuery>,
) -> ApiResult<Json<Vec<ExecutionIntent>>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    let intents = repository::list_execution_intents_for_project(
        &state.pool,
        &project_id,
        query.agent_id.as_deref(),
    )
    .await
    .map_err(internal_error)?;
    Ok(Json(intents))
}

async fn create_project_execution_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<CreateExecutionIntentBody>,
) -> ApiResult<impl IntoResponse> {
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    if input.agent_id.trim().is_empty()
        || input.agent_role.trim().is_empty()
        || input.title.trim().is_empty()
        || input.description.trim().is_empty()
        || input.target.trim().is_empty()
        || input.connector_id.trim().is_empty()
    {
        return Err(bad_request("execution intent fields are required"));
    }

    let runtime = repository::get_runtime_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Runtime not found"))?;

    let saved = repository::insert_execution_intent(
        &state.pool,
        &NewExecutionIntent {
            project_id: project_id.clone(),
            runtime_id: Some(runtime.runtime_id.clone()),
            created_by: Some(claims.sub.clone()),
            agent_id: input.agent_id.trim().to_string(),
            agent_role: input.agent_role.trim().to_string(),
            kind: input.kind,
            title: input.title.trim().to_string(),
            description: input.description.trim().to_string(),
            target: input.target.trim().to_string(),
            connector_id: input.connector_id.trim().to_string(),
            payload: input.payload,
            requires_approval: input.requires_approval,
        },
    )
    .await
    .map_err(internal_error)?;

    emit_execution_intent_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &runtime.runtime_id,
            plan_id: None,
            step_id: None,
            actor_id: Some(&claims.sub),
        },
        EventType::ExecutionIntentCreated,
        &saved,
        json!({}),
    )
    .await
    .map_err(internal_error)?;

    Ok((StatusCode::CREATED, Json(saved)))
}

async fn get_project_execution_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, intent_id)): Path<(String, String)>,
) -> ApiResult<Json<ExecutionIntent>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    ensure_execution_intent_belongs_to_project(&state.pool, &project_id, &intent_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Execution intent not found"))
        .map(Json)
}

async fn decide_project_execution_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, intent_id)): Path<(String, String)>,
    Json(input): Json<DecideExecutionIntentBody>,
) -> ApiResult<Json<ExecutionIntent>> {
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    let intent = ensure_execution_intent_belongs_to_project(&state.pool, &project_id, &intent_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Execution intent not found"))?;
    let runtime_id = intent
        .runtime_id
        .clone()
        .ok_or_else(|| bad_request("Execution intent runtime is missing"))?;

    let (status, mark_approved, mark_resolved) = match input.action {
        ExecutionIntentDecisionAction::Approved => (ExecutionIntentStatus::Approved, true, false),
        ExecutionIntentDecisionAction::Hold => {
            (ExecutionIntentStatus::PendingApproval, false, false)
        }
        ExecutionIntentDecisionAction::Rejected => (ExecutionIntentStatus::Rejected, false, true),
    };

    let decided = repository::set_execution_intent_decision(
        &state.pool,
        &intent_id,
        &status,
        input.note.as_deref(),
        mark_approved,
        mark_resolved,
    )
    .await
    .map_err(internal_error)?
    .ok_or_else(|| not_found("Execution intent not found"))?;

    emit_execution_intent_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &runtime_id,
            plan_id: None,
            step_id: None,
            actor_id: Some(&claims.sub),
        },
        EventType::ExecutionIntentStatusChanged,
        &decided,
        json!({
            "decision_action": input.action,
        }),
    )
    .await
    .map_err(internal_error)?;

    if input.action == ExecutionIntentDecisionAction::Approved
        && input.execution_track.unwrap_or_default() == ExecutionTrack::Server
    {
        let executed = execute_intent_server_side(
            &state.pool,
            &state.event_bus,
            &project_id,
            &runtime_id,
            &claims.sub,
            &decided.intent_id,
        )
        .await
        .map_err(internal_error)?;
        return Ok(Json(executed));
    }

    Ok(Json(decided))
}

async fn complete_project_execution_intent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, intent_id)): Path<(String, String)>,
    Json(input): Json<CompleteExecutionIntentBody>,
) -> ApiResult<Json<ExecutionIntent>> {
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    let intent = ensure_execution_intent_belongs_to_project(&state.pool, &project_id, &intent_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Execution intent not found"))?;
    let runtime_id = intent
        .runtime_id
        .clone()
        .ok_or_else(|| bad_request("Execution intent runtime is missing"))?;
    if input.result_summary.trim().is_empty() {
        return Err(bad_request("result_summary is required"));
    }

    let next_status = match input.status {
        ConnectorCompletionStatus::Completed => ExecutionIntentStatus::Completed,
        ConnectorCompletionStatus::Failed => ExecutionIntentStatus::Failed,
    };

    let completed = repository::complete_execution_intent(
        &state.pool,
        &intent_id,
        &next_status,
        input.result_summary.trim(),
        input.result_payload.as_ref(),
        input.note.as_deref(),
    )
    .await
    .map_err(internal_error)?
    .ok_or_else(|| not_found("Execution intent not found"))?;

    emit_execution_intent_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &runtime_id,
            plan_id: None,
            step_id: None,
            actor_id: Some(&claims.sub),
        },
        if matches!(next_status, ExecutionIntentStatus::Completed) {
            EventType::ConnectorExecutionCompleted
        } else {
            EventType::ConnectorExecutionFailed
        },
        &completed,
        json!({}),
    )
    .await
    .map_err(internal_error)?;

    Ok(Json(completed))
}

async fn execute_project_plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id)): Path<(String, String)>,
    Json(input): Json<ExecutePlanBody>,
) -> ApiResult<Json<ExecutionPlan>> {
    require_project_claims(&state.pool, &headers, &project_id).await?;
    ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;

    let execution_track = input.execution_track.unwrap_or_default();
    let plan = match execution_track {
        ExecutionTrack::LocalCli => {
            activate_plan_for_local_cli(&state.pool, &state.event_bus, &project_id, &plan_id).await
        }
        ExecutionTrack::Server => {
            execute_plan_internal(&state.pool, &state.event_bus, &project_id, &plan_id).await
        }
    }
    .map_err(internal_error)?;
    Ok(Json(plan))
}

async fn complete_project_step(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id, step_id)): Path<(String, String, String)>,
    Json(input): Json<CompleteStepBody>,
) -> ApiResult<Json<ExecutionPlan>> {
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    let step = plan
        .steps
        .iter()
        .find(|candidate| candidate.step_id == step_id)
        .cloned()
        .ok_or_else(|| not_found("Step not found"))?;
    if step.approval_required_by.is_some() {
        return Err(bad_request(
            "Step requires approval and cannot be completed directly",
        ));
    }
    if !matches!(
        step.status,
        StepStatus::Pending | StepStatus::Blocked | StepStatus::InProgress
    ) {
        return Err(bad_request("Step is not in a completable state"));
    }
    if !StepHandoff::dependencies_satisfied(&plan, &step) {
        return Err(bad_request("Step dependencies are not satisfied"));
    }

    let instances = instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    let blueprints = load_blueprints_for_instances(&state.pool, &instances)
        .await
        .map_err(internal_error)?;
    let event_context = EventContext {
        project_id: &project_id,
        runtime_id: &plan.runtime_id,
        plan_id: Some(&plan_id),
        step_id: Some(&step_id),
        actor_id: Some(&claims.sub),
    };
    let assembled_input = match input.input.clone() {
        Some(value) => value,
        None => StepHandoff::assemble_ready_input(&plan, &step).map_err(internal_error)?,
    };

    set_assigned_instance_status(
        &state.pool,
        &state.event_bus,
        event_context,
        &step,
        &instances,
        &blueprints,
        RuntimeStatus::Working,
    )
    .await
    .map_err(internal_error)?;

    if !matches!(step.status, StepStatus::InProgress) {
        repository::update_step_status(
            &state.pool,
            &step_id,
            &StepStatus::InProgress,
            Some(&assembled_input),
            None,
            true,
            false,
        )
        .await
        .map_err(internal_error)?;
        emit_step_status_event(
            &state.pool,
            &state.event_bus,
            event_context,
            &step,
            &StepStatus::InProgress,
            &instances,
            &blueprints,
            json!({
                "input": assembled_input,
            }),
        )
        .await
        .map_err(internal_error)?;
    }

    match input.status {
        StepCompletionStatus::Completed => {
            repository::update_step_status(
                &state.pool,
                &step_id,
                &StepStatus::Completed,
                Some(&assembled_input),
                Some(&input.output),
                false,
                true,
            )
            .await
            .map_err(internal_error)?;
            emit_step_status_event(
                &state.pool,
                &state.event_bus,
                event_context,
                &step,
                &StepStatus::Completed,
                &instances,
                &blueprints,
                json!({
                    "input": assembled_input,
                    "output": input.output,
                    "summary": summarize_step_output(&step, &input.output),
                }),
            )
            .await
            .map_err(internal_error)?;
            set_assigned_instance_status(
                &state.pool,
                &state.event_bus,
                event_context,
                &step,
                &instances,
                &blueprints,
                RuntimeStatus::Idle,
            )
            .await
            .map_err(internal_error)?;

            let reloaded = repository::get_plan(&state.pool, &plan_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| not_found("Plan not found"))?;
            if let Some(completed_step) = reloaded
                .steps
                .iter()
                .find(|candidate| candidate.step_id == step_id)
            {
                let transitions = StepHandoff::process_completion(&reloaded, completed_step)
                    .map_err(internal_error)?;
                apply_transitions(&state.pool, &transitions)
                    .await
                    .map_err(internal_error)?;
                emit_transition_events(
                    &state.pool,
                    &state.event_bus,
                    EventContext {
                        project_id: &project_id,
                        runtime_id: &reloaded.runtime_id,
                        plan_id: Some(&reloaded.plan_id),
                        step_id: None,
                        actor_id: Some(&claims.sub),
                    },
                    &reloaded,
                    &transitions,
                    &instances,
                    &blueprints,
                )
                .await
                .map_err(internal_error)?;
            }

            let updated = sync_plan_status(
                &state.pool,
                &state.event_bus,
                EventContext {
                    project_id: &project_id,
                    runtime_id: &plan.runtime_id,
                    plan_id: Some(&plan_id),
                    step_id: None,
                    actor_id: Some(&claims.sub),
                },
            )
            .await
            .map_err(internal_error)?;
            Ok(Json(updated))
        }
        StepCompletionStatus::Failed => {
            repository::update_step_status(
                &state.pool,
                &step_id,
                &StepStatus::Failed,
                Some(&assembled_input),
                Some(&input.output),
                false,
                true,
            )
            .await
            .map_err(internal_error)?;
            emit_step_status_event(
                &state.pool,
                &state.event_bus,
                event_context,
                &step,
                &StepStatus::Failed,
                &instances,
                &blueprints,
                json!({
                    "input": assembled_input,
                    "output": input.output,
                    "summary": summarize_step_output(&step, &input.output),
                }),
            )
            .await
            .map_err(internal_error)?;
            set_assigned_instance_status(
                &state.pool,
                &state.event_bus,
                event_context,
                &step,
                &instances,
                &blueprints,
                RuntimeStatus::Failed,
            )
            .await
            .map_err(internal_error)?;

            let updated = sync_plan_status(
                &state.pool,
                &state.event_bus,
                EventContext {
                    project_id: &project_id,
                    runtime_id: &plan.runtime_id,
                    plan_id: Some(&plan_id),
                    step_id: None,
                    actor_id: Some(&claims.sub),
                },
            )
            .await
            .map_err(internal_error)?;
            Ok(Json(updated))
        }
    }
}

async fn approve_project_step(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id, plan_id, step_id)): Path<(String, String, String)>,
    Json(input): Json<ApproveStepBody>,
) -> ApiResult<Json<ExecutionPlan>> {
    let claims = require_project_claims(&state.pool, &headers, &project_id).await?;
    let execution_track = input.execution_track.unwrap_or_default();
    let plan = ensure_plan_belongs_to_project(&state.pool, &project_id, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    let step = plan
        .steps
        .iter()
        .find(|candidate| candidate.step_id == step_id)
        .cloned()
        .ok_or_else(|| not_found("Step not found"))?;
    if step.approval_required_by.is_none() {
        return Err(bad_request("Step does not require approval"));
    }

    let approval_output = json!({
        "approved_by_user_id": claims.sub.clone(),
        "note": input.note.clone().unwrap_or_default(),
        "previous_output": step.output.clone(),
    });
    repository::update_step_status(
        &state.pool,
        &step_id,
        &StepStatus::Approved,
        None,
        Some(&approval_output),
        false,
        true,
    )
    .await
    .map_err(internal_error)?;
    let instances = instances_for_project(&state.pool, &project_id)
        .await
        .map_err(internal_error)?;
    let blueprints = load_blueprints_for_instances(&state.pool, &instances)
        .await
        .map_err(internal_error)?;
    emit_step_status_event(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &plan.runtime_id,
            plan_id: Some(&plan_id),
            step_id: Some(&step_id),
            actor_id: Some(&claims.sub),
        },
        &step,
        &StepStatus::Approved,
        &instances,
        &blueprints,
        json!({
            "output": approval_output,
        }),
    )
    .await
    .map_err(internal_error)?;
    emit_approval_granted(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &plan.runtime_id,
            plan_id: Some(&plan_id),
            step_id: Some(&step_id),
            actor_id: Some(&claims.sub),
        },
        &step,
        &claims.sub,
        &instances,
        &blueprints,
    )
    .await
    .map_err(internal_error)?;
    set_assigned_instance_status(
        &state.pool,
        &state.event_bus,
        EventContext {
            project_id: &project_id,
            runtime_id: &plan.runtime_id,
            plan_id: Some(&plan_id),
            step_id: Some(&step_id),
            actor_id: Some(&claims.sub),
        },
        &step,
        &instances,
        &blueprints,
        RuntimeStatus::Idle,
    )
    .await
    .map_err(internal_error)?;

    let reloaded = repository::get_plan(&state.pool, &plan_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| not_found("Plan not found"))?;
    if let Some(approved_step) = reloaded
        .steps
        .iter()
        .find(|candidate| candidate.step_id == step_id)
    {
        let transitions =
            StepHandoff::process_completion(&reloaded, approved_step).map_err(internal_error)?;
        apply_transitions(&state.pool, &transitions)
            .await
            .map_err(internal_error)?;
        emit_transition_events(
            &state.pool,
            &state.event_bus,
            EventContext {
                project_id: &project_id,
                runtime_id: &reloaded.runtime_id,
                plan_id: Some(&reloaded.plan_id),
                step_id: None,
                actor_id: Some(&claims.sub),
            },
            &reloaded,
            &transitions,
            &instances,
            &blueprints,
        )
        .await
        .map_err(internal_error)?;
    }

    let updated = match execution_track {
        ExecutionTrack::LocalCli => {
            sync_plan_status(
                &state.pool,
                &state.event_bus,
                EventContext {
                    project_id: &project_id,
                    runtime_id: &plan.runtime_id,
                    plan_id: Some(&plan_id),
                    step_id: None,
                    actor_id: Some(&claims.sub),
                },
            )
            .await
        }
        ExecutionTrack::Server => {
            execute_plan_internal(&state.pool, &state.event_bus, &project_id, &plan_id).await
        }
    }
    .map_err(internal_error)?;
    Ok(Json(updated))
}

async fn activate_plan_for_local_cli(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    project_id: &str,
    plan_id: &str,
) -> infra_error::AppResult<ExecutionPlan> {
    let runtime = repository::get_runtime_for_project(pool, project_id)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("runtime not found".into()))?;
    let instances = repository::list_instances_for_project(pool, project_id).await?;
    let blueprints = load_blueprints_for_instances(pool, &instances).await?;
    let current_plan = repository::get_plan(pool, plan_id)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("plan not found".into()))?;
    let plan_context = EventContext {
        project_id,
        runtime_id: &runtime.runtime_id,
        plan_id: Some(plan_id),
        step_id: None,
        actor_id: None,
    };

    if !matches!(current_plan.status, PlanStatus::Active) {
        let _ = repository::update_plan_status(pool, plan_id, &PlanStatus::Active).await?;
        emit_plan_event(
            pool,
            event_bus,
            plan_context,
            EventType::PlanStarted,
            json!({
                "status": PlanStatus::Active,
                "execution_track": "local_cli",
            }),
        )
        .await?;
    }

    set_all_instance_statuses(
        pool,
        event_bus,
        plan_context,
        &instances,
        &blueprints,
        RuntimeStatus::Planning,
    )
    .await?;

    let transitions = current_plan
        .steps
        .iter()
        .filter_map(|step| initial_local_cli_transition(&current_plan, step))
        .collect::<Vec<_>>();
    if !transitions.is_empty() {
        apply_transitions(pool, &transitions).await?;
        emit_transition_events(
            pool,
            event_bus,
            plan_context,
            &current_plan,
            &transitions,
            &instances,
            &blueprints,
        )
        .await?;
    }

    sync_plan_status(pool, event_bus, plan_context).await
}

fn initial_local_cli_transition(
    plan: &ExecutionPlan,
    step: &ExecutionStep,
) -> Option<StepTransition> {
    let dependencies_satisfied = StepHandoff::dependencies_satisfied(plan, step);
    if dependencies_satisfied {
        return match step.status {
            StepStatus::Blocked if step.approval_required_by.is_none() => Some(StepTransition {
                step_id: step.step_id.clone(),
                assembled_input: StepHandoff::assemble_ready_input(plan, step)
                    .unwrap_or_else(|_| step.input.clone()),
                next_status: StepStatus::Pending,
            }),
            StepStatus::Pending | StepStatus::Blocked if step.approval_required_by.is_some() => {
                Some(StepTransition {
                    step_id: step.step_id.clone(),
                    assembled_input: StepHandoff::assemble_ready_input(plan, step)
                        .unwrap_or_else(|_| step.input.clone()),
                    next_status: StepStatus::AwaitingApproval,
                })
            }
            _ => None,
        };
    }

    if matches!(step.status, StepStatus::Pending) && !step.depends_on.is_empty() {
        return Some(StepTransition {
            step_id: step.step_id.clone(),
            assembled_input: step.input.clone(),
            next_status: StepStatus::Blocked,
        });
    }

    None
}

async fn sync_plan_status(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
) -> infra_error::AppResult<ExecutionPlan> {
    let plan = repository::get_plan(pool, context.plan_id.unwrap_or_default())
        .await?
        .ok_or_else(|| infra_error::AppError::Message("plan not found".into()))?;
    let next_status = if plan
        .steps
        .iter()
        .any(|step| matches!(step.status, StepStatus::Failed))
    {
        PlanStatus::Failed
    } else if plan.steps.iter().all(|step| {
        matches!(
            step.status,
            StepStatus::Completed | StepStatus::Approved | StepStatus::Skipped
        )
    }) {
        PlanStatus::Completed
    } else {
        plan.status.clone()
    };

    if next_status == plan.status {
        return Ok(plan);
    }

    let updated = repository::update_plan_status(pool, &plan.plan_id, &next_status)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("updated plan not found".into()))?;
    match next_status {
        PlanStatus::Completed => {
            emit_plan_event(
                pool,
                event_bus,
                context,
                EventType::PlanCompleted,
                json!({
                    "status": PlanStatus::Completed,
                }),
            )
            .await?;
            let instances =
                repository::list_instances_for_project(pool, context.project_id).await?;
            let blueprints = load_blueprints_for_instances(pool, &instances).await?;
            set_all_instance_statuses(
                pool,
                event_bus,
                context,
                &instances,
                &blueprints,
                RuntimeStatus::Completed,
            )
            .await?;
        }
        PlanStatus::Failed => {
            emit_plan_event(
                pool,
                event_bus,
                context,
                EventType::PlanFailed,
                json!({
                    "status": PlanStatus::Failed,
                }),
            )
            .await?;
            let instances =
                repository::list_instances_for_project(pool, context.project_id).await?;
            let blueprints = load_blueprints_for_instances(pool, &instances).await?;
            set_all_instance_statuses(
                pool,
                event_bus,
                context,
                &instances,
                &blueprints,
                RuntimeStatus::Failed,
            )
            .await?;
        }
        _ => {}
    }

    Ok(updated)
}

async fn set_assigned_instance_status(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
    status: RuntimeStatus,
) -> infra_error::AppResult<()> {
    let Some(instance_id) = step.assigned_to.as_deref() else {
        return Ok(());
    };
    let Some(instance) = instances
        .iter()
        .find(|candidate| candidate.instance_id == instance_id)
    else {
        return Ok(());
    };

    let _ = repository::update_instance_runtime_state(
        pool,
        &instance.instance_id,
        None,
        None,
        None,
        Some(&status),
    )
    .await?;
    emit_agent_status_event(pool, event_bus, context, instance, blueprints, &status).await?;
    Ok(())
}

fn summarize_step_output(step: &ExecutionStep, output: &serde_json::Value) -> String {
    if let Some(summary) = output.get("summary").and_then(|value| value.as_str()) {
        let trimmed = summary.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(stdout) = output.get("stdout").and_then(|value| value.as_str()) {
        let summary = stdout
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("");
        let trimmed = summary.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(160).collect();
        }
    }
    if let Some(text) = output.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return trimmed.chars().take(160).collect();
        }
    }
    step.label.clone()
}

async fn execute_plan_internal(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    project_id: &str,
    plan_id: &str,
) -> infra_error::AppResult<ExecutionPlan> {
    let runtime = repository::get_runtime_for_project(pool, project_id)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("runtime not found".into()))?;
    let instances = repository::list_instances_for_project(pool, project_id).await?;
    let blueprints = load_blueprints_for_instances(pool, &instances).await?;
    let executor = AgentExecutor::new();
    let plan_context = EventContext {
        project_id,
        runtime_id: &runtime.runtime_id,
        plan_id: Some(plan_id),
        step_id: None,
        actor_id: None,
    };

    let _ = repository::update_plan_status(pool, plan_id, &PlanStatus::Active).await?;
    emit_plan_event(
        pool,
        event_bus,
        plan_context,
        EventType::PlanStarted,
        json!({
            "status": PlanStatus::Active,
        }),
    )
    .await?;
    set_all_instance_statuses(
        pool,
        event_bus,
        plan_context,
        &instances,
        &blueprints,
        RuntimeStatus::Planning,
    )
    .await?;

    let mut saw_waiting_approval = false;
    let mut saw_progress = false;

    loop {
        let current_plan = repository::get_plan(pool, plan_id)
            .await?
            .ok_or_else(|| infra_error::AppError::Message("plan not found".into()))?;
        let mut cycle_progress = false;

        for step in current_plan.steps.clone() {
            match step.status {
                StepStatus::Pending | StepStatus::Blocked => {
                    if !StepHandoff::dependencies_satisfied(&current_plan, &step) {
                        if matches!(step.status, StepStatus::Pending) {
                            let _ = repository::update_step_status(
                                pool,
                                &step.step_id,
                                &StepStatus::Blocked,
                                None,
                                None,
                                false,
                                false,
                            )
                            .await?;
                            emit_step_status_event(
                                pool,
                                event_bus,
                                EventContext {
                                    step_id: Some(&step.step_id),
                                    ..plan_context
                                },
                                &step,
                                &StepStatus::Blocked,
                                &instances,
                                &blueprints,
                                json!({}),
                            )
                            .await?;
                            cycle_progress = true;
                        }
                        continue;
                    }

                    let assembled_input = StepHandoff::assemble_ready_input(&current_plan, &step)?;
                    if step.approval_required_by.is_some() {
                        let _ = repository::update_step_status(
                            pool,
                            &step.step_id,
                            &StepStatus::AwaitingApproval,
                            Some(&assembled_input),
                            None,
                            false,
                            false,
                        )
                        .await?;
                        emit_step_status_event(
                            pool,
                            event_bus,
                            EventContext {
                                step_id: Some(&step.step_id),
                                ..plan_context
                            },
                            &step,
                            &StepStatus::AwaitingApproval,
                            &instances,
                            &blueprints,
                            json!({
                                "input": assembled_input,
                            }),
                        )
                        .await?;
                        persist_event(
                            pool,
                            event_bus,
                            EventContext {
                                step_id: Some(&step.step_id),
                                ..plan_context
                            },
                            EventType::ApprovalRequested,
                            build_step_event_payload(
                                &step,
                                &StepStatus::AwaitingApproval,
                                &instances,
                                &blueprints,
                                json!({
                                    "input": assembled_input,
                                }),
                            ),
                        )
                        .await?;
                        saw_waiting_approval = true;
                        cycle_progress = true;
                        continue;
                    }

                    execute_single_step(
                        pool,
                        event_bus,
                        project_id,
                        &runtime.runtime_id,
                        &executor,
                        &instances,
                        &blueprints,
                        &current_plan,
                        &step,
                        &assembled_input,
                    )
                    .await?;
                    let refreshed = repository::get_plan(pool, plan_id)
                        .await?
                        .ok_or_else(|| infra_error::AppError::Message("plan not found".into()))?;
                    if let Some(completed_step) = refreshed
                        .steps
                        .iter()
                        .find(|candidate| candidate.step_id == step.step_id)
                    {
                        let transitions =
                            StepHandoff::process_completion(&refreshed, completed_step)?;
                        apply_transitions(pool, &transitions).await?;
                        emit_transition_events(
                            pool,
                            event_bus,
                            EventContext {
                                runtime_id: &refreshed.runtime_id,
                                plan_id: Some(&refreshed.plan_id),
                                ..plan_context
                            },
                            &refreshed,
                            &transitions,
                            &instances,
                            &blueprints,
                        )
                        .await?;
                    }
                    cycle_progress = true;
                    saw_progress = true;
                }
                StepStatus::Approved => {
                    let transitions = StepHandoff::process_completion(&current_plan, &step)?;
                    if !transitions.is_empty() {
                        apply_transitions(pool, &transitions).await?;
                        emit_transition_events(
                            pool,
                            event_bus,
                            EventContext {
                                runtime_id: &current_plan.runtime_id,
                                plan_id: Some(&current_plan.plan_id),
                                ..plan_context
                            },
                            &current_plan,
                            &transitions,
                            &instances,
                            &blueprints,
                        )
                        .await?;
                        cycle_progress = true;
                        saw_progress = true;
                    }
                }
                StepStatus::AwaitingApproval => {
                    saw_waiting_approval = true;
                }
                _ => {}
            }
        }

        if !cycle_progress {
            break;
        }
    }

    let final_plan = repository::get_plan(pool, plan_id)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("plan not found".into()))?;
    let next_status = if final_plan
        .steps
        .iter()
        .any(|step| matches!(step.status, StepStatus::Failed))
    {
        PlanStatus::Failed
    } else if final_plan.steps.iter().all(|step| {
        matches!(
            step.status,
            StepStatus::Completed | StepStatus::Approved | StepStatus::Skipped
        )
    }) {
        PlanStatus::Completed
    } else if final_plan
        .steps
        .iter()
        .any(|step| matches!(step.status, StepStatus::AwaitingApproval))
        || saw_waiting_approval
    {
        PlanStatus::Paused
    } else if saw_progress {
        PlanStatus::Active
    } else {
        final_plan.status.clone()
    };

    let runtime_status = match next_status {
        PlanStatus::Completed => RuntimeStatus::Completed,
        PlanStatus::Failed => RuntimeStatus::Failed,
        PlanStatus::Paused => RuntimeStatus::WaitingApproval,
        PlanStatus::Active => RuntimeStatus::Working,
        PlanStatus::Draft => RuntimeStatus::Idle,
    };
    set_all_instance_statuses(
        pool,
        event_bus,
        EventContext {
            runtime_id: &final_plan.runtime_id,
            plan_id: Some(&final_plan.plan_id),
            ..plan_context
        },
        &instances,
        &blueprints,
        runtime_status,
    )
    .await?;

    let updated_plan = repository::update_plan_status(pool, plan_id, &next_status)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("updated plan not found".into()))?;
    match next_status {
        PlanStatus::Completed => {
            emit_plan_event(
                pool,
                event_bus,
                EventContext {
                    runtime_id: &updated_plan.runtime_id,
                    plan_id: Some(&updated_plan.plan_id),
                    ..plan_context
                },
                EventType::PlanCompleted,
                json!({
                    "status": next_status,
                }),
            )
            .await?;
        }
        PlanStatus::Failed => {
            emit_plan_event(
                pool,
                event_bus,
                EventContext {
                    runtime_id: &updated_plan.runtime_id,
                    plan_id: Some(&updated_plan.plan_id),
                    ..plan_context
                },
                EventType::PlanFailed,
                json!({
                    "status": next_status,
                }),
            )
            .await?;
        }
        _ => {}
    }
    Ok(updated_plan)
}

async fn execute_single_step(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    project_id: &str,
    runtime_id: &str,
    executor: &AgentExecutor,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
    plan: &ExecutionPlan,
    step: &ExecutionStep,
    assembled_input: &serde_json::Value,
) -> infra_error::AppResult<()> {
    let _ = repository::update_step_status(
        pool,
        &step.step_id,
        &StepStatus::InProgress,
        Some(assembled_input),
        None,
        true,
        false,
    )
    .await?;
    emit_step_status_event(
        pool,
        event_bus,
        EventContext {
            project_id,
            runtime_id,
            plan_id: Some(&plan.plan_id),
            step_id: Some(&step.step_id),
            actor_id: None,
        },
        step,
        &StepStatus::InProgress,
        instances,
        blueprints,
        json!({
            "input": assembled_input,
        }),
    )
    .await?;

    let assigned_instance = step.assigned_to.as_deref().and_then(|instance_id| {
        instances
            .iter()
            .find(|instance| instance.instance_id == instance_id)
    });

    let output = if let Some(instance) = assigned_instance {
        let _ = repository::update_instance_runtime_state(
            pool,
            &instance.instance_id,
            None,
            None,
            None,
            Some(&RuntimeStatus::Working),
        )
        .await?;

        let blueprint = blueprints
            .iter()
            .find(|candidate| candidate.id == instance.blueprint_id);
        let context = build_context_snapshot(pool, runtime_id, instance, plan).await?;

        match blueprint {
            Some(blueprint) => {
                executor
                    .execute(instance, blueprint, step, &context)
                    .await?
            }
            None => fallback_step_output(step, "Blueprint missing for assigned instance"),
        }
    } else {
        fallback_step_output(
            step,
            "Step executed in fallback mode without assigned agent",
        )
    };

    let _ = repository::update_step_status(
        pool,
        &step.step_id,
        &StepStatus::Completed,
        Some(assembled_input),
        Some(&output.payload),
        false,
        true,
    )
    .await?;
    emit_step_status_event(
        pool,
        event_bus,
        EventContext {
            project_id,
            runtime_id,
            plan_id: Some(&plan.plan_id),
            step_id: Some(&step.step_id),
            actor_id: None,
        },
        step,
        &StepStatus::Completed,
        instances,
        blueprints,
        json!({
            "input": assembled_input,
            "output": output.payload,
            "summary": output
                .payload
                .get("summary")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String(step.label.clone())),
        }),
    )
    .await?;

    if let Some(instance) = assigned_instance {
        RuntimeContext::update_token_usage(
            pool,
            instance,
            output.input_tokens,
            output.output_tokens,
            &step.step_id,
        )
        .await?;
        let _ = repository::update_instance_runtime_state(
            pool,
            &instance.instance_id,
            None,
            None,
            Some(&output.live_metrics),
            Some(&RuntimeStatus::Idle),
        )
        .await?;
    }

    Ok(())
}

async fn build_context_snapshot(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
    instance: &AgentInstance,
    plan: &ExecutionPlan,
) -> infra_error::AppResult<ContextSnapshot> {
    let mut context = RuntimeContext::get_context(instance, plan)?;
    let shared_context = RuntimeContext::get_shared_context(pool, runtime_id).await?;
    context.shared_artifacts = shared_context
        .get("completed_outputs")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(context)
}

fn fallback_step_output(step: &ExecutionStep, reason: &str) -> StepOutput {
    StepOutput {
        payload: json!({
            "summary": format!("{}: {}", step.label, reason),
            "reason": reason,
            "step_id": step.step_id,
        }),
        input_tokens: 1,
        output_tokens: 1,
        live_metrics: json!({
            "last_model": "mock",
            "last_provider": "mock",
            "last_prompt_tokens": 1,
            "last_completion_tokens": 1,
        }),
    }
}

async fn apply_transitions(
    pool: &sqlx::SqlitePool,
    transitions: &[StepTransition],
) -> infra_error::AppResult<()> {
    for transition in transitions {
        let _ = repository::update_step_status(
            pool,
            &transition.step_id,
            &transition.next_status,
            Some(&transition.assembled_input),
            None,
            false,
            false,
        )
        .await?;
    }
    Ok(())
}

async fn set_all_instance_statuses(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
    status: RuntimeStatus,
) -> infra_error::AppResult<()> {
    for instance in instances {
        let _ = repository::update_instance_runtime_state(
            pool,
            &instance.instance_id,
            None,
            None,
            None,
            Some(&status),
        )
        .await?;
        emit_agent_status_event(pool, event_bus, context, instance, blueprints, &status).await?;
    }
    Ok(())
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

async fn instances_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
) -> infra_error::AppResult<Vec<AgentInstance>> {
    repository::list_instances_for_project(pool, project_id).await
}

fn role_label_for_instance(
    instance_id: Option<&str>,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> Option<String> {
    let instance = instances
        .iter()
        .find(|candidate| Some(candidate.instance_id.as_str()) == instance_id)?;
    blueprints
        .iter()
        .find(|candidate| candidate.id == instance.blueprint_id)
        .map(|blueprint| blueprint.role_label.clone())
}

fn merge_payload(mut payload: serde_json::Value, extra: serde_json::Value) -> serde_json::Value {
    if let (serde_json::Value::Object(base), serde_json::Value::Object(extra_map)) =
        (&mut payload, extra)
    {
        for (key, value) in extra_map {
            base.insert(key, value);
        }
    }
    payload
}

fn build_step_event_payload(
    step: &ExecutionStep,
    status: &StepStatus,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
    extra: serde_json::Value,
) -> serde_json::Value {
    merge_payload(
        json!({
            "step_id": step.step_id,
            "label": step.label,
            "status": status,
            "assigned_to": step.assigned_to,
            "role_label": role_label_for_instance(step.assigned_to.as_deref(), instances, blueprints),
            "approval_required_by": step.approval_required_by,
            "approval_role_label": role_label_for_instance(step.approval_required_by.as_deref(), instances, blueprints),
        }),
        extra,
    )
}

fn build_execution_intent_event_payload(
    intent: &ExecutionIntent,
    extra: serde_json::Value,
) -> serde_json::Value {
    merge_payload(
        json!({
            "intent_id": intent.intent_id,
            "project_id": intent.project_id,
            "runtime_id": intent.runtime_id,
            "agent_id": intent.agent_id,
            "agent_role": intent.agent_role,
            "kind": intent.kind,
            "status": intent.status,
            "title": intent.title,
            "description": intent.description,
            "target": intent.target,
            "connector_id": intent.connector_id,
            "requires_approval": intent.requires_approval,
            "note": intent.note,
            "result_summary": intent.result_summary,
        }),
        extra,
    )
}

async fn persist_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    event_type: EventType,
    payload: serde_json::Value,
) -> infra_error::AppResult<RuntimeEvent> {
    let event = repository::append_execution_event(
        pool,
        context.project_id,
        context.runtime_id,
        context.plan_id,
        context.step_id,
        context.actor_id,
        &event_type,
        &payload,
    )
    .await?;
    event_bus.emit(event.clone())?;
    Ok(event)
}

async fn emit_execution_intent_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    event_type: EventType,
    intent: &ExecutionIntent,
    extra: serde_json::Value,
) -> infra_error::AppResult<()> {
    let payload = build_execution_intent_event_payload(intent, extra);
    persist_event(pool, event_bus, context, event_type, payload).await?;
    Ok(())
}

async fn emit_step_status_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    status: &StepStatus,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
    extra: serde_json::Value,
) -> infra_error::AppResult<()> {
    let payload = build_step_event_payload(step, status, instances, blueprints, extra);
    persist_event(
        pool,
        event_bus,
        context,
        EventType::StepStatusChanged,
        payload,
    )
    .await?;
    Ok(())
}

async fn emit_transition_events(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    plan: &ExecutionPlan,
    transitions: &[StepTransition],
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    for transition in transitions {
        if let Some(step) = plan
            .steps
            .iter()
            .find(|candidate| candidate.step_id == transition.step_id)
        {
            let step_context = EventContext {
                step_id: Some(&transition.step_id),
                ..context
            };
            emit_step_status_event(
                pool,
                event_bus,
                step_context,
                step,
                &transition.next_status,
                instances,
                blueprints,
                json!({
                    "input": transition.assembled_input,
                }),
            )
            .await?;
            // ── Step 3-4: 전용 에이전트 활동 이벤트 발행 ──
            match transition.next_status {
                StepStatus::InProgress => {
                    // 에이전트가 작업 시작
                    emit_agent_working(pool, event_bus, step_context, step, instances, blueprints)
                        .await?;
                }
                StepStatus::AwaitingApproval => {
                    // 기존 ApprovalRequested 발행 (하위 호환)
                    persist_event(
                        pool,
                        event_bus,
                        step_context,
                        EventType::ApprovalRequested,
                        build_step_event_payload(
                            step,
                            &transition.next_status,
                            instances,
                            blueprints,
                            json!({
                                "input": transition.assembled_input,
                            }),
                        ),
                    )
                    .await?;
                    // 리뷰어에게 AgentReviewing 발행
                    emit_agent_reviewing(
                        pool,
                        event_bus,
                        step_context,
                        step,
                        instances,
                        blueprints,
                    )
                    .await?;
                }
                StepStatus::Completed | StepStatus::Approved => {
                    // 핸드오프: 다음 step 에이전트에게 전달
                    emit_agent_handoff_if_next(
                        pool,
                        event_bus,
                        step_context,
                        step,
                        plan,
                        instances,
                        blueprints,
                    )
                    .await?;
                    // 완료된 에이전트에게 다음 작업 없으면 Idle
                    emit_agent_idle_if_no_next(
                        pool,
                        event_bus,
                        step_context,
                        step,
                        plan,
                        instances,
                        blueprints,
                    )
                    .await?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

async fn emit_plan_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    event_type: EventType,
    extra: serde_json::Value,
) -> infra_error::AppResult<()> {
    persist_event(
        pool,
        event_bus,
        context,
        event_type,
        merge_payload(
            json!({
                "plan_id": context.plan_id,
            }),
            extra,
        ),
    )
    .await?;
    Ok(())
}

async fn emit_agent_status_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    instance: &AgentInstance,
    blueprints: &[AgentBlueprint],
    status: &RuntimeStatus,
) -> infra_error::AppResult<()> {
    let role_label = blueprints
        .iter()
        .find(|candidate| candidate.id == instance.blueprint_id)
        .map(|blueprint| blueprint.role_label.clone());
    persist_event(
        pool,
        event_bus,
        context,
        EventType::AgentStatusChanged,
        json!({
            "instance_id": instance.instance_id,
            "role_label": role_label,
            "status": status,
            "current_task": instance.current_tasks.first().cloned(),
        }),
    )
    .await?;
    Ok(())
}

async fn emit_approval_granted(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    approved_by_user_id: &str,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    persist_event(
        pool,
        event_bus,
        context,
        EventType::ApprovalGranted,
        json!({
            "step_id": step.step_id,
            "label": step.label,
            "status": StepStatus::Approved,
            "assigned_to": step.assigned_to,
            "role_label": role_label_for_instance(step.assigned_to.as_deref(), instances, blueprints),
            "approval_required_by": step.approval_required_by,
            "approval_role_label": role_label_for_instance(step.approval_required_by.as_deref(), instances, blueprints),
            "approved_by_user_id": approved_by_user_id,
        }),
    )
    .await?;
    Ok(())
}

// ── 에이전트 활동 전용 이벤트 발행 (Step 3-4) ──

async fn emit_agent_activity_event(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    event_type: EventType,
    instance: &AgentInstance,
    blueprints: &[AgentBlueprint],
    extra: serde_json::Value,
) -> infra_error::AppResult<()> {
    let role_label = blueprints
        .iter()
        .find(|b| b.id == instance.blueprint_id)
        .map(|b| b.role_label.clone());
    let mut payload = json!({
        "instance_id": instance.instance_id,
        "role_label": role_label,
        "current_task": instance.current_tasks.first().cloned(),
    });
    if let (Some(base), Some(ext)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in ext {
            base.insert(k.clone(), v.clone());
        }
    }
    persist_event(pool, event_bus, context, event_type, payload).await?;
    Ok(())
}

/// step in_progress 전환 시 → AgentWorking 발행
async fn emit_agent_working(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    if let Some(assigned) = step.assigned_to.as_deref() {
        if let Some(inst) = instances.iter().find(|i| i.instance_id == assigned) {
            emit_agent_activity_event(
                pool,
                event_bus,
                context,
                EventType::AgentWorking,
                inst,
                blueprints,
                json!({ "step_id": step.step_id, "step_label": step.label }),
            )
            .await?;
        }
    }
    Ok(())
}

/// step 완료 후 다음 ready step이 없으면 → AgentIdle 발행
async fn emit_agent_idle_if_no_next(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    plan: &ExecutionPlan,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    if let Some(assigned) = step.assigned_to.as_deref() {
        // 이 에이전트에게 배정된 다른 ready step이 있는지 확인
        let has_next = plan.steps.iter().any(|s| {
            s.step_id != step.step_id
                && s.assigned_to.as_deref() == Some(assigned)
                && matches!(s.status, StepStatus::Pending | StepStatus::InProgress)
        });
        if !has_next {
            if let Some(inst) = instances.iter().find(|i| i.instance_id == assigned) {
                emit_agent_activity_event(
                    pool,
                    event_bus,
                    context,
                    EventType::AgentIdle,
                    inst,
                    blueprints,
                    json!({ "completed_step_id": step.step_id }),
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// step 완료 후 다음 dependent step이 있으면 → AgentHandoff 발행
async fn emit_agent_handoff_if_next(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    plan: &ExecutionPlan,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    let from_role = role_label_for_instance(step.assigned_to.as_deref(), instances, blueprints);
    // 이 step에 의존하는 다음 step들을 찾는다
    for next_step in &plan.steps {
        if next_step.depends_on.contains(&step.step_id) {
            let to_role =
                role_label_for_instance(next_step.assigned_to.as_deref(), instances, blueprints);
            if let Some(from_inst) = step
                .assigned_to
                .as_deref()
                .and_then(|id| instances.iter().find(|i| i.instance_id == id))
            {
                emit_agent_activity_event(
                    pool,
                    event_bus,
                    context,
                    EventType::AgentHandoff,
                    from_inst,
                    blueprints,
                    json!({
                        "from_step_id": step.step_id,
                        "from_step_label": step.label,
                        "from_role": from_role,
                        "to_step_id": next_step.step_id,
                        "to_step_label": next_step.label,
                        "to_instance_id": next_step.assigned_to,
                        "to_role": to_role,
                        "summary": format!("{} -> {}", step.label, next_step.label),
                        "handoff_type": "task_complete",
                        "speech_duration_ms": COLLABORATION_SPEECH_DURATION_MS,
                        "arrival_buffer_ms": COLLABORATION_ARRIVAL_BUFFER_MS,
                    }),
                )
                .await?;
            }
        }
    }
    Ok(())
}

/// awaiting_approval 전환 시 → AgentReviewing 발행
async fn emit_agent_reviewing(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    context: EventContext<'_>,
    step: &ExecutionStep,
    instances: &[AgentInstance],
    blueprints: &[AgentBlueprint],
) -> infra_error::AppResult<()> {
    if let Some(reviewer_id) = step.approval_required_by.as_deref() {
        if let Some(reviewer_inst) = instances.iter().find(|i| i.instance_id == reviewer_id) {
            emit_agent_activity_event(
                pool,
                event_bus,
                context,
                EventType::AgentReviewing,
                reviewer_inst,
                blueprints,
                json!({
                    "step_id": step.step_id,
                    "step_label": step.label,
                    "requested_by": step.assigned_to,
                    "requested_by_role": role_label_for_instance(
                        step.assigned_to.as_deref(), instances, blueprints
                    ),
                }),
            )
            .await?;
        }
    }
    Ok(())
}

async fn execute_intent_server_side(
    pool: &sqlx::SqlitePool,
    event_bus: &EventBus,
    project_id: &str,
    runtime_id: &str,
    actor_id: &str,
    intent_id: &str,
) -> infra_error::AppResult<ExecutionIntent> {
    let executing = repository::mark_execution_intent_executing(pool, intent_id)
        .await?
        .ok_or_else(|| infra_error::AppError::Message("Execution intent not found".into()))?;
    emit_execution_intent_event(
        pool,
        event_bus,
        EventContext {
            project_id,
            runtime_id,
            plan_id: None,
            step_id: None,
            actor_id: Some(actor_id),
        },
        EventType::ConnectorExecutionStarted,
        &executing,
        json!({}),
    )
    .await?;

    let executor = ServerConnectorExecutor;
    let outcome = executor.execute(&executing).await?;
    let completed = repository::complete_execution_intent(
        pool,
        intent_id,
        &outcome.status,
        &outcome.result_summary,
        Some(&outcome.result_payload),
        None,
    )
    .await?
    .ok_or_else(|| infra_error::AppError::Message("Execution intent not found".into()))?;

    emit_execution_intent_event(
        pool,
        event_bus,
        EventContext {
            project_id,
            runtime_id,
            plan_id: None,
            step_id: None,
            actor_id: Some(actor_id),
        },
        if matches!(outcome.status, ExecutionIntentStatus::Completed) {
            EventType::ConnectorExecutionCompleted
        } else {
            EventType::ConnectorExecutionFailed
        },
        &completed,
        json!({
            "result_payload": outcome.result_payload,
        }),
    )
    .await?;

    Ok(completed)
}

async fn ensure_execution_intent_belongs_to_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    intent_id: &str,
) -> infra_error::AppResult<Option<ExecutionIntent>> {
    let intent_project_id =
        repository::find_project_id_for_execution_intent(pool, intent_id).await?;
    if intent_project_id.as_deref() != Some(project_id) {
        return Ok(None);
    }
    repository::get_execution_intent(pool, intent_id).await
}

async fn ensure_plan_belongs_to_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    plan_id: &str,
) -> infra_error::AppResult<Option<ExecutionPlan>> {
    let plan_project_id = repository::find_project_id_for_plan(pool, plan_id).await?;
    if plan_project_id.as_deref() != Some(project_id) {
        return Ok(None);
    }
    repository::get_plan(pool, plan_id).await
}

fn internal_error(err: infra_error::AppError) -> (StatusCode, Json<ErrorBody>) {
    tracing::warn!("execution route error: {}", err);
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

fn conflict(detail: &str) -> (StatusCode, Json<ErrorBody>) {
    (
        StatusCode::CONFLICT,
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
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;
    use std::{collections::HashMap, sync::Arc};
    use tokio::sync::Mutex;
    use tower::ServiceExt;
    use uuid::Uuid;

    use crate::{
        domain::{
            blueprint::BlueprintInput,
            execution::{
                ExecutionIntent, ExecutionIntentKind, ExecutionIntentStatus, ExecutionPlan,
                ExecutionStep, PlanStatus, StepStatus,
            },
            repository,
            runtime::ExecutionMode,
            skills::load_shared_skill_loader,
            ui_profile::UiProfile,
        },
        events::{EventBus, EventType, RuntimeEvent},
        jwt,
        routes::api_router,
        AppState,
    };

    #[tokio::test]
    async fn list_plan_events_returns_persisted_timeline_for_project_member() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let runtime = repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &json!({ "zones": [] }),
            &Vec::<String>::new(),
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": [] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        let plan = repository::insert_plan(
            &pool,
            &ExecutionPlan {
                plan_id: "plan-1".to_string(),
                runtime_id: runtime.runtime_id.clone(),
                workflow_name: "feature_development".to_string(),
                goal: "Ship execution event persistence".to_string(),
                created_by: "user-1".to_string(),
                planner_version: "pm_planner_v1".to_string(),
                planning_mode: "sequential".to_string(),
                plan_rationale: "Test plan for execution event history.".to_string(),
                revision: 1,
                steps: vec![ExecutionStep {
                    step_id: "step-1".to_string(),
                    label: "Initial step".to_string(),
                    description: "Prepare persisted event test data.".to_string(),
                    assigned_to: None,
                    depends_on: vec![],
                    approval_required_by: None,
                    status: StepStatus::Pending,
                    required_capabilities: vec!["planning".to_string()],
                    selection_reason: Some("Selected for repository route test.".to_string()),
                    approval_reason: None,
                    planner_notes: Some("Used only in route test.".to_string()),
                    parallel_group: None,
                    input: json!({}),
                    output: json!({}),
                    started_at: None,
                    completed_at: None,
                }],
                status: PlanStatus::Draft,
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .await
        .unwrap();

        let recorded = repository::append_execution_event(
            &pool,
            "project-1",
            &runtime.runtime_id,
            Some(&plan.plan_id),
            Some("step-1"),
            Some("user-1"),
            &EventType::PlanCreated,
            &json!({
                "status": "draft",
                "goal": plan.goal,
            }),
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/projects/project-1/plans/plan-1/events")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let events: Vec<RuntimeEvent> = serde_json::from_slice(&body).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_id, recorded.event_id);
        assert_eq!(events[0].event_type, EventType::PlanCreated);
        assert_eq!(events[0].project_id, "project-1");
        assert_eq!(
            events[0].runtime_id.as_deref(),
            Some(runtime.runtime_id.as_str())
        );
        assert_eq!(events[0].plan_id.as_deref(), Some("plan-1"));
        assert_eq!(events[0].step_id.as_deref(), Some("step-1"));
        assert_eq!(events[0].actor_id.as_deref(), Some("user-1"));
        assert_eq!(events[0].sequence_no, 1);
    }

    #[tokio::test]
    async fn local_cli_execution_routes_advance_ready_steps_and_complete_plan() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let runtime = repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &json!({ "zones": [] }),
            &Vec::<String>::new(),
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": [] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        let plan = repository::insert_plan(
            &pool,
            &ExecutionPlan {
                plan_id: "plan-local".to_string(),
                runtime_id: runtime.runtime_id.clone(),
                workflow_name: "feature_development".to_string(),
                goal: "Complete a local CLI plan".to_string(),
                created_by: "user-1".to_string(),
                planner_version: "pm_planner_v1".to_string(),
                planning_mode: "sequential".to_string(),
                plan_rationale: "Test local CLI route flow.".to_string(),
                revision: 1,
                steps: vec![
                    ExecutionStep {
                        step_id: "step-a".to_string(),
                        label: "First step".to_string(),
                        description: "Prepare the handoff.".to_string(),
                        assigned_to: None,
                        depends_on: vec![],
                        approval_required_by: None,
                        status: StepStatus::Pending,
                        required_capabilities: vec!["planning".to_string()],
                        selection_reason: Some("Seed step".to_string()),
                        approval_reason: None,
                        planner_notes: Some("Runs first.".to_string()),
                        parallel_group: None,
                        input: json!({}),
                        output: json!({}),
                        started_at: None,
                        completed_at: None,
                    },
                    ExecutionStep {
                        step_id: "step-b".to_string(),
                        label: "Second step".to_string(),
                        description: "Consume the handoff.".to_string(),
                        assigned_to: None,
                        depends_on: vec!["step-a".to_string()],
                        approval_required_by: None,
                        status: StepStatus::Pending,
                        required_capabilities: vec!["delivery".to_string()],
                        selection_reason: Some("Follow-up step".to_string()),
                        approval_reason: None,
                        planner_notes: Some("Runs after step-a.".to_string()),
                        parallel_group: None,
                        input: json!({}),
                        output: json!({}),
                        started_at: None,
                        completed_at: None,
                    },
                ],
                status: PlanStatus::Draft,
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let execute_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/plans/plan-local/execute")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"execution_track":"local_cli"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(execute_response.status(), StatusCode::OK);

        let ready_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/projects/project-1/plans/plan-local/ready-steps")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready_response.status(), StatusCode::OK);
        let ready_body = to_bytes(ready_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let ready_steps: Vec<ExecutionStep> = serde_json::from_slice(&ready_body).unwrap();
        assert_eq!(ready_steps.len(), 1);
        assert_eq!(ready_steps[0].step_id, "step-a");

        let complete_first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/plans/plan-local/steps/step-a/complete")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"status":"completed","output":{"summary":"step-a complete","stdout":"done"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete_first.status(), StatusCode::OK);

        let ready_after_first = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/projects/project-1/plans/plan-local/ready-steps")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(ready_after_first.status(), StatusCode::OK);
        let ready_after_first_body = to_bytes(ready_after_first.into_body(), usize::MAX)
            .await
            .unwrap();
        let ready_after_first_steps: Vec<ExecutionStep> =
            serde_json::from_slice(&ready_after_first_body).unwrap();
        assert_eq!(ready_after_first_steps.len(), 1);
        assert_eq!(ready_after_first_steps[0].step_id, "step-b");

        let complete_second = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/plans/plan-local/steps/step-b/complete")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"status":"completed","output":{"summary":"step-b complete","stdout":"done"}}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete_second.status(), StatusCode::OK);
        let complete_second_body = to_bytes(complete_second.into_body(), usize::MAX)
            .await
            .unwrap();
        let completed_plan: ExecutionPlan = serde_json::from_slice(&complete_second_body).unwrap();
        assert_eq!(completed_plan.plan_id, plan.plan_id);
        assert_eq!(completed_plan.status, PlanStatus::Completed);
    }

    #[tokio::test]
    async fn create_plan_route_handles_complex_cross_domain_reference_prompts() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;
        seed_test_runtime_agents(&pool, "project-1", "user-1").await;

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();
        let prompts = [
            (
                "travel",
                [
                    "도시 여행 일정 추천 웹사이트를 만들어줘",
                    "방문지와 이동수단은 카드/검색으로 입력하고, 좋아하는 장소는 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
                    "추천 10개와 이유를 보여주고 1일차부터 5일차까지 일정이 바뀔 때마다 추천이 새로 바뀌어야 해.",
                    "고려해야 할 것: 이동거리, 예산, 날씨, 운영시간, 아이 동반, 휠체어 접근성, 음식 취향, 휴무/폐점 장소 제외.",
                    "장소 DB는 알아서 할것.",
                ]
                .join("\n"),
            ),
            (
                "warehouse",
                [
                    "창고 출고 작업자가 주문을 고를 때 피킹 순서를 추천해주는 웹사이트를 만들어줘",
                    "주문과 SKU는 검색해서 선택하고, 자주 쓰는 구역은 즐겨찾기 목록으로 두되 로그인은 필요 없어.",
                    "추천 10개, 이유 표시, 주문 1번부터 5번까지 추가될 때마다 경로와 우선순위가 새로 계산되어야 해.",
                    "고려해야 할 것: 동선 거리, 무게, 냉장/상온, 파손 위험, 출고 마감, 재고 부족, 이미 잠긴 구역 제외.",
                    "SKU/로케이션 DB는 알아서 할것.",
                ]
                .join("\n"),
            ),
            (
                "staffing",
                [
                    "행사 부스 운영 상황별 스태프 배치 추천 웹사이트를 만들어줘",
                    "부스와 스태프는 검색해서 선택하고, 자주 쓰는 배치 템플릿은 즐겨찾기 목록으로 관리하되 로그인은 없어야 해.",
                    "추천 10개와 이유를 보여주고 부스 1번부터 5번까지 배정이 추가될 때마다 추천이 새로고침되어야 해.",
                    "고려해야 할 것: 혼잡도, 휴식 시간, 언어 가능 여부, 안전 역할, 이동 거리, 이미 배정된 사람/휴무자 제외.",
                    "스태프 DB는 알아서 할것.",
                ]
                .join("\n"),
            ),
        ];

        for (name, prompt) in prompts {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/projects/project-1/plans")
                        .header("authorization", format!("Bearer {}", token))
                        .header("content-type", "application/json")
                        .body(Body::from(
                            serde_json::to_vec(&json!({ "goal": prompt })).unwrap(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::CREATED,
                "create plan route should accept {name} prompt"
            );
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let plan: ExecutionPlan = serde_json::from_slice(&body).unwrap();
            let trace = plan
                .steps
                .iter()
                .map(|step| {
                    format!(
                        "{}:{}:{:?}",
                        step.label,
                        step.input
                            .get("artifact_type")
                            .and_then(|value| value.as_str())
                            .unwrap_or("none"),
                        step.required_capabilities
                    )
                })
                .collect::<Vec<_>>()
                .join(" | ");

            assert_eq!(plan.planning_mode, "dynamic_graph", "{name} trace: {trace}");
            assert!(
                plan.plan_rationale.contains("프론트엔드: true")
                    && plan.plan_rationale.contains("백엔드: false")
                    && plan.plan_rationale.contains("입력기반 선택/추천: true")
                    && plan.plan_rationale.contains("새 산출물 생성: true"),
                "{name} route should preserve frontend-only decision-web shape, rationale={}, trace={trace}",
                plan.plan_rationale
            );
            assert!(
                plan.steps
                    .iter()
                    .any(|step| step.input["artifact_type"] == json!("frontend")),
                "{name} route should create a frontend artifact step, trace={trace}"
            );
            assert!(
                plan.steps
                    .iter()
                    .filter(|step| step.input["artifact_type"] == json!("frontend"))
                    .count()
                    >= 3,
                "{name} complex prompt should be split into bounded frontend slices to reduce provider timeout risk, trace={trace}"
            );
            assert!(
                !plan.steps
                    .iter()
                    .any(|step| step.input["artifact_type"] == json!("backend")),
                "{name} route must not create backend artifact only because static DB/no-login wording appeared, trace={trace}"
            );
            let frontend_step = plan
                .steps
                .iter()
                .find(|step| step.input["artifact_type"] == json!("frontend"))
                .expect("frontend step");
            assert_eq!(
                frontend_step.input["quality_guardrails"]["risk_profile"], "input_driven_selection",
                "{name} frontend quality trace: {trace}"
            );
            assert_eq!(
                frontend_step.input["quality_guardrails"]["delivery_intent"], "fresh_artifact",
                "{name} frontend delivery trace: {trace}"
            );
            assert_eq!(
                frontend_step.input["quality_guardrails"]["requires_negative_adversarial_case"],
                true,
                "{name} frontend negative-case trace: {trace}"
            );
            assert!(
                frontend_step.input["goal"]
                    .as_str()
                    .unwrap_or_default()
                    .contains("DB는 알아서 할것")
                    || frontend_step.input["goal"]
                        .as_str()
                        .unwrap_or_default()
                        .contains("DB는 알아서 할것."),
                "{name} route should carry original static DB wording into handoff, trace={trace}"
            );
            assert!(
                plan.steps
                    .iter()
                    .any(|step| step.input.get("review_scope").is_some()
                        && step.input["requires_negative_adversarial_case"] == json!(true)),
                "{name} route should create reviewer negative-case gate, trace={trace}"
            );
            assert!(
                plan.steps
                    .iter()
                    .any(|step| step.input.get("verify_preview").is_some()
                        && step.input["quality_guardrails"]["requires_negative_adversarial_case"]
                            == json!(true)),
                "{name} route should create verifier negative-case gate, trace={trace}"
            );

            let events_response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(format!(
                            "/api/projects/project-1/plans/{}/events",
                            plan.plan_id
                        ))
                        .header("authorization", format!("Bearer {}", token))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(events_response.status(), StatusCode::OK);
            let events_body = to_bytes(events_response.into_body(), usize::MAX)
                .await
                .unwrap();
            let events: Vec<RuntimeEvent> = serde_json::from_slice(&events_body).unwrap();
            assert!(
                events
                    .iter()
                    .any(|event| event.event_type == EventType::PlanCreated
                        && event.payload["planning_mode"] == json!("dynamic_graph")),
                "{name} route should persist a dynamic PlanCreated trace event, trace={trace}"
            );
        }
    }

    #[tokio::test]
    async fn execution_intent_routes_persist_and_complete_local_connector_results() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let runtime = repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &json!({ "zones": [] }),
            &Vec::<String>::new(),
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": [] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let create_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/projects/project-1/execution-intents")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "agent_id":"agent-1",
                            "agent_role":"developer_front",
                            "kind":"open_pull_request",
                            "title":"Open release PR",
                            "description":"Prepare and open the release PR",
                            "target":"release/v1",
                            "connector_id":"git_connector",
                            "payload":{"branch":"release/v1"}
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(create_response.status(), StatusCode::CREATED);
        let create_body = to_bytes(create_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let created: ExecutionIntent = serde_json::from_slice(&create_body).unwrap();
        assert_eq!(created.project_id, "project-1");
        assert_eq!(
            created.runtime_id.as_deref(),
            Some(runtime.runtime_id.as_str())
        );
        assert_eq!(created.kind, ExecutionIntentKind::OpenPullRequest);
        assert_eq!(created.status, ExecutionIntentStatus::PendingApproval);

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/projects/project-1/execution-intents")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed: Vec<ExecutionIntent> = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].intent_id, created.intent_id);

        let approve_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/projects/project-1/execution-intents/{}/decision",
                        created.intent_id
                    ))
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"action":"approved","execution_track":"local_cli"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(approve_response.status(), StatusCode::OK);
        let approve_body = to_bytes(approve_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let approved: ExecutionIntent = serde_json::from_slice(&approve_body).unwrap();
        assert_eq!(approved.status, ExecutionIntentStatus::Approved);
        assert!(approved.approved_at.is_some());
        assert!(approved.resolved_at.is_none());

        let complete_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/projects/project-1/execution-intents/{}/complete",
                        created.intent_id
                    ))
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "status":"completed",
                            "result_summary":"PR created successfully",
                            "result_payload":{"url":"https://example.com/pr/123"}
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(complete_response.status(), StatusCode::OK);
        let complete_body = to_bytes(complete_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let completed: ExecutionIntent = serde_json::from_slice(&complete_body).unwrap();
        assert_eq!(completed.status, ExecutionIntentStatus::Completed);
        assert_eq!(
            completed.result_summary.as_deref(),
            Some("PR created successfully")
        );
        assert_eq!(
            completed
                .result_payload
                .as_ref()
                .and_then(|value| value.get("url"))
                .and_then(|value| value.as_str()),
            Some("https://example.com/pr/123")
        );
    }

    #[tokio::test]
    async fn legacy_workflow_routes_round_trip_persisted_workflow_name() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        let runtime = repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &json!({ "zones": [] }),
            &Vec::<String>::new(),
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": [] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        repository::insert_plan(
            &pool,
            &ExecutionPlan {
                plan_id: "plan-custom".to_string(),
                runtime_id: runtime.runtime_id.clone(),
                workflow_name: "customer_handoff".to_string(),
                goal: "Ship the customer handoff workflow".to_string(),
                created_by: "user-1".to_string(),
                planner_version: "pm_planner_v1".to_string(),
                planning_mode: "sequential".to_string(),
                plan_rationale: "Verify workflow_name persistence on legacy routes.".to_string(),
                revision: 1,
                steps: vec![],
                status: PlanStatus::Active,
                created_at: String::new(),
                updated_at: String::new(),
            },
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let list_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/workflows/project-1")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(list_response.status(), StatusCode::OK);
        let list_body = to_bytes(list_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let listed: serde_json::Value = serde_json::from_slice(&list_body).unwrap();
        assert_eq!(listed[0]["workflow_name"], "customer_handoff");
        assert_eq!(listed[0]["name"], "customer_handoff");

        let get_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/workflows/project-1/plan-custom")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(get_response.status(), StatusCode::OK);
        let get_body = to_bytes(get_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let workflow: serde_json::Value = serde_json::from_slice(&get_body).unwrap();
        assert_eq!(workflow["workflow_name"], "customer_handoff");
        assert_eq!(workflow["name"], "customer_handoff");

        let stop_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/workflows/project-1/plan-custom/stop")
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stop_response.status(), StatusCode::OK);
        let stop_body = to_bytes(stop_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let stopped: serde_json::Value = serde_json::from_slice(&stop_body).unwrap();
        assert_eq!(stopped["status"], "paused");
    }

    #[tokio::test]
    async fn overnight_routes_persist_status_constraints_and_report_state() {
        let pool = test_pool().await;
        insert_user(&pool, "user-1", "user1@example.com").await;
        insert_project_membership(&pool, "project-1", "Project One", "user-1").await;

        repository::create_runtime(
            &pool,
            "project-1",
            "Project One Runtime",
            &json!({ "zones": [] }),
            &Vec::<String>::new(),
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": [] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();

        let app = test_app(pool.clone());
        let token =
            jwt::create_access_token("user-1", "user1@example.com", &jwt::jwt_secret().unwrap())
                .unwrap();

        let start_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/workflows/project-1/overnight")
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "workflow_name": "overnight_reliability",
                            "goal": "Verify overnight contract parity",
                            "constraints": {
                                "max_runtime_minutes": 30,
                                "max_spend_usd": 5.0,
                                "max_iterations": 3,
                                "allowed_tools": ["rg", "sed"],
                                "blocked_commands": ["rm -rf", "git reset --hard"]
                            },
                            "definition_of_done": [
                                "Persist the overnight status payload",
                                "Merge resume constraints into stored config"
                            ],
                            "verification_profile": "strict",
                            "quality_threshold": 9
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(start_response.status(), StatusCode::OK);
        let start_body = to_bytes(start_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let started: serde_json::Value = serde_json::from_slice(&start_body).unwrap();
        let run_id = started["run_id"].as_str().unwrap().to_string();
        let initial_task_id = started["task_id"].as_str().unwrap().to_string();
        let initial_deadline = started["deadline_at"].as_str().unwrap().to_string();
        assert_eq!(started["status"], "started");
        assert_eq!(started["workflow_name"], "overnight_reliability");
        assert_eq!(started["goal"], "Verify overnight contract parity");

        let status_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/workflows/project-1/overnight/{run_id}"))
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status_response.status(), StatusCode::OK);
        let status_body = to_bytes(status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&status_body).unwrap();
        assert_eq!(status["status"], "running");
        assert_eq!(status["goal"], "Verify overnight contract parity");
        assert_eq!(
            status["overnight_config"]["constraints"]["max_runtime_minutes"],
            30
        );
        assert_eq!(
            status["overnight_config"]["constraints"]["max_spend_usd"],
            5.0
        );
        assert_eq!(
            status["overnight_config"]["constraints"]["max_iterations"],
            3
        );
        assert_eq!(
            status["overnight_config"]["workflow_name"],
            "overnight_reliability"
        );
        assert_eq!(status["steps"].as_array().unwrap().len(), 2);

        let stop_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/workflows/project-1/overnight/{run_id}/stop"))
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stop_response.status(), StatusCode::OK);
        let stop_body = to_bytes(stop_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let stopped: serde_json::Value = serde_json::from_slice(&stop_body).unwrap();
        assert_eq!(stopped["status"], "stopped_with_report");

        let report_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/api/workflows/project-1/overnight/{run_id}/report"
                    ))
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(report_response.status(), StatusCode::OK);
        let report_body = to_bytes(report_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let report: serde_json::Value = serde_json::from_slice(&report_body).unwrap();
        assert_eq!(report["final_status"], "stopped_with_report");
        assert_eq!(report["goal"], "Verify overnight contract parity");
        assert!(report["next_actions"].as_array().unwrap().len() >= 1);
        assert_eq!(report["gate_results"], json!([]));
        assert_eq!(report["hard_failures"], json!([]));

        let resume_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!(
                        "/api/workflows/project-1/overnight/{run_id}/resume"
                    ))
                    .header("authorization", format!("Bearer {}", token))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{
                            "additional_budget_usd": 2.5,
                            "additional_time_minutes": 15,
                            "additional_iterations": 4
                        }"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resume_response.status(), StatusCode::OK);
        let resume_body = to_bytes(resume_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let resumed: serde_json::Value = serde_json::from_slice(&resume_body).unwrap();
        assert_eq!(resumed["status"], "running");
        assert_ne!(resumed["task_id"].as_str().unwrap(), initial_task_id);

        let resumed_status_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/api/workflows/project-1/overnight/{run_id}"))
                    .header("authorization", format!("Bearer {}", token))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resumed_status_response.status(), StatusCode::OK);
        let resumed_status_body = to_bytes(resumed_status_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let resumed_status: serde_json::Value =
            serde_json::from_slice(&resumed_status_body).unwrap();
        assert_eq!(resumed_status["status"], "running");
        assert_eq!(
            resumed_status["overnight_config"]["constraints"]["max_spend_usd"],
            7.5
        );
        assert_eq!(
            resumed_status["overnight_config"]["constraints"]["max_runtime_minutes"],
            45
        );
        assert_eq!(
            resumed_status["overnight_config"]["constraints"]["max_iterations"],
            7
        );
        assert_ne!(
            resumed_status["deadline_at"].as_str().unwrap(),
            initial_deadline
        );
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

    async fn seed_test_runtime_agents(pool: &sqlx::SqlitePool, project_id: &str, user_id: &str) {
        let roles = [
            (
                "PM",
                "pm",
                vec!["planning", "goal_decomposition"],
                "planning",
                9,
            ),
            (
                "Frontend Developer",
                "frontend",
                vec!["frontend", "ui", "design", "code_generation"],
                "frontend",
                5,
            ),
            (
                "Backend Developer",
                "backend",
                vec!["backend", "api", "code_generation"],
                "backend",
                5,
            ),
            (
                "Reviewer",
                "reviewer",
                vec!["review", "quality_gate", "negative_case_review"],
                "quality",
                7,
            ),
            (
                "Verifier",
                "verifier",
                vec!["verification", "preview_validation", "adversarial_testing"],
                "quality",
                7,
            ),
        ];

        let mut instance_ids = Vec::with_capacity(roles.len());
        for (name, role_label, capabilities, team, authority_level) in roles {
            let blueprint = repository::create_blueprint(
                pool,
                user_id,
                &BlueprintInput {
                    name: name.to_string(),
                    role_label: role_label.to_string(),
                    capabilities: capabilities
                        .into_iter()
                        .map(str::to_string)
                        .collect::<Vec<_>>(),
                    prompt_bundle_ref: None,
                    skill_bundle_refs: vec![],
                    tool_policy: json!({}),
                    permission_policy: json!({}),
                    memory_policy: json!({}),
                    collaboration_policy: json!({}),
                    approval_policy: json!({}),
                    ui_profile: UiProfile {
                        display_name: name.to_string(),
                        team_affinity: team.to_string(),
                        authority_level,
                        ..Default::default()
                    },
                },
            )
            .await
            .unwrap();
            let instance = repository::create_instance(pool, &blueprint.id, project_id, Some(team))
                .await
                .unwrap();
            instance_ids.push(instance.instance_id);
        }

        repository::create_runtime(
            pool,
            project_id,
            "Project One Runtime",
            &json!({ "agents": instance_ids }),
            &instance_ids,
            &json!({ "meeting_style": "runtime_aware" }),
            &json!({ "owner_gate": ["PM"] }),
            &json!({ "artifacts": [] }),
            &ExecutionMode::Assisted,
            &json!({ "status": "idle" }),
        )
        .await
        .unwrap();
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
