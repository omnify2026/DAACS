use ratatui::style::{Color, Modifier, Style};

#[derive(Debug, Clone, Copy)]
pub enum ThemeVariant {
    Cyberpunk,
    Zen,
}

pub struct Theme {
    pub border_active: Style,
    pub border_idle: Style,
    pub text_primary: Style,
    pub text_secondary: Style,
    pub accent_success: Style,
    pub accent_failure: Style,
}

impl Theme {
    pub fn new(variant: ThemeVariant) -> Self {
        match variant {
            ThemeVariant::Cyberpunk => Self {
                border_active: Style::default().fg(Color::Magenta).add_modifier(Modifier::BOLD),
                border_idle: Style::default().fg(Color::DarkGray),
                text_primary: Style::default().fg(Color::Cyan),
                text_secondary: Style::default().fg(Color::Gray),
                accent_success: Style::default().fg(Color::Green),
                accent_failure: Style::default().fg(Color::Red),
            },
            ThemeVariant::Zen => Self {
                border_active: Style::default().fg(Color::White),
                border_idle: Style::default().fg(Color::Gray),
                text_primary: Style::default().fg(Color::White),
                text_secondary: Style::default().fg(Color::DarkGray),
                accent_success: Style::default().fg(Color::LightBlue),
                accent_failure: Style::default().fg(Color::LightRed),
            },
        }
    }
}
