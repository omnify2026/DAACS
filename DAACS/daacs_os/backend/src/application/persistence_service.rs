#![allow(dead_code)]

use infra_error::AppResult;
use serde_json::Value;

pub fn load_workflows_for_project(_project_id: &str) -> AppResult<Vec<Value>> {
    Ok(vec![])
}

pub fn load_workflow(_project_id: &str, _workflow_id: &str) -> AppResult<Option<Value>> {
    Ok(None)
}

pub fn persist_workflow_started(
    _project_id: &str,
    _workflow_id: &str,
    _workflow_name: &str,
    _goal: &str,
    _params: &Value,
) -> AppResult<()> {
    Ok(())
}
