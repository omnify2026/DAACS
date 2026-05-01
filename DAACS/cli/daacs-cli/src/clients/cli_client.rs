//! SessionBasedCLIClient - Refactored for Phase 2 Core Mechanics
//!
//! Uses the `Provider` trait (Strategy Pattern) to delegate model execution.

use anyhow::Result;
use std::path::PathBuf;
pub use crate::clients::provider::{Provider, ModelProvider, ProviderOptions};
use crate::clients::provider_impls::get_provider_implementation; 
use std::sync::Arc; 

/// 세션 기반 CLI 클라이언트
#[derive(Clone)]
pub struct SessionBasedCLIClient {
    pub provider: ModelProvider,
    pub working_dir: PathBuf,
    pub is_continue: bool,
    
    // Core Engine
    strategy: Arc<dyn Provider>,
}

impl SessionBasedCLIClient {
    /// 새 클라이언트 생성
    pub fn new(provider: ModelProvider, working_dir: PathBuf) -> Self {
        let strategy = get_provider_implementation(provider.clone(), working_dir.clone());
        Self {
            provider,
            working_dir,
            is_continue: false,
            strategy,
        }
    }
    
    /// 세션 유지 모드 활성화 (Provider가 지원해야 함)
    pub fn with_continue(mut self) -> Self {
        self.is_continue = true;
        self
    }
    
    /// Basic Execution
    pub async fn execute(&self, prompt: &str) -> Result<String> {
        let options = ProviderOptions { session_continue: self.is_continue };
        self.strategy.complete(prompt, &[], &[], &options).await
    }

    /// Exec with Paths
    pub async fn execute_with_paths(&self, prompt: &str, context_paths: &[PathBuf]) -> Result<String> {
        let options = ProviderOptions { session_continue: self.is_continue };
        self.strategy.complete(prompt, &[], context_paths, &options).await
    }

    /// Exec with History
    pub async fn execute_with_history(
        &self, 
        prompt: &str, 
        history: &mut Vec<(String, String)>,
        context_paths: &[PathBuf]
    ) -> Result<String> {
        let options = ProviderOptions { session_continue: self.is_continue };
        let response = self.strategy.complete(prompt, history, context_paths, &options).await?;
        
        // Update history
        history.push(("user".to_string(), prompt.to_string()));
        history.push(("assistant".to_string(), response.clone()));
        
        Ok(response)
    }

    pub async fn execute_agentic(&self, prompt: &str) -> Result<String> {
        // Temporary: Agentic mode via execute
        self.execute(prompt).await
    }
}

// Re-export rescue fn
pub async fn rescue_to_model(
    current_context: &str,
    target_model: ModelProvider,
    working_dir: PathBuf,
) -> Result<String> {
    let client = SessionBasedCLIClient::new(target_model, working_dir);
    let prompt = format!("Rescue Context:\n{}", current_context);
    client.execute(&prompt).await
}
