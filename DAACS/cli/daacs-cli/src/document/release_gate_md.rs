//! RELEASE_GATE.md generation helpers.

use anyhow::{Context, Result};
use chrono::Local;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::document::review_md::ReviewData;
use crate::document::test_report_md::{Status, TestReportData};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[derive(Default)]
pub enum ReleaseGateStatus {
    Pass,
    Conditional,
    #[default]
    Fail,
}

impl ReleaseGateStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            ReleaseGateStatus::Pass => "pass",
            ReleaseGateStatus::Conditional => "conditional",
            ReleaseGateStatus::Fail => "fail",
        }
    }
}


#[derive(Debug, Clone, Default)]
pub struct ReleaseGateDecision {
    pub status: ReleaseGateStatus,
    pub reasons: Vec<String>,
    pub required_actions: Vec<String>,
}

pub fn decide_release_gate(review: &ReviewData, test: &TestReportData) -> ReleaseGateDecision {
    let mut fail_reasons = Vec::new();
    let mut conditional_reasons = Vec::new();

    // Quality score
    if review.score < 6.0 {
        fail_reasons.push("품질 점수 < 6.0".to_string());
    } else if review.score < 8.0 {
        conditional_reasons.push("품질 점수 6.0~7.9".to_string());
    }

    if review.critical_count >= 1 {
        fail_reasons.push("Critical 이슈 존재".to_string());
    }
    if review.high_count >= 1 {
        conditional_reasons.push("High 이슈 존재".to_string());
    }
    if review.unmet_requirements >= 1 {
        fail_reasons.push("중요 요구사항 미충족".to_string());
    }
    if (1..=3).contains(&review.minor_issues) {
        conditional_reasons.push("사양 경미 이슈 존재".to_string());
    }
    if review.minor_issues >= 4 {
        fail_reasons.push("사양 이슈 과다".to_string());
    }

    // Runtime
    if test.runtime_backend == Status::Fail || test.runtime_frontend == Status::Fail {
        fail_reasons.push("런타임 검증 실패".to_string());
    }

    // Visual
    if test.visual_screenshot_count == 0 {
        conditional_reasons.push("스크린샷 없음".to_string());
    }
    if test.visual_console_error_count > 0 {
        conditional_reasons.push("콘솔 오류 감지".to_string());
    }

    // E2E
    if test.e2e_scenario_count == 0 {
        conditional_reasons.push("E2E 시나리오 없음".to_string());
    }
    if test.e2e_fail_count >= 1 {
        fail_reasons.push("E2E 시나리오 실패".to_string());
    }

    // Performance
    if !test.perf_baseline_exists {
        conditional_reasons.push("성능 기준선 없음".to_string());
    } else if test.perf_degradation_percent >= 20.0 {
        fail_reasons.push("성능 저하 20% 이상".to_string());
    }

    // Stability
    if test.stability_fail_count >= 2 {
        fail_reasons.push("안정성 실패 2회 이상".to_string());
    } else if test.stability_fail_count == 1 {
        conditional_reasons.push("안정성 실패 감지".to_string());
    }

    // Consistency
    if test.consistency_status == Status::Fail {
        fail_reasons.push("일관성 검증 실패".to_string());
    }

    let status = if !fail_reasons.is_empty() {
        ReleaseGateStatus::Fail
    } else if !conditional_reasons.is_empty() {
        ReleaseGateStatus::Conditional
    } else {
        ReleaseGateStatus::Pass
    };

    let mut reasons = Vec::new();
    reasons.extend(fail_reasons);
    reasons.extend(conditional_reasons.clone());

    let required_actions = if status == ReleaseGateStatus::Conditional {
        conditional_reasons
    } else {
        Vec::new()
    };

    ReleaseGateDecision {
        status,
        reasons,
        required_actions,
    }
}

pub async fn generate_release_gate_md(
    path: &Path,
    project_name: &str,
    review: &ReviewData,
    test: &TestReportData,
    decision: &ReleaseGateDecision,
) -> Result<()> {
    let template = load_template("RELEASE_GATE.md").await?;
    let now = Local::now();

    let mut content = template;
    content = content.replace("{{DATE}}", &now.format("%Y-%m-%d").to_string());
    content = content.replace("{{PROJECT_NAME}}", project_name);
    content = content.replace("{{GATE_STATUS}}", decision.status.as_str());
    content = content.replace("{{TIMESTAMP}}", &now.to_rfc3339());

    content = content.replace("{{SCORE}}", &format!("{:.1}", review.score));
    content = content.replace("{{CRITICAL_COUNT}}", &review.critical_count.to_string());
    content = content.replace("{{HIGH_COUNT}}", &review.high_count.to_string());
    content = content.replace("{{UNMET_CRITICAL}}", &review.unmet_requirements.to_string());
    content = content.replace("{{MINOR_ISSUES}}", &review.minor_issues.to_string());

    content = content.replace(
        "{{BACKEND_STATUS}}",
        test.runtime_backend.as_str(),
    );
    content = content.replace(
        "{{FRONTEND_STATUS}}",
        test.runtime_frontend.as_str(),
    );

    content = content.replace(
        "{{SCREENSHOT_STATUS}}",
        if test.visual_screenshot_count > 0 { "있음" } else { "없음" },
    );
    content = content.replace(
        "{{CONSOLE_ERROR_STATUS}}",
        if test.visual_console_error_count > 0 { "있음" } else { "없음" },
    );

    content = content.replace(
        "{{SCENARIO_EXISTS}}",
        if test.e2e_scenario_count > 0 { "예" } else { "아니오" },
    );
    content = content.replace(
        "{{SCENARIO_FAIL_COUNT}}",
        &test.e2e_fail_count.to_string(),
    );

    content = content.replace(
        "{{BASELINE_EXISTS}}",
        if test.perf_baseline_exists { "예" } else { "아니오" },
    );
    content = content.replace(
        "{{PERF_DEGRADATION}}",
        &format!("{:.1}", test.perf_degradation_percent),
    );

    content = content.replace("{{TOTAL_RUNS}}", &test.stability_runs.to_string());
    content = content.replace("{{FAIL_COUNT}}", &test.stability_fail_count.to_string());

    content.push_str("\n\n```yaml\nrelease_gate:\n");
    content.push_str(&format!("  status: {}\n", decision.status.as_str()));
    content.push_str(&format!("  score: {:.1}\n", review.score));
    content.push_str(&format!("  critical_count: {}\n", review.critical_count));
    content.push_str(&format!("  high_count: {}\n", review.high_count));
    content.push_str(&format!("  unmet_requirements: {}\n", review.unmet_requirements));
    if !decision.reasons.is_empty() {
        content.push_str("  reasons:\n");
        for reason in &decision.reasons {
            content.push_str(&format!("    - {}\n", reason));
        }
    }
    if !decision.required_actions.is_empty() {
        content.push_str("  required_actions:\n");
        for action in &decision.required_actions {
            content.push_str(&format!("    - {}\n", action));
        }
    }
    content.push_str("```\n");

    fs::write(path, content).await?;
    Ok(())
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
