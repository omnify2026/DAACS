use anyhow::{Result, Context};
use std::path::PathBuf;
use indicatif::{ProgressBar, ProgressStyle};
use std::time::Duration;

use crate::agents::engine::{AgentEngine, EngineOutcome};
use crate::graph::state::{Task, TaskStatus, AgentType};

pub struct TaskRunner {
    engine: AgentEngine,
}

impl TaskRunner {
    pub fn new(project_path: PathBuf) -> Self {
        Self {
            engine: AgentEngine::new(project_path),
        }
    }

    pub async fn execute_single_shot(&mut self, request: &str, agent_type: AgentType) -> Result<String> {
        let spinner = ProgressBar::new_spinner();
        spinner.set_style(
            ProgressStyle::default_spinner()
                .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
                .template("{spinner:.cyan} {msg}")
                .unwrap(),
        );
        spinner.enable_steady_tick(Duration::from_millis(100));
        spinner.set_message("Initializing Autonomous Agent... (This may take a moment)");

        // Create an ad-hoc task
        let task = Task {
            id: "adhoc-1".to_string(),
            name: "Single Shot Request".to_string(),
            description: request.to_string(),
            agent: agent_type,
            status: TaskStatus::Pending,
            phase_num: 1,
            output: None,
            dependencies: vec![],
        };

        // Execute via Engine
        // Note: For ad-hoc tasks, we provide empty DAACS context for now, 
        // assuming the agent can self-discover via FileTracker or user request contains necessary info.
        // Ideally, we load DAACS.md if available.
        let daacs_content = if self.engine.project_path.join("DAACS.md").exists() {
            tokio::fs::read_to_string(self.engine.project_path.join("DAACS.md")).await.unwrap_or_default()
        } else {
            String::new()
        };

        let outcome = self.engine.execute_task(
            &task,
            &daacs_content, 
            "", // No design context for now
            Some(&spinner)
        ).await?;

        spinner.finish_and_clear();

        match outcome {
            EngineOutcome::Developer(res) => Ok(res),
            EngineOutcome::DevOps(res) => Ok(format!("DevOps Output: {:?}", res)),
            EngineOutcome::Reviewer(res) => Ok(format!("Review Approved: {}\n{}", res.approved, res.summary)),
            EngineOutcome::Skipped => Ok("Task Skipped.".to_string()),
        }
    }
}

// Expose internal engine path for debugging if needed
impl TaskRunner {
    pub fn get_project_path(&self) -> PathBuf {
        self.engine.project_path.clone()
    }
}
