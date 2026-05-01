//! 모델 할당 매트릭스 - SPEC.md Section 13.1 기반
//!
//! 각 에이전트에 최적의 모델을 할당합니다.

use crate::clients::cli_client::ModelProvider;
use std::collections::HashMap;

/// 모델 할당 매트릭스
#[derive(Debug, Clone)]
pub struct ModelMatrix {
    assignments: HashMap<AgentRole, ModelAssignment>,
}

/// 에이전트 역할
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum AgentRole {
    Architect,
    BackendDeveloper,
    FrontendDeveloper,
    DevOps,
    Reviewer,
    Refactorer,
    Designer,
    DocWriter,
    Council,
}

/// 모델 할당 정보
#[derive(Debug, Clone)]
pub struct ModelAssignment {
    pub default_model: ModelProvider,
    pub fallback_model: Option<ModelProvider>,
    pub max_output_tokens: usize,
    pub reason: String,
}

impl Default for ModelMatrix {
    fn default() -> Self {
        let mut assignments = HashMap::new();
        
        // CLI 에이전틱 모드 우선: 기본은 Codex로 통일
        assignments.insert(
            AgentRole::Architect,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 16000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::BackendDeveloper,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 128000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::FrontendDeveloper,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Gemini),
                max_output_tokens: 64000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::DevOps,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 16000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::Reviewer,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 16000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::Refactorer,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 16000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::Designer,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Gemini),
                max_output_tokens: 64000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        assignments.insert(
            AgentRole::DocWriter,
            ModelAssignment {
                default_model: ModelProvider::Codex,
                fallback_model: Some(ModelProvider::Claude),
                max_output_tokens: 32000,
                reason: "Codex 우선 (에이전틱 CLI)".to_string(),
            },
        );
        
        Self { assignments }
    }
}

impl ModelMatrix {
    /// 새 매트릭스 생성
    pub fn new() -> Self {
        Self::default()
    }
    
    /// 에이전트에 할당된 모델 가져오기
    pub fn get_model(&self, role: &AgentRole) -> Option<&ModelAssignment> {
        self.assignments.get(role)
    }
    
    /// 모델 할당 변경
    pub fn set_model(&mut self, role: AgentRole, assignment: ModelAssignment) {
        self.assignments.insert(role, assignment);
    }
    
    /// Fallback 모델 가져오기
    pub fn get_fallback(&self, role: &AgentRole) -> Option<ModelProvider> {
        self.assignments.get(role)
            .and_then(|a| a.fallback_model.clone())
    }
}
