//! DevOps 에이전트 - 빌드/테스트 검증 (Autonomous Mode)

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};
use crate::graph::state::Task;

/// DevOps 에이전트
pub struct DevOpsAgent {
    client: SessionBasedCLIClient,
}

impl DevOpsAgent {
    /// 사전 구성된 클라이언트로 생성
    pub fn with_client(client: SessionBasedCLIClient) -> Self {
        Self { client }
    }

    /// 새 DevOps 생성
    pub fn new(model: ModelProvider, working_dir: PathBuf) -> Self {
        let client = SessionBasedCLIClient::new(model, working_dir);
        Self { client }
    }

    /// Task Execution (Autonomous LLM Mode)
    pub async fn execute_task(
        &self,
        task: &Task,
        daacs_content: &str,
        project_path: &Path,
    ) -> Result<DevOpsResult> {
        crate::logger::status_update(&format!("DevOps: {} (Autonomous Mode)...", task.name));

        // 1. Context Preparation
        let prompt = self.build_task_prompt(task, daacs_content, project_path);

        // 2. LLM Execution
        crate::logger::status_update(&format!("📤  Sending Prompt to {:?} (DevOps)...", self.client.provider));
        
        let response = self.client
            .execute(&prompt)
            .await
            .context("Autonomous DevOps Agent execution failed")?;

        crate::logger::status_update(&format!("📥  Received Response ({} chars)", response.len()));

        // 3. Apply Generated Files
        if let Err(e) = self.apply_generated_files(&response, project_path).await {
            crate::logger::log_warning(&format!("DevOps: 파일 적용 실패: {}", e));
        }

        // 4. Result Parsing
        let result = self.parse_result(&response);
        crate::logger::task_complete(&format!("DevOps: {} Complete", task.name));
        
        Ok(result)
    }

    /// 파일 블록 파싱 및 적용
    async fn apply_generated_files(&self, response: &str, base_path: &Path) -> Result<()> {
        let files = parse_file_blocks(response);
        for (file_path, content) in files {
            let target_path = base_path.join(&file_path);
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent).await?;
            }
            fs::write(&target_path, content).await?;
            crate::logger::status_update(&format!("  wrote: {}", file_path));
        }
        Ok(())
    }

    fn build_task_prompt(&self, task: &Task, daacs_content: &str, project_path: &Path) -> String {
        format!(
            r#"You are an expert DevOps Engineer & QA Specialist.
Your goal is to complete the following task autonomously.
You are equipped with the "DevOpsCloud" skill bundle.

[Project Context]
Path: {path}
{spec}

[Task]
Name: {task_name}
Description: {task_desc}

[Instructions]
1. Analyze the task (Testing, Docker, CI/CD, etc.).
2. IMPLEMENT the necessary code or files.
3. OUTPUT your implementation using file blocks.
4. Output a JSON summary.

[Output Format]
### File: path/to/file.ext
```lang
content
```

```json
{{
  "success": true,
  "summary": "Implemented Dockerfile and nginx.conf",
  "build_status": "success",
  "tests_passed": 0,
  "tests_failed": 0
}}
```
"#,
            path = project_path.display(),
            spec = daacs_content,
            task_name = task.name,
            task_desc = task.description
        )
    }

    fn parse_result(&self, response: &str) -> DevOpsResult {
        if let Some(json_str) = extract_json_block(response) {
            if let Ok(result) = serde_json::from_str::<DevOpsResult>(&json_str) {
                return result;
            }
        }

        DevOpsResult {
            success: response.contains("success") || response.contains("passed") || response.contains("Created"),
            tests_passed: 0,
            tests_failed: 0,
            build_status: "success".to_string(),
            errors: vec![],
            warnings: vec![],
            summary: response.chars().take(200).collect(),
        }
    }
}

/// JSON 블록 추출 (Helper)
fn extract_json_block(text: &str) -> Option<String> {
    if let Some(start) = text.find("```json") {
        let content_start = start + "```json".len();
        if let Some(end) = text[content_start..].find("```") {
            return Some(text[content_start..content_start + end].trim().to_string());
        }
    }

    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                return Some(text[start..=end].to_string());
            }
        }
    }

    None
}

/// Parse file blocks manually (No Regex)
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
            
            let file_path = raw_path.split_whitespace().next().unwrap_or(raw_path).to_string();

            i += 1;
            if i < lines.len() && lines[i].starts_with("```") {
                let code_start = i + 1;
                let mut code_end = code_start;
                
                for j in code_start..lines.len() {
                    if lines[j].starts_with("```") {
                        code_end = j;
                        break;
                    }
                }
                
                if code_end > code_start {
                    let content = lines[code_start..code_end].join("\n");
                    files.push((file_path, content));
                    i = code_end;
                }
            }
        }
        i += 1;
    }
    files
}

/// DevOps 실행 결과
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DevOpsResult {
    pub success: bool,
    pub tests_passed: usize,
    pub tests_failed: usize,
    pub build_status: String,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub summary: String,
}
