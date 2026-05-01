//! 재시도 노드 - SPEC.md Section 3.2 기반
//!
//! 실패한 작업을 분석하고 재시도 전략을 수립합니다.
//! Exponential Backoff 및 전략 수정 포함.

use anyhow::Result;
use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};
use std::time::Duration;

pub struct RetryNode;

#[async_trait::async_trait]
impl Node for RetryNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("재시도 (Self-Correction)");
        
        state.retry_count += 1;
        
        // 1. 실패 원인 분석
        let failed_tasks = state.failed_tasks.join(", ");
        crate::logger::log_warning(&format!(
            "실패한 작업: {} (시도 {}/{})", 
            failed_tasks, state.retry_count, state.max_retries
        ));
        
        // 2. Backoff 대기
        let delay = Duration::from_secs(2u64.pow(state.retry_count - 1));
        crate::logger::status_update(&format!("{}초 대기 후 재시도...", delay.as_secs()));
        tokio::time::sleep(delay).await;
        
        // 3. 상태 초기화 (실패 목록 클리어)
        state.failed_tasks.clear();
        state.error = None;
        
        crate::logger::task_complete("재시도 준비 완료");
        
        Ok(NodeResult::Success)
    }
    
    fn name(&self) -> &str {
        "RetryNode"
    }
}
