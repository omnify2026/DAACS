//! plan.md generate/parse/update helpers.

use anyhow::Result;
use std::path::Path;
use tokio::fs;

use crate::graph::state::{AgentType, Task, TaskStatus};

/// Generate a basic plan.md template from tasks.
pub fn generate_template(tasks: &[Task]) -> String {
    let mut md = String::new();
    md.push_str("# 구현 계획\n\n");

    // Group tasks by phase.
    let mut phases: std::collections::BTreeMap<u32, Vec<&Task>> =
        std::collections::BTreeMap::new();
    for task in tasks {
        phases.entry(task.phase_num).or_default().push(task);
    }

    for (phase_num, phase_tasks) in phases {
        // Generate phase title based on tasks
        let phase_title = generate_phase_title(phase_num, &phase_tasks);
        md.push_str(&format!("## 단계 {}: {}\n\n", phase_num, phase_title));
        md.push_str("| ID | 작업 | 담당 | 상태 |\n");
        md.push_str("|----|------|------|------|\n");

        for task in phase_tasks {
            let status_icon = status_to_str(&task.status);
            let agent_str = agent_to_str(&task.agent);
            md.push_str(&format!(
                "| {} | {} | {} | {} |\n",
                task.id, task.name, agent_str, status_icon
            ));
        }
        md.push('\n');
    }

    md
}

/// Generate phase title based on task content
fn generate_phase_title(phase_num: u32, phase_tasks: &[&Task]) -> String {
    // Analyze tasks to generate meaningful title
    if phase_tasks.is_empty() {
        return format!("Phase {}", phase_num);
    }

    // Common patterns for each phase
    let has_backend = phase_tasks.iter().any(|t| matches!(t.agent, AgentType::BackendDeveloper));
    let has_frontend = phase_tasks.iter().any(|t| matches!(t.agent, AgentType::FrontendDeveloper));
    let has_devops = phase_tasks.iter().any(|t| matches!(t.agent, AgentType::DevOps));
    let has_reviewer = phase_tasks.iter().any(|t| matches!(t.agent, AgentType::Reviewer));

    // Pattern matching for common phases
    match phase_num {
        1 => {
            if has_backend && has_frontend {
                "프로젝트 기반 구조 생성".to_string()
            } else if has_backend {
                "백엔드 프로젝트 구조 생성".to_string()
            } else {
                "프로젝트 초기 설정".to_string()
            }
        },
        2 => {
            if has_backend {
                "백엔드 API 구현".to_string()
            } else {
                "핵심 기능 구현".to_string()
            }
        },
        3 => {
            if has_frontend {
                "프론트엔드 UI 구현".to_string()
            } else {
                "UI/UX 구현".to_string()
            }
        },
        4 => {
            if has_devops {
                "테스트 및 빌드".to_string()
            } else if has_reviewer {
                "코드 리뷰 및 검증".to_string()
            } else {
                "품질 검증".to_string()
            }
        },
        _ => {
            // For phases beyond 4, try to infer from task names
            if has_reviewer {
                "리뷰 및 검증".to_string()
            } else if has_devops {
                "운영 및 배포".to_string()
            } else {
                format!("구현 단계 {}", phase_num)
            }
        }
    }
}

/// Parse plan.md into tasks.
pub async fn parse_file(path: &Path) -> Result<Vec<Task>> {
    let content = fs::read_to_string(path).await?;
    let mut tasks = Vec::new();
    let mut current_phase = 1u32;

    for line in content.lines() {
        if let Some(phase) = parse_phase_number(line) {
            current_phase = phase;
            continue;
        }

        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        if trimmed.contains("---") {
            continue;
        }

        let cols: Vec<String> = trimmed
            .split('|')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        if cols.is_empty() {
            continue;
        }

        // Skip header rows.
        if cols.iter().any(|c| {
            c.eq_ignore_ascii_case("task")
                || c.eq_ignore_ascii_case("id")
                || c.eq_ignore_ascii_case("agent")
        }) {
            continue;
        }

        let (id, name, agent, status) = if cols.len() >= 4 {
            (
                cols[0].clone(),
                cols[1].clone(),
                parse_agent_type(&cols[2]),
                parse_status(&cols[3]),
            )
        } else if cols.len() == 3 {
            (
                format!("{}-{}", current_phase, tasks.len() + 1),
                cols[0].clone(),
                parse_agent_type(&cols[1]),
                parse_status(&cols[2]),
            )
        } else {
            continue;
        };

        if name.is_empty() {
            continue;
        }

        tasks.push(Task {
            id,
            name: name.clone(),
            description: name,
            agent,
            status,
            phase_num: current_phase,
            output: None,
            dependencies: Vec::new(),
        });
    }

    Ok(tasks)
}

