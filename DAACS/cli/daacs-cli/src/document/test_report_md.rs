//! TEST_REPORT.md generation and parsing helpers.

use anyhow::{Context, Result};
use chrono::Local;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::agents::devops::DevOpsResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Default)]
pub enum Status {
    Ok,
    Fail,
    Conditional,
    Skip,
    #[default]
    Unknown,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::Fail => "fail",
            Status::Conditional => "conditional",
            Status::Skip => "skip",
            Status::Unknown => "unknown",
        }
    }

    fn from_str(value: &str) -> Status {
        match value.trim().to_lowercase().as_str() {
            "ok" | "pass" => Status::Ok,
            "fail" => Status::Fail,
            "conditional" => Status::Conditional,
            "skip" => Status::Skip,
            _ => Status::Unknown,
        }
    }
}


#[derive(Debug, Clone, Default)]
pub struct TestReportData {
    pub runtime_backend: Status,
    pub runtime_frontend: Status,
    pub consistency_status: Status,
    pub visual_screenshot_count: u32,
    pub visual_console_error_count: u32,
    pub e2e_scenario_count: u32,
    pub e2e_fail_count: u32,
    pub perf_baseline_exists: bool,
    pub perf_degradation_percent: f32,
    pub stability_runs: u32,
    pub stability_fail_count: u32,
}

pub async fn generate_test_report_md(
    path: &Path,
    project_name: &str,
    devops: &DevOpsResult,
) -> Result<TestReportData> {
    let template = load_template("TEST_REPORT.md").await?;
    let now = Local::now();

    let runtime_status = if devops.success {
        Status::Ok
    } else {
        Status::Fail
    };

    let data = TestReportData {
        runtime_backend: runtime_status,
        runtime_frontend: runtime_status,
        consistency_status: Status::Skip,
        visual_screenshot_count: 0,
        visual_console_error_count: 0,
        e2e_scenario_count: 0,
        e2e_fail_count: 0,
        perf_baseline_exists: false,
        perf_degradation_percent: 0.0,
        stability_runs: 0,
        stability_fail_count: 0,
    };

    let overall_status = if runtime_status == Status::Ok {
        Status::Conditional
    } else {
        Status::Fail
    };

    let mut content = template;
    content = content.replace("{{DATE}}", &now.format("%Y-%m-%d").to_string());
    content = content.replace("{{PROJECT_NAME}}", project_name);
    content = content.replace("{{RUNTIME_STATUS}}", runtime_status.as_str());
    content = content.replace("{{VISUAL_STATUS}}", Status::Skip.as_str());
    content = content.replace("{{E2E_STATUS}}", Status::Skip.as_str());
    content = content.replace("{{PERF_STATUS}}", Status::Skip.as_str());
    content = content.replace("{{STABILITY_STATUS}}", Status::Skip.as_str());
    content = content.replace("{{OVERALL_STATUS}}", overall_status.as_str());

    content = content.replace("{{ERROR_LOG}}", &devops.summary);
    content = content.replace("{{TIMESTAMP}}", &now.to_rfc3339());
    content = content.replace("{{OS}}", std::env::consts::OS);
    content = content.replace("{{NODE_VERSION}}", "unknown");
    content = content.replace("{{PYTHON_VERSION}}", "unknown");

    content.push_str("\n\n```yaml\ntest_metrics:\n");
    content.push_str(&format!(
        "  runtime_backend: {}\n",
        data.runtime_backend.as_str()
    ));
    content.push_str(&format!(
        "  runtime_frontend: {}\n",
        data.runtime_frontend.as_str()
    ));
    content.push_str(&format!(
        "  consistency_status: {}\n",
        data.consistency_status.as_str()
    ));
    content.push_str(&format!(
        "  visual_screenshot_count: {}\n",
        data.visual_screenshot_count
    ));
    content.push_str(&format!(
        "  visual_console_error_count: {}\n",
        data.visual_console_error_count
    ));
    content.push_str(&format!("  e2e_scenario_count: {}\n", data.e2e_scenario_count));
    content.push_str(&format!("  e2e_fail_count: {}\n", data.e2e_fail_count));
    content.push_str(&format!(
        "  perf_baseline_exists: {}\n",
        data.perf_baseline_exists
    ));
    content.push_str(&format!(
        "  perf_degradation_percent: {:.1}\n",
        data.perf_degradation_percent
    ));
    content.push_str(&format!("  stability_runs: {}\n", data.stability_runs));
    content.push_str(&format!(
        "  stability_fail_count: {}\n",
        data.stability_fail_count
    ));
    content.push_str("```\n");

    fs::write(path, content).await?;
    Ok(data)
}

pub async fn parse_test_report_md(path: &Path) -> Result<TestReportData> {
    let content = fs::read_to_string(path)
        .await
        .with_context(|| format!("파일 읽기 실패: {}", path.display()))?;

    if let Some(data) = parse_test_metrics_yaml(&content) {
        return Ok(data);
    }

    Ok(TestReportData::default())
}

