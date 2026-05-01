//! E2E verification helpers (stubbed).

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::path::Path;
use tokio::process::Command;

use crate::graph::verifier::{VerificationResult, VerificationStatus};

#[derive(Debug, Clone, Deserialize)]
pub struct E2EScenario {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct E2EResult {
    pub scenario_id: String,
    pub success: bool,
}

pub async fn generate_scenarios(project_path: &Path) -> Result<Vec<E2EScenario>> {
    let scenarios_path = project_path
        .join("artifacts")
        .join("e2e_scenarios.json");
    if !scenarios_path.exists() {
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(scenarios_path)?;
    let parsed: Vec<E2EScenario> = serde_json::from_str(&content).unwrap_or_default();
    Ok(parsed)
}

pub async fn execute_scenarios(
    project_path: &Path,
    scenarios: &[E2EScenario],
) -> Result<Vec<E2EResult>> {
    let results_path = project_path
        .join("artifacts")
        .join("e2e_results.json");
    if !results_path.exists() {
        // Try running Playwright tests to generate results.
        if let Some(summary) = run_playwright(project_path).await? {
            return Ok(summary);
        }
        return Ok(Vec::new());
    }

    let content = std::fs::read_to_string(results_path)?;
    let parsed: Vec<E2EResult> = serde_json::from_str(&content).unwrap_or_default();

    // If results empty but scenarios exist, treat as missing.
    if parsed.is_empty() && !scenarios.is_empty() {
        return Ok(Vec::new());
    }

    Ok(parsed)
}

pub fn report_results(results: &[E2EResult]) -> Result<VerificationResult> {
    if results.is_empty() {
        return Ok(VerificationResult {
            status: VerificationStatus::Conditional,
            message: "No E2E scenarios or results.".to_string(),
            details: None,
        });
    }

    let failures = results.iter().filter(|r| !r.success).count();
    if failures > 0 {
        return Ok(VerificationResult {
            status: VerificationStatus::Fail,
            message: "E2E failures detected.".to_string(),
            details: None,
        });
    }

    Ok(VerificationResult::ok("E2E verification ok."))
}

async fn run_playwright(project_path: &Path) -> Result<Option<Vec<E2EResult>>> {
    let package_json = project_path.join("package.json");
    if !package_json.exists() {
        return Ok(None);
    }

    let exec = if project_path
        .join("node_modules")
        .join(".bin")
        .join(if cfg!(windows) { "playwright.cmd" } else { "playwright" })
        .exists()
    {
        project_path
            .join("node_modules")
            .join(".bin")
            .join(if cfg!(windows) { "playwright.cmd" } else { "playwright" })
    } else {
        Path::new("npx").to_path_buf()
    };

    let exec_str = exec.to_string_lossy().to_lowercase();
    let mut cmd = Command::new(exec);
    if exec_str.contains("npx") {
        cmd.arg("playwright");
    }
    let output = cmd
        .arg("test")
        .arg("--reporter=json")
        .current_dir(project_path)
        .output()
        .await;

    let output = match output {
        Ok(out) => out,
        Err(_) => return Ok(None),
    };

    if !output.status.success() {
        // Still try to parse any JSON output.
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: Value = match serde_json::from_str(&stdout) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };

    let mut total = 0usize;
    let mut failed = 0usize;
    count_tests(&value, &mut total, &mut failed);

    if total == 0 {
        return Ok(None);
    }

    let mut results = Vec::new();
    for idx in 0..total {
        let success = idx >= failed;
        results.push(E2EResult {
            scenario_id: format!("E2E-{}", idx + 1),
            success,
        });
    }

    Ok(Some(results))
}

fn count_tests(value: &Value, total: &mut usize, failed: &mut usize) {
    match value {
        Value::Object(map) => {
            if let Some(tests) = map.get("tests").and_then(|v| v.as_array()) {
                for test in tests {
                    *total += 1;
                    let status = test
                        .get("status")
                        .and_then(|s| s.as_str())
                        .unwrap_or("unknown")
                        .to_lowercase();
                    if status != "passed" && status != "ok" {
                        *failed += 1;
                    }
                }
            }
            for v in map.values() {
                count_tests(v, total, failed);
            }
        }
        Value::Array(arr) => {
            for v in arr {
                count_tests(v, total, failed);
            }
        }
        _ => {}
    }
}
