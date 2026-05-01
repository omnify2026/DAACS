//! 완료 요약 UI

use ratatui::{
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, Paragraph},
    Frame,
};
use crate::tui::App;

/// 요약 화면 렌더링
pub fn render(f: &mut Frame, _app: &App) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .margin(1)
        .constraints([
            Constraint::Length(5),   // 헤더
            Constraint::Min(10),     // 생성된 파일 목록
            Constraint::Length(5),   // 다음 단계 안내
        ])
        .split(f.size());
    
    render_header(f, chunks[0]);
    render_files(f, chunks[1]);
    render_next_steps(f, chunks[2]);
}

/// 헤더 렌더링
fn render_header(f: &mut Frame, area: Rect) {
    let header = Paragraph::new("🎉 프로젝트 생성 완료!")
        .style(Style::default().fg(Color::Green).add_modifier(Modifier::BOLD))
        .block(Block::default().borders(Borders::ALL));
    f.render_widget(header, area);
}

/// 생성된 파일 목록 렌더링
fn render_files(f: &mut Frame, area: Rect) {
    let files = vec![
        ListItem::new(Line::from(Span::styled("📄 DAACS.md - 기술 명세서", Style::default().fg(Color::Cyan)))),
        ListItem::new(Line::from(Span::styled("📄 plan.md - 실행 계획", Style::default().fg(Color::Cyan)))),
        ListItem::new(Line::from(Span::styled("📁 backend/ - 백엔드 코드", Style::default().fg(Color::Yellow)))),
        ListItem::new(Line::from(Span::styled("📁 frontend/ - 프론트엔드 코드", Style::default().fg(Color::Yellow)))),
        ListItem::new(Line::from(Span::styled("📄 README.md - 프로젝트 문서", Style::default().fg(Color::Cyan)))),
    ];
    
    let files_list = List::new(files)
        .block(Block::default().title("생성된 파일").borders(Borders::ALL));
    
    f.render_widget(files_list, area);
}

/// 다음 단계 안내 렌더링
fn render_next_steps(f: &mut Frame, area: Rect) {
    let next_steps = Paragraph::new("다음 단계:\n1. cd ./project\n2. npm install 또는 pip install\n3. npm run dev 또는 python main.py")
        .style(Style::default().fg(Color::Gray))
        .block(Block::default().title("다음 단계").borders(Borders::ALL));
    
    f.render_widget(next_steps, area);
}
