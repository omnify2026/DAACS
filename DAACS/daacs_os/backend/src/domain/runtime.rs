use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Manual,
    Assisted,
    Autonomous,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CompanyRuntime {
    pub runtime_id: String,
    pub project_id: String,
    pub company_name: String,
    #[serde(default)]
    pub org_graph: serde_json::Value,
    #[serde(default)]
    pub agent_instance_ids: Vec<String>,
    #[serde(default)]
    pub meeting_protocol: serde_json::Value,
    #[serde(default)]
    pub approval_graph: serde_json::Value,
    #[serde(default)]
    pub shared_boards: serde_json::Value,
    pub execution_mode: ExecutionMode,
    #[serde(default)]
    pub owner_ops_state: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}
