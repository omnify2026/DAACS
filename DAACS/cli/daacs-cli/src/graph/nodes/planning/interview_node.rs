//! 인터뷰 노드 (LLM 기반, 실패 시 폴백 질문)

use anyhow::Result;
use std::collections::HashMap;

use crate::agents::agent_runtime::AgentRuntime;
use crate::graph::state::{CLIState, InterviewTurn};
use crate::graph::workflow::{Node, NodeResult};
use crate::ui::console::Console;
use crate::ui::prompt::Prompt;

pub struct InterviewNode;

const MAX_INTERVIEW_ROUNDS: usize = 8;
const INTERVIEW_COMPLETE_KEYWORDS: [&str; 5] = [
    "[INTERVIEW_COMPLETE]",
    "interview complete",
    "enough information",
    "인터뷰 완료",
    "정보 충분",
];

#[async_trait::async_trait]
impl Node for InterviewNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        let console = Console::new();
        console.print_panel("인터뷰 시작", "Phase 1: 인터뷰", "LLM 기반");

        let config = crate::config::settings::get();
        let model = config.get_architect_model();
        let mut runtime = AgentRuntime::new(&state.project_path);
        let client = runtime.client(model, "architect");

        if state.goal.is_empty() {
            let goal = Prompt::ask_text("무엇을 만들고 싶나요?");
            state.goal = goal;
        }
        console.print_info(&format!("목표: {}", state.goal));

        let system_prompt = create_interview_system_prompt();
        let mut conversation_context = format!(
            "{}\n\n사용자 목표: {}\n\n첫 질문을 시작하세요.",
            system_prompt, state.goal
        );

        let mut round = 0usize;
        loop {
            round += 1;
            if round > MAX_INTERVIEW_ROUNDS {
                console.print_warning("최대 인터뷰 라운드에 도달했습니다. 다음 단계로 진행합니다.");
                break;
            }

            let llm_response = match client.execute(&conversation_context).await {
                Ok(response) => response,
                Err(e) => {
                    console.print_warning(&format!(
                        "LLM 응답 실패: {}. 폴백 질문 모드로 전환합니다.",
                        e
                    ));
                    return execute_fallback_interview(state, &console).await;
                }
            };

            if is_interview_complete(&llm_response) {
                console.print_success("인터뷰 완료.");
                state.interview_history.push(InterviewTurn {
                    role: "assistant".to_string(),
                    content: llm_response.clone(),
                });
                state
                    .interview_context
                    .insert("summary".to_string(), llm_response.clone());
                state.interview_context.insert(
                    "history".to_string(),
                    summarize_history(&state.interview_history),
                );
                break;
            }

            println!();
            println!();
            console.print_info(&format!("[Q{}]", round));
            println!("{}", llm_response);

            state.interview_history.push(InterviewTurn {
                role: "assistant".to_string(),
                content: llm_response.clone(),
            });

            let user_answer = Prompt::ask_text("답변");
            if user_answer.eq_ignore_ascii_case("/done")
                || user_answer.eq_ignore_ascii_case("/skip")
            {
                console.print_info("인터뷰를 조기 종료합니다.");
                break;
            }

            state.interview_history.push(InterviewTurn {
                role: "user".to_string(),
                content: user_answer.clone(),
            });

            conversation_context = format!(
                "사용자 목표: {}\n\n대화 기록:\n{}\n\n사용자 답변: {}\n\n다음 질문을 하세요. 정보가 충분하면 [INTERVIEW_COMPLETE]와 요약을 출력하세요.",
                state.goal,
                summarize_history(&state.interview_history),
                user_answer
            );
        }

        if state.interview_context.is_empty() {
            state
                .interview_context
                .insert("summary".to_string(), "요약 없음".to_string());
            state.interview_context.insert(
                "history".to_string(),
                summarize_history(&state.interview_history),
            );
        }

        // Extract tech stack from interview context
        extract_tech_stack_from_context(state);

        console.print_success(&format!(
            "컨텍스트 {}건 수집 완료",
            state.interview_context.len()
        ));
        for (key, value) in &state.interview_context {
            console.print_info(&format!("  {}: {}", key, value));
        }

        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "InterviewNode"
    }
}

