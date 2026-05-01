//! 그래프 실행 테스트 (mock nodes)

#[cfg(test)]
mod tests {
    use daacs::graph::state::{CLIState, Phase};
    use daacs::graph::workflow::{WorkflowGraph, Node, NodeResult};
    use daacs::graph::edge::{Transition, ConditionalEdge};
    use anyhow::Result;
    use std::path::PathBuf;

    /// Mock Interview Node
    struct MockInterviewNode;

    #[async_trait::async_trait]
    impl Node for MockInterviewNode {
        async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
            state.goal = "테스트 프로젝트".to_string();
            state.interview_context.insert("vibe".to_string(), "미니멀".to_string());
            state.interview_context.insert("platform".to_string(), "웹".to_string());
            Ok(NodeResult::Success)
        }
        
        fn name(&self) -> &str {
            "MockInterviewNode"
        }
    }

    /// Mock Document Node
    struct MockDocumentNode;

    #[async_trait::async_trait]
    impl Node for MockDocumentNode {
        async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
            state.daacs_content = Some("# Test DAACS.md".to_string());
            state.plan_content = Some("# Test plan.md".to_string());
            Ok(NodeResult::Success)
        }
        
        fn name(&self) -> &str {
            "MockDocumentNode"
        }
    }

    /// Mock Confirm Node
    struct MockConfirmNode;

    #[async_trait::async_trait]
    impl Node for MockConfirmNode {
        async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
            state.user_confirmed = true;
            Ok(NodeResult::Success)
        }
        
        fn name(&self) -> &str {
            "MockConfirmNode"
        }
    }

    #[test]
    fn test_cli_state_creation() {
        let state = CLIState::new("테스트 목표", PathBuf::from("/tmp/test"));
        
        assert_eq!(state.goal, "테스트 목표");
        assert_eq!(state.current_phase, Phase::Interview);
        assert_eq!(state.retry_count, 0);
        assert_eq!(state.max_retries, 3);
        assert!(!state.user_confirmed);
    }

    #[test]
    fn test_phase_transitions() {
        let state = CLIState::default();
        
        assert_eq!(state.current_phase, Phase::Interview);
        
        // Phase enum 비교
        assert_ne!(Phase::Interview, Phase::DocumentGeneration);
        assert_eq!(Phase::Complete, Phase::Complete);
    }

    #[test]
    fn test_conditional_edge() {
        let edge = ConditionalEdge::new(|state: &CLIState| {
            if state.user_confirmed {
                Transition::To(Phase::BackendExecution)
            } else {
                Transition::To(Phase::Failed)
            }
        });
        
        // 확인 안됨 -> Failed
        let state = CLIState::default();
        assert_eq!(edge.evaluate(&state), Phase::Failed);
        
        // 확인됨 -> BackendExecution
        let mut confirmed_state = CLIState::default();
        confirmed_state.user_confirmed = true;
        assert_eq!(edge.evaluate(&confirmed_state), Phase::BackendExecution);
    }

    #[test]
    fn test_escalation_path() {
        // Escalation Path: max_retries 초과 시 DocumentGeneration으로
        let edge = ConditionalEdge::new(|state: &CLIState| {
            if state.failed_tasks.is_empty() {
                Transition::To(Phase::Complete)
            } else if state.retry_count < state.max_retries {
                Transition::To(Phase::Retry)
            } else {
                Transition::To(Phase::DocumentGeneration) // Escalation!
            }
        });
        
        // 실패 없음 -> Complete
        let state = CLIState::default();
        assert_eq!(edge.evaluate(&state), Phase::Complete);
        
        // 실패 있고 재시도 가능 -> Retry
        let mut retry_state = CLIState::default();
        retry_state.failed_tasks.push("task1".to_string());
        retry_state.retry_count = 1;
        assert_eq!(edge.evaluate(&retry_state), Phase::Retry);
        
        // 실패 있고 재시도 초과 -> DocumentGeneration (Escalation)
        let mut escalation_state = CLIState::default();
        escalation_state.failed_tasks.push("task1".to_string());
        escalation_state.retry_count = 3;
        escalation_state.max_retries = 3;
        assert_eq!(edge.evaluate(&escalation_state), Phase::DocumentGeneration);
    }

    #[tokio::test]
    async fn test_workflow_graph_creation() {
        let workflow = WorkflowGraph::new();
        
        // WorkflowGraph가 정상 생성되는지 확인
        assert!(true); // 생성 자체가 성공이면 테스트 통과
    }
}
