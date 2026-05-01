use infra_error::AppResult;
use serde_json::json;

use crate::domain::{
    execution::{ExecutionPlan, StepStatus},
    instance::AgentInstance,
    repository,
};

#[derive(Debug, Clone)]
pub struct ContextSnapshot {
    pub recent_outputs: Vec<serde_json::Value>,
    pub shared_artifacts: Vec<serde_json::Value>,
    pub token_budget_remaining: u32,
}

pub struct RuntimeContext;

impl RuntimeContext {
    pub fn get_context(
        instance: &AgentInstance,
        plan: &ExecutionPlan,
    ) -> AppResult<ContextSnapshot> {
        let recent_outputs = plan
            .steps
            .iter()
            .filter(|step| matches!(step.status, StepStatus::Completed | StepStatus::Approved))
            .filter(|step| !step.output.is_null())
            .rev()
            .take(5)
            .map(|step| {
                json!({
                    "step_id": step.step_id,
                    "label": step.label,
                    "output": step.output,
                })
            })
            .collect::<Vec<_>>();

        let token_budget_remaining = instance
            .context_window_state
            .get("token_budget_remaining")
            .and_then(|value| value.as_u64())
            .unwrap_or(120_000) as u32;

        Ok(ContextSnapshot {
            recent_outputs,
            shared_artifacts: vec![],
            token_budget_remaining,
        })
    }

    pub async fn update_token_usage(
        pool: &sqlx::SqlitePool,
        instance: &AgentInstance,
        input_tokens: u32,
        output_tokens: u32,
        last_step_id: &str,
    ) -> AppResult<()> {
        let total_tokens = instance
            .live_metrics
            .get("total_tokens")
            .and_then(|value| value.as_u64())
            .unwrap_or_default()
            + u64::from(input_tokens)
            + u64::from(output_tokens);

        let token_budget_remaining = 120_000u64.saturating_sub(total_tokens);
        let live_metrics = json!({
            "total_tokens": total_tokens,
            "last_input_tokens": input_tokens,
            "last_output_tokens": output_tokens,
        });
        let context_window_state = json!({
            "last_step_id": last_step_id,
            "token_budget_remaining": token_budget_remaining,
        });

        repository::update_instance_runtime_state(
            pool,
            &instance.instance_id,
            Some(&context_window_state),
            Some(&instance.memory_bindings),
            Some(&live_metrics),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn get_shared_context(
        pool: &sqlx::SqlitePool,
        runtime_id: &str,
    ) -> AppResult<serde_json::Value> {
        let plans = repository::list_plans_for_runtime(pool, runtime_id).await?;
        let completed_outputs = plans
            .into_iter()
            .flat_map(|plan| plan.steps.into_iter())
            .filter(|step| matches!(step.status, StepStatus::Completed | StepStatus::Approved))
            .filter(|step| !step.output.is_null())
            .map(|step| {
                json!({
                    "step_id": step.step_id,
                    "label": step.label,
                    "output": step.output,
                })
            })
            .collect::<Vec<_>>();

        Ok(json!({
            "runtime_id": runtime_id,
            "completed_outputs": completed_outputs,
        }))
    }
}
