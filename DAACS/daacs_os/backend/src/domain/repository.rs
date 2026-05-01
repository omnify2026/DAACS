use serde::de::DeserializeOwned;
use sqlx::Row;
use uuid::Uuid;

use infra_error::{AppError, AppResult};

use crate::domain::{
    blueprint::{AgentBlueprint, BlueprintInput},
    execution::{
        ExecutionIntent, ExecutionIntentKind, ExecutionIntentStatus, ExecutionPlan, ExecutionStep,
        NewExecutionIntent, PlanStatus, StepStatus,
    },
    instance::{AgentInstance, RuntimeStatus},
    runtime::{CompanyRuntime, ExecutionMode},
};
use crate::events::{EventType, RuntimeEvent};

const SYSTEM_OWNER_ID: &str = "system";
const CORE_BUILTIN_BLUEPRINT_IDS: [&str; 3] =
    ["builtin-pm", "builtin-reviewer", "builtin-verifier"];

fn encode_json(value: &impl serde::Serialize) -> AppResult<String> {
    serde_json::to_string(value).map_err(Into::into)
}

fn decode_json<T: DeserializeOwned>(raw: String) -> AppResult<T> {
    serde_json::from_str(&raw).map_err(Into::into)
}

fn runtime_status_to_str(status: &RuntimeStatus) -> &'static str {
    match status {
        RuntimeStatus::Idle => "idle",
        RuntimeStatus::Planning => "planning",
        RuntimeStatus::Working => "working",
        RuntimeStatus::WaitingApproval => "waiting_approval",
        RuntimeStatus::Completed => "completed",
        RuntimeStatus::Failed => "failed",
    }
}

fn parse_runtime_status(raw: String) -> RuntimeStatus {
    match raw.as_str() {
        "planning" => RuntimeStatus::Planning,
        "working" => RuntimeStatus::Working,
        "waiting_approval" => RuntimeStatus::WaitingApproval,
        "completed" => RuntimeStatus::Completed,
        "failed" => RuntimeStatus::Failed,
        _ => RuntimeStatus::Idle,
    }
}

fn execution_mode_to_str(mode: &ExecutionMode) -> &'static str {
    match mode {
        ExecutionMode::Manual => "manual",
        ExecutionMode::Assisted => "assisted",
        ExecutionMode::Autonomous => "autonomous",
    }
}

fn parse_execution_mode(raw: String) -> ExecutionMode {
    match raw.as_str() {
        "manual" => ExecutionMode::Manual,
        "autonomous" => ExecutionMode::Autonomous,
        _ => ExecutionMode::Assisted,
    }
}

fn plan_status_to_str(status: &PlanStatus) -> &'static str {
    match status {
        PlanStatus::Draft => "draft",
        PlanStatus::Active => "active",
        PlanStatus::Paused => "paused",
        PlanStatus::Completed => "completed",
        PlanStatus::Failed => "failed",
    }
}

fn parse_plan_status(raw: String) -> PlanStatus {
    match raw.as_str() {
        "active" => PlanStatus::Active,
        "paused" => PlanStatus::Paused,
        "completed" => PlanStatus::Completed,
        "failed" => PlanStatus::Failed,
        _ => PlanStatus::Draft,
    }
}

fn step_status_to_str(status: &StepStatus) -> &'static str {
    match status {
        StepStatus::Pending => "pending",
        StepStatus::Blocked => "blocked",
        StepStatus::InProgress => "in_progress",
        StepStatus::AwaitingApproval => "awaiting_approval",
        StepStatus::Approved => "approved",
        StepStatus::Completed => "completed",
        StepStatus::Failed => "failed",
        StepStatus::Skipped => "skipped",
    }
}

fn parse_step_status(raw: String) -> StepStatus {
    match raw.as_str() {
        "blocked" => StepStatus::Blocked,
        "in_progress" => StepStatus::InProgress,
        "awaiting_approval" => StepStatus::AwaitingApproval,
        "approved" => StepStatus::Approved,
        "completed" => StepStatus::Completed,
        "failed" => StepStatus::Failed,
        "skipped" => StepStatus::Skipped,
        _ => StepStatus::Pending,
    }
}

fn execution_intent_kind_to_str(kind: &ExecutionIntentKind) -> &'static str {
    match kind {
        ExecutionIntentKind::OpenPullRequest => "open_pull_request",
        ExecutionIntentKind::DeployRelease => "deploy_release",
        ExecutionIntentKind::PublishContent => "publish_content",
        ExecutionIntentKind::LaunchCampaign => "launch_campaign",
        ExecutionIntentKind::PublishAsset => "publish_asset",
        ExecutionIntentKind::RunOpsAction => "run_ops_action",
        ExecutionIntentKind::SubmitBudgetUpdate => "submit_budget_update",
    }
}

fn parse_execution_intent_kind(raw: String) -> ExecutionIntentKind {
    match raw.as_str() {
        "deploy_release" => ExecutionIntentKind::DeployRelease,
        "publish_content" => ExecutionIntentKind::PublishContent,
        "launch_campaign" => ExecutionIntentKind::LaunchCampaign,
        "publish_asset" => ExecutionIntentKind::PublishAsset,
        "run_ops_action" => ExecutionIntentKind::RunOpsAction,
        "submit_budget_update" => ExecutionIntentKind::SubmitBudgetUpdate,
        _ => ExecutionIntentKind::OpenPullRequest,
    }
}

fn execution_intent_status_to_str(status: &ExecutionIntentStatus) -> &'static str {
    match status {
        ExecutionIntentStatus::Draft => "draft",
        ExecutionIntentStatus::PendingApproval => "pending_approval",
        ExecutionIntentStatus::Approved => "approved",
        ExecutionIntentStatus::Rejected => "rejected",
        ExecutionIntentStatus::Executing => "executing",
        ExecutionIntentStatus::Completed => "completed",
        ExecutionIntentStatus::Failed => "failed",
    }
}

