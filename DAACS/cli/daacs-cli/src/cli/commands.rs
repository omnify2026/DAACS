//! REPL 슬래시 명령어 처리

use anyhow::{Context, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use indicatif::{ProgressBar, ProgressStyle};
use std::time::Duration;

use crate::clients::cli_client::{rescue_to_model, ModelProvider, SessionBasedCLIClient};
use crate::agents::council::{run_council, synthesize_responses, CouncilConfig};
use crate::config::settings::DaacsConfig;
use crate::ui::prompt::Prompt;
use crate::skills::SkillLoader;
use crate::config::bundles::BundlesConfig;
use crate::config::agents::{AgentsConfig, AgentConfig};
use crate::agents::task_runner::TaskRunner;
use crate::graph::state::AgentType;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandState {
    working_dir: PathBuf,
    active_persona: String,
    #[serde(default)]
    persona_enabled: bool,
    last_context: Option<String>,
    last_model: Option<String>,
    #[serde(default)]
    repl_history: Vec<(String, String)>,
    #[serde(skip)]
    active_bundle: Option<String>,
    #[serde(skip)]
    council_memory: Option<String>,
    #[serde(skip)]
    active_agent_config: Option<AgentConfig>,
}

impl Default for CommandState {
    fn default() -> Self {
        Self {
            working_dir: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            active_persona: "PM".to_string(),
            persona_enabled: false,
            last_context: None,
            last_model: None,
            repl_history: Vec::new(),
            active_bundle: None,
            council_memory: None,
            active_agent_config: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct McpServer {
    name: String,
    endpoint: String,
    connected: bool,
}

static COMMAND_STATE: Lazy<Mutex<CommandState>> =
    Lazy::new(|| Mutex::new(CommandState::default()));

static MCP_SERVERS: Lazy<Mutex<HashMap<String, McpServer>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub async fn handle_command(input: &str) -> Result<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    if !trimmed.starts_with('/') {
        return handle_prompt(trimmed).await;
    }

    let mut parts = trimmed.split_whitespace();
    let cmd = parts.next().unwrap_or("");
    let args: Vec<&str> = parts.collect();

    match cmd {
        "/init" => handle_init(args).await,
        "/auto" => handle_auto(args).await, // [Phase 6] Auto-Pilot
        "/resume" => handle_resume(args).await,
        "/sessions" => handle_sessions(args).await,
        "/model" => handle_model(args).await,
        "/fix" => handle_fix(args).await,
        "/rescue" => handle_rescue(args).await,
        "/design" => handle_design().await,
        "/cd" => handle_cd(args).await,
        "/agent" => handle_agent(args).await,
        "/bundle" => handle_bundle(args).await,
        "/mcp" => handle_mcp(args).await,
        "/status" => handle_status().await,
        "/help" => Ok(build_help()),
        "/exit" | "/quit" => Ok("/exit 으로 REPL을 종료합니다.".to_string()),
        _ => anyhow::bail!("알 수 없는 명령어: {}", cmd),
    }
}

    async fn handle_prompt(input: &str) -> Result<String> {
    let (working_dir, persona, persona_enabled, active_bundle, active_agent) = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        (
            state.working_dir.clone(),
            state.active_persona.clone(),
            state.persona_enabled,
            state.active_bundle.clone(),
            state.active_agent_config.clone(),
        )
    };

    let config = DaacsConfig::load()?;
    let mut model = config.get_architect_model();
    
    // Override model if agent specifies one
    if let Some(agent) = &active_agent {
        if let Some(agent_model) = &agent.model {
            model = config.parse_model_provider(agent_model);
        }
    }

    // Prepare Skill Bundle Paths
    let mut bundle_paths = Vec::new();
    let mut loader = SkillLoader::new(&working_dir);

    // 1. Manually activated /bundle
    if let Some(bundle) = active_bundle {
        if let Ok(paths) = loader.get_bundle_paths(&bundle).await {
            bundle_paths.extend(paths);
        }
    }

    // 2. Agent Auto-loaded skills
    if let Some(agent) = &active_agent {
        for skill in &agent.skills {
            if let Ok(paths) = loader.get_bundle_paths(skill).await {
                bundle_paths.extend(paths);
            }
        }
    }
    
    // Deduplicate paths
    bundle_paths.sort();
    bundle_paths.dedup();

    let prompt = if persona_enabled {
        if let Some(agent) = active_agent.clone() {
            // New Agent System
            format!("{}\n\n[USER REQUEST]:\n{}\n\n한국어로 전문적이고 간결하게 답변하세요.",
                agent.system_prompt,
                input
            )
        } else {
            input.to_string()
        }
    } else {
        input.to_string()
    };
    
    // Inject Council Memory if available (Actionable /fix results)
    let prompt = {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        if let Some(council_mem) = state.council_memory.take() {
            format!("🛑 이전 'Council of AIs' 합의 및 분석 내용 (참고하여 수행):\n{}\n\n위 내용을 바탕으로 다음 사용자 요청을 처리하세요:\n{}", council_mem, prompt)
        } else {
            prompt
        }
    };

    // [Phase 8] Unified Agent Runtime: TaskRunner
    // If an agent is active, we use TaskRunner to execute the request as a Task.
    // If no agent is active (or legacy mode), we fall back to simple chat (SessionBasedCLIClient).
    // For now, let's enable TaskRunner if persona_enabled is true.
    
    if persona_enabled {
        let agent_type = match persona.to_lowercase().as_str() {
            "backend" | "backenddeveloper" => AgentType::BackendDeveloper,
            "frontend" | "frontenddeveloper" => AgentType::FrontendDeveloper,
            "devops" => AgentType::DevOps,
            "reviewer" => AgentType::Reviewer,
            "qa" => AgentType::QA,
            "designer" => AgentType::Designer,
            "docwriter" => AgentType::DocWriter,
            "architect" => AgentType::Architect,
            _ => AgentType::BackendDeveloper, // Default fallback
        };

        let mut runner = TaskRunner::new(working_dir);
        let response = runner.execute_single_shot(&prompt, agent_type.clone()).await
            .with_context(|| "Agent Execution Failed")?;

        // Update History Logic Needed? 
        // TaskRunner doesn't use repl_history like Client.
        // We might need to manually append to history for context?
        // For Phase 8 MVP, we rely on the Runner's internal context management via AgentEngine.
        
        {
            let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
            // Save context for rescue
            let context = format!("페르소나: {:?}\n질문: {}\n응답: {}", agent_type, input, response);
            state.last_context = Some(context);
            state.last_model = Some(format!("{:?}", model));
            let _ = save_state(&state);
        }

        return Ok(response);
    }

    // Fallback: Legacy Chat Mode (No Active Agent or simple chat)
    let client = SessionBasedCLIClient::new(model.clone(), working_dir);
    
    // REPL 히스토리 복사 (Lock 최소화)
    let mut history = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.repl_history.clone()
    };

    // 실행 (Async - Lock 없이 수행)
    // Pass bundle_paths as context_paths to utilize native -p/file loading
    let spinner = ProgressBar::new_spinner();
    spinner.set_style(
        ProgressStyle::default_spinner()
            .tick_chars("⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏")
            .template("{spinner:.green} {msg}")
            .unwrap(),
    );
    spinner.set_message(format!("Thinking ({:?})...", model));
    spinner.enable_steady_tick(Duration::from_millis(100));

    let response_result = client
        .execute_with_history(&prompt, &mut history, &bundle_paths)
        .await;

    spinner.finish_and_clear();

    let response = response_result
        .with_context(|| format!("모델 실행 실패: {:?}", model))?;

    // 상태 업데이트 (다시 Lock)
    {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.repl_history = history;

        // 컨텍스트 저장 (레거시 호환 및 rescue용)
        let context = format!("질문: {}\n응답: {}", input, response);
        state.last_context = Some(context);
        state.last_model = Some(format!("{:?}", model));
        let _ = save_state(&state);
    }

    Ok(response)
}

async fn handle_init(args: Vec<&str>) -> Result<String> {
    let goal = if args.is_empty() {
        Prompt::ask_text("프로젝트 목표를 입력하세요:")
    } else {
        args.join(" ")
    };

    if goal.trim().is_empty() {
        anyhow::bail!("목표를 입력해야 합니다.");
    }

    let project_name = Prompt::ask_text("프로젝트 폴더명 (기본: project):");
    let project_name = if project_name.trim().is_empty() {
        "project"
    } else {
        project_name.trim()
    };

    let base_dir = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.working_dir.clone()
    };

    let project_path = base_dir.join(project_name);
    crate::cli::run::start_new_project(goal, project_path.clone(), false).await?; // auto_mode = false

    Ok(format!("프로젝트 생성 완료: {}", project_path.display()))
}

