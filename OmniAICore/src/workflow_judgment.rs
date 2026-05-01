use crate::recover_json;
use crate::workflow_types::{FileMap, JudgmentRequest, JudgmentResult, ReviewData};

const REVIEW_PROMPT: &str = r#"You are an expert code reviewer. Review the following code and provide a quality assessment.

## Project Goal
{goal}

## API Specification
{api_spec}

## Backend Files
{backend_files}

## Frontend Files
{frontend_files}

## Instructions
Analyze the code and respond with a JSON object:

{{
    "score": 0-10,
    "passed": true/false,
    "issues": [
        {{"severity": "critical|warning|info", "file": "path", "description": "issue", "suggestion": "fix"}}
    ],
    "goal_achieved": true/false,
    "goal_reason": "Why goal is/isn't achieved",
    "missing_features": ["feature1", "feature2"],
    "compatibility_issues": ["issue1"]
}}
"#;

pub fn build_judgment_review_prompt(req: &JudgmentRequest) -> String {
    REVIEW_PROMPT
        .replace("{goal}", req.goal.trim())
        .replace(
            "{api_spec}",
            &serde_json::to_string_pretty(&req.api_spec).unwrap_or_else(|_| "N/A".to_string()),
        )
        .replace(
            "{backend_files}",
            &format_files_for_review(&req.backend_files, 8_000),
        )
        .replace(
            "{frontend_files}",
            &format_files_for_review(&req.frontend_files, 8_000),
        )
}

pub fn evaluate_judgment(req: JudgmentRequest) -> JudgmentResult {
    let mut failure_summary = Vec::new();
    if req.needs_backend {
        failure_summary.extend(check_file_basics(&req.backend_files, "backend"));
    }
    if req.needs_frontend {
        failure_summary.extend(check_file_basics(&req.frontend_files, "frontend"));
    }

    let (consistency_passed, consistency_issues) =
        check_api_spec_compliance(&req.api_spec, &req.backend_files, &req.frontend_files);
    failure_summary.extend(consistency_issues.clone());

    let code_review = req
        .review_data
        .clone()
        .or_else(|| parse_review_data(req.review_response.as_deref()))
        .unwrap_or_else(|| {
            if req.backend_files.is_empty() && req.frontend_files.is_empty() {
                failure_summary.push("No files generated at all".to_string());
                ReviewData {
                    score: 0,
                    ..ReviewData::default()
                }
            } else {
                ReviewData::default()
            }
        });

    if !code_review.goal_achieved {
        failure_summary.push(format!(
            "Goal not achieved: {}",
            blank_to_fallback(&code_review.goal_reason, "unknown")
        ));
    }
    for issue in &code_review.issues {
        if issue.severity.eq_ignore_ascii_case("critical") {
            failure_summary.push(format!("Critical: {}", issue.description.trim()));
        }
    }
    failure_summary.extend(
        code_review
            .missing_features
            .iter()
            .map(|item| format!("Missing feature: {}", item.trim())),
    );
    failure_summary.extend(
        code_review
            .compatibility_issues
            .iter()
            .map(|item| format!("Compatibility: {}", item.trim())),
    );

    let min_score = req.min_score.unwrap_or(8);
    let code_review_passed = code_review.score >= min_score && failure_summary.is_empty();

    JudgmentResult {
        needs_rework: !code_review_passed,
        code_review: code_review.clone(),
        code_review_score: code_review.score,
        code_review_passed,
        consistency_passed,
        consistency_issues,
        failure_summary,
        rework_source: (!code_review_passed).then(|| "reviewer".to_string()),
    }
}

fn parse_review_data(raw: Option<&str>) -> Option<ReviewData> {
    raw.and_then(recover_json)
        .and_then(|value| serde_json::from_value(value).ok())
}

fn blank_to_fallback(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn format_files_for_review(files: &FileMap, max_chars: usize) -> String {
    if files.is_empty() {
        return "(no files)".to_string();
    }

    let mut parts = Vec::new();
    let mut total = 0usize;
    for (path, code) in files {
        let entry = format!("--- {} ---\n{}\n", path, code);
        if total + entry.len() > max_chars {
            parts.push(format!(
                "... ({} more files truncated)",
                files.len().saturating_sub(parts.len())
            ));
            break;
        }
        total += entry.len();
        parts.push(entry);
    }
    parts.join("\n")
}

fn check_api_spec_compliance(
    api_spec: &crate::workflow_types::ApiSpec,
    backend_files: &FileMap,
    frontend_files: &FileMap,
) -> (bool, Vec<String>) {
    if api_spec.endpoints.is_empty() {
        return (true, Vec::new());
    }

    let backend_code = backend_files
        .values()
        .map(|contents| contents.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let mut issues = api_spec
        .endpoints
        .iter()
        .filter_map(|endpoint| {
            let path = endpoint.path.trim().to_lowercase();
            (!path.is_empty() && !backend_code.contains(&path)).then(|| {
                format!(
                    "Missing backend endpoint: {} {}",
                    endpoint.method.trim().to_uppercase(),
                    endpoint.path.trim()
                )
            })
        })
        .collect::<Vec<_>>();

    let frontend_code = frontend_files
        .values()
        .map(|contents| contents.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let frontend_has_api_call = [
        "fetch(",
        "axios",
        "api.",
        "/api/",
        "usequery",
        "usemutation",
    ]
    .iter()
    .any(|needle| frontend_code.contains(needle));
    if !frontend_files.is_empty() && !backend_files.is_empty() && !frontend_has_api_call {
        issues.push("Frontend doesn't appear to call any backend API endpoints".to_string());
    }

    (issues.is_empty(), issues)
}

fn check_file_basics(files: &FileMap, role: &str) -> Vec<String> {
    if files.is_empty() {
        return vec![format!("No {} files generated", role)];
    }

    let mut issues = Vec::new();
    for (path, code) in files {
        if code.trim().is_empty() {
            issues.push(format!("Empty file: {}", path));
        }
        if code.len() < 20 {
            issues.push(format!(
                "Suspiciously short file ({} chars): {}",
                code.len(),
                path
            ));
        }
    }
    issues
}

#[cfg(test)]
mod tests {
    use super::evaluate_judgment;
    use crate::workflow_types::{ApiEndpoint, ApiSpec, JudgmentRequest, ReviewData};

    #[test]
    fn evaluate_judgment_blocks_on_static_failures() {
        let result = evaluate_judgment(JudgmentRequest {
            api_spec: ApiSpec {
                endpoints: vec![ApiEndpoint {
                    method: "GET".to_string(),
                    path: "/api/health".to_string(),
                    description: String::new(),
                }],
            },
            backend_files: [("src/lib.rs".to_string(), "pub fn main() {}".to_string())]
                .into_iter()
                .collect(),
            frontend_files: [(
                "app.tsx".to_string(),
                "export default function App() { return null; }".to_string(),
            )]
            .into_iter()
            .collect(),
            review_data: Some(ReviewData {
                score: 9,
                goal_achieved: true,
                ..ReviewData::default()
            }),
            ..JudgmentRequest::default()
        });

        assert!(result.needs_rework);
        assert!(result
            .failure_summary
            .iter()
            .any(|item| item.contains("Missing backend endpoint")));
    }
}
