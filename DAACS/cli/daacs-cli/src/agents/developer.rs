//! 개발자 에이전트 (백엔드/프론트엔드)

use anyhow::{Context, Result};

use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};
use crate::context::smart_context::StateWindow;
use crate::graph::state::Task;

/// ??? ??
#[derive(Debug, Clone, Copy)]
pub enum DeveloperType {
    Backend,
    Frontend,
}

use crate::clients::persistent_session::PersistentSessionClient;
use crate::tui::dashboard::events::AgentEvent;
use flume::Sender;

/// 개발자 에이전트
pub struct DeveloperAgent {
    client: SessionBasedCLIClient,
    dev_type: DeveloperType,
    history: tokio::sync::Mutex<Vec<(String, String)>>,
    persistent_session: tokio::sync::Mutex<Option<PersistentSessionClient>>,
    event_sender: Option<Sender<AgentEvent>>,
}

impl DeveloperAgent {
    /// 새 에이전트 생성
    pub fn new(model: ModelProvider, working_dir: std::path::PathBuf, dev_type: DeveloperType) -> Self {
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self {
            client,
            dev_type,
            history: tokio::sync::Mutex::new(Vec::new()),
            persistent_session: tokio::sync::Mutex::new(None),
            event_sender: None,
        }
    }

    /// 기존 클라이언트로 에이전트 생성
    pub fn with_client(client: SessionBasedCLIClient, dev_type: DeveloperType) -> Self {
        Self {
            client,
            dev_type,
            history: tokio::sync::Mutex::new(Vec::new()),
            persistent_session: tokio::sync::Mutex::new(None),
            event_sender: None,
        }
    }

    /// Persistent Session 시작
    pub async fn start_session(&self, system_context: &str) -> Result<()> {
        let model = self.client.provider.clone();
        
        // CLI 모델인지 확인 (Claude, Gemini, Codex)
        let is_cli = matches!(model, ModelProvider::Claude | ModelProvider::Gemini | ModelProvider::Codex);
        
        if is_cli {
            let mut session = PersistentSessionClient::new(
                model.clone(),
                self.client.working_dir.clone(),
            );
            
            crate::logger::status_update("🚀 Persistent Session 시작 중...");
            session.start(system_context).await?;
            crate::logger::status_update("✅ Persistent Session 시작 완료");
            
            let mut session_guard = self.persistent_session.lock().await;
            *session_guard = Some(session);
        }
        
        Ok(())
    }

    /// Persistent Session 종료
    pub async fn stop_session(&self) {
        let mut session_guard = self.persistent_session.lock().await;
        if let Some(mut session) = session_guard.take() {
            if let Err(e) = session.stop().await {
                crate::logger::log_warning(&format!("Session 종료 실패: {}", e));
            } else {
                crate::logger::status_update("✅ Persistent Session 종료됨");
            }
        }
    }

    /// 세션 초기화 (DAACS.md 스펙 주입)
    /// Persistent Session이 있으면 이미 start_session에서 처리되었으므로 무시
    pub async fn init_session(&self, daacs_content: &str) {
        // 이미 Persistent Session이 있다면 init_session은 필요 없음
        if self.persistent_session.lock().await.is_some() {
            return;
        }

        let role = match self.dev_type {
            DeveloperType::Backend => "백엔드 개발자",
            DeveloperType::Frontend => "프론트엔드 개발자",
        };

        let system_prompt = format!(
            r#"당신은 숙련된 {role}입니다.

[기술 명세서 (DAACS.md)]
{spec}

이 명세서를 바탕으로 프로젝트를 구현해야 합니다.
앞으로 제가 구체적인 작업을 하나씩 지시할 것입니다.
한 번에 모든 것을 구현하지 말고, **지시받은 작업(Task)에 대해서만** 코드를 작성하세요.
"#,
            role = role,
            spec = daacs_content
        );

        let mut history = self.history.lock().await;
        history.push(("system".to_string(), system_prompt));
    }