/// Update a task status in plan.md.
pub async fn update_task_status(path: &Path, task_id: &str, status: TaskStatus) -> Result<()> {
    let content = fs::read_to_string(path).await?;
    let mut new_lines = Vec::new();

    let status_icon = status_to_str(&status);
    for line in content.lines() {
        if line.contains(&format!("| {} |", task_id)) {
            let parts: Vec<&str> = line.split('|').collect();
            if parts.len() >= 5 {
                let mut new_parts: Vec<String> = parts.iter().map(|s| s.to_string()).collect();
                new_parts[4] = format!(" {} ", status_icon);
                new_lines.push(new_parts.join("|"));
            } else {
                new_lines.push(line.to_string());
            }
        } else {
            new_lines.push(line.to_string());
        }
    }

    fs::write(path, new_lines.join("\n")).await?;
    Ok(())
}

fn status_to_str(status: &TaskStatus) -> &'static str {
    match status {
        TaskStatus::Pending => "TODO",
        TaskStatus::InProgress => "DOING",
        TaskStatus::Completed => "DONE",
        TaskStatus::Failed => "FAIL",
    }
}

fn parse_status(input: &str) -> TaskStatus {
    let s = input.trim().to_lowercase();
    if s.contains("done") || s.contains("complete") {
        TaskStatus::Completed
    } else if s.contains("doing") || s.contains("in progress") {
        TaskStatus::InProgress
    } else if s.contains("fail") || s.contains("failed") {
        TaskStatus::Failed
    } else {
        TaskStatus::Pending
    }
}

fn parse_phase_number(line: &str) -> Option<u32> {
    if !line.trim_start().starts_with("##") {
        return None;
    }
    let tokens: Vec<&str> = line.split_whitespace().collect();
    for (i, token) in tokens.iter().enumerate() {
        let lowered = token.to_lowercase();
        if (lowered == "phase" || token == &"단계") && i + 1 < tokens.len() {
            return tokens[i + 1].trim_end_matches(':').parse::<u32>().ok();
        }
    }
    None
}

fn parse_agent_type(agent_str: &str) -> AgentType {
    match agent_str.trim().to_lowercase().as_str() {
        "backend" | "backenddeveloper" | "developer (backend)" | "백엔드" | "백엔드개발" | "백엔드개발자" => {
            AgentType::BackendDeveloper
        }
        "frontend" | "frontenddeveloper" | "developer (frontend)" | "프론트" | "프론트엔드" | "프론트엔드개발자" => {
            AgentType::FrontendDeveloper
        }
        "devops" | "데브옵스" | "운영" => AgentType::DevOps,
        "reviewer" | "리뷰어" | "검토" => AgentType::Reviewer,
        "qa" | "품질" | "테스트" => AgentType::QA,
        "architect" | "아키텍트" => AgentType::Architect,
        "designer" | "디자이너" | "디자인" => AgentType::Designer,
        _ => AgentType::BackendDeveloper,
    }
}

fn agent_to_str(agent: &AgentType) -> &'static str {
    match agent {
        AgentType::BackendDeveloper => "백엔드",
        AgentType::FrontendDeveloper => "프론트엔드",
        AgentType::DevOps => "DevOps",
        AgentType::Reviewer => "리뷰어",
        AgentType::QA => "QA",
        AgentType::Architect => "아키텍트",
        AgentType::Refactorer => "리팩터링",
        AgentType::Designer => "디자인",
        AgentType::DocWriter => "문서",
    }
}
