//! 워크플로우 노드 모듈
//!
//! 각 Phase를 처리하는 노드들을 정의합니다.
pub mod planning;
pub mod execution;
pub mod finalize;

// Re-export specific nodes for flattened access (Facade Pattern)
pub use planning::{InterviewNode, ConfirmNode, DocumentNode};
pub use execution::{OrchestratorNode, RefactorNode, RetryNode, DesignNode};
pub use finalize::DocumentationNode;
