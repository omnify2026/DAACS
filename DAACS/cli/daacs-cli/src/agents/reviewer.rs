//! Reviewer Agent - Code quality and security review.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewResult {
    pub approved: bool,
    pub issues: Vec<String>,
    pub suggestions: Vec<String>,
    pub summary: String,
}

pub struct ReviewerAgent {
    client: SessionBasedCLIClient,
}

impl ReviewerAgent {
    pub fn new(model: ModelProvider, working_dir: std::path::PathBuf) -> Self {
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self { client }
    }

    pub fn with_client(client: SessionBasedCLIClient) -> Self {
        Self { client }
    }

    pub async fn review_code(
        &self,
        daacs_content: &str,
        project_path: &std::path::Path,
        code_content: Option<&str>, // Optional: Review generated code directly
    ) -> Result<ReviewResult> {
        let context = if let Some(code) = code_content {
            format!("Generated Code:\n{}", code)
        } else {
            format!("Project Path: {}", project_path.display())
        };

        let prompt = format!(
            r#"You are a Code Reviewer. Review the code against the spec.

=== SPECIFICATION ===
{spec}

=== CODE TO REVIEW ===
{context}

=== CRITERIA ===
1. Does it meet the spec?
2. Are there bugs or security issues?
3. Is the design consistent (if frontend)?

=== OUTPUT FORMAT (JSON ONLY) ===
{{
    "approved": true/false,
    "issues": ["Critical issue 1", "Major issue 2"],
    "suggestions": ["Suggestion 1"],
    "summary": "Brief summary"
}}

RULES:
- If there are compilation errors or missing requirements, approved must be FALSE.
- If it's just a style suggestion, approved can be TRUE.
"#,
            spec = daacs_content,
            context = context
        );

        crate::logger::status_update("Reviewer: Reviewing code...");
        let response = self.client.execute(&prompt).await?;
        
        let json_str = extract_json(&response).unwrap_or(response);
        let result: ReviewResult = serde_json::from_str(&json_str)
            .unwrap_or_else(|_| ReviewResult {
                approved: false,
                issues: vec!["Failed to parse reviewer response".to_string()],
                suggestions: vec![],
                summary: "Review parsing failed".to_string(),
            });

        Ok(result)
    }
}

fn extract_json(text: &str) -> Option<String> {
    if let Some(start) = text.find("```json") {
        let content_start = start + 7;
        if let Some(end) = text[content_start..].find("```") {
            return Some(text[content_start..content_start + end].trim().to_string());
        }
    }
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return Some(text[start..=end].to_string());
        }
    }
    None
}
