use crate::workflow_planning::default_evidence_required;
use crate::workflow_types::{
    FileMap, VerificationDetail, VerificationEvidence, VerificationRequest, VerificationResult,
};

pub fn run_verification(req: VerificationRequest) -> VerificationResult {
    let needs_backend = req.needs_backend;
    let needs_frontend = req.needs_frontend;
    let qa_profile = normalize_qa_profile(&req.qa_profile);
    let required_checks = if req.evidence_required.is_empty() {
        default_evidence_required(qa_profile.as_str(), needs_backend, needs_frontend)
    } else {
        req.evidence_required
            .iter()
            .map(|item| item.trim())
            .filter(|item| !item.is_empty())
            .map(ToOwned::to_owned)
            .collect::<Vec<_>>()
    };

    let mut details = Vec::new();
    if needs_backend {
        details.push(check_files_exist(&req.backend_files, "backend"));
    }
    if needs_frontend {
        details.push(check_files_exist(&req.frontend_files, "frontend"));
    }

    details.extend(check_json_syntax(&req.backend_files));
    details.extend(check_json_syntax(&req.frontend_files));

    if needs_backend {
        details.push(check_api_endpoints(&req.api_spec, &req.backend_files));
    }
    details.extend(req.command_results.iter().map(command_detail));

    let verification_passed = details.iter().all(|detail| detail.ok);
    let verification_failures = details
        .iter()
        .filter(|detail| !detail.ok)
        .map(|detail| {
            detail
                .error
                .clone()
                .unwrap_or_else(|| format!("{} failed", detail.template))
        })
        .collect::<Vec<_>>();
    let verification_evidence =
        build_verification_evidence(&details, needs_backend, needs_frontend);
    let verification_gaps = compute_verification_gaps(&verification_evidence, &required_checks);
    let verification_confidence =
        compute_verification_confidence(&details, &verification_evidence, &verification_gaps);

    VerificationResult {
        verification_passed,
        verification_details: details,
        verification_evidence,
        verification_gaps,
        verification_confidence,
        verification_failures,
        rework_source: (!verification_passed).then(|| "verifier".to_string()),
    }
}

fn normalize_qa_profile(value: &str) -> String {
    match value.trim().to_lowercase().as_str() {
        "lite" => "lite".to_string(),
        "ui" => "ui".to_string(),
        "strict" => "strict".to_string(),
        _ => "standard".to_string(),
    }
}

fn check_files_exist(files: &FileMap, role: &str) -> VerificationDetail {
    if files.is_empty() {
        return VerificationDetail {
            template: "files_exist".to_string(),
            ok: false,
            role: Some(role.to_string()),
            error: Some(format!("No {} files generated", role)),
            ..VerificationDetail::default()
        };
    }
    let empty_files = files
        .iter()
        .filter(|(_, contents)| contents.trim().is_empty())
        .map(|(path, _)| path.to_string())
        .collect::<Vec<_>>();
    VerificationDetail {
        template: "files_exist".to_string(),
        ok: empty_files.is_empty(),
        role: Some(role.to_string()),
        error: (!empty_files.is_empty())
            .then(|| format!("Empty files: {}", empty_files.join(", "))),
        count: Some(files.len()),
        ..VerificationDetail::default()
    }
}

fn check_json_syntax(files: &FileMap) -> Vec<VerificationDetail> {
    files
        .iter()
        .filter(|(path, _)| path.ends_with(".json"))
        .map(
            |(path, contents)| match serde_json::from_str::<serde_json::Value>(contents) {
                Ok(_) => VerificationDetail {
                    template: "json_syntax".to_string(),
                    ok: true,
                    file: Some(path.to_string()),
                    ..VerificationDetail::default()
                },
                Err(err) => VerificationDetail {
                    template: "json_syntax".to_string(),
                    ok: false,
                    file: Some(path.to_string()),
                    error: Some(err.to_string()),
                    ..VerificationDetail::default()
                },
            },
        )
        .collect()
}

fn check_api_endpoints(
    api_spec: &crate::workflow_types::ApiSpec,
    backend_files: &FileMap,
) -> VerificationDetail {
    if api_spec.endpoints.is_empty() {
        return VerificationDetail {
            template: "api_compliance".to_string(),
            ok: true,
            note: Some("No API spec defined".to_string()),
            ..VerificationDetail::default()
        };
    }

    let all_code = backend_files
        .values()
        .map(|contents| contents.to_lowercase())
        .collect::<Vec<_>>()
        .join("\n");
    let missing = api_spec
        .endpoints
        .iter()
        .filter_map(|endpoint| {
            let path = endpoint.path.trim().to_lowercase();
            (!path.is_empty() && !all_code.contains(&path)).then(|| {
                format!(
                    "{} {}",
                    endpoint.method.trim().to_uppercase(),
                    endpoint.path.trim()
                )
            })
        })
        .collect::<Vec<_>>();

    VerificationDetail {
        template: "api_compliance".to_string(),
        ok: missing.is_empty(),
        total_endpoints: Some(api_spec.endpoints.len()),
        missing,
        ..VerificationDetail::default()
    }
}

