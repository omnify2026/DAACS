//! Documentation node to generate REPORT.md.

use anyhow::Result;

use crate::clients::cli_client::SessionBasedCLIClient;
use crate::document::release_gate_md::decide_release_gate;
use crate::document::report_md::generate_report_md;
use crate::document::{review_md::parse_review_md, test_report_md::parse_test_report_md};
use crate::graph::state::CLIState;
use crate::graph::workflow::{Node, NodeResult};

pub struct DocumentationNode;

#[async_trait::async_trait]
impl Node for DocumentationNode {
    async fn execute(&self, state: &mut CLIState) -> Result<NodeResult> {
        crate::logger::phase_start("문서화 (Documentation)");

        let config = crate::config::settings::get();
        let model = config.get_docwriter_model();

        let client = SessionBasedCLIClient::new(model, state.project_path.clone());

        // 1. Generate README.md
        crate::logger::status_update("README.md 작성 중...");
        
        let daacs_content = state.daacs_content.clone().unwrap_or_default();
        let tech_stack = format!("{:?}", state.tech_stack);
        
        let prompt = format!(
            r#"당신은 테크니컬 라이터입니다. 프로젝트의 README.md를 작성해 주세요.

[프로젝트 명세 (DAACS.md)]
{}

[기술 스택]
{}

[지시사항]
1. 프로젝트 소개, 설치 방법, 사용법, 기술 스택, 라이선스 등을 포함하세요.
2. 마크다운 형식으로 작성하세요.
3. 파일 블록(### File: README.md) 형식으로 출력하세요.
4. 언어는 한국어로 작성하세요.
"#,
            daacs_content, tech_stack
        );

        let response = client.execute(&prompt).await?;
        
        if response.contains("### File:") || response.contains("### 파일:") {
             let _ = extract_and_save_files(&response, &state.project_path).await?;
             crate::logger::task_complete("README.md 생성 완료");
        } else {
             crate::logger::log_warning("README.md 파일 블록을 찾을 수 없습니다.");
        }

        // 2. Generate REPORT.md (Legacy summary)
        let review_path = state.project_path.join("REVIEW.md");
        let test_path = state.project_path.join("TEST_REPORT.md");
        let review_data = parse_review_md(&review_path).await.unwrap_or_default();
        let test_data = parse_test_report_md(&test_path).await.unwrap_or_default();
        let decision = decide_release_gate(&review_data, &test_data);
        
        let report_path = state.project_path.join("REPORT.md");
        let summary = format!(
            "Release gate: {}. Review score: {:.1}. Failed tasks: {}",
            decision.status.as_str(),
            review_data.score,
            state.failed_tasks.join(", ")
        );
        generate_report_md(&report_path, &state.goal, &summary, &decision).await?;

        Ok(NodeResult::Success)
    }

    fn name(&self) -> &str {
        "DocumentationNode"
    }
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
