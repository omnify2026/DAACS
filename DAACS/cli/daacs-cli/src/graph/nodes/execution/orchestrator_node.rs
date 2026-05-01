//! 아키텍트 오케스트레이션 노드: plan.md 기반 작업 큐 실행

use anyhow::Result;

use crate::agents::agent_runtime::AgentRuntime;
use crate::agents::developer::{DeveloperAgent, DeveloperType};
use crate::agents::devops::{DevOpsAgent, DevOpsResult};
use crate::agents::designer::DesignerAgent;
use crate::agents::reviewer::ReviewerAgent;
use crate::agents::qa::QAAgent;
use crate::agents::diff_patch::DiffPatcher;
use crate::context::file_tracker::FileTracker;
use crate::skills::SkillLoader;
use crate::document::plan_md;
use crate::graph::state::{AgentType, CLIState, TaskStatus};
use crate::graph::workflow::{Node, NodeResult};
use crate::utils::file_snapshot::{capture, diff};
use indicatif::{ProgressBar, ProgressStyle, MultiProgress};
use std::time::Duration;
use crate::agents::council::{run_council, CouncilConfig, synthesize_responses};
use crate::middleware::self_healing::{Healer, EscalationReason};

use crate::agents::engine::{AgentEngine, EngineOutcome};

pub struct OrchestratorNode;

