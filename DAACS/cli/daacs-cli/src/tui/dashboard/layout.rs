use ratatui::layout::{Constraint, Direction, Layout, Rect};

pub fn split_dashboard(area: Rect) -> (Rect, Rect, Rect, Rect) {
    let workspace = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),  // HUD
            Constraint::Min(10),    // Main Workspace
            Constraint::Length(3),  // Input/Logs
        ])
        .split(area);

    let hud_area = workspace[0];
    let main_area = workspace[1];
    let bottom_area = workspace[2];

    let main_split = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([
            Constraint::Length(25), // Sidebar (Crew)
            Constraint::Min(40),    // Viewport
        ])
        .split(main_area);

    let sidebar_area = main_split[0];
    let viewport_area = main_split[1];

    (hud_area, sidebar_area, viewport_area, bottom_area)
}
