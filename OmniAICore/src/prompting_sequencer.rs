//! Sequencer TODO persistence, `[FilesCreated]` / `[Command]` parsing, artifact manifests, and the system prompt built from `Prompting_Sequencer_Rule.md`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use omni_utilities::{ensure_dir_all, json_from_file, json_to_file};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SequencerStatus {
    Pending,
    InProgress,
    Done,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencerItem {
    pub number: u32,
    pub title: String,
    pub description: String,
    pub status: SequencerStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencerTodoList {
    pub main_task_name: String,
    pub project_name: String,
    pub channel_id: String,
    pub items: Vec<SequencerItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SequencerMetadataEntry {
    pub channel_id: String,
    pub last_file: String,
    pub last_updated_utc: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SequencerMetadata {
    pub entries: Vec<SequencerMetadataEntry>,
}

fn appdata_base_dir() -> PathBuf {
    if let Ok(value) = std::env::var("DAACS_APPDATA_DIR") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if let Ok(value) = std::env::var("APPDATA") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(value) = std::env::var("HOME") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed)
                    .join("Library")
                    .join("Application Support");
            }
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(value) = std::env::var("XDG_STATE_HOME") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
        if let Ok(value) = std::env::var("XDG_DATA_HOME") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed);
            }
        }
        if let Ok(value) = std::env::var("HOME") {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return PathBuf::from(trimmed).join(".local").join("state");
            }
        }
    }

    std::env::temp_dir().join("daacs_appdata")
}

pub fn project_cache_root(main_program_name: &str, project_name: &str) -> PathBuf {
    let base = appdata_base_dir();
    base.join(main_program_name)
        .join("cached")
        .join(project_name)
}

fn data_file_path(base: &Path, channel_id: &str) -> PathBuf {
    base.join(format!("psc_{}.dat", channel_id))
}

fn metadata_file_path(base: &Path) -> PathBuf {
    base.join("psc.metadata")
}

pub fn save_todo_list(
    main_program_name: &str,
    project_name: &str,
    todo: &SequencerTodoList,
) -> Result<PathBuf, String> {
    let base = project_cache_root(main_program_name, project_name);
    if let Err(e) = ensure_dir_all(&base) {
        return Err(e.to_string());
    }
    let data_path = data_file_path(&base, &todo.channel_id);
    json_to_file(&data_path, todo)
        .map_err(|e| e.to_string())
        .map(|_| ())?;

    let metadata_path = metadata_file_path(&base);
    let mut metadata: SequencerMetadata = json_from_file(&metadata_path)
        .map_err(|_| ())
        .ok()
        .unwrap_or_default();

    let timestamp = format!("{:?}", std::time::SystemTime::now());
    let last_file = data_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();

    if let Some(entry) = metadata
        .entries
        .iter_mut()
        .find(|e| e.channel_id == todo.channel_id)
    {
        entry.last_file = last_file;
        entry.last_updated_utc = timestamp;
    } else {
        metadata.entries.push(SequencerMetadataEntry {
            channel_id: todo.channel_id.clone(),
            last_file,
            last_updated_utc: timestamp,
        });
    }

    json_to_file(&metadata_path, &metadata)
        .map_err(|e| e.to_string())
        .map(|_| data_path)
}

pub fn load_todo_list(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
) -> Option<SequencerTodoList> {
    let base = project_cache_root(main_program_name, project_name);
    let data_path = data_file_path(&base, channel_id);
    json_from_file(&data_path).ok()
}

