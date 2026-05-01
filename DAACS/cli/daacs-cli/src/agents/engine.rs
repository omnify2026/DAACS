use anyhow::Result;
use std::path::PathBuf;
use std::time::Duration;
use indicatif::{ProgressBar, ProgressStyle};

use crate::agents::agent_runtime::AgentRuntime;
use crate::agents::developer::{DeveloperAgent, DeveloperType};
use crate::agents::devops::{DevOpsAgent, DevOpsResult};
use crate::agents::designer::DesignerAgent;
use crate::agents::reviewer::{ReviewerAgent, ReviewResult};
use crate::agents::qa::QAAgent;
use crate::agents::diff_patch::DiffPatcher;
use crate::context::file_tracker::FileTracker;
use crate::skills::SkillLoader;
use crate::graph::state::{AgentType, Task, TaskStatus};
use crate::agents::council::{run_council, CouncilConfig, synthesize_responses};
use crate::middleware::self_healing::{Healer, EscalationReason};

pub struct AgentEngine {
    pub project_path: PathBuf,
    runtime: AgentRuntime,
    file_tracker: FileTracker,
    skill_loader: SkillLoader,
}

pub enum EngineOutcome {
    Developer(String),
    DevOps(DevOpsResult),
    Reviewer(ReviewResult),
    Skipped,
}

impl AgentEngine {
    pub fn new(project_path: PathBuf) -> Self {
        Self {
            project_path: project_path.clone(),
            runtime: AgentRuntime::new(&project_path),
            file_tracker: FileTracker::new(&project_path),
            skill_loader: SkillLoader::new(&project_path),
        }
    }

