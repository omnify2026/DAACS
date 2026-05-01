//! 문서 생성 노드 - DAACS.md와 plan.md를 생성합니다.

use anyhow::Result;

use crate::agents::agent_runtime::AgentRuntime;
use crate::agents::architect::ArchitectAgent;
use crate::document::{daacs_md, plan_md};
use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};

pub struct DocumentNode;

#[async_trait::async_trait]
impl Node for DocumentNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("문서 생성");

        let config = crate::config::settings::get();
        let architect_model = config.get_architect_model();

        let mut runtime = AgentRuntime::new(&state.project_path);
        let client = runtime.client(architect_model, "architect");
        let architect = ArchitectAgent::with_client(client);

        // 1) DAACS.md 생성
        crate::logger::status_update("Step 1/2: DAACS.md 생성 중...");

        let daacs_content = match architect.generate_daacs_md(
            &state.goal,
            &state.interview_context,
            &state.tech_stack,
            &state.features,
        ).await {
            Ok(content) => content,
            Err(e) => {
                crate::logger::log_warning(&format!("Architect 실행 실패: {}", e));
                crate::logger::log_warning("샘플 기반 기본 명세로 대체합니다.");
                daacs_md::generate_template(
                    &state.goal,
                    &state.tech_stack,
                    &state.features,
                    &state.interview_context
                )
            }
        };

        let daacs_path = state.project_path.join("DAACS.md");
        if !daacs_path.exists() {
            daacs_md::save_file(&daacs_path, &daacs_content).await?;
        }

        state.daacs_content = Some(daacs_content.clone());
        state.daacs_path = Some(daacs_path.clone());

        crate::logger::task_complete(&format!("DAACS.md 생성 완료 ({})", daacs_path.display()));

        // 2) plan.md 생성
        crate::logger::status_update("Step 2/2: plan.md 생성 중...");

        let mut tasks = match architect.generate_plan_md(&daacs_content, &state.tech_stack).await {
            Ok(tasks) => tasks,
            Err(e) => {
                crate::logger::log_warning(&format!("plan.md 생성 실패: {}", e));
                crate::logger::log_warning("기본 Task 목록으로 대체합니다.");
                crate::agents::architect::create_default_tasks()
            }
        };
        if tasks.is_empty() {
            crate::logger::log_warning("plan.md 파싱 결과가 비어 있습니다. 기본 Task로 대체합니다.");
            tasks = crate::agents::architect::create_default_tasks();
        }

        state.tasks = tasks.clone();

        let plan_path = state.project_path.join("plan.md");
        let plan_content = match tokio::fs::read_to_string(&plan_path).await {
            Ok(content) => content,
            Err(_) => {
                let content = plan_md::generate_template(&tasks);
                tokio::fs::write(&plan_path, &content).await?;
                content
            }
        };

        state.plan_content = Some(plan_content);
        state.plan_path = Some(plan_path.clone());

        crate::logger::task_complete(&format!("plan.md 생성 완료 ({} tasks)", tasks.len()));

        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "DocumentNode"
    }
}
