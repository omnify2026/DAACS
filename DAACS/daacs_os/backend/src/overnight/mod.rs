use infra_error::{AppError, AppResult};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

const DEFAULT_MAX_RUNTIME_MINUTES: i64 = 480;
const DEFAULT_MAX_SPEND_USD: f64 = 5.0;
const DEFAULT_MAX_ITERATIONS: i64 = 20;
const DEFAULT_VERIFICATION_PROFILE: &str = "default";
const DEFAULT_QUALITY_THRESHOLD: i64 = 7;
const RESUMABLE_STATUSES: &[&str] = &["recovering", "needs_human", "stopped_with_report"];
const ACTIVE_STATUSES: &[&str] = &["queued", "running", "recovering", "needs_human"];

#[derive(Debug, Clone)]
pub struct OvernightRun {
    pub run_id: String,
    pub project_id: String,
    pub task_id: String,
    pub workflow_name: String,
    pub goal: String,
    pub status: String,
    pub overnight_config: Value,
    pub steps: Vec<Value>,
    pub spent_usd: f64,
    pub deadline_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct ResumeOvernightUpdate {
    pub additional_budget_usd: Option<f64>,
    pub additional_time_minutes: Option<i64>,
    pub additional_iterations: Option<i64>,
}

fn message_error(error: impl std::fmt::Display) -> AppError {
    AppError::Message(error.to_string())
}

fn encode_json(value: &impl serde::Serialize) -> AppResult<String> {
    serde_json::to_string(value).map_err(Into::into)
}

fn decode_json(raw: String) -> AppResult<Value> {
    serde_json::from_str(&raw).map_err(Into::into)
}

fn extract_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn summarize_label(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return "Overnight objective".to_string();
    }
    let mut chars = trimmed.chars();
    let summary: String = chars.by_ref().take(72).collect();
    if chars.next().is_some() {
        format!("{summary}...")
    } else {
        summary
    }
}

fn synthesize_steps(goal: &str, definition_of_done: &[String]) -> Vec<Value> {
    let items = if definition_of_done.is_empty() {
        vec![goal.trim().to_string()]
    } else {
        definition_of_done.to_vec()
    };

    items
        .into_iter()
        .enumerate()
        .map(|(index, description)| {
            let label = summarize_label(&description);
            json!({
                "id": format!("overnight-step-{}", index + 1),
                "label": label,
                "description": description,
                "status": "pending",
                "type": "definition_of_done",
            })
        })
        .collect()
}

async fn compute_deadline_at(
    pool: &sqlx::SqlitePool,
    runtime_minutes: i64,
) -> AppResult<Option<String>> {
    sqlx::query_scalar("SELECT datetime('now', ?)")
        .bind(format!("+{runtime_minutes} minutes"))
        .fetch_optional(pool)
        .await
        .map_err(message_error)
}

async fn extend_deadline_at(
    pool: &sqlx::SqlitePool,
    current_deadline_at: Option<&str>,
    additional_minutes: i64,
) -> AppResult<Option<String>> {
    if additional_minutes <= 0 {
        return Ok(current_deadline_at.map(str::to_string));
    }

    if let Some(deadline_at) = current_deadline_at {
        return sqlx::query_scalar("SELECT datetime(?, ?)")
            .bind(deadline_at)
            .bind(format!("+{additional_minutes} minutes"))
            .fetch_optional(pool)
            .await
            .map_err(message_error);
    }

    compute_deadline_at(pool, additional_minutes).await
}

fn normalize_constraints(config: &mut serde_json::Map<String, Value>) {
    let needs_reset = !matches!(config.get("constraints"), Some(Value::Object(_)));
    if needs_reset {
        config.insert("constraints".to_string(), json!({}));
    }
    let Some(constraints) = config.get_mut("constraints").and_then(Value::as_object_mut) else {
        return;
    };

    let max_runtime_minutes = constraints
        .get("max_runtime_minutes")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_RUNTIME_MINUTES);
    let max_spend_usd = constraints
        .get("max_spend_usd")
        .and_then(Value::as_f64)
        .filter(|value| *value > 0.0)
        .unwrap_or(DEFAULT_MAX_SPEND_USD);
    let max_iterations = constraints
        .get("max_iterations")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_ITERATIONS);
    let allowed_tools = extract_string_list(constraints.get("allowed_tools"));
    let blocked_commands = extract_string_list(constraints.get("blocked_commands"));

    constraints.insert(
        "max_runtime_minutes".to_string(),
        Value::from(max_runtime_minutes),
    );
    constraints.insert("max_spend_usd".to_string(), Value::from(max_spend_usd));
    constraints.insert("max_iterations".to_string(), Value::from(max_iterations));
    constraints.insert("allowed_tools".to_string(), json!(allowed_tools));
    constraints.insert("blocked_commands".to_string(), json!(blocked_commands));
}

