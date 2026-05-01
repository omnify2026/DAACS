//! 인터뷰 UI - SPEC.md Section 6.2 기반

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph, Wrap},
    Frame,
};
use crate::tui::App;

/// 인터뷰 화면 렌더링
pub fn render(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3),   // 헤더
            Constraint::Min(10),     // 대화 영역
            Constraint::Length(5),   // 요약 패널
            Constraint::Length(3),   // 입력 영역
        ])
        .split(f.size());
    
    render_header(f, chunks[0]);
    render_messages(f, chunks[1], app);
    render_summary_panel(f, chunks[2], app);
    render_input(f, chunks[3], app);
}

/// 헤더 렌더링
fn render_header(f: &mut Frame, area: Rect) {
    let header = Paragraph::new("🐝 DAACS CLI - 동적 인터뷰")
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::BOTTOM));
    f.render_widget(header, area);
}

/// 대화 메시지 렌더링
fn render_messages(f: &mut Frame, area: Rect, app: &App) {
    let messages: Vec<ListItem> = app
        .messages
        .iter()
        .map(|(role, content)| {
            let style = if role == "user" {
                Style::default().fg(Color::Cyan)
            } else {
                Style::default().fg(Color::Green)
            };
            
            let prefix = if role == "user" { "👤 You" } else { "🤖 DAACS" };
            let text = format!("{}: {}", prefix, content);
            
            ListItem::new(Line::from(Span::styled(text, style)))
        })
        .collect();
    
    let messages_list = List::new(messages)
        .block(Block::default().title("대화").borders(Borders::ALL));
    
    f.render_widget(messages_list, area);
}

/// 요약 패널 렌더링
fn render_summary_panel(f: &mut Frame, area: Rect, app: &App) {
    let summary_text = if app.messages.len() > 2 {
        "📋 수집된 정보: 프로젝트 유형, 기술 스택..."
    } else {
        "📋 인터뷰를 진행하면 여기에 요약이 표시됩니다."
    };
    
    let summary = Paragraph::new(summary_text)
        .style(Style::default().fg(Color::Gray))
        .block(Block::default().title("실시간 요약").borders(Borders::ALL))
        .wrap(Wrap { trim: true });
    
    f.render_widget(summary, area);
}

/// 입력 영역 렌더링
fn render_input(f: &mut Frame, area: Rect, app: &App) {
    let input = Paragraph::new(app.input.as_str())
        .style(Style::default().fg(Color::White))
        .block(Block::default().title("입력 (Enter: 전송, Esc: 종료)").borders(Borders::ALL));
    
    f.render_widget(input, area);
    
    // 커서 위치 설정
    f.set_cursor(
        area.x + app.input.len() as u16 + 1,
        area.y + 1,
    );
}
