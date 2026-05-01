#![allow(dead_code)]

use serde_json::json;

pub fn resolve_runtime_context(project_id: &str, role: &str) -> serde_json::Value {
    json!({
        "project_id": project_id,
        "role": role,
    })
}

pub fn is_codex_ready() -> bool {
    true
}
