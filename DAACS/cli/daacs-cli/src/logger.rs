//! 로깅 시스템 - SPEC.md Section 1.2 기반
//!
//! 한글 로그, 색상 출력, 파일 로깅을 지원합니다.

use std::io::Write;
use std::sync::Mutex;
use colored::*;
use chrono::Local;
use once_cell::sync::Lazy;

/// 전역 로거 설정
static LOGGER_CONFIG: Lazy<Mutex<LoggerConfig>> = Lazy::new(|| {
    Mutex::new(LoggerConfig::default())
});

/// 로거 설정
#[derive(Debug, Clone)]
#[derive(Default)]
pub struct LoggerConfig {
    pub verbose: bool,
    pub log_file: Option<std::path::PathBuf>,
}


/// 로거 초기화
pub fn init(verbose: bool, log_file: Option<std::path::PathBuf>) {
    let mut config = LOGGER_CONFIG.lock().unwrap();
    config.verbose = verbose;
    config.log_file = log_file;
    
    // env_logger 초기화 (외부 라이브러리 로그용)
    if std::env::var("RUST_LOG").is_err() {
        std::env::set_var("RUST_LOG", if verbose { "debug" } else { "info" });
    }
    let _ = env_logger::try_init();
}

/// Phase 시작 로그
pub fn phase_start(name: &str) {
    let msg = format!("\n🚀 Phase: {}", name).bold().cyan();
    println!("{}", msg);
    log_to_file(&format!("[PHASE] {}", name));
}

/// Task 완료 로그
pub fn task_complete(name: &str) {
    let msg = format!("✅ {}", name).green();
    println!("{}", msg);
    log_to_file(&format!("[DONE] {}", name));
}

/// 상태 업데이트 로그
pub fn status_update(msg: &str) {
    println!("   ℹ️ {}", msg);
    log_to_file(&format!("[INFO] {}", msg));
}

/// 프롬프트 전송 로그
pub fn prompt_sent(model: &str) {
    let msg = format!("   📤 Sending prompt to {}", model).dimmed();
    println!("{}", msg);
    log_to_file(&format!("[PROMPT] -> {}", model));
}

/// 응답 수신 로그
pub fn response_received(model: &str) {
    let msg = format!("   📥 Received response from {}", model).dimmed();
    println!("{}", msg);
    log_to_file(&format!("[RESPONSE] <- {}", model));
}

/// 경고 로그
pub fn log_warning(msg: &str) {
    let text = format!("⚠️ {}", msg).yellow();
    println!("{}", text);
    log_to_file(&format!("[WARN] {}", msg));
}

/// 에러 로그
pub fn log_error(msg: &str) {
    let text = format!("❌ {}", msg).red().bold();
    eprintln!("{}", text);
    log_to_file(&format!("[ERROR] {}", msg));
}

/// 디버그 로그
pub fn log_debug(msg: &str) {
    let config = LOGGER_CONFIG.lock().unwrap();
    if config.verbose {
        let text = format!("   🐛 DEBUG: {}", msg).bright_black();
        println!("{}", text);
        // 디버그는 파일에는 기록하지 않음 (선택사항)
    }
}

/// 파일에 로그 기록
fn log_to_file(msg: &str) {
    let config = LOGGER_CONFIG.lock().unwrap();
    if let Some(path) = &config.log_file {
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path) 
        {
            let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
            let _ = writeln!(file, "[{}] {}", timestamp, msg);
        }
    }
}
