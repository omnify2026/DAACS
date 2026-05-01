//! REVIEW.md generation and parsing helpers.

use anyhow::{Context, Result};
use chrono::Local;
use std::path::Path;
use tokio::fs;

use crate::agents::reviewer::ReviewResult;

#[derive(Debug, Clone, Default)]
pub struct ReviewData {
    pub score: f32,
    pub recommendation: String,
    pub critical_count: u32,
    pub high_count: u32,
    pub medium_count: u32,
    pub low_count: u32,
    pub unmet_requirements: u32,
    pub minor_issues: u32,
}

pub async fn generate_review_md(
    path: &Path,
    project_name: &str,
    review: &ReviewResult,
) -> Result<ReviewData> {
    let data = ReviewData::from_review_result(review);
    let now = Local::now();

    let mut content = String::new();
    content.push_str("# 리뷰 보고서\n\n");
    content.push_str(&format!("> 생성일: {}\n", now.format("%Y-%m-%d")));
    content.push_str(&format!("> 프로젝트: {}\n", project_name));
    content.push_str("> 리뷰: ReviewerAgent (Self-Correcting)\n\n");
    content.push_str("---\n\n");

    // 1. Summary
    content.push_str("## 1. 리뷰 요약\n\n");
    content.push_str(&format!("**결과**: {}\n\n", if review.approved { "승인 (Approved)" } else { "반려 (Rejected)" }));
    content.push_str(&format!("{}\n\n", review.summary));
    
    content.push_str("| 항목 | 값 |\n");
    content.push_str("|---|---|\n");
    content.push_str(&format!("| 전체 점수 | {:.1}/10 |\n", data.score));
    content.push_str(&format!("| 권고 | {} |\n", data.recommendation));
    content.push_str(&format!("| 이슈 | {}건 |\n", review.issues.len()));
    content.push_str(&format!("| 제안 | {}건 |\n", review.suggestions.len()));
    content.push('\n');

    // 2. Issues
    content.push_str("## 2. 발견된 이슈 (Issues)\n\n");
    if !review.issues.is_empty() {
        for (idx, issue) in review.issues.iter().enumerate() {
            content.push_str(&format!("{}. {}\n", idx + 1, issue));
        }
    } else {
        content.push_str("발견된 주요 이슈가 없습니다.\n");
    }
    content.push('\n');

    // 3. Suggestions
    content.push_str("## 3. 제안사항 (Suggestions)\n\n");
    if !review.suggestions.is_empty() {
        for (idx, rec) in review.suggestions.iter().enumerate() {
            content.push_str(&format!("{}. {}\n", idx + 1, rec));
        }
    } else {
        content.push_str("제안사항이 없습니다.\n");
    }
    content.push('\n');

    // Append metadata
    content.push_str("---\n\n");
    content.push_str("```yaml\nreview_metrics:\n");
    content.push_str(&format!("  score: {:.1}\n", data.score));
    content.push_str(&format!("  recommendation: {}\n", data.recommendation));
    content.push_str(&format!("  issue_count: {}\n", review.issues.len()));
    content.push_str("```\n");

    fs::write(path, content).await?;
    Ok(data)
}

pub async fn parse_review_md(path: &Path) -> Result<ReviewData> {
    let content = fs::read_to_string(path)
        .await
        .with_context(|| format!("파일 읽기 실패: {}", path.display()))?;

    if let Some(data) = parse_review_metrics_yaml(&content) {
        return Ok(data);
    }

    // Fallback: naive parsing from tables.
    let mut data = ReviewData::default();
    for line in content.lines() {
        if line.contains("/10") && line.contains('|') {
            if let Some(score) = extract_number_before(line, "/10") {
                data.score = score;
            }
        }
    }

    data.recommendation = recommendation_from_score(data.score);
    Ok(data)
}

pub async fn update_review_metrics<F>(path: &Path, updater: F) -> Result<ReviewData>
where
    F: FnOnce(&mut ReviewData),
{
    let content = fs::read_to_string(path).await.unwrap_or_else(|_| {
        String::from("# 리뷰 요약\n\n(템플릿 없이 생성된 파일입니다.)\n")
    });

    let mut data = parse_review_metrics_yaml(&content).unwrap_or_default();
    updater(&mut data);

    let updated = upsert_review_metrics_block(&content, &data);
    fs::write(path, updated).await?;

    Ok(data)
}

impl ReviewData {
    pub fn from_review_result(result: &ReviewResult) -> Self {
        let base_score = if result.approved { 9.0 } else { 5.0 };
        let penalty = (result.issues.len() as f32) * 0.5;
        let score = (base_score - penalty).clamp(0.0, 10.0);
        
        let recommendation = if result.approved {
            "pass".to_string()
        } else {
            "fail".to_string()
        };

        ReviewData {
            score,
            recommendation,
            critical_count: result.issues.len() as u32,
            high_count: 0,
            medium_count: 0,
            low_count: 0,
            unmet_requirements: 0,
            minor_issues: result.suggestions.len() as u32,
        }
    }
}

fn recommendation_from_score(score: f32) -> String {
    if score >= 8.0 {
        "pass".to_string()
    } else if score >= 6.0 {
        "conditional".to_string()
    } else {
        "fail".to_string()
    }
}

fn extract_number_before(line: &str, suffix: &str) -> Option<f32> {
    let idx = line.find(suffix)?;
    let prefix = &line[..idx];
    let digits: String = prefix
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.parse::<f32>().ok()
}

fn parse_review_metrics_yaml(content: &str) -> Option<ReviewData> {
    let mut in_metrics = false;
    let mut data = ReviewData::default();

    for line in content.lines() {
        if line.trim() == "review_metrics:" {
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
                    "score" => data.score = value.parse::<f32>().unwrap_or(0.0),
                    "recommendation" => data.recommendation = value.to_string(),
                    "issue_count" => data.critical_count = value.parse().unwrap_or(0),
                    _ => {}
                }
            }
        }
    }

    if in_metrics {
        if data.recommendation.is_empty() {
            data.recommendation = recommendation_from_score(data.score);
        }
        Some(data)
    } else {
        None
    }
}

fn upsert_review_metrics_block(content: &str, data: &ReviewData) -> String {
    let stripped = remove_yaml_block(content, "review_metrics:");
    let mut output = stripped.trim_end().to_string();
    output.push_str("\n\n```yaml\nreview_metrics:\n");
    output.push_str(&format!("  score: {:.1}\n", data.score));
    output.push_str(&format!("  recommendation: {}\n", data.recommendation));
    output.push_str(&format!("  issue_count: {}\n", data.critical_count));
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
        output.append(&mut block_lines);
    }

    output.join("\n")
}