fn normalize_config_value(
    workflow_name: &str,
    goal: &str,
    task_id: &str,
    deadline_at: Option<&str>,
    config: &Value,
    state: &str,
) -> (Value, Vec<Value>) {
    let mut normalized = config
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    normalize_constraints(&mut normalized);

    let definition_of_done = extract_string_list(normalized.get("definition_of_done"));
    let steps = synthesize_steps(goal, &definition_of_done);

    normalized.insert("mode".to_string(), Value::from("overnight"));
    normalized.insert(
        "workflow_name".to_string(),
        Value::from(workflow_name.to_string()),
    );
    normalized.insert(
        "verification_profile".to_string(),
        Value::from(
            normalized
                .get("verification_profile")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(DEFAULT_VERIFICATION_PROFILE)
                .to_string(),
        ),
    );
    normalized.insert(
        "quality_threshold".to_string(),
        Value::from(
            normalized
                .get("quality_threshold")
                .and_then(Value::as_i64)
                .unwrap_or(DEFAULT_QUALITY_THRESHOLD),
        ),
    );
    normalized
        .entry("resume_policy".to_string())
        .or_insert_with(|| json!({ "max_retries_per_gate": 3, "max_total_retries": 12 }));
    normalized
        .entry("params".to_string())
        .or_insert_with(|| json!({}));
    normalized
        .entry("gate_results".to_string())
        .or_insert_with(|| json!([]));
    normalized
        .entry("retries".to_string())
        .or_insert_with(|| json!({ "per_gate": {}, "total": 0 }));
    normalized.insert("state".to_string(), Value::from(state.to_string()));
    normalized.insert(
        "celery_task_id".to_string(),
        Value::from(task_id.to_string()),
    );
    normalized.insert(
        "deadline_at".to_string(),
        deadline_at
            .map(|value| Value::from(value.to_string()))
            .unwrap_or(Value::Null),
    );
    normalized.insert(
        "next_actions".to_string(),
        json!(derive_next_actions_from_steps(state, &steps)),
    );

    (Value::Object(normalized), steps)
}

fn derive_next_actions_from_steps(status: &str, steps: &[Value]) -> Vec<String> {
    let mut actions = steps
        .iter()
        .filter_map(|step| {
            let label = step.get("label").and_then(Value::as_str)?.trim();
            if label.is_empty() {
                return None;
            }
            let step_status = step
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");

            let action = match step_status {
                "failed" => format!("Investigate failed overnight objective: {label}"),
                "blocked" => format!("Unblock overnight objective: {label}"),
                "awaiting_approval" => {
                    format!("Review and approve overnight objective: {label}")
                }
                "completed" | "approved" | "skipped" => return None,
                _ => format!("Complete overnight objective: {label}"),
            };

            Some(action)
        })
        .collect::<Vec<_>>();

    if actions.is_empty() {
        match status {
            "running" | "queued" => actions
                .push("Let the overnight run continue until the deadline or stop it for review."
                    .to_string()),
            "stopped_with_report" => actions.push(
                "Review the current overnight report and resume with more time, budget, or iterations if needed."
                    .to_string(),
            ),
            "needs_human" | "recovering" => actions.push(
                "Review the overnight blockers, then resume the run after addressing them."
                    .to_string(),
            ),
            "completed" => actions.push(
                "Review the overnight deliverables and close the run if they satisfy the goal."
                    .to_string(),
            ),
            _ => {}
        }
    }

    actions
}

