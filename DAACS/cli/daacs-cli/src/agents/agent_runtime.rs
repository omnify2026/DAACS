//! Agent runtime helpers: session continuation + per-agent memory.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::clients::cli_client::SessionBasedCLIClient;
use crate::clients::cli_client::ModelProvider;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionState {
    sessions: HashMap<String, bool>,
}

pub struct AgentRuntime {
    project_path: PathBuf,
    memory_dir: PathBuf,
    sessions_path: PathBuf,
    sessions: HashMap<String, bool>,
}

impl AgentRuntime {
    pub fn new(project_path: &Path) -> Self {
        let daacs_dir = project_path.join(".daacs");
        let memory_dir = daacs_dir.join("memory");
        let sessions_path = daacs_dir.join("agent_sessions.json");

        let sessions = load_sessions(&sessions_path).unwrap_or_default();

        Self {
            project_path: project_path.to_path_buf(),
            memory_dir,
            sessions_path,
            sessions,
        }
    }

    /// Create a session-aware client for the agent.
    pub fn client(&mut self, model: ModelProvider, agent_key: &str) -> SessionBasedCLIClient {
        let mut client = SessionBasedCLIClient::new(model, self.project_path.clone());
        if self.sessions.get(agent_key).copied().unwrap_or(false) {
            client = client.with_continue();
        }
        self.sessions.insert(agent_key.to_string(), true);
        let _ = save_sessions(&self.sessions_path, &self.sessions);
        client
    }

    /// Build extra context: project tree + per-agent memory.
    pub fn build_context(&self, agent_key: &str) -> Result<String> {
        let mut context = String::new();
        context.push_str(&format!("Agent: {}\n", agent_key));
        context.push_str("[Project tree]\n");
        context.push_str(&build_tree_summary(&self.project_path));

        if let Some(memory) = self.read_memory(agent_key)? {
            if !memory.trim().is_empty() {
                context.push_str("\n[Agent memory]\n");
                context.push_str(&memory);
                if !memory.ends_with('\n') {
                    context.push('\n');
                }
            }
        }

        Ok(context)
    }

    /// Append memory snippet for the agent (trims to max length).
    pub fn append_memory(&self, agent_key: &str, text: &str) -> Result<()> {
        std::fs::create_dir_all(&self.memory_dir)
            .with_context(|| format!("Failed to create memory dir: {}", self.memory_dir.display()))?;

        let path = self.memory_dir.join(format!("{}.md", agent_key));
        let mut content = if path.exists() {
            std::fs::read_to_string(&path).unwrap_or_default()
        } else {
            String::new()
        };

        if !content.ends_with('\n') && !content.is_empty() {
            content.push('\n');
        }
        content.push_str(text);
        if !text.ends_with('\n') {
            content.push('\n');
        }

        // keep last ~4000 chars to limit prompt size
        const MAX_CHARS: usize = 4000;
        if content.len() > MAX_CHARS {
            let mut start = content.len() - MAX_CHARS;
            // Ensure start is at a valid UTF-8 character boundary
            while !content.is_char_boundary(start) && start < content.len() {
                start += 1;
            }
            content = content[start..].to_string();
        }

        std::fs::write(&path, content)
            .with_context(|| format!("Failed to write memory: {}", path.display()))?;

        Ok(())
    }

    fn read_memory(&self, agent_key: &str) -> Result<Option<String>> {
        let path = self.memory_dir.join(format!("{}.md", agent_key));
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)
            .with_context(|| format!("Failed to read memory: {}", path.display()))?;
        Ok(Some(content))
    }
}

fn load_sessions(path: &Path) -> Option<HashMap<String, bool>> {
    if !path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(path).ok()?;
    let state: SessionState = serde_json::from_str(&content).ok()?;
    Some(state.sessions)
}

fn save_sessions(path: &Path, sessions: &HashMap<String, bool>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create session dir: {}", parent.display()))?;
    }
    let state = SessionState { sessions: sessions.clone() };
    let content = serde_json::to_string_pretty(&state)?;
    std::fs::write(path, content)
        .with_context(|| format!("Failed to write sessions: {}", path.display()))?;
    Ok(())
}

fn build_tree_summary(root: &Path) -> String {
    let mut lines = Vec::new();
    collect_tree(root, root, 0, 3, &mut lines, 200);
    if lines.is_empty() {
        return "(empty)\n".to_string();
    }
    lines.join("\n") + "\n"
}

fn collect_tree(
    root: &Path,
    current: &Path,
    depth: usize,
    max_depth: usize,
    out: &mut Vec<String>,
    max_entries: usize,
) {
    if depth > max_depth || out.len() >= max_entries {
        return;
    }

    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if out.len() >= max_entries {
            return;
        }
        let path = entry.path();
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n,
            None => continue,
        };

        if should_skip(name) {
            continue;
        }

        let rel = path.strip_prefix(root).unwrap_or(&path);
        if path.is_dir() {
            out.push(format!("{}/", rel.display()));
            collect_tree(root, &path, depth + 1, max_depth, out, max_entries);
        } else {
            out.push(rel.display().to_string());
        }
    }
}

fn should_skip(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "target"
            | "node_modules"
            | ".daacs"
            | "dist"
            | "build"
            | ".next"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}
