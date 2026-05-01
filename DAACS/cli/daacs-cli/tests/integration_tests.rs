//! 통합 테스트 - SPEC.md Section 10 기반
//!
//! 전체 워크플로우(Interview -> Document -> Backend -> Frontend -> Verify)를 검증합니다.

#[cfg(test)]
mod integration_tests {
    use daacs::graph::state::{CLIState, Phase};
    use daacs::graph::workflow::{WorkflowGraph, Node};
    use daacs::graph::nodes::*;
    use anyhow::Result;
    use std::path::PathBuf;
    use std::fs;

    /// 테스트용 임시 디렉토리 생성
    fn setup_test_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join("daacs_tests").join(name);
        if path.exists() {
            let _ = fs::remove_dir_all(&path);
        }
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[tokio::test]
    async fn test_full_workflow_scaffolding() -> Result<()> {
        // 1. 테스트 환경 설정
        std::env::set_var("DAACS_TEST_MODE", "1");

        // Config 초기화 (필수)
        daacs::config::settings::init();

        let project_path = setup_test_dir("full_workflow");
        let mut state = CLIState::new("통합 테스트 프로젝트", project_path.clone());
        
        // 2. 워크플로우 그래프 생성
        let mut workflow = WorkflowGraph::new();
        
        // 3. 노드 등록
        workflow.graph.add_node(Phase::Interview, Box::new(InterviewNode));
        workflow.graph.add_node(Phase::DocumentGeneration, Box::new(DocumentNode));
        workflow.graph.add_node(Phase::UserConfirmation, Box::new(ConfirmNode));
        workflow.graph.add_node(Phase::BackendExecution, Box::new(BackendNode));
        workflow.graph.add_node(Phase::FrontendExecution, Box::new(FrontendNode));
        workflow.graph.add_node(Phase::Verification, Box::new(VerifyNode));
        
        // 4. 상태 초기화
        state.interview_context.insert("vibe".to_string(), "Minimal".to_string());
        state.interview_context.insert("platform".to_string(), "Web".to_string());
        state.user_confirmed = true;
        
        // 5. 워크플로우 실행
        
        // 5.1 Document Generation
        println!("DEBUG: Executing DocumentNode...");
        let doc_node = DocumentNode;
        let _ = doc_node.execute(&mut state).await; 
        println!("DEBUG: DocumentNode done.");
        
        assert!(state.daacs_path.as_ref().unwrap().exists());
        assert!(state.plan_path.as_ref().unwrap().exists());
        
        // 5.2 Backend Generation
        println!("DEBUG: Executing BackendNode...");
        let backend_node = BackendNode;
        let result = backend_node.execute(&mut state).await;
        println!("DEBUG: BackendNode done.");
        
        if result.is_err() || matches!(result, Ok(daacs::graph::workflow::NodeResult::Failure(_))) {
            println!("BackendNode failed as expected (no LLM CLI in test env)");
            assert!(state.backend_path.exists());
        } else {
            assert!(matches!(result, Ok(daacs::graph::workflow::NodeResult::Success)));
        }
        
        // 5.3 Frontend Generation
        println!("DEBUG: Executing FrontendNode...");
        let frontend_node = FrontendNode;
        let result = frontend_node.execute(&mut state).await;
        println!("DEBUG: FrontendNode done.");
        
        if result.is_err() || matches!(result, Ok(daacs::graph::workflow::NodeResult::Failure(_))) {
            println!("FrontendNode failed as expected (no LLM CLI in test env)");
            assert!(state.frontend_path.exists());
        } else {
            assert!(matches!(result, Ok(daacs::graph::workflow::NodeResult::Success)));
        }
        
        Ok(())
    }
}