fn row_to_run(row: sqlx::sqlite::SqliteRow) -> AppResult<OvernightRun> {
    let overnight_config = decode_json(row.try_get("overnight_config").map_err(message_error)?)?;
    let steps_value = decode_json(row.try_get("steps").map_err(message_error)?)?;
    let steps = steps_value.as_array().cloned().unwrap_or_default();

    Ok(OvernightRun {
        run_id: row.try_get("run_id").map_err(message_error)?,
        project_id: row.try_get("project_id").map_err(message_error)?,
        task_id: row.try_get("task_id").map_err(message_error)?,
        workflow_name: row.try_get("workflow_name").map_err(message_error)?,
        goal: row.try_get("goal").map_err(message_error)?,
        status: row.try_get("status").map_err(message_error)?,
        overnight_config,
        steps,
        spent_usd: row
            .try_get::<Option<f64>, _>("spent_usd")
            .map_err(message_error)?
            .unwrap_or_default(),
        deadline_at: row.try_get("deadline_at").map_err(message_error)?,
        created_at: row.try_get("created_at").map_err(message_error)?,
        updated_at: row.try_get("updated_at").map_err(message_error)?,
    })
}

pub async fn start_overnight_run(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    workflow_name: &str,
    goal: &str,
    config: &Value,
) -> AppResult<OvernightRun> {
    let run_id = Uuid::new_v4().to_string();
    let task_id = format!("overnight-task-{}", Uuid::new_v4());
    let requested_minutes = config
        .get("constraints")
        .and_then(Value::as_object)
        .and_then(|constraints| constraints.get("max_runtime_minutes"))
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_RUNTIME_MINUTES);
    let deadline_at = compute_deadline_at(pool, requested_minutes).await?;
    let (overnight_config, steps) = normalize_config_value(
        workflow_name,
        goal,
        &task_id,
        deadline_at.as_deref(),
        config,
        "running",
    );

    sqlx::query(
        r#"
        INSERT INTO overnight_runs (
            run_id, project_id, task_id, workflow_name, goal, status,
            overnight_config, steps, spent_usd, deadline_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&run_id)
    .bind(project_id)
    .bind(&task_id)
    .bind(workflow_name)
    .bind(goal)
    .bind("running")
    .bind(encode_json(&overnight_config)?)
    .bind(encode_json(&steps)?)
    .bind(0.0_f64)
    .bind(deadline_at.clone())
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_overnight_run(pool, project_id, &run_id)
        .await?
        .ok_or_else(|| AppError::Message("created overnight run not found".into()))
}

pub async fn get_overnight_run(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    run_id: &str,
) -> AppResult<Option<OvernightRun>> {
    let row = sqlx::query(
        r#"
        SELECT run_id, project_id, task_id, workflow_name, goal, status,
               overnight_config, steps, spent_usd, deadline_at, created_at, updated_at
        FROM overnight_runs
        WHERE project_id = ? AND run_id = ?
        "#,
    )
    .bind(project_id)
    .bind(run_id)
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_run).transpose()
}

pub async fn get_active_overnight_run_for_project(
    pool: &sqlx::SqlitePool,
    project_id: &str,
) -> AppResult<Option<OvernightRun>> {
    let row = sqlx::query(
        r#"
        SELECT run_id, project_id, task_id, workflow_name, goal, status,
               overnight_config, steps, spent_usd, deadline_at, created_at, updated_at
        FROM overnight_runs
        WHERE project_id = ? AND status IN (?, ?, ?, ?)
        ORDER BY created_at DESC
        LIMIT 1
        "#,
    )
    .bind(project_id)
    .bind(ACTIVE_STATUSES[0])
    .bind(ACTIVE_STATUSES[1])
    .bind(ACTIVE_STATUSES[2])
    .bind(ACTIVE_STATUSES[3])
    .fetch_optional(pool)
    .await
    .map_err(message_error)?;

    row.map(row_to_run).transpose()
}