async fn handle_auto(args: Vec<&str>) -> Result<String> {
    if args.is_empty() {
        anyhow::bail!("사용법: /auto <goal> 또는 /auto resume [id]");
    }

    let sub = args[0];
    if sub.eq_ignore_ascii_case("resume") {
        let session_id = args.get(1).map(|s| s.to_string());
        crate::cli::run::resume_session(session_id, true).await?;
        Ok("🚀 Auto-Pilot 모드로 세션을 재개했습니다.".to_string())
    } else {
        let goal = args.join(" ");
        let base_dir = {
            let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
            state.working_dir.clone()
        };
        let project_name = "auto_project";
        let project_path = base_dir.join(project_name);
        
        println!("🚀 Auto-Pilot 초기화: {}", goal);
        println!("📂 프로젝트 경로: {}", project_path.display());
        
        crate::cli::run::start_new_project(goal, project_path.clone(), true).await?;
        
        Ok(format!("🚀 Auto-Pilot 완료: {}", project_path.display()))
    }
}

async fn handle_resume(args: Vec<&str>) -> Result<String> {
    let session_id = if let Some(id) = args.first() {
        Some(id.to_string())
    } else {
        let input = Prompt::ask_text("복원할 세션 ID (latest 입력 시 최신):");
        let trimmed = input.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };

    crate::cli::run::resume_session(session_id, false).await?; // auto_mode = false
    Ok("세션을 복원했습니다.".to_string())
}

