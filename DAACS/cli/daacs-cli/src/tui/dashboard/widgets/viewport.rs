use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    widgets::{Block, Borders, Paragraph, Wrap},
    Frame,
};
use crate::tui::dashboard::{DashboardState, state::WorkflowStep};

pub fn render(f: &mut Frame, area: Rect, state: &DashboardState) {
    let block = Block::default()
        .borders(Borders::ALL)
        .title(" MAIN WORKSPACE ")
        .style(Style::default().fg(Color::White));

    let inner_area = block.inner(area);
    f.render_widget(block, area);

    // Split for Process Bar (Top) and Content (Bottom)
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Workflow Status Bar
            Constraint::Min(10),   // Main Content
        ])
        .split(inner_area);

    // 1. Workflow Status Bar
    render_workflow_bar(f, chunks[0], &state.workflow_step);

    // 2. Main Content
    let content_text = if state.council_active {
        "Council is voting... Focus on the Council overlay.".to_string()
    } else if !state.main_content.is_empty() {
        state.main_content.clone()
    } else if !state.logs.is_empty() {
         // Fallback to logs if no specific content
        state.logs.iter()
            .rev()
            .take(20)
            .map(|log| format!("[{}] {} - {}", log.timestamp, log.level, log.message))
            .collect::<Vec<String>>()
            .join("\n")
    } else {
        "Ready for command.\n\nWaiting for activity...".to_string()
    };

    let content_block = Block::default()
        .borders(Borders::NONE)
        .style(Style::default().fg(Color::Gray));

    let paragraph = Paragraph::new(content_text)
        .block(content_block)
        .wrap(Wrap { trim: false }); // Code wrapping might be bad, but better than clipping for now

    f.render_widget(paragraph, chunks[1]);
}

fn render_workflow_bar(f: &mut Frame, area: Rect, current_step: &WorkflowStep) {
    let steps = vec![
        (WorkflowStep::Architecting, "1. PLAN"),
        (WorkflowStep::Council, "2. AGREE"),
        (WorkflowStep::Coding, "3. CODE"),
        (WorkflowStep::Reviewing, "4. REVIEW"),
        (WorkflowStep::Deploying, "5. DEPLOY"),
    ];

    let step_width = area.width / steps.len() as u16;
    let layout = Layout::default()
        .direction(Direction::Horizontal)
        .constraints(vec![Constraint::Length(step_width); steps.len()])
        .split(area);

    for (i, (step_enum, label)) in steps.iter().enumerate() {
        let is_active = std::mem::discriminant(current_step) == std::mem::discriminant(step_enum);
        
        let style = if is_active {
            Style::default().fg(Color::Black).bg(Color::Green).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(Color::DarkGray)
        };

        let block = Block::default()
            .borders(Borders::ALL)
            .style(style);

        let paragraph = Paragraph::new(*label)
            .block(block)
            .alignment(ratatui::layout::Alignment::Center);

        if i < layout.len() {
            f.render_widget(paragraph, layout[i]);
        }
    }
}
