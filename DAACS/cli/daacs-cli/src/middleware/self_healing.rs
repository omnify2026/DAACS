//! Self-Healing Middleware (Healer)
//!
//! Intercepts execution errors and attempts to fix them autonomously using GLM-4.7-Flash.
//! Implements "Fail-Fast" and "Smart Trigger" logic.

use anyhow::{Result, Context};
use std::path::{Path, PathBuf};
use tokio::fs;
use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};

pub enum EscalationReason {
    Fixed,
    Unfixable(String),
    EscalateToCouncil(String),
}

pub struct Healer {
    model: ModelProvider,
}

impl Healer {
    pub fn new() -> Self {
        Self {
            // Explicitly use GLM-4.7-Flash for Fail-Fast speed
            model: ModelProvider::GLM,
        }
    }

    /// Verifies the project code based on Smart Triggers.
    /// Returns:
    /// - Ok(()) if verification passes or no relevant files changed.
    /// - Err(String) containing the error log if verification fails.
    pub async fn verify_code(&self, project_path: &Path) -> Result<()> {
        crate::logger::status_update("🏥 Healer: Verifying code integrity (Smart Trigger)...");

        // Simple heuristic: Check for presence of Cargo.toml or *.py files
        // In a real implementation with FileTracker, we passed changed files.
        // Here we scan the root to decide the strategy.
        
        let has_cargo = project_path.join("Cargo.toml").exists();
        let has_py = self.has_extension(project_path, "py").await;
        let has_ts = self.has_extension(project_path, "ts").await;

        // 1. Rust Check
        if has_cargo {
            crate::logger::log_debug("Trigger: Rust project detected. Running `cargo check`...");
            let output = tokio::process::Command::new("cargo")
                .arg("check")
                .arg("--message-format=short")
                .current_dir(project_path)
                .output()
                .await?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                return Err(anyhow::anyhow!("Rust Compilation Error:\n{}", stderr));
            }
        }

        // 2. Python Check
        if has_py {
            crate::logger::log_debug("Trigger: Python files detected. Running `py_compile`...");
            // Python check is trickier across OS, using python3 or python
             let python_cmd = if cfg!(windows) { "python" } else { "python3" };
             let output = tokio::process::Command::new(python_cmd)
                .arg("-m")
                .arg("compileall")
                .arg("-q")
                .arg(".")
                .current_dir(project_path)
                .output()
                .await?;
            
            if !output.status.success() {
                 let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                 // compileall might return 1 if *any* file fails
                 return Err(anyhow::anyhow!("Python Syntax Error:\n{}", stderr));
            }
        }

        // 3. TypeScript Check (Basic tsc)
        if has_ts {
             crate::logger::log_debug("Trigger: TypeScript detected. Running `tsc --noEmit`...");
             // Check if tsc exists first? Assuming yes or skip.
             let output = if cfg!(windows) {
                 tokio::process::Command::new("cmd")
                    .args(&["/C", "npx tsc --noEmit"])
                    .current_dir(project_path)
                    .output()
                    .await
             } else {
                 tokio::process::Command::new("npx")
                    .args(&["tsc", "--noEmit"])
                    .current_dir(project_path)
                    .output()
                    .await
             };

             if let Ok(out) = output {
                 if !out.status.success() {
                     let stdout = String::from_utf8_lossy(&out.stdout).to_string(); // tsc often prints to stdout
                     return Err(anyhow::anyhow!("TypeScript Error:\n{}", stdout));
                 }
             }
        }

        Ok(())
    }

    async fn has_extension(&self, dir: &Path, ext: &str) -> bool {
        let mut read_dir = match fs::read_dir(dir).await {
            Ok(rd) => rd,
            Err(_) => return false,
        };
        
        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let path = entry.path();
            if path.is_file() {
                if let Some(e) = path.extension() {
                    if e == ext {
                        return true;
                    }
                }
            }
        }
        false
    }

    /// Attempts to fix the error by prompting GLM and patching the file.
    pub async fn attempt_fix(&self, error_log: &str, project_path: &Path) -> Result<EscalationReason> {
        crate::logger::log_warning("🚨 Detection: Code Verification Failed.");
        crate::logger::status_update("🚑 Healer: Analyzing error with GLM-4.7-Flash...");

        // 1. Identify the culprit file from error log (Heuristic)
        let culprit_file = self.extract_filename(error_log);
        
        if let Some(filename) = culprit_file {
            let file_path = project_path.join(&filename);
            if file_path.exists() {
                let code_content = fs::read_to_string(&file_path).await?;
                
                // 2. Prompt GLM
                let client = SessionBasedCLIClient::new(self.model.clone(), project_path.to_path_buf());
                let prompt = format!(
                    "You are a syntax repair expert.
The following code has an error.

[ERROR LOG]
{}

[BROKEN CODE]
{}

[INSTRUCTION]
1. Fix the error in the code.
2. Return ONLY the full corrected code content.
3. Do NOT output markdown backticks (```).
4. Just the raw code.

[CRITICAL]
If the error is LOGICAL or requires refactoring (e.g. 'function not found' but you don't know where it is, or 'recursuve dependency'), return EXACTLY: 'ESCALATE: <reason>'",
                    error_log, code_content
                );

                let response = client.execute(&prompt).await?;
                
                // 3. Check for Escalation Signal
                if response.trim().starts_with("ESCALATE:") {
                    let reason = response.replace("ESCALATE:", "").trim().to_string();
                    return Ok(EscalationReason::EscalateToCouncil(reason));
                }

                // 4. Verify output sanity (Basic check)
                if response.len() < 10 || response.contains("Here is the fixed code") {
                    crate::logger::log_warning("Healer produced invalid code. Skipping fix.");
                    return Ok(EscalationReason::Unfixable("Healer output invalid".to_string()));
                }
                
                // 5. Clean Markdown
                 let clean_code = response
                    .trim()
                    .trim_start_matches("```rust")
                    .trim_start_matches("```python")
                    .trim_start_matches("```")
                    .trim_end_matches("```")
                    .trim();

                // 6. Apply Fix
                crate::logger::status_update(&format!("🚑 Healer: Patching file '{}'...", filename));
                fs::write(&file_path, clean_code).await?;
                
                return Ok(EscalationReason::Fixed);
            }
        }

        crate::logger::log_warning("Healer could not identify the broken file or fix it.");
        Ok(EscalationReason::Unfixable("Unknown file or logic".to_string()))
    }

    fn extract_filename(&self, log: &str) -> Option<String> {
        // Simple regex-like extraction
        // Rust: "src/main.rs:10"
        for line in log.lines() {
            if let Some(idx) = line.find(".rs:") {
                 // Extract path before .rs:
                 let part = &line[..idx+3];
                 // Find start (space or start of line)
                 // This is a naive parser, assuming relative path from root
                 return Some(part.trim().to_string());
            }
             if let Some(idx) = line.find(".py\", line") {
                 // File "script.py", line 
                 // parse between quotes
                 let parts: Vec<&str> = line.split('"').collect();
                 if parts.len() >= 2 {
                     return Some(parts[1].to_string());
                 }
            }
             if let Some(idx) = line.find(".ts(") {
                  // src/index.ts(10,5)
                  let part = &line[..idx+3];
                  return Some(part.trim().to_string());
             }
        }
        None
    }
}