    pub async fn execute_task(
        &mut self,
        task: &Task,
        daacs_content: &str,
        design_context: &str,
        progress_bar: Option<&ProgressBar>,
    ) -> Result<EngineOutcome> {
        let _ = self.file_tracker.scan(); // Refresh file state
        
        let mut attempts = 0;
        const MAX_ATTEMPTS: i32 = 3;
        let mut last_feedback: Option<String> = None;
        
        // Dynamic Config Reload
        let _ = crate::config::settings::reload();
        let config = crate::config::settings::get();

        // Agent Initialization (Lazy or Cached per Engine)
        // For simplicity in Phase 8, we instantiate per task or reuse runtime clients
        // Ideally, Agents should be persistent in the Engine if they have session context.
        // Here we recreate them to ensuring config reload is respected, but sessions might need care.
        
        while attempts < MAX_ATTEMPTS {
            attempts += 1;
            if let Some(pb) = progress_bar {
                if attempts > 1 {
                    pb.set_message(format!("Retry {}/{}: {}", attempts, MAX_ATTEMPTS, task.name));
                }
            }

            // Context Building
            let extra_context = self.runtime.build_context("orchestrator").unwrap_or_default();
            let empty_files: Vec<String> = Vec::new();
            let skills_ctx = self.skill_loader.build_context(match task.agent {
                AgentType::BackendDeveloper => "BackendDeveloper",
                AgentType::FrontendDeveloper => "FrontendDeveloper",
                _ => "Developer",
            }, &task.description, &empty_files).await.ok();
            
            let keywords: Vec<&str> = task.description.split_whitespace().take(5).collect();
            let file_ctx = self.file_tracker.build_context(&keywords);
            let file_ctx_opt = if file_ctx.is_empty() { None } else { Some(file_ctx.as_str()) };



            // Update Spinner
            if let Some(pb) = progress_bar {
                pb.set_message(format!("🤖 {:?} is working on it...", task.agent));
            }

            // Execution
            let result: Result<EngineOutcome> = match task.agent {
                AgentType::BackendDeveloper => {
                    let model = config.get_backend_model();
                    let client = self.runtime.client(model, "backend");
                    let agent = DeveloperAgent::with_client(client, DeveloperType::Backend);
                    
                    let response = agent.execute_task(
                        task, 
                        daacs_content, 
                        None, 
                        Some(&extra_context), 
                        last_feedback.as_deref(), 
                        None, 
                        skills_ctx.as_deref(), 
                        file_ctx_opt,
                        None
                    ).await?;
                    Ok(EngineOutcome::Developer(response))
                }
                AgentType::FrontendDeveloper => {
                    let model = config.get_frontend_model();
                    let client = self.runtime.client(model, "frontend");
                    let agent = DeveloperAgent::with_client(client, DeveloperType::Frontend);
                    
                    let response = agent.execute_task(
                        task, 
                        daacs_content, 
                        None, 
                        Some(&extra_context), 
                        last_feedback.as_deref(), 
                        Some(design_context), 
                        skills_ctx.as_deref(), 
                        file_ctx_opt,
                        None
                    ).await?;
                    Ok(EngineOutcome::Developer(response))
                }
                AgentType::DevOps => {
                    let model = config.get_devops_model();
                    let client = self.runtime.client(model, "devops");
                    let agent = DevOpsAgent::with_client(client);
                    let response = agent.execute_task(task, daacs_content, &self.project_path).await?;
                    Ok(EngineOutcome::DevOps(response))
                }
                AgentType::Reviewer => {
                    let model = config.get_reviewer_model();
                    let client = self.runtime.client(model, "reviewer");
                    let agent = ReviewerAgent::with_client(client);
                    let result = agent.review_code(daacs_content, &self.project_path, None).await?;
                    Ok(EngineOutcome::Reviewer(result))
                }
                _ => Ok(EngineOutcome::Skipped), // Others implemented as needed
            };

            match result {
                Ok(EngineOutcome::Developer(response)) => {
                    // 1. Apply Changes
                    if DiffPatcher::contains_diff(&response) {
                        let diffs = DiffPatcher::extract_diffs(&response);
                        for diff_chunk in diffs {
                            let _ = DiffPatcher::apply_patch(&self.project_path, &diff_chunk);
                        }
                        let _ = self.file_tracker.scan();
                    } else if DeveloperAgent::contains_file_blocks(&response) {
                        // Needed for new file creation fallback
                        // Note: ideally we move extract_and_save_files to a utility or trait
                        // For now we assume DiffPatcher or manual handling logic is sufficient or handled by specific agents
                        // We will add a helper here if needed.
                        // Actually, DeveloperAgent has specific logic for this.
                        // Let's instantiate a temp agent to save files if needed, or better, refactor DeveloperAgent logic to be static or Engine-owned.
                        // For Phase 8 MVP, we rely on DiffPatcher which is the primary method now.
                    }

                    // 2. Self-Healing Verification
                    let healer = Healer::new();
                    match healer.verify_code(&self.project_path).await {
                        Ok(_) => {
                            if let Some(pb) = progress_bar { pb.set_message("Verification Passed"); }
                            return Ok(EngineOutcome::Developer(response));
                        },
                        Err(e) => {
                            if let Some(pb) = progress_bar { pb.set_message("Healing..."); }
                            match healer.attempt_fix(&e.to_string(), &self.project_path).await {
                                Ok(EscalationReason::Fixed) => {
                                    return Ok(EngineOutcome::Developer(response));
                                },
                                Ok(EscalationReason::EscalateToCouncil(reason)) => {
                                    if let Some(pb) = progress_bar { pb.set_message("Escalating to Council..."); }
                                    let issue = format!("Task '{}' failed verification.\nHealer Request: {}\n\nError Log:\n{}", task.name, reason, e);
                                    if let Ok(responses) = run_council(&issue, CouncilConfig::default(), self.project_path.clone()).await {
                                        let advice = synthesize_responses(&responses);
                                        last_feedback = Some(format!("Council Intervention:\n{}", advice));
                                        // Loop continues to retry with advice
                                    }
                                },
                                Ok(EscalationReason::Unfixable(reason)) => {
                                    last_feedback = Some(format!("Verification failed: {}\nReason: {}", e, reason));
                                },
                                Err(heal_err) => {
                                    last_feedback = Some(format!("Verification failed: {}\nHealer Error: {}", e, heal_err));
                                }
                            }
                        }
                    }
                }
                Ok(outcome) => return Ok(outcome),
                Err(e) => {
                    // Execution Error -> Council Strategy
                    if attempts < MAX_ATTEMPTS {
                        if let Some(pb) = progress_bar { pb.set_message("Asking Council for help..."); }
                        let issue = format!("Task '{}' failed execution: {}\n\nHow should I fix this?", task.name, e);
                        if let Ok(responses) = run_council(&issue, CouncilConfig::default(), self.project_path.clone()).await {
                            let advice = synthesize_responses(&responses);
                            last_feedback = Some(advice);
                        }
                    } else {
                        return Err(e);
                    }
                }
            }
        }
        
        Err(anyhow::anyhow!("Max attempts reached for task {}", task.name))
    }
}
