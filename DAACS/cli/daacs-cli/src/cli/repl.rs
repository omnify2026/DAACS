//! REPL 실행 - DAACS CLI

use std::io;

use colored::*;

use crate::cli::commands::handle_command;
use crate::ui::banner;

/// REPL 실행
pub async fn run_repl() -> anyhow::Result<()> {
    clear_screen();

    banner::print_banner();
    banner::print_ready();

    let prompt_symbol = ">".bright_cyan().bold().to_string();

    loop {
        // Inquire Text Prompt
        let result = inquire::Text::new(&prompt_symbol)
            .with_render_config(get_repl_render_config())
            .prompt();

        let input = match result {
            Ok(s) => s,
            Err(inquire::InquireError::OperationCanceled) => {
                // Ctrl-C
                break;
            }
            Err(inquire::InquireError::IO(_)) => {
                // Ctrl-D or Pipe closed
                break;
            }
            Err(e) => {
                banner::print_error(&format!("입력 오류: {}", e));
                continue;
            }
        };

        let input = input.trim();
        if input.is_empty() {
            continue;
        }

        match input {
            "/exit" | "/quit" => {
                banner::print_goodbye();
                break;
            }
            "/clear" => {
                clear_screen();
                banner::print_banner();
                banner::print_ready();
                continue;
            }
            "/help" => {
                print_help();
                continue;
            }
            _ => {}
        }

        match handle_command(&input).await {
            Ok(response) => {
                if !response.is_empty() {
                    println!();
                    println!("{}", response);
                    println!();
                }
            }
            Err(e) => {
                println!();
                banner::print_error(&format!("오류: {}", e));
                println!();
            }
        }
    }

    Ok(())
}

fn get_repl_render_config() -> inquire::ui::RenderConfig<'static> {
    let mut config = inquire::ui::RenderConfig::default();
    config.prompt_prefix = inquire::ui::Styled::new(""); // Remove '?'
    config.answered_prompt_prefix = inquire::ui::Styled::new("");
    config
}

fn clear_screen() {
    if cfg!(target_os = "windows") {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "cls"].as_ref())
            .status();
    } else {
        let _ = std::process::Command::new("clear").status();
    }
}

fn print_help() {
    println!();
    println!("{}", "========================================".bright_black());
    println!("{}", "  📌 DAACS CLI 도움말".bright_cyan().bold());
    println!("{}", "========================================".bright_black());
    println!();

    print_command_help("/init", "새 프로젝트 생성 (목표 + 폴더)");
    print_command_help("/resume", "세션 복원");
    print_command_help("/sessions", "세션 목록/관리");
    print_command_help("/model", "모델 설정 조회/변경");
    print_command_help("/fix <문제>", "Council 합의로 해결안 도출");
    print_command_help("/rescue <model>", "다른 모델로 이어서 실행");
    print_command_help("/design", "DESIGN.md 생성");
    print_command_help("/cd <경로>", "작업 경로 변경");
    print_command_help("/agent <페르소나>", "페르소나 설정");
    print_command_help("/agent off", "페르소나 해제");
    print_command_help("/agent status", "에이전트 상태 확인");
    print_command_help("/bundle <name>", "스킬 번들 설정 (list/off)");
    print_command_help("/mcp <명령>", "MCP 서버 관리 (list/connect/disconnect)");
    print_command_help("/status", "현재 상태 표시");
    print_command_help("/clear", "화면 지우기");
    print_command_help("/help", "도움말");
    print_command_help("/exit", "종료");

    println!();
    println!("{}", "========================================".bright_black());
    println!();
}

fn print_command_help(cmd: &str, desc: &str) {
    println!("  {} - {}", cmd.bright_green().bold(), desc.white());
}