#[async_trait::async_trait]
impl Node for OrchestratorNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("아키텍트 오케스트레이션 (Self-Correcting)");

        let plan_path = state
            .plan_path
            .clone()
            .unwrap_or_else(|| state.project_path.join("plan.md"));

        if plan_path.exists() {
            if let Ok(parsed) = plan_md::parse_file(&plan_path).await {
                if !parsed.is_empty() {
                    state.tasks = parsed;
                }
            }
        }

        if state.tasks.is_empty() {
            crate::logger::log_warning("plan.md에 실행할 작업이 없습니다.");
            return Ok(NodeResult::Success);
        }

        let daacs_content = state
            .daacs_content
            .clone()
            .ok_or_else(|| anyhow::anyhow!("DAACS.md content is missing"))?;

        // 작업 정렬
        state.tasks.sort_by(|a, b| {
            let a_is_fix = a.id.contains("fix");
            let b_is_fix = b.id.contains("fix");
            if a_is_fix && !b_is_fix { return std::cmp::Ordering::Less; }
            if !a_is_fix && b_is_fix { return std::cmp::Ordering::Greater; }
            
            // Natural Sort for IDs (e.g., 1-2 < 1-10)
            let parse_id = |id: &str| -> Vec<u32> {
                id.split(|c: char| !c.is_numeric())
                  .filter_map(|s| s.parse::<u32>().ok())
                  .collect()
            };
            
            let a_nums = parse_id(&a.id);
            let b_nums = parse_id(&b.id);
            
            // Compare parsed numbers first
            match a_nums.cmp(&b_nums) {
                std::cmp::Ordering::Equal => a.id.cmp(&b.id), // Fallback to string if nums match (shouldn't happen for distinct IDs)
                ord => ord,
            }
        });

        let config = crate::config::settings::get();
        let mut runtime = AgentRuntime::new(&state.project_path);

        // Backend Agent Init
        let backend_model = config.get_backend_model();
        let backend_client = runtime.client(backend_model.clone(), "backend");
        let backend_agent = DeveloperAgent::with_client(backend_client, DeveloperType::Backend);
            
        // Frontend Agent Init
        let frontend_model = config.get_frontend_model();
        let frontend_client = runtime.client(frontend_model.clone(), "frontend");
        let frontend_agent = DeveloperAgent::with_client(frontend_client, DeveloperType::Frontend);
        
        // DevOps Agent Init
        let mut devops_agent: Option<DevOpsAgent> = None;
        // Designer Agent Init
        let mut designer_agent: Option<DesignerAgent> = None;
        // Reviewer Agent Init
        let mut reviewer_agent: Option<ReviewerAgent> = None;
        // QA Agent Init
        let mut qa_agent: Option<QAAgent> = None;

        // 1. Design Context 로드 (DesignNode에서 이미 생성됨)
        let design_path = state.project_path.join(".daacs/design_system.json");
        let design_context = if design_path.exists() {
            tokio::fs::read_to_string(&design_path).await.unwrap_or_default()
        } else {
            crate::logger::status_update("디자인 시스템 없음 (백엔드 전용 또는 미생성)");
            String::new()
        };

        // 1.5 Load Skills
        let mut skill_loader = SkillLoader::new(&state.project_path);
        let _ = skill_loader.load_all().await;
        let skills_available = skill_loader.has_skills();
        if skills_available {
            let loaded_skills = skill_loader.load_all().await.unwrap_or_default();
            let skill_names: Vec<String> = loaded_skills.iter()
                .map(|s| s.name.clone())
                .collect();
            crate::logger::status_update(&format!("🛠️  Skills Loaded: {:?}", skill_names));
        }
        
        // plan.md 경로 설정
        let plan_path = state.project_path.join("plan.md");

        // [CRITICAL] State Sync with plan.md
        if plan_path.exists() {
            match plan_md::parse_file(&plan_path).await {
                Ok(plan_tasks) => {
                    let mut synced_count = 0;
                    for task in &mut state.tasks {
                        if let Some(plan_task) = plan_tasks.iter().find(|pt| pt.id == task.id) {
                            if matches!(plan_task.status, TaskStatus::Completed) && !matches!(task.status, TaskStatus::Completed) {
                                task.status = TaskStatus::Completed;
                                synced_count += 1;
                            }
                        }
                    }
                    if synced_count > 0 {
                        crate::logger::status_update(&format!("🔄  Synced {} completed tasks from plan.md", synced_count));
                    }
                }
                Err(e) => {
                     crate::logger::log_warning(&format!("Failed to sync with plan.md: {}", e));
                }
            }
        }

        // 1.6 Initialize FileTracker for diff-based modifications
        let mut file_tracker = FileTracker::new(&state.project_path);
        let file_count = file_tracker.scan().unwrap_or(0);
        if file_count > 0 {
            crate::logger::status_update(&format!("FileTracker: {} 기존 파일 추적 중", file_count));
        }

        // 1.7 시스템 컨텍스트 준비 (1회만 전송 - 토큰 절약)
        // [Role-Based Skill Bundles]
        // 1. Frontend: Web Wizard Pack (Standard for React/Next.js)
        crate::logger::status_update("Frontend: Using Web Wizard Bundle");
        let frontend_skills = skill_loader.build_bundle_context("web-wizard").await.ok();

        // 2. Backend: Dynamic Selection (Default to PythonPro for now, could be Node via Essentials)
        let backend_skills = if daacs_content.to_lowercase().contains("node") && !daacs_content.to_lowercase().contains("python") {
             // If expressly Node and not Python, use Essentials to avoid Python pollution
             crate::logger::status_update("Backend: Detected Node.js -> Using Essentials Bundle");
             skill_loader.build_bundle_context("essentials").await.ok()
        } else {
             // Default to Python Pro as requested
             crate::logger::status_update("Backend: Using Python Pro Bundle");
             skill_loader.build_bundle_context("python-pro").await.ok()
        };
        
        // plan.md 요약 (작업 목록)
        let task_summary: String = state.tasks.iter()
            .map(|t| format!("- [{}] {}", t.id, t.name))
            .collect::<Vec<_>>()
            .join("\n");
        
        let backend_system_context = format!(
            r#"당신은 숙련된 백엔드 개발자입니다.

[기술 명세서 (DAACS.md)]
{}

[작업 계획 (plan.md)]
총 {} 개 작업:
{}

[Backend Skills]
{}

이 명세서를 바탕으로 프로젝트를 구현해야 합니다.
앞으로 제가 구체적인 작업을 하나씩 지시할 것입니다.
한 번에 모든 것을 구현하지 말고, **지시받은 작업(Task)에 대해서만** 코드를 작성하세요.
파일을 생성/수정할 때는 전체 파일 내용을 출력하세요.
"#, 
            daacs_content,
            state.tasks.len(),
            task_summary,
            backend_skills.as_deref().unwrap_or("")
        );
        
        let frontend_system_context = format!(
            r#"당신은 숙련된 프론트엔드 개발자입니다.

[기술 명세서 (DAACS.md)]
{}

[디자인 시스템]
{}

[작업 계획 (plan.md)]
총 {} 개 작업:
{}

[Frontend Skills]
{}

이 명세서를 바탕으로 프로젝트를 구현해야 합니다.
앞으로 제가 구체적인 작업을 하나씩 지시할 것입니다.
한 번에 모든 것을 구현하지 말고, **지시받은 작업(Task)에 대해서만** 코드를 작성하세요.
파일을 생성/수정할 때는 전체 파일 내용을 출력하세요.
"#, 
            daacs_content, 
            design_context,
            state.tasks.len(), 
            task_summary, 
            frontend_skills.as_deref().unwrap_or("")
        );

        // Persistent Session Start
        // All tasks completed check
        let all_completed = state.tasks.iter().all(|t| matches!(t.status, TaskStatus::Completed));
        if !all_completed {
            if let Err(e) = backend_agent.start_session(&backend_system_context).await {
                 crate::logger::log_warning(&format!("Backend Session Start Failed: {}", e));
            }
            if let Err(e) = frontend_agent.start_session(&frontend_system_context).await {
                 crate::logger::log_warning(&format!("Frontend Session Start Failed: {}", e));
            }
        } else {
             crate::logger::status_update("⏩  All tasks completed. Skipping session initialization.");
        }

        // 2. Execution Loop with MultiProgress
        let m = MultiProgress::new();
        let overall_style = ProgressStyle::default_bar()
            .template("[{elapsed_precise}] {bar:40.cyan/blue} {pos:>7}/{len:7} {msg}")
            .unwrap()
            .progress_chars("##-");
        
        let overall_pb = m.add(ProgressBar::new(state.tasks.len() as u64));
        overall_pb.set_style(overall_style.clone());
        overall_pb.set_message("Overall Progress");

        for task in state.tasks.clone() {
            // [Dynamic Config Reload]
            let _ = crate::config::settings::reload();
            let config = crate::config::settings::get();
            
            // Skip if already done
            if matches!(task.status, TaskStatus::Completed) {
                overall_pb.inc(1);
                continue;
            }

            update_task_status(state, &task.id, TaskStatus::InProgress);
            let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::InProgress).await;

            let before = capture(&state.project_path);
            
            let task_pb = m.add(ProgressBar::new_spinner());
            task_pb.set_style(ProgressStyle::default_spinner().template("  {spinner:.green} {msg}").unwrap());
            task_pb.enable_steady_tick(Duration::from_millis(100));
            task_pb.set_message(format!("Executing Task {}: {}", task.id, task.name));

            // Use AgentEngine
            // AgentEngine is lightweight, but recreating it rebuilds runtime/skill_loader.
            // Ideally we hoist it out, but for now this matches the logic I intended.
            let mut engine = AgentEngine::new(state.project_path.clone());
            
            let result = engine.execute_task(&task, &daacs_content, &design_context, Some(&task_pb)).await;

            match result {
                Ok(EngineOutcome::Developer(response)) => {
                    attach_output(state, &task.id, TaskOutcome::Developer(response.clone()));
                    // Capture snapshot for verification logging
                    let after = capture(&state.project_path);
                    let changed = diff(&before, &after);
                    let summary = format!("Task {} 변경 파일: {}", task.name, changed.join(", "));
                    task_pb.finish_with_message(format!("✅ Done: {}", summary));
                    
                    update_task_status(state, &task.id, TaskStatus::Completed);
                    let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::Completed).await;
                    overall_pb.inc(1);
                },
                Ok(EngineOutcome::DevOps(res)) => {
                    attach_output(state, &task.id, TaskOutcome::DevOps(res.clone()));
                    task_pb.finish_with_message(format!("✅ DevOps Task Complete: {:?}", res));
                    update_task_status(state, &task.id, TaskStatus::Completed);
                    let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::Completed).await;
                    overall_pb.inc(1);
                },
                Ok(EngineOutcome::Reviewer(res)) => {
                    attach_output(state, &task.id, TaskOutcome::Developer(format!("Approved: {}\n{}", res.approved, res.summary)));
                    task_pb.finish_with_message(format!("✅ Review Complete. Approved: {}", res.approved));
                    update_task_status(state, &task.id, TaskStatus::Completed);
                    let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::Completed).await;
                    overall_pb.inc(1);
                },
                Ok(EngineOutcome::Skipped) => {
                    task_pb.finish_with_message("⏩ Skipped (No Agent logic)");
                    update_task_status(state, &task.id, TaskStatus::Completed);
                    let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::Completed).await;
                    overall_pb.inc(1);
                },
                Err(e) => {
                    task_pb.finish_with_message(format!("❌ Failed: {}", e));
                    update_task_status(state, &task.id, TaskStatus::Failed);
                    let _ = plan_md::update_task_status(&plan_path, &task.id, TaskStatus::Failed).await;
                    overall_pb.set_message(format!("Task {} Failed!", task.id));
                    
                    // Stop on failure
                    // Persistent session clean up
                    backend_agent.stop_session().await;
                    frontend_agent.stop_session().await;
                    return Err(e);
                }
            }
        }

        // ========== Persistent Session 정리 ==========
        backend_agent.stop_session().await;
        frontend_agent.stop_session().await;

        crate::logger::task_complete("plan.md 작업 큐 실행 완료");
        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "OrchestratorNode"
    }
}

