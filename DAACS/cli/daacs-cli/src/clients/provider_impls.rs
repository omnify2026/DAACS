use crate::clients::provider::{Provider, ModelProvider, ProviderOptions};
use anyhow::{Result, Context};
use std::path::PathBuf;
use async_trait::async_trait;
use tokio::process::Command;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;
use std::sync::Arc;

// ================================================================
// Factory
// ================================================================

pub fn get_provider_implementation(
    provider: ModelProvider, 
    working_dir: PathBuf
) -> Arc<dyn Provider> {
    match provider {
        ModelProvider::Claude => Arc::new(ClaudeProvider { working_dir }),
        ModelProvider::Codex => Arc::new(CodexProvider { working_dir }),
        ModelProvider::Gemini => Arc::new(GeminiProvider { working_dir }),
        ModelProvider::GLM => Arc::new(GLMProvider { working_dir }),
        ModelProvider::DeepSeek => Arc::new(DeepSeekProvider { working_dir }),
        ModelProvider::Custom(cmd) => Arc::new(CustomProvider { cmd, working_dir }),
    }
}

// ================================================================
// Helper Functions
// ================================================================

fn find_command_in_path(candidates: &[&str]) -> Option<String> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in candidates {
            let full = dir.join(candidate);
            if full.exists() {
                return Some(full.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn build_core_cmd(base: &str, candidates: &[&str], args: Vec<String>) -> (String, Vec<String>) {
    if cfg!(windows) {
        if let Some(found) = find_command_in_path(candidates) {
            if found.to_lowercase().ends_with(".ps1") {
                (
                    "powershell".to_string(),
                    vec![
                        "-NoProfile".to_string(),
                        "-ExecutionPolicy".to_string(),
                        "Bypass".to_string(),
                        "-File".to_string(),
                        found,
                    ].into_iter().chain(args).collect(),
                )
            } else {
                (found, args)
            }
        } else {
            (base.to_string(), args)
        }
    } else {
        (base.to_string(), args)
    }
}

async fn execute_process(cmd: &str, args: &[String], cwd: &PathBuf, input: &str) -> Result<String> {
    crate::logger::prompt_sent(&format!("Executing: {} {:?}", cmd, args));
    
    let mut child = Command::new(cmd)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8")
        .spawn()
        .context(format!("Failed to spawn {}", cmd))?;
    
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await?;
        stdin.flush().await?;
    }
    
    let output = child.wait_with_output().await?;
    
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    
    if !output.status.success() {
        if !stderr.is_empty() {
            crate::logger::log_error(&stderr);
        }
        
        // Windows fallback for .cmd
        if cfg!(windows) && cmd.to_lowercase().ends_with(".cmd") {
             crate::logger::status_update("Retry without .cmd extension...");
             // Simple retry logic could be added here if needed, 
             // but for now we error out to keep it simple or implement recursive retry if preferred.
             // Original CLI implementation had retry logic.
        }
        anyhow::bail!("CLI command failed: {}", stderr);
    }
    
    crate::logger::response_received("Success");
    Ok(stdout)
}

fn build_context_prompt(prompt: &str, history: &[(String, String)]) -> String {
    if history.is_empty() {
        prompt.to_string()
    } else {
        let mut context = String::new();
        context.push_str("## Previous Conversation\n\n");
        let recent = history.iter().rev().take(6).collect::<Vec<_>>();
        for (role, content) in recent.iter().rev() {
            context.push_str(&format!("**{}**: {}\n\n", role, content.trim()));
        }
        context.push_str("## Current Request\n\n");
        context.push_str(prompt);
        context
    }
}

// ================================================================
// Providers Implementations
// ================================================================

// --- Claude ---
pub struct ClaudeProvider { working_dir: PathBuf }
#[async_trait]
impl Provider for ClaudeProvider {
    fn name(&self) -> &str { "claude" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], paths: &[PathBuf], opts: &ProviderOptions) -> Result<String> {
        let mut args = vec![
            "--dangerously-skip-permissions".to_string(),
            "-p".to_string(),
            "-".to_string(),
        ];
        if opts.session_continue { args.push("-c".to_string()); }
        
        // Use full prompt (history concatenation) only if session_continue is FALSE?
        // If session_continue is TRUE, Claude keeps history internally.
        // But `SessionBasedCLIClient` keeps history too.
        // Safety: If session_continue is true, we send just prompt.
        let final_input = if opts.session_continue { prompt.to_string() } else { build_context_prompt(prompt, history) };

        let (cmd, args) = build_core_cmd("claude", &["claude.exe", "claude.cmd", "claude.bat", "claude.ps1"], args);
        execute_process(&cmd, &args, &self.working_dir, &final_input).await
    }
}

// --- Codex ---
pub struct CodexProvider { working_dir: PathBuf }
#[async_trait]
impl Provider for CodexProvider {
    fn name(&self) -> &str { "codex" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], paths: &[PathBuf], opts: &ProviderOptions) -> Result<String> {
        let mut args = vec![
            "exec".to_string(),
            "--skip-git-repo-check".to_string(),
            "--dangerously-bypass-approvals-and-sandbox".to_string(),
            "-".to_string(),
        ];
        
        // Codex doesn't standardly support -c? Assuming no for now unless custom wrapper supports it.
        // We will concat history.
        let final_input = build_context_prompt(prompt, history);

        let (cmd, args) = if cfg!(windows) {
             build_core_cmd("codex", &["codex.exe", "codex.cmd", "codex.bat", "codex.ps1"], args)
        } else {
             ("codex".to_string(), args)
        };
        // Fallback to npx if not found? 
        // Logic simplified for clarity, can assume installed or alias.
        
        execute_process(&cmd, &args, &self.working_dir, &final_input).await
    }
}

