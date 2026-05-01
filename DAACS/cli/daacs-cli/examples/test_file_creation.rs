//! 파일 생성 테스트 - Claude CLI로 실제 파일 생성 (stdin 사용)
//!
//! 실행: cargo run --example test_file_creation

use std::process::{Command, Stdio};
use std::io::Write;
use std::path::PathBuf;
use std::fs;

fn main() {
    println!("\n");
    println!("╔══════════════════════════════════════════════════════════════╗");
    println!("║           DAACS - File Creation Test with Claude             ║");
    println!("╚══════════════════════════════════════════════════════════════╝");

    let test_dir = std::env::temp_dir().join("daacs_file_test");

    // 기존 테스트 디렉토리 삭제 후 재생성
    if test_dir.exists() {
        let _ = fs::remove_dir_all(&test_dir);
    }
    fs::create_dir_all(&test_dir).unwrap();

    println!("\n📁 Test directory: {:?}\n", test_dir);

    // 테스트 1: 단순 텍스트 파일 생성
    test_create_text_file(&test_dir);

    // 테스트 2: Python 파일 생성
    test_create_python_file(&test_dir);

    // 테스트 3: 파일 수정
    test_modify_file(&test_dir);

    // 결과 확인
    println!("\n========== Final Directory Contents ==========");
    list_directory(&test_dir);

    println!("\n✅ Test Complete!\n");
}

/// Claude CLI를 stdin으로 실행 (실제 구현과 동일한 방식)
fn execute_claude_stdin(prompt: &str, working_dir: &PathBuf) -> Result<String, String> {
    let cmd = if cfg!(windows) { "claude.cmd" } else { "claude" };

    let mut child = Command::new(cmd)
        .args(&["--dangerously-skip-permissions", "-p", "-"])
        .current_dir(working_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn: {}", e))?;

    // stdin에 프롬프트 전송
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())
            .map_err(|e| format!("Failed to write stdin: {}", e))?;
    }

    let output = child.wait_with_output()
        .map_err(|e| format!("Failed to wait: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if output.status.success() {
        Ok(stdout)
    } else {
        Err(format!("Command failed: {}", stderr))
    }
}

fn test_create_text_file(test_dir: &PathBuf) {
    println!("\n========== Test 1: Create Text File ==========");

    let file_path = test_dir.join("hello.txt");

    let prompt = format!(
        "Create a text file at exactly this path: {}
The file should contain only: 'Hello from DAACS CLI Test!'
No explanation, just create the file.",
        file_path.display()
    );

    println!("📤 Prompt: Create hello.txt");
    println!("📍 Path: {:?}", file_path);

    match execute_claude_stdin(&prompt, test_dir) {
        Ok(response) => {
            println!("📥 Claude response: {}", response.chars().take(150).collect::<String>());

            if file_path.exists() {
                let content = fs::read_to_string(&file_path).unwrap_or_default();
                println!("✅ File created! Content: '{}'", content.trim());
            } else {
                println!("❌ File was not created at expected path");
                list_directory(test_dir);
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}

fn test_create_python_file(test_dir: &PathBuf) {
    println!("\n========== Test 2: Create Python File ==========");

    let prompt = "Create a Python file named 'calculator.py' in the current directory with:
1. A function add(a, b) that returns a + b
2. A function subtract(a, b) that returns a - b
3. A main block that prints add(5, 3)
Just create the file, no explanation needed.";

    println!("📤 Prompt: Create calculator.py");

    match execute_claude_stdin(prompt, test_dir) {
        Ok(response) => {
            println!("📥 Claude response: {}", response.chars().take(150).collect::<String>());

            let file_path = test_dir.join("calculator.py");
            if file_path.exists() {
                let content = fs::read_to_string(&file_path).unwrap_or_default();
                println!("✅ Python file created!");
                println!("--- calculator.py ---");
                println!("{}", content);
                println!("---------------------");
            } else {
                println!("❌ Python file was not created");
                list_directory(test_dir);
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}

fn test_modify_file(test_dir: &PathBuf) {
    println!("\n========== Test 3: Modify Existing File ==========");

    let file_path = test_dir.join("config.txt");

    // 먼저 파일 생성
    fs::write(&file_path, "version=1.0\nname=test\n").unwrap();
    println!("📝 Created initial file: config.txt");
    println!("   Original content: version=1.0, name=test");

    let prompt = format!(
        "Modify the file at {} to add a new line 'author=DAACS' at the end.",
        file_path.display()
    );

    println!("📤 Prompt: Add 'author=DAACS' to config.txt");

    match execute_claude_stdin(&prompt, test_dir) {
        Ok(response) => {
            println!("📥 Claude response: {}", response.chars().take(150).collect::<String>());

            let content = fs::read_to_string(&file_path).unwrap_or_default();
            if content.contains("author=DAACS") {
                println!("✅ File modified successfully!");
                println!("   New content:\n{}", content);
            } else {
                println!("⚠️ File content unchanged or different modification:");
                println!("   Content:\n{}", content);
            }
        }
        Err(e) => {
            println!("❌ Execution failed: {}", e);
        }
    }
}

fn list_directory(dir: &PathBuf) {
    println!("📂 Contents of {:?}:", dir);
    match fs::read_dir(dir) {
        Ok(entries) => {
            for entry in entries.flatten() {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let file_type = if path.is_dir() { "DIR" } else { "FILE" };
                println!("   {} {:8} bytes - {}", file_type, size, name);
            }
        }
        Err(e) => {
            println!("   Error reading directory: {}", e);
        }
    }
}
