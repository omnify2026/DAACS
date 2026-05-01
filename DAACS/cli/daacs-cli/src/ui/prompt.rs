//! Interactive Prompts using inquire

use inquire::{Text, Select, Confirm};
use inquire::ui::RenderConfig;

pub struct Prompt;

impl Prompt {
    /// Ask for text input
    pub fn ask_text(message: &str) -> String {
        Text::new(message)
            .with_render_config(Self::get_config())
            .prompt()
            .unwrap_or_default()
    }

    /// Ask for selection
    pub fn ask_select(message: &str, options: Vec<&str>) -> String {
        Select::new(message, options)
            .with_render_config(Self::get_config())
            .prompt()
            .unwrap_or_default()
            .to_string()
    }

    /// Ask for confirmation
    pub fn ask_confirm(message: &str) -> bool {
        Confirm::new(message)
            .with_render_config(Self::get_config())
            .with_default(true)
            .prompt()
            .unwrap_or(false)
    }

    fn get_config() -> RenderConfig<'static> {
        RenderConfig::default()
    }
}
