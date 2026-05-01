use infra_error::{AppError, AppResult};
use omni_ai_core::{
    extract_command_lines, load_todo_list, mark_item_done, parse_pm_task_lists,
    prompting_sequencer_system_prompt, save_todo_list, system_prompt_for_role, AgentRole,
    SequencerTodoList,
};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri_plugin_dialog::DialogExt;
use tokio::process::Command as TokioCommand;
use tracing::{debug, info, warn};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

const MAIN_PROGRAM_NAME: &str = "DAACS";
const LOCAL_STATE_APP_DIR: &str = "DAACS";
const LOCAL_OFFICE_STATE_DIR: &str = "office_state";
const LOCAL_OFFICE_STATE_SNAPSHOT_VERSION: u64 = 2;
const GLOBAL_OFFICE_STATE_FILE: &str = "global_office_state.json";
const WORKSPACE_COMMAND_TIMEOUT_SECS: u64 = 120;
const DEFAULT_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 900;
const MIN_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 60;
const MAX_PROVIDER_COMMAND_TIMEOUT_SECS: u64 = 7_200;
const PROVIDER_COMMAND_TIMEOUT_ENV: &str = "DAACS_PROVIDER_COMMAND_TIMEOUT_SECS";
const LOCAL_LLM_COMMAND_TIMEOUT_ENV: &str = "DAACS_LOCAL_LLM_TIMEOUT_SECS";
const SEQUENCER_CODEX_MODEL: &str = "gpt-5.5";
const SEQUENCER_CODEX_REASONING_EFFORT: &str = "low";
const L10N_KEY_CLI_ERROR_EMPTY_INSTRUCTION: &str = "cli.errorEmptyInstruction";
const L10N_KEY_CLI_ERROR_NO_PROVIDER: &str = "cli.errorNoProviderAll";
const L10N_KEY_CLI_ERROR_CLAUDE_PROVIDER_REQUIRES_OLLAMA: &str =
    "cli.errorClaudeProviderRequiresOllama";
const L10N_KEY_CLI_ERROR_INVALID_PATH: &str = "cli.errorInvalidPath";
const L10N_KEY_CLI_WORKSPACE_COMMAND_TIMED_OUT: &str = "cli.workspaceCommandTimedOut";
const L10N_KEY_CLI_LOCAL_LLM_TIMED_OUT: &str = "cli.localLlmTimedOut";
const L10N_KEY_CLI_GEMINI_TIMED_OUT: &str = "cli.geminiTimedOut";
const L10N_KEY_CLI_CODEX_TIMED_OUT: &str = "cli.codexTimedOut";
const L10N_KEY_CLI_CLAUDE_TIMED_OUT: &str = "cli.claudeTimedOut";
const MALFORMED_PATCH_FAILURE_MARKER: &str = "apply_patch verification failed";
const MALFORMED_PATCH_FAILURE_LIMIT: usize = 3;
const PARTIAL_ARTIFACT_TIMEOUT_TAG: &str = "DAACS_PARTIAL_ARTIFACT_TIMEOUT";
const WORKSPACE_SNAPSHOT_FILE_LIMIT: usize = 5000;

static ACTIVE_COMMAND_PIDS: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
static CODEX_SESSION_IDS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn active_command_pids() -> &'static Mutex<HashSet<u32>> {
    ACTIVE_COMMAND_PIDS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn codex_session_ids() -> &'static Mutex<HashMap<String, String>> {
    CODEX_SESSION_IDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn get_codex_session_id(session_key: &str) -> Option<String> {
    let normalized = normalize_cli_session_key(Some(session_key))?;
    codex_session_ids()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&normalized).cloned())
}

fn set_codex_session_id(session_key: &str, thread_id: &str) {
    let Some(normalized) = normalize_cli_session_key(Some(session_key)) else {
        return;
    };
    if thread_id.trim().is_empty() {
        return;
    }
    if let Ok(mut guard) = codex_session_ids().lock() {
        guard.insert(normalized, thread_id.trim().to_string());
    }
}

fn clear_codex_session_id(session_key: &str) {
    let Some(normalized) = normalize_cli_session_key(Some(session_key)) else {
        return;
    };
    if let Ok(mut guard) = codex_session_ids().lock() {
        guard.remove(&normalized);
    }
}

fn register_active_pid(pid: u32) {
    if let Ok(mut guard) = active_command_pids().lock() {
        guard.insert(pid);
    }
}

fn unregister_active_pid(pid: u32) {
    if let Ok(mut guard) = active_command_pids().lock() {
        guard.remove(&pid);
    }
}

fn snapshot_active_pids() -> Vec<u32> {
    active_command_pids()
        .lock()
        .map(|guard| guard.iter().copied().collect())
        .unwrap_or_default()
}

fn cli_text(in_key: &str, in_fallback: &str) -> String {
    crate::l10n::localized_text(in_key, in_fallback)
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

fn local_llm_command_timeout_secs() -> Option<u64> {
    let local_override = env_var(LOCAL_LLM_COMMAND_TIMEOUT_ENV);
    if local_override.is_some() {
        return parse_bounded_timeout_secs(
            local_override.as_deref(),
            DEFAULT_PROVIDER_COMMAND_TIMEOUT_SECS,
            MIN_PROVIDER_COMMAND_TIMEOUT_SECS,
            MAX_PROVIDER_COMMAND_TIMEOUT_SECS,
        );
    }
    provider_command_timeout_secs()
}

fn provider_timeout_message(key: &str, provider_label: &str, timeout_secs: Option<u64>) -> String {
    let fallback = match timeout_secs {
        Some(_) => format!("{provider_label} CLI timed out after {{seconds}} seconds."),
        None => format!("{provider_label} CLI timeout is disabled."),
    };
    match timeout_secs {
        Some(secs) => cli_text(key, &fallback).replace("{seconds}", &secs.to_string()),
        None => cli_text(key, &fallback),
    }
}

fn local_llm_timeout_message(timeout_secs: Option<u64>) -> String {
    let fallback = match timeout_secs {
        Some(_) => {
            "Local LLM timed out after {seconds} seconds. The model may be too large or stuck."
                .to_string()
        }
        None => "Local LLM timeout is disabled.".to_string(),
    };
    match timeout_secs {
        Some(secs) => cli_text(L10N_KEY_CLI_LOCAL_LLM_TIMED_OUT, &fallback)
            .replace("{seconds}", &secs.to_string()),
        None => cli_text(L10N_KEY_CLI_LOCAL_LLM_TIMED_OUT, &fallback),
    }
}

enum ChildStopReason {
    Exited(i32),
    TimedOut,
    FailedFast(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorkspaceFileStamp {
    len: u64,
    modified_nanos: u128,
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

fn should_skip_workspace_snapshot_entry(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git"
            | ".DS_Store"
            | "node_modules"
            | "target"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | "dist"
            | "build"
    )
}

fn workspace_file_modified_nanos(metadata: &std::fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn workspace_snapshot_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn collect_workspace_file_snapshot(
    root: &Path,
    current: &Path,
    out: &mut HashMap<String, WorkspaceFileStamp>,
) -> std::io::Result<()> {
    if out.len() > WORKSPACE_SNAPSHOT_FILE_LIMIT {
        return Ok(());
    }
    for entry in std::fs::read_dir(current)? {
        let entry = entry?;
        let path = entry.path();
        if should_skip_workspace_snapshot_entry(&path) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if metadata.is_dir() {
            collect_workspace_file_snapshot(root, &path, out)?;
            if out.len() > WORKSPACE_SNAPSHOT_FILE_LIMIT {
                return Ok(());
            }
            continue;
        }
        if !metadata.is_file() {
            continue;
        }
        out.insert(
            workspace_snapshot_relative_path(root, &path),
            WorkspaceFileStamp {
                len: metadata.len(),
                modified_nanos: workspace_file_modified_nanos(&metadata),
            },
        );
    }
    Ok(())
}

fn snapshot_workspace_files(root: &Path) -> Option<HashMap<String, WorkspaceFileStamp>> {
    if !root.is_dir() {
        return None;
    }
    let mut out = HashMap::new();
    collect_workspace_file_snapshot(root, root, &mut out).ok()?;
    if out.len() > WORKSPACE_SNAPSHOT_FILE_LIMIT {
        return None;
    }
    Some(out)
}

fn changed_workspace_files(
    before: &HashMap<String, WorkspaceFileStamp>,
    after: &HashMap<String, WorkspaceFileStamp>,
) -> Vec<String> {
    let mut changed: Vec<String> = after
        .iter()
        .filter_map(|(path, stamp)| (before.get(path) != Some(stamp)).then(|| path.clone()))
        .collect();
    changed.sort();
    changed.truncate(80);
    changed
}

fn append_partial_artifact_timeout_marker(stderr: &mut String, changed_files: &[String]) {
    if changed_files.is_empty() {
        return;
    }
    if !stderr.trim().is_empty() {
        stderr.push('\n');
    }
    stderr.push_str(&format!("[{}]\n", PARTIAL_ARTIFACT_TIMEOUT_TAG));
    stderr.push_str("status=files_changed_before_timeout\n");
    stderr.push_str("Files changed before timeout:\n");
    for path in changed_files {
        stderr.push_str("- ");
        stderr.push_str(path);
        stderr.push('\n');
    }
    stderr.push_str(&format!("[/{}]", PARTIAL_ARTIFACT_TIMEOUT_TAG));
}

fn annotate_partial_artifact_timeout(
    result: (String, String, i32),
    before_snapshot: Option<&HashMap<String, WorkspaceFileStamp>>,
    cwd: &Path,
    timeout_message: &str,
) -> (String, String, i32) {
    let (stdout, mut stderr, exit_code) = result;
    if exit_code == 0 || !stderr.contains(timeout_message) {
        return (stdout, stderr, exit_code);
    }
    let Some(before) = before_snapshot else {
        return (stdout, stderr, exit_code);
    };
    let Some(after) = snapshot_workspace_files(cwd) else {
        return (stdout, stderr, exit_code);
    };
    let changed = changed_workspace_files(before, &after);
    append_partial_artifact_timeout_marker(&mut stderr, &changed);
    (stdout, stderr, exit_code)
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

async fn run_tokio_command_with_timeout(
    mut command: TokioCommand,
    stdin_text: Option<&str>,
    timeout_secs: Option<u64>,
    timeout_message: &str,
) -> AppResult<(String, String, i32)> {
    use tokio::io::AsyncReadExt;

    #[cfg(unix)]
    {
        command.process_group(0);
    }

    let mut child = command
        .spawn()
        .map_err(|error| AppError::Message(error.to_string()))?;
    let child_pid = child.id();
    if let Some(pid) = child_pid {
        register_active_pid(pid);
    }
    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            stdin
                .write_all(text.as_bytes())
                .await
                .map_err(|error| AppError::Message(error.to_string()))?;
            stdin
                .flush()
                .await
                .map_err(|error| AppError::Message(error.to_string()))?;
        }
    }

    let stdout_task = child.stdout.take().map(|mut stdout| {
        tokio::spawn(async move {
            let mut buf = Vec::new();
            stdout.read_to_end(&mut buf).await.map(|_| buf)
        })
    });
    let (fast_fail_tx, mut fast_fail_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
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
            Ok(buf)
        })
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
                        match status {
                            Ok(status) => break ChildStopReason::Exited(status.code().unwrap_or(-1)),
                            Err(error) => {
                                if let Some(pid) = child_pid {
                                    unregister_active_pid(pid);
                                }
                                return Err(AppError::Message(error.to_string()));
                            }
                        }
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
                        match status {
                            Ok(status) => break ChildStopReason::Exited(status.code().unwrap_or(-1)),
                            Err(error) => {
                                if let Some(pid) = child_pid {
                                    unregister_active_pid(pid);
                                }
                                return Err(AppError::Message(error.to_string()));
                            }
                        }
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
            let stdout = collect_child_output(stdout_task).await?;
            let stderr = collect_child_output(stderr_task).await?;
            if let Some(pid) = child_pid {
                unregister_active_pid(pid);
            }
            Ok((stdout, stderr, exit_code))
        }
        ChildStopReason::TimedOut => {
            terminate_child_process_group(&mut child, child_pid).await;
            let stdout = collect_child_output(stdout_task).await?;
            let mut stderr = collect_child_output(stderr_task).await?;
            if !stderr.is_empty() {
                stderr.push('\n');
            }
            stderr.push_str(timeout_message);
            if let Some(pid) = child_pid {
                unregister_active_pid(pid);
            }
            Ok((stdout, stderr, 1))
        }
        ChildStopReason::FailedFast(message) => {
            terminate_child_process_group(&mut child, child_pid).await;
            let stdout = collect_child_output(stdout_task).await?;
            let mut stderr = collect_child_output(stderr_task).await?;
            if !stderr.is_empty() {
                stderr.push('\n');
            }
            stderr.push_str(&message);
            if let Some(pid) = child_pid {
                unregister_active_pid(pid);
            }
            Ok((stdout, stderr, 1))
        }
    }
}

async fn collect_child_output(
    task: Option<tokio::task::JoinHandle<std::io::Result<Vec<u8>>>>,
) -> AppResult<String> {
    match task {
        Some(handle) => {
            let bytes = handle
                .await
                .map_err(|error| AppError::Message(error.to_string()))?
                .map_err(AppError::from)?;
            Ok(String::from_utf8_lossy(&bytes).to_string())
        }
        None => Ok(String::new()),
    }
}

