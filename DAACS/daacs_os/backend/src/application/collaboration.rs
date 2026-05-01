#![allow(dead_code)]

use infra_error::AppResult;
use serde_json::Value;

pub fn create_session(_project_id: &str, _shared_goal: &str) -> AppResult<String> {
    Ok(uuid::Uuid::new_v4().to_string())
}

pub fn get_session(_project_id: &str, _session_id: &str) -> AppResult<Option<Value>> {
    Ok(None)
}

pub fn add_round(_project_id: &str, _session_id: &str, _prompt: &str) -> AppResult<String> {
    Ok(uuid::Uuid::new_v4().to_string())
}