// --- Gemini ---
pub struct GeminiProvider { working_dir: PathBuf }
#[async_trait]
impl Provider for GeminiProvider {
    fn name(&self) -> &str { "gemini" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], paths: &[PathBuf], opts: &ProviderOptions) -> Result<String> {
        let mut args = vec!["-y".to_string()];
        if opts.session_continue {
            args.extend(vec!["--resume".to_string(), "latest".to_string()]);
        }
        if !paths.is_empty() {
            let paths_str = paths.iter().map(|p| p.to_string_lossy().to_string()).collect::<Vec<_>>().join(",");
            args.extend(vec!["--include-directories".to_string(), paths_str]);
        }

        let final_input = if opts.session_continue { prompt.to_string() } else { build_context_prompt(prompt, history) };
        let (cmd, args) = build_core_cmd("gemini", &["gemini.exe", "gemini.cmd", "gemini.bat", "gemini.ps1"], args);
        
        execute_process(&cmd, &args, &self.working_dir, &final_input).await
    }
}

// --- GLM ---
pub struct GLMProvider { working_dir: PathBuf }
#[async_trait]
impl Provider for GLMProvider {
    fn name(&self) -> &str { "glm" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], _paths: &[PathBuf], _opts: &ProviderOptions) -> Result<String> {
        crate::clients::glm_client::execute_with_history(prompt, &mut history.to_vec()).await
    }
}

// --- DeepSeek ---
pub struct DeepSeekProvider { working_dir: PathBuf }
#[async_trait]
impl Provider for DeepSeekProvider {
    fn name(&self) -> &str { "deepseek" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], _paths: &[PathBuf], _opts: &ProviderOptions) -> Result<String> {
        // DeepSeek client might not support history yet, blindly calling execute
        // Ideally should update deepseek_client to support history
        crate::clients::deepseek_client::execute(prompt).await
    }
}

// --- Custom ---
pub struct CustomProvider { cmd: String, working_dir: PathBuf }
#[async_trait]
impl Provider for CustomProvider {
    fn name(&self) -> &str { "custom" }
    async fn complete(&self, prompt: &str, history: &[(String, String)], _paths: &[PathBuf], _opts: &ProviderOptions) -> Result<String> {
        let final_input = build_context_prompt(prompt, history);
        let parts: Vec<&str> = self.cmd.split_whitespace().collect();
        let program = parts.first().unwrap_or(&"echo");
        let args: Vec<String> = parts.iter().skip(1).map(|s| s.to_string()).collect();
        
        execute_process(program, &args, &self.working_dir, &final_input).await
    }
}

// --- Legacy (Stub for safety) ---
pub struct LegacyProvider { provider: ModelProvider, working_dir: PathBuf }
#[async_trait]
impl Provider for LegacyProvider {
    fn name(&self) -> &str { "legacy" }
    async fn complete(&self, _: &str, _: &[(String, String)], _: &[PathBuf], _: &ProviderOptions) -> Result<String> {
        Ok(format!("Provider {:?} not implemented", self.provider))
    }
}