fn normalize_cli_session_key_segment(value: &str) -> String {
    let mut out = String::new();
    let mut last_was_dash = false;
    for ch in value.trim().chars() {
        let normalized = ch.to_ascii_lowercase();
        let allowed = normalized.is_ascii_alphanumeric()
            || normalized == '.'
            || normalized == '_'
            || normalized == '-';
        if allowed {
            out.push(normalized);
            last_was_dash = false;
            continue;
        }
        if !last_was_dash {
            out.push('-');
            last_was_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn normalize_cli_session_key(session_key: Option<&str>) -> Option<String> {
    let raw = session_key
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let parts: Vec<String> = raw
        .split(':')
        .map(normalize_cli_session_key_segment)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(":"))
    }
}

fn is_sequencer_session_key(session_key: Option<&str>) -> bool {
    normalize_cli_session_key(session_key)
        .is_some_and(|value| value.split(':').next() == Some("sequencer"))
}

fn is_empty_sequencer_plan_session_failure(session_key: Option<&str>, stdout: &str) -> bool {
    if !stdout.trim().is_empty() {
        return false;
    }
    normalize_cli_session_key(session_key).is_some_and(|value| {
        let parts: Vec<&str> = value.split(':').collect();
        if parts.first() != Some(&"sequencer") {
            return false;
        }
        parts.last() == Some(&"plan") || parts.get(parts.len().saturating_sub(2)) == Some(&"plan")
    })
}

fn build_codex_config_args(session_key: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-c".to_string(),
        "features.plugins=false".to_string(),
        "-c".to_string(),
        "sandbox_mode=\"workspace-write\"".to_string(),
        "-c".to_string(),
        "approval_policy=\"never\"".to_string(),
    ];
    if is_sequencer_session_key(session_key) {
        args.push("-c".to_string());
        args.push(format!("model=\"{}\"", SEQUENCER_CODEX_MODEL));
        args.push("-c".to_string());
        args.push(format!(
            "model_reasoning_effort=\"{}\"",
            SEQUENCER_CODEX_REASONING_EFFORT
        ));
    }
    args
}

fn is_transient_codex_provider_failure(stdout: &str, stderr: &str, exit_code: i32) -> bool {
    if exit_code == 0 {
        return false;
    }
    let combined = format!("{}\n{}", stdout, stderr).to_lowercase();
    combined.contains("failed to refresh available models")
        || combined.contains("high demand")
        || combined.contains("stream disconnected - retrying sampling request")
        || combined.contains("temporarily unavailable")
        || combined.contains("rate limit")
        || combined.contains("terminalquotaerror")
        || combined.contains("quota_exhausted")
        || combined.contains("exhausted your capacity")
        || combined.contains("quota will reset after")
}

fn should_retry_codex_provider_failure(
    session_key: Option<&str>,
    stdout: &str,
    stderr: &str,
    exit_code: i32,
) -> bool {
    if !is_transient_codex_provider_failure(stdout, stderr, exit_code) {
        return false;
    }
    !is_sequencer_session_key(session_key)
        || is_empty_sequencer_plan_session_failure(session_key, stdout)
}

fn build_codex_last_message_path(session_key: Option<&str>) -> PathBuf {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or_default();
    let session_segment = session_key
        .map(sanitize_filename)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());
    std::env::temp_dir().join(format!(
        "daacs_codex_last_message_{}_{}_{}.txt",
        session_segment,
        std::process::id(),
        timestamp
    ))
}

fn extract_sequencer_commands(text: &str) -> Vec<String> {
    let extracted = extract_command_lines(text);
    if !extracted.is_empty() {
        return extracted;
    }
    extract_tagged_command_block(text, "Commands")
        .or_else(|| extract_tagged_command_block(text, "Command"))
        .unwrap_or_default()
}

fn is_command_code_fence_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("```") || trimmed.starts_with("~~~")
}

fn extract_tagged_command_block(text: &str, tag: &str) -> Option<Vec<String>> {
    let open = format!("[{tag}]");
    let close = format!("[/{tag}]");
    let start = text.find(&open)?;
    let inner_start = start + open.len();
    let end_rel = text[inner_start..].find(&close)?;
    Some(
        text[inner_start..inner_start + end_rel]
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    return None;
                }
                if is_command_code_fence_line(trimmed) {
                    return None;
                }
                let payload = trimmed
                    .split_once('.')
                    .and_then(|(prefix, rest)| {
                        prefix
                            .chars()
                            .all(|ch| ch.is_ascii_digit())
                            .then_some(rest.trim())
                    })
                    .unwrap_or(trimmed);
                if is_command_code_fence_line(payload) {
                    return None;
                }
                (!payload.is_empty()).then(|| payload.to_string())
            })
            .collect(),
    )
}

fn extract_codex_thread_id(stdout_jsonl: &str) -> Option<String> {
    stdout_jsonl.lines().find_map(|line| {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            return None;
        }
        let parsed: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        if parsed.get("type").and_then(|value| value.as_str()) != Some("thread.started") {
            return None;
        }
        parsed
            .get("thread_id")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned)
    })
}

fn extract_codex_last_message_from_jsonl(stdout_jsonl: &str) -> Option<String> {
    let mut last_message = None;
    for line in stdout_jsonl.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if parsed.get("type").and_then(|value| value.as_str()) != Some("item.completed") {
            continue;
        }
        let item = match parsed.get("item") {
            Some(value) => value,
            None => continue,
        };
        if item.get("type").and_then(|value| value.as_str()) != Some("agent_message") {
            continue;
        }
        last_message = item
            .get("text")
            .and_then(|value| value.as_str())
            .map(ToOwned::to_owned);
    }
    last_message
}

fn finalize_codex_result(
    result: (String, String, i32),
    session_key: Option<&str>,
    resume_thread_id: Option<&str>,
    last_message_path: Option<&PathBuf>,
) -> Result<(String, String, i32), String> {
    let (stdout, stderr, exit_code) = result;
    if let Some(path) = last_message_path {
        let file_message = std::fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let _ = std::fs::remove_file(path);
        let stdout_text = file_message
            .or_else(|| extract_codex_last_message_from_jsonl(&stdout))
            .unwrap_or_default();
        if let Some(key) = session_key {
            if exit_code == 0 {
                if let Some(thread_id) = extract_codex_thread_id(&stdout)
                    .or_else(|| resume_thread_id.map(ToOwned::to_owned))
                {
                    set_codex_session_id(key, &thread_id);
                }
            } else {
                clear_codex_session_id(key);
            }
        }
        return Ok((stdout_text, stderr, exit_code));
    }
    Ok((stdout, stderr, exit_code))
}

fn resolve_gemini() -> Option<std::path::PathBuf> {
    if let Some(p) = env_var("DAACS_GEMINI_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["gemini", "gemini.cmd", "gemini.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    if let Some(appdata) = env_var("APPDATA") {
        let candidate = Path::new(&appdata).join("npm").join("gemini.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Some(local) = env_var("LOCALAPPDATA") {
        let candidate = Path::new(&local).join("npm").join("gemini.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_codex() -> Option<std::path::PathBuf> {
    if let Some(p) = env_var("DAACS_CODEX_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["codex", "codex.cmd", "codex.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    if let Some(appdata) = env_var("APPDATA") {
        let candidate = Path::new(&appdata).join("npm").join("codex.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    if let Some(local) = env_var("LOCALAPPDATA") {
        let candidate = Path::new(&local).join("npm").join("codex.cmd");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn resolve_local_llm() -> Option<std::path::PathBuf> {
    if let Some(p) = env_var("DAACS_LOCAL_LLM_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["ollama", "ollama.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        if let Some(local) = env_var("LOCALAPPDATA") {
            let candidate = Path::new(&local)
                .join("Programs")
                .join("Ollama")
                .join("ollama.exe");
            if candidate.exists() {
                return Some(candidate);
            }
            let winget_link = Path::new(&local)
                .join("Microsoft")
                .join("WinGet")
                .join("Links")
                .join("ollama.exe");
            if winget_link.exists() {
                return Some(winget_link);
            }
        }
        if let Some(program_files) = env_var("ProgramFiles") {
            let candidate = Path::new(&program_files).join("Ollama").join("ollama.exe");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn resolve_optional_local_model_path(
    path: Option<&str>,
) -> Result<Option<std::path::PathBuf>, String> {
    let Some(value) = path.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(std::path::PathBuf::from(value)))
}

fn local_llm_response_is_configuration_error(response: &str) -> bool {
    let trimmed = response.trim_start();
    trimmed.starts_with("Error: Local LLM")
        || trimmed.starts_with("Error: Multiple local LLM models were found")
        || trimmed.starts_with("Error: Could not find llama-cli")
}

fn resolve_ollama_model_name() -> Result<String, String> {
    env_var("DAACS_LOCAL_LLM_MODEL").ok_or_else(|| {
        "DAACS_LOCAL_LLM_MODEL is not set. Set the Ollama model name before using the Ollama provider."
            .to_string()
    })
}

#[cfg(windows)]
fn resolve_claude_cli() -> Option<std::path::PathBuf> {
    if let Some(p) = env_var("DAACS_CLAUDE_CLI_PATH") {
        let path = Path::new(&p);
        if path.exists() {
            return Some(path.to_path_buf());
        }
        return None;
    }
    for name in ["claude", "claude.cmd", "claude.exe"] {
        if let Some(path) = which_path(name) {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = env_var("APPDATA") {
            let candidate = Path::new(&appdata).join("npm").join("claude.cmd");
            if candidate.exists() {
                return Some(candidate);
            }
        }
        if let Some(local) = env_var("LOCALAPPDATA") {
            let candidate_npm = Path::new(&local).join("npm").join("claude.cmd");
            if candidate_npm.exists() {
                return Some(candidate_npm);
            }
            let candidate_programs = Path::new(&local)
                .join("Programs")
                .join("Claude")
                .join("claude.exe");
            if candidate_programs.exists() {
                return Some(candidate_programs);
            }
        }
    }
    None
}

fn which_path(name: &str) -> Option<std::path::PathBuf> {
    // First try standard PATH
    if let Some(found) = std::env::var_os("PATH").and_then(|paths| {
        for p in std::env::split_paths(&paths) {
            let candidate = p.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    }) {
        return Some(found);
    }

    // macOS app bundles have stripped PATH — probe common install locations manually
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/david".to_string());
        let extra_paths = vec![
            // npm global (system node)
            "/usr/local/bin".to_string(),
            "/usr/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
            "/opt/homebrew/sbin".to_string(),
            // npm global via corepack / classic
            format!("{}/node_modules/.bin", home),
            format!("{}/Library/pnpm", home),
            // nvm versions — try active symlink and latest dirs
            format!(
                "{}/.nvm/versions/node/$(ls -t {}/.nvm/versions/node 2>/dev/null | head -1)/bin",
                home, home
            ),
            format!("{}/.nvm/alias/default/bin", home),
        ];
        // Simpler: just glob common nvm node bin dirs
        let nvm_base = format!("{}/.nvm/versions/node", home);
        if let Ok(entries) = std::fs::read_dir(&nvm_base) {
            let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
            versions.sort_by(|a, b| b.file_name().cmp(&a.file_name())); // newest first
            for entry in versions.iter().take(5) {
                let bin = entry.path().join("bin").join(name);
                if bin.is_file() {
                    return Some(bin);
                }
                // npm global under this node version
                let global_bin = entry.path().join("lib/node_modules/.bin").join(name);
                if global_bin.is_file() {
                    return Some(global_bin);
                }
            }
        }
        for dir in &extra_paths {
            if dir.contains('$') || dir.contains('(') {
                continue;
            } // skip shell expressions
            let bin = Path::new(dir).join(name);
            if bin.is_file() {
                return Some(bin);
            }
        }
    }

    None
}

fn build_augmented_path() -> String {
    let current_path = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_else(|_| "/Users/david".to_string());

    let mut extra: Vec<String> = vec![
        "/opt/homebrew/bin".to_string(),
        "/opt/homebrew/sbin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
        "/bin".to_string(),
    ];

    // nvm: find the latest installed node version
    let nvm_base = format!("{}/.nvm/versions/node", home);
    if let Ok(entries) = std::fs::read_dir(&nvm_base) {
        let mut versions: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        for entry in versions.iter().take(3) {
            extra.push(entry.path().join("bin").to_string_lossy().to_string());
        }
    }

    // Build combined PATH: extras first, then original
    let mut paths: Vec<String> = extra;
    for p in current_path.split(':') {
        if !p.is_empty() {
            paths.push(p.to_string());
        }
    }
    paths.join(":")
}

fn preferred_provider() -> &'static str {
    match env_var("DAACS_CLI_PROVIDER").as_deref() {
        Some("codex") => "codex",
        Some("gemini") => "gemini",
        Some("claude") => "claude",
        Some("local_llm") => "local_llm",
        _ => "codex",
    }
}

#[derive(serde::Serialize)]
pub struct CliRunResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub provider: String,
}

#[tauri::command]
pub fn omni_cli_which() -> Result<serde_json::Value, String> {
    cli_which()
}

#[tauri::command]
pub fn list_local_llm_models() -> Result<serde_json::Value, String> {
    let candidates = omni_ai_core::list_local_model_candidates();
    info!(
        "local LLM model candidates discovered: {}",
        candidates.len()
    );
    serde_json::to_value(candidates).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn omni_cli_workspace_path(project_id: Option<String>) -> Result<String, String> {
    cli_workspace_path(project_id)
}

#[tauri::command]
pub async fn open_workspace_directory_dialog(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let Some(path) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = PathBuf::try_from(path).map_err(|error| format!("dialog_path_invalid:{error}"))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
pub fn open_path_in_file_manager(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("path_empty".to_string());
    }
    let target = PathBuf::from(trimmed);
    if !target.exists() {
        return Err(format!("path_not_found:{}", target.display()));
    }

    #[cfg(target_os = "macos")]
    let status = {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R");
        }
        command.arg(&target).status()
    };

    #[cfg(target_os = "windows")]
    let status = {
        let mut command = Command::new("explorer");
        if target.is_file() {
            command.arg(format!("/select,{}", target.display()));
        } else {
            command.arg(&target);
        }
        command.status()
    };

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let status = Command::new("xdg-open").arg(&target).status();

    let status = status.map_err(|error| format!("open_path_failed:{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("open_path_failed_exit:{status}"))
    }
}

#[tauri::command]
pub fn omni_cli_initialize_local() -> Result<(), String> {
    let _ = cli_workspace_path(None)?;
    ensure_user_daacs_data_root()?;
    ensure_agents_metadata_user_file()?;
    Ok(())
}

fn desktop_resources_base() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "invalid CARGO_MANIFEST_DIR parent".to_string())
}

fn user_daacs_data_root() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
}

fn ensure_user_daacs_data_root() -> Result<(), String> {
    let root = user_daacs_data_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("create_data_root: {} ({})", e, root.display()))
}

fn factory_prompt_key_for_id(agent_id: &str) -> String {
    let folded: String = agent_id
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let trimmed = folded.trim_matches('_');
    let body = if trimmed.is_empty() {
        "custom"
    } else {
        trimmed
    };
    format!("agent_{}", body)
}

#[tauri::command]
pub fn save_factory_agent(
    agent_id: String,
    display_name: String,
    summary: String,
    prompt_text: String,
    skill_bundle_refs: Vec<String>,
    office_role: Option<String>,
    skill_bundle_role: Option<String>,
    character: Option<String>,
) -> Result<serde_json::Value, String> {
    let agent_id = agent_id.trim().to_string();
    if agent_id.is_empty() {
        return Err("agent_id_empty".to_string());
    }
    let prompt_key = factory_prompt_key_for_id(&agent_id);
    let root = user_daacs_data_root();
    let prompts_dir = root.join("Resources/prompts");
    let agents_dir = root.join("Resources/Agents");
    std::fs::create_dir_all(&prompts_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&agents_dir).map_err(|e| e.to_string())?;

    let lines: Vec<String> = prompt_text
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    let display = display_name.trim();
    let prompt_doc = serde_json::json!({
        "description": format!("Factory agent: {}", display),
        "content": lines,
    });
    let prompt_path = prompts_dir.join(format!("{}.json", prompt_key));
    let prompt_json = serde_json::to_string_pretty(&prompt_doc).map_err(|e| e.to_string())?;
    std::fs::write(&prompt_path, prompt_json).map_err(|e| e.to_string())?;

    ensure_agents_metadata_user_file()?;
    let user_agents_path = agents_metadata_user_path();
    let mut user_root = if user_agents_path.exists() {
        let raw = std::fs::read_to_string(&user_agents_path).map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&raw).map_err(|e| e.to_string())?
    } else {
        serde_json::json!({ "schema_version": 1, "agents": [] })
    };
    let agents_arr = user_root
        .get_mut("agents")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "agents_metadata_invalid_shape".to_string())?;

    let id_lower = agent_id.to_lowercase();
    agents_arr.retain(|a| {
        a.get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_lowercase() != id_lower)
            .unwrap_or(true)
    });

    let summary_trim = summary.trim();
    let summary_val = if summary_trim.is_empty() {
        display.to_string()
    } else {
        summary_trim.to_string()
    };
    let office = office_role
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("developer")
        .to_string();
    let skill_role = skill_bundle_role
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            skill_bundle_refs
                .first()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "developer".to_string())
        });
    let character_safe = match character
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) => sanitize_character_filename(s)?,
        None => sanitize_character_filename(&format!("{}Data.json", &agent_id))?,
    };
    let entry = serde_json::json!({
        "id": agent_id,
        "display_name": display,
        "summary": summary_val,
        "office_role": office,
        "prompt_key": prompt_key,
        "prompt_file": format!("Resources/prompts/{}.json", prompt_key),
        "skill_bundle_refs": skill_bundle_refs,
        "skill_bundle_role": skill_role,
        "character": character_safe,
        "factory_origin": true,
    });
    agents_arr.push(entry);

    let out_user = serde_json::to_string_pretty(&user_root).map_err(|e| e.to_string())?;
    std::fs::write(&user_agents_path, out_user).map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "ok": true,
        "promptKey": prompt_key,
        "agentId": agent_id,
    }))
}