    /// 작업 실행
    pub async fn execute_task(
        &self,
        task: &Task,
        _daacs_content: &str,
        context: Option<&StateWindow>,
        extra_context: Option<&str>,
        feedback: Option<&str>, // Feedback from reviewer
        design_context: Option<&str>, // Design system tokens
        skills_context: Option<&str>, // Skills from .daacs/skills/
        file_context: Option<&str>, // Existing files context for diff mode
        active_skill: Option<&str>, // [NEW] Validated Skill Name for Slash Command
    ) -> Result<String> {
        let mut prompt = self.build_task_prompt(task, context, extra_context, feedback, design_context, skills_context, file_context);

        // [Slash Command Support for Claude]
        if let Some(skill_name) = active_skill {
            if matches!(self.client.provider, ModelProvider::Claude) {
                crate::logger::status_update(&format!("⚡ Using Slash Command: /{}", skill_name));
                prompt = format!("/{} {}", skill_name, prompt);
            }
        }

        let dev_type_str = match self.dev_type {
            DeveloperType::Backend => "백엔드",
            DeveloperType::Frontend => "프론트엔드",
        };

        crate::logger::status_update(&format!("{} 개발자: {} 작업 중...", dev_type_str, task.name));
        
        if let Some(sender) = &self.event_sender {
            let _ = sender.send(AgentEvent::StatusChange {
                agent: dev_type_str.to_string(),
                status: format!("작업 중: {}", task.name),
                is_active: true,
            });
        }
        
        // [LOG] Log prompt summary (Clean)
        crate::logger::status_update(&format!("📤  Sending Prompt to {:?}...", self.client.provider));

        if feedback.is_some() {
            crate::logger::status_update("  (Refining based on feedback...)");
        }

        // Persistent Session 확인
        let mut session_guard = self.persistent_session.lock().await;
        
        let response = if let Some(session) = session_guard.as_mut() {
            // Persistent Session 사용
            let resp = session.send(&prompt).await.context("Persistent Session 실행 실패")?;
            
            // [LOG] Log response summary (Clean)
            crate::logger::status_update(&format!("📥  Received Response ({} chars)", resp.len()));
            
            resp
        } else {
             // ... One-Shot ...
            let mut history = self.history.lock().await;
            let resp = self.client
                .execute_with_history(&prompt, &mut history, &[])
                .await
                .context(format!("{} 개발자 실행 실패", dev_type_str))?;
                
            crate::logger::status_update(&format!("📥  Received Response (One-Shot, {} chars)", resp.len()));
            resp
        };

        if let Some(sender) = &self.event_sender {
            let _ = sender.send(AgentEvent::StatusChange {
                agent: dev_type_str.to_string(),
                status: "유휴 (Idle)".to_string(),
                is_active: false,
            });
        }

        if response.trim().len() < 10 {
            crate::logger::log_warning(&format!("⚠️  Response too short ({} chars). Retrying/Failing...", response.len()));
            crate::logger::log_debug(&format!("Raw Response: {:?}", response));
            anyhow::bail!("Model returned empty or invalid response (Length: {})", response.len());
        }

        crate::logger::task_complete(&format!("{}: {} 완료", dev_type_str, task.name));

        Ok(response)
    }

