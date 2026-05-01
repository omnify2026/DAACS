use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Draft,
    Active,
    Paused,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Pending,
    Blocked,
    InProgress,
    AwaitingApproval,
    Approved,
    Completed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionStep {
    pub step_id: String,
    pub label: String,
    pub description: String,
    #[serde(default)]
    pub assigned_to: Option<String>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub approval_required_by: Option<String>,
    pub status: StepStatus,
    #[serde(default)]
    pub required_capabilities: Vec<String>,
    #[serde(default)]
    pub selection_reason: Option<String>,
    #[serde(default)]
    pub approval_reason: Option<String>,
    #[serde(default)]
    pub planner_notes: Option<String>,
    #[serde(default)]
    pub parallel_group: Option<String>,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default)]
    pub output: serde_json::Value,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionPlan {
    pub plan_id: String,
    pub runtime_id: String,
    #[serde(default = "default_workflow_name")]
    pub workflow_name: String,
    pub goal: String,
    pub created_by: String,
    #[serde(default)]
    pub planner_version: String,
    #[serde(default)]
    pub planning_mode: String,
    #[serde(default)]
    pub plan_rationale: String,
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub steps: Vec<ExecutionStep>,
    pub status: PlanStatus,
    pub created_at: String,
    pub updated_at: String,
}

fn default_workflow_name() -> String {
    "feature_development".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionIntentKind {
    OpenPullRequest,
    DeployRelease,
    PublishContent,
    LaunchCampaign,
    PublishAsset,
    RunOpsAction,
    SubmitBudgetUpdate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionIntentStatus {
    Draft,
    PendingApproval,
    Approved,
    Rejected,
    Executing,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutionIntent {
    pub intent_id: String,
    pub project_id: String,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    pub agent_id: String,
    pub agent_role: String,
    pub kind: ExecutionIntentKind,
    pub title: String,
    pub description: String,
    pub target: String,
    pub connector_id: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default)]
    pub result_payload: Option<serde_json::Value>,
    pub status: ExecutionIntentStatus,
    #[serde(default = "default_requires_approval")]
    pub requires_approval: bool,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub approved_at: Option<String>,
    #[serde(default)]
    pub resolved_at: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub result_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewExecutionIntent {
    pub project_id: String,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub created_by: Option<String>,
    pub agent_id: String,
    pub agent_role: String,
    pub kind: ExecutionIntentKind,
    pub title: String,
    pub description: String,
    pub target: String,
    pub connector_id: String,
    #[serde(default)]
    pub payload: serde_json::Value,
    #[serde(default = "default_requires_approval")]
    pub requires_approval: bool,
}

fn default_requires_approval() -> bool {
    true
}