pub fn delete_todo_list(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
) -> Result<(), String> {
    let base = project_cache_root(main_program_name, project_name);
    let data_path = data_file_path(&base, channel_id);
    if data_path.exists() {
        std::fs::remove_file(&data_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn delete_project_cache(main_program_name: &str, project_name: &str) -> Result<(), String> {
    let project = project_name.trim();
    if project.is_empty() {
        return Err("project_name_empty".to_string());
    }

    let base = project_cache_root(main_program_name, project);
    if base.exists() {
        std::fs::remove_dir_all(&base).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn mark_item_done(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
    number: u32,
) -> Result<SequencerTodoList, String> {
    let mut todo = load_todo_list(main_program_name, project_name, channel_id)
        .ok_or_else(|| "todo_not_found".to_string())?;

    if let Some(item) = todo.items.iter_mut().find(|i| i.number == number) {
        item.status = SequencerStatus::Done;
    }

    let _ = save_todo_list(main_program_name, project_name, &todo)?;
    Ok(todo)
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SequencerArtifactManifest {
    pub entries: Vec<SequencerArtifactEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SequencerArtifactEntry {
    pub relative_path: String,
    pub step_number: Option<u32>,
    pub last_seen_utc: String,
}

fn artifact_manifest_path(base: &Path, channel_id: &str) -> PathBuf {
    base.join(format!("psc_artifacts_{}.json", channel_id))
}

fn artifacts_mirror_root(main_program_name: &str, project_name: &str, channel_id: &str) -> PathBuf {
    project_cache_root(main_program_name, project_name)
        .join("artifacts")
        .join(channel_id)
        .join("mirror")
}

fn normalize_workspace_relative(workspace: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim().trim_start_matches('/').trim_start_matches('\\');
    if trimmed.is_empty() {
        return Err("empty_relative_path".to_string());
    }
    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err("absolute_path_not_allowed".to_string());
    }
    let mut built = PathBuf::new();
    for comp in candidate.components() {
        match comp {
            std::path::Component::Normal(x) => built.push(x),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("invalid_path_component".to_string());
            }
        }
    }
    if built.as_os_str().is_empty() {
        return Err("empty_built_path".to_string());
    }
    Ok(workspace.join(built))
}

fn verify_resolved_file_inside_workspace(workspace: &Path, file_path: &Path) -> Result<(), String> {
    let ws = workspace.canonicalize().map_err(|e| e.to_string())?;
    let tgt = file_path.canonicalize().map_err(|e| e.to_string())?;
    if !tgt.starts_with(&ws) {
        return Err("path_outside_workspace".to_string());
    }
    Ok(())
}

fn posix_rel_key(path: &Path) -> String {
    path.iter()
        .map(|c| c.to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn extract_files_created_paths(text: &str) -> Vec<String> {
    let t = text;
    let lower = t.to_ascii_lowercase();
    let open = "[filescreated]";
    let close = "[/filescreated]";
    let Some(start) = lower.find(open) else {
        return vec![];
    };
    let after_open = start + open.len();
    let Some(end_rel) = lower[after_open..].find(close) else {
        return vec![];
    };
    let body = t[after_open..after_open + end_rel].trim();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let line = line.strip_prefix('-').map(|s| s.trim()).unwrap_or(line);
        let line = line.strip_prefix('*').map(|s| s.trim()).unwrap_or(line);
        if line.is_empty() {
            continue;
        }
        if !seen.insert(line.to_string()) {
            continue;
        }
        out.push(line.to_string());
    }
    out
}

fn try_extract_command_line_payload(line: &str) -> Option<&str> {
    fn numbered_payload(value: &str) -> Option<&str> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        let mut digit_end = 0usize;
        for (_, ch) in value.char_indices() {
            if ch.is_ascii_digit() {
                digit_end += ch.len_utf8();
                continue;
            }
            break;
        }
        if digit_end == 0 {
            return None;
        }
        let remain = value[digit_end..].trim_start();
        if let Some(rest) = remain.strip_prefix('.') {
            let rest = rest.trim_start().trim_end_matches('|').trim();
            return if rest.is_empty() { None } else { Some(rest) };
        }
        if let Some(rest) = remain.strip_prefix(')') {
            let rest = rest.trim_start().trim_end_matches('|').trim();
            return if rest.is_empty() { None } else { Some(rest) };
        }
        None
    }

    fn inner(value: &str) -> Option<&str> {
        let value = value.trim();
        if value.is_empty() {
            return None;
        }
        if let Some(p) = numbered_payload(value) {
            return Some(p);
        }
        if let Some(r) = value.strip_prefix('-').map(str::trim_start) {
            if r.is_empty() {
                return None;
            }
            if let Some(p) = numbered_payload(r) {
                return Some(p);
            }
            let trimmed_rest = r.trim_start();
            if trimmed_rest.starts_with('-') || trimmed_rest.starts_with('*') {
                return inner(r);
            }
            let r = r.trim().trim_end_matches('|').trim();
            return if r.is_empty() { None } else { Some(r) };
        }
        if let Some(r) = value.strip_prefix('*').map(str::trim_start) {
            if r.is_empty() {
                return None;
            }
            if let Some(p) = numbered_payload(r) {
                return Some(p);
            }
            let trimmed_rest = r.trim_start();
            if trimmed_rest.starts_with('-') || trimmed_rest.starts_with('*') {
                return inner(r);
            }
            let r = r.trim().trim_end_matches('|').trim();
            return if r.is_empty() { None } else { Some(r) };
        }
        None
    }
    inner(line)
}

fn heredoc_delimiter(command: &str) -> Option<String> {
    let mut rest = command;
    while let Some(pos) = rest.find("<<") {
        let after = &rest[pos + 2..];
        if after.starts_with('<') {
            rest = &after[1..];
            continue;
        }
        let after = after.strip_prefix('-').unwrap_or(after).trim_start();
        if after.is_empty() {
            return None;
        }
        let token = after
            .split(|ch: char| ch.is_whitespace() || ch == ';' || ch == '&' || ch == '|')
            .next()
            .unwrap_or("")
            .trim();
        let token = token
            .trim_matches('\'')
            .trim_matches('"')
            .trim_matches('`')
            .trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
        rest = after;
    }
    None
}

fn find_command_block_bounds(lower: &str) -> Option<(usize, usize, usize)> {
    let open_command = "[command]";
    let open_commands = "[commands]";
    let pos_cmd = lower.find(open_command);
    let pos_cmds = lower.find(open_commands);
    let (open_len, start) = match (pos_cmd, pos_cmds) {
        (Some(a), Some(b)) => {
            if a <= b {
                (open_command.len(), a)
            } else {
                (open_commands.len(), b)
            }
        }
        (Some(a), None) => (open_command.len(), a),
        (None, Some(b)) => (open_commands.len(), b),
        (None, None) => return None,
    };
    let after_open = start + open_len;
    let tail = &lower[after_open..];
    let close_command = "[/command]";
    let close_commands = "[/commands]";
    let end_rel_cmd = tail.find(close_command);
    let end_rel_cmds = tail.find(close_commands);
    let end_rel = match (end_rel_cmd, end_rel_cmds) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }?;
    Some((start, after_open, after_open + end_rel))
}

pub fn extract_command_lines(text: &str) -> Vec<String> {
    let body = text.trim();
    if body.is_empty() {
        return vec![];
    }
    let lower = body.to_ascii_lowercase();
    let Some((_start, inner_start, inner_end)) = find_command_block_bounds(&lower) else {
        return vec![];
    };
    let inner = body[inner_start..inner_end].trim();
    if inner.is_empty() {
        return vec![];
    }

    let mut out = Vec::<String>::new();
    let mut seen = std::collections::HashSet::<String>::new();
    let lines: Vec<&str> = inner.lines().collect();
    let mut idx = 0usize;
    while idx < lines.len() {
        let line = lines[idx];
        idx += 1;
        let value = line.trim();
        if value.is_empty() {
            continue;
        }
        let Some(payload) = try_extract_command_line_payload(value) else {
            continue;
        };
        let value = payload.trim();
        if value.is_empty() {
            continue;
        }

        let mut normalized = value.to_string();
        if let Some(delimiter) = heredoc_delimiter(value) {
            let mut found_terminator = false;
            while idx < lines.len() {
                let heredoc_line = lines[idx];
                idx += 1;
                normalized.push('\n');
                normalized.push_str(heredoc_line);
                if heredoc_line.trim() == delimiter {
                    found_terminator = true;
                    break;
                }
            }
            if !found_terminator {
                continue;
            }
        }
        let lower_val = normalized.to_ascii_lowercase();

        // Host Command Heuristic Validator (P0)
        // Block LLM from emitting instructional sentences or placeholders masked as shell commands
        if lower_val.contains("host must run shell commands")
            || lower_val.contains("execute this step")
            || lower_val.contains("[command]")
            || lower_val.contains("sequencer protocol")
            || lower_val.contains("do not reply with only")
            || lower_val.contains("placeholder")
            || lower_val.starts_with("first shell command")
            || lower_val.starts_with("second shell command")
            || lower_val.starts_with("```")
        {
            continue;
        }

        if !seen.insert(normalized.clone()) {
            continue;
        }
        out.push(normalized);
    }
    out
}

pub fn load_artifact_manifest(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
) -> Option<SequencerArtifactManifest> {
    let base = project_cache_root(main_program_name, project_name);
    let p = artifact_manifest_path(&base, channel_id);
    json_from_file(&p).ok()
}

fn save_artifact_manifest(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
    manifest: &SequencerArtifactManifest,
) -> Result<(), String> {
    let base = project_cache_root(main_program_name, project_name);
    ensure_dir_all(&base).map_err(|e| e.to_string())?;
    let p = artifact_manifest_path(&base, channel_id);
    json_to_file(&p, manifest).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn ingest_files_created_from_step_output(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
    workspace_root: &Path,
    step_output: &str,
    step_number: Option<u32>,
) -> Result<SequencerArtifactManifest, String> {
    let project = project_name.trim();
    let channel = channel_id.trim();
    if project.is_empty() || channel.is_empty() {
        return Err("project_or_channel_empty".to_string());
    }
    if !workspace_root.is_dir() {
        return Err("workspace_not_a_directory".to_string());
    }
    let ws = workspace_root.canonicalize().map_err(|e| e.to_string())?;

    let paths = extract_files_created_paths(step_output);
    if paths.is_empty() {
        return sync_artifact_manifest_with_workspace(main_program_name, project, channel, &ws);
    }

    let mut manifest =
        load_artifact_manifest(main_program_name, project, channel).unwrap_or_default();
    let mirror = artifacts_mirror_root(main_program_name, project, channel);
    ensure_dir_all(&mirror).map_err(|e| e.to_string())?;
    let timestamp = format!("{:?}", std::time::SystemTime::now());

    for raw in paths {
        let resolved = match normalize_workspace_relative(&ws, &raw) {
            Ok(p) => p,
            Err(_) => continue,
        };
        if !resolved.is_file() {
            continue;
        }
        if verify_resolved_file_inside_workspace(&ws, &resolved).is_err() {
            continue;
        }
        let rel_key = resolved
            .strip_prefix(&ws)
            .map(posix_rel_key)
            .unwrap_or_else(|_| raw.trim().replace('\\', "/"));
        let dest = mirror.join(&rel_key);
        if let Some(parent) = dest.parent() {
            ensure_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::copy(&resolved, &dest).map_err(|e| e.to_string())?;

        if let Some(existing) = manifest
            .entries
            .iter_mut()
            .find(|e| e.relative_path == rel_key)
        {
            existing.step_number = step_number;
            existing.last_seen_utc = timestamp.clone();
        } else {
            manifest.entries.push(SequencerArtifactEntry {
                relative_path: rel_key,
                step_number,
                last_seen_utc: timestamp.clone(),
            });
        }
    }

    sync_artifact_manifest_with_workspace(main_program_name, project, channel, &ws)
}

pub fn sync_artifact_manifest_with_workspace(
    main_program_name: &str,
    project_name: &str,
    channel_id: &str,
    workspace_root: &Path,
) -> Result<SequencerArtifactManifest, String> {
    let project = project_name.trim();
    let channel = channel_id.trim();
    if project.is_empty() || channel.is_empty() {
        return Err("project_or_channel_empty".to_string());
    }

    let mut manifest =
        load_artifact_manifest(main_program_name, project, channel).unwrap_or_default();

    if !workspace_root.is_dir() {
        return Ok(SequencerArtifactManifest { entries: vec![] });
    }
    let ws = match workspace_root.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            return Ok(SequencerArtifactManifest { entries: vec![] });
        }
    };

    manifest.entries.retain(|e| {
        normalize_workspace_relative(&ws, &e.relative_path)
            .map(|p| p.is_file())
            .unwrap_or(false)
    });

    save_artifact_manifest(main_program_name, project, channel, &manifest)?;
    Ok(manifest)
}

const PROMPTING_SEQUENCER_RULE: &str = include_str!("Prompting_Sequencer_Rule.md");

fn sequencer_rule_prompt(project_name: &str, channel_id: &str) -> String {
    let project_trimmed = project_name.trim();
    let project_display = if project_trimmed.is_empty() {
        "(unspecified)"
    } else {
        project_trimmed
    };
    let channel_trimmed = channel_id.trim();
    let channel_display = if channel_trimmed.is_empty() {
        "(unspecified)"
    } else {
        channel_trimmed
    };
    format!(
        "Session context: project_name={}, channel_id={}.\n\n{}",
        project_display, channel_display, PROMPTING_SEQUENCER_RULE,
    )
}

pub fn prompting_sequencer_system_prompt(project_name: &str, channel_id: &str) -> String {
    sequencer_rule_prompt(project_name, channel_id)
}

#[cfg(test)]
mod tests {
    use super::{extract_command_lines, extract_files_created_paths};

    #[test]
    fn parses_files_created_block() {
        let text = r#"[STEP_1_RESULT]
[FilesCreated]
test.txt
img.jpg
[/FilesCreated]
[/STEP_1_RESULT]"#;
        let p = extract_files_created_paths(text);
        assert_eq!(p, vec!["test.txt".to_string(), "img.jpg".to_string()]);
    }

    #[test]
    fn parses_bulleted_lines() {
        let text = "[FilesCreated]\n- a.txt\n* b.txt\n[/FilesCreated]";
        let p = extract_files_created_paths(text);
        assert_eq!(p, vec!["a.txt".to_string(), "b.txt".to_string()]);
    }

    #[test]
    fn parses_command_block_lines() {
        let text = "[STEP_1_RESULT]\nready\n[/STEP_1_RESULT]\n[Command]\n1. npm run test\n2. cargo check |\n[/Command]";
        let out = extract_command_lines(text);
        assert_eq!(
            out,
            vec!["npm run test".to_string(), "cargo check".to_string()]
        );
    }

    #[test]
    fn parses_command_block_bullets() {
        let text = "[Command]\n- pnpm lint\n* pnpm build\n[/Command]";
        let out = extract_command_lines(text);
        assert_eq!(out, vec!["pnpm lint".to_string(), "pnpm build".to_string()]);
    }

    #[test]
    fn ignores_non_list_lines_inside_command_block() {
        let text = "[Command]\nexport default CalculatorPage;\n1. npm run build\n[/Command]";
        let out = extract_command_lines(text);
        assert_eq!(out, vec!["npm run build".to_string()]);
    }

    #[test]
    fn parses_commands_plural_tag() {
        let text = "[Commands]\n1. cargo test\n[/Commands]";
        let out = extract_command_lines(text);
        assert_eq!(out, vec!["cargo test".to_string()]);
    }

    #[test]
    fn preserves_numbered_heredoc_command_body() {
        let text = r#"[Command]
1. cd apps/web && node --input-type=module <<'NODE'
console.log("ok");
NODE
2. npm run build
[/Command]"#;
        let out = extract_command_lines(text);
        assert_eq!(
            out,
            vec![
                "cd apps/web && node --input-type=module <<'NODE'\nconsole.log(\"ok\");\nNODE"
                    .to_string(),
                "npm run build".to_string(),
            ]
        );
    }

    #[test]
    fn skips_incomplete_heredoc_command_body() {
        let text = "[Command]\n1. cd apps/web && node --input-type=module <<'NODE'\n[/Command]";
        let out = extract_command_lines(text);
        assert!(out.is_empty());
    }
}
