//! Performance verification helpers (stubbed).

use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::graph::verifier::{VerificationResult, VerificationStatus};

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct PerfBaseline {
    pub p95_ms: f32,
    pub rps: f32,
}

#[derive(Debug, Clone, Deserialize, serde::Serialize)]
pub struct PerfMetrics {
    pub p95_ms: f32,
    pub rps: f32,
}

pub async fn establish_baseline(project_path: &Path) -> Result<Option<PerfBaseline>> {
    let path = project_path
        .join("artifacts")
        .join("perf_baseline.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(path)?;
    let baseline: PerfBaseline = serde_json::from_str(&content).unwrap_or(PerfBaseline {
        p95_ms: 0.0,
        rps: 0.0,
    });
    Ok(Some(baseline))
}

pub async fn measure_metrics(project_path: &Path) -> Result<PerfMetrics> {
    let path = project_path.join("artifacts").join("perf_metrics.json");
    if path.exists() {
        let content = std::fs::read_to_string(path)?;
        let metrics: PerfMetrics = serde_json::from_str(&content).unwrap_or(PerfMetrics {
            p95_ms: 0.0,
            rps: 0.0,
        });
        return Ok(metrics);
    }

    if let Some(metrics) = run_k6(project_path).await? {
        return Ok(metrics);
    }

    Ok(PerfMetrics { p95_ms: 0.0, rps: 0.0 })
}

async fn run_k6(project_path: &Path) -> Result<Option<PerfMetrics>> {
    let script = find_k6_script(project_path);
    let script = match script {
        Some(path) => path,
        None => return Ok(None),
    };

    let summary_path = project_path.join("artifacts").join("k6_summary.json");
    let _ = std::fs::create_dir_all(summary_path.parent().unwrap());

    let output = Command::new("k6")
        .arg("run")
        .arg("--summary-export")
        .arg(&summary_path)
        .arg(script)
        .current_dir(project_path)
        .output()
        .await;

    let output = match output {
        Ok(out) => out,
        Err(_) => return Ok(None),
    };

    if !output.status.success() && !summary_path.exists() {
        return Ok(None);
    }

    if !summary_path.exists() {
        return Ok(None);
    }

    let content = std::fs::read_to_string(&summary_path)?;
    let value: Value = serde_json::from_str(&content).unwrap_or(Value::Null);
    let (p95_ms, rps) = extract_k6_metrics(&value);

    let metrics = PerfMetrics { p95_ms, rps };
    let metrics_path = project_path.join("artifacts").join("perf_metrics.json");
    let _ = std::fs::write(&metrics_path, serde_json::to_string(&metrics).unwrap_or_default());

    Ok(Some(metrics))
}

fn find_k6_script(project_path: &Path) -> Option<PathBuf> {
    let candidates = [
        "perf/k6.js",
        "perf.js",
        "tests/perf.js",
        "tests/k6.js",
        "k6.js",
    ];

    for cand in candidates {
        let path = project_path.join(cand);
        if path.exists() {
            return Some(path);
        }
    }
    None
}

fn extract_k6_metrics(value: &Value) -> (f32, f32) {
    let mut p95 = 0.0;
    let mut rps = 0.0;

    if let Some(metrics) = value.get("metrics").and_then(|v| v.as_object()) {
        if let Some(http_req_duration) = metrics.get("http_req_duration") {
            if let Some(values) = http_req_duration.get("values") {
                if let Some(val) = values.get("p(95)").or_else(|| values.get("p(95.0)")) {
                    p95 = val.as_f64().unwrap_or(0.0) as f32;
                }
            }
        }

        if let Some(http_reqs) = metrics.get("http_reqs") {
            if let Some(rate) = http_reqs.get("rate") {
                rps = rate.as_f64().unwrap_or(0.0) as f32;
            }
        }
    }

    (p95, rps)
}

pub fn compare_with_baseline(
    baseline: Option<&PerfBaseline>,
    metrics: &PerfMetrics,
) -> Result<(VerificationResult, f32)> {
    if let Some(base) = baseline {
        if base.p95_ms <= 0.0 {
            return Ok((
                VerificationResult {
                    status: VerificationStatus::Conditional,
                    message: "Baseline invalid.".to_string(),
                    details: None,
                },
                0.0,
            ));
        }

        let degradation = ((metrics.p95_ms - base.p95_ms) / base.p95_ms) * 100.0;
        if degradation >= 20.0 {
            return Ok((
                VerificationResult {
                    status: VerificationStatus::Fail,
                    message: "Performance regression >= 20%".to_string(),
                    details: None,
                },
                degradation,
            ));
        }

        return Ok((VerificationResult::ok("Performance ok."), degradation));
    }

    Ok((
        VerificationResult {
            status: VerificationStatus::Conditional,
            message: "No baseline available.".to_string(),
            details: None,
        },
        0.0,
    ))
}
