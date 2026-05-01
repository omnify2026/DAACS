use anyhow::Result;
use async_trait::async_trait;
use std::path::PathBuf;

use serde::{Serialize, Deserialize};

/// Model Provider Enum
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ModelProvider {
    Claude,
    Codex,
    Gemini,
    GLM,
    DeepSeek,
    Custom(String),
}

/// Options for provider execution
#[derive(Debug, Clone, Default)]
pub struct ProviderOptions {
    pub session_continue: bool,
}

/// Common interface for all AI Model Providers (CLI or API)
#[async_trait]
pub trait Provider: Send + Sync {
    /// Execute a prompt and return the response.
    async fn complete(
        &self,
        prompt: &str,
        history: &[(String, String)],
        context_paths: &[PathBuf],
        options: &ProviderOptions,
    ) -> Result<String>;

    /// Return the name of the provider (e.g., "claude", "glm-4").
    fn name(&self) -> &str;
}
