//! DAACS CLI 엔트리 포인트

use clap::Parser;

use daacs::cli::args::Args;
use daacs::cli::repl::run_repl;
use daacs::config::settings::DaacsConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::init();

    if let Err(e) = daacs::config::settings::init() {
        eprintln!("설정 초기화 실패: {}", e);
        eprintln!("   기본 설정으로 진행합니다.");
    }

    let args = Args::parse();

    if args.verbose {
        println!("디버그 로그 활성화");
    }

    if args.dir != "." {
        std::env::set_current_dir(&args.dir)?;
        println!("현재 경로 변경: {}", args.dir);
    }

    match args.command {
        Some(daacs::cli::args::Commands::New { name }) => {
            let project_path = std::env::current_dir()?.join(&name);
            let goal = format!("새 프로젝트 생성: {}", name);
            daacs::cli::run::start_new_project(goal, project_path, false).await?; // auto_mode = false
        }
        Some(daacs::cli::args::Commands::Resume { session_id }) => {
            daacs::cli::run::resume_session(session_id, false).await?; // auto_mode = false
        }
        Some(daacs::cli::args::Commands::Config { key, value }) => {
            handle_config_command(key, value)?;
        }
        Some(daacs::cli::args::Commands::Sessions { action }) => {
            handle_sessions_command(action).await?;
        }
        None => {
            if let Some(goal) = args.goal {
                let project_path = std::env::current_dir()?.join("project");
                daacs::cli::run::start_new_project(goal, project_path, false).await?; // auto_mode = false
            } else {
                run_repl().await?;
            }
        }
    }

    Ok(())
}

fn handle_config_command(key: Option<String>, value: Option<String>) -> anyhow::Result<()> {
    let mut config = DaacsConfig::load()?;

    match (key, value) {
        (None, None) => {
            println!("현재 DAACS 설정:\n");
            println!("설정 경로: {}", DaacsConfig::config_path()?.display());
            println!("\n[models]");
            println!("  architect       = {}", config.models.architect);
            println!("  backend_dev     = {}", config.models.backend_developer);
            println!("  frontend_dev    = {}", config.models.frontend_developer);
            println!("  devops          = {}", config.models.devops);
            println!("  reviewer        = {}", config.models.reviewer);
            println!("  refactorer      = {}", config.models.refactorer);
            println!("  designer        = {}", config.models.designer);
            println!("  doc_writer      = {}", config.models.doc_writer);
            println!("\n[resilience]");
            println!("  max_retries            = {}", config.resilience.max_retries);
            println!("  enable_fallback        = {}", config.resilience.enable_fallback);
            println!("  token_limit_strategy   = {}", config.resilience.token_limit_strategy);
            println!("  use_git_checkpoint     = {}", config.resilience.use_git_checkpoint);
            println!("\n[api_keys]");
            println!(
                "  glm_api_key       = {}",
                if config.api_keys.glm_api_key.is_some() { "설정됨" } else { "없음" }
            );
            println!(
                "  deepseek_api_key  = {}",
                if config.api_keys.deepseek_api_key.is_some() { "설정됨" } else { "없음" }
            );
            println!(
                "  openai_api_key    = {}",
                if config.api_keys.openai_api_key.is_some() { "설정됨" } else { "없음" }
            );
            println!(
                "  anthropic_api_key = {}",
                if config.api_keys.anthropic_api_key.is_some() { "설정됨" } else { "없음" }
            );
            println!(
                "  google_api_key    = {}",
                if config.api_keys.google_api_key.is_some() { "설정됨" } else { "없음" }
            );
        }
        (Some(k), None) => {
            println!("설정 {}: {:?}", k, get_config_value(&config, &k));
        }
        (Some(k), Some(v)) => {
            set_config_value(&mut config, &k, &v)?;
            config.save()?;
            println!("설정 변경 완료: {} = {}", k, v);
        }
        _ => unreachable!(),
    }

    Ok(())
}

