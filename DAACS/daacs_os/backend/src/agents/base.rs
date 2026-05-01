#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Developer,
    Designer,
    Reviewer,
    DevOps,
    Marketer,
}

impl AgentRole {
    pub fn from_str(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "developer" => Some(AgentRole::Developer),
            "designer" => Some(AgentRole::Designer),
            "reviewer" => Some(AgentRole::Reviewer),
            "devops" => Some(AgentRole::DevOps),
            "marketer" => Some(AgentRole::Marketer),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            AgentRole::Developer => "developer",
            AgentRole::Designer => "designer",
            AgentRole::Reviewer => "reviewer",
            AgentRole::DevOps => "devops",
            AgentRole::Marketer => "marketer",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AgentState {
    pub role: String,
    pub status: String,
    pub current_task_id: Option<String>,
}
