//! Visual verification helpers (stubbed).

use anyhow::Result;
use std::path::{Path, PathBuf};

use crate::graph::verifier::{VerificationResult, VerificationStatus};

pub async fn capture_screenshots(project_path: &Path) -> Result<Vec<String>> {
    let mut shots = Vec::new();
    let dirs = vec![
        project_path.join("artifacts").join("screenshots"),
        project_path.join("playwright-report"),
        project_path.join("test-results"),
    ];

    for dir in dirs {
        if dir.is_dir() {
            collect_images_recursive(&dir, &mut shots)?;
        }
    }
    Ok(shots)
}

pub async fn check_console_errors(project_path: &Path) -> Result<Vec<String>> {
    let mut errors = Vec::new();
    let log_path = project_path
        .join("artifacts")
        .join("console_errors.log");
    let alt_path = project_path
        .join("artifacts")
        .join("console_errors.txt");

    let path = if log_path.exists() {
        log_path
    } else if alt_path.exists() {
        alt_path
    } else {
        return Ok(errors);
    };

    let content = std::fs::read_to_string(path)?;
    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            errors.push(trimmed.to_string());
        }
    }
    Ok(errors)
}

fn collect_images_recursive(dir: &PathBuf, out: &mut Vec<String>) -> Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.is_dir() {
            collect_images_recursive(&path, out)?;
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let ext = ext.to_lowercase();
            if ext == "png" || ext == "jpg" || ext == "jpeg" {
                out.push(path.display().to_string());
            }
        }
    }
    Ok(())
}

pub fn analyze_ui(screenshots: &[String], console_errors: &[String]) -> Result<VerificationResult> {
    if screenshots.is_empty() {
        return Ok(VerificationResult {
            status: VerificationStatus::Conditional,
            message: "No screenshots captured.".to_string(),
            details: None,
        });
    }

    if !console_errors.is_empty() {
        return Ok(VerificationResult {
            status: VerificationStatus::Conditional,
            message: "Console errors detected.".to_string(),
            details: None,
        });
    }

    Ok(VerificationResult::ok("Visual verification ok."))
}
