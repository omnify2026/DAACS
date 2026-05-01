use serde::Deserialize;
use std::path::Path;

use crate::file_io::file_exists;
use crate::json_util::json_from_file;

const PROMPTS_REL_PATH: &str = "Resources/prompts";
const PROMPT_EXT: &str = ".json";

#[derive(Debug, Clone, Deserialize)]
pub struct PromptDoc {
    #[serde(deserialize_with = "deserialize_content")]
    pub content: String,
    #[serde(default)]
    pub description: Option<String>,
}

fn deserialize_content<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ContentOrLines {
        String(String),
        Lines(Vec<String>),
    }
    let value = ContentOrLines::deserialize(deserializer)?;
    Ok(match value {
        ContentOrLines::String(s) => s,
        ContentOrLines::Lines(lines) => lines.join("\n"),
    })
}

#[derive(Debug)]
pub enum PromptError {
    Path(String),
    Io(std::io::Error),
    Parse(serde_json::Error),
}

impl std::fmt::Display for PromptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PromptError::Path(s) => write!(f, "prompt path error: {}", s),
            PromptError::Io(e) => write!(f, "prompt IO error: {}", e),
            PromptError::Parse(e) => write!(f, "prompt parse error: {}", e),
        }
    }
}

impl std::error::Error for PromptError {}

impl From<std::io::Error> for PromptError {
    fn from(e: std::io::Error) -> Self {
        PromptError::Io(e)
    }
}

impl From<serde_json::Error> for PromptError {
    fn from(e: serde_json::Error) -> Self {
        PromptError::Parse(e)
    }
}

fn path_for_prompt<P: AsRef<Path>>(base_path: P, prompt_name: &str) -> std::path::PathBuf {
    base_path
        .as_ref()
        .join(PROMPTS_REL_PATH)
        .join(format!("{}{}", prompt_name, PROMPT_EXT))
}

pub fn load_prompt<P: AsRef<Path>>(base_path: P, prompt_name: &str) -> Result<PromptDoc, PromptError> {
    let path = path_for_prompt(base_path, prompt_name);
    if !file_exists(&path) {
        return Err(PromptError::Path(format!(
            "prompt file not found: {}",
            path.display()
        )));
    }
    let doc: PromptDoc = json_from_file(&path).map_err(|e| match e {
        crate::json_util::JsonFileError::Io(io) => PromptError::Io(io),
        crate::json_util::JsonFileError::Parse(se) => PromptError::Parse(se),
    })?;
    Ok(doc)
}

pub fn try_load_prompt<P: AsRef<Path>>(base_path: P, prompt_name: &str) -> Option<PromptDoc> {
    load_prompt(base_path, prompt_name).ok()
}

impl PromptDoc {
    pub fn substitute(&self, replacements: &[(&str, &str)]) -> String {
        let mut out = self.content.clone();
        for (key, value) in replacements {
            let placeholder = format!("{{{}}}", key);
            out = out.replace(&placeholder, value);
        }
        out
    }
}