async fn handle_sessions(args: Vec<&str>) -> Result<String> {
    let sub = args.first().map(|s| s.to_lowercase());

    match sub.as_deref() {
        None | Some("list") => list_sessions().await,
        Some("latest") => latest_session().await,
        Some("delete") => {
            let id = args.get(1).map(|s| s.to_string()).unwrap_or_else(|| {
                Prompt::ask_text("삭제할 세션 ID:")
            });
            if id.trim().is_empty() {
                anyhow::bail!("세션 ID가 비어 있습니다.");
            }
            crate::session::delete_checkpoint(id.trim()).await?;
            Ok(format!("세션 삭제 완료: {}", id.trim()))
        }
        Some("cleanup") => {
            let days_str = args.get(1).map(|s| s.to_string()).unwrap_or_else(|| {
                Prompt::ask_text("보존 일수 (기본 30):")
            });
            let days = if days_str.trim().is_empty() {
                30
            } else {
                days_str.trim().parse::<u64>()?
            };
            let count = crate::session::cleanup_old_checkpoints(days).await?;
            Ok(format!("{}일 이전 세션 {}개 삭제", days, count))
        }
        _ => anyhow::bail!("알 수 없는 /sessions 하위 명령입니다."),
    }
}

async fn list_sessions() -> Result<String> {
    let checkpoints = crate::session::list_checkpoints().await?;
    if checkpoints.is_empty() {
        return Ok("저장된 세션이 없습니다.".to_string());
    }

    let mut output = String::new();
    output.push_str("세션 목록:\n\n");
    for (idx, checkpoint) in checkpoints.iter().enumerate() {
        let elapsed = checkpoint
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

        output.push_str(&format!(
            "{}. {} ({})\n   목표: {}\n   Phase: {:?}\n   진행: {}/{} tasks\n\n",
            idx + 1,
            checkpoint.session_id,
            elapsed,
            checkpoint.goal,
            checkpoint.current_phase,
            checkpoint.tasks_completed,
            checkpoint.tasks_total
        ));
    }

    Ok(output)
}

