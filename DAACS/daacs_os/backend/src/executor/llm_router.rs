use crate::domain::blueprint::AgentBlueprint;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolDef {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub tools: Vec<ToolDef>,
}

pub struct LlmRouter;

impl LlmRouter {
    pub fn new() -> Self {
        Self
    }

    pub fn resolve(&self, blueprint: &AgentBlueprint) -> LlmConfig {
        let is_high_authority = blueprint.ui_profile.authority_level >= 8;
        let has_code_generation = blueprint
            .capabilities
            .iter()
            .any(|capability| capability == "code_generation");
        let tools = blueprint
            .tool_policy
            .get("tools")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(|name| ToolDef {
                        name: name.to_string(),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let provider = std::env::var("DAACS_CLI_PROVIDER")
            .ok()
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| matches!(value.as_str(), "codex" | "gemini" | "claude" | "local_llm"))
            .unwrap_or_else(|| "codex".to_string());
        let local_model_label = std::env::var("DAACS_LOCAL_LLM_MODEL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                std::env::var("DAACS_LOCAL_LLM_MODEL_PATH")
                    .ok()
                    .and_then(|value| {
                        Path::new(value.trim())
                            .file_name()
                            .and_then(|name| name.to_str())
                            .map(|name| name.to_string())
                    })
            })
            .unwrap_or_else(|| "local-llm-user-selected".to_string());
        let model = match provider.as_str() {
            "gemini" => "gemini-cli".to_string(),
            "claude" | "local_llm" => local_model_label,
            _ => {
                if has_code_generation {
                    "codex-cli".to_string()
                } else if is_high_authority {
                    "codex-strategist".to_string()
                } else {
                    "codex-generalist".to_string()
                }
            }
        };

        LlmConfig {
            provider,
            model,
            temperature: if is_high_authority { 0.2 } else { 0.4 },
            max_tokens: if has_code_generation { 1800 } else { 1200 },
            tools,
        }
    }
}
