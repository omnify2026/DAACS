pub mod events;
pub mod state;
pub mod layout;
pub mod widgets;
pub mod theme;

pub use state::DashboardState;
pub use events::AgentEvent;

use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEventKind},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{backend::CrosstermBackend, Terminal};
use std::io;
use std::time::Duration;
use flume::Receiver;

/// TUI 실행
pub async fn run_dashboard(event_rx: Receiver<AgentEvent>) -> Result<()> {
    // 터미널 설정
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut state = DashboardState::new();

    loop {
        // 1. Draw UI
        terminal.draw(|f| {
            match state.current_screen {
                state::Screen::Home => {
                    widgets::home::render(f, f.size(), &state);
                },
                state::Screen::Dashboard => {
                    let (hud_area, sidebar_area, viewport_area, _bottom_area) = layout::split_dashboard(f.size());
                    
                    widgets::hud::render(f, hud_area, &state);
                    widgets::crew::render(f, sidebar_area, &state);
                    widgets::viewport::render(f, viewport_area, &state);
                    // widgets::console::render(f, bottom_area, &state); // Console placeholder
                    
                    // Council Overlay (if active)
                    widgets::council::render(f, viewport_area, &state);
                }
            }
        })?;

        // 2. Handle Events (Non-blocking check)
        // Check for agent events
        while let Ok(event) = event_rx.try_recv() {
            state.apply_event(event);
        }

        // 3. Handle Input (Poll with timeout)
        if event::poll(Duration::from_millis(16))? {
            if let Event::Key(key) = event::read()? {
                if key.kind == KeyEventKind::Press {
                    match key.code {
                        KeyCode::Esc => break, // Exit TUI
                        KeyCode::Char(c) => {
                            state.input_buffer.push(c);
                        },
                        KeyCode::Backspace => {
                            state.input_buffer.pop();
                        },
                        _ => {}
                    }
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

    Ok(())
}
