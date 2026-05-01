use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph},
    Frame,
};
use crate::tui::dashboard::DashboardState;

pub fn render(f: &mut Frame, area: Rect, state: &DashboardState) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" PROJECT HUD ")
        .style(Style::default().fg(Color::Yellow));

    let inner_area = block.inner(area);
    f.render_widget(block, area);

    let chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Percentage(33),
            Constraint::Percentage(33),
            Constraint::Percentage(33),
        ])
        .split(inner_area);

    // Phase
    let phase_text = format!("Phase: {}", state.phase);
    let phase = Paragraph::new(Line::from(phase_text))
        .style(Style::default().fg(Color::White).add_modifier(Modifier::BOLD));
    f.render_widget(phase, chunks[0]);

    // Tokens
    let token_text = format!("Tokens: {}", state.token_usage);
    let tokens = Paragraph::new(Line::from(token_text))
        .style(Style::default().fg(Color::Magenta));
    f.render_widget(tokens, chunks[1]);
    
    // Cost
    let cost_text = format!("Cost: ${:.4}", state.estimated_cost);
    let cost = Paragraph::new(Line::from(cost_text))
        .style(Style::default().fg(Color::Green));
    f.render_widget(cost, chunks[2]);
}