async fn latest_session() -> Result<String> {
    let checkpoints = crate::session::list_checkpoints().await?;
    let latest = checkpoints.first().context("세션이 없습니다.")?;
    Ok(format!("latest 세션: {}", latest.session_id))
}

async fn handle_model(args: Vec<&str>) -> Result<String> {
    let mut config = DaacsConfig::load()?;

    if args.is_empty() {
        return Ok(render_model_config(&config));
    }

    if args.len() == 1 {
        return Ok(render_single_model(&config, args[0]));
    }

    let agent = args[0];
    let model = args[1];

    set_model_value(&mut config, agent, model)?;
    config.save()?;
    crate::config::settings::set(config.clone())?;

    Ok(format!("모델 설정 완료: {} = {}", agent, model))
}

fn render_model_config(config: &DaacsConfig) -> String {
    format!(
        "모델 설정:\n\n\
architect   = {}\n\
backend     = {}\n\
frontend    = {}\n\
devops      = {}\n\
reviewer    = {}\n\
refactorer  = {}\n\
designer    = {}\n\
docwriter   = {}\n",
        config.models.architect,
        config.models.backend_developer,
        config.models.frontend_developer,
        config.models.devops,
        config.models.reviewer,
        config.models.refactorer,
        config.models.designer,
        config.models.doc_writer,
    )
}

fn render_single_model(config: &DaacsConfig, agent: &str) -> String {
    match agent.to_lowercase().as_str() {
        "architect" | "arch" => format!("architect = {}", config.models.architect),
        "backend" | "backend_dev" | "backend_developer" => {
            format!("backend = {}", config.models.backend_developer)
        }
        "frontend" | "frontend_dev" | "frontend_developer" => {
            format!("frontend = {}", config.models.frontend_developer)
        }
        "devops" => format!("devops = {}", config.models.devops),
        "reviewer" => format!("reviewer = {}", config.models.reviewer),
        "refactorer" => format!("refactorer = {}", config.models.refactorer),
        "designer" => format!("designer = {}", config.models.designer),
        "docwriter" | "doc_writer" => format!("docwriter = {}", config.models.doc_writer),
        "all" => render_model_config(config),
        _ => format!("알 수 없는 에이전트: {}", agent),
    }
}

fn set_model_value(config: &mut DaacsConfig, agent: &str, model: &str) -> Result<()> {
    match agent.to_lowercase().as_str() {
        "architect" | "arch" => config.models.architect = model.to_string(),
        "backend" | "backend_dev" | "backend_developer" => {
            config.models.backend_developer = model.to_string();
        }
        "frontend" | "frontend_dev" | "frontend_developer" => {
            config.models.frontend_developer = model.to_string();
        }
        "devops" => config.models.devops = model.to_string(),
        "reviewer" => config.models.reviewer = model.to_string(),
        "refactorer" => config.models.refactorer = model.to_string(),
        "designer" => config.models.designer = model.to_string(),
        "docwriter" | "doc_writer" => config.models.doc_writer = model.to_string(),
        "all" => {
            config.models.architect = model.to_string();
            config.models.backend_developer = model.to_string();
            config.models.frontend_developer = model.to_string();
            config.models.devops = model.to_string();
            config.models.reviewer = model.to_string();
            config.models.refactorer = model.to_string();
            config.models.designer = model.to_string();
            config.models.doc_writer = model.to_string();
        }
        _ => anyhow::bail!("알 수 없는 에이전트: {}", agent),
    }

    Ok(())
}

