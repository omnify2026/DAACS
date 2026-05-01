use ratatui::{
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem},
    Frame,
};
use crate::tui::dashboard::DashboardState;

pub fn render(f: &mut Frame, area: Rect, state: &DashboardState) {
    let mut items = Vec::new();
    
    // Sort agents for consistent display
    let mut agent_names: Vec<&String> = state.agents.keys().collect();
    agent_names.sort();

    for name in agent_names {
        if let Some(agent) = state.agents.get(name) {
            let (status_color, icon) = if agent.is_active {
                if name == "Council" {
                    (Color::Red, "🏛️") // Council gets special icon
                } else {
                    (Color::Green, "⚡")
                }
            } else {
                (Color::Gray, "⚫")
            };

            let name_span = Span::styled(
                format!("{} {}", icon, agent.name),
                Style::default().fg(status_color).add_modifier(Modifier::BOLD),
            );
            
            let status_span = Span::styled(
                format!("  | {}", agent.status),
                Style::default().fg(Color::DarkGray),
            );

            items.push(ListItem::new(Line::from(vec![name_span, status_span])));
        }
    }

    let block = Block::default()
        .borders(Borders::ALL)
        .title(" CREW STATUS ")
        .style(Style::default().fg(Color::Cyan));

    let list = List::new(items).block(block);
    f.render_widget(list, area);
}
