use crate::recover_json;
use crate::workflow_types::{
    ApiEndpoint, ApiSpec, OrchestrationPolicy, PlanningEvaluationInput, PlanningResult,
    PlanningTask, TechStack,
};
use serde::Deserialize;

const ROLE_ORDER: &[&str] = &[
    "pm",
    "developer",
    "designer",
    "reviewer",
    "verifier",
    "devops",
    "ceo",
    "cfo",
    "marketer",
];

#[derive(Debug, Default, Deserialize)]
struct PlanningDraft {
    #[serde(default)]
    plan: String,
    needs_backend: Option<bool>,
    needs_frontend: Option<bool>,
    #[serde(default)]
    tech_stack: TechStack,
    #[serde(default)]
    api_spec: ApiSpec,
    #[serde(default)]
    tasks: Vec<PlanningTask>,
    #[serde(default)]
    qa_profile: String,
    #[serde(default)]
    acceptance_criteria: Vec<String>,
}

pub fn evaluate_planning(input: PlanningEvaluationInput) -> PlanningResult {
    let draft = input
        .llm_response
        .as_deref()
        .and_then(parse_planning_draft)
        .unwrap_or_default();
    let needs_backend = draft.needs_backend.unwrap_or(true);
    let needs_frontend = draft.needs_frontend.unwrap_or(true);
    let qa_profile = normalize_qa_profile(&draft.qa_profile);
    let api_spec = normalized_api_spec(draft.api_spec);
    let tech_stack = normalized_tech_stack(draft.tech_stack);
    let orchestrator_plan = normalized_plan(&draft.plan, &input.goal);
    let active_roles = derive_active_roles(needs_backend, needs_frontend, &draft.tasks);
    let orchestration_policy =
        build_orchestration_policy(needs_backend, needs_frontend, &active_roles);
    let acceptance_criteria =
        derive_acceptance_criteria(&draft.acceptance_criteria, &api_spec, needs_frontend);
    let evidence_required =
        default_evidence_required(qa_profile.as_str(), needs_backend, needs_frontend);
    let pending_handoffs = orchestration_policy
        .execution_handoffs
        .iter()
        .chain(orchestration_policy.quality_handoffs.iter())
        .cloned()
        .collect::<Vec<_>>();

    PlanningResult {
        orchestrator_plan,
        needs_backend,
        needs_frontend,
        api_spec: api_spec.clone(),
        tech_stack,
        tasks: draft.tasks,
        active_roles,
        orchestration_policy,
        qa_profile,
        acceptance_criteria,
        evidence_required,
        pending_handoffs,
        logs: vec![format!(
            "planning: plan generated, {} endpoints",
            api_spec.endpoints.len()
        )],
    }
}

pub fn default_evidence_required(
    qa_profile: &str,
    needs_backend: bool,
    needs_frontend: bool,
) -> Vec<String> {
    let mut requirements = Vec::new();
    if needs_backend {
        requirements.push("backend_files".to_string());
    }
    if needs_frontend {
        requirements.push("frontend_files".to_string());
    }
    if matches!(qa_profile, "standard" | "ui" | "strict") {
        requirements.push("python_json_syntax".to_string());
    }
    if needs_backend && matches!(qa_profile, "standard" | "ui" | "strict") {
        requirements.push("api_compliance".to_string());
    }
    requirements
}

fn parse_planning_draft(raw: &str) -> Option<PlanningDraft> {
    recover_json(raw).and_then(|value| serde_json::from_value(value).ok())
}

fn normalized_plan(raw_plan: &str, goal: &str) -> String {
    let trimmed_plan = raw_plan.trim();
    if !trimmed_plan.is_empty() {
        return trimmed_plan.to_string();
    }
    let trimmed_goal = goal.trim();
    if trimmed_goal.is_empty() {
        "Default plan for: the requested goal".to_string()
    } else {
        format!("Default plan for: {}", trimmed_goal)
    }
}

