//! GLM API 클라이언트 - SPEC.md Section 12.1 기반
//!
//! ZhipuAI API 직접 호출 (CLI 없음)

use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// GLM API 엔드포인트
const GLM_API_URL: &str = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

/// GLM 요청
#[derive(Debug, Serialize)]
struct GlmRequest {
    model: String,
    messages: Vec<GlmMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<Tool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_choice: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct GlmMessage {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Tool {
    #[serde(rename = "type")]
    tool_type: String,
    function: ToolFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolFunction {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: String,
    function: ToolCallFunction,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct ToolCallFunction {
    name: String,
    arguments: String,
}

/// GLM 응답
#[derive(Debug, Deserialize)]
struct GlmResponse {
    choices: Vec<GlmChoice>,
}

#[derive(Debug, Deserialize)]
struct GlmChoice {
    message: GlmMessage,
}

/// GLM 실행 (기본 모델)
pub async fn execute(prompt: &str) -> Result<String> {
    execute_with_history(prompt, &mut Vec::new()).await
}

/// GLM 실행 (히스토리 포함)
pub async fn execute_with_history(prompt: &str, history: &mut Vec<(String, String)>) -> Result<String> {
    let model = std::env::var("GLM_MODEL").unwrap_or_else(|_| "glm-4.7-flash".to_string());
    let api_key = resolve_api_key();
    if api_key.is_empty() {
        return Ok("[GLM] API 키가 설정되지 않았습니다. config.toml 또는 GLM_API_KEY를 확인하세요.".to_string());
    }

    let client = Client::new();

    // 히스토리를 GLM 메시지로 변환
    let mut messages: Vec<GlmMessage> = history.iter().map(|(role, content)| {
        GlmMessage {
            role: role.clone(),
            content: Some(content.clone()),
            tool_calls: None,
            tool_call_id: None,
        }
    }).collect();

    // 현재 프롬프트 추가
    messages.push(GlmMessage {
        role: "user".to_string(),
        content: Some(prompt.to_string()),
        tool_calls: None,
        tool_call_id: None,
    });

    let request = GlmRequest {
        model: model.clone(),
        messages,
        tools: None,
        tool_choice: None,
    };

    let response = client
        .post(GLM_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&request)
        .send()
        .await?;

    let glm_response: GlmResponse = response.json().await?;

    if let Some(choice) = glm_response.choices.first() {
        let content = choice.message.content.clone().unwrap_or_default();
        Ok(content)
    } else {
        Ok("[GLM] 응답이 없습니다.".to_string())
    }
}

/// GLM 실행 (모델 지정 - 레거시 호환용, 히스토리 없음)
pub async fn execute_with_model(prompt: &str, model_name: &str) -> Result<String> {
    let api_key = resolve_api_key();
    if api_key.is_empty() {
        return Ok("[GLM] API 키가 설정되지 않았습니다. config.toml 또는 GLM_API_KEY를 확인하세요.".to_string());
    }

    let client = Client::new();

    let request = GlmRequest {
        model: model_name.to_string(),
        messages: vec![GlmMessage {
            role: "user".to_string(),
            content: Some(prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
        }],
        tools: None,
        tool_choice: None,
    };

    let response = client
        .post(GLM_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&request)
        .send()
        .await?;

    let glm_response: GlmResponse = response.json().await?;

    if let Some(choice) = glm_response.choices.first() {
        Ok(choice.message.content.clone().unwrap_or_default())
    } else {
        Ok("[GLM] 응답이 없습니다.".to_string())
    }
}

/// GLM 에이전틱 모드 실행
pub async fn execute_agentic(prompt: &str, working_dir: &std::path::Path) -> Result<String> {
    let model = std::env::var("GLM_MODEL").unwrap_or_else(|_| "glm-4.7-flash".to_string());
    let api_key = resolve_api_key();
    
    if api_key.is_empty() {
        return Ok("[GLM] API 키가 설정되지 않았습니다.".to_string());
    }

    let client = Client::new();
    
    // 기본 도구 정의
    let tools = vec![
        Tool {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "read_file".to_string(),
                description: "파일의 내용을 읽습니다.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "읽을 파일의 경로" }
                    },
                    "required": ["path"]
                }),
            },
        },
        Tool {
            tool_type: "function".to_string(),
            function: ToolFunction {
                name: "list_dir".to_string(),
                description: "디렉토리의 파일 목록을 조회합니다.".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "path": { "type": "string", "description": "조회할 디렉토리 경로 (기본값: 현재 디렉토리)" }
                    },
                }),
            },
        },
    ];

    let mut messages = vec![
        GlmMessage {
            role: "system".to_string(),
            content: Some("당신은 파일 시스템에 접근하여 코드를 분석하고 작업을 수행할 수 있는 AI 에이전트입니다.".to_string()),
            tool_calls: None,
            tool_call_id: None,
        },
        GlmMessage {
            role: "user".to_string(),
            content: Some(prompt.to_string()),
            tool_calls: None,
            tool_call_id: None,
        }
    ];

    // 에이전트 루프 (최대 10회)
    for _ in 0..10 {
        let request = GlmRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: Some(tools.clone()),
            tool_choice: Some("auto".to_string()),
        };

        let response = client
            .post(GLM_API_URL)
            .header("Authorization", format!("Bearer {}", api_key))
            .json(&request)
            .send()
            .await?;

        let glm_response: GlmResponse = response.json().await?;
        
        let choice = match glm_response.choices.first() {
            Some(c) => c,
            None => return Ok("응답이 없습니다.".to_string()),
        };

        let msg = choice.message.clone();
        messages.push(msg.clone());

        if let Some(tool_calls) = &msg.tool_calls {
            for tool_call in tool_calls {
                let function_name = &tool_call.function.name;
                let args_str = &tool_call.function.arguments;
                let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
                
                crate::logger::status_update(&format!("🤖 도구 실행: {} ({})", function_name, args_str));

                let result = match function_name.as_str() {
                    "read_file" => {
                        let path = args["path"].as_str().unwrap_or("");
                        let full_path = working_dir.join(path);
                        match tokio::fs::read_to_string(full_path).await {
                            Ok(content) => content,
                            Err(e) => format!("Error reading file: {}", e),
                        }
                    },
                    "list_dir" => {
                        let path = args["path"].as_str().unwrap_or(".");
                        let full_path = working_dir.join(path);
                        match std::fs::read_dir(full_path) {
                            Ok(entries) => {
                                let names: Vec<String> = entries
                                    .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
                                    .collect();
                                names.join("\n")
                            },
                            Err(e) => format!("Error listing directory: {}", e),
                        }
                    },
                    _ => "Unknown tool".to_string(),
                };

                messages.push(GlmMessage {
                    role: "tool".to_string(),
                    content: Some(result),
                    tool_calls: None,
                    tool_call_id: Some(tool_call.id.clone()),
                });
            }
        } else {
            // 최종 응답
            return Ok(msg.content.unwrap_or_default());
        }
    }

    Ok("최대 반복 횟수를 초과했습니다.".to_string())
}

fn resolve_api_key() -> String {
    if let Ok(key) = std::env::var("GLM_API_KEY") {
        if !key.trim().is_empty() {
            return key;
        }
    }
    if let Ok(config) = crate::config::settings::DaacsConfig::load() {
        if let Some(key) = config.api_keys.glm_api_key {
            if !key.trim().is_empty() {
                return key;
            }
        }
    }
    String::new()
}