fn parse_execution_intent_status(raw: String) -> ExecutionIntentStatus {
    match raw.as_str() {
        "pending_approval" => ExecutionIntentStatus::PendingApproval,
        "approved" => ExecutionIntentStatus::Approved,
        "rejected" => ExecutionIntentStatus::Rejected,
        "executing" => ExecutionIntentStatus::Executing,
        "completed" => ExecutionIntentStatus::Completed,
        "failed" => ExecutionIntentStatus::Failed,
        _ => ExecutionIntentStatus::Draft,
    }
}

fn event_type_to_str(event_type: &EventType) -> &'static str {
    match event_type {
        EventType::PlanCreated => "plan_created",
        EventType::StepStatusChanged => "step_status_changed",
        EventType::ApprovalRequested => "approval_requested",
        EventType::ApprovalGranted => "approval_granted",
        EventType::PlanStarted => "plan_started",
        EventType::PlanCompleted => "plan_completed",
        EventType::PlanFailed => "plan_failed",
        EventType::ExecutionIntentCreated => "execution_intent_created",
        EventType::ExecutionIntentStatusChanged => "execution_intent_status_changed",
        EventType::ConnectorExecutionStarted => "connector_execution_started",
        EventType::ConnectorExecutionCompleted => "connector_execution_completed",
        EventType::ConnectorExecutionFailed => "connector_execution_failed",
        EventType::AgentStatusChanged => "agent_status_changed",
        EventType::AgentWorking => "agent_working",
        EventType::AgentIdle => "agent_idle",
        EventType::AgentHandoff => "agent_handoff",
        EventType::AgentReviewing => "agent_reviewing",
        EventType::RuntimeUpdated => "runtime_updated",
    }
}

fn parse_event_type(raw: String) -> EventType {
    match raw.as_str() {
        "plan_created" => EventType::PlanCreated,
        "step_status_changed" => EventType::StepStatusChanged,
        "approval_requested" => EventType::ApprovalRequested,
        "approval_granted" => EventType::ApprovalGranted,
        "plan_started" => EventType::PlanStarted,
        "plan_completed" => EventType::PlanCompleted,
        "plan_failed" => EventType::PlanFailed,
        "execution_intent_created" => EventType::ExecutionIntentCreated,
        "execution_intent_status_changed" => EventType::ExecutionIntentStatusChanged,
        "connector_execution_started" => EventType::ConnectorExecutionStarted,
        "connector_execution_completed" => EventType::ConnectorExecutionCompleted,
        "connector_execution_failed" => EventType::ConnectorExecutionFailed,
        "agent_status_changed" => EventType::AgentStatusChanged,
        "agent_working" => EventType::AgentWorking,
        "agent_idle" => EventType::AgentIdle,
        "agent_handoff" => EventType::AgentHandoff,
        "agent_reviewing" => EventType::AgentReviewing,
        "runtime_updated" => EventType::RuntimeUpdated,
        _ => EventType::StepStatusChanged,
    }
}

fn row_to_blueprint(row: sqlx::sqlite::SqliteRow) -> AppResult<AgentBlueprint> {
    Ok(AgentBlueprint {
        id: row.try_get("id").map_err(message_error)?,
        name: row.try_get("name").map_err(message_error)?,
        role_label: row.try_get("role_label").map_err(message_error)?,
        capabilities: decode_json(row.try_get("capabilities").map_err(message_error)?)?,
        prompt_bundle_ref: row.try_get("prompt_bundle_ref").map_err(message_error)?,
        skill_bundle_refs: decode_json(row.try_get("skill_bundle_refs").map_err(message_error)?)?,
        tool_policy: decode_json(row.try_get("tool_policy").map_err(message_error)?)?,
        permission_policy: decode_json(row.try_get("permission_policy").map_err(message_error)?)?,
        memory_policy: decode_json(row.try_get("memory_policy").map_err(message_error)?)?,
        collaboration_policy: decode_json(
            row.try_get("collaboration_policy").map_err(message_error)?,
        )?,
        approval_policy: decode_json(row.try_get("approval_policy").map_err(message_error)?)?,
        ui_profile: decode_json(row.try_get("ui_profile").map_err(message_error)?)?,
        is_builtin: row.try_get::<i64, _>("is_builtin").map_err(message_error)? != 0,
        owner_user_id: row.try_get("owner_user_id").map_err(message_error)?,
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
    })
}

fn row_to_instance(row: sqlx::sqlite::SqliteRow) -> AppResult<AgentInstance> {
    Ok(AgentInstance {
        instance_id: row.try_get("instance_id").map_err(message_error)?,
        blueprint_id: row.try_get("blueprint_id").map_err(message_error)?,
        project_id: row.try_get("project_id").map_err(message_error)?,
        runtime_status: parse_runtime_status(row.try_get("runtime_status").map_err(message_error)?),
        assigned_team: row.try_get("assigned_team").map_err(message_error)?,
        current_tasks: decode_json(row.try_get("current_tasks").map_err(message_error)?)?,
        context_window_state: decode_json(
            row.try_get("context_window_state").map_err(message_error)?,
        )?,
        memory_bindings: decode_json(row.try_get("memory_bindings").map_err(message_error)?)?,
        live_metrics: decode_json(row.try_get("live_metrics").map_err(message_error)?)?,
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
    })
}

fn row_to_runtime(row: sqlx::sqlite::SqliteRow) -> AppResult<CompanyRuntime> {
    Ok(CompanyRuntime {
        runtime_id: row.try_get("runtime_id").map_err(message_error)?,
        project_id: row.try_get("project_id").map_err(message_error)?,
        company_name: row.try_get("company_name").map_err(message_error)?,
        org_graph: decode_json(row.try_get("org_graph").map_err(message_error)?)?,
        agent_instance_ids: decode_json(row.try_get("agent_instance_ids").map_err(message_error)?)?,
        meeting_protocol: decode_json(row.try_get("meeting_protocol").map_err(message_error)?)?,
        approval_graph: decode_json(row.try_get("approval_graph").map_err(message_error)?)?,
        shared_boards: decode_json(row.try_get("shared_boards").map_err(message_error)?)?,
        execution_mode: parse_execution_mode(row.try_get("execution_mode").map_err(message_error)?),
        owner_ops_state: decode_json(row.try_get("owner_ops_state").map_err(message_error)?)?,
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
    })
}

