use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub type FileMap = BTreeMap<String, String>;

fn default_get() -> String {
    "GET".to_string()
}

fn default_true() -> bool {
    true
}

fn default_score() -> i32 {
    5
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ApiEndpoint {
    #[serde(default = "default_get")]
    pub method: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ApiSpec {
    #[serde(default)]
    pub endpoints: Vec<ApiEndpoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct TechStack {
    #[serde(default)]
    pub backend: Vec<String>,
    #[serde(default)]
    pub frontend: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PlanningTask {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub assignee: String,
    #[serde(default)]
    pub priority: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct OrchestrationPolicy {
    #[serde(default)]
    pub execution_handoffs: Vec<String>,
    #[serde(default)]
    pub quality_handoffs: Vec<String>,
    #[serde(default)]
    pub replan_handoff: Option<String>,
    #[serde(default)]
    pub allow_skip_review: bool,
    #[serde(default)]
    pub allow_skip_verification: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct PlanningEvaluationInput {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub llm_response: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningResult {
    #[serde(default)]
    pub orchestrator_plan: String,
    #[serde(default = "default_true")]
    pub needs_backend: bool,
    #[serde(default = "default_true")]
    pub needs_frontend: bool,
    #[serde(default)]
    pub api_spec: ApiSpec,
    #[serde(default)]
    pub tech_stack: TechStack,
    #[serde(default)]
    pub tasks: Vec<PlanningTask>,
    #[serde(default)]
    pub active_roles: Vec<String>,
    #[serde(default)]
    pub orchestration_policy: OrchestrationPolicy,
    #[serde(default)]
    pub qa_profile: String,
    #[serde(default)]
    pub acceptance_criteria: Vec<String>,
    #[serde(default)]
    pub evidence_required: Vec<String>,
    #[serde(default)]
    pub pending_handoffs: Vec<String>,
    #[serde(default)]
    pub logs: Vec<String>,
}

impl Default for PlanningResult {
    fn default() -> Self {
        Self {
            orchestrator_plan: String::new(),
            needs_backend: true,
            needs_frontend: true,
            api_spec: ApiSpec::default(),
            tech_stack: TechStack::default(),
            tasks: Vec::new(),
            active_roles: Vec::new(),
            orchestration_policy: OrchestrationPolicy::default(),
            qa_profile: String::new(),
            acceptance_criteria: Vec::new(),
            evidence_required: Vec::new(),
            pending_handoffs: Vec::new(),
            logs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct VerificationCommandResult {
    #[serde(default)]
    pub check: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationRequest {
    #[serde(default)]
    pub backend_files: FileMap,
    #[serde(default)]
    pub frontend_files: FileMap,
    #[serde(default)]
    pub api_spec: ApiSpec,
    #[serde(default = "default_true")]
    pub needs_backend: bool,
    #[serde(default = "default_true")]
    pub needs_frontend: bool,
    #[serde(default)]
    pub qa_profile: String,
    #[serde(default)]
    pub evidence_required: Vec<String>,
    #[serde(default)]
    pub command_results: Vec<VerificationCommandResult>,
}

impl Default for VerificationRequest {
    fn default() -> Self {
        Self {
            backend_files: FileMap::new(),
            frontend_files: FileMap::new(),
            api_spec: ApiSpec::default(),
            needs_backend: true,
            needs_frontend: true,
            qa_profile: String::new(),
            evidence_required: Vec::new(),
            command_results: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct VerificationDetail {
    #[serde(default)]
    pub template: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub count: Option<usize>,
    #[serde(default)]
    pub total_endpoints: Option<usize>,
    #[serde(default)]
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct VerificationEvidence {
    #[serde(default)]
    pub check: String,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub count: Option<usize>,
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct VerificationResult {
    #[serde(default)]
    pub verification_passed: bool,
    #[serde(default)]
    pub verification_details: Vec<VerificationDetail>,
    #[serde(default)]
    pub verification_evidence: Vec<VerificationEvidence>,
    #[serde(default)]
    pub verification_gaps: Vec<String>,
    #[serde(default)]
    pub verification_confidence: i32,
    #[serde(default)]
    pub verification_failures: Vec<String>,
    #[serde(default)]
    pub rework_source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ReviewIssue {
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub suggestion: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReviewData {
    #[serde(default = "default_score")]
    pub score: i32,
    #[serde(default)]
    pub passed: bool,
    #[serde(default)]
    pub issues: Vec<ReviewIssue>,
    #[serde(default = "default_true")]
    pub goal_achieved: bool,
    #[serde(default)]
    pub goal_reason: String,
    #[serde(default)]
    pub missing_features: Vec<String>,
    #[serde(default)]
    pub compatibility_issues: Vec<String>,
}

impl Default for ReviewData {
    fn default() -> Self {
        Self {
            score: default_score(),
            passed: false,
            issues: Vec::new(),
            goal_achieved: true,
            goal_reason: String::new(),
            missing_features: Vec::new(),
            compatibility_issues: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct JudgmentRequest {
    #[serde(default)]
    pub goal: String,
    #[serde(default)]
    pub api_spec: ApiSpec,
    #[serde(default)]
    pub backend_files: FileMap,
    #[serde(default)]
    pub frontend_files: FileMap,
    #[serde(default = "default_true")]
    pub needs_backend: bool,
    #[serde(default = "default_true")]
    pub needs_frontend: bool,
    #[serde(default)]
    pub review_response: Option<String>,
    #[serde(default)]
    pub review_data: Option<ReviewData>,
    #[serde(default)]
    pub min_score: Option<i32>,
}

impl Default for JudgmentRequest {
    fn default() -> Self {
        Self {
            goal: String::new(),
            api_spec: ApiSpec::default(),
            backend_files: FileMap::new(),
            frontend_files: FileMap::new(),
            needs_backend: true,
            needs_frontend: true,
            review_response: None,
            review_data: None,
            min_score: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct JudgmentResult {
    #[serde(default)]
    pub needs_rework: bool,
    #[serde(default)]
    pub code_review: ReviewData,
    #[serde(default)]
    pub code_review_score: i32,
    #[serde(default)]
    pub code_review_passed: bool,
    #[serde(default)]
    pub consistency_passed: bool,
    #[serde(default)]
    pub consistency_issues: Vec<String>,
    #[serde(default)]
    pub failure_summary: Vec<String>,
    #[serde(default)]
    pub rework_source: Option<String>,
}
