use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeStatus {
    Idle,
    Planning,
    Working,
    WaitingApproval,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentInstance {
    pub instance_id: String,
    pub blueprint_id: String,
    pub project_id: String,
    pub runtime_status: RuntimeStatus,
    #[serde(default)]
    pub assigned_team: Option<String>,
    #[serde(default)]
    pub current_tasks: Vec<String>,
    #[serde(default)]
    pub context_window_state: serde_json::Value,
    #[serde(default)]
    pub memory_bindings: serde_json::Value,
    #[serde(default)]
    pub live_metrics: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}