fn create_interview_system_prompt() -> String {
    r#"당신은 소프트웨어 프로젝트의 요구사항을 철저히 수집하는 전문 인터뷰어입니다.

다음 핵심 정보들을 빠짐없이 수집하세요. 한 번에 1~2개의 명확한 질문을 하세요:

**필수 수집 항목:**
1. 기술 스택
   - 선호하는 프로그래밍 언어(Python, JavaScript, Rust, Go 등)
   - 백엔드 프레임워크(FastAPI, Express, Django, Spring 등)
   - 프론트엔드 프레임워크(React, Vue, Svelte 등)
   - 데이터베이스(PostgreSQL, MySQL, MongoDB, SQLite 등)

2. 플랫폼 & 환경
   - 대상 플랫폼(웹, 모바일, 데스크톱, CLI, API)
   - 배포 환경(로컬, 클라우드, 컨테이너)
   - 운영체제 요구사항

3. 디자인 & UI/UX
   - 디자인 스타일(미니멀, 모던, 캐주얼, 포멀, 다크모드 등)
   - 주요 색상 테마
   - UI 컴포넌트 라이브러리 선호도

4. 핵심 기능
   - 주요 기능 목록
   - 인증/권한 필요 여부
   - 파일 업로드/다운로드 필요 여부
   - 실시간 기능 필요 여부(WebSocket, SSE 등)

5. 데이터 & 비즈니스 로직
   - 예상 데이터 규모
   - 주요 데이터 모델
   - 복잡한 비즈니스 로직 여부

6. 비기능 요구사항
   - 예상 동시 사용자 수
   - 성능 요구사항
   - 보안 요구사항
   - 국제화(i18n) 필요 여부

**진행 방식:**
- 먼저 기술 스택과 플랫폼부터 물어보세요
- 사용자 답변에 따라 관련된 심화 질문을 하세요
- 모호한 답변은 구체화하세요
- 5-7개 질문 후, 정보가 충분하면 종료하세요

**종료 조건:**
정보가 충분히 수집되면 다음 형식으로 종료:
[INTERVIEW_COMPLETE]
요약: <수집된 정보 요약>
"#
    .to_string()
}

fn is_interview_complete(response: &str) -> bool {
    INTERVIEW_COMPLETE_KEYWORDS
        .iter()
        .any(|kw| response.to_lowercase().contains(&kw.to_lowercase()))
}

fn extract_question(response: &str) -> String {
    for line in response.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with('[') {
            return trimmed.to_string();
        }
    }
    response.lines().next().unwrap_or(response).to_string()
}

fn summarize_history(history: &[InterviewTurn]) -> String {
    history
        .iter()
        .map(|turn| format!("{}: {}", turn.role, turn.content))
        .collect::<Vec<_>>()
        .join("\n")
}

async fn execute_fallback_interview(
    state: &mut CLIState,
    console: &Console,
) -> Result<NodeResult> {
    console.print_warning("폴백 인터뷰 모드로 진행합니다.");
    let mut context = HashMap::new();

    // 1. 플랫폼
    let platform = Prompt::ask_select(
        "대상 플랫폼은 무엇인가요?",
        vec!["웹", "모바일", "데스크톱", "CLI", "API"],
    );
    context.insert("platform".to_string(), platform.clone());
    add_interview_turn(state, "대상 플랫폼은 무엇인가요?", &platform);

    // 2. 백엔드 언어/프레임워크
    let backend_lang = Prompt::ask_select(
        "백엔드 언어/프레임워크는?",
        vec!["Python (FastAPI)", "Python (Django)", "Node.js (Express)", "Rust (Axum)", "Go (Gin)", "Java (Spring)", "기타"],
    );
    context.insert("backend".to_string(), backend_lang.clone());
    add_interview_turn(state, "백엔드 언어/프레임워크는?", &backend_lang);

    // 3. 프론트엔드 (웹인 경우만)
    if platform.contains("웹") {
        let frontend = Prompt::ask_select(
            "프론트엔드 프레임워크는?",
            vec!["React", "Vue", "Svelte", "Next.js", "바닐라 JS", "기타"],
        );
        context.insert("frontend".to_string(), frontend.clone());
        add_interview_turn(state, "프론트엔드 프레임워크는?", &frontend);
    }

    // 4. 데이터베이스
    let database = Prompt::ask_select(
        "데이터베이스는 무엇을 사용하나요?",
        vec!["PostgreSQL", "MySQL", "SQLite", "MongoDB", "Redis", "없음"],
    );
    context.insert("database".to_string(), database.clone());
    add_interview_turn(state, "데이터베이스는?", &database);

    // 5. 인증/권한
    let auth = Prompt::ask_select(
        "사용자 인증이 필요한가요?",
        vec!["필요 (JWT)", "필요 (세션)", "필요 (OAuth)", "불필요"],
    );
    context.insert("auth".to_string(), auth.clone());
    add_interview_turn(state, "사용자 인증이 필요한가요?", &auth);

    // 6. 디자인 스타일
    let design_style = Prompt::ask_text("디자인 스타일은? (예: 미니멀, 모던, 다크모드, 캐주얼, 포멀)");
    context.insert("design_style".to_string(), design_style.clone());
    add_interview_turn(state, "디자인 스타일은?", &design_style);

    // 7. 색상 테마 (선택)
    let color_theme = Prompt::ask_text("선호하는 색상 테마가 있나요? (없으면 enter)");
    if !color_theme.trim().is_empty() {
        context.insert("color_theme".to_string(), color_theme.clone());
        add_interview_turn(state, "색상 테마는?", &color_theme);
    }

    // 8. 핵심 기능
    let features_str = Prompt::ask_text("핵심 기능을 콤마(,)로 구분해 입력하세요.");
    state.features = features_str
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    context.insert("features".to_string(), features_str.clone());
    add_interview_turn(state, "핵심 기능은?", &features_str);

    // 9. 파일 처리
    let file_upload = Prompt::ask_select(
        "파일 업로드/다운로드가 필요한가요?",
        vec!["필요", "불필요"],
    );
    context.insert("file_upload".to_string(), file_upload.clone());
    add_interview_turn(state, "파일 처리가 필요한가요?", &file_upload);

    // 10. 배포 환경
    let deployment = Prompt::ask_select(
        "배포 환경은?",
        vec!["로컬 개발", "클라우드 (AWS/GCP/Azure)", "컨테이너 (Docker)", "기타"],
    );
    context.insert("deployment".to_string(), deployment.clone());
    add_interview_turn(state, "배포 환경은?", &deployment);

    // 11. 프로젝트 규모
    let scale = Prompt::ask_select(
        "프로젝트 규모는?",
        vec!["프로토타입", "MVP", "프로덕션"],
    );
    context.insert("scale".to_string(), scale.clone());
    add_interview_turn(state, "프로젝트 규모는?", &scale);

    state.interview_context = context;

    // Extract tech stack from collected context
    extract_tech_stack_from_context(state);

    console.print_success("인터뷰 완료.");

    Ok(NodeResult::Success)
}