async fn handle_fix(args: Vec<&str>) -> Result<String> {
    let issue = if args.is_empty() {
        Prompt::ask_text("해결할 문제를 입력하세요 (또는 'check' 입력 시 컴파일 에러 자동수정):")
    } else {
        args.join(" ")
    };

    let final_issue = if issue.trim() == "check" {
        let spinner = ProgressBar::new_spinner();
        spinner.set_style(ProgressStyle::default_spinner().template("{spinner:.red} Running cargo check...").unwrap());
        spinner.enable_steady_tick(Duration::from_millis(100));
        
        let output = tokio::process::Command::new("cargo")
            .arg("check")
            .output()
            .await
            .context("Failed to run cargo check")?;
        
        spinner.finish_and_clear();
        
        if output.status.success() {
            return Ok("✅ cargo check 통과! 해결할 에러가 없습니다.".to_string());
        }
        
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("다음 cargo check 에러를 수정하세요:\n```\n{}\n```", stderr)
    } else {
        issue
    };

    if final_issue.trim().is_empty() {
        anyhow::bail!("문제를 입력해야 합니다.");
    }

    let working_dir = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.working_dir.clone()
    };

    // Spinner for Council
    let spinner = ProgressBar::new_spinner();
    spinner.set_style(ProgressStyle::default_spinner().template("{spinner:.blue} Council is deliberating...").unwrap());
    spinner.enable_steady_tick(Duration::from_millis(100));

    let responses = run_council(&final_issue, CouncilConfig::default(), working_dir).await?;
    let synthesis = synthesize_responses(&responses);
    
    spinner.finish_and_clear();

    // Save to context for next interaction to allow "Apply this"
    {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.council_memory = Some(synthesis.clone());
    }

    Ok(crate::ui::markdown::render_markdown(&synthesis))
}

async fn handle_rescue(args: Vec<&str>) -> Result<String> {
    let model_name = if args.is_empty() {
        Prompt::ask_text("대상 모델 (claude/codex/gemini/glm/deepseek):")
    } else {
        args[0].to_string()
    };

    let (context, working_dir) = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        (state.last_context.clone(), state.working_dir.clone())
    };

    let context = context.context("이전 대화 컨텍스트가 없습니다.")?;
    let config = DaacsConfig::load()?;
    let provider = config.parse_model_provider(model_name.trim());

    let response = rescue_to_model(&context, provider.clone(), working_dir).await?;

    {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.last_context = Some(context);
        state.last_model = Some(format!("{:?}", provider));
        let _ = save_state(&state);
    }

    Ok(response)
}

async fn handle_design() -> Result<String> {
    let (working_dir, persona) = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        (state.working_dir.clone(), state.active_persona.clone())
    };

    let design_path = working_dir.join("DESIGN.md");
    if design_path.exists() {
        let overwrite = Prompt::ask_confirm("DESIGN.md가 이미 있습니다. 덮어쓸까요?");
        if !overwrite {
            return Ok("DESIGN.md 생성을 취소했습니다.".to_string());
        }
    }

    let template = format!(
        "# Design System\n\n## Persona\n- Active: {}\n\n## Colors\n- Primary: #222222\n- Secondary: #f2f2f2\n\n## Typography\n- Heading: Inter\n- Body: Noto Sans KR\n\n## Layout\n- 12-column grid\n- 8px spacing scale\n",
        persona
    );

    tokio::fs::write(&design_path, template)
        .await
        .with_context(|| format!("DESIGN.md 저장 실패: {}", design_path.display()))?;

    Ok(format!("DESIGN.md 생성 완료: {}", design_path.display()))
}

async fn handle_cd(args: Vec<&str>) -> Result<String> {
    let path_input = if args.is_empty() {
        Prompt::ask_text("이동할 경로:")
    } else {
        args[0].to_string()
    };

    if path_input.trim().is_empty() {
        anyhow::bail!("경로를 입력해야 합니다.");
    }

    let new_path = PathBuf::from(path_input.trim());
    std::env::set_current_dir(&new_path)
        .with_context(|| format!("경로 이동 실패: {}", new_path.display()))?;

    {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.working_dir = std::env::current_dir().unwrap_or(new_path.clone());
        let _ = save_state(&state);
    }

    Ok(format!("현재 경로 변경: {}", new_path.display()))
}

