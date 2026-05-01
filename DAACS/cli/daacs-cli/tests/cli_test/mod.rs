//! LLM CLI 호출 테스트
//!
//! 각 모델의 CLI가 정상적으로 호출되는지 테스트합니다.
//! - Claude: claude.cmd --dangerously-skip-permissions -p -
//! - Codex: npx @openai/codex exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -
//! - Gemini: gemini.cmd -y

use std::process::Command;
use std::path::PathBuf;
use std::fs;

/// 테스트 디렉토리 경로
fn get_test_dir() -> PathBuf {
    let path = std::env::temp_dir().join("daacs_cli_test");
    if !path.exists() {
        fs::create_dir_all(&path).unwrap();
    }
    path
}

/// CLI 실행 가능 여부 확인
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

/// Claude CLI 테스트
pub fn test_claude_cli() -> (bool, String) {
    println!("\n========== Claude CLI Test ==========");

    let cmd = if cfg!(windows) { "claude.cmd" } else { "claude" };

    // 1. CLI 존재 여부 확인
    if !check_cli_available(cmd) {
        return (false, format!("❌ Claude CLI not found: {}", cmd));
    }
    println!("✅ Claude CLI found: {}", cmd);

    // 2. 버전 확인
    let version_result = Command::new(cmd)
        .arg("--version")
        .output();

    match version_result {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            println!("✅ Claude version: {}", version.trim());
        }
        Err(e) => {
            return (false, format!("❌ Claude version check failed: {}", e));
        }
    }

    // 3. 간단한 프롬프트 테스트 (echo만)
    let test_dir = get_test_dir();
    println!("📁 Test directory: {:?}", test_dir);

    let test_prompt = "Say 'Hello from Claude' and nothing else.";
    println!("📤 Sending prompt: {}", test_prompt);

    let result = Command::new(cmd)
        .args(&["--dangerously-skip-permissions", "-p", test_prompt])
        .current_dir(&test_dir)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);

            if output.status.success() {
                println!("✅ Claude responded: {}", stdout.chars().take(100).collect::<String>());
                (true, format!("Claude CLI working. Response: {}...", stdout.chars().take(50).collect::<String>()))
            } else {
                println!("⚠️ Claude stderr: {}", stderr);
                (false, format!("Claude CLI error: {}", stderr))
            }
        }
        Err(e) => {
            (false, format!("❌ Claude execution failed: {}", e))
        }
    }
}

/// Codex CLI 테스트
pub fn test_codex_cli() -> (bool, String) {
    println!("\n========== Codex CLI Test ==========");

    // Windows에서는 npx를 통해 실행
    let (cmd, base_args): (&str, Vec<&str>) = if cfg!(windows) {
        ("npx.cmd", vec!["@openai/codex"])
    } else {
        ("codex", vec![])
    };

    // 1. npx 또는 codex 존재 여부 확인
    if !check_cli_available(cmd) {
        return (false, format!("❌ {} not found", cmd));
    }
    println!("✅ {} found", cmd);

    // 2. Codex 버전 확인
    let mut version_args = base_args.clone();
    version_args.push("--version");

    let version_result = Command::new(cmd)
        .args(&version_args)
        .output();

    match version_result {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            if !version.is_empty() {
                println!("✅ Codex version: {}", version.trim());
            } else {
                println!("⚠️ Codex version not available (package may need install)");
            }
        }
        Err(e) => {
            println!("⚠️ Codex version check: {}", e);
        }
    }

    // 3. 간단한 테스트 (설치 여부만 확인)
    let test_dir = get_test_dir();
    println!("📁 Test directory: {:?}", test_dir);

    let mut exec_args = base_args.clone();
    exec_args.extend(&["exec", "--help"]);

    let result = Command::new(cmd)
        .args(&exec_args)
        .current_dir(&test_dir)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if output.status.success() || stdout.contains("codex") || stdout.contains("Usage") {
                println!("✅ Codex CLI available");
                (true, "Codex CLI available".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                println!("⚠️ Codex output: {}", stderr.chars().take(100).collect::<String>());
                (false, format!("Codex CLI issue: {}", stderr.chars().take(100).collect::<String>()))
            }
        }
        Err(e) => {
            (false, format!("❌ Codex execution failed: {}", e))
        }
    }
}

/// Gemini CLI 테스트
pub fn test_gemini_cli() -> (bool, String) {
    println!("\n========== Gemini CLI Test ==========");

    let cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };

    // 1. CLI 존재 여부 확인
    if !check_cli_available(cmd) {
        return (false, format!("❌ Gemini CLI not found: {}", cmd));
    }
    println!("✅ Gemini CLI found: {}", cmd);

    // 2. 버전 확인
    let version_result = Command::new(cmd)
        .arg("--version")
        .output();

    match version_result {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output.stdout);
            println!("✅ Gemini version: {}", version.trim());
        }
        Err(e) => {
            println!("⚠️ Gemini version check: {}", e);
        }
    }

    // 3. 도움말 테스트
    let help_result = Command::new(cmd)
        .arg("--help")
        .output();

    match help_result {
        Ok(output) => {
            if output.status.success() {
                println!("✅ Gemini CLI responding");
                (true, "Gemini CLI available".to_string())
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr);
                (false, format!("Gemini CLI error: {}", stderr))
            }
        }
        Err(e) => {
            (false, format!("❌ Gemini execution failed: {}", e))
        }
    }
}