pub async fn update_test_metrics<F>(path: &Path, updater: F) -> Result<TestReportData>
where
    F: FnOnce(&mut TestReportData),
{
    let content = fs::read_to_string(path).await.unwrap_or_else(|_| {
        String::from("# 테스트 보고서\n\n(템플릿 없이 생성된 파일입니다.)\n")
    });

    let mut data = parse_test_metrics_yaml(&content).unwrap_or_default();
    updater(&mut data);

    let updated = upsert_test_metrics_block(&content, &data);
    fs::write(path, updated).await?;

    Ok(data)
}

fn parse_test_metrics_yaml(content: &str) -> Option<TestReportData> {
    let mut in_metrics = false;
    let mut data = TestReportData::default();

    for line in content.lines() {
        if line.trim() == "test_metrics:" {
            in_metrics = true;
            continue;
        }
        if in_metrics {
            if line.trim_start().starts_with("```") {
                break;
            }
            let trimmed = line.trim();
            if let Some((key, value)) = trimmed.split_once(':') {
                let key = key.trim();
                let value = value.trim();
                match key {
                    "runtime_backend" => data.runtime_backend = Status::from_str(value),
                    "runtime_frontend" => data.runtime_frontend = Status::from_str(value),
                    "consistency_status" => data.consistency_status = Status::from_str(value),
                    "visual_screenshot_count" => {
                        data.visual_screenshot_count = value.parse().unwrap_or(0)
                    }
                    "visual_console_error_count" => {
                        data.visual_console_error_count = value.parse().unwrap_or(0)
                    }
                    "e2e_scenario_count" => data.e2e_scenario_count = value.parse().unwrap_or(0),
                    "e2e_fail_count" => data.e2e_fail_count = value.parse().unwrap_or(0),
                    "perf_baseline_exists" => {
                        data.perf_baseline_exists = value.parse().unwrap_or(false)
                    }
                    "perf_degradation_percent" => {
                        data.perf_degradation_percent = value.parse().unwrap_or(0.0)
                    }
                    "stability_runs" => data.stability_runs = value.parse().unwrap_or(0),
                    "stability_fail_count" => data.stability_fail_count = value.parse().unwrap_or(0),
                    _ => {}
                }
            }
        }
    }

    if in_metrics {
        Some(data)
    } else {
        None
    }
}

fn upsert_test_metrics_block(content: &str, data: &TestReportData) -> String {
    let stripped = remove_yaml_block(content, "test_metrics:");
    let mut output = stripped.trim_end().to_string();
    output.push_str("\n\n```yaml\ntest_metrics:\n");
    output.push_str(&format!(
        "  runtime_backend: {}\n",
        data.runtime_backend.as_str()
    ));
    output.push_str(&format!(
        "  runtime_frontend: {}\n",
        data.runtime_frontend.as_str()
    ));
    output.push_str(&format!(
        "  consistency_status: {}\n",
        data.consistency_status.as_str()
    ));
    output.push_str(&format!(
        "  visual_screenshot_count: {}\n",
        data.visual_screenshot_count
    ));
    output.push_str(&format!(
        "  visual_console_error_count: {}\n",
        data.visual_console_error_count
    ));
    output.push_str(&format!("  e2e_scenario_count: {}\n", data.e2e_scenario_count));
    output.push_str(&format!("  e2e_fail_count: {}\n", data.e2e_fail_count));
    output.push_str(&format!(
        "  perf_baseline_exists: {}\n",
        data.perf_baseline_exists
    ));
    output.push_str(&format!(
        "  perf_degradation_percent: {:.1}\n",
        data.perf_degradation_percent
    ));
    output.push_str(&format!("  stability_runs: {}\n", data.stability_runs));
    output.push_str(&format!(
        "  stability_fail_count: {}\n",
        data.stability_fail_count
    ));
    output.push_str("```\n");
    output
}

fn remove_yaml_block(content: &str, marker: &str) -> String {
    let mut output = Vec::new();
    let mut in_block = false;
    let mut block_lines: Vec<String> = Vec::new();

    for line in content.lines() {
        if line.trim_start().starts_with("```") {
            if in_block {
                block_lines.push(line.to_string());
                let is_target = block_lines.iter().any(|l| l.trim() == marker);
                if !is_target {
                    output.append(&mut block_lines);
                } else {
                    block_lines.clear();
                }
                in_block = false;
            } else {
                in_block = true;
                block_lines.push(line.to_string());
            }
            continue;
        }

        if in_block {
            block_lines.push(line.to_string());
        } else {
            output.push(line.to_string());
        }
    }

    if in_block && !block_lines.is_empty() {
        // Unterminated block: keep as-is.
        output.append(&mut block_lines);
    }

    output.join("\n")
}

async fn load_template(file_name: &str) -> Result<String> {
    let path = template_path(file_name);
    fs::read_to_string(&path)
        .await
        .with_context(|| format!("템플릿 읽기 실패: {}", path.display()))
}

fn template_path(file_name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("templates")
        .join(file_name)
}