fn get_config_value(config: &DaacsConfig, key: &str) -> String {
    match key {
        "models.architect" => config.models.architect.clone(),
        "models.backend_developer" => config.models.backend_developer.clone(),
        "models.frontend_developer" => config.models.frontend_developer.clone(),
        "models.devops" => config.models.devops.clone(),
        "models.reviewer" => config.models.reviewer.clone(),
        "models.refactorer" => config.models.refactorer.clone(),
        "models.designer" => config.models.designer.clone(),
        "models.doc_writer" => config.models.doc_writer.clone(),
        "resilience.max_retries" => config.resilience.max_retries.to_string(),
        "resilience.enable_fallback" => config.resilience.enable_fallback.to_string(),
        "resilience.token_limit_strategy" => config.resilience.token_limit_strategy.clone(),
        "resilience.use_git_checkpoint" => config.resilience.use_git_checkpoint.to_string(),
        _ => format!("알 수 없는 키: {}", key),
    }
}

fn set_config_value(config: &mut DaacsConfig, key: &str, value: &str) -> anyhow::Result<()> {
    match key {
        "models.architect" => config.models.architect = value.to_string(),
        "models.backend_developer" => config.models.backend_developer = value.to_string(),
        "models.frontend_developer" => config.models.frontend_developer = value.to_string(),
        "models.devops" => config.models.devops = value.to_string(),
        "models.reviewer" => config.models.reviewer = value.to_string(),
        "models.refactorer" => config.models.refactorer = value.to_string(),
        "models.designer" => config.models.designer = value.to_string(),
        "models.doc_writer" => config.models.doc_writer = value.to_string(),
        "resilience.max_retries" => config.resilience.max_retries = value.parse()?,
        "resilience.enable_fallback" => config.resilience.enable_fallback = value.parse()?,
        "resilience.token_limit_strategy" => {
            config.resilience.token_limit_strategy = value.to_string()
        }
        "resilience.use_git_checkpoint" => config.resilience.use_git_checkpoint = value.parse()?,
        _ => anyhow::bail!("알 수 없는 키: {}", key),
    }
    Ok(())
}

async fn handle_sessions_command(
    action: Option<daacs::cli::args::SessionAction>,
) -> anyhow::Result<()> {
    use daacs::cli::args::SessionAction;

    match action {
        Some(SessionAction::List) | None => {
            println!("세션 체크포인트 목록:\n");

            let checkpoints = daacs::session::list_checkpoints().await?;

            if checkpoints.is_empty() {
                println!("저장된 세션이 없습니다.");
                return Ok(());
            }

            for (i, checkpoint) in checkpoints.iter().enumerate() {
                let modified = checkpoint
                    .modified_at
                    .elapsed()
                    .map(|d| {
                        let secs = d.as_secs();
                        if secs < 60 {
                            format!("{}초 전", secs)
                        } else if secs < 3600 {
                            format!("{}분 전", secs / 60)
                        } else if secs < 86400 {
                            format!("{}시간 전", secs / 3600)
                        } else {
                            format!("{}일 전", secs / 86400)
                        }
                    })
                    .unwrap_or_else(|_| "시간 계산 실패".to_string());

                println!("{}. {} ({})", i + 1, checkpoint.session_id, modified);
                println!("   목표: {}", checkpoint.goal);
                println!("   Phase: {:?}", checkpoint.current_phase);
                println!("   진행: {}/{} tasks", checkpoint.tasks_completed, checkpoint.tasks_total);
                println!();
            }
        }
        Some(SessionAction::Delete { session_id }) => {
            daacs::session::delete_checkpoint(&session_id).await?;
            println!("세션 삭제 완료: {}", session_id);
        }
        Some(SessionAction::Cleanup { days }) => {
            let count = daacs::session::cleanup_old_checkpoints(days).await?;
            println!("{}일 이전 세션 {}개 삭제", days, count);
        }
    }

    Ok(())
}
