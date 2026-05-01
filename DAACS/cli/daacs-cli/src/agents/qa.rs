//! QA Agent - Responsible for rigorous testing using the QA & Testing Bundle.

use anyhow::Result;
use crate::clients::cli_client::{SessionBasedCLIClient, ModelProvider};
use std::path::PathBuf;

pub struct QAAgent {
    client: SessionBasedCLIClient,
}

impl QAAgent {
    pub fn new(working_dir: PathBuf) -> Self {
        // User requested GLM for QA via API
        let model = ModelProvider::Custom("glm-4.7-flash".to_string());
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self { client }
    }

    pub async fn execute_task(&self, task: &str, project_path: &std::path::Path) -> Result<String> {
        let skills_dir = project_path.join(".daacs/skills");
        
        // Load "QA & Testing" Bundle Skills
        let qa_skills = vec![
            skills_dir.join("test-driven-development"),
            skills_dir.join("systematic-debugging"),
            skills_dir.join("browser-automation"),
            skills_dir.join("e2e-testing-patterns"),
            skills_dir.join("code-review-checklist"),
            skills_dir.join("test-fixing"),
        ];

        // Filter for existing skills
        let active_skills: Vec<PathBuf> = qa_skills
            .into_iter()
            .filter(|p| p.exists())
            .collect();

        let prompt = format!(
            r#"You are the QA Engineer utilizing the "QA & Testing" skill set.
Task: {}

Context:
- You have access to specialized testing skills. Use them.
- If you find bugs, report them clearly.
- If tests fail, analyze the root cause.

Execute the task and provide a detailed report."#,
            task
        );

        crate::logger::status_update("🐞 QA Agent: Executing testing workflow...");
        let response = self.client.execute_with_paths(&prompt, &active_skills).await?;
        Ok(response)
    }
}
