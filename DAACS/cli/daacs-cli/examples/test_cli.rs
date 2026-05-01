//! LLM CLI 호출 테스트 (Standalone)
//!
//! 실행: cargo run --example test_cli

use std::process::Command;
use std::path::PathBuf;
use std::fs;

fn main() {
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║           DAACS CLI - LLM Provider Test Suite                ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    let test_dir = std::env::temp_dir().join("daacs_cli_test");
    if !test_dir.exists() {
        fs::create_dir_all(&test_dir).unwrap();
    }
    println!("\n📁 Test directory: {:?}\n", test_dir);

    // Claude 테스트
    test_claude(&test_dir);

    // Codex 테스트
    test_codex(&test_dir);

    // Gemini 테스트
    test_gemini(&test_dir);

    println!("\n========== Test Complete ==========\n");
}

fn check_cli_available(cmd: &str) -> bool {
    let result = if cfg!(windows) {
        Command::new("where").arg(cmd).output()
    } else {
        Command::new("which").arg(cmd).output()
    };

    match result {
        Ok(output) => output.status.success(),
        Err(_) => false,
    }
}

fn test_claude(test_dir: &PathBuf) {
    println!("\n========== Claude CLI Test ==========");

    let cmd = if cfg!(windows) { "claude.cmd" } else { "claude" };

    // 1. CLI 존재 여부 확인
    if !check_cli_available(cmd) {
        println!("❌ Claude CLI not found: {}", cmd);
        return;
    }
    println!("✅ Claude CLI found: {}", cmd);

    // 2. 버전 확인
    match Command::new(cmd).arg("--version").output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            println!("✅ Claude version: {}", version.trim());
        }
        Err(e) => {
            println!("⚠️ Version check failed: {}", e);
        }
    }

    // 3. 간단한 프롬프트 테스트
    println!("📤 Testing prompt execution...");

    let result = Command::new(cmd)
        .args(&["--dangerously-skip-permissions", "-p", "Say 'Hello' and nothing else"])
        .current_dir(test_dir)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                println!("✅ Response: {}", stdout.chars().take(100).collect::<String>());
            } else {
                println!("❌ Error: {}", stderr.chars().take(200).collect::<String>());
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}

fn test_codex(test_dir: &PathBuf) {
    println!("\n========== Codex CLI Test ==========");

    let (cmd, base_args): (&str, Vec<&str>) = if cfg!(windows) {
        ("npx", vec!["@openai/codex"])
    } else {
        ("codex", vec![])
    };

    if !check_cli_available(cmd) {
        println!("❌ {} not found", cmd);
        return;
    }
    println!("✅ {} found", cmd);

    // 버전 확인
    let mut version_args = base_args.clone();
    version_args.push("--version");

    match Command::new(cmd).args(&version_args).output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            if !version.is_empty() {
                println!("✅ Codex: {}", version.trim());
            }
        }
        Err(_) => {}
    }

    // Help 테스트
    let mut help_args = base_args.clone();
    help_args.push("--help");

    match Command::new(cmd).args(&help_args).current_dir(test_dir).output() {
        Ok(output) => {
            if output.status.success() {
                println!("✅ Codex CLI available");
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                println!("⚠️ Codex: {}", stderr.chars().take(100).collect::<String>());
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}

fn test_gemini(test_dir: &PathBuf) {
    println!("\n========== Gemini CLI Test ==========");

    let cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };

    if !check_cli_available(cmd) {
        println!("❌ Gemini CLI not found: {}", cmd);
        return;
    }
    println!("✅ Gemini CLI found: {}", cmd);

    // 버전 확인
    match Command::new(cmd).arg("--version").output() {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            println!("✅ Gemini version: {}", version.trim());
        }
        Err(e) => {
            println!("⚠️ Version check: {}", e);
        }
    }

    // Help 테스트
    match Command::new(cmd).arg("--help").current_dir(test_dir).output() {
        Ok(output) => {
            if output.status.success() {
                println!("✅ Gemini CLI responding");
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                println!("⚠️ Gemini: {}", stderr.chars().take(100).collect::<String>());
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}
