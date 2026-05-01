#![allow(dead_code)]

use infra_error::AppResult;

pub fn create_sandbox(_project_id: &str) -> AppResult<String> {
    Ok(uuid::Uuid::new_v4().to_string())
}

pub fn run_command(_sandbox_id: &str, _cmd: &[&str]) -> AppResult<(i32, String)> {
    Ok((0, String::new()))
}

pub fn destroy_sandbox(_sandbox_id: &str) -> AppResult<()> {
    Ok(())
}