fn row_to_step(row: sqlx::sqlite::SqliteRow) -> AppResult<ExecutionStep> {
    Ok(ExecutionStep {
        step_id: row.try_get("step_id").map_err(message_error)?,
        label: row.try_get("label").map_err(message_error)?,
        description: row.try_get("description").map_err(message_error)?,
        assigned_to: row.try_get("assigned_to").map_err(message_error)?,
        depends_on: decode_json(row.try_get("depends_on").map_err(message_error)?)?,
        approval_required_by: row.try_get("approval_required_by").map_err(message_error)?,
        status: parse_step_status(row.try_get("status").map_err(message_error)?),
        required_capabilities: decode_json(
            row.try_get("required_capabilities")
                .map_err(message_error)?,
        )?,
        selection_reason: row.try_get("selection_reason").map_err(message_error)?,
        approval_reason: row.try_get("approval_reason").map_err(message_error)?,
        planner_notes: row.try_get("planner_notes").map_err(message_error)?,
        parallel_group: row.try_get("parallel_group").map_err(message_error)?,
        input: decode_json(row.try_get("input").map_err(message_error)?)?,
        output: decode_json(row.try_get("output").map_err(message_error)?)?,
        started_at: row.try_get("started_at").map_err(message_error)?,
        completed_at: row.try_get("completed_at").map_err(message_error)?,
    })
}

fn row_to_plan_base(row: sqlx::sqlite::SqliteRow) -> AppResult<ExecutionPlan> {
    Ok(ExecutionPlan {
        plan_id: row.try_get("plan_id").map_err(message_error)?,
        runtime_id: row.try_get("runtime_id").map_err(message_error)?,
        workflow_name: row.try_get("workflow_name").map_err(message_error)?,
        goal: row.try_get("goal").map_err(message_error)?,
        created_by: row.try_get("created_by").map_err(message_error)?,
        planner_version: row.try_get("planner_version").map_err(message_error)?,
        planning_mode: row.try_get("planning_mode").map_err(message_error)?,
        plan_rationale: row.try_get("plan_rationale").map_err(message_error)?,
        revision: row.try_get("revision").map_err(message_error)?,
        steps: vec![],
        status: parse_plan_status(row.try_get("status").map_err(message_error)?),
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
    })
}

fn row_to_execution_intent(row: sqlx::sqlite::SqliteRow) -> AppResult<ExecutionIntent> {
    let result_payload_raw: Option<String> =
        row.try_get("result_payload").map_err(message_error)?;
    Ok(ExecutionIntent {
        intent_id: row.try_get("intent_id").map_err(message_error)?,
        project_id: row.try_get("project_id").map_err(message_error)?,
        runtime_id: row.try_get("runtime_id").map_err(message_error)?,
        created_by: row.try_get("created_by").map_err(message_error)?,
        agent_id: row.try_get("agent_id").map_err(message_error)?,
        agent_role: row.try_get("agent_role").map_err(message_error)?,
        kind: parse_execution_intent_kind(row.try_get("kind").map_err(message_error)?),
        title: row.try_get("title").map_err(message_error)?,
        description: row.try_get("description").map_err(message_error)?,
        target: row.try_get("target").map_err(message_error)?,
        connector_id: row.try_get("connector_id").map_err(message_error)?,
        payload: decode_json(row.try_get("payload").map_err(message_error)?)?,
        result_payload: result_payload_raw.map(decode_json).transpose()?,
        status: parse_execution_intent_status(row.try_get("status").map_err(message_error)?),
        requires_approval: row
            .try_get::<i64, _>("requires_approval")
            .map_err(message_error)?
            != 0,
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
        approved_at: row.try_get("approved_at").map_err(message_error)?,
        resolved_at: row.try_get("resolved_at").map_err(message_error)?,
        note: row.try_get("note").map_err(message_error)?,
        result_summary: row.try_get("result_summary").map_err(message_error)?,
    })
}

fn row_to_event(row: sqlx::sqlite::SqliteRow) -> AppResult<RuntimeEvent> {
    Ok(RuntimeEvent {
        event_id: row.try_get("event_id").map_err(message_error)?,
        event_type: parse_event_type(row.try_get("event_type").map_err(message_error)?),
        payload: decode_json(row.try_get("payload").map_err(message_error)?)?,
        project_id: row.try_get("project_id").map_err(message_error)?,
        runtime_id: row.try_get("runtime_id").map_err(message_error)?,
        plan_id: row.try_get("plan_id").map_err(message_error)?,
        step_id: row.try_get("step_id").map_err(message_error)?,
        actor_id: row.try_get("actor_id").map_err(message_error)?,
        sequence_no: row.try_get("sequence_no").map_err(message_error)?,
        timestamp: row
            .try_get::<i64, _>("timestamp_ms")
            .map_err(message_error)? as u64,
        created_at: row.try_get("created_at").map_err(message_error)?,
    })
}

fn message_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(error.to_string())
}

pub async fn is_user_project_member(
    pool: &sqlx::SqlitePool,
    user_id: &str,
    project_id: &str,
) -> AppResult<bool> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM project_memberships WHERE user_id = ? AND project_id = ? LIMIT 1",
    )
    .bind(user_id)
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    Ok(row.is_some())
}

pub async fn get_project_name(
    pool: &sqlx::SqlitePool,
    project_id: &str,
) -> AppResult<Option<String>> {
    sqlx::query_scalar("SELECT name FROM projects WHERE id = ?")
        .bind(project_id)
        .fetch_optional(pool)
        .await
        .map_err(message_error)
}