fn command_detail(result: &crate::workflow_types::VerificationCommandResult) -> VerificationDetail {
    VerificationDetail {
        template: result.check.trim().to_string(),
        ok: result.ok,
        note: result.evidence.clone(),
        error: result.error.clone(),
        ..VerificationDetail::default()
    }
}

fn build_verification_evidence(
    details: &[VerificationDetail],
    needs_backend: bool,
    needs_frontend: bool,
) -> Vec<VerificationEvidence> {
    let mut evidence = Vec::new();
    if needs_backend {
        evidence.push(role_files_evidence(details, "backend", "backend_files"));
    }
    if needs_frontend {
        evidence.push(role_files_evidence(details, "frontend", "frontend_files"));
    }

    let syntax_details = details
        .iter()
        .filter(|detail| detail.template == "json_syntax")
        .collect::<Vec<_>>();
    evidence.push(VerificationEvidence {
        check: "python_json_syntax".to_string(),
        ok: syntax_details.iter().all(|detail| detail.ok),
        source: "syntax".to_string(),
        count: Some(syntax_details.len()),
        note: None,
    });

    if needs_backend {
        evidence.push(template_evidence(
            details,
            "api_compliance",
            "api_compliance",
        ));
    }

    for detail in details.iter().filter(|detail| {
        detail.template != "files_exist"
            && detail.template != "json_syntax"
            && detail.template != "api_compliance"
    }) {
        evidence.push(VerificationEvidence {
            check: detail.template.clone(),
            ok: detail.ok,
            source: "command".to_string(),
            count: None,
            note: detail.note.clone(),
        });
    }

    evidence
}

fn role_files_evidence(
    details: &[VerificationDetail],
    role: &str,
    check: &str,
) -> VerificationEvidence {
    let detail = details
        .iter()
        .find(|detail| detail.template == "files_exist" && detail.role.as_deref() == Some(role));
    VerificationEvidence {
        check: check.to_string(),
        ok: detail.map(|item| item.ok).unwrap_or(false),
        source: "files_exist".to_string(),
        count: detail.and_then(|item| item.count),
        note: None,
    }
}

fn template_evidence(
    details: &[VerificationDetail],
    template: &str,
    source: &str,
) -> VerificationEvidence {
    let detail = details.iter().find(|detail| detail.template == template);
    VerificationEvidence {
        check: template.to_string(),
        ok: detail.map(|item| item.ok).unwrap_or(false),
        source: source.to_string(),
        count: detail.and_then(|item| item.count),
        note: detail.and_then(|item| item.note.clone()),
    }
}

fn compute_verification_gaps(
    evidence: &[VerificationEvidence],
    required_checks: &[String],
) -> Vec<String> {
    required_checks
        .iter()
        .filter(|check| {
            !evidence
                .iter()
                .any(|item| item.check == check.as_str() && item.ok)
        })
        .map(|check| format!("Missing required evidence: {}", check))
        .collect()
}

fn compute_verification_confidence(
    details: &[VerificationDetail],
    evidence: &[VerificationEvidence],
    gaps: &[String],
) -> i32 {
    let detail_ratio = if details.is_empty() {
        100
    } else {
        ((details.iter().filter(|detail| detail.ok).count() * 100) / details.len()) as i32
    };
    let evidence_ratio = if evidence.is_empty() {
        100
    } else {
        ((evidence.iter().filter(|item| item.ok).count() * 100) / evidence.len()) as i32
    };
    let gap_penalty = (gaps.len() as i32 * 15).min(45);
    let confidence = ((detail_ratio * 45) + (evidence_ratio * 55)) / 100 - gap_penalty;
    confidence.clamp(0, 100)
}

#[cfg(test)]
mod tests {
    use super::run_verification;
    use crate::workflow_types::{ApiEndpoint, ApiSpec, VerificationRequest};

    #[test]
    fn run_verification_flags_missing_endpoint() {
        let result = run_verification(VerificationRequest {
            backend_files: [("src/lib.rs".to_string(), "pub fn health() {}".to_string())]
                .into_iter()
                .collect(),
            api_spec: ApiSpec {
                endpoints: vec![ApiEndpoint {
                    method: "GET".to_string(),
                    path: "/api/items".to_string(),
                    description: String::new(),
                }],
            },
            needs_frontend: false,
            ..VerificationRequest::default()
        });

        assert!(!result.verification_passed);
        assert!(result
            .verification_failures
            .iter()
            .any(|item| item.contains("api_compliance")));
    }
}
