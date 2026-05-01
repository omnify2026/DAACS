//! 리팩터링 노드 - GLM 4.7-flash 기본 연결

use anyhow::Result;

use crate::agents::agent_runtime::AgentRuntime;
use crate::clients::cli_client::SessionBasedCLIClient;
use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};
use crate::utils::file_snapshot::{capture, diff};

pub struct RefactorNode;

#[async_trait::async_trait]
impl Node for RefactorNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("리팩터링");

        let daacs_content = state
            .daacs_content
            .clone()
            .ok_or_else(|| anyhow::anyhow!("DAACS.md content is missing"))?;

        let config = crate::config::settings::get();
        let runtime = AgentRuntime::new(&state.project_path);
        let extra_context = runtime.build_context("refactorer").unwrap_or_default();

        let review_path = state.project_path.join("REVIEW.md");
        let test_report_path = state.project_path.join("TEST_REPORT.md");
        let review_summary = read_optional(&review_path);
        let test_summary = read_optional(&test_report_path);

        let prompt = build_refactor_prompt(
            &daacs_content,
            &state.project_path,
            &extra_context,
            &review_summary,
            &test_summary,
        );

        let model_name = resolve_refactor_model();

        let before = capture(&state.project_path);

        let response = if model_name.to_lowercase().starts_with("glm") {
            // GLM 모델인 경우 Agentic Mode 사용
            let provider = crate::clients::cli_client::ModelProvider::GLM;
            let client = SessionBasedCLIClient::new(provider, state.project_path.clone());
            client.execute_agentic(&prompt).await?
        } else {
            let provider = config.parse_model_provider(&model_name);
            let client = SessionBasedCLIClient::new(provider, state.project_path.clone());
            client.execute(&prompt).await?
        };

        if contains_file_blocks(&response) {
            let _ = extract_and_save_files(&response, &state.project_path).await?;
        } else {
            crate::logger::log_warning("리팩터링 응답에 파일 블록이 없습니다. 변경이 적용되지 않을 수 있습니다.");
        }

        let after = capture(&state.project_path);
        let changed = diff(&before, &after);
        if !changed.is_empty() {
            let summary = format!("리팩터링 변경 파일: {}", changed.join(", "));
            let _ = runtime.append_memory("refactorer", &summary);
        } else {
            let _ = runtime.append_memory("refactorer", "리팩터링 변경 파일 없음");
        }

        crate::logger::task_complete("리팩터링 완료");
        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "RefactorNode"
    }
}

fn build_refactor_prompt(
    daacs: &str,
    project_path: &std::path::Path,
    extra_context: &str,
    review_summary: &str,
    test_summary: &str,
) -> String {
    format!(
        r#"당신은 리팩터링 전담 개발자입니다.

[프로젝트 사양 (DAACS.md)]
{daacs}

[프로젝트 경로]
{path}

[리뷰 요약]
{review}

[테스트 요약]
{tests}

[추가 컨텍스트]
{context}

[지시사항]
1) 코드 품질/가독성/구조 개선을 중심으로 리팩터링하세요. (비즈니스 로직 수정 금지)
2) 기능 변경 없이 내부 구조 개선을 우선합니다. 기능적 버그가 보여도 무시하십시오 (그것은 재작업/Rework 단계의 역할입니다).
3) 필요한 파일을 수정/생성하고, 아래 형식으로 파일 블록을 출력하세요.

[출력 규칙]
- 변경된 파일만 출력하세요.
- 각 파일은 아래 형식을 반드시 지켜주세요.

### File: relative/path/to/file.ext
```lang
...file content...
```

- 사용자에게 보이는 텍스트/메시지/UI는 한국어 우선입니다.
"#,
        daacs = daacs,
        path = project_path.display(),
        review = if review_summary.is_empty() { "(없음)" } else { review_summary },
        tests = if test_summary.is_empty() { "(없음)" } else { test_summary },
        context = extra_context
    )
}

fn resolve_refactor_model() -> String {
    if let Ok(config) = crate::config::settings::DaacsConfig::load() {
        let mut name = config.models.refactorer.trim().to_string();
        if name.eq_ignore_ascii_case("glm-4.7-falsh") {
            name = "glm-4.7-flash".to_string();
        }
        if name.is_empty() || name.eq_ignore_ascii_case("glm") || name.eq_ignore_ascii_case("codex") {
            return "glm-4.7-flash".to_string();
        }
        return name;
    }
    "glm-4.7-flash".to_string()
}

fn read_optional(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

fn contains_file_blocks(response: &str) -> bool {
    response.contains("### File:") || response.contains("### 파일:")
}

async fn extract_and_save_files(
    response: &str,
    base_path: &std::path::Path,
) -> Result<Vec<String>> {
    let files = parse_file_blocks(response);
    let mut created_files = Vec::new();

    for (file_path, content) in files {
        let full_path = base_path.join(&file_path);

        if let Some(parent) = full_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }

        tokio::fs::write(&full_path, content).await?;
        crate::logger::status_update(&format!("  wrote: {}", file_path));
        created_files.push(file_path);
    }

    Ok(created_files)
}

fn parse_file_blocks(response: &str) -> Vec<(String, String)> {
    let mut files = Vec::new();
    let lines: Vec<&str> = response.lines().collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];

        if line.starts_with("### File:") || line.starts_with("### 파일:") {
            let file_path = line
                .trim_start_matches("###")
                .trim()
                .trim_start_matches("File:")
                .trim_start_matches("파일:")
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