async fn handle_agent(args: Vec<&str>) -> Result<String> {
    let config = AgentsConfig::load()?;
    
    if args.is_empty() {
        let mut output = String::new();
        output.push_str("사용 가능한 에이전트 (Agents from .daacs/config/agents.toml):\n\n");
        
        let mut keys: Vec<&String> = config.agents.keys().collect();
        keys.sort();
        
        for key in keys {
            if let Some(agent) = config.agents.get(key) {
                output.push_str(&format!("- {}: {}\n", key, agent.description));
                if let Some(model) = &agent.model {
                    output.push_str(&format!("  └─ Model: {}\n", model));
                }
                if !agent.skills.is_empty() {
                    output.push_str(&format!("  └─ Skills: {:?}\n", agent.skills));
                }
            }
        }
        
        output.push_str("\n사용법: /agent <name> (예: /agent 러스트_전문가)\n");
        output.push_str("해제: /agent off\n");
        return Ok(output);
    }

    let name = args[0].to_string();
    
    if name == "status" {
        return Ok(agent_status());
    }
    
    if name == "off" || name == "none" {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.persona_enabled = false;
        state.active_agent_config = None;
        let _ = save_state(&state);
        return Ok("에이전트 모드를 해제했습니다. (기본 모드)".to_string());
    }

    if let Some(agent) = config.agents.get(&name) {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.active_persona = name.clone();
        state.persona_enabled = true;
        state.active_agent_config = Some(agent.clone());
        
        let _ = save_state(&state); // State persistence might drop complex structs, but that's okay for now
        
        let mut msg = format!("✅ 에이전트 활성화: {}\n{}", name, agent.description);
        if !agent.skills.is_empty() {
            msg.push_str(&format!("\n🛠️ 자동 로드 스킬: {:?}", agent.skills));
        }
        if let Some(model) = &agent.model {
            msg.push_str(&format!("\n🧠 모델 오버라이드: {}", model));
        }
        Ok(msg)
    } else {
        Ok(format!("❌ 알 수 없는 에이전트: {}\n'/agent'를 입력하여 목록을 확인하세요.", name))
    }
}

async fn handle_bundle(args: Vec<&str>) -> Result<String> {
    let sub = args.get(1).map(|s| s.to_lowercase());
    let config = BundlesConfig::load();
    
    // List bundles
    if sub.is_none() || sub.as_deref() == Some("list") {
        let mut output = String::new();
        output.push_str("사용 가능한 스킬 번들 (Skill Bundles - Configurable):\n\n");
        
        // Sort keys for stable output
        let mut keys: Vec<&String> = config.bundles.keys().collect();
        keys.sort();

        for key in keys {
            if let Some(def) = config.bundles.get(key) {
                output.push_str(&format!("- {}: {}\n", key, def.description));
            }
        }
        
        output.push_str("\n사용법: /bundle <name> (예: /bundle web-wizard)\n");
        output.push_str("해제: /bundle off\n");
        output.push_str("설정 파일: .daacs/config/bundles.toml\n");
        return Ok(output);
    }

    let sub_str = sub.as_deref().unwrap();

    // Clear bundle
    if sub_str == "off" || sub_str == "clear" || sub_str == "none" {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.active_bundle = None;
        return Ok("✅ 스킬 번들 해제됨".to_string());
    }

    // Check if bundle exists in config
    if let Some(def) = config.bundles.get(sub_str) {
        let mut state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        state.active_bundle = Some(sub_str.to_string());
        
        Ok(format!("✅ 스킬 번들 활성화: {}\n프롬프트에 '{}' 스킬들이 자동으로 포함됩니다.", 
            sub_str, def.description))
    } else {
        Ok(format!("❌ 알 수 없는 번들 이름: {}\n사용 가능한 목록: /bundle list", sub_str))
    }
}



