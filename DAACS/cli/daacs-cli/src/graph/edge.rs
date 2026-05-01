//! 조건부 엣지 & Escalation Path 구현 - SPEC.md Section 3.2 기반

use crate::graph::state::{CLIState, Phase};

/// 전이 결과
#[derive(Debug, Clone)]
pub enum Transition {
    To(Phase),
}

impl Transition {
    /// Phase 추출
    pub fn into_phase(self) -> Phase {
        match self {
            Transition::To(phase) => phase,
        }
    }
}

/// 조건부 엣지 - 상태에 따라 다음 Phase 결정
pub struct ConditionalEdge {
    evaluator: Box<dyn Fn(&CLIState) -> Transition + Send + Sync>,
}

impl ConditionalEdge {
    /// 새 조건부 엣지 생성
    pub fn new<F>(evaluator: F) -> Self
    where
        F: Fn(&CLIState) -> Transition + Send + Sync + 'static,
    {
        Self {
            evaluator: Box::new(evaluator),
        }
    }
    
    /// 조건 평가
    pub fn evaluate(&self, state: &CLIState) -> Phase {
        (self.evaluator)(state).into_phase()
    }
}
