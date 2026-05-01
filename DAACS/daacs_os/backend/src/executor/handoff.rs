use infra_error::AppResult;
use serde_json::json;

use crate::domain::execution::{ExecutionPlan, ExecutionStep, StepStatus};

#[derive(Debug, Clone)]
pub struct StepTransition {
    pub step_id: String,
    pub assembled_input: serde_json::Value,
    pub next_status: StepStatus,
}

pub struct StepHandoff;

impl StepHandoff {
    pub fn assemble_ready_input(
        plan: &ExecutionPlan,
        step: &ExecutionStep,
    ) -> AppResult<serde_json::Value> {
        Ok(assemble_input(plan, step))
    }

    pub fn dependencies_satisfied(plan: &ExecutionPlan, step: &ExecutionStep) -> bool {
        dependencies_satisfied(plan, step)
    }

    pub fn process_completion(
        plan: &ExecutionPlan,
        completed_step: &ExecutionStep,
    ) -> AppResult<Vec<StepTransition>> {
        let transitions = plan
            .steps
            .iter()
            .filter(|step| step.depends_on.contains(&completed_step.step_id))
            .filter(|step| matches!(step.status, StepStatus::Pending | StepStatus::Blocked))
            .filter(|step| dependencies_satisfied(plan, step))
            .map(|step| StepTransition {
                step_id: step.step_id.clone(),
                assembled_input: assemble_input(plan, step),
                next_status: if step.approval_required_by.is_some() {
                    StepStatus::AwaitingApproval
                } else {
                    StepStatus::Pending
                },
            })
            .collect();

        Ok(transitions)
    }
}

fn dependencies_satisfied(plan: &ExecutionPlan, step: &ExecutionStep) -> bool {
    step.depends_on.iter().all(|dependency_id| {
        plan.steps
            .iter()
            .find(|candidate| &candidate.step_id == dependency_id)
            .map(|candidate| {
                matches!(
                    candidate.status,
                    StepStatus::Completed | StepStatus::Approved | StepStatus::Skipped
                )
            })
            .unwrap_or(false)
    })
}

fn assemble_input(plan: &ExecutionPlan, step: &ExecutionStep) -> serde_json::Value {
    let dependency_outputs = step
        .depends_on
        .iter()
        .filter_map(|dependency_id| {
            plan.steps
                .iter()
                .find(|candidate| &candidate.step_id == dependency_id)
        })
        .map(|dependency| {
            json!({
                "step_id": dependency.step_id,
                "label": dependency.label,
                "output": dependency.output,
            })
        })
        .collect::<Vec<_>>();

    json!({
        "goal": plan.goal,
        "depends_on": dependency_outputs,
        "existing_input": step.input,
    })
}
