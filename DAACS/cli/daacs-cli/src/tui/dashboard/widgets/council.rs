use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};
use crate::tui::dashboard::{DashboardState, events::VoteType};

pub fn render(f: &mut Frame, area: Rect, state: &DashboardState) {
    if !state.council_active {
        return; // Don't render if council is not active
    }

    // Overlay block
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" 🏛️  COUNCIL SESSION ")
        .style(Style::default().fg(Color::Yellow).bg(Color::Reset)); // Keep BG clean

    let inner_area = block.inner(area);
    f.render_widget(block, area);

    // Layout
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Topic
            Constraint::Min(5),    // Votes
            Constraint::Length(3), // Status
        ])
        .split(inner_area);

    // Topic
    let topic_text = format!("Topic: {}", state.council_topic);
    let topic = Paragraph::new(Line::from(topic_text))
        .style(Style::default().add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::BOTTOM));
    f.render_widget(topic, chunks[0]);

    // Votes Grid (2x2)
    let vote_chunks = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(chunks[1]);
    
    let left_col = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(vote_chunks[0]);

    let right_col = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Percentage(50), Constraint::Percentage(50)])
        .split(vote_chunks[1]);

    let all_vote_slots = vec![left_col[0], right_col[0], left_col[1], right_col[1]];
    
    let mut i = 0;
    for (voter, vote) in &state.council_votes {
        if i >= all_vote_slots.len() { break; }
        
        let (icon, color, label) = match vote {
            VoteType::Approve => ("✅", Color::Green, "APPROVE"),
            VoteType::Reject => ("❌", Color::Red, "REJECT"),
            VoteType::Abstain => ("⚪", Color::Gray, "ABSTAIN"),
            VoteType::Pending => ("⏳", Color::Yellow, "THINKING..."),
        };

        let card_content = vec![
            Line::from(Span::styled(voter, Style::default().add_modifier(Modifier::BOLD))),
            Line::from(""),
            Line::from(Span::styled(format!("{} {}", icon, label), Style::default().fg(color))),
        ];

        let card = Paragraph::new(card_content)
            .block(Block::default().borders(Borders::ALL).border_style(Style::default().fg(color)))
            .wrap(Wrap { trim: true });
        
        f.render_widget(card, all_vote_slots[i]);
        i += 1;
    }
}
