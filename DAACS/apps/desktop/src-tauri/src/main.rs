#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use infra_logger;

fn main() {
    infra_logger::init_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![run_agent])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
async fn run_agent() -> Result<(), String> {
    let runner = ai_core::AgentRunner::new();
    runner.run().await.map_err(|e| e.to_string())
}