#[tauri::command]
pub fn get_agent_prompt_by_prompt_key(prompt_key: String) -> Result<String, String> {
    let key = prompt_key.trim();
    if key.is_empty() {
        return Err("prompt_key_empty".to_string());
    }
    crate::prompts::load_prompt_content_merged(key)
        .ok_or_else(|| format!("prompt_not_found:{}", key))
}

fn agents_metadata_bundled_path() -> Result<std::path::PathBuf, String> {
    Ok(desktop_resources_base()?.join("Resources/Agents/agents_metadata.json"))
}

fn agents_metadata_user_path() -> std::path::PathBuf {
    user_daacs_data_root().join("Resources/Agents/agents_metadata.json")
}

fn default_agents_metadata_seed_body() -> Result<String, String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "schema_version": 1,
        "agents": [],
    }))
    .map_err(|e| format!("default_agents_metadata_seed: {}", e))
}

fn ensure_agents_metadata_user_file() -> Result<(), String> {
    let user_path = agents_metadata_user_path();
    let legacy_user_path = user_daacs_data_root().join("Resources/Agents/agents_user.json");
    let user_parent = user_path
        .parent()
        .ok_or_else(|| "agents_metadata_user_parent_missing".to_string())?;
    std::fs::create_dir_all(user_parent)
        .map_err(|e| format!("create_dir: {} ({})", e, user_parent.display()))?;

    let should_seed = match std::fs::read_to_string(&user_path) {
        Ok(content) => content.trim().is_empty(),
        Err(_) => true,
    };
    if !should_seed {
        return Ok(());
    }

    let body = if legacy_user_path.is_file() {
        let legacy = std::fs::read_to_string(&legacy_user_path).map_err(|e| {
            format!(
                "read agents_metadata legacy_user: {} ({})",
                e,
                legacy_user_path.display()
            )
        })?;
        if legacy.trim().is_empty() {
            default_agents_metadata_seed_body()?
        } else {
            legacy
        }
    } else {
        let bundle_path = agents_metadata_bundled_path()?;
        match std::fs::read_to_string(&bundle_path) {
            Ok(s) if !s.trim().is_empty() => s,
            Ok(_) | Err(_) => default_agents_metadata_seed_body()?,
        }
    };

    std::fs::write(&user_path, body)
        .map_err(|e| format!("write agents_metadata: {} ({})", e, user_path.display()))
}

fn read_agents_metadata_base_raw() -> Result<String, String> {
    let user_path = agents_metadata_user_path();
    ensure_agents_metadata_user_file()?;
    std::fs::read_to_string(&user_path)
        .map_err(|e| format!("read agents_metadata user: {} ({})", e, user_path.display()))
}