pub async fn list_blueprints_for_user(
    pool: &sqlx::SqlitePool,
    user_id: &str,
) -> AppResult<Vec<AgentBlueprint>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
               tool_policy, permission_policy, memory_policy, collaboration_policy,
               approval_policy, ui_profile, is_builtin, owner_user_id, created_at, updated_at
        FROM agent_blueprints
        WHERE owner_user_id = ?
           OR (owner_user_id = ? AND id IN (?, ?, ?))
        ORDER BY is_builtin DESC, name ASC
        "#,
    )
    .bind(user_id)
    .bind(SYSTEM_OWNER_ID)
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[0])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[1])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[2])
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_blueprint).collect()
}

pub async fn list_builtin_blueprints(pool: &sqlx::SqlitePool) -> AppResult<Vec<AgentBlueprint>> {
    let rows = sqlx::query(
        r#"
        SELECT id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
               tool_policy, permission_policy, memory_policy, collaboration_policy,
               approval_policy, ui_profile, is_builtin, owner_user_id, created_at, updated_at
        FROM agent_blueprints
        WHERE is_builtin = 1
          AND id IN (?, ?, ?)
        ORDER BY name ASC
        "#,
    )
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[0])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[1])
    .bind(CORE_BUILTIN_BLUEPRINT_IDS[2])
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_blueprint).collect()
}

pub async fn get_blueprint_by_id(
    pool: &sqlx::SqlitePool,
    blueprint_id: &str,
) -> AppResult<Option<AgentBlueprint>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
               tool_policy, permission_policy, memory_policy, collaboration_policy,
               approval_policy, ui_profile, is_builtin, owner_user_id, created_at, updated_at
        FROM agent_blueprints
        WHERE id = ?
        "#,
    )
    .bind(blueprint_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_blueprint).transpose()
}

pub async fn get_blueprint_for_user(
    pool: &sqlx::SqlitePool,
    blueprint_id: &str,
    user_id: &str,
) -> AppResult<Option<AgentBlueprint>> {
    let row = sqlx::query(
        r#"
        SELECT id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
               tool_policy, permission_policy, memory_policy, collaboration_policy,
               approval_policy, ui_profile, is_builtin, owner_user_id, created_at, updated_at
        FROM agent_blueprints
        WHERE id = ? AND (owner_user_id = ? OR owner_user_id = ?)
        "#,
    )
    .bind(blueprint_id)
    .bind(user_id)
    .bind(SYSTEM_OWNER_ID)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_blueprint).transpose()
}

pub async fn create_blueprint(
    pool: &sqlx::SqlitePool,
    user_id: &str,
    input: &BlueprintInput,
) -> AppResult<AgentBlueprint> {
    let blueprint_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO agent_blueprints (
            id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
            tool_policy, permission_policy, memory_policy, collaboration_policy,
            approval_policy, ui_profile, is_builtin, owner_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        "#,
    )
    .bind(&blueprint_id)
    .bind(&input.name)
    .bind(&input.role_label)
    .bind(encode_json(&input.capabilities)?)
    .bind(input.prompt_bundle_ref.clone())
    .bind(encode_json(&input.skill_bundle_refs)?)
    .bind(encode_json(&input.tool_policy)?)
    .bind(encode_json(&input.permission_policy)?)
    .bind(encode_json(&input.memory_policy)?)
    .bind(encode_json(&input.collaboration_policy)?)
    .bind(encode_json(&input.approval_policy)?)
    .bind(encode_json(&input.ui_profile)?)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_blueprint_for_user(pool, &blueprint_id, user_id)
        .await?
        .ok_or_else(|| AppError::Message("created blueprint not found".into()))
}

pub async fn update_blueprint(
    pool: &sqlx::SqlitePool,
    blueprint_id: &str,
    user_id: &str,
    input: &BlueprintInput,
) -> AppResult<Option<AgentBlueprint>> {
    let result = sqlx::query(
        r#"
        UPDATE agent_blueprints
        SET name = ?,
            role_label = ?,
            capabilities = ?,
            prompt_bundle_ref = ?,
            skill_bundle_refs = ?,
            tool_policy = ?,
            permission_policy = ?,
            memory_policy = ?,
            collaboration_policy = ?,
            approval_policy = ?,
            ui_profile = ?,
            updated_at = datetime('now')
        WHERE id = ? AND owner_user_id = ? AND is_builtin = 0
        "#,
    )
    .bind(&input.name)
    .bind(&input.role_label)
    .bind(encode_json(&input.capabilities)?)
    .bind(input.prompt_bundle_ref.clone())
    .bind(encode_json(&input.skill_bundle_refs)?)
    .bind(encode_json(&input.tool_policy)?)
    .bind(encode_json(&input.permission_policy)?)
    .bind(encode_json(&input.memory_policy)?)
    .bind(encode_json(&input.collaboration_policy)?)
    .bind(encode_json(&input.approval_policy)?)
    .bind(encode_json(&input.ui_profile)?)
    .bind(blueprint_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_blueprint_for_user(pool, blueprint_id, user_id).await
}

pub async fn delete_blueprint(
    pool: &sqlx::SqlitePool,
    blueprint_id: &str,
    user_id: &str,
) -> AppResult<bool> {
    let result = sqlx::query(
        "DELETE FROM agent_blueprints WHERE id = ? AND owner_user_id = ? AND is_builtin = 0",
    )
    .bind(blueprint_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    Ok(result.rows_affected() > 0)
}

pub async fn upsert_system_blueprint(
    pool: &sqlx::SqlitePool,
    blueprint: &AgentBlueprint,
) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO agent_blueprints (
            id, name, role_label, capabilities, prompt_bundle_ref, skill_bundle_refs,
            tool_policy, permission_policy, memory_policy, collaboration_policy,
            approval_policy, ui_profile, is_builtin, owner_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            role_label = excluded.role_label,
            capabilities = excluded.capabilities,
            prompt_bundle_ref = excluded.prompt_bundle_ref,
            skill_bundle_refs = excluded.skill_bundle_refs,
            tool_policy = excluded.tool_policy,
            permission_policy = excluded.permission_policy,
            memory_policy = excluded.memory_policy,
            collaboration_policy = excluded.collaboration_policy,
            approval_policy = excluded.approval_policy,
            ui_profile = excluded.ui_profile,
            is_builtin = excluded.is_builtin,
            owner_user_id = excluded.owner_user_id,
            updated_at = datetime('now')
        "#,
    )
    .bind(&blueprint.id)
    .bind(&blueprint.name)
    .bind(&blueprint.role_label)
    .bind(encode_json(&blueprint.capabilities)?)
    .bind(blueprint.prompt_bundle_ref.clone())
    .bind(encode_json(&blueprint.skill_bundle_refs)?)
    .bind(encode_json(&blueprint.tool_policy)?)
    .bind(encode_json(&blueprint.permission_policy)?)
    .bind(encode_json(&blueprint.memory_policy)?)
    .bind(encode_json(&blueprint.collaboration_policy)?)
    .bind(encode_json(&blueprint.approval_policy)?)
    .bind(encode_json(&blueprint.ui_profile)?)
    .bind(if blueprint.is_builtin { 1 } else { 0 })
    .bind(&blueprint.owner_user_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    Ok(())
}

pub async fn list_instances_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
) -> AppResult<Vec<AgentInstance>> {
    let rows = sqlx::query(
        r#"
        SELECT instance_id, blueprint_id, project_id, runtime_status, assigned_team,
               current_tasks, context_window_state, memory_bindings, live_metrics,
               created_at, updated_at
        FROM agent_instances
        WHERE project_id = ?
        ORDER BY created_at ASC
        "#,
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_instance).collect()
}

pub async fn get_instance(
    pool: &sqlx::SqlitePool,
    instance_id: &str,
) -> AppResult<Option<AgentInstance>> {
    let row = sqlx::query(
        r#"
        SELECT instance_id, blueprint_id, project_id, runtime_status, assigned_team,
               current_tasks, context_window_state, memory_bindings, live_metrics,
               created_at, updated_at
        FROM agent_instances
        WHERE instance_id = ?
        "#,
    )
    .bind(instance_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_instance).transpose()
}

pub async fn create_instance(
    pool: &sqlx::SqlitePool,
    blueprint_id: &str,
    project_id: &str,
    assigned_team: Option<&str>,
) -> AppResult<AgentInstance> {
    let instance_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO agent_instances (
            instance_id, blueprint_id, project_id, runtime_status, assigned_team,
            current_tasks, context_window_state, memory_bindings, live_metrics
        ) VALUES (?, ?, ?, 'idle', ?, '[]', '{}', '{}', '{}')
        "#,
    )
    .bind(&instance_id)
    .bind(blueprint_id)
    .bind(project_id)
    .bind(assigned_team)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_instance(pool, &instance_id)
        .await?
        .ok_or_else(|| AppError::Message("created instance not found".into()))
}

