#![allow(dead_code)]

use infra_error::AppResult;

pub fn embed(_text: &str) -> AppResult<Vec<f32>> {
    Ok(vec![])
}

pub fn search_similar(
    _project_id: &str,
    _query_embedding: &[f32],
    _k: usize,
) -> AppResult<Vec<String>> {
    Ok(vec![])
}