/// 파일 생성 테스트 (실제 LLM 호출)
pub fn test_file_creation_with_claude() -> (bool, String) {
    println!("\n========== File Creation Test (Claude) ==========");

    let cmd = if cfg!(windows) { "claude.cmd" } else { "claude" };

    if !check_cli_available(cmd) {
        return (false, "Claude CLI not available".to_string());
    }

    let test_dir = get_test_dir().join("file_test");
    if test_dir.exists() {
        let _ = fs::remove_dir_all(&test_dir);
    }
    fs::create_dir_all(&test_dir).unwrap();

    let test_file = test_dir.join("hello.txt");
    let prompt = format!(
        "Create a file at '{}' with the content 'Hello from DAACS CLI Test'. Only create the file, no explanation needed.",
        test_file.display()
    );

    println!("📤 Prompt: {}", prompt);
    println!("📁 Expected file: {:?}", test_file);

    let result = Command::new(cmd)
        .args(&["--dangerously-skip-permissions", "-p", &prompt])
        .current_dir(&test_dir)
        .output();

    match result {
        Ok(output) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            println!("📥 Response: {}", stdout.chars().take(200).collect::<String>());

            // 파일 생성 확인
            if test_file.exists() {
                let content = fs::read_to_string(&test_file).unwrap_or_default();
                println!("✅ File created! Content: {}", content);
                (true, format!("File created successfully. Content: {}", content))
            } else {
                println!("❌ File was not created");
                (false, "File was not created".to_string())
            }
        }
        Err(e) => {
            (false, format!("Execution failed: {}", e))
        }
    }
}

/// 파일 생성 테스트 (Codex)
pub fn test_file_creation_with_codex() -> (bool, String) {
    println!("\n========== File Creation Test (Codex) ==========");

    let (cmd, base_args): (&str, Vec<&str>) = if cfg!(windows) {
        ("npx.cmd", vec!["@openai/codex"])
    } else {
        ("codex", vec![])
    };

    if !check_cli_available(cmd) {
        return (false, "Codex CLI not available".to_string());
    }

    let test_dir = get_test_dir().join("codex_test");
    if test_dir.exists() {
        let _ = fs::remove_dir_all(&test_dir);
    }
    fs::create_dir_all(&test_dir).unwrap();

    let test_file = test_dir.join("codex_hello.txt");
    let prompt = format!(
        "Create a file at '{}' with the content 'Hello from Codex'. Only create the file, no explanation needed.",
        test_file.display()
    );

    println!("📤 Prompt: {}", prompt);

    let mut exec_args = base_args.clone();
    exec_args.extend(&[
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-",
    ]);

    let mut child = Command::new(cmd)
        .args(&exec_args)
        .current_dir(&test_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn codex process");

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).unwrap();
    }

    let output = child.wait_with_output().unwrap();

    if output.status.success() {
        if test_file.exists() {
            let content = fs::read_to_string(&test_file).unwrap_or_default();
            println!("✅ File created! Content: {}", content);
            (true, format!("File created successfully. Content: {}", content))
        } else {
            println!("❌ File was not created");
            (false, "File was not created".to_string())
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("❌ Codex failed: {}", stderr);
        (false, format!("Codex failed: {}", stderr))
    }
}

/// 파일 수정 테스트 (Codex)
pub fn test_file_modification_with_codex() -> (bool, String) {
    println!("\n========== File Modification Test (Codex) ==========");

    let (cmd, base_args): (&str, Vec<&str>) = if cfg!(windows) {
        ("npx.cmd", vec!["@openai/codex"])
    } else {
        ("codex", vec![])
    };

    let test_dir = get_test_dir().join("codex_test");
    let test_file = test_dir.join("codex_hello.txt");

    if !test_file.exists() {
        return (false, "Prerequisite file missing (run creation test first)".to_string());
    }

    let prompt = format!(
        "Modify the file '{}'. Change the content to 'Hello from Codex - Modified'. Only modify the file.",
        test_file.display()
    );

    println!("📤 Prompt: {}", prompt);

    let mut exec_args = base_args.clone();
    exec_args.extend(&[
        "exec",
        "--skip-git-repo-check",
        "--dangerously-bypass-approvals-and-sandbox",
        "-",
    ]);

    let mut child = Command::new(cmd)
        .args(&exec_args)
        .current_dir(&test_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn codex process");

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).unwrap();
    }

    let output = child.wait_with_output().unwrap();

    if output.status.success() {
        let content = fs::read_to_string(&test_file).unwrap_or_default();
        if content.contains("Modified") {
            println!("✅ File modified! Content: {}", content);
            (true, format!("File modified successfully. Content: {}", content))
        } else {
            println!("❌ File content not updated: {}", content);
            (false, format!("File content not updated: {}", content))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("❌ Codex failed: {}", stderr);
        (false, format!("Codex failed: {}", stderr))
    }
}

