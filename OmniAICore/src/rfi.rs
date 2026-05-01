use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::recover_json;

const RFI_TOPICS: [RfiTopic; 11] = [
    RfiTopic::Platform,
    RfiTopic::Frontend,
    RfiTopic::Backend,
    RfiTopic::Database,
    RfiTopic::Auth,
    RfiTopic::Ui,
    RfiTopic::Users,
    RfiTopic::Deployment,
    RfiTopic::Integrations,
    RfiTopic::Constraints,
    RfiTopic::AcceptanceCriteria,
];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "snake_case")]
pub enum RfiTopic {
    Platform,
    Frontend,
    Backend,
    Database,
    Auth,
    Ui,
    Users,
    Deployment,
    Integrations,
    Constraints,
    AcceptanceCriteria,
    #[default]
    #[serde(other)]
    Unknown,
}

impl RfiTopic {
    fn as_str(self) -> &'static str {
        match self {
            Self::Platform => "platform",
            Self::Frontend => "frontend",
            Self::Backend => "backend",
            Self::Database => "database",
            Self::Auth => "auth",
            Self::Ui => "ui",
            Self::Users => "users",
            Self::Deployment => "deployment",
            Self::Integrations => "integrations",
            Self::Constraints => "constraints",
            Self::AcceptanceCriteria => "acceptance_criteria",
            Self::Unknown => "constraints",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RfiQuestion {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub topic: RfiTopic,
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RfiKnownAnswer {
    pub topic: RfiTopic,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RfiRequest {
    pub goal: String,
    pub workspace_files: Vec<String>,
    pub known_answers: Vec<RfiKnownAnswer>,
    pub prior_summary: Option<String>,
    pub max_questions: usize,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RfiStatus {
    NeedsClarification,
    ReadyToPlan,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum RfiQuestionLevel {
    L0,
    L1,
    L2,
    #[default]
    L3,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct RfiExecutionContract {
    #[serde(default)]
    pub request_type: String,
    #[serde(default)]
    pub artifact_type: String,
    #[serde(default)]
    pub delivery_tier: String,
    #[serde(default)]
    pub user_language: String,
    #[serde(default)]
    pub primary_goal: String,
    #[serde(default)]
    pub input_requirements: Vec<String>,
    #[serde(default)]
    pub output_requirements: Vec<String>,
    #[serde(default)]
    pub success_criteria: Vec<String>,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub role_hints: Vec<String>,
    #[serde(default)]
    pub domain_signals: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RfiOutcome {
    pub status: RfiStatus,
    pub refined_goal: String,
    pub summary: String,
    #[serde(default)]
    pub question_level: RfiQuestionLevel,
    pub missing_topics: Vec<RfiTopic>,
    pub questions: Vec<RfiQuestion>,
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub execution_contract: RfiExecutionContract,
    pub ready_to_plan: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct PartialRfiOutcome {
    status: Option<RfiStatus>,
    refined_goal: Option<String>,
    summary: Option<String>,
    question_level: Option<RfiQuestionLevel>,
    missing_topics: Option<Vec<RfiTopic>>,
    questions: Option<Vec<RfiQuestion>>,
    assumptions: Option<Vec<String>>,
    execution_contract: Option<RfiExecutionContract>,
    ready_to_plan: Option<bool>,
}

pub fn rfi_system_prompt() -> &'static str {
    r#"You are the DAACS RFI agent.

You perform a single-pass requirements clarification gate before planning.

Rules:
- Return STRICT JSON only.
- Do not wrap the JSON in prose.
- Ask at most the provided max_questions count.
- Use only these topic values:
  platform, frontend, backend, database, auth, ui, users, deployment, integrations, constraints, acceptance_criteria
- If the goal is clear enough to plan, set status to "ready_to_plan" and ready_to_plan to true.
- If clarification is still required, set status to "needs_clarification" and ready_to_plan to false.
- refined_goal must be EXTREMELY concise (under 100 chars), preserving intent without restating context.
- summary must be EXTREMELY concise and factual (under 100 chars).
- Do not repeat the entire user input; just extract the core objective.
- Think in two layers:
  1) user-facing clarification language must be simple and non-technical
  2) internal execution_contract must be precise enough for PM handoff
- question_level means:
  - l0: no follow-up needed, execute immediately
  - l1: one small confirmation is enough
  - l2: several important product/quality clarifications are missing
  - l3: the request is too abstract; PM would guess without stronger clarification
- Prefer request-structure reasoning over hard-coded domains.
- Questions must be easy for a non-technical user to answer.
- Avoid jargon such as ontology, architecture, schema, stack, classifier, taxonomy unless the user already uses them.
- questions must be empty when ready_to_plan is true.

Return JSON with this exact shape:
{
  "status": "needs_clarification | ready_to_plan",
  "refined_goal": "string",
  "summary": "string",
  "question_level": "l0 | l1 | l2 | l3",
  "missing_topics": ["platform", "frontend", "backend", "database", "auth", "ui", "users", "deployment", "integrations", "constraints", "acceptance_criteria"],
  "questions": [
    {
      "id": "string",
      "topic": "platform",
      "question": "string",
      "reason": "string",
      "required": true
    }
  ],
  "assumptions": ["string"],
  "execution_contract": {
    "request_type": "string",
    "artifact_type": "string",
    "delivery_tier": "string",
    "user_language": "string",
    "primary_goal": "string",
    "input_requirements": ["string"],
    "output_requirements": ["string"],
    "success_criteria": ["string"],
    "constraints": ["string"],
    "role_hints": ["string"],
    "domain_signals": ["string"]
  },
  "ready_to_plan": true
}"#
}

pub fn build_rfi_user_prompt(request: &RfiRequest) -> String {
    let goal = sanitize_multiline(&request.goal);
    let prior_summary = request
        .prior_summary
        .as_deref()
        .map(sanitize_multiline)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "(none)".to_string());
    let workspace_files = format_string_list(&request.workspace_files, "(none)");
    let known_answers = format_known_answers(&request.known_answers);
    let max_questions = request.max_questions.max(1);
    let topics = RFI_TOPICS
        .iter()
        .map(|topic| format!("- {}", topic.as_str()))
        .collect::<Vec<_>>()
        .join("\n");

    format!(
        "RFI request for DAACS.\n\n\
Goal:\n{goal}\n\n\
Prior summary:\n{prior_summary}\n\n\
Known answers:\n{known_answers}\n\n\
Workspace files:\n{workspace_files}\n\n\
Maximum clarification questions: {max_questions}\n\n\
Allowed topics:\n{topics}\n\n\
Interpret the request by structure first, not by a fixed domain catalog.\n\
Infer a question_level (l0-l3) and a precise execution_contract for PM handoff.\n\
If you ask questions, make them simple for a non-technical user to answer.\n\n\
Return strict JSON only."
    )
}

pub fn parse_rfi_outcome(raw: &str) -> Result<RfiOutcome, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("rfi output is empty".to_string());
    }

    if let Ok(outcome) = serde_json::from_str::<RfiOutcome>(trimmed) {
        return Ok(normalize_outcome(outcome));
    }

    let recovered =
        recover_json(trimmed).ok_or_else(|| "unable to recover rfi json".to_string())?;
    let candidate = extract_rfi_candidate(&recovered);

    if let Ok(outcome) = serde_json::from_value::<RfiOutcome>(candidate.clone()) {
        return Ok(normalize_outcome(outcome));
    }

    let partial: PartialRfiOutcome = serde_json::from_value(candidate)
        .map_err(|error| format!("invalid rfi payload: {error}"))?;

    partial
        .into_outcome()
        .map(normalize_outcome)
        .ok_or_else(|| "recovered rfi payload was incomplete".to_string())
}

pub fn fallback_rfi_outcome(goal: &str, raw: &str, error: &str) -> RfiOutcome {
    let trimmed_goal = sanitize_multiline(goal);
    let preview = sanitize_multiline(raw)
        .chars()
        .take(160)
        .collect::<String>();
    let summary = if preview.is_empty() {
        format!("RFI could not parse the model output. Error: {error}")
    } else {
        format!("RFI parse error: {error} | Raw preview: {}", preview)
    };

    RfiOutcome {
        status: RfiStatus::NeedsClarification,
        refined_goal: if trimmed_goal.is_empty() {
            "Clarify the project goal before planning.".to_string()
        } else {
            trimmed_goal.clone()
        },
        summary,
        question_level: RfiQuestionLevel::L3,
        missing_topics: RFI_TOPICS.to_vec(),
        questions: vec![RfiQuestion {
            id: "clarify-goal-baseline".to_string(),
            topic: RfiTopic::Constraints,
            question:
                "어떤 결과물을 원하시는지, 어디서 사용할지, 어느 정도 완성도를 원하는지 알려주세요."
                    .to_string(),
            reason:
                "The RFI output was invalid, so the baseline project constraints are still unclear."
                    .to_string(),
            required: true,
        }],
        assumptions: vec![
            "The original goal was preserved because the RFI output was invalid.".to_string(),
        ],
        execution_contract: RfiExecutionContract {
            request_type: "unknown_request".to_string(),
            artifact_type: "unspecified_artifact".to_string(),
            delivery_tier: "unspecified".to_string(),
            user_language: "ko".to_string(),
            primary_goal: if goal.trim().is_empty() {
                "Clarify the requested outcome".to_string()
            } else {
                trimmed_goal.clone()
            },
            input_requirements: vec![
                "Requested artifact shape is unclear".to_string(),
                "Target platform is unclear".to_string(),
            ],
            output_requirements: vec!["A PM-ready execution contract is still missing".to_string()],
            success_criteria: vec!["Clarify outcome, platform, and quality bar".to_string()],
            constraints: vec![],
            role_hints: vec!["pm".to_string()],
            domain_signals: vec![],
        },
        ready_to_plan: false,
    }
}

impl PartialRfiOutcome {
    fn into_outcome(self) -> Option<RfiOutcome> {
        let ready_to_plan = self
            .ready_to_plan
            .unwrap_or(matches!(self.status, Some(RfiStatus::ReadyToPlan)));
        let status = if ready_to_plan {
            RfiStatus::ReadyToPlan
        } else {
            self.status.unwrap_or(RfiStatus::NeedsClarification)
        };

        // Make defaults more robust to prevent 'parse error' when strings are empty
        let refined_goal = self.refined_goal.unwrap_or_default();
        let summary = self.summary.unwrap_or_default();

        Some(RfiOutcome {
            status,
            refined_goal,
            summary,
            question_level: self.question_level.unwrap_or_default(),
            missing_topics: self.missing_topics.unwrap_or_default(),
            questions: self.questions.unwrap_or_default(),
            assumptions: self.assumptions.unwrap_or_default(),
            execution_contract: self.execution_contract.unwrap_or_default(),
            ready_to_plan,
        })
    }
}

fn extract_rfi_candidate(value: &Value) -> Value {
    if looks_like_rfi_object(value) {
        return value.clone();
    }

    for key in ["rfi", "result", "output", "data", "payload"] {
        if let Some(inner) = value.get(key) {
            if looks_like_rfi_object(inner) {
                return inner.clone();
            }
        }
    }

    value.clone()
}

fn looks_like_rfi_object(value: &Value) -> bool {
    value.get("status").is_some()
        || value.get("refined_goal").is_some()
        || value.get("summary").is_some()
        || value.get("questions").is_some()
        || value.get("ready_to_plan").is_some()
}

fn normalize_outcome(mut outcome: RfiOutcome) -> RfiOutcome {
    outcome.refined_goal = sanitize_multiline(&outcome.refined_goal);
    outcome.summary = sanitize_multiline(&outcome.summary);
    outcome.assumptions = normalize_string_list(outcome.assumptions);
    outcome.missing_topics = normalize_topics(outcome.missing_topics);
    outcome.questions = normalize_questions(outcome.questions);
    outcome.execution_contract = normalize_execution_contract(outcome.execution_contract);

    if outcome.summary.is_empty() {
        outcome.summary = if outcome.ready_to_plan {
            "RFI determined the goal is ready for planning.".to_string()
        } else {
            "RFI requires clarification before planning.".to_string()
        };
    }

    if outcome.refined_goal.is_empty() {
        outcome.refined_goal = outcome.summary.clone();
    }

    if outcome.execution_contract.primary_goal.is_empty() {
        outcome.execution_contract.primary_goal = outcome.refined_goal.clone();
    }

    if outcome.execution_contract.user_language.is_empty() {
        outcome.execution_contract.user_language = "ko".to_string();
    }

    if matches!(outcome.status, RfiStatus::ReadyToPlan) || outcome.ready_to_plan {
        outcome.status = RfiStatus::ReadyToPlan;
        outcome.ready_to_plan = true;
        outcome.questions.clear();
        outcome.missing_topics.clear();
    } else {
        outcome.status = RfiStatus::NeedsClarification;
        outcome.ready_to_plan = false;
    }

    outcome
}

fn normalize_execution_contract(mut contract: RfiExecutionContract) -> RfiExecutionContract {
    contract.request_type = sanitize_multiline(&contract.request_type);
    contract.artifact_type = sanitize_multiline(&contract.artifact_type);
    contract.delivery_tier = sanitize_multiline(&contract.delivery_tier);
    contract.user_language = sanitize_multiline(&contract.user_language);
    contract.primary_goal = sanitize_multiline(&contract.primary_goal);
    contract.input_requirements = normalize_string_list(contract.input_requirements);
    contract.output_requirements = normalize_string_list(contract.output_requirements);
    contract.success_criteria = normalize_string_list(contract.success_criteria);
    contract.constraints = normalize_string_list(contract.constraints);
    contract.role_hints = normalize_string_list(contract.role_hints);
    contract.domain_signals = normalize_string_list(contract.domain_signals);
    contract
}

fn normalize_topics(topics: Vec<RfiTopic>) -> Vec<RfiTopic> {
    let mut out = Vec::new();
    for topic in topics {
        if !out.contains(&topic) {
            out.push(topic);
        }
    }
    out
}

fn normalize_questions(questions: Vec<RfiQuestion>) -> Vec<RfiQuestion> {
    questions
        .into_iter()
        .filter_map(|question| {
            let id = sanitize_multiline(&question.id);
            let prompt = sanitize_multiline(&question.question);
            let reason = sanitize_multiline(&question.reason);
            if id.is_empty() || prompt.is_empty() {
                return None;
            }
            Some(RfiQuestion {
                id,
                topic: question.topic,
                question: prompt,
                reason,
                required: question.required,
            })
        })
        .collect()
}

fn normalize_string_list(items: Vec<String>) -> Vec<String> {
    items
        .into_iter()
        .map(|item| sanitize_multiline(&item))
        .filter(|item| !item.is_empty())
        .collect()
}

fn format_known_answers(items: &[RfiKnownAnswer]) -> String {
    if items.is_empty() {
        return "(none)".to_string();
    }

    items
        .iter()
        .map(|item| {
            format!(
                "- {}: {}",
                item.topic.as_str(),
                sanitize_multiline(&item.value)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn format_string_list(items: &[String], empty_label: &str) -> String {
    if items.is_empty() {
        return empty_label.to_string();
    }

    items
        .iter()
        .map(|item| format!("- {}", sanitize_multiline(item)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn sanitize_multiline(input: &str) -> String {
    input
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_valid_json_rfi_output() {
        let raw = r#"{
            "status": "ready_to_plan",
            "refined_goal": "Build a multi-tenant dashboard",
            "summary": "The goal is specific enough to plan.",
            "question_level": "l1",
            "missing_topics": [],
            "questions": [],
            "assumptions": ["Use existing auth"],
            "execution_contract": {
                "request_type": "software_build",
                "artifact_type": "dashboard",
                "delivery_tier": "polished_demo",
                "user_language": "en",
                "primary_goal": "Build a multi-tenant dashboard",
                "input_requirements": ["Existing auth"],
                "output_requirements": ["Working dashboard"],
                "success_criteria": ["Tenant switching works"],
                "constraints": [],
                "role_hints": ["pm", "frontend", "backend", "reviewer", "verifier"],
                "domain_signals": ["dashboard", "multi-tenant"]
            },
            "ready_to_plan": true
        }"#;

        let parsed = parse_rfi_outcome(raw).expect("valid json should parse");

        assert_eq!(parsed.status, RfiStatus::ReadyToPlan);
        assert!(parsed.ready_to_plan);
        assert!(parsed.questions.is_empty());
        assert_eq!(parsed.refined_goal, "Build a multi-tenant dashboard");
        assert_eq!(parsed.question_level, RfiQuestionLevel::L1);
        assert_eq!(parsed.execution_contract.request_type, "software_build");
    }

    #[test]
    fn parses_fenced_json_rfi_output() {
        let raw = r#"```json
        {
          "status": "needs_clarification",
          "refined_goal": "Build a dashboard",
          "summary": "Clarify tenant model first.",
          "question_level": "l2",
          "missing_topics": ["users", "auth"],
          "questions": [
            {
              "id": "tenant-users",
              "topic": "users",
              "question": "Who will use the dashboard?",
              "reason": "The user groups are not explicit.",
              "required": true
            }
          ],
          "assumptions": [],
          "execution_contract": {
            "request_type": "software_build",
            "artifact_type": "dashboard",
            "delivery_tier": "unspecified",
            "user_language": "en",
            "primary_goal": "Build a dashboard",
            "input_requirements": ["Clarify who uses it"],
            "output_requirements": [],
            "success_criteria": [],
            "constraints": [],
            "role_hints": ["pm"],
            "domain_signals": ["dashboard"]
          },
          "ready_to_plan": false
        }
        ```"#;

        let parsed = parse_rfi_outcome(raw).expect("fenced json should parse");

        assert_eq!(parsed.status, RfiStatus::NeedsClarification);
        assert!(!parsed.ready_to_plan);
        assert_eq!(parsed.questions.len(), 1);
        assert_eq!(parsed.missing_topics, vec![RfiTopic::Users, RfiTopic::Auth]);
        assert_eq!(parsed.question_level, RfiQuestionLevel::L2);
    }

    #[test]
    fn recovers_malformed_json_rfi_output() {
        let raw = r#"analysis {status:"ready_to_plan",refined_goal:"Ship the release",summary:"Enough detail is present",question_level:"l0",missing_topics:[],questions:[],assumptions:["Existing API remains"],execution_contract:{request_type:"delivery_request",artifact_type:"release",delivery_tier:"production_oriented",user_language:"en",primary_goal:"Ship the release",input_requirements:["Existing API remains"],output_requirements:["Release package"],success_criteria:["Release ships"],constraints:[],role_hints:["pm","reviewer","verifier"],domain_signals:["release"]},ready_to_plan:true,}"#;

        let parsed = parse_rfi_outcome(raw).expect("recoverable json should parse");

        assert_eq!(parsed.status, RfiStatus::ReadyToPlan);
        assert_eq!(parsed.summary, "Enough detail is present");
        assert_eq!(parsed.assumptions, vec!["Existing API remains"]);
        assert_eq!(parsed.question_level, RfiQuestionLevel::L0);
    }

    #[test]
    fn fallback_handles_empty_or_garbage_output() {
        assert!(parse_rfi_outcome("not-json").is_err());

        let fallback = fallback_rfi_outcome("Build an AI office", "not-json", "invalid_json");

        assert_eq!(fallback.status, RfiStatus::NeedsClarification);
        assert!(!fallback.ready_to_plan);
        assert!(!fallback.questions.is_empty());
        assert_eq!(fallback.refined_goal, "Build an AI office");
    }

    #[test]
    fn build_prompt_includes_goal_context_and_limits() {
        let prompt = build_rfi_user_prompt(&RfiRequest {
            goal: "Build a review workflow".to_string(),
            workspace_files: vec!["src/main.ts".to_string(), "README.md".to_string()],
            known_answers: vec![RfiKnownAnswer {
                topic: RfiTopic::Platform,
                value: "desktop + web".to_string(),
            }],
            prior_summary: Some("The project already has auth.".to_string()),
            max_questions: 3,
        });

        assert!(prompt.contains("Build a review workflow"));
        assert!(prompt.contains("desktop + web"));
        assert!(prompt.contains("src/main.ts"));
        assert!(prompt.contains("The project already has auth."));
        assert!(prompt.contains("Maximum clarification questions: 3"));
    }
}