fn add_interview_turn(state: &mut CLIState, question: &str, answer: &str) {
    state.interview_history.push(InterviewTurn {
        role: "assistant".to_string(),
        content: question.to_string(),
    });
    state.interview_history.push(InterviewTurn {
        role: "user".to_string(),
        content: answer.to_string(),
    });
}

fn extract_tech_stack_from_context(state: &mut CLIState) {
    let mut tech_stack = HashMap::new();

    // Extract backend
    if let Some(backend) = state.interview_context.get("backend") {
        tech_stack.insert("Backend".to_string(), backend.clone());
    }

    // Extract frontend
    if let Some(frontend) = state.interview_context.get("frontend") {
        tech_stack.insert("Frontend".to_string(), frontend.clone());
    }

    // Extract database
    if let Some(database) = state.interview_context.get("database") {
        tech_stack.insert("Database".to_string(), database.clone());
    }

    // Extract platform
    if let Some(platform) = state.interview_context.get("platform") {
        tech_stack.insert("Platform".to_string(), platform.clone());
    }

    // Extract auth
    if let Some(auth) = state.interview_context.get("auth") {
        tech_stack.insert("Authentication".to_string(), auth.clone());
    }

    // Extract deployment
    if let Some(deployment) = state.interview_context.get("deployment") {
        tech_stack.insert("Deployment".to_string(), deployment.clone());
    }

    // Parse from history if LLM-based interview
    if tech_stack.is_empty() {
        // Try to extract from history using keywords
        let history_text = summarize_history(&state.interview_history).to_lowercase();

        if history_text.contains("fastapi") || history_text.contains("django") {
            tech_stack.insert("Backend".to_string(), "Python".to_string());
        } else if history_text.contains("express") || history_text.contains("node") {
            tech_stack.insert("Backend".to_string(), "Node.js".to_string());
        } else if history_text.contains("rust") || history_text.contains("axum") {
            tech_stack.insert("Backend".to_string(), "Rust".to_string());
        }

        if history_text.contains("react") {
            tech_stack.insert("Frontend".to_string(), "React".to_string());
        } else if history_text.contains("vue") {
            tech_stack.insert("Frontend".to_string(), "Vue".to_string());
        } else if history_text.contains("svelte") {
            tech_stack.insert("Frontend".to_string(), "Svelte".to_string());
        }

        if history_text.contains("postgres") {
            tech_stack.insert("Database".to_string(), "PostgreSQL".to_string());
        } else if history_text.contains("mysql") {
            tech_stack.insert("Database".to_string(), "MySQL".to_string());
        } else if history_text.contains("sqlite") {
            tech_stack.insert("Database".to_string(), "SQLite".to_string());
        } else if history_text.contains("mongodb") {
            tech_stack.insert("Database".to_string(), "MongoDB".to_string());
        }
    }

    state.tech_stack = tech_stack;
}
