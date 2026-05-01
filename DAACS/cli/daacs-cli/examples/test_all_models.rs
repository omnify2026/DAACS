//! 모든 LLM CLI 파일 생성 테스트
//!
//! 실행: cargo run --example test_all_models

use std::process::{Command, Stdio};
use std::io::Write;
use std::path::PathBuf;
use std::fs;

fn main() {
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║       DAACS - Multi-Model File Creation Test Suite           ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    let base_test_dir = std::env::temp_dir().join("daacs_model_test");
    if base_test_dir.exists() {
        let _ = fs::remove_dir_all(&base_test_dir);
    }
    fs::create_dir_all(&base_test_dir).unwrap();

    println!("\n📁 Base test directory: {:?}\n", base_test_dir);

    // Claude 테스트
    let claude_dir = base_test_dir.join("claude");
    fs::create_dir_all(&claude_dir).unwrap();
    test_model("Claude", &claude_dir, execute_claude);

    // Codex 테스트
    let codex_dir = base_test_dir.join("codex");
    fs::create_dir_all(&codex_dir).unwrap();
    test_model("Codex", &codex_dir, execute_codex);

    // Gemini 테스트
    let gemini_dir = base_test_dir.join("gemini");
    fs::create_dir_all(&gemini_dir).unwrap();
    test_model("Gemini", &gemini_dir, execute_gemini);

    // 최종 결과 요약
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║                    Final Results Summary                      ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    for model in ["claude", "codex", "gemini"] {
        let dir = base_test_dir.join(model);
        println!("\n📂 {} results:", model.to_uppercase());
        list_directory(&dir);
    }

    println!("\n✅ All tests complete!\n");
}

/// 모델별 테스트 실행
fn test_model(
    model_name: &str,
    test_dir: &PathBuf,
    executor: fn(&str, &PathBuf) -> Result<String, String>,
) {
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║  Testing: {:^50} ║", model_name);
    println!("╚══════════════════════════════════════════════════════════════╝");

    // 테스트 1: 텍스트 파일 생성
    test_create_file(model_name, test_dir, executor);

    // 테스트 2: Python 파일 생성
    test_create_python(model_name, test_dir, executor);

    // 테스트 3: 파일 수정
    test_modify_file(model_name, test_dir, executor);
}

/// 텍스트 파일 생성 테스트
fn test_create_file(
    model_name: &str,
    test_dir: &PathBuf,
    executor: fn(&str, &PathBuf) -> Result<String, String>,
) {
    println!("\n--- Test 1: Create Text File ---");

    let file_path = test_dir.join("hello.txt");
    let prompt = format!(
        "Create a file named 'hello.txt' in the current directory containing exactly: 'Hello from {} test!'",
        model_name
    );

    println!("📤 Prompt: {}", prompt);

    match executor(&prompt, test_dir) {
        Ok(response) => {
            println!("📥 Response: {}...", response.chars().take(100).collect::<String>());

            if file_path.exists() {
                let content = fs::read_to_string(&file_path).unwrap_or_default();
                println!("✅ {} - File created: '{}'", model_name, content.trim());
            } else {
                println!("❌ {} - File not created", model_name);
                list_directory(test_dir);
            }
        }
        Err(e) => {
            println!("❌ {} - Error: {}", model_name, e);
        }
    }
}

/// Python 파일 생성 테스트
fn test_create_python(
    model_name: &str,
    test_dir: &PathBuf,
    executor: fn(&str, &PathBuf) -> Result<String, String>,
) {
    println!("\n--- Test 2: Create Python File ---");

    let prompt = "Create a Python file named 'calc.py' with a function multiply(a, b) that returns a * b, and a main block that prints multiply(6, 7).";

    println!("📤 Prompt: Create calc.py");

    match executor(prompt, test_dir) {
        Ok(response) => {
            println!("📥 Response: {}...", response.chars().take(100).collect::<String>());

            let file_path = test_dir.join("calc.py");
            if file_path.exists() {
                let content = fs::read_to_string(&file_path).unwrap_or_default();
                println!("✅ {} - Python file created:", model_name);
                println!("--- calc.py ---\n{}\n---------------", content);
            } else {
                println!("❌ {} - Python file not created", model_name);
                list_directory(test_dir);
            }
        }
        Err(e) => {
            println!("❌ {} - Error: {}", model_name, e);
        }
    }
}