fn sanitize_character_filename(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("character_filename_empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("character_filename_too_long".to_string());
    }
    if trimmed.contains("..") || trimmed.starts_with('.') {
        return Err("character_filename_invalid".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("character_filename_invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn agent_character_bundled_path(filename: &str) -> Result<std::path::PathBuf, String> {
    let safe = sanitize_character_filename(filename)?;
    Ok(desktop_resources_base()?
        .join("Resources/Agents/Characters")
        .join(safe))
}

#[tauri::command]
pub fn read_agent_character_file(filename: String) -> Result<String, String> {
    let safe = sanitize_character_filename(&filename)?;
    let user_path = user_daacs_data_root()
        .join("Resources/Agents/Characters")
        .join(&safe);
    if user_path.is_file() {
        match std::fs::read_to_string(&user_path) {
            Ok(s) if !s.trim().is_empty() => return Ok(s),
            Ok(_) => {}
            Err(_) => {}
        }
    }
    let bundle_path = agent_character_bundled_path(&filename)?;
    std::fs::read_to_string(&bundle_path).map_err(|e| {
        format!(
            "read agent character (bundle): {} ({})",
            e,
            bundle_path.display()
        )
    })
}

fn agent_characters_user_dir() -> std::path::PathBuf {
    user_daacs_data_root().join("Resources/Agents/Characters")
}

#[tauri::command]
pub fn get_agent_characters_user_dir() -> Result<String, String> {
    Ok(agent_characters_user_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub fn save_agent_character_file(filename: String, content: String) -> Result<(), String> {
    let safe = sanitize_character_filename(&filename)?;
    let _: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("invalid_json: {}", e))?;
    let dir = agent_characters_user_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir: {} ({})", e, dir.display()))?;
    let path = dir.join(&safe);
    std::fs::write(&path, content).map_err(|e| format!("write: {} ({})", e, path.display()))?;
    Ok(())
}

#[tauri::command]
pub fn read_agents_metadata_bundled() -> Result<String, String> {
    get_agents_metadata_json()
}

#[tauri::command]
pub fn save_agents_metadata_bundled(content: String) -> Result<(), String> {
    let mut root: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("invalid_json: {}", e))?;
    enforce_required_default_agents(&mut root)?;
    validate_agents_metadata_schema(&root)?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let path = agents_metadata_user_path();
    let dir = path
        .parent()
        .ok_or_else(|| "agents_metadata_user_parent_missing".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir: {} ({})", e, dir.display()))?;
    std::fs::write(&path, pretty)
        .map_err(|e| format!("write agents_metadata: {} ({})", e, path.display()))
}

#[tauri::command]
pub fn remove_agent_user_artifacts(
    agent_id: String,
    prompt_key: String,
    character_filename: Option<String>,
) -> Result<(), String> {
    let id_norm = agent_id.trim().to_lowercase();
    if id_norm.is_empty() {
        return Err("agent_id_empty".to_string());
    }
    let agents_user_path = agents_metadata_user_path();
    if agents_user_path.is_file() {
        let raw = std::fs::read_to_string(&agents_user_path).map_err(|e| {
            format!(
                "read agents_metadata: {} ({})",
                e,
                agents_user_path.display()
            )
        })?;
        let mut root: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
            format!(
                "parse agents_metadata: {} ({})",
                e,
                agents_user_path.display()
            )
        })?;
        if let Some(arr) = root.get_mut("agents").and_then(|v| v.as_array_mut()) {
            arr.retain(|entry| {
                let Some(eid) = entry.get("id").and_then(|v| v.as_str()) else {
                    return true;
                };
                eid.trim().to_lowercase() != id_norm
            });
        }
        let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        std::fs::write(&agents_user_path, pretty).map_err(|e| {
            format!(
                "write agents_metadata: {} ({})",
                e,
                agents_user_path.display()
            )
        })?;
    }
    let pk = prompt_key.trim();
    if !pk.is_empty() {
        if let Ok(path) = prompt_file_user_path(pk) {
            if path.is_file() {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    if let Some(cf) = character_filename {
        let trimmed = cf.trim();
        if !trimmed.is_empty() {
            if let Ok(safe) = sanitize_character_filename(trimmed) {
                let path = agent_characters_user_dir().join(&safe);
                if path.is_file() {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_agents_metadata_user_path() -> Result<String, String> {
    Ok(agents_metadata_user_path().to_string_lossy().to_string())
}

fn sanitize_prompt_key(key: &str) -> Result<String, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("prompt_key_empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("prompt_key_too_long".to_string());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err("prompt_key_invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn is_legacy_bundled_implementation_agent(agent: &serde_json::Value) -> bool {
    let id = agent
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    if !matches!(id.as_str(), "developer" | "designer" | "devops") {
        return false;
    }

    let prompt_key = agent
        .get("prompt_key")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default();
    let prompt_file = agent
        .get("prompt_file")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().replace('\\', "/").to_lowercase())
        .unwrap_or_default();

    matches!(
        prompt_key.as_str(),
        "agent_developer" | "agent_designer" | "agent_devops"
    ) || matches!(
        prompt_file.as_str(),
        "resources/prompts/agent_developer.json"
            | "resources/prompts/agent_designer.json"
            | "resources/prompts/agent_devops.json"
    )
}

fn enforce_required_default_agents(in_root: &mut serde_json::Value) -> Result<bool, String> {
    let root_agents = in_root
        .get_mut("agents")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "agents_metadata_missing_agents_array".to_string())?;
    let required_ids = HashSet::from([
        "pm".to_string(),
        "frontend".to_string(),
        "backend".to_string(),
        "reviewer".to_string(),
        "verifier".to_string(),
    ]);
    let before_len = root_agents.len();
    root_agents.retain(|agent| {
        let id = agent
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_lowercase())
            .unwrap_or_default();
        !required_ids.contains(&id) && !is_legacy_bundled_implementation_agent(agent)
    });
    let _removed_existing_defaults = root_agents.len() != before_len;

    root_agents.push(serde_json::json!({
        "id": "pm",
        "display_name": "PM",
        "summary": "Planning and specification; delegates implementation work to frontend/backend, then reviewer/verifier.",
        "office_role": "pm",
        "prompt_key": "agent_pm",
        "prompt_file": "Resources/prompts/agent_pm.json",
        "skill_bundle_role": "pm",
        "skill_bundle_refs": [
            "concise-planning",
            "plan-writing",
            "writing-plans",
            "executing-plans",
            "product-manager-toolkit",
            "architecture-decision-records"
        ],
        "character": "pmData.json"
    }));
    root_agents.push(serde_json::json!({
        "id": "frontend",
        "display_name": "Frontend Developer",
        "summary": "UI/UX and client-side implementation per PM tasks.",
        "office_role": "developer_front",
        "prompt_key": "agent_frontend",
        "prompt_file": "Resources/prompts/agent_frontend.json",
        "skill_bundle_role": "developer",
        "skill_bundle_refs": [
            "typescript-pro",
            "react-best-practices",
            "clean-code",
            "api-patterns",
            "nextjs-app-router-patterns",
            "javascript-mastery",
            "error-handling-patterns"
        ],
        "character": "frontendData.json"
    }));
    root_agents.push(serde_json::json!({
        "id": "backend",
        "display_name": "Backend Developer",
        "summary": "APIs, data, and backend implementation per PM tasks.",
        "office_role": "developer_back",
        "prompt_key": "agent_backend",
        "prompt_file": "Resources/prompts/agent_backend.json",
        "skill_bundle_role": "developer",
        "skill_bundle_refs": [
            "rust",
            "api-patterns",
            "clean-code",
            "database-design",
            "sql-pro"
        ],
        "character": "backendData.json"
    }));
    root_agents.push(serde_json::json!({
        "id": "reviewer",
        "display_name": "Reviewer",
        "summary": "Quality review, regression detection, and readiness assessment.",
        "office_role": "reviewer",
        "prompt_key": "agent_reviewer",
        "prompt_file": "Resources/prompts/agent_reviewer.json",
        "skill_bundle_role": "reviewer",
        "skill_bundle_refs": [
            "code-reviewer",
            "code-review-excellence",
            "code-review-checklist",
            "production-code-audit",
            "security-auditor",
            "systematic-debugging",
            "verification-before-completion"
        ],
        "character": "reviewerData.json"
    }));
    root_agents.push(serde_json::json!({
        "id": "verifier",
        "display_name": "Verifier",
        "summary": "Executable verification, evidence collection, and delivery validation.",
        "office_role": "verifier",
        "prompt_key": "agent_verifier",
        "prompt_file": "Resources/prompts/agent_verifier.json",
        "skill_bundle_role": "verifier",
        "skill_bundle_refs": [
            "verification-before-completion",
            "lint-and-validate",
            "test-automator",
            "test-fixing",
            "systematic-debugging",
            "performance-profiling",
            "deployment-validation-config-validate"
        ],
        "character": "verifierData.json"
    }));
    Ok(true)
}

fn prompts_user_dir() -> PathBuf {
    user_daacs_data_root().join("Resources/prompts")
}

fn prompt_file_bundled_path(key: &str) -> Result<PathBuf, String> {
    let safe = sanitize_prompt_key(key)?;
    Ok(desktop_resources_base()?
        .join("Resources/prompts")
        .join(format!("{}.json", safe)))
}

fn prompt_file_user_path(key: &str) -> Result<PathBuf, String> {
    let safe = sanitize_prompt_key(key)?;
    Ok(prompts_user_dir().join(format!("{}.json", safe)))
}

fn read_prompt_merged_raw_for_key(prompt_key: &str) -> Result<String, String> {
    let user_path = prompt_file_user_path(prompt_key)?;
    if user_path.is_file() {
        match std::fs::read_to_string(&user_path) {
            Ok(s) if !s.trim().is_empty() => return Ok(s),
            Ok(_) => {}
            Err(e) => {
                return Err(format!("read prompt user: {} ({})", e, user_path.display()));
            }
        }
    }
    let bundle_path = prompt_file_bundled_path(prompt_key)?;
    std::fs::read_to_string(&bundle_path)
        .map_err(|e| format!("read prompt bundle: {} ({})", e, bundle_path.display()))
}

#[tauri::command]
pub fn get_prompts_user_dir() -> Result<String, String> {
    Ok(prompts_user_dir().to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_prompt_file_by_key(prompt_key: String) -> Result<String, String> {
    read_prompt_merged_raw_for_key(prompt_key.trim())
}

#[tauri::command]
pub fn save_prompt_file_by_key(prompt_key: String, content: String) -> Result<(), String> {
    let root: serde_json::Value =
        serde_json::from_str(content.trim()).map_err(|e| format!("invalid_json: {}", e))?;
    let path = prompt_file_user_path(&prompt_key)?;
    let dir = path
        .parent()
        .ok_or_else(|| "prompt_user_parent_missing".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("create_dir: {} ({})", e, dir.display()))?;
    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| format!("write prompt: {} ({})", e, path.display()))
}

#[tauri::command]
pub fn list_prompt_keys() -> Result<String, String> {
    let mut keys = HashSet::<String>::new();
    let bundle_dir = desktop_resources_base()?.join("Resources/prompts");
    let user_dir = prompts_user_dir();
    for dir in [&bundle_dir, &user_dir] {
        if !dir.is_dir() {
            continue;
        }
        for entry in std::fs::read_dir(dir).map_err(|e| format!("read_dir: {}", e))? {
            let entry = entry.map_err(|e| format!("read_dir entry: {}", e))?;
            let p = entry.path();
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem.is_empty() {
                continue;
            }
            if let Ok(safe) = sanitize_prompt_key(stem) {
                keys.insert(safe);
            }
        }
    }
    let mut sorted: Vec<String> = keys.into_iter().collect();
    sorted.sort();
    serde_json::to_string(&sorted).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_agents_metadata_json() -> Result<String, String> {
    let raw = read_agents_metadata_base_raw()?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse agents_metadata: {}", e))?;

    let changed = enforce_required_default_agents(&mut root)?;
    validate_agents_metadata_schema(&root)?;
    if changed {
        let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
        let path = agents_metadata_user_path();
        let parent = path
            .parent()
            .ok_or_else(|| "agents_metadata_user_parent_missing".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir: {} ({})", e, parent.display()))?;
        std::fs::write(&path, &pretty)
            .map_err(|e| format!("write agents_metadata: {} ({})", e, path.display()))?;
    }
    serde_json::to_string(&root).map_err(|e| e.to_string())
}

pub fn initialize_agents_metadata_on_startup() -> Result<(), String> {
    get_agents_metadata_json().map(|_| ())?;
    prune_local_office_state_files_on_startup()
}

#[derive(Deserialize)]
struct AgentMetadataLite {
    id: Option<String>,
    prompt_key: Option<String>,
}

#[derive(Deserialize)]
struct AgentsMetadataLite {
    agents: Vec<AgentMetadataLite>,
}

fn fold_role_key(in_value: &str) -> String {
    in_value.trim().to_lowercase().replace([' ', '-'], "_")
}

fn normalize_role_key(in_value: &str) -> String {
    let key = fold_role_key(in_value);
    match key.as_str() {
        "피엠" | "기획" | "기획자" => "pm".to_string(),
        "developer_front" | "developerfront" | "front" | "front_end" | "frontend" | "프론트"
        | "프론트엔드" => "frontend".to_string(),
        "developer_back" | "developerback" | "back" | "back_end" | "backend" | "백엔드"
        | "서버" => "backend".to_string(),
        "review" | "reviewer" | "리뷰" | "리뷰어" | "검토" | "검토자" => {
            "reviewer".to_string()
        }
        "verify" | "verification" | "verifier" | "검증" | "검증자" | "검수" | "검수자" => {
            "verifier".to_string()
        }
        "generic" | "general" | "agent" => "agent".to_string(),
        _ => key,
    }
}

fn validate_agents_metadata_schema(in_root: &serde_json::Value) -> Result<(), String> {
    let agents = in_root
        .get("agents")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "agents_metadata_missing_agents_array".to_string())?;
    let mut id_seen = std::collections::HashSet::<String>::new();
    for item in agents {
        let id = item
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_lowercase())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "agents_metadata_invalid:id_required".to_string())?;
        let prompt_key = item
            .get("prompt_key")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("agents_metadata_invalid:prompt_key_required:{}", id))?;
        if prompt_key.is_empty() {
            return Err(format!(
                "agents_metadata_invalid:required_field_empty:{}",
                id
            ));
        }
        if !id_seen.insert(id.clone()) {
            return Err(format!("agents_metadata_invalid:duplicate_id:{}", id));
        }
    }
    Ok(())
}

fn find_prompt_key_for_role(in_role: &str) -> Result<Option<String>, String> {
    let role_key = normalize_role_key(in_role);
    if role_key.is_empty() {
        return Ok(None);
    }
    let merged = get_agents_metadata_json()?;
    let parsed: AgentsMetadataLite = serde_json::from_str(&merged)
        .map_err(|e| format!("parse merged agents metadata: {}", e))?;
    for agent in parsed.agents {
        let id = agent
            .id
            .as_deref()
            .map(normalize_role_key)
            .unwrap_or_default();
        if role_key == id {
            let key = agent.prompt_key.unwrap_or_default().trim().to_string();
            if !key.is_empty() {
                return Ok(Some(key));
            }
        }
    }
    Ok(None)
}

#[tauri::command]
pub async fn omni_cli_run_command(
    instruction: String,
    cwd: Option<String>,
    system_prompt: Option<String>,
    provider_override: Option<String>,
    local_llm_path: Option<String>,
    local_llm_base_url: Option<String>,
    session_key: Option<String>,
) -> Result<CliRunResult, String> {
    cli_run_command(
        instruction,
        cwd,
        system_prompt,
        provider_override,
        local_llm_path,
        local_llm_base_url,
        session_key,
    )
    .await
}

#[tauri::command]
pub fn prompting_sequencer_system_prompt_command(
    project_name: String,
    channel_id: String,
) -> String {
    prompting_sequencer_system_prompt(project_name.trim(), channel_id.trim())
}

#[tauri::command]
pub fn prompting_sequencer_save_todo_command(
    project_name: String,
    todo_json: String,
) -> Result<(), String> {
    let project = project_name.trim();
    if project.is_empty() {
        return Err("project_name_empty".to_string());
    }
    let json_text = todo_json.trim();
    if json_text.is_empty() {
        return Err("todo_json_empty".to_string());
    }
    let todo: SequencerTodoList = serde_json::from_str(json_text).map_err(|e| e.to_string())?;
    let _ = save_todo_list(MAIN_PROGRAM_NAME, project, &todo)?;
    Ok(())
}

#[tauri::command]
pub fn prompting_sequencer_load_todo_command(
    project_name: String,
    channel_id: String,
) -> Option<SequencerTodoList> {
    let project = project_name.trim();
    let channel = channel_id.trim();
    if project.is_empty() || channel.is_empty() {
        return None;
    }
    load_todo_list(MAIN_PROGRAM_NAME, project, channel)
}

#[tauri::command]
pub fn prompting_sequencer_clear_channel_command(
    project_name: String,
    channel_id: String,
) -> Result<(), String> {
    let project = project_name.trim();
    let channel = channel_id.trim();
    if project.is_empty() || channel.is_empty() {
        return Err("project_or_channel_empty".to_string());
    }
    omni_ai_core::delete_todo_list(MAIN_PROGRAM_NAME, project, channel)
}

#[tauri::command]
pub fn prompting_sequencer_mark_done_command(
    project_name: String,
    channel_id: String,
    item_number: u32,
) -> Result<SequencerTodoList, String> {
    let project = project_name.trim();
    let channel = channel_id.trim();
    if project.is_empty() || channel.is_empty() {
        return Err("project_or_channel_empty".to_string());
    }
    mark_item_done(MAIN_PROGRAM_NAME, project, channel, item_number)
}

#[tauri::command]
pub fn prompting_sequencer_extract_commands_command(in_stdout: String) -> Vec<String> {
    extract_sequencer_commands(&in_stdout)
}

#[tauri::command]
pub async fn run_workspace_command(
    in_command: String,
    in_cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let cmd_line = in_command.trim().to_string();
    if cmd_line.is_empty() {
        return Err("workspace_command_empty".to_string());
    }
    let cwd_buf: PathBuf = match in_cwd.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let pb = PathBuf::from(p);
            if !pb.is_dir() {
                return Err(format!("workspace_cwd_not_dir:{}", pb.display()));
            }
            pb
        }
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };

    #[cfg(windows)]
    let command = {
        use std::os::windows::process::CommandExt;
        let mut command = TokioCommand::new("cmd.exe");
        command
            .args(["/C", &cmd_line])
            .current_dir(&cwd_buf)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW);
        command
    };
    #[cfg(not(windows))]
    let command = {
        let mut command = TokioCommand::new("sh");
        command
            .args(["-c", &cmd_line])
            .current_dir(&cwd_buf)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    };

    let (stdout, stderr, exit_code) = run_tokio_command_with_timeout(
        command,
        None,
        Some(WORKSPACE_COMMAND_TIMEOUT_SECS),
        &cli_text(
            L10N_KEY_CLI_WORKSPACE_COMMAND_TIMED_OUT,
            "Workspace command timed out after 120 seconds. The command may be interactive or long-running.",
        ),
    )
    .await
    .map_err(|error| error.to_string())?;

    Ok(serde_json::json!({
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "provider": "workspace_cmd",
    }))
}

#[tauri::command]
pub async fn stop_active_cli_commands() -> Result<serde_json::Value, String> {
    let pids = snapshot_active_pids();
    let mut stopped: Vec<u32> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    for pid in pids {
        #[cfg(windows)]
        {
            let output = TokioCommand::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .await
                .map_err(|error| error.to_string())?;
            if output.status.success() {
                stopped.push(pid);
                unregister_active_pid(pid);
            } else {
                failed.push(format!(
                    "{}:{}",
                    pid,
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        }

        #[cfg(not(windows))]
        {
            let group_target = format!("-{}", pid);
            let term_output = TokioCommand::new("kill")
                .args(["-TERM", &group_target])
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .output()
                .await
                .map_err(|error| error.to_string())?;

            let success = if term_output.status.success() {
                true
            } else {
                let kill_output = TokioCommand::new("kill")
                    .args(["-KILL", &group_target])
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .map_err(|error| error.to_string())?;
                kill_output.status.success()
            };

            if success {
                stopped.push(pid);
                unregister_active_pid(pid);
            } else {
                failed.push(format!("{}:kill_failed", pid));
            }
        }
    }

    Ok(serde_json::json!({
        "status": if failed.is_empty() { "stopped" } else { "partial" },
        "stopped_pids": stopped,
        "failed": failed,
    }))
}

async fn cli_run_command(
    instruction: String,
    cwd: Option<String>,
    system_prompt: Option<String>,
    provider_override: Option<String>,
    local_llm_path: Option<String>,
    local_llm_base_url: Option<String>,
    session_key: Option<String>,
) -> Result<CliRunResult, String> {
    let work_dir = cwd
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists())
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let instruction = instruction.trim();
    if instruction.is_empty() {
        return Err(cli_text(
            L10N_KEY_CLI_ERROR_EMPTY_INSTRUCTION,
            "Instruction is empty",
        ));
    }

    let prefer: &str = match provider_override
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(s) if s.eq_ignore_ascii_case("gemini") => "gemini",
        Some(s) if s.eq_ignore_ascii_case("codex") => "codex",
        Some(s) if s.eq_ignore_ascii_case("claude") => "claude",
        Some(s) if s.eq_ignore_ascii_case("local_llm") => "local_llm",
        _ => preferred_provider(),
    };

    if prefer == "local_llm" {
        let model_path = match resolve_optional_local_model_path(local_llm_path.as_deref()) {
            Ok(path) => path,
            Err(error) => {
                return Ok(CliRunResult {
                    stdout: String::new(),
                    stderr: error,
                    exit_code: 1,
                    provider: "local_llm".to_string(),
                });
            }
        };
        let _local_llm_base_url = local_llm_base_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToOwned::to_owned);
        let sys_prompt = system_prompt.unwrap_or_default();
        let inst = instruction.to_string();

        // local_llm requires blocking inference, dispatch to async runtime thread pool.
        // The timeout is policy-driven so long local models can run without a hard-coded 300s wall.
        let blocking_task = tauri::async_runtime::spawn_blocking(move || {
            omni_ai_core::generate_response(&inst, &sys_prompt, model_path.as_deref())
        });
        let local_timeout_secs = local_llm_command_timeout_secs();
        let result_text = if let Some(timeout_secs) = local_timeout_secs {
            match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), blocking_task)
                .await
            {
                Ok(Ok(text)) => text,
                Ok(Err(e)) => return Err(format!("Local LLM task error: {}", e)),
                Err(_) => {
                    return Ok(CliRunResult {
                        stdout: String::new(),
                        stderr: local_llm_timeout_message(local_timeout_secs),
                        exit_code: 1,
                        provider: "local_llm".to_string(),
                    });
                }
            }
        } else {
            blocking_task
                .await
                .map_err(|e| format!("Local LLM task error: {}", e))?
        };

        if local_llm_response_is_configuration_error(&result_text) {
            return Ok(CliRunResult {
                stdout: String::new(),
                stderr: result_text,
                exit_code: 1,
                provider: "local_llm".to_string(),
            });
        }

        return Ok(CliRunResult {
            stdout: result_text,
            stderr: String::new(),
            exit_code: 0,
            provider: "local_llm".to_string(),
        });
    }

    let full_prompt = match system_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(sp) => format!("{}\n\n---\n\n{}", sp, instruction),
        None => instruction.to_string(),
    };

    let (provider, exe) = if prefer == "codex" {
        if let Some(p) = resolve_codex() {
            ("codex", p)
        } else if let Some(p) = resolve_local_llm() {
            ("claude", p)
        } else if let Some(p) = resolve_gemini() {
            ("gemini", p)
        } else if let Some(p) = resolve_local_llm() {
            ("local_llm", p)
        } else {
            return Err(cli_text(
                L10N_KEY_CLI_ERROR_NO_PROVIDER,
                "No available CLI provider found. Install codex/gemini/ollama CLI or set DAACS_CODEX_CLI_PATH / DAACS_GEMINI_CLI_PATH / DAACS_LOCAL_LLM_CLI_PATH.",
            ));
        }
    } else if prefer == "claude" {
        if let Some(p) = resolve_local_llm() {
            ("claude", p)
        } else {
            return Err(cli_text(
                L10N_KEY_CLI_ERROR_CLAUDE_PROVIDER_REQUIRES_OLLAMA,
                "Claude provider requires Ollama executable. Set DAACS_LOCAL_LLM_CLI_PATH to full ollama path (e.g. C:\\Users\\<user>\\AppData\\Local\\Programs\\Ollama\\ollama.exe).",
            ));
        }
    } else {
        if let Some(p) = resolve_gemini() {
            ("gemini", p)
        } else if let Some(p) = resolve_codex() {
            ("codex", p)
        } else if let Some(p) = resolve_local_llm() {
            ("claude", p)
        } else if let Some(p) = resolve_local_llm() {
            ("local_llm", p)
        } else {
            return Err(cli_text(
                L10N_KEY_CLI_ERROR_NO_PROVIDER,
                "No available CLI provider found. Install codex/gemini/ollama CLI or set DAACS_CODEX_CLI_PATH / DAACS_GEMINI_CLI_PATH / DAACS_LOCAL_LLM_CLI_PATH.",
            ));
        }
    };
    let (stdout, stderr, exit_code) = if provider == "gemini" {
        run_gemini(&exe, &full_prompt, &work_dir).await?
    } else if provider == "claude" {
        run_claude_via_ollama(&exe, &full_prompt, &work_dir).await?
    } else {
        let mut result = run_codex(&exe, &full_prompt, &work_dir, session_key.as_deref()).await?;
        if should_retry_codex_provider_failure(
            session_key.as_deref(),
            &result.0,
            &result.1,
            result.2,
        ) {
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            let retry = run_codex(&exe, &full_prompt, &work_dir, session_key.as_deref()).await?;
            if retry.2 == 0 {
                result = retry;
            } else {
                result = (
                    retry.0,
                    format!(
                        "{}\n\n[DAACS codex retry after transient provider failure]\n{}",
                        result.1, retry.1
                    ),
                    retry.2,
                );
            }
        }
        result
    };
    warn!(
        "[DAACS CLI] provider={} exit_code={} stderr_snippet={:?}",
        provider,
        exit_code,
        &stderr.chars().take(400).collect::<String>()
    );

    // Auto-log failures to ISSUES.md for quick dev visibility
    if exit_code != 0 {
        append_issue_log(provider, exit_code, &stderr);
    }

    Ok(CliRunResult {
        stdout,
        stderr,
        exit_code,
        provider: provider.to_string(),
    })
}

async fn run_gemini(
    exe: &std::path::Path,
    prompt: &str,
    cwd: &std::path::Path,
) -> Result<(String, String, i32), String> {
    let timeout_secs = provider_command_timeout_secs();
    let timeout_message =
        provider_timeout_message(L10N_KEY_CLI_GEMINI_TIMED_OUT, "Gemini", timeout_secs);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = TokioCommand::new("cmd.exe");
        command
            .arg("/c")
            .arg(exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .creation_flags(CREATE_NO_WINDOW);
        return run_tokio_command_with_timeout(
            command,
            Some(prompt),
            timeout_secs,
            &timeout_message,
        )
        .await
        .map_err(|error| error.to_string());
    }
    #[cfg(not(windows))]
    {
        let augmented_path = build_augmented_path();
        let mut command = TokioCommand::new(exe);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env("PATH", augmented_path)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy");
        run_tokio_command_with_timeout(command, Some(prompt), timeout_secs, &timeout_message)
            .await
            .map_err(|error| error.to_string())
    }
}

async fn run_codex(
    exe: &std::path::Path,
    prompt: &str,
    cwd: &std::path::Path,
    session_key: Option<&str>,
) -> Result<(String, String, i32), String> {
    let codex_workdir = cwd.to_string_lossy().to_string();
    let normalized_session_key = normalize_cli_session_key(session_key);
    let codex_config_args = build_codex_config_args(normalized_session_key.as_deref());
    let known_thread_id = normalized_session_key
        .as_deref()
        .and_then(get_codex_session_id);
    let capture_json = normalized_session_key.is_some();
    let last_message_path =
        capture_json.then(|| build_codex_last_message_path(normalized_session_key.as_deref()));
    let codex_temp_dir = cwd.join(".daacs_cli_tmp");
    let codex_temp_dir = std::fs::create_dir_all(&codex_temp_dir)
        .ok()
        .map(|_| codex_temp_dir);
    let before_workspace_snapshot = snapshot_workspace_files(cwd);
    let timeout_secs = provider_command_timeout_secs();
    let timeout_message =
        provider_timeout_message(L10N_KEY_CLI_CODEX_TIMED_OUT, "Codex", timeout_secs);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut command = TokioCommand::new("cmd.exe");
        command.arg("/c").arg(exe);
        if let Some(thread_id) = known_thread_id.as_deref() {
            command.args(["exec", "resume"]);
            command.args(&codex_config_args);
            command.args(["--skip-git-repo-check", thread_id]);
        } else {
            command.arg("exec");
            command.args(&codex_config_args);
            if !capture_json {
                command.arg("--ephemeral");
            }
            command.args(["--skip-git-repo-check", "-C", &codex_workdir]);
        }
        if let Some(path) = last_message_path.as_ref() {
            let path_text = path.to_string_lossy().to_string();
            command.args(["--json", "-o", &path_text]);
        }
        command
            .arg("-")
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
            .env_remove("CODEX_THREAD_ID")
            .creation_flags(CREATE_NO_WINDOW);
        if let Some(temp_dir) = codex_temp_dir.as_ref() {
            command
                .env("TMPDIR", temp_dir)
                .env("TMP", temp_dir)
                .env("TEMP", temp_dir);
        }
        let result =
            run_tokio_command_with_timeout(command, Some(prompt), timeout_secs, &timeout_message)
                .await
                .map_err(|error| error.to_string())?;
        let result = annotate_partial_artifact_timeout(
            result,
            before_workspace_snapshot.as_ref(),
            cwd,
            &timeout_message,
        );
        return finalize_codex_result(
            result,
            normalized_session_key.as_deref(),
            known_thread_id.as_deref(),
            last_message_path.as_ref(),
        );
    }
    #[cfg(not(windows))]
    {
        let mut command = TokioCommand::new(exe);
        if let Some(thread_id) = known_thread_id.as_deref() {
            command.args(["exec", "resume"]);
            command.args(&codex_config_args);
            command.args(["--skip-git-repo-check", thread_id]);
        } else {
            command.arg("exec");
            command.args(&codex_config_args);
            if !capture_json {
                command.arg("--ephemeral");
            }
            command.args(["--skip-git-repo-check", "-C", &codex_workdir]);
        }
        if let Some(path) = last_message_path.as_ref() {
            let path_text = path.to_string_lossy().to_string();
            command.args(["--json", "-o", &path_text]);
        }
        command
            .arg("-")
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
        if let Some(temp_dir) = codex_temp_dir.as_ref() {
            command
                .env("TMPDIR", temp_dir)
                .env("TMP", temp_dir)
                .env("TEMP", temp_dir);
        }
        let result =
            run_tokio_command_with_timeout(command, Some(prompt), timeout_secs, &timeout_message)
                .await
                .map_err(|error| error.to_string())?;
        let result = annotate_partial_artifact_timeout(
            result,
            before_workspace_snapshot.as_ref(),
            cwd,
            &timeout_message,
        );
        finalize_codex_result(
            result,
            normalized_session_key.as_deref(),
            known_thread_id.as_deref(),
            last_message_path.as_ref(),
        )
    }
}

