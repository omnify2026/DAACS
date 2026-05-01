use infra_error::{AppError, AppResult};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command as TokioCommand;

const MALFORMED_PATCH_FAILURE_MARKER: &str = "apply_patch verification failed";
const MALFORMED_PATCH_FAILURE_LIMIT: usize = 3;
const DEFAULT_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 900;
const MIN_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 60;
const MAX_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 7_200;
const PROVIDER_COMMAND_TIMEOUT_ENV: &str = "DAACS_PROVIDER_COMMAND_TIMEOUT_SECS";

#[async_trait::async_trait]
pub trait LlmExecutor: Send + Sync {
    async fn complete(&self, prompt: &str, role: &str) -> AppResult<String>;
}

pub struct CliExecutor;

#[async_trait::async_trait]
impl LlmExecutor for CliExecutor {
    async fn complete(&self, prompt: &str, _role: &str) -> AppResult<String> {
        let cwd = std::env::current_dir()?;
        let prefer = preferred_provider();

        if prefer == "local_llm" {
            let model_path = resolve_local_model_path().ok_or_else(|| {
                AppError::Message(
                    "Local LLM model file is not configured. Set DAACS_LOCAL_LLM_MODEL_PATH."
                        .to_string(),
                )
            })?;
            let response = omni_ai_core::generate_response(prompt, "", Some(model_path.as_path()));
            if response.starts_with("Error:") {
                return Err(AppError::Message(response));
            }
            return Ok(response);
        }

        let (provider, exe) = resolve_provider(&prefer)?;
        let (stdout, stderr, exit_code) = match provider.as_str() {
            "gemini" => run_gemini(&exe, prompt, &cwd).await?,
            "claude" => run_claude_via_ollama(&exe, prompt, &cwd).await?,
            _ => run_codex(&exe, prompt, &cwd).await?,
        };

        if exit_code != 0 {
            return Err(AppError::Message(format!(
                "{provider} CLI failed with exit code {exit_code}: {}",
                stderr.trim()
            )));
        }

        Ok(stdout)
    }
}

pub fn create_executor() -> AppResult<Box<dyn LlmExecutor>> {
    Ok(Box::new(CliExecutor))
}

fn preferred_provider() -> String {
    match std::env::var("DAACS_CLI_PROVIDER")
        .ok()
        .unwrap_or_else(|| "codex".to_string())
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "gemini" => "gemini".to_string(),
        "local_llm" => "local_llm".to_string(),
        "claude" => "claude".to_string(),
        _ => "codex".to_string(),
    }
}

fn resolve_provider(prefer: &str) -> AppResult<(String, PathBuf)> {
    let preferred = prefer.trim().to_ascii_lowercase();
    let provider = match preferred.as_str() {
        "gemini" => resolve_gemini()
            .map(|path| ("gemini".to_string(), path))
            .or_else(|| resolve_codex().map(|path| ("codex".to_string(), path)))
            .or_else(|| resolve_local_llm().map(|path| ("claude".to_string(), path))),
        "claude" => resolve_local_llm().map(|path| ("claude".to_string(), path)),
        _ => resolve_codex()
            .map(|path| ("codex".to_string(), path))
            .or_else(|| resolve_gemini().map(|path| ("gemini".to_string(), path)))
            .or_else(|| resolve_local_llm().map(|path| ("claude".to_string(), path))),
    };

    provider.ok_or_else(|| {
        AppError::Message(
            "No available CLI provider found. Configure Codex, Gemini, or local LLM CLI."
                .to_string(),
        )
    })
}

fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_bounded_timeout_secs(
    value: Option<&str>,
    default_secs: u64,
    min_secs: u64,
    max_secs: u64,
) -> Option<u64> {
    let Some(raw) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Some(default_secs);
    };

    if matches!(
        raw.to_ascii_lowercase().as_str(),
        "0" | "off" | "none" | "disabled"
    ) {
        return None;
    }

    raw.parse::<u64>()
        .ok()
        .map(|secs| secs.clamp(min_secs, max_secs))
        .or(Some(default_secs))
}

fn provider_command_timeout_secs() -> Option<u64> {
    parse_bounded_timeout_secs(
        env_var(PROVIDER_COMMAND_TIMEOUT_ENV).as_deref(),
        DEFAULT_PROVIDER_COMMAND_TIMEOUT_SECS,
        MIN_PROVIDER_COMMAND_TIMEOUT_SECS,
        MAX_PROVIDER_COMMAND_TIMEOUT_SECS,
    )
}

