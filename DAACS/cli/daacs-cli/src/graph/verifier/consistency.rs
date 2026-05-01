//! Consistency verification helpers (stubbed).

use anyhow::Result;
use std::path::Path;

pub async fn check_api_consistency(project_path: &Path, daacs_path: &Path) -> Result<bool> {
    let daacs = std::fs::read_to_string(daacs_path).unwrap_or_default();
    if !daacs.to_lowercase().contains("api") {
        return Ok(true);
    }

    let openapi_json = project_path.join("openapi.json");
    let openapi_yaml = project_path.join("openapi.yaml");
    let openapi_yml = project_path.join("openapi.yml");
    let api_dir = project_path.join("api");

    Ok(openapi_json.exists() || openapi_yaml.exists() || openapi_yml.exists() || api_dir.is_dir())
}

pub async fn check_port_consistency(project_path: &Path, daacs_path: &Path) -> Result<bool> {
    let daacs = std::fs::read_to_string(daacs_path).unwrap_or_default();
    if !daacs.to_lowercase().contains("port") {
        return Ok(true);
    }

    let env_path = project_path.join(".env");
    if !env_path.exists() {
        return Ok(false);
    }

    let env = std::fs::read_to_string(env_path).unwrap_or_default();
    Ok(env.lines().any(|l| l.trim_start().starts_with("PORT=")))
}

pub async fn check_env_consistency(project_path: &Path) -> Result<bool> {
    let example = project_path.join(".env.example");
    let env = project_path.join(".env");
    if example.exists() && !env.exists() {
        return Ok(false);
    }
    Ok(true)
}
