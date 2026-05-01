#![allow(dead_code)]

use infra_error::AppResult;
use serde_json::Value;

pub fn list_presets() -> AppResult<Vec<Value>> {
    Ok(vec![])
}

pub fn get_preset(_preset_id: &str) -> AppResult<Option<Value>> {
    Ok(None)
}