/// 파일 생성 테스트 (Gemini)
pub fn test_file_creation_with_gemini() -> (bool, String) {
    println!("\n========== File Creation Test (Gemini) ==========");

    let cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };

    if !check_cli_available(cmd) {
        return (false, "Gemini CLI not available".to_string());
    }

    let test_dir = get_test_dir().join("gemini_test");
    if test_dir.exists() {
        let _ = fs::remove_dir_all(&test_dir);
    }
    fs::create_dir_all(&test_dir).unwrap();

    let test_file = test_dir.join("gemini_hello.txt");
    let prompt = format!(
        "Create a file at '{}' with the content 'Hello from Gemini'. Only create the file, no explanation needed.",
        test_file.display()
    );

    println!("📤 Prompt: {}", prompt);

    let mut child = Command::new(cmd)
        .args(&["-y"]) // Auto-approve
        .current_dir(&test_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn gemini process");

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).unwrap();
    }

    let output = child.wait_with_output().unwrap();

    if output.status.success() {
        if test_file.exists() {
            let content = fs::read_to_string(&test_file).unwrap_or_default();
            println!("✅ File created! Content: {}", content);
            (true, format!("File created successfully. Content: {}", content))
        } else {
            println!("❌ File was not created");
            (false, "File was not created".to_string())
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("❌ Gemini failed: {}", stderr);
        (false, format!("Gemini failed: {}", stderr))
    }
}

/// 파일 수정 테스트 (Gemini)
pub fn test_file_modification_with_gemini() -> (bool, String) {
    println!("\n========== File Modification Test (Gemini) ==========");

    let cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };

    let test_dir = get_test_dir().join("gemini_test");
    let test_file = test_dir.join("gemini_hello.txt");

    if !test_file.exists() {
        return (false, "Prerequisite file missing (run creation test first)".to_string());
    }

    let prompt = format!(
        "Modify the file '{}'. Change the content to 'Hello from Gemini - Modified'. Only modify the file.",
        test_file.display()
    );

    println!("📤 Prompt: {}", prompt);

    let mut child = Command::new(cmd)
        .args(&["-y"])
        .current_dir(&test_dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .expect("Failed to spawn gemini process");

    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(prompt.as_bytes()).unwrap();
    }

    let output = child.wait_with_output().unwrap();

    if output.status.success() {
        let content = fs::read_to_string(&test_file).unwrap_or_default();
        if content.contains("Modified") {
            println!("✅ File modified! Content: {}", content);
            (true, format!("File modified successfully. Content: {}", content))
        } else {
            println!("❌ File content not updated: {}", content);
            (false, format!("File content not updated: {}", content))
        }
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("❌ Gemini failed: {}", stderr);
        (false, format!("Gemini failed: {}", stderr))
    }
}

/// 모든 CLI 테스트 실행
pub fn run_all_tests() {
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║           DAACS CLI - LLM Provider Test Suite                ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    let mut results: Vec<(&str, bool, String)> = Vec::new();

    // Claude 테스트
    let (ok, msg) = test_claude_cli();
    results.push(("Claude", ok, msg));

    // Codex 테스트
    let (ok, msg) = test_codex_cli();
    results.push(("Codex", ok, msg));

    // Gemini 테스트
    let (ok, msg) = test_gemini_cli();
    results.push(("Gemini", ok, msg));

    // 결과 요약
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║                      Test Results Summary                     ║");
    println!("╠══════════════════════════════════════════════════════════════╣");

    for (name, ok, msg) in &results {
        let status = if *ok { "✅ PASS" } else { "❌ FAIL" };
        println!("║ {:8} | {:8} | {:40} ║", name, status, msg.chars().take(40).collect::<String>());
    }

    println!("╚══════════════════════════════════════════════════════════════╝");

    let passed = results.iter().filter(|(_, ok, _)| *ok).count();
    let total = results.len();

    println!("\n📊 Result: {}/{} CLI providers available", passed, total);

    if passed > 0 {
        println!("\n🧪 Running file creation/modification tests...");
        
        // Claude
        if check_cli_available(if cfg!(windows) { "claude.cmd" } else { "claude" }) {
            let (ok, msg) = test_file_creation_with_claude();
            println!("Claude Creation: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
        }

        // Codex
        let codex_cmd = if cfg!(windows) { "npx.cmd" } else { "codex" };
        if check_cli_available(codex_cmd) {
            let (ok, msg) = test_file_creation_with_codex();
            println!("Codex Creation: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
            
            if ok {
                let (ok, msg) = test_file_modification_with_codex();
                println!("Codex Modification: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
            }
        }

        // Gemini
        let gemini_cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };
        if check_cli_available(gemini_cmd) {
            let (ok, msg) = test_file_creation_with_gemini();
            println!("Gemini Creation: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
            
            if ok {
                let (ok, msg) = test_file_modification_with_gemini();
                println!("Gemini Modification: {} - {}", if ok { "PASS" } else { "FAIL" }, msg);
            }
        }
    }
}
