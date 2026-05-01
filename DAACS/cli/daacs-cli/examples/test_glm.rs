use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize)]
struct GlmRequest {
    model: String,
    messages: Vec<GlmMessage>,
}

#[derive(Debug, Serialize)]
struct GlmMessage {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct GlmResponse {
    choices: Vec<GlmChoice>,
}

#[derive(Debug, Deserialize)]
struct GlmChoice {
    message: GlmMessageResponse,
}

#[derive(Debug, Deserialize)]
struct GlmMessageResponse {
    content: String,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Load config from ~/.daacs/config.toml
    println!("Loading config from ~/.daacs/config.toml...");
    
    // Note: We assume 'daacs' lib is available. 
    // If running via `cargo run --example test_glm`, it should link to the lib.
    let config = daacs::config::settings::DaacsConfig::load()?;
    
    let api_key = config.api_keys.glm_api_key
        .expect("GLM_API_KEY not set in config.toml. Please add it under [api_keys]");
        
    let url = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

    println!("Testing GLM-4-Flash API...");
    println!("API Key: {}...", &api_key[..5]);

    let client = Client::new();
    let request = GlmRequest {
        model: "glm-4.7-flash".to_string(),
        messages: vec![GlmMessage {
            role: "user".to_string(),
            content: "Hello! Are you working correctly?".to_string(),
        }],
    };

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&request)
        .send()
        .await?;

    if response.status().is_success() {
        let glm_response: GlmResponse = response.json().await?;
        if let Some(choice) = glm_response.choices.first() {
            println!("✅ Success! Response: {}", choice.message.content);
        } else {
            println!("⚠️ Success but no content.");
        }
    } else {
        println!("❌ Failed: Status {}", response.status());
        println!("Body: {}", response.text().await?);
    }

    Ok(())
}
