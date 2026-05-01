//! 진행 상황 표시 UI

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Gauge, List, ListItem, Paragraph},
    Frame,
};
use crate::tui::App;

/// 진행 상황 화면 렌더링
pub fn render(f: &mut Frame, app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(3),   // 헤더
            Constraint::Length(3),   // 진행 바
            Constraint::Length(5),   // 현재 작업
            Constraint::Min(10),     // 로그
        ])
        .split(f.size());
    
    render_header(f, chunks[0]);
    render_progress_bar(f, chunks[1], app);
    render_current_task(f, chunks[2], app);
    render_logs(f, chunks[3]);
}

/// 헤더 렌더링
fn render_header(f: &mut Frame, area: Rect) {
    let header = Paragraph::new("🚀 DAACS CLI - 자율 개발 진행 중")
        .style(Style::default().fg(Color::Yellow).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::BOTTOM));
    f.render_widget(header, area);
}

/// 진행 바 렌더링
fn render_progress_bar(f: &mut Frame, area: Rect, app: &App) {
    let gauge = Gauge::default()
        .block(Block::default().title("전체 진행률").borders(Borders::ALL))
        .gauge_style(Style::default().fg(Color::Cyan).bg(Color::DarkGray))
        .percent((app.progress * 100.0) as u16)
        .label(format!("{:.1}%", app.progress * 100.0));
    
    f.render_widget(gauge, area);
}

/// 현재 작업 렌더링
fn render_current_task(f: &mut Frame, area: Rect, app: &App) {
    let task_text = if app.current_task.is_empty() {
        "대기 중..."
    } else {
        &app.current_task
    };
    
    let task = Paragraph::new(task_text)
        .style(Style::default().fg(Color::Green))
        .block(Block::default().title("현재 작업").borders(Borders::ALL));
    
    f.render_widget(task, area);
}

/// 로그 렌더링
fn render_logs(f: &mut Frame, area: Rect) {
    let logs = vec![
        ListItem::new(Line::from(Span::styled("✓ Phase 1: 인터뷰 완료", Style::default().fg(Color::Green)))),
        ListItem::new(Line::from(Span::styled("✓ Phase 2: 문서 생성 완료", Style::default().fg(Color::Green)))),
        ListItem::new(Line::from(Span::styled("🔄 Phase 3: Backend 개발 중...", Style::default().fg(Color::Yellow)))),
    ];
    
    let logs_list = List::new(logs)
        .block(Block::default().title("실행 로그").borders(Borders::ALL));
    
    f.render_widget(logs_list, area);
}
