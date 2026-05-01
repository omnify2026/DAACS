#![allow(dead_code)]

use infra_error::AppResult;

pub fn list_worktree(_project_id: &str, _root: &str) -> AppResult<Vec<serde_json::Value>> {
    Ok(vec![])
}

pub fn read_file(_project_id: &str, _path: &str) -> AppResult<Option<String>> {
    Ok(None)
}
