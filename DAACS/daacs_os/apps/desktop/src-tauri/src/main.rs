#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod calculator;
mod cli;
mod commands;
// Staged local-LLM bridge kept for the Rust migration; the active desktop runtime
// does not call it until local model orchestration is fully wired.
#[allow(dead_code, non_snake_case)]
mod httpApi;
mod l10n;
// Prompt loading is advertised in bundled metadata and kept for the Rust prompt bridge.
#[allow(dead_code)]
mod prompts;
mod skills;

use tauri::{LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let _ = tracing_subscriber::fmt::try_init();
    if let Err(error) = cli::initialize_agents_metadata_on_startup() {
        tracing::warn!("agents metadata startup migration skipped: {}", error);
    }
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Regular);
                if let Err(error) = app.handle().set_dock_visibility(true) {
                    tracing::warn!("dock visibility setup skipped: {}", error);
                }
                if let Err(error) = app.handle().show() {
                    tracing::warn!("app foreground show skipped: {}", error);
                }
            }

            let window = if let Some(window) = app.get_webview_window("main") {
                window
            } else if let Some(window_config) = app.config().app.windows.first().cloned() {
                let webview_url = {
                    #[cfg(debug_assertions)]
                    {
                        let dev_url = "http://localhost:3001"
                            .parse()
                            .expect("valid local Vite dev URL");
                        WebviewUrl::External(dev_url)
                    }

                    #[cfg(not(debug_assertions))]
                    {
                        WebviewUrl::App("index.html".into())
                    }
                };

                WebviewWindowBuilder::new(app.handle(), window_config.label.clone(), webview_url)
                    .title(window_config.title.clone())
                    .inner_size(window_config.width, window_config.height)
                    .resizable(window_config.resizable)
                    .maximizable(window_config.maximizable)
                    .minimizable(window_config.minimizable)
                    .closable(window_config.closable)
                    .decorations(window_config.decorations)
                    .visible(true)
                    .focusable(true)
                    .focused(true)
                    .build()?
            } else {
                tracing::warn!("main window config not found during startup");
                return Ok(());
            };

            {
                if let Err(error) = window.unminimize() {
                    tracing::warn!("main window unminimize skipped: {}", error);
                }
                if let Err(error) = window.set_size(LogicalSize::new(1400.0, 900.0)) {
                    tracing::warn!("main window resize skipped: {}", error);
                }
                if let Err(error) = window.center() {
                    tracing::warn!("main window center skipped: {}", error);
                }
                if let Err(error) = window.show() {
                    tracing::warn!("main window show skipped: {}", error);
                }
                if let Err(error) = window.set_focus() {
                    tracing::warn!("main window focus skipped: {}", error);
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::auth_login,
            commands::auth_register,
            commands::auth_me,
            commands::auth_logout,
            commands::auth_list_projects,
            commands::auth_create_project,
            commands::auth_ws_ticket,
            cli::prepare_artifact_workspace,
            cli::prepare_agent_workspaces,
            cli::omni_cli_run_command,
            cli::omni_cli_which,
            cli::omni_cli_workspace_path,
            cli::open_workspace_directory_dialog,
            cli::open_path_in_file_manager,
            cli::omni_cli_initialize_local,
            cli::get_agents_metadata_json,
            cli::get_agents_metadata_user_path,
            cli::read_agents_metadata_bundled,
            cli::save_agents_metadata_bundled,
            cli::remove_agent_user_artifacts,
            cli::read_agent_character_file,
            cli::get_agent_characters_user_dir,
            cli::save_agent_character_file,
            cli::save_factory_agent,
            cli::get_agent_prompt_by_prompt_key,
            cli::get_agent_prompt,
            cli::get_prompts_user_dir,
            cli::read_prompt_file_by_key,
            cli::save_prompt_file_by_key,
            cli::list_prompt_keys,
            cli::get_skill_prompt_for_role,
            cli::get_skill_prompt_for_custom,
            cli::get_skill_bundle_summary,
            cli::get_skill_catalog,
            cli::get_available_skill_ids,
            cli::save_local_office_state,
            cli::load_local_office_state,
            cli::clear_local_office_state,
            cli::save_global_office_state,
            cli::load_global_office_state,
            cli::parse_pm_task_lists_command,
            cli::rfi_system_prompt_command,
            cli::build_rfi_user_prompt_command,
            cli::parse_rfi_outcome_command,
            cli::prompting_sequencer_system_prompt_command,
            cli::prompting_sequencer_save_todo_command,
            cli::prompting_sequencer_load_todo_command,
            cli::prompting_sequencer_clear_channel_command,
            cli::prompting_sequencer_mark_done_command,
            cli::prompting_sequencer_extract_commands_command,
            cli::run_workspace_command,
            cli::stop_active_cli_commands,
            cli::list_local_llm_models,
            l10n::get_l10n,
            calculator::add,
            calculator::subtract,
            calculator::multiply,
            calculator::divide,
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        tracing::error!("error while running tauri application: {}", e);
        std::process::exit(1);
    }
}
