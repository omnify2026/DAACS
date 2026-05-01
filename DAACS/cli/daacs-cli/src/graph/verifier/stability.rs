//! Stability verification helpers.

use anyhow::Result;
use serde_json::Value;
use std::path::Path;
use tokio::process::Command;

use crate::graph::verifier::{VerificationResult, VerificationStatus};

#[derive(Debug, Clone)]
pub struct RunResult {
    pub success: bool,
    pub message: String,
}

pub async fn run_multiple_times(project_path: &Path) -> Result<Vec<RunResult>> {
    let mut results = Vec::new();
    let cmd = detect_stability_command(project_path);

    if cmd.is_none() {
        return Ok(results);
    }

    let cmd = cmd.unwrap();
    for _ in 0..3 {
        let outcome = run_command(project_path, &cmd).await;
        match outcome {
            Ok(ok) => results.push(RunResult {
                success: ok,
                message: if ok { "ok".to_string() } else { "failed".to_string() },
            }),
            Err(e) => results.push(RunResult {
                success: false,
                message: format!("error: {}", e),
            }),
        }
    }

    Ok(results)
}

pub fn analyze_stability(results: &[RunResult]) -> Result<VerificationResult> {
    if results.is_empty() {
        return Ok(VerificationResult {
            status: VerificationStatus::Conditional,
            message: "No stability runs executed.".to_string(),
            details: None,
        });
    }

    let failures = results.iter().filter(|r| !r.success).count();
    if failures >= 2 {
        return Ok(VerificationResult {
            status: VerificationStatus::Fail,
            message: "Stability failures >= 2.".to_string(),
            details: None,
        });
    }
    if failures == 1 {
        return Ok(VerificationResult {
            status: VerificationStatus::Conditional,
            message: "Stability failure detected.".to_string(),
            details: None,
        });
    }

    Ok(VerificationResult::ok("Stability ok."))
}

fn detect_stability_command(project_path: &Path) -> Option<Vec<String>> {
    if let Ok(cmd) = std::env::var("DAACS_STABILITY_CMD") {
        let parts: Vec<String> = cmd.split_whitespace().map(|s| s.to_string()).collect();
        if !parts.is_empty() {
            return Some(parts);
        }
    }

    if project_path.join("Cargo.toml").exists() {
        return Some(vec!["cargo".to_string(), "test".to_string()]);
    }

    if project_path.join("package.json").exists() && npm_has_script(project_path, "test") {
        return Some(vec!["npm".to_string(), "test".to_string()]);
    }

    None
}

async fn run_command(project_path: &Path, cmd: &[String]) -> Result<bool> {
    if cmd.is_empty() {
        return Ok(false);
    }
    let output = Command::new(&cmd[0])
        .args(&cmd[1..])
        .current_dir(project_path)
        .output()
        .await;

    match output {
        Ok(out) => Ok(out.status.success()),
        Err(e) => Err(e.into()),
    }
}

fn npm_has_script(project_path: &Path, script: &str) -> bool {
    let path = project_path.join("package.json");
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let json: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
    json.get("scripts")
        .and_then(|v| v.get(script))
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}