pub async fn stop_overnight_run(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    run_id: &str,
) -> AppResult<Option<OvernightRun>> {
    let current = match get_overnight_run(pool, project_id, run_id).await? {
        Some(run) => run,
        None => return Ok(None),
    };

    let mut overnight_config = current
        .overnight_config
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    overnight_config.insert("state".to_string(), Value::from("stopped_with_report"));
    overnight_config.insert(
        "next_actions".to_string(),
        json!(derive_next_actions_from_steps(
            "stopped_with_report",
            &current.steps
        )),
    );

    sqlx::query(
        r#"
        UPDATE overnight_runs
        SET status = ?, overnight_config = ?, updated_at = datetime('now')
        WHERE project_id = ? AND run_id = ?
        "#,
    )
    .bind("stopped_with_report")
    .bind(encode_json(&Value::Object(overnight_config))?)
    .bind(project_id)
    .bind(run_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_overnight_run(pool, project_id, run_id).await
}

pub async fn resume_overnight_run(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    run_id: &str,
    update: ResumeOvernightUpdate,
) -> AppResult<Option<OvernightRun>> {
    let current = match get_overnight_run(pool, project_id, run_id).await? {
        Some(run) => run,
        None => return Ok(None),
    };

    if !RESUMABLE_STATUSES.contains(&current.status.as_str()) {
        return Err(AppError::Message(format!(
            "Run status '{}' is not resumable",
            current.status
        )));
    }

    let mut overnight_config = current
        .overnight_config
        .as_object()
        .cloned()
        .unwrap_or_else(serde_json::Map::new);
    normalize_constraints(&mut overnight_config);

    let Some(constraints) = overnight_config
        .get_mut("constraints")
        .and_then(Value::as_object_mut)
    else {
        return Err(AppError::Message(
            "Overnight run constraints are unavailable".to_string(),
        ));
    };
    let next_budget = constraints
        .get("max_spend_usd")
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_MAX_SPEND_USD)
        + update.additional_budget_usd.unwrap_or_default().max(0.0);
    let next_iterations = constraints
        .get("max_iterations")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_MAX_ITERATIONS)
        + update.additional_iterations.unwrap_or_default().max(0);
    let next_minutes = constraints
        .get("max_runtime_minutes")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_MAX_RUNTIME_MINUTES)
        + update.additional_time_minutes.unwrap_or_default().max(0);

    constraints.insert("max_spend_usd".to_string(), Value::from(next_budget));
    constraints.insert("max_iterations".to_string(), Value::from(next_iterations));
    constraints.insert("max_runtime_minutes".to_string(), Value::from(next_minutes));

    let next_deadline_at = extend_deadline_at(
        pool,
        current.deadline_at.as_deref(),
        update.additional_time_minutes.unwrap_or_default().max(0),
    )
    .await?;
    let next_task_id = format!("overnight-task-{}", Uuid::new_v4());

    overnight_config.insert("state".to_string(), Value::from("running"));
    overnight_config.insert(
        "celery_task_id".to_string(),
        Value::from(next_task_id.clone()),
    );
    overnight_config.insert(
        "deadline_at".to_string(),
        next_deadline_at
            .as_ref()
            .map(|value| Value::from(value.clone()))
            .unwrap_or(Value::Null),
    );
    overnight_config.insert(
        "next_actions".to_string(),
        json!(derive_next_actions_from_steps("running", &current.steps)),
    );

    sqlx::query(
        r#"
        UPDATE overnight_runs
        SET task_id = ?,
            status = ?,
            overnight_config = ?,
            deadline_at = ?,
            updated_at = datetime('now')
        WHERE project_id = ? AND run_id = ?
        "#,
    )
    .bind(&next_task_id)
    .bind("running")
    .bind(encode_json(&Value::Object(overnight_config))?)
    .bind(next_deadline_at.clone())
    .bind(project_id)
    .bind(run_id)
    .execute(pool)
    .await
    .map_err(message_error)?;

    get_overnight_run(pool, project_id, run_id).await
}

pub async fn get_overnight_report(
    pool: &sqlx::SqlitePool,
    project_id: &str,
    run_id: &str,
) -> AppResult<Option<Value>> {
    let run = match get_overnight_run(pool, project_id, run_id).await? {
        Some(run) => run,
        None => return Ok(None),
    };

    let gate_results = run
        .overnight_config
        .get("gate_results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let hard_failures = gate_results
        .iter()
        .filter(|gate| {
            gate.get("hard").and_then(Value::as_bool).unwrap_or(false)
                && gate.get("verdict").and_then(Value::as_str) != Some("pass")
        })
        .cloned()
        .collect::<Vec<_>>();

    Ok(Some(json!({
        "run_id": run.run_id,
        "goal": run.goal,
        "final_status": run.status,
        "spent_usd": run.spent_usd,
        "deadline_at": run.deadline_at,
        "gate_results": gate_results,
        "hard_failures": hard_failures,
        "logs_tail": run.steps.iter().rev().take(20).cloned().collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),
        "next_actions": run
            .overnight_config
            .get("next_actions")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                derive_next_actions_from_steps(&run.status, &run.steps)
                    .into_iter()
                    .map(Value::from)
                    .collect()
            }),
    })))
}
