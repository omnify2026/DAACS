#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;

use infra_error::{AppError, AppResult};

use super::base::AgentState;

static MANAGERS: std::sync::OnceLock<Mutex<HashMap<String, HashMap<String, AgentState>>>> =
    std::sync::OnceLock::new();

fn managers() -> AppResult<&'static Mutex<HashMap<String, HashMap<String, AgentState>>>> {
    Ok(MANAGERS.get_or_init(|| Mutex::new(HashMap::new())))
}

pub struct AgentManager;

impl AgentManager {
    pub fn get_agent_state(project_id: &str, role: &str) -> AppResult<Option<AgentState>> {
        let guard = managers()?
            .lock()
            .map_err(|e| AppError::Message(e.to_string()))?;
        let project = guard.get(project_id);
        Ok(project.and_then(|m| m.get(role).cloned()))
    }

    pub fn get_all_states(project_id: &str) -> AppResult<Vec<AgentState>> {
        let guard = managers()?
            .lock()
            .map_err(|e| AppError::Message(e.to_string()))?;
        let project = guard.get(project_id);
        Ok(project
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default())
    }

    pub fn set_agent_state(project_id: &str, role: &str, state: AgentState) -> AppResult<()> {
        let mut guard = managers()?
            .lock()
            .map_err(|e| AppError::Message(e.to_string()))?;
        guard
            .entry(project_id.to_string())
            .or_default()
            .insert(role.to_string(), state);
        Ok(())
    }
}