    /// 작업 프롬프트 생성
    fn build_task_prompt(
        &self,
        task: &Task,
        context: Option<&StateWindow>,
        extra_context: Option<&str>,
        feedback: Option<&str>,
        design_context: Option<&str>,
        skills_context: Option<&str>,
        file_context: Option<&str>,
    ) -> String {
        let mut prompt = format!(
            r#"
[현재 작업]
ID: {id}
이름: {name}
설명: {desc}

**지시사항:**
1. 위 작업 설명에 해당하는 코드만 작성하세요.
2. 미래의 작업이나 명세서의 다른 부분은 구현하지 마세요.
"#,
            id = task.id,
            name = task.name,
            desc = task.description
        );

        // 기존 파일이 있으면 diff 모드
        if let Some(fc) = file_context {
            prompt.push_str(&format!(r#"
{}

**중요: 파일 수정 방식**
- 기존 파일을 수정할 때는 전체 파일을 다시 작성하지 마세요.
- 대신 unified diff 형식으로 변경점만 출력하세요:
```diff
--- a/path/to/file
+++ b/path/to/file
@@ -시작라인,줄수 +시작라인,줄수 @@
 컨텍스트 라인
-삭제할 라인
+추가할 라인
```
- 새 파일만 `### File:` 형식으로 작성하세요.
"#, fc));
        } else {
            prompt.push_str("\n3. 파일 블록(### File: ...) 형식으로 출력하세요.\n");
        }

        if let Some(skills) = skills_context {
            prompt.push_str(&format!("\n{}\n", skills));
        }

        if let Some(design) = design_context {
            prompt.push_str(&format!("\n[디자인 시스템 & 스타일 가이드]\n{}\n", design));
        }

        if let Some(fb) = feedback {
            prompt.push_str(&format!("\n[수정 요청사항 (Reviewer Feedback)]\n{}\n\n위 피드백을 반영하여 코드를 수정하세요.\n", fb));
        }

        if let Some(ctx) = context {
            prompt.push_str(&format!("\n[관련 파일 컨텍스트]\n{}\n", ctx.to_prompt_context()));
        }
        if let Some(extra) = extra_context {
            prompt.push_str(&format!("\n[추가 컨텍스트]\n{}\n", extra));
        }

        // Tech stack should be derived from DAACS.md (system prompt), not hardcoded here.
        // match self.dev_type { ... } removed to prevent hallucinations.

        // [Global Language Enforcement]
        prompt.push_str("\n**[출력 언어 제한]**\n모든 생각(Thinking)과 답변, 주석은 **반드시 한국어(Korean)**로 작성하세요. 영어로 된 자료를 분석하더라도 출력은 한국어야 합니다.\n");

        prompt
    }

    /// LLM ???? ?? ??? ??? ??
    pub fn contains_file_blocks(response: &str) -> bool {
        response.contains("### File:")
            || response.contains("### 파일:")
            || response.contains("### 파일:")
            || response.contains("### File ")
    }

    /// ?? ??? ??? ?? (???)
    pub async fn extract_and_save_files(
        &self,
        response: &str,
        base_path: &std::path::Path,
    ) -> Result<Vec<String>> {
        let files = parse_file_blocks(response);
        let mut created_files = Vec::new();

        for (file_path, content) in files {
            // [Safety Check] Domain Boundary Enforcement
            // Frontend agent should NOT touch backend/
            // Backend agent should NOT touch frontend/
            let is_safe = match self.dev_type {
                DeveloperType::Frontend => !file_path.starts_with("backend/") && !file_path.starts_with("backend\\"),
                DeveloperType::Backend => !file_path.starts_with("frontend/") && !file_path.starts_with("frontend\\"),
            };

            if !is_safe {
                crate::logger::log_warning(&format!(
                    "🚫 Access Denied: {:?} Agent attempted to write to restricted path '{}'. Skipped.", 
                    self.dev_type, file_path
                ));
                continue;
            }

            let full_path = base_path.join(&file_path);

            if let Some(parent) = full_path.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }

            tokio::fs::write(&full_path, content)
                .await
                .context(format!("파일 저장 실패: {}", file_path))?;

            crate::logger::status_update(&format!("  wrote: {}", file_path));
            created_files.push(file_path);
        }

        Ok(created_files)
    }
}

/// 보호된 파일인지 확인 (블랙리스트)
fn is_protected_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    matches!(
        lower.as_str(),
        "daacs.md" | "plan.md" | "task.md" | "review.md" | "test_report.md" | "design.md"
    ) || lower.starts_with(".daacs") 
      || lower.starts_with(".git")
      || lower.starts_with("target")
}

/// ?? ??? ??? ?? (???)
/// Format: "### File: path/to/file.ext\n```lang\n...\n```"
fn parse_file_blocks(response: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let lines: Vec<&str> = response.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        if line.starts_with("### File:") || line.starts_with("### 파일:") {
            let raw_path = line
                .trim_start_matches("###")
                .trim()
                .trim_start_matches("File:")
                .trim_start_matches("파일:")
                .trim();

            // Sanitize path: take first part before whitespace or parentheses
            let file_path = raw_path
                .split_whitespace()
                .next()
                .unwrap_or(raw_path)
                .trim_end_matches("(수정)")
                .trim_end_matches("(modified)")
                .trim()
                .to_string();

            i += 1;
            if i < lines.len() && lines[i].starts_with("```") {
                let code_start = i + 1;
                let mut code_end = code_start;

                while code_end < lines.len() && !lines[code_end].starts_with("```") {
                    code_end += 1;
                }

                if code_end < lines.len() {
                    let content = lines[code_start..code_end].join("\n");
                    files.push((file_path, content));
                    i = code_end + 1;
                    continue;
                }
            }
        }

        i += 1;
    }

    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_file_blocks() {
        let response = r#"
### File: backend/main.py
```python
print("Hello")
```

### File: backend/models.py
```python
class User:
    pass
```
"#;

        let files = parse_file_blocks(response);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].0, "backend/main.py");
        assert!(files[0].1.contains("Hello"));
        assert_eq!(files[1].0, "backend/models.py");
        assert!(files[1].1.contains("User"));
    }
}
