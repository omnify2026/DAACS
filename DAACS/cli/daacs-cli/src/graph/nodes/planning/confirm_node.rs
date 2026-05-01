//! 사용자 확인 노드 - 생성된 문서 확인/수정 요청 처리

use anyhow::Result;
use std::io::{self, Write};

use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};

pub struct ConfirmNode;

#[async_trait::async_trait]
impl Node for ConfirmNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("사용자 확인");

        println!("\n📄 생성된 문서를 확인해 주세요:");
        println!("   - {}", state.daacs_path.as_ref().unwrap().display());
        println!("   - {}", state.plan_path.as_ref().unwrap().display());

        if state.auto_mode {
            crate::logger::status_update("🚀 Auto-Pilot: 사용자 확인 자동 승인");
            state.user_confirmed = true;
            state.confirmation_message = None;
            return Ok(NodeResult::Success);
        }

        print!("\n승인하시겠습니까? (y/n/수정요청): ");
        io::stdout().flush()?;

        let is_test = std::env::var("DAACS_TEST_MODE").is_ok();
        let input = if is_test {
            "y".to_string()
        } else {
            let mut input = String::new();
            io::stdin().read_line(&mut input)?;
            input.trim().to_string()
        };

        if input.eq_ignore_ascii_case("y") {
            state.user_confirmed = true;
            state.confirmation_message = None;
            crate::logger::task_complete("사용자 승인 완료");
        } else if input.eq_ignore_ascii_case("n") {
            state.user_confirmed = false;
            state.confirmation_message = None;
            crate::logger::log_warning("사용자가 거절했습니다. 종료합니다.");
        } else {
            state.user_confirmed = false;
            state.confirmation_message = Some(input.to_string());
            crate::logger::status_update(&format!("수정 요청 접수: {}", input));
        }

        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "ConfirmNode"
    }
}
