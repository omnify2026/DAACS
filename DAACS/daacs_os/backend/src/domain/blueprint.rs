use serde::{Deserialize, Serialize};

use crate::domain::ui_profile::UiProfile;

fn default_json_object() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentBlueprint {
    pub id: String,
    pub name: String,
    pub role_label: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub prompt_bundle_ref: Option<String>,
    #[serde(default)]
    pub skill_bundle_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub tool_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub permission_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub memory_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub collaboration_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub approval_policy: serde_json::Value,
    #[serde(default)]
    pub ui_profile: UiProfile,
    #[serde(default)]
    pub is_builtin: bool,
    pub owner_user_id: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlueprintInput {
    pub name: String,
    pub role_label: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub prompt_bundle_ref: Option<String>,
    #[serde(default)]
    pub skill_bundle_refs: Vec<String>,
    #[serde(default = "default_json_object")]
    pub tool_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub permission_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub memory_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub collaboration_policy: serde_json::Value,
    #[serde(default = "default_json_object")]
    pub approval_policy: serde_json::Value,
    #[serde(default)]
    pub ui_profile: UiProfile,
}