fn which_path(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_gemini() -> Option<PathBuf> {
    if let Some(path) = env_var("DAACS_GEMINI_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    ["gemini", "gemini.cmd", "gemini.exe"]
        .into_iter()
        .find_map(which_path)
}

fn resolve_codex() -> Option<PathBuf> {
    if let Some(path) = env_var("DAACS_CODEX_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    ["codex", "codex.cmd", "codex.exe"]
        .into_iter()
        .find_map(which_path)
}

fn resolve_local_llm() -> Option<PathBuf> {
    if let Some(path) = env_var("DAACS_LOCAL_LLM_CLI_PATH") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(path);
        }
    }
    ["ollama", "ollama.exe"].into_iter().find_map(which_path)
}

fn resolve_local_model_path() -> Option<PathBuf> {
    env_var("DAACS_LOCAL_LLM_MODEL_PATH")
        .map(PathBuf::from)
        .filter(|path| path.exists())
}

fn resolve_ollama_model_name() -> AppResult<String> {
    env_var("DAACS_LOCAL_LLM_MODEL").ok_or_else(|| {
        AppError::Message(
            "DAACS_LOCAL_LLM_MODEL is not set. Set the Ollama model name before using the Ollama provider."
                .to_string(),
        )
    })
}

enum ChildStopReason {
    Exited(i32),
    TimedOut,
    FailedFast(String),
}

fn count_malformed_patch_failures(stderr: &str) -> usize {
    stderr
        .lines()
        .filter(|line| line.contains(MALFORMED_PATCH_FAILURE_MARKER))
        .count()
}

fn malformed_patch_fast_fail_message(count: usize) -> String {
    format!(
        "Codex CLI stopped early after {count} repeated apply_patch verification failures. The agent is retrying a malformed file-write operation; retry with smaller complete file creates/edits or report the blocker."
    )
}

fn detect_malformed_patch_fast_fail(stderr: &str) -> Option<String> {
    let count = count_malformed_patch_failures(stderr);
    (count >= MALFORMED_PATCH_FAILURE_LIMIT).then(|| malformed_patch_fast_fail_message(count))
}

async fn terminate_child_process_group(child: &mut tokio::process::Child, child_pid: Option<u32>) {
    #[cfg(windows)]
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
        let _ = child_pid;
    }

    #[cfg(not(windows))]
    {
        if let Some(pid) = child_pid {
            let group_target = format!("-{}", pid);
            let _ = TokioCommand::new("kill")
                .args(["-TERM", &group_target])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .await;
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            if matches!(child.try_wait(), Ok(Some(_))) {
                let _ = child.wait().await;
                return;
            }
            let _ = TokioCommand::new("kill")
                .args(["-KILL", &group_target])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .await;
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

async fn run_gemini(exe: &Path, prompt: &str, cwd: &Path) -> AppResult<(String, String, i32)> {
    let mut command = TokioCommand::new(exe);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(cwd)
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy");
    run_tokio_command_with_timeout(command, Some(prompt), provider_command_timeout_secs()).await
}

async fn run_codex(exe: &Path, prompt: &str, cwd: &Path) -> AppResult<(String, String, i32)> {
    let codex_workdir = cwd.to_string_lossy().to_string();
    let mut command = TokioCommand::new(exe);
    command
        .args([
            "exec",
            "-c",
            "features.plugins=false",
            "--ephemeral",
            "--skip-git-repo-check",
            "-C",
            &codex_workdir,
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(cwd)
        .env_remove("HTTP_PROXY")
        .env_remove("HTTPS_PROXY")
        .env_remove("http_proxy")
        .env_remove("https_proxy")
        .env_remove("CODEX_CI")
        .env_remove("CODEX_INTERNAL_ORIGINATOR_OVERRIDE")
        .env_remove("CODEX_SHELL")
        .env_remove("CODEX_THREAD_ID");
    run_tokio_command_with_timeout(command, Some(prompt), provider_command_timeout_secs()).await
}

async fn run_claude_via_ollama(
    exe: &Path,
    prompt: &str,
    cwd: &Path,
) -> AppResult<(String, String, i32)> {
    let model = resolve_ollama_model_name()?;
    let mut command = TokioCommand::new(exe);
    command
        .args(["run", model.as_str()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(cwd);
    run_tokio_command_with_timeout(command, Some(prompt), provider_command_timeout_secs()).await
}

async fn run_tokio_command_with_timeout(
    mut command: TokioCommand,
    stdin_text: Option<&str>,
    timeout_secs: Option<u64>,
) -> AppResult<(String, String, i32)> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command.spawn()?;
    let child_pid = child.id();
    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(text.as_bytes()).await?;
            stdin.flush().await?;
        }
    }

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Message("stdout pipe missing".to_string()))?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| AppError::Message("stderr pipe missing".to_string()))?;

    let stdout_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        stdout.read_to_end(&mut buf).await.map(|_| buf)
    });
    let (fast_fail_tx, mut fast_fail_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut stderr_text = String::new();
        let mut signaled_fast_fail = false;
        let mut chunk = [0_u8; 4096];
        loop {
            let read_count = stderr.read(&mut chunk).await?;
            if read_count == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..read_count]);
            if !signaled_fast_fail {
                stderr_text.push_str(&String::from_utf8_lossy(&chunk[..read_count]));
                if let Some(message) = detect_malformed_patch_fast_fail(&stderr_text) {
                    let _ = fast_fail_tx.send(message);
                    signaled_fast_fail = true;
                }
            }
        }
        Ok::<Vec<u8>, std::io::Error>(buf)
    });

    let stop_reason = {
        let wait_future = child.wait();
        tokio::pin!(wait_future);
        let mut fast_fail_closed = false;

        if let Some(timeout_secs) = timeout_secs {
            let timeout_future = tokio::time::sleep(std::time::Duration::from_secs(timeout_secs));
            tokio::pin!(timeout_future);

            loop {
                tokio::select! {
                    status = &mut wait_future => {
                        break ChildStopReason::Exited(status?.code().unwrap_or(-1));
                    }
                    _ = &mut timeout_future => {
                        break ChildStopReason::TimedOut;
                    }
                    maybe_message = fast_fail_rx.recv(), if !fast_fail_closed => {
                        match maybe_message {
                            Some(message) => break ChildStopReason::FailedFast(message),
                            None => fast_fail_closed = true,
                        }
                    }
                }
            }
        } else {
            loop {
                tokio::select! {
                    status = &mut wait_future => {
                        break ChildStopReason::Exited(status?.code().unwrap_or(-1));
                    }
                    maybe_message = fast_fail_rx.recv(), if !fast_fail_closed => {
                        match maybe_message {
                            Some(message) => break ChildStopReason::FailedFast(message),
                            None => fast_fail_closed = true,
                        }
                    }
                }
            }
        }
    };

    match stop_reason {
        ChildStopReason::Exited(exit_code) => {
            let stdout = stdout_task
                .await
                .map_err(|error| AppError::Message(error.to_string()))??;
            let stderr = stderr_task
                .await
                .map_err(|error| AppError::Message(error.to_string()))??;

            Ok((
                String::from_utf8_lossy(&stdout).to_string(),
                String::from_utf8_lossy(&stderr).to_string(),
                exit_code,
            ))
        }
        ChildStopReason::TimedOut => {
            terminate_child_process_group(&mut child, child_pid).await;
            let timeout_secs = timeout_secs.unwrap_or_default();
            return Err(AppError::Message(format!(
                "CLI command timed out after {timeout_secs} seconds"
            )));
        }
        ChildStopReason::FailedFast(message) => {
            terminate_child_process_group(&mut child, child_pid).await;
            let stdout = stdout_task
                .await
                .map_err(|error| AppError::Message(error.to_string()))??;
            let stderr = stderr_task
                .await
                .map_err(|error| AppError::Message(error.to_string()))??;
            let mut stderr = String::from_utf8_lossy(&stderr).to_string();
            if !stderr.is_empty() {
                stderr.push('\n');
            }
            stderr.push_str(&message);

            Ok((String::from_utf8_lossy(&stdout).to_string(), stderr, 1))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_bounded_timeout_secs_uses_defaults_clamps_and_allows_disable() {
        assert_eq!(parse_bounded_timeout_secs(None, 900, 60, 7_200), Some(900));
        assert_eq!(
            parse_bounded_timeout_secs(Some("1200"), 900, 60, 7_200),
            Some(1_200)
        );
        assert_eq!(
            parse_bounded_timeout_secs(Some("5"), 900, 60, 7_200),
            Some(60)
        );
        assert_eq!(
            parse_bounded_timeout_secs(Some("99999"), 900, 60, 7_200),
            Some(7_200)
        );
        assert_eq!(
            parse_bounded_timeout_secs(Some("not-a-number"), 900, 60, 7_200),
            Some(900)
        );
        assert_eq!(
            parse_bounded_timeout_secs(Some("disabled"), 900, 60, 7_200),
            None
        );
    }

    #[test]
    fn detect_malformed_patch_fast_fail_requires_repeated_failures() {
        assert!(detect_malformed_patch_fast_fail(
            "error=apply_patch verification failed: invalid patch"
        )
        .is_none());

        let repeated = [
            "error=apply_patch verification failed: invalid patch",
            "noise",
            "error=apply_patch verification failed: invalid patch",
            "error=apply_patch verification failed: invalid patch",
        ]
        .join("\n");
        assert!(detect_malformed_patch_fast_fail(&repeated)
            .expect("repeated malformed patch failures should fast-fail")
            .contains("stopped early"));
    }

    #[tokio::test]
    async fn run_tokio_command_fast_fails_repeated_malformed_patch_errors() {
        #[cfg(not(windows))]
        {
            let mut command = TokioCommand::new("sh");
            command
                .args([
                    "-c",
                    "for i in 1 2 3; do echo 'error=apply_patch verification failed: invalid patch' >&2; sleep 0.05; done; sleep 5",
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let started = std::time::Instant::now();
            let (_stdout, stderr, exit_code) =
                run_tokio_command_with_timeout(command, None, Some(30))
                    .await
                    .expect("command should return a controlled failure");

            assert_eq!(exit_code, 1);
            assert!(stderr.contains("stopped early"));
            assert!(
                started.elapsed() < std::time::Duration::from_secs(3),
                "fast-fail should stop before the long child sleep"
            );
        }
    }
}