async fn run_claude_via_ollama(
    exe: &std::path::Path,
    prompt: &str,
    cwd: &std::path::Path,
) -> Result<(String, String, i32), String> {
    let model = resolve_ollama_model_name()?;
    let timeout_secs = provider_command_timeout_secs();
    let timeout_message =
        provider_timeout_message(L10N_KEY_CLI_CLAUDE_TIMED_OUT, "Ollama/Claude", timeout_secs);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let claude_exe = resolve_claude_cli();
        let mut command = TokioCommand::new(exe);
        command.args(["run", model.as_str()]);
        if let Some(claude_path) = claude_exe {
            if let Some(claude_dir) = claude_path.parent() {
                let mut paths = vec![claude_dir.to_path_buf()];
                if let Some(current) = std::env::var_os("PATH") {
                    for p in std::env::split_paths(&current) {
                        paths.push(p);
                    }
                }
                if let Ok(joined) = std::env::join_paths(paths) {
                    command.env("PATH", joined);
                }
            }
        }
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy")
            .creation_flags(CREATE_NO_WINDOW);
        return run_tokio_command_with_timeout(
            command,
            Some(prompt),
            timeout_secs,
            &timeout_message,
        )
        .await
        .map_err(|error| error.to_string());
    }
    #[cfg(not(windows))]
    {
        let mut command = TokioCommand::new(exe);
        command
            .args(["run", model.as_str()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(cwd)
            .env_remove("HTTP_PROXY")
            .env_remove("HTTPS_PROXY")
            .env_remove("http_proxy")
            .env_remove("https_proxy");
        run_tokio_command_with_timeout(command, Some(prompt), timeout_secs, &timeout_message)
            .await
            .map_err(|error| error.to_string())
    }
}

fn cli_workspace_path(project_id: Option<String>) -> Result<String, String> {
    let base = std::env::temp_dir().join("daacs_workspace");
    let dir = match project_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(id) => base.join(sanitize_filename(id)),
        None => base.join("default"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    dir.into_os_string()
        .into_string()
        .map_err(|_| cli_text(L10N_KEY_CLI_ERROR_INVALID_PATH, "Invalid path"))
}

#[tauri::command]
pub fn prepare_artifact_workspace(root_path: String, goal_text: String) -> Result<String, String> {
    let root = PathBuf::from(root_path.trim());
    if !root.is_dir() {
        return Err(format!("workspace_root_not_dir:{}", root.display()));
    }

    let compact_goal: String = goal_text
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .collect();
    let sanitized_goal = sanitize_filename(&compact_goal);
    let slug = sanitized_goal.trim_matches('_');
    let safe_slug = if slug.is_empty() { "artifact" } else { slug };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let child = root.join(format!(
        "daacs-artifact-{}-{}",
        timestamp,
        safe_slug.chars().take(32).collect::<String>(),
    ));

    std::fs::create_dir_all(&child).map_err(|e| e.to_string())?;
    child
        .into_os_string()
        .into_string()
        .map_err(|_| cli_text(L10N_KEY_CLI_ERROR_INVALID_PATH, "Invalid path"))
}

#[tauri::command]
pub fn prepare_agent_workspaces(
    root_path: String,
    agent_ids: Vec<String>,
) -> Result<HashMap<String, String>, String> {
    let root = PathBuf::from(root_path.trim());
    if !root.is_dir() {
        return Err(format!("workspace_root_not_dir:{}", root.display()));
    }

    let mut ordered_agent_ids: Vec<String> = Vec::new();
    for raw in agent_ids {
        let normalized = normalize_role_key(&raw);
        if normalized.is_empty()
            || ordered_agent_ids
                .iter()
                .any(|existing| existing == &normalized)
        {
            continue;
        }
        ordered_agent_ids.push(normalized);
    }

    if ordered_agent_ids.is_empty() {
        return Ok(HashMap::new());
    }

    let mut out = HashMap::new();
    let shared_root = root
        .into_os_string()
        .into_string()
        .map_err(|_| cli_text(L10N_KEY_CLI_ERROR_INVALID_PATH, "Invalid path"))?;
    for agent_id in ordered_agent_ids.iter() {
        out.insert(agent_id.clone(), shared_root.clone());
    }
    Ok(out)
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect()
}

fn builtin_agent_role_for_role_key(in_role: &str) -> Option<AgentRole> {
    match normalize_role_key(in_role).as_str() {
        "pm" => Some(AgentRole::Pm),
        "goal" => Some(AgentRole::Goal),
        "frontend" => Some(AgentRole::Frontend),
        "backend" => Some(AgentRole::Backend),
        "agent" => Some(AgentRole::Agent),
        "reviewer" => Some(AgentRole::Reviewer),
        "verifier" => Some(AgentRole::Verifier),
        _ => None,
    }
}

#[tauri::command]
pub fn get_agent_prompt(in_role: String) -> Result<String, String> {
    let role = in_role.trim();
    if role.is_empty() {
        return Err("agent_role_empty".to_string());
    }
    let prompt_key = find_prompt_key_for_role(role)?;
    if let Some(key) = prompt_key.as_deref() {
        if let Some(prompt) = crate::prompts::load_prompt_content_merged(key) {
            return Ok(prompt);
        }
    }

    if let Some(agent_role) = builtin_agent_role_for_role_key(role) {
        warn!(
            "agent_prompt_missing_for_role role={} prompt_key={:?}; using built-in fallback",
            role, prompt_key
        );
        return Ok(system_prompt_for_role(agent_role).to_string());
    }

    match prompt_key {
        Some(key) => Err(format!("prompt_not_found_for_role:{} ({})", in_role, key)),
        None => Err(format!("Unknown agent role: {}", in_role)),
    }
}

#[tauri::command]
pub fn get_skill_prompt_for_role(role: String) -> Result<String, String> {
    let skill_roots = crate::skills::resolve_skill_roots();
    let config_path = crate::skills::resolve_bundles_config();
    let mut loader = crate::skills::SkillLoader::new(skill_roots, &config_path)
        .map_err(|error| error.to_string())?;
    let bundle = loader.load_bundle(&role);
    Ok(bundle.to_system_prompt(true))
}

#[tauri::command]
pub fn get_skill_prompt_for_custom(role: String, skill_ids: Vec<String>) -> Result<String, String> {
    let skill_roots = crate::skills::resolve_skill_roots();
    let config_path = crate::skills::resolve_bundles_config();
    let mut loader = crate::skills::SkillLoader::new(skill_roots, &config_path)
        .map_err(|error| error.to_string())?;
    let bundle = loader.load_custom_skills(&skill_ids, &role);
    Ok(bundle.to_system_prompt(true))
}

#[tauri::command]
pub fn get_skill_bundle_summary() -> Result<String, String> {
    let skill_roots = crate::skills::resolve_skill_roots();
    let config_path = crate::skills::resolve_bundles_config();
    let loader = crate::skills::SkillLoader::new(skill_roots, &config_path)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&loader.get_bundle_summary()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_skill_catalog() -> Result<String, String> {
    let skill_roots = crate::skills::resolve_skill_roots();
    let config_path = crate::skills::resolve_bundles_config();
    let loader = crate::skills::SkillLoader::new(skill_roots, &config_path)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&loader.get_skill_catalog()).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_available_skill_ids() -> Result<String, String> {
    let skill_roots = crate::skills::resolve_skill_roots();
    let config_path = crate::skills::resolve_bundles_config();
    let loader = crate::skills::SkillLoader::new(skill_roots, &config_path)
        .map_err(|error| error.to_string())?;
    serde_json::to_string(&loader.available_skill_ids()).map_err(|error| error.to_string())
}

fn local_office_state_path(project_id: &str) -> Result<PathBuf, String> {
    let project = project_id.trim();
    if project.is_empty() {
        return Err("project_id_empty".to_string());
    }
    let base_dir = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
        .join(LOCAL_OFFICE_STATE_DIR);
    Ok(base_dir.join(format!("{}.json", sanitize_filename(project))))
}

fn local_office_state_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
        .join(LOCAL_OFFICE_STATE_DIR)
}

fn json_string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_lowercase())
        .unwrap_or_default()
}

