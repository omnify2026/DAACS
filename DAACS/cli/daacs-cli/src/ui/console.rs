//! Simple Console Output

use std::io::{self, Write};
use colored::*;

pub struct Console;

impl Default for Console {
    fn default() -> Self {
        Self::new()
    }
}

impl Console {
    pub fn new() -> Self {
        Self
    }

    /// Print a panel with a title
    pub fn print_panel(&self, content: &str, title: &str, subtitle: &str) {
        let width = 80;
        let title_len = title.chars().count();
        let padding = if width > title_len + 4 { width - title_len - 4 } else { 0 };
        
        println!();
        println!("╭─ {} {}╮", title.bright_cyan().bold(), "─".repeat(padding).bright_cyan());
        
        for line in content.lines() {
            let line_len = line.chars().count();
            let space = if width > line_len + 4 { width - line_len - 4 } else { 0 };
            println!("│ {} {} │", line, " ".repeat(space));
        }
        
        let subtitle_len = subtitle.chars().count();
        let padding_sub = if width > subtitle_len + 4 { width - subtitle_len - 4 } else { 0 };
        println!("╰─ {} {}╯", subtitle.bright_cyan(), "─".repeat(padding_sub).bright_cyan());
        println!();
    }

    /// Print success message
    pub fn print_success(&self, message: &str) {
        println!("{} {}", "✓".bright_green().bold(), message);
    }

    /// Print error message
    pub fn print_error(&self, message: &str) {
        println!("{} {}", "✗".bright_red().bold(), message);
    }
    
    /// Print warning message
    pub fn print_warning(&self, message: &str) {
        println!("{} {}", "⚠".bright_yellow().bold(), message);
    }
    
    /// Print info message
    pub fn print_info(&self, message: &str) {
        println!("{} {}", "ℹ".bright_blue().bold(), message);
    }
    
    /// Print a streaming token
    pub fn print_stream(&self, token: &str) {
        print!("{}", token);
        io::stdout().flush().unwrap();
    }
}