fn agent_status() -> String {
    let (working_dir, persona, persona_enabled, active_agent) = {
        let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
        (
            state.working_dir.clone(),
            state.active_persona.clone(),
            state.persona_enabled,
            state.active_agent_config.clone(),
        )
    };

    let mut output = String::new();
    output.push_str("🤖 에이전트 시스템 상태:\n\n");
    output.push_str(&format!("- 작업 디렉터리: {}\n", working_dir.display()));
    
    if persona_enabled {
        output.push_str(&format!("- 활성 에이전트: {} (ON)\n", persona));
        if let Some(agent) = active_agent {
            output.push_str(&format!("  └─ 설명: {}\n", agent.description));
            if let Some(model) = agent.model {
                output.push_str(&format!("  └─ 🧠 모델: {}\n", model));
            } else {
                output.push_str("  └─ 🧠 모델: 기본값 (Architect)\n");
            }
            if !agent.skills.is_empty() {
                output.push_str(&format!("  └─ 🛠️ 스킬: {:?}\n", agent.skills));
            }
        }
    } else {
        output.push_str("- 활성 에이전트: 없음 (기본 모드)\n");
    }

    let sessions = read_agent_sessions(&working_dir);
    if sessions.is_empty() {
        output.push_str("- 세션 히스토리: 없음\n");
    } else {
        output.push_str("- 세션 히스토리: 저장됨 (persistent_session)\n");
        for (agent, is_active) in sessions {
            output.push_str(&format!("  └─ {}: {}\n", agent, if is_active { "Active" } else { "Inactive" }));
        }
    }
    
    let memory_dir = working_dir.join(".daacs").join("memory");
    if memory_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&memory_dir) {
            let mut files = Vec::new();
            for entry in entries.flatten() {
                if let Some(name) = entry.path().file_name().and_then(|s| s.to_str()) {
                    files.push(name.to_string());
                }
            }
            if files.is_empty() {
                output.push_str("- 메모리: 없음\n");
            } else {
                output.push_str(&format!("- 메모리: {}개 파일\n", files.len()));
            }
        }
    } else {
        output.push_str("- 메모리: 없음\n");
    }

    output
}

async fn handle_mcp(args: Vec<&str>) -> Result<String> {
    let sub = args.first().map(|s| s.to_lowercase());
    match sub.as_deref() {
        None | Some("list") => list_mcp_servers(),
        Some("connect") => connect_mcp(args).await,
        Some("disconnect") => disconnect_mcp(args).await,
        _ => anyhow::bail!("/mcp는 list|connect|disconnect 중 하나여야 합니다."),
    }
}

fn list_mcp_servers() -> Result<String> {
    let servers = MCP_SERVERS.lock().expect("MCP_SERVERS lock");
    if servers.is_empty() {
        return Ok("연결된 MCP 서버가 없습니다.".to_string());
    }

    let mut output = String::new();
    output.push_str("MCP 서버 목록:\n\n");
    for server in servers.values() {
        output.push_str(&format!(
            "- {} ({}) [{}]\n",
            server.name,
            server.endpoint,
            if server.connected { "connected" } else { "disconnected" }
        ));
    }
    Ok(output)
}

async fn connect_mcp(args: Vec<&str>) -> Result<String> {
    let name = args.get(1).map(|s| s.to_string()).unwrap_or_else(|| {
        Prompt::ask_text("MCP 서버 이름:")
    });
    let endpoint = args.get(2).map(|s| s.to_string()).unwrap_or_else(|| {
        Prompt::ask_text("MCP 엔드포인트:")
    });

    if name.trim().is_empty() || endpoint.trim().is_empty() {
        anyhow::bail!("서버 이름과 엔드포인트를 입력해야 합니다.");
    }

    let mut servers = MCP_SERVERS.lock().expect("MCP_SERVERS lock");
    servers.insert(
        name.trim().to_string(),
        McpServer {
            name: name.trim().to_string(),
            endpoint: endpoint.trim().to_string(),
            connected: true,
        },
    );

    Ok(format!("MCP 서버 연결: {}", name.trim()))
}

async fn disconnect_mcp(args: Vec<&str>) -> Result<String> {
    let name = args.get(1).map(|s| s.to_string()).unwrap_or_else(|| {
        Prompt::ask_text("연결 해제할 MCP 서버 이름:")
    });
    let name = name.trim();
    if name.is_empty() {
        anyhow::bail!("서버 이름이 비어 있습니다.");
    }

    let mut servers = MCP_SERVERS.lock().expect("MCP_SERVERS lock");
    if let Some(server) = servers.get_mut(name) {
        server.connected = false;
        return Ok(format!("MCP 서버 연결 해제: {}", name));
    }

    anyhow::bail!("알 수 없는 MCP 서버: {}", name)
}

