use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph},
    Frame,
};
use crate::tui::dashboard::DashboardState;

pub fn render(f: &mut Frame, area: Rect, state: &DashboardState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(10), // Logo
            Constraint::Length(6),  // Stats/Info
            Constraint::Min(2),     // Spacer
            Constraint::Length(3),  // Tips
            Constraint::Length(3),  // Input
        ])
        .split(area);

    // 1. Logo (ASCII Art)
    let logo_text = vec![
        Line::from(vec![Span::styled("╭─ DAACS (Digital Autonomous Agent Coding System) ──────────────────────────────╮", Style::default().fg(Color::DarkGray))]),
        Line::from(vec![Span::styled("│                                                                               │", Style::default().fg(Color::DarkGray))]),
        Line::from(vec![Span::styled("│     ██████╗  █████╗  █████╗  ██████╗ ███████╗                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│     ██╔══██╗██╔══██╗██╔══██╗██╔════╝ ██╔════╝                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│     ██║  ██║███████║███████║██║      ███████╗                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│     ██║  ██║██╔══██║██╔══██║██║      ╚════██║                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│     ██████╔╝██║  ██║██║  ██║╚██████╔╝███████║                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│     ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝                                 │", Style::default().fg(Color::Cyan))]),
        Line::from(vec![Span::styled("│                                                                               │", Style::default().fg(Color::DarkGray))]),
        Line::from(vec![Span::styled("╰─ v2.0.0 | CLI: codex ─────────────────────────────────────────────────────────╯", Style::default().fg(Color::DarkGray))]),
    ];
    let logo = Paragraph::new(logo_text).alignment(Alignment::Center);
    f.render_widget(logo, chunks[0]);

    // 2. Info Panel
    let info_text = vec![
        Line::from(vec![Span::styled("  📁 Project: ", Style::default().fg(Color::Yellow)), Span::raw(std::env::current_dir().unwrap_or_default().display().to_string())]),
        Line::from(vec![Span::styled("  🤖 CLI Type: ", Style::default().fg(Color::Yellow)), Span::raw("codex")]), // Dynamic later
        Line::from(vec![Span::styled("  💾 Memory: ", Style::default().fg(Color::Yellow)), Span::raw(".daacs/memory/")]),
    ];
    let info = Paragraph::new(info_text).alignment(Alignment::Center);
    f.render_widget(info, chunks[1]);

    // 3. Tips
    let tips = Paragraph::new("ℹ Tips: /help, /init, /model, /clear, /exit")
        .style(Style::default().fg(Color::DarkGray))
        .alignment(Alignment::Center);
    f.render_widget(tips, chunks[3]);

    // 4. Input Prompt
    let input_block = Block::default()
        .borders(Borders::NONE);
    
    let input_text = format!("> {}", state.input_buffer);
    let input = Paragraph::new(input_text)
        .block(input_block)
        .style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD));
    f.render_widget(input, chunks[4]); // Using chunks[4] for input at bottom
}
