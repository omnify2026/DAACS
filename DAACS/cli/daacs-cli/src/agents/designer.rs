//! Designer Agent - Generates design systems and tokens.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignSystem {
    pub name: String,
    pub reasoning: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorPalette {
    pub theme_name: String,
    pub primary: String,
    pub secondary: String,
    pub background: String,
    pub surface: String,
    pub text: String,
    pub accent: String,
    pub mood_description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Typography {
    pub font_family: String,
    pub heading_font: String,
    pub base_size: String,
    pub scale: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DesignTokens {
    pub design_system: DesignSystem,
    pub color_palette: ColorPalette,
    pub typography: Typography,
    pub border_radius: String,
}

pub struct DesignerAgent {
    client: SessionBasedCLIClient,
}

impl DesignerAgent {
    pub fn new(model: ModelProvider, working_dir: std::path::PathBuf) -> Self {
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self { client }
    }

    pub async fn generate_design_tokens(&self, project_goal: &str) -> Result<DesignTokens> {
        let prompt = format!(
            "You are a world-class UI/UX Designer.\n\
Analyze the project goal and define the most suitable Design System, Color Palette, and Typography.\n\n\
=== PROJECT GOAL ===\n\
{goal}\n\n\
=== OUTPUT FORMAT (JSON ONLY) ===\n\
{{\n\
    \"design_system\": {{\n\
        \"name\": \"Tailwind CSS | Shadcn UI | Material UI\",\n\
        \"reasoning\": \"Why this fits the project\"\n\
    }},\n\
    \"color_palette\": {{\n\
        \"theme_name\": \"Theme Name (e.g., Cyberpunk, Corporate)\",\n\
        \"primary\": \"#000000\",\n\
        \"secondary\": \"#666666\",\n\
        \"background\": \"#ffffff\",\n\
        \"surface\": \"#f5f5f5\",\n\
        \"text\": \"#333333\",\n\
        \"accent\": \"#0066ff\",\n\
        \"mood_description\": \"Description of the visual mood\"\n\
    }},\n\
    \"typography\": {{\n\
        \"font_family\": \"Main Font (e.g., Inter, Roboto)\",\n\
        \"heading_font\": \"Heading Font (e.g., Outfit, Montserrat)\",\n\
        \"base_size\": \"16px\",\n\
        \"scale\": 1.25\n\
    }},\n\
    \"border_radius\": \"0.25rem | 0.5rem | 1rem\"\n\
}}\n\n\
RULES:\n\
1. Choose colors that match the project's mood (e.g., Dark/Serious for finance, Colorful for creative).\n\
2. Output ONLY valid JSON.",
            goal = project_goal
        );

        crate::logger::status_update("Designer: Generating design system...");
        let response = self.client.execute(&prompt).await?;
        
        let json_str = extract_json(&response).unwrap_or(response);
        let tokens: DesignTokens = serde_json::from_str(&json_str)
            .context("Failed to parse design tokens JSON")?;

        Ok(tokens)
    }

    pub async fn execute_general_task(&self, prompt: &str, context_paths: &[std::path::PathBuf]) -> Result<String> {
        let mut final_prompt = prompt.to_string();
        
        // [Slash Command Support for Claude]
        // If the model is Claude and we have exactly one skill path provided,
        // we can assume we want to "use" that skill via slash command.
        if matches!(self.client.provider, ModelProvider::Claude) {
            if let Some(first_path) = context_paths.first() {
                if let Some(skill_name) = first_path.file_name().and_then(|n| n.to_str()) {
                    crate::logger::status_update(&format!("⚡ Designer: Using Slash Command /{}", skill_name));
                    final_prompt = format!("/{} {}", skill_name, prompt);
                }
            }
            // For Claude, we inject the slash command into the prompt.
            // We MIGHT pass paths too if CLI client supports it, but Slash Command is primary.
            // SessionBasedCLIClient::execute_with_paths handles arguments differently per provider.
            // If Claude CLI ignores paths in args (verified earlier it looks only for --file or stdin),
            // then paths here are just for extracting the name.
        }

        crate::logger::status_update("Designer: Executing task...");
        let response = self.client.execute_with_paths(&final_prompt, context_paths).await?;
        Ok(response)
    }
}

fn extract_json(text: &str) -> Option<String> {
    if let Some(start) = text.find("```json") {
        let content_start = start + 7;
        if let Some(end) = text[content_start..].find("```") {
            return Some(text[content_start..content_start + end].trim().to_string());
        }
    }
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            return Some(text[start..=end].to_string());
        }
    }
    None
}