async fn handle_status() -> Result<String> {
    let state = COMMAND_STATE.lock().expect("COMMAND_STATE lock");
    let config = DaacsConfig::load()?;

    let mut output = String::new();
    output.push_str("현재 상태:\n\n");
    output.push_str(&format!("- 작업 디렉터리: {}\n", state.working_dir.display()));
    if state.persona_enabled {
        output.push_str(&format!("- 페르소나: {} (활성)\n", state.active_persona));
    } else {
        output.push_str("- 페르소나: 비활성\n");
    }
    if let Some(bundle) = &state.active_bundle {
        output.push_str(&format!("- Active Bundle: {}\n", bundle));
    } else {
        output.push_str("- Active Bundle: 없음\n");
    }
    output.push_str(&format!("- 기본 모델(architect): {}\n", config.models.architect));
    let provider: ModelProvider = config.parse_model_provider(&config.models.architect);
    output.push_str(&format!("- 인식된 모델 공급자: {:?}\n", provider));
    if let Some(model) = &state.last_model {
        output.push_str(&format!("- 마지막 모델: {}\n", model));
    }
    if state.last_context.is_some() {
        output.push_str("- 마지막 컨텍스트: 있음\n");
    } else {
        output.push_str("- 마지막 컨텍스트: 없음\n");
    }
    Ok(output)
}

fn build_help() -> String {
    let mut output = String::new();
    output.push_str("DAACS CLI 슬래시 명령어\n\n");
    output.push_str("/init [goal]              새 프로젝트 생성\n");
    output.push_str("/resume [id]              세션 복원 (latest 가능)\n");
    output.push_str("/sessions [list]          세션 목록/관리\n");
    output.push_str("/sessions delete <id>     세션 삭제\n");
    output.push_str("/sessions cleanup <days>  오래된 세션 정리\n");
    output.push_str("/sessions latest          최신 세션 ID\n");
    output.push_str("/model [agent] [model]    모델 조회/설정\n");
    output.push_str("/fix <문제>               Council 합의로 해결안 도출\n");
    output.push_str("/rescue <model>           다른 모델로 이어서 실행\n");
    output.push_str("/design                   DESIGN.md 생성\n");
    output.push_str("/cd <경로>                 작업 경로 변경\n");
    output.push_str("/agent <name>             페르소나 설정\n");
    output.push_str("/agent off                페르소나 해제\n");
    output.push_str("/agent status             에이전트 상태 확인\n");
    output.push_str("/bundle <name>            스킬 번들 설정 (list/off)\n");
    output.push_str("/mcp <cmd>                MCP 서버 관리(list/connect/disconnect)\n");
    output.push_str("/status                   현재 상태 표시\n");
    output.push_str("/help                     도움말\n");
    output.push_str("/exit                     종료\n\n");
    output.push_str("/agent 사용 가능한 에이전트 (from agents.toml):\n");
    if let Ok(config) = AgentsConfig::load() {
        for (name, agent) in config.agents {
            output.push_str(&format!("- {}: {}\n", name, agent.description));
        }
    } else {
        output.push_str("(설정 파일 로드 실패)\n");
    }
    
    // Dynamic Active Bundle Info
    if let Ok(guard) = COMMAND_STATE.lock() {
        if let Some(bundle) = &guard.active_bundle {
            output.push_str(&format!("\n✅ 현재 활성 번들: {}\n", bundle));
        }
    }
    
    output
}

fn state_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".daacs").join("repl_state.json"))
}

fn load_state() -> Option<CommandState> {
    let path = state_path()?;
    let content = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_state(state: &CommandState) -> Result<()> {
    let path = state_path().context("상태 저장 경로를 찾을 수 없습니다.")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("상태 디렉터리 생성 실패: {}", parent.display()))?;
    }
    let content = serde_json::to_string_pretty(state)?;
    std::fs::write(&path, content).with_context(|| format!("상태 저장 실패: {}", path.display()))?;
    Ok(())
}

fn read_agent_sessions(working_dir: &Path) -> HashMap<String, bool> {
    let sessions_path = working_dir.join(".daacs").join("agent_sessions.json");
    let content = match std::fs::read_to_string(&sessions_path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(),
    };

    let json: Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };

    let mut sessions = HashMap::new();
    if let Some(obj) = json.get("sessions").and_then(|v| v.as_object()) {
        for (k, v) in obj {
            if let Some(flag) = v.as_bool() {
                sessions.insert(k.to_string(), flag);
            }
        }
    }

    sessions
}
