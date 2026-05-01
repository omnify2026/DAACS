//! TUI 인터페이스 모듈 (ratatui)
//!
//! 대화형 인터뷰 UI, 진행 상황 표시, 완료 요약을 처리합니다.

pub mod interview;
pub mod progress;
pub mod summary;
pub mod dashboard;

use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    Terminal,
};
use std::io;
use anyhow::Result;
use std::collections::HashMap;

/// TUI 실행 결과
#[derive(Debug, Clone)]
pub struct TuiResult {
    pub goal: String,
    pub context: HashMap<String, String>,
}

/// TUI 앱 상태
#[derive(Debug, Clone)]
pub enum AppState {
    Interview,
    Progress,
    Summary,
    Exit,
}

/// TUI 앱
pub struct App {
    pub state: AppState,
    pub input: String,
    pub messages: Vec<(String, String)>, // (role, content)
    pub progress: f64,
    pub current_task: String,
    
    // 수집된 데이터
    pub goal: String,
    pub context: HashMap<String, String>,
}

impl Default for App {
    fn default() -> Self {
        Self {
            state: AppState::Interview,
            input: String::new(),
            messages: vec![
                ("assistant".to_string(), "안녕하세요! DAACS CLI입니다. 🐝\n\n어떤 프로젝트를 만들고 싶으신가요?".to_string()),
            ],
            progress: 0.0,
            current_task: String::new(),
            goal: String::new(),
            context: HashMap::new(),
        }
    }
}

impl App {
    pub fn new() -> Self {
        Self::default()
    }
    
    /// 사용자 입력 추가
    pub fn add_user_message(&mut self, message: String) {
        self.messages.push(("user".to_string(), message.clone()));
        
        // 첫 번째 입력을 목표로 설정 (단순화)
        if self.goal.is_empty() {
            self.goal = message;
        }
    }
    
    /// 어시스턴트 응답 추가
    pub fn add_assistant_message(&mut self, message: String) {
        self.messages.push(("assistant".to_string(), message));
    }
}

/// TUI 실행 (결과 반환)
pub async fn run_tui() -> Result<TuiResult> {
    // 터미널 설정
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;
    
    let mut app = App::new();
    
    // 메인 루프
    loop {
        terminal.draw(|f| {
            match app.state {
                AppState::Interview => interview::render(f, &app),
                AppState::Progress => progress::render(f, &app),
                AppState::Summary => summary::render(f, &app),
                AppState::Exit => {}
            }
        })?;
        
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Press {
                match key.code {
                    KeyCode::Esc => {
                        app.state = AppState::Exit;
                        break;
                    }
                    KeyCode::Enter => {
                        if !app.input.is_empty() {
                            let input = app.input.clone();
                            app.add_user_message(input);
                            app.input.clear();
                            
                            // TODO: 실제 LLM 연동 (여기서도 Mock 제거 필요)
                            // 현재는 단순 응답만
                            app.add_assistant_message("네, 확인했습니다. (Enter를 한 번 더 누르면 종료)".to_string());
                            
                            // 두 번째 입력 시 종료 (테스트용)
                            if app.messages.len() > 4 {
                                app.state = AppState::Exit;
                                break;
                            }
                        }
                    }
                    KeyCode::Char(c) => {
                        app.input.push(c);
                    }
                    KeyCode::Backspace => {
                        app.input.pop();
                    }
                    _ => {}
                }
            }
        }
    }
    
    // 터미널 복원
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    
    // 결과 반환
    Ok(TuiResult {
        goal: app.goal,
        context: app.context,
    })
}