pub async fn update_instance_runtime_state(
    pool: &sqlx::SqlitePool,
    instance_id: &str,
    context_window_state: Option<&serde_json::Value>,
    memory_bindings: Option<&serde_json::Value>,
    live_metrics: Option<&serde_json::Value>,
    runtime_status: Option<&RuntimeStatus>,
) -> AppResult<Option<AgentInstance>> {
    let current = match get_instance(pool, instance_id).await? {
        Some(instance) => instance,
        None => return Ok(None),
    };

    let next_context_window_state = context_window_state
        .cloned()
        .unwrap_or_else(|| current.context_window_state.clone());
    let next_memory_bindings = memory_bindings
        .cloned()
        .unwrap_or_else(|| current.memory_bindings.clone());
    let next_live_metrics = live_metrics
        .cloned()
        .unwrap_or_else(|| current.live_metrics.clone());
    let next_runtime_status = runtime_status.unwrap_or(&current.runtime_status);

    sqlx::query(
        r#"
        UPDATE agent_instances
        SET runtime_status = ?,
            context_window_state = ?,
            memory_bindings = ?,
            live_metrics = ?,
            updated_at = datetime('now')
        WHERE instance_id = ?
        "#,
    )
    .bind(runtime_status_to_str(next_runtime_status))
    .bind(encode_json(&next_context_window_state)?)
    .bind(encode_json(&next_memory_bindings)?)
    .bind(encode_json(&next_live_metrics)?)
    .bind(instance_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_instance(pool, instance_id).await
}

pub async fn get_runtime_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
) -> AppResult<Option<CompanyRuntime>> {
    let row = sqlx::query(
        r#"
        SELECT runtime_id, project_id, company_name, org_graph, agent_instance_ids,
               meeting_protocol, approval_graph, shared_boards, execution_mode,
               owner_ops_state, created_at, updated_at
        FROM company_runtimes
        WHERE project_id = ?
        "#,
    )
    .bind(project_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_runtime).transpose()
}

pub async fn get_runtime(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
) -> AppResult<Option<CompanyRuntime>> {
    let row = sqlx::query(
        r#"
        SELECT runtime_id, project_id, company_name, org_graph, agent_instance_ids,
               meeting_protocol, approval_graph, shared_boards, execution_mode,
               owner_ops_state, created_at, updated_at
        FROM company_runtimes
        WHERE runtime_id = ?
        "#,
    )
    .bind(runtime_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_runtime).transpose()
}

pub async fn create_runtime(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    company_name: &str,
    org_graph: &serde_json::Value,
    agent_instance_ids: &[String],
    meeting_protocol: &serde_json::Value,
    approval_graph: &serde_json::Value,
    shared_boards: &serde_json::Value,
    execution_mode: &ExecutionMode,
    owner_ops_state: &serde_json::Value,
) -> AppResult<CompanyRuntime> {
    let runtime_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO company_runtimes (
            runtime_id, project_id, company_name, org_graph, agent_instance_ids,
            meeting_protocol, approval_graph, shared_boards, execution_mode, owner_ops_state
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&runtime_id)
    .bind(project_id)
    .bind(company_name)
    .bind(encode_json(org_graph)?)
    .bind(encode_json(&agent_instance_ids)?)
    .bind(encode_json(meeting_protocol)?)
    .bind(encode_json(approval_graph)?)
    .bind(encode_json(shared_boards)?)
    .bind(execution_mode_to_str(execution_mode))
    .bind(encode_json(owner_ops_state)?)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_runtime(pool, &runtime_id)
        .await?
        .ok_or_else(|| AppError::Message("created runtime not found".into()))
}

