//! DeepSeek API 클라이언트
//!
//! DeepSeek API 직접 호출 (CLI 없음)

use anyhow::Result;
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// DeepSeek API 엔드포인트
const DEEPSEEK_API_URL: &str = "https://api.deepseek.com/v1/chat/completions";

/// DeepSeek 요청
#[derive(Debug, Serialize)]
struct DeepSeekRequest {
    model: String,
    messages: Vec<DeepSeekMessage>,
}

#[derive(Debug, Serialize)]
struct DeepSeekMessage {
    role: String,
    content: String,
}

/// DeepSeek 응답
#[derive(Debug, Deserialize)]
struct DeepSeekResponse {
    choices: Vec<DeepSeekChoice>,
}

#[derive(Debug, Deserialize)]
struct DeepSeekChoice {
    message: DeepSeekMessageResponse,
}

#[derive(Debug, Deserialize)]
struct DeepSeekMessageResponse {
    content: String,
}

/// DeepSeek V4 실행
pub async fn execute(prompt: &str) -> Result<String> {
    let api_key = std::env::var("DEEPSEEK_API_KEY")
        .unwrap_or_else(|_| "".to_string());
    
    if api_key.is_empty() {
        return Ok("[DeepSeek] API 키가 설정되지 않았습니다. DEEPSEEK_API_KEY 환경변수를 설정하세요.".to_string());
    }
    
    let client = Client::new();
    
    let request = DeepSeekRequest {
        model: "deepseek-chat".to_string(),
        messages: vec![DeepSeekMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
    };
    
    let response = client
        .post(DEEPSEEK_API_URL)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&request)
        .send()
        .await?;
    
    let ds_response: DeepSeekResponse = response.json().await?;
    
    if let Some(choice) = ds_response.choices.first() {
        Ok(choice.message.content.clone())
    } else {
        Ok("[DeepSeek] 응답 없음".to_string())
    }
}