fn is_core_default_agent_ref(raw: &str, active_agent_ids: &HashSet<String>) -> bool {
    let normalized = raw.trim().to_lowercase();
    let key = normalized
        .strip_prefix("agent:")
        .unwrap_or(normalized.as_str());
    active_agent_ids.contains(key)
        || matches!(
            key,
            "pm" | "reviewer" | "verifier" | "builtin-pm" | "builtin-reviewer" | "builtin-verifier"
        )
}

fn is_legacy_bundled_office_agent(agent: &serde_json::Value) -> bool {
    let id = json_string_field(agent, "id");
    if !matches!(id.as_str(), "developer" | "designer" | "devops") {
        return false;
    }
    let prompt_key = json_string_field(agent, "promptKey");
    let legacy_prompt_key = json_string_field(agent, "prompt_key");
    let key = if prompt_key.is_empty() {
        legacy_prompt_key
    } else {
        prompt_key
    };
    matches!(
        key.as_str(),
        "agent_developer" | "agent_designer" | "agent_devops"
    )
}

fn prune_agent_scoped_map(
    root: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    active_agent_ids: &HashSet<String>,
) -> bool {
    let Some(map) = root.get_mut(key).and_then(|v| v.as_object_mut()) else {
        return false;
    };
    let before = map.len();
    map.retain(|agent_key, _| is_core_default_agent_ref(agent_key, active_agent_ids));
    before != map.len()
}

fn prune_agent_scoped_array(
    root: &mut serde_json::Map<String, serde_json::Value>,
    key: &str,
    active_agent_ids: &HashSet<String>,
    field_names: &[&str],
) -> bool {
    let Some(items) = root.get_mut(key).and_then(|v| v.as_array_mut()) else {
        return false;
    };
    let before = items.len();
    items.retain(|item| {
        let id_values = ["agentId", "fromAgentId", "toAgentId"]
            .iter()
            .filter_map(|field| item.get(field).and_then(|v| v.as_str()))
            .collect::<Vec<_>>();
        if !id_values.is_empty() {
            return id_values
                .iter()
                .all(|value| is_core_default_agent_ref(value, active_agent_ids));
        }
        let scoped_values = field_names
            .iter()
            .filter_map(|field| item.get(field).and_then(|v| v.as_str()))
            .collect::<Vec<_>>();
        !scoped_values.is_empty()
            && scoped_values
                .iter()
                .all(|value| is_core_default_agent_ref(value, active_agent_ids))
    });
    before != items.len()
}

fn prune_local_office_state_snapshot(snapshot: &mut serde_json::Value) -> bool {
    let Some(root) = snapshot.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    let mut active_agent_ids = HashSet::<String>::new();
    let mut local_custom_agent_count = 0usize;

    if let Some(agents) = root.get_mut("agents").and_then(|v| v.as_array_mut()) {
        let before = agents.len();
        agents.retain(|agent| !is_legacy_bundled_office_agent(agent));
        changed |= before != agents.len();
        for agent in agents.iter() {
            let id = json_string_field(agent, "id");
            if id.is_empty() {
                continue;
            }
            let blueprint_id = json_string_field(agent, "blueprintId");
            let is_core = matches!(
                id.as_str(),
                "pm" | "frontend" | "backend" | "reviewer" | "verifier"
            ) || matches!(
                blueprint_id.as_str(),
                "builtin-pm"
                    | "builtin-frontend"
                    | "builtin-backend"
                    | "builtin-reviewer"
                    | "builtin-verifier"
            );
            if !is_core {
                local_custom_agent_count += 1;
            }
            active_agent_ids.insert(id);
        }
    }

    let snapshot_version = root.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    let should_reset_legacy_core_history =
        snapshot_version < LOCAL_OFFICE_STATE_SNAPSHOT_VERSION && local_custom_agent_count == 0;
    if should_reset_legacy_core_history {
        for key in ["workLogs", "taskHistory", "fileChanges", "agentErrors"] {
            if root
                .get(key)
                .and_then(|v| v.as_object())
                .is_some_and(|items| !items.is_empty())
            {
                root.insert(key.to_string(), serde_json::json!({}));
                changed = true;
            }
        }
        for key in [
            "commandHistory",
            "agentMessages",
            "pendingTransfers",
            "collaborationVisits",
        ] {
            if root
                .get(key)
                .and_then(|v| v.as_array())
                .is_some_and(|items| !items.is_empty())
            {
                root.insert(key.to_string(), serde_json::json!([]));
                changed = true;
            }
        }
    } else {
        for key in ["workLogs", "taskHistory", "fileChanges", "agentErrors"] {
            changed |= prune_agent_scoped_map(root, key, &active_agent_ids);
        }
        changed |= prune_agent_scoped_array(
            root,
            "commandHistory",
            &active_agent_ids,
            &["agentId", "agentRole"],
        );
        changed |= prune_agent_scoped_array(
            root,
            "agentMessages",
            &active_agent_ids,
            &["fromAgentId", "toAgentId", "from", "to"],
        );
        changed |=
            prune_agent_scoped_array(root, "pendingTransfers", &active_agent_ids, &["from", "to"]);
    }
    if root
        .get("collaborationVisits")
        .and_then(|v| v.as_array())
        .is_some_and(|items| !items.is_empty())
    {
        root.insert("collaborationVisits".to_string(), serde_json::json!([]));
        changed = true;
    }
    if root.get("version").and_then(|v| v.as_u64()) != Some(LOCAL_OFFICE_STATE_SNAPSHOT_VERSION) {
        root.insert(
            "version".to_string(),
            serde_json::json!(LOCAL_OFFICE_STATE_SNAPSHOT_VERSION),
        );
        changed = true;
    }
    if root.get("localCustomAgentCount").and_then(|v| v.as_u64())
        != Some(local_custom_agent_count as u64)
    {
        root.insert(
            "localCustomAgentCount".to_string(),
            serde_json::json!(local_custom_agent_count),
        );
        changed = true;
    }

    changed
}