enum TaskOutcome {
    Developer(String),
    DevOps(DevOpsResult),
    Skipped,
}

fn update_task_status(state: &mut CLIState, task_id: &str, status: TaskStatus) {
    if let Some(t) = state.tasks.iter_mut().find(|t| t.id == task_id) {
        t.status = status;
    }
}

fn attach_output(state: &mut CLIState, task_id: &str, outcome: TaskOutcome) {
    if let Some(t) = state.tasks.iter_mut().find(|t| t.id == task_id) {
        match outcome {
            TaskOutcome::Developer(response) => t.output = Some(response),
            TaskOutcome::DevOps(result) => {
                t.output = serde_json::to_string(&result).ok();
            }
            TaskOutcome::Skipped => {}
        }
    }
}

fn agent_key(agent: &AgentType) -> &str {
    match agent {
        AgentType::BackendDeveloper => "backend",
        AgentType::FrontendDeveloper => "frontend",
        AgentType::DevOps => "devops",
        _ => "orchestrator",
    }
}

// Helper to extract skill names for logging
#[allow(dead_code)]
fn extract_skill_names(context: &str) -> String {
    context.lines()
        .filter(|line| line.trim().starts_with("- @") || line.contains("Skill:"))
        .map(|line| line.trim().replace("- @", "").replace("Skill:", "").trim().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}
