//! 배너 및 UI 출력

use crate::ui::console::Console;

/// DAACS 배너 출력
pub fn print_banner() {
    let banner = r#"
    ██████╗  █████╗  █████╗  ██████╗ ███████╗
    ██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔════╝
    ██║  ██║███████║███████║██║      ███████╗
    ██║  ██║██╔══██║██╔══██║██║      ╚════██║
    ██████╔╝██║  ██║██║  ██║╚██████╔╝███████║
    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝
    "#;

    let console = Console::new();

    let version = env!("CARGO_PKG_VERSION");
    let cli_type = "codex"; // 기본 우선순위
    let project_dir = std::env::current_dir().unwrap_or_default().display().to_string();

    let subtitle = format!("v{} | CLI: {}", version, cli_type);

    console.print_panel(banner, "DAACS (Digital Autonomous Agent Coding System)", &subtitle);

    println!("  📁 Project: {}", project_dir);
    println!("  🤖 CLI Type: {}", cli_type);
    println!("  💾 Memory: .daacs/memory/");
    println!();

    print_tips();
    println!();
}

/// 팁 출력
pub fn print_tips() {
    let console = Console::new();
    console.print_info("Tips: /help, /init, /model, /clear, /exit");
}

/// Ready 출력
pub fn print_ready() {
    println!("\nReady! 목표 또는 명령을 입력하세요.\n");
}

/// Phase 배너
pub fn print_phase_banner(phase_name: &str) {
    let console = Console::new();
    console.print_panel("", &format!("Phase: {}", phase_name), "");
}

/// 성공 메시지
pub fn print_success(message: &str) {
    let console = Console::new();
    console.print_success(message);
}

/// 오류 메시지
pub fn print_error(message: &str) {
    let console = Console::new();
    console.print_error(message);
}

/// 작업 완료 메시지
pub fn print_task_complete(task_name: &str) {
    let console = Console::new();
    console.print_success(task_name);
}

/// 경고 메시지
pub fn print_warning(message: &str) {
    let console = Console::new();
    console.print_warning(message);
}

/// Goodbye 메시지
pub fn print_goodbye() {
    let console = Console::new();
    console.print_info("안녕히 가세요!");
}

/// 진행 상태 표시
pub fn print_progress(current: usize, total: usize, message: &str) {
    let console = Console::new();
    console.print_info(&format!("{} ({}/{})", message, current, total));
}