fn prune_local_office_state_file(path: &Path) -> Result<bool, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("read local office state: {} ({})", error, path.display()))?;
    let mut snapshot: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|error| format!("parse local office state: {} ({})", error, path.display()))?;
    if !prune_local_office_state_snapshot(&mut snapshot) {
        return Ok(false);
    }
    let serialized = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
    std::fs::write(path, serialized)
        .map_err(|error| format!("write local office state: {} ({})", error, path.display()))?;
    Ok(true)
}

fn prune_local_office_state_files_on_startup() -> Result<(), String> {
    let dir = local_office_state_dir();
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir)
        .map_err(|error| format!("read local office state dir: {} ({})", error, dir.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let _ = prune_local_office_state_file(&path)?;
    }
    Ok(())
}

fn global_office_state_path() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
        .join(GLOBAL_OFFICE_STATE_FILE)
}

#[tauri::command]
pub fn save_local_office_state(project_id: String, snapshot_json: String) -> Result<(), String> {
    let path = local_office_state_path(&project_id)?;
    let mut snapshot: serde_json::Value =
        serde_json::from_str(snapshot_json.trim()).map_err(|error| error.to_string())?;
    prune_local_office_state_snapshot(&mut snapshot);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
    std::fs::write(path, serialized).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_local_office_state(project_id: String) -> Result<Option<String>, String> {
    let path = local_office_state_path(&project_id)?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut snapshot: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    prune_local_office_state_snapshot(&mut snapshot);
    serde_json::to_string(&snapshot)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn clear_local_office_state(project_id: String) -> Result<(), String> {
    let path = local_office_state_path(&project_id)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn save_global_office_state(snapshot_json: String) -> Result<(), String> {
    let path = global_office_state_path();
    let snapshot: serde_json::Value =
        serde_json::from_str(snapshot_json.trim()).map_err(|error| error.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let serialized = serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?;
    std::fs::write(path, serialized).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn load_global_office_state() -> Result<Option<String>, String> {
    let path = global_office_state_path();
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(path).map_err(|error| error.to_string())?;
    let snapshot: serde_json::Value =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    serde_json::to_string(&snapshot)
        .map(Some)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn parse_pm_task_lists_command(in_stdout: String) -> Result<omni_ai_core::PmTaskLists, String> {
    Ok(parse_pm_task_lists(&in_stdout))
}

#[tauri::command]
pub fn rfi_system_prompt_command() -> String {
    omni_ai_core::rfi_system_prompt().to_string()
}

#[tauri::command]
pub fn build_rfi_user_prompt_command(
    goal: String,
    known_answers: Vec<omni_ai_core::RfiKnownAnswer>,
) -> Result<String, String> {
    let request = omni_ai_core::RfiRequest {
        goal,
        prior_summary: None,
        known_answers,
        workspace_files: vec![],
        max_questions: 3,
    };
    Ok(omni_ai_core::build_rfi_user_prompt(&request))
}

#[tauri::command]
pub fn parse_rfi_outcome_command(goal: String, raw: String) -> omni_ai_core::RfiOutcome {
    debug!("raw_rfi_output={}", raw);
    omni_ai_core::parse_rfi_outcome(&raw)
        .unwrap_or_else(|e| omni_ai_core::fallback_rfi_outcome(&goal, &raw, &e))
}

fn cli_which() -> Result<serde_json::Value, String> {
    let provider = preferred_provider();
    let (codex_path, gemini_path, local_llm_path) =
        (resolve_codex(), resolve_gemini(), resolve_local_llm());
    Ok(serde_json::json!({
        "preferred": provider,
        "codex": codex_path.and_then(|p| p.into_os_string().into_string().ok()),
        "gemini": gemini_path.and_then(|p| p.into_os_string().into_string().ok()),
        "claude": local_llm_path.clone().and_then(|p| p.into_os_string().into_string().ok()),
        "local_llm": local_llm_path.and_then(|p| p.into_os_string().into_string().ok()),
    }))
}
fn issue_log_path() -> std::path::PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
        .join("logs")
        .join("ISSUES.md")
}

/// Append a CLI failure entry to the runtime issue log for quick developer visibility.
/// The log lives in app data so normal provider failures do not dirty the source repo.
fn append_issue_log(provider: &str, exit_code: i32, stderr: &str) {
    use std::io::Write;

    let issues_path = issue_log_path();
    if let Some(parent) = issues_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();

    // Trim the noisy skill-loading errors from stderr to keep the log readable
    let relevant: String = stderr
        .lines()
        .filter(|l| !l.contains("failed to load skill") && !l.trim().is_empty())
        .take(30)
        .collect::<Vec<_>>()
        .join("\n");

    let entry = format!(
        "\n---\n\n## 🔴 CLI Error — {now}\n\n- **Provider**: `{provider}`\n- **Exit code**: `{exit_code}`\n\n```\n{relevant}\n```\n",
        now = now,
        provider = provider,
        exit_code = exit_code,
        relevant = relevant,
    );

    // Create file with header if it doesn't exist yet
    let needs_header = !issues_path.exists();
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&issues_path)
    {
        if needs_header {
            let _ = writeln!(f, "# DAACS Runtime Issues Log\n\n> Auto-generated. Errors from CLI provider calls are appended here during development.\n");
        }
        let _ = f.write_all(entry.as_bytes());
        info!("[DAACS CLI] issue logged → {}", issues_path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_test_key(label: &str) -> String {
        format!("test:{}:{}", label, std::process::id())
    }

    #[test]
    fn normalize_cli_session_key_trims_and_drops_empty_values() {
        assert_eq!(normalize_cli_session_key(None), None);
        assert_eq!(normalize_cli_session_key(Some("   ")), None);
        assert_eq!(
            normalize_cli_session_key(Some("  sequencer:pm:plan  ")),
            Some("sequencer:pm:plan".to_string())
        );
        assert_eq!(
            normalize_cli_session_key(Some(" Project : Project Alpha : Agent Command : Reviewer ")),
            Some("project:project-alpha:agent-command:reviewer".to_string())
        );
    }

    #[test]
    fn normalize_role_key_accepts_office_and_korean_aliases() {
        assert_eq!(normalize_role_key("developer-front"), "frontend");
        assert_eq!(normalize_role_key("프론트엔드"), "frontend");
        assert_eq!(normalize_role_key("developer_back"), "backend");
        assert_eq!(normalize_role_key("백엔드"), "backend");
        assert_eq!(normalize_role_key("리뷰어"), "reviewer");
        assert_eq!(normalize_role_key("검수자"), "verifier");
    }

    #[test]
    fn enforce_required_default_agents_prunes_legacy_bundled_implementation_agents() {
        let mut root = serde_json::json!({
            "schema_version": 1,
            "agents": [
                {
                    "id": "developer",
                    "display_name": "Developer",
                    "office_role": "developer",
                    "prompt_key": "agent_developer",
                    "prompt_file": "Resources/prompts/agent_developer.json"
                },
                {
                    "id": "frontend",
                    "display_name": "Frontend Developer",
                    "office_role": "developer_front",
                    "prompt_key": "agent_frontend",
                    "prompt_file": "Resources/prompts/agent_frontend.json"
                },
                {
                    "id": "ui_builder",
                    "display_name": "UI Builder",
                    "office_role": "developer_front",
                    "prompt_key": "agent_frontend",
                    "prompt_file": "Resources/prompts/agent_frontend.json"
                },
                {
                    "id": "pm",
                    "display_name": "Old PM",
                    "office_role": "pm",
                    "prompt_key": "agent_pm",
                    "prompt_file": "Resources/prompts/agent_pm.json"
                }
            ]
        });

        enforce_required_default_agents(&mut root).expect("enforce defaults");
        let ids: Vec<_> = root["agents"]
            .as_array()
            .expect("agents array")
            .iter()
            .filter_map(|agent| agent.get("id").and_then(|v| v.as_str()))
            .collect();

        assert!(!ids.contains(&"developer"));
        assert!(ids.contains(&"frontend"));
        assert!(ids.contains(&"backend"));
        assert!(ids.contains(&"ui_builder"));
        assert_eq!(
            ids.iter().filter(|id| **id == "pm").count(),
            1,
            "core PM should be replaced with one canonical default"
        );
        assert_eq!(
            ids.iter().filter(|id| **id == "frontend").count(),
            1,
            "core frontend should be replaced with one canonical default"
        );
        assert_eq!(
            ids.iter().filter(|id| **id == "backend").count(),
            1,
            "core backend should be added as one canonical default"
        );
        assert!(ids.contains(&"reviewer"));
        assert!(ids.contains(&"verifier"));
    }

    #[test]
    fn prune_local_office_state_snapshot_removes_legacy_default_agents_and_scoped_logs() {
        let mut snapshot = serde_json::json!({
            "projectId": "local",
            "agents": [
                { "id": "developer", "role": "developer", "promptKey": "agent_developer" },
                { "id": "frontend", "role": "developer_front", "promptKey": "agent_frontend" },
                { "id": "pm", "role": "pm", "promptKey": "agent_pm" },
                { "id": "ui_builder", "role": "developer_front", "promptKey": "agent_frontend" },
                { "id": "reviewer", "role": "reviewer", "promptKey": "agent_reviewer" },
                { "id": "verifier", "role": "verifier", "promptKey": "agent_verifier" }
            ],
            "workLogs": {
                "developer": [],
                "frontend": [],
                "ui_builder": [],
                "pm": []
            },
            "taskHistory": {
                "agent:developer": [],
                "agent:pm": [],
                "ui_builder": []
            },
            "agentErrors": {
                "backend": [],
                "reviewer": []
            },
            "agentMessages": [
                { "id": "1", "from": "developer", "to": "pm", "content": "old" },
                { "id": "2", "fromAgentId": "ui_builder", "from": "developer_front", "to": "pm", "content": "keep" },
                { "id": "3", "from": "pm", "to": "reviewer", "content": "keep core" }
            ],
            "commandHistory": [
                { "id": "1", "agentRole": "developer", "message": "old" },
                { "id": "2", "agentId": "ui_builder", "agentRole": "developer_front", "message": "keep" }
            ],
            "pendingTransfers": [
                { "id": "1", "from": "developer", "to": "reviewer" },
                { "id": "2", "from": "pm", "to": "verifier" }
            ],
            "collaborationVisits": [
                { "id": "visit", "from": "developer", "to": "pm" }
            ],
            "localCustomAgentCount": 0
        });

        assert!(prune_local_office_state_snapshot(&mut snapshot));
        let agents = snapshot["agents"].as_array().expect("agents");
        let agent_ids: Vec<_> = agents
            .iter()
            .filter_map(|agent| agent.get("id").and_then(|value| value.as_str()))
            .collect();

        assert_eq!(
            agent_ids,
            vec!["frontend", "pm", "ui_builder", "reviewer", "verifier"]
        );
        assert!(snapshot["workLogs"].get("developer").is_none());
        assert!(snapshot["workLogs"].get("ui_builder").is_some());
        assert!(snapshot["taskHistory"].get("agent:developer").is_none());
        assert!(snapshot["taskHistory"].get("ui_builder").is_some());
        assert_eq!(snapshot["agentMessages"].as_array().unwrap().len(), 2);
        assert_eq!(snapshot["commandHistory"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["pendingTransfers"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["collaborationVisits"].as_array().unwrap().len(), 0);
        assert_eq!(
            snapshot["version"],
            serde_json::json!(LOCAL_OFFICE_STATE_SNAPSHOT_VERSION)
        );
        assert_eq!(snapshot["localCustomAgentCount"], serde_json::json!(1));
    }

    #[test]
    fn prune_local_office_state_snapshot_resets_old_core_only_runtime_history() {
        let mut snapshot = serde_json::json!({
            "version": 1,
            "projectId": "local",
            "agents": [
                { "id": "pm", "role": "pm", "promptKey": "agent_pm" },
                { "id": "reviewer", "role": "reviewer", "promptKey": "agent_reviewer" },
                { "id": "verifier", "role": "verifier", "promptKey": "agent_verifier" }
            ],
            "workLogs": { "pm": [{ "id": "old" }] },
            "taskHistory": { "pm": [{ "id": "old" }] },
            "agentErrors": { "reviewer": [{ "id": "old" }] },
            "agentMessages": [
                { "id": "old", "fromAgentId": "pm", "from": "pm", "to": "reviewer", "content": "old default-roster run" }
            ],
            "commandHistory": [{ "id": "old", "agentRole": "pm" }],
            "pendingTransfers": [{ "id": "old", "from": "pm", "to": "verifier" }],
            "collaborationVisits": [{ "id": "old", "from": "pm", "to": "reviewer" }],
            "localCustomAgentCount": 0
        });

        assert!(prune_local_office_state_snapshot(&mut snapshot));
        assert_eq!(snapshot["workLogs"], serde_json::json!({}));
        assert_eq!(snapshot["taskHistory"], serde_json::json!({}));
        assert_eq!(snapshot["agentErrors"], serde_json::json!({}));
        assert_eq!(snapshot["agentMessages"], serde_json::json!([]));
        assert_eq!(snapshot["commandHistory"], serde_json::json!([]));
        assert_eq!(snapshot["pendingTransfers"], serde_json::json!([]));
        assert_eq!(snapshot["collaborationVisits"], serde_json::json!([]));
        assert_eq!(
            snapshot["version"],
            serde_json::json!(LOCAL_OFFICE_STATE_SNAPSHOT_VERSION)
        );
    }

    #[test]
    fn resolve_optional_local_model_path_allows_core_auto_discovery() {
        assert_eq!(resolve_optional_local_model_path(None).unwrap(), None);
        assert_eq!(
            resolve_optional_local_model_path(Some("   ")).unwrap(),
            None
        );

        let path = std::env::temp_dir().join(format!(
            "daacs-local-model-{}-{}.gguf",
            std::process::id(),
            unique_test_key("model").replace(':', "-")
        ));
        std::fs::write(&path, b"test model placeholder").expect("write temp model placeholder");
        let resolved = resolve_optional_local_model_path(path.to_str())
            .expect("selected model should resolve");
        assert_eq!(resolved.as_deref(), Some(path.as_path()));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn local_llm_configuration_errors_are_not_successful_cli_output() {
        assert!(local_llm_response_is_configuration_error(
            "Error: Multiple local LLM models were found (2): a, b. Choose one."
        ));
        assert!(local_llm_response_is_configuration_error(
            "Error: Local LLM model file is not configured."
        ));
        assert!(local_llm_response_is_configuration_error(
            "Error: Could not find llama-cli. Please ensure dependencies are built."
        ));
        assert!(!local_llm_response_is_configuration_error(
            "Here is a useful assistant response."
        ));
    }

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
            parse_bounded_timeout_secs(Some("off"), 900, 60, 7_200),
            None
        );
    }

    #[test]
    fn detect_malformed_patch_fast_fail_requires_repeated_failures() {
        let once = "error=apply_patch verification failed: invalid patch";
        assert!(
            detect_malformed_patch_fast_fail(once).is_none(),
            "a single patch failure should not stop a recoverable run"
        );

        let repeated = [
            "error=apply_patch verification failed: invalid patch",
            "noise",
            "error=apply_patch verification failed: invalid patch",
            "error=apply_patch verification failed: invalid patch",
        ]
        .join("\n");
        let message = detect_malformed_patch_fast_fail(&repeated)
            .expect("repeated malformed patch failures should fast-fail");
        assert!(message.contains("stopped early"));
    }

    #[test]
    fn annotate_partial_artifact_timeout_records_changed_files() {
        let root = std::env::temp_dir().join(format!(
            "daacs-partial-timeout-{}-{}",
            std::process::id(),
            unique_test_key("workspace").replace(':', "-")
        ));
        std::fs::create_dir_all(root.join("src")).expect("create temp workspace");
        std::fs::write(root.join("README.md"), "before").expect("write baseline file");
        let before = snapshot_workspace_files(&root).expect("snapshot baseline workspace");
        std::fs::write(root.join("index.html"), "<main>candidate</main>")
            .expect("write candidate artifact");
        std::fs::write(root.join("src").join("app.js"), "console.log('candidate');")
            .expect("write candidate source");

        let (_stdout, stderr, exit_code) = annotate_partial_artifact_timeout(
            (
                String::new(),
                "Codex CLI timed out after 900 seconds.".to_string(),
                1,
            ),
            Some(&before),
            &root,
            "Codex CLI timed out after 900 seconds.",
        );

        assert_eq!(exit_code, 1);
        assert!(stderr.contains("[DAACS_PARTIAL_ARTIFACT_TIMEOUT]"));
        assert!(stderr.contains("- index.html"));
        assert!(stderr.contains("- src/app.js"));
        let _ = std::fs::remove_dir_all(root);
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
                run_tokio_command_with_timeout(command, None, Some(30), "test timeout")
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

    #[test]
    fn codex_session_ids_reuse_normalized_session_keys() {
        let session_key = format!("normalization reuse {}", std::process::id());
        let mixed_case = format!(" Project : {} : Reviewer ", session_key);
        let normalized = format!(
            "project:{}:reviewer",
            normalize_cli_session_key_segment(&session_key)
        );
        clear_codex_session_id(&mixed_case);
        set_codex_session_id(&mixed_case, "thread_normalized");
        assert_eq!(
            get_codex_session_id(&normalized),
            Some("thread_normalized".to_string())
        );
        clear_codex_session_id(&normalized);
        assert_eq!(get_codex_session_id(&mixed_case), None);
    }

    #[test]
    fn build_codex_config_args_adds_model_and_low_reasoning_only_for_sequencer_sessions() {
        assert_eq!(
            build_codex_config_args(Some("sequencer:pm:step:2")),
            vec![
                "-c".to_string(),
                "features.plugins=false".to_string(),
                "-c".to_string(),
                "sandbox_mode=\"workspace-write\"".to_string(),
                "-c".to_string(),
                "approval_policy=\"never\"".to_string(),
                "-c".to_string(),
                "model=\"gpt-5.5\"".to_string(),
                "-c".to_string(),
                "model_reasoning_effort=\"low\"".to_string()
            ]
        );
        assert_eq!(
            build_codex_config_args(Some("office:pm:step:2")),
            vec![
                "-c".to_string(),
                "features.plugins=false".to_string(),
                "-c".to_string(),
                "sandbox_mode=\"workspace-write\"".to_string(),
                "-c".to_string(),
                "approval_policy=\"never\"".to_string()
            ]
        );
        assert_eq!(
            build_codex_config_args(None),
            vec![
                "-c".to_string(),
                "features.plugins=false".to_string(),
                "-c".to_string(),
                "sandbox_mode=\"workspace-write\"".to_string(),
                "-c".to_string(),
                "approval_policy=\"never\"".to_string()
            ]
        );
    }

    #[test]
    fn transient_codex_provider_failure_detection_stays_narrow() {
        assert!(is_transient_codex_provider_failure(
            "",
            "failed to refresh available models: We're currently experiencing high demand",
            1,
        ));
        assert!(is_transient_codex_provider_failure(
            "",
            "stream disconnected - retrying sampling request (1/5)",
            1,
        ));
        assert!(is_transient_codex_provider_failure(
            "",
            "TerminalQuotaError: You have exhausted your capacity on this model. Your quota will reset after 16h33m56s. reason: QUOTA_EXHAUSTED",
            1,
        ));
        assert!(!is_transient_codex_provider_failure(
            "",
            "Codex CLI timed out after 900 seconds.",
            1,
        ));
        assert!(!is_transient_codex_provider_failure("", "", 0));
    }

    #[test]
    fn sequencer_sessions_retry_only_empty_plan_transient_codex_provider_failures() {
        let stderr = "failed to refresh available models: We're currently experiencing high demand";
        assert!(should_retry_codex_provider_failure(
            Some("sequencer:local:pm:plan"),
            "",
            stderr,
            1,
        ));
        assert!(should_retry_codex_provider_failure(
            Some("sequencer:local:session:pm:plan"),
            "",
            stderr,
            1,
        ));
        assert!(!should_retry_codex_provider_failure(
            Some("sequencer:local:session:pm:plan"),
            "[SEQUENCER_PLAN]\n1. partial",
            stderr,
            1,
        ));
        assert!(!should_retry_codex_provider_failure(
            Some("sequencer:local:session:builder:step:1"),
            "",
            stderr,
            1,
        ));
        assert!(should_retry_codex_provider_failure(None, "", stderr, 1));
    }

    #[test]
    fn extract_codex_thread_id_ignores_noise_and_finds_thread_started_event() {
        let stdout_jsonl = r#"
not-json
{"type":"item.completed","item":{"type":"agent_message","text":"ignored"}}
{"type":"thread.started","thread_id":"thread_123"}
{"type":"thread.started","thread_id":"thread_456"}
"#;

        assert_eq!(
            extract_codex_thread_id(stdout_jsonl),
            Some("thread_123".to_string())
        );
    }

    #[test]
    fn extract_sequencer_commands_accepts_plural_commands_block() {
        let text = r#"
[STEP_2_RESULT]
Validation finished.
[/STEP_2_RESULT]
[Commands]
1. cargo test -p daacs_desktop
2. cargo test -p daacs_backend
[/Commands]
{END_TASK_2}
"#;

        assert_eq!(
            extract_sequencer_commands(text),
            vec![
                "cargo test -p daacs_desktop".to_string(),
                "cargo test -p daacs_backend".to_string()
            ]
        );
    }

    #[test]
    fn extract_sequencer_commands_keeps_legacy_singular_command_block() {
        let text = r#"
[STEP_1_RESULT]
Done.
[/STEP_1_RESULT]
[Command]
1. cargo test
[/Command]
{END_TASK_1}
"#;

        assert_eq!(
            extract_sequencer_commands(text),
            vec!["cargo test".to_string()]
        );
    }

    #[test]
    fn extract_sequencer_commands_ignores_markdown_code_fences() {
        let text = r#"
[STEP_1_RESULT]
Done.
[/STEP_1_RESULT]
[Command]
```bash
npm install
npm run build
npm run smoke
```
[/Command]
{END_TASK_1}
"#;

        assert_eq!(
            extract_sequencer_commands(text),
            vec![
                "npm install".to_string(),
                "npm run build".to_string(),
                "npm run smoke".to_string()
            ]
        );
    }

    #[test]
    fn extract_codex_last_message_from_jsonl_prefers_last_agent_message() {
        let stdout_jsonl = r#"
{"type":"item.completed","item":{"type":"tool_result","text":"ignored"}}
{"type":"item.completed","item":{"type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final"}}
"#;

        assert_eq!(
            extract_codex_last_message_from_jsonl(stdout_jsonl),
            Some("final".to_string())
        );
    }

    #[test]
    fn finalize_codex_result_uses_output_file_and_persists_session_id() {
        let session_key = unique_test_key("persist");
        clear_codex_session_id(&session_key);
        let last_message_path = build_codex_last_message_path(Some(&session_key));
        std::fs::write(&last_message_path, "final message\n").expect("write last message");
        let stdout_jsonl = r#"{"type":"thread.started","thread_id":"thread_persist"}"#.to_string();

        let result = finalize_codex_result(
            (stdout_jsonl, String::new(), 0),
            Some(&session_key),
            None,
            Some(&last_message_path),
        )
        .expect("finalize result");

        assert_eq!(result.0, "final message");
        assert_eq!(
            get_codex_session_id(&session_key),
            Some("thread_persist".to_string())
        );
        assert!(!last_message_path.exists());
        clear_codex_session_id(&session_key);
    }

    #[test]
    fn finalize_codex_result_falls_back_to_last_json_message_and_clears_failed_session() {
        let session_key = unique_test_key("fallback");
        set_codex_session_id(&session_key, "thread_old");
        let last_message_path = build_codex_last_message_path(Some(&session_key));
        let stdout_jsonl = r#"
{"type":"item.completed","item":{"type":"agent_message","text":"draft"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final from json"}}
"#
        .to_string();

        let result = finalize_codex_result(
            (stdout_jsonl, "stderr".to_string(), 1),
            Some(&session_key),
            Some("thread_resume"),
            Some(&last_message_path),
        )
        .expect("finalize result");

        assert_eq!(result.0, "final from json");
        assert_eq!(result.1, "stderr");
        assert_eq!(result.2, 1);
        assert_eq!(get_codex_session_id(&session_key), None);
    }

    #[test]
    fn prepare_agent_workspaces_does_not_create_repo_root_output_dirs() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "daacs-prepare-agent-workspaces-{}-{}",
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&root).expect("create temp root");

        let result = prepare_agent_workspaces(
            root.to_str().expect("utf8 root").to_string(),
            vec!["pm".to_string(), "reviewer".to_string()],
        )
        .expect("prepare workspaces");

        assert_eq!(result.get("pm"), result.get("reviewer"));
        assert!(!root.join("output").exists());
        assert!(!root.join("artifacts").exists());
        assert!(!root.join("verification").exists());

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn prepare_artifact_workspace_creates_isolated_child_dir() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "daacs-prepare-artifact-workspace-{}-{}",
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&root).expect("create temp root");

        let result = prepare_artifact_workspace(
            root.to_str().expect("utf8 root").to_string(),
            "새 점심 추천 웹 MVP 만들어줘".to_string(),
        )
        .expect("prepare artifact workspace");
        let child = PathBuf::from(result);

        assert!(child.starts_with(&root));
        assert_ne!(child, root);
        assert!(child.is_dir());
        assert!(child
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .starts_with("daacs-artifact-"));

        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }

    #[test]
    fn prepare_agent_workspaces_canonicalizes_role_aliases() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "daacs-prepare-agent-workspaces-aliases-{}-{}",
            std::process::id(),
            unique
        ));
        std::fs::create_dir_all(&root).expect("create temp root");

        let result = prepare_agent_workspaces(
            root.to_str().expect("utf8 root").to_string(),
            vec![
                "프론트".to_string(),
                "developer-front".to_string(),
                "백엔드".to_string(),
                "검수자".to_string(),
            ],
        )
        .expect("prepare workspaces");

        assert!(result.contains_key("frontend"));
        assert!(result.contains_key("backend"));
        assert!(result.contains_key("verifier"));
        assert_eq!(result.len(), 3);
        assert!(!result.contains_key("프론트"));
        std::fs::remove_dir_all(&root).expect("cleanup temp root");
    }
}