pub async fn update_runtime_agent_instance_ids(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
    agent_instance_ids: &[String],
) -> AppResult<Option<CompanyRuntime>> {
    let result = sqlx::query(
        r#"
        UPDATE company_runtimes
        SET agent_instance_ids = ?, updated_at = datetime('now')
        WHERE runtime_id = ?
        "#,
    )
    .bind(encode_json(&agent_instance_ids)?)
    .bind(runtime_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_runtime(pool, runtime_id).await
}

pub async fn update_runtime_org_graph(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
    org_graph: &serde_json::Value,
) -> AppResult<Option<CompanyRuntime>> {
    let result = sqlx::query(
        r#"
        UPDATE company_runtimes
        SET org_graph = ?, updated_at = datetime('now')
        WHERE runtime_id = ?
        "#,
    )
    .bind(encode_json(org_graph)?)
    .bind(runtime_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_runtime(pool, runtime_id).await
}

pub async fn find_project_id_for_runtime(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
) -> AppResult<Option<String>> {
    sqlx::query_scalar("SELECT project_id FROM company_runtimes WHERE runtime_id = ?")
        .bind(runtime_id)
        .fetch_optional(pool)
        .await
        .map_err(message_error)
}

pub async fn list_plans_for_runtime(
    pool: &sqlx::SqlitePool,
    runtime_id: &str,
) -> AppResult<Vec<ExecutionPlan>> {
    let rows = sqlx::query(
        r#"
        SELECT plan_id, runtime_id, goal, created_by, planner_version, planning_mode,
               workflow_name, plan_rationale, revision, status, created_at, updated_at
        FROM execution_plans
        WHERE runtime_id = ?
        ORDER BY created_at DESC
        "#,
    )
    .bind(runtime_id)
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    let mut plans = Vec::with_capacity(rows.len());
    for row in rows {
        let mut plan = row_to_plan_base(row)?;
        plan.steps = list_steps_for_plan(pool, &plan.plan_id).await?;
        plans.push(plan);
    }
    Ok(plans)
}

pub async fn get_plan(pool: &sqlx::SqlitePool, plan_id: &str) -> AppResult<Option<ExecutionPlan>> {
    let row = sqlx::query(
        r#"
        SELECT plan_id, runtime_id, goal, created_by, planner_version, planning_mode,
               workflow_name, plan_rationale, revision, status, created_at, updated_at
        FROM execution_plans
        WHERE plan_id = ?
        "#,
    )
    .bind(plan_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    let mut plan = match row {
        Some(row) => row_to_plan_base(row)?,
        None => return Ok(None),
    };
    plan.steps = list_steps_for_plan(pool, &plan.plan_id).await?;
    Ok(Some(plan))
}

pub async fn list_execution_intents_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    agent_id: Option<&str>,
) -> AppResult<Vec<ExecutionIntent>> {
    let rows = if let Some(agent_id) = agent_id {
        sqlx::query(
            r#"
            SELECT intent_id, project_id, runtime_id, created_by, agent_id, agent_role,
                   kind, title, description, target, connector_id, payload, result_payload,
                   status, requires_approval, note, result_summary, approved_at, resolved_at,
                   created_at, updated_at
            FROM execution_intents
            WHERE project_id = ? AND agent_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(project_id)
        .bind(agent_id)
        .fetch_all(pool)
        .await
        .map_err(message_error)?
    } else {
        sqlx::query(
            r#"
            SELECT intent_id, project_id, runtime_id, created_by, agent_id, agent_role,
                   kind, title, description, target, connector_id, payload, result_payload,
                   status, requires_approval, note, result_summary, approved_at, resolved_at,
                   created_at, updated_at
            FROM execution_intents
            WHERE project_id = ?
            ORDER BY created_at DESC
            "#,
        )
        .bind(project_id)
        .fetch_all(pool)
        .await
        .map_err(message_error)?
    };

    rows.into_iter().map(row_to_execution_intent).collect()
}

pub async fn get_execution_intent(
    pool: &sqlx::SqlitePool,
    intent_id: &str,
) -> AppResult<Option<ExecutionIntent>> {
    let row = sqlx::query(
        r#"
        SELECT intent_id, project_id, runtime_id, created_by, agent_id, agent_role,
               kind, title, description, target, connector_id, payload, result_payload,
               status, requires_approval, note, result_summary, approved_at, resolved_at,
               created_at, updated_at
        FROM execution_intents
        WHERE intent_id = ?
        "#,
    )
    .bind(intent_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_execution_intent).transpose()
}

pub async fn insert_execution_intent(
    pool: &sqlx::SqlitePool,
    input: &NewExecutionIntent,
) -> AppResult<ExecutionIntent> {
    let intent_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO execution_intents (
            intent_id, project_id, runtime_id, created_by, agent_id, agent_role, kind,
            title, description, target, connector_id, payload, status, requires_approval
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&intent_id)
    .bind(&input.project_id)
    .bind(input.runtime_id.clone())
    .bind(input.created_by.clone())
    .bind(&input.agent_id)
    .bind(&input.agent_role)
    .bind(execution_intent_kind_to_str(&input.kind))
    .bind(&input.title)
    .bind(&input.description)
    .bind(&input.target)
    .bind(&input.connector_id)
    .bind(encode_json(&input.payload)?)
    .bind(if input.requires_approval {
        execution_intent_status_to_str(&ExecutionIntentStatus::PendingApproval)
    } else {
        execution_intent_status_to_str(&ExecutionIntentStatus::Draft)
    })
    .bind(if input.requires_approval { 1 } else { 0 })
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_execution_intent(pool, &intent_id)
        .await?
        .ok_or_else(|| AppError::Message("created execution intent not found".into()))
}

pub async fn set_execution_intent_decision(
    pool: &sqlx::SqlitePool,
    intent_id: &str,
    status: &ExecutionIntentStatus,
    note: Option<&str>,
    mark_approved: bool,
    mark_resolved: bool,
) -> AppResult<Option<ExecutionIntent>> {
    let result = sqlx::query(
        r#"
        UPDATE execution_intents
        SET status = ?,
            note = COALESCE(?, note),
            approved_at = CASE
                WHEN ? = 1 AND approved_at IS NULL THEN datetime('now')
                ELSE approved_at
            END,
            resolved_at = CASE
                WHEN ? = 1 THEN datetime('now')
                ELSE NULL
            END,
            updated_at = datetime('now')
        WHERE intent_id = ?
        "#,
    )
    .bind(execution_intent_status_to_str(status))
    .bind(note)
    .bind(if mark_approved { 1 } else { 0 })
    .bind(if mark_resolved { 1 } else { 0 })
    .bind(intent_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_execution_intent(pool, intent_id).await
}

pub async fn mark_execution_intent_executing(
    pool: &sqlx::SqlitePool,
    intent_id: &str,
) -> AppResult<Option<ExecutionIntent>> {
    let result = sqlx::query(
        r#"
        UPDATE execution_intents
        SET status = ?,
            updated_at = datetime('now')
        WHERE intent_id = ?
        "#,
    )
    .bind(execution_intent_status_to_str(
        &ExecutionIntentStatus::Executing,
    ))
    .bind(intent_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_execution_intent(pool, intent_id).await
}

pub async fn complete_execution_intent(
    pool: &sqlx::SqlitePool,
    intent_id: &str,
    status: &ExecutionIntentStatus,
    result_summary: &str,
    result_payload: Option<&serde_json::Value>,
    note: Option<&str>,
) -> AppResult<Option<ExecutionIntent>> {
    let encoded_result_payload = result_payload.map(encode_json).transpose()?;
    let result = sqlx::query(
        r#"
        UPDATE execution_intents
        SET status = ?,
            result_summary = ?,
            result_payload = ?,
            note = COALESCE(?, note),
            resolved_at = datetime('now'),
            updated_at = datetime('now')
        WHERE intent_id = ?
        "#,
    )
    .bind(execution_intent_status_to_str(status))
    .bind(result_summary)
    .bind(encoded_result_payload)
    .bind(note)
    .bind(intent_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_execution_intent(pool, intent_id).await
}

pub async fn insert_plan(
    pool: &sqlx::SqlitePool,
    plan: &ExecutionPlan,
) -> AppResult<ExecutionPlan> {
    sqlx::query(
        r#"
        INSERT INTO execution_plans (
            plan_id, runtime_id, workflow_name, goal, created_by, planner_version,
            planning_mode, plan_rationale, revision, status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&plan.plan_id)
    .bind(&plan.runtime_id)
    .bind(&plan.workflow_name)
    .bind(&plan.goal)
    .bind(&plan.created_by)
    .bind(&plan.planner_version)
    .bind(&plan.planning_mode)
    .bind(&plan.plan_rationale)
    .bind(plan.revision)
    .bind(plan_status_to_str(&plan.status))
    .execute(pool)
    .await
    .map_err(message_error)?;

    for step in &plan.steps {
        sqlx::query(
            r#"
            INSERT INTO execution_steps (
                step_id, plan_id, label, description, assigned_to, depends_on,
                approval_required_by, status, required_capabilities, selection_reason,
                approval_reason, planner_notes, parallel_group, input, output,
                started_at, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            "#,
        )
        .bind(&step.step_id)
        .bind(&plan.plan_id)
        .bind(&step.label)
        .bind(&step.description)
        .bind(step.assigned_to.clone())
        .bind(encode_json(&step.depends_on)?)
        .bind(step.approval_required_by.clone())
        .bind(step_status_to_str(&step.status))
        .bind(encode_json(&step.required_capabilities)?)
        .bind(step.selection_reason.clone())
        .bind(step.approval_reason.clone())
        .bind(step.planner_notes.clone())
        .bind(step.parallel_group.clone())
        .bind(encode_json(&step.input)?)
        .bind(encode_json(&step.output)?)
        .bind(step.started_at.clone())
        .bind(step.completed_at.clone())
        .execute(pool)
        .await
        .map_err(message_error)?;
    }

    get_plan(pool, &plan.plan_id)
        .await?
        .ok_or_else(|| AppError::Message("created plan not found".into()))
}

pub async fn list_steps_for_plan(
    pool: &sqlx::SqlitePool,
    plan_id: &str,
) -> AppResult<Vec<ExecutionStep>> {
    let rows = sqlx::query(
        r#"
        SELECT step_id, label, description, assigned_to, depends_on,
               approval_required_by, status, required_capabilities, selection_reason,
               approval_reason, planner_notes, parallel_group, input, output,
               started_at, completed_at
        FROM execution_steps
        WHERE plan_id = ?
        ORDER BY rowid ASC
        "#,
    )
    .bind(plan_id)
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_step).collect()
}

pub async fn get_step(pool: &sqlx::SqlitePool, step_id: &str) -> AppResult<Option<ExecutionStep>> {
    let row = sqlx::query(
        r#"
        SELECT step_id, label, description, assigned_to, depends_on,
               approval_required_by, status, required_capabilities, selection_reason,
               approval_reason, planner_notes, parallel_group, input, output,
               started_at, completed_at
        FROM execution_steps
        WHERE step_id = ?
        "#,
    )
    .bind(step_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_step).transpose()
}

pub async fn update_plan_status(
    pool: &sqlx::SqlitePool,
    plan_id: &str,
    status: &PlanStatus,
) -> AppResult<Option<ExecutionPlan>> {
    let result = sqlx::query(
        "UPDATE execution_plans SET status = ?, updated_at = datetime('now') WHERE plan_id = ?",
    )
    .bind(plan_status_to_str(status))
    .bind(plan_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    if result.rows_affected() == 0 {
        return Ok(None);
    }

    get_plan(pool, plan_id).await
}

pub async fn update_step_status(
    pool: &sqlx::SqlitePool,
    step_id: &str,
    status: &StepStatus,
    input: Option<&serde_json::Value>,
    output: Option<&serde_json::Value>,
    mark_started: bool,
    mark_completed: bool,
) -> AppResult<Option<ExecutionStep>> {
    let current = match get_step(pool, step_id).await? {
        Some(step) => step,
        None => return Ok(None),
    };

    let next_input = input.cloned().unwrap_or_else(|| current.input.clone());
    let next_output = output.cloned().unwrap_or_else(|| current.output.clone());
    let started_at = if mark_started && current.started_at.is_none() {
        Some("datetime('now')".to_string())
    } else {
        current.started_at.clone()
    };
    let completed_at = if mark_completed {
        Some("datetime('now')".to_string())
    } else {
        current.completed_at.clone()
    };

    sqlx::query(
        r#"
        UPDATE execution_steps
        SET status = ?,
            input = ?,
            output = ?,
            started_at = CASE WHEN ? = 1 AND started_at IS NULL THEN datetime('now') ELSE ? END,
            completed_at = CASE WHEN ? = 1 THEN datetime('now') ELSE ? END
        WHERE step_id = ?
        "#,
    )
    .bind(step_status_to_str(status))
    .bind(encode_json(&next_input)?)
    .bind(encode_json(&next_output)?)
    .bind(if mark_started { 1 } else { 0 })
    .bind(started_at)
    .bind(if mark_completed { 1 } else { 0 })
    .bind(completed_at)
    .bind(step_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_step(pool, step_id).await
}

pub async fn find_project_id_for_plan(
    pool: &sqlx::SqlitePool,
    plan_id: &str,
) -> AppResult<Option<String>> {
    sqlx::query_scalar(
        r#"
        SELECT cr.project_id
        FROM execution_plans ep
        JOIN company_runtimes cr ON cr.runtime_id = ep.runtime_id
        WHERE ep.plan_id = ?
        "#,
    )
    .bind(plan_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)
}

pub async fn find_project_id_for_execution_intent(
    pool: &sqlx::SqlitePool,
    intent_id: &str,
) -> AppResult<Option<String>> {
    sqlx::query_scalar("SELECT project_id FROM execution_intents WHERE intent_id = ?")
        .bind(intent_id)
        .fetch_optional(pool)
        .await
        .map_err(message_error)
}

pub async fn list_events_for_plan(
    pool: &sqlx::SqlitePool,
    plan_id: &str,
) -> AppResult<Vec<RuntimeEvent>> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, project_id, runtime_id, plan_id, step_id, actor_id,
               event_type, sequence_no, payload, timestamp_ms, created_at
        FROM execution_events
        WHERE plan_id = ?
        ORDER BY sequence_no ASC
        "#,
    )
    .bind(plan_id)
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_event).collect()
}

pub async fn list_events_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    limit: i64,
) -> AppResult<Vec<RuntimeEvent>> {
    let rows = sqlx::query(
        r#"
        SELECT event_id, project_id, runtime_id, plan_id, step_id, actor_id,
               event_type, sequence_no, payload, timestamp_ms, created_at
        FROM execution_events
        WHERE project_id = ?
        ORDER BY sequence_no DESC
        LIMIT ?
        "#,
    )
    .bind(project_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(message_error)?;

    rows.into_iter().map(row_to_event).collect()
}

pub async fn append_execution_event(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    runtime_id: &str,
    plan_id: Option<&str>,
    step_id: Option<&str>,
    actor_id: Option<&str>,
    event_type: &EventType,
    payload: &serde_json::Value,
) -> AppResult<RuntimeEvent> {
    let event_id = Uuid::new_v4().to_string();
    let timestamp = now_epoch_ms() as i64;
    let mut tx = pool.begin().await.map_err(message_error)?;

    let sequence_no: i64 = sqlx::query_scalar(
        r#"
        SELECT COALESCE(MAX(sequence_no), 0) + 1
        FROM execution_events
        WHERE project_id = ?
        "#,
    )
    .bind(project_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(message_error)?;

    sqlx::query(
        r#"
        INSERT INTO execution_events (
            event_id, project_id, runtime_id, plan_id, step_id, actor_id,
            event_type, sequence_no, payload, timestamp_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&event_id)
    .bind(project_id)
    .bind(runtime_id)
    .bind(plan_id)
    .bind(step_id)
    .bind(actor_id)
    .bind(event_type_to_str(event_type))
    .bind(sequence_no)
    .bind(encode_json(payload)?)
    .bind(timestamp)
    .execute(&mut *tx)
    .await
    .map_err(message_error)?;

    let row = sqlx::query(
        r#"
        SELECT event_id, project_id, runtime_id, plan_id, step_id, actor_id,
               event_type, sequence_no, payload, timestamp_ms, created_at
        FROM execution_events
        WHERE event_id = ?
        "#,
    )
    .bind(&event_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(message_error)?;

    tx.commit().await.map_err(message_error)?;
    row_to_event(row)
}

fn now_epoch_ms() -> u64 {
    let now = std::time::SystemTime::now();
    now.duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{event_type_to_str, parse_event_type};
    use crate::events::EventType;

    #[test]
    fn event_type_round_trip_covers_agent_activity_variants() {
        let variants = [
            EventType::PlanCreated,
            EventType::StepStatusChanged,
            EventType::ApprovalRequested,
            EventType::ApprovalGranted,
            EventType::PlanStarted,
            EventType::PlanCompleted,
            EventType::PlanFailed,
            EventType::ExecutionIntentCreated,
            EventType::ExecutionIntentStatusChanged,
            EventType::ConnectorExecutionStarted,
            EventType::ConnectorExecutionCompleted,
            EventType::ConnectorExecutionFailed,
            EventType::AgentStatusChanged,
            EventType::AgentWorking,
            EventType::AgentIdle,
            EventType::AgentHandoff,
            EventType::AgentReviewing,
            EventType::RuntimeUpdated,
        ];

        for variant in variants {
            let encoded = event_type_to_str(&variant);
            let decoded = parse_event_type(encoded.to_string());
            assert_eq!(decoded, variant);
        }
    }
}