/// 파일 수정 테스트
fn test_modify_file(
    model_name: &str,
    test_dir: &PathBuf,
    executor: fn(&str, &PathBuf) -> Result<String, String>,
) {
    println!("\n--- Test 3: Modify Existing File ---");

    let file_path = test_dir.join("config.ini");
    fs::write(&file_path, "[settings]\nversion=1.0\n").unwrap();
    println!("📝 Created config.ini with: [settings] version=1.0");

    let prompt = "Add a new line 'author=DAACS' under the [settings] section in config.ini";

    println!("📤 Prompt: Add author=DAACS");

    match executor(prompt, test_dir) {
        Ok(response) => {
            println!("📥 Response: {}...", response.chars().take(100).collect::<String>());

            let content = fs::read_to_string(&file_path).unwrap_or_default();
            if content.contains("author") {
                println!("✅ {} - File modified:", model_name);
                println!("{}", content);
            } else {
                println!("⚠️ {} - File unchanged:", model_name);
                println!("{}", content);
            }
        }
        Err(e) => {
            println!("❌ {} - Error: {}", model_name, e);
        }
    }
}

// ============================================================================
// Model Executors
// ============================================================================

/// Claude CLI 실행 (stdin)
fn execute_claude(prompt: &str, working_dir: &PathBuf) -> Result<String, String> {
    let cmd = if cfg!(windows) { "claude.cmd" } else { "claude" };

    let mut child = Command::new(cmd)
        .args(&["--dangerously-skip-permissions", "-p", "-"])
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Claude: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())
            .map_err(|e| format!("stdin error: {}", e))?;
    }

    let output = child.wait_with_output()
        .map_err(|e| format!("wait error: {}", e))?;

    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).to_string())
    }
}

/// Codex CLI 실행
fn execute_codex(prompt: &str, working_dir: &PathBuf) -> Result<String, String> {
    // Windows: npx @openai/codex exec
    let (cmd, base_args): (&str, Vec<&str>) = if cfg!(windows) {
        ("npx", vec!["@openai/codex"])
    } else {
        ("codex", vec![])
    };

    let mut args = base_args.clone();
    args.extend(&["exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "-"]);

    let mut child = Command::new(cmd)
        .args(&args)
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Codex: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())
            .map_err(|e| format!("stdin error: {}", e))?;
    }

    let output = child.wait_with_output()
        .map_err(|e| format!("wait error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        // Codex sometimes outputs to stderr even on success
        if !stdout.is_empty() {
            Ok(stdout)
        } else {
            Err(stderr)
        }
    }
}

/// Gemini CLI 실행
fn execute_gemini(prompt: &str, working_dir: &PathBuf) -> Result<String, String> {
    let cmd = if cfg!(windows) { "gemini.cmd" } else { "gemini" };

    // Gemini uses -y for auto-approve and takes prompt directly
    let mut child = Command::new(cmd)
        .args(&["-y", prompt])
        .current_dir(working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn Gemini: {}", e))?;

    let output = child.wait_with_output()
        .map_err(|e| format!("wait error: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        if !stdout.is_empty() {
            Ok(stdout)
        } else {
            Err(stderr)
        }
    }
}

/// 디렉토리 내용 출력
fn list_directory(dir: &PathBuf) {
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                println!("   📄 {} ({} bytes)", name, size);
            }
        }
        Err(_) => println!("   (empty or error)"),
    }
}