fn normalized_api_spec(mut api_spec: ApiSpec) -> ApiSpec {
    if api_spec.endpoints.is_empty() {
        api_spec.endpoints.push(ApiEndpoint {
            method: "GET".to_string(),
            path: "/api/health".to_string(),
            description: "Health check".to_string(),
        });
    }
    api_spec
}

fn normalized_tech_stack(mut tech_stack: TechStack) -> TechStack {
    if tech_stack.backend.is_empty() {
        tech_stack.backend = vec!["Rust".to_string(), "Tauri".to_string()];
    }
    if tech_stack.frontend.is_empty() {
        tech_stack.frontend = vec!["DAACS".to_string(), "Tauri WebView".to_string()];
    }
    tech_stack
}

fn normalize_qa_profile(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "lite" => "lite".to_string(),
        "ui" => "ui".to_string(),
        "strict" => "strict".to_string(),
        _ => "standard".to_string(),
    }
}

fn derive_acceptance_criteria(
    requested: &[String],
    api_spec: &ApiSpec,
    needs_frontend: bool,
) -> Vec<String> {
    let clean = requested
        .iter()
        .map(|item| item.trim())
        .filter(|item| !item.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if !clean.is_empty() {
        return clean;
    }

    let mut derived = api_spec
        .endpoints
        .iter()
        .filter_map(|endpoint| {
            let path = endpoint.path.trim();
            if path.is_empty() {
                None
            } else {
                Some(format!(
                    "{} {} is implemented",
                    endpoint.method.trim(),
                    path
                ))
            }
        })
        .collect::<Vec<_>>();

    if needs_frontend {
        derived.push("Frontend deliverables are present and non-empty".to_string());
    }

    derived.truncate(8);
    derived
}

fn derive_active_roles(
    needs_backend: bool,
    needs_frontend: bool,
    tasks: &[PlanningTask],
) -> Vec<String> {
    let mut roles = vec!["pm".to_string()];
    if needs_backend || needs_frontend {
        roles.extend([
            "developer".to_string(),
            "reviewer".to_string(),
            "verifier".to_string(),
        ]);
    }
    if needs_frontend {
        roles.push("designer".to_string());
    }
    for task in tasks {
        let assignee = task.assignee.trim().to_lowercase();
        if !assignee.is_empty() && !roles.contains(&assignee) {
            roles.push(assignee);
        }
    }

    ROLE_ORDER
        .iter()
        .filter(|role| roles.iter().any(|item| item == **role))
        .map(|role| role.to_string())
        .collect()
}

fn build_orchestration_policy(
    needs_backend: bool,
    needs_frontend: bool,
    active_roles: &[String],
) -> OrchestrationPolicy {
    let mut execution_handoffs = Vec::new();
    if needs_backend {
        execution_handoffs.push("execute_backend".to_string());
    }
    if needs_frontend {
        execution_handoffs.push("execute_frontend".to_string());
    }

    let mut quality_handoffs = Vec::new();
    if active_roles.iter().any(|role| role == "reviewer") {
        quality_handoffs.push("review".to_string());
    }
    if active_roles.iter().any(|role| role == "verifier") {
        quality_handoffs.push("verification".to_string());
    }

    OrchestrationPolicy {
        execution_handoffs,
        quality_handoffs,
        replan_handoff: active_roles
            .iter()
            .any(|role| role == "pm")
            .then(|| "replanning".to_string()),
        allow_skip_review: !active_roles.iter().any(|role| role == "reviewer"),
        allow_skip_verification: !active_roles.iter().any(|role| role == "verifier"),
    }
}

#[cfg(test)]
mod tests {
    use super::evaluate_planning;
    use crate::workflow_types::PlanningEvaluationInput;

    #[test]
    fn evaluate_planning_infers_default_rust_boundary() {
        let result = evaluate_planning(PlanningEvaluationInput {
            goal: "planner migration".to_string(),
            llm_response: None,
        });

        assert_eq!(result.api_spec.endpoints[0].path, "/api/health");
        assert!(result.active_roles.contains(&"pm".to_string()));
        assert!(result.active_roles.contains(&"verifier".to_string()));
        assert!(result.tech_stack.backend.contains(&"Rust".to_string()));
    }
}
