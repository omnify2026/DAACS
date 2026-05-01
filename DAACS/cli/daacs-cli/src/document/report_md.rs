//! REPORT.md generation helper.

use anyhow::{Context, Result};
use chrono::Local;
use std::path::Path;
use tokio::fs;

use crate::document::release_gate_md::ReleaseGateDecision;

pub async fn generate_report_md(
    path: &Path,
    project_name: &str,
    summary: &str,
    decision: &ReleaseGateDecision,
) -> Result<()> {
    let now = Local::now();
    let content = format!(
        "# Project Report\n\n\
Generated: {}\n\n\
## Project\n\
{}\n\n\
## Summary\n\
{}\n\n\
## Release Gate\n\
Status: {}\n\n\
## Notes\n\
{}\n",
        now.to_rfc3339(),
        project_name,
        summary,
        decision.status.as_str(),
        decision
            .reasons
            .iter()
            .map(|r| format!("- {}", r))
            .collect::<Vec<_>>()
            .join("\n")
    );

    fs::write(path, content)
        .await
        .with_context(|| format!("Failed to write {}", path.display()))?;
    Ok(())
}
