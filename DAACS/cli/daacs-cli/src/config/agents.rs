//! Agent Configuration
//!
//! Defines the structure for `agents.toml` which allows dynamic creation
//! of specialized agents with specific system prompts and skill bundles.

use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::path::PathBuf;
use anyhow::{Result, Context};
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentsConfig {
    #[serde(flatten)]
    pub agents: HashMap<String, AgentConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// Description of the agent's role
    pub description: String,
    
    /// Optional: Specific model to use (e.g. "claude-3-opus")
    /// If None, uses the current CLI model
    pub model: Option<String>,
    
    /// Skill bundles to auto-load (e.g. ["rust-pro", "backend-patterns"])
    #[serde(default)]
    pub skills: Vec<String>,
    
    /// System prompt defining the persona
    pub system_prompt: String,
}

impl AgentsConfig {
    pub fn config_path() -> Result<PathBuf> {
        let home = dirs::home_dir().context("Cannot find home directory")?;
        Ok(home.join(".daacs").join("config").join("agents.toml"))
    }

    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;
        
        if !path.exists() {
            // Create default agents if file doesn't exist
            let default_config = Self::default_agents();
            default_config.save()?;
            return Ok(default_config);
        }

        let content = fs::read_to_string(&path)
            .context("Failed to read agents.toml")?;
            
        let config: AgentsConfig = toml::from_str(&content)
            .context("Failed to parse agents.toml")?;
            
        Ok(config)
    }

    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;
        
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let content = toml::to_string_pretty(self)
            .context("Failed to serialize agents config")?;
            
        fs::write(&path, content)
            .context("Failed to write agents.toml")?;
            
        Ok(())
    }

    fn default_agents() -> Self {
        let mut agents = HashMap::new();

        // 1. Management
        agents.insert("PM".to_string(), AgentConfig {
            description: "프로젝트 일정, 범위, 우선순위 관리 전문가".to_string(),
            model: None,
            skills: vec!["product-manager-toolkit".to_string(), "brainstorming".to_string(), "plan-writing".to_string()],
            system_prompt: "당신은 노련한 프로젝트 매니저(PM)입니다. 목표를 명확히 하고, 리소스를 조율하며, 일정을 관리하세요.".to_string(),
        });

        agents.insert("창업가".to_string(), AgentConfig {
            description: "스타트업 사업 전략, BM, 피칭 전문가".to_string(),
            model: Some("claude-3-opus".to_string()),
            skills: vec!["startup-analyst".to_string(), "micro-saas-launcher".to_string(), "pricing-strategy".to_string()],
            system_prompt: "당신은 연쇄 창업가입니다. 비즈니스 모델, 수익화 전략, 시장 진입 전략(GTM)에 대해 조언하세요.".to_string(),
        });

        // 2. Development (Specialized)
        agents.insert("프론트엔드".to_string(), AgentConfig {
            description: "React, Tailwind, UI/UX 프론트엔드 전문가".to_string(),
            model: None,
            skills: vec!["frontend-developer".to_string(), "ui-ux-pro-max".to_string(), "react-patterns".to_string(), "tailwind-design-system".to_string()],
            system_prompt: "당신은 디테일에 집착하는 프론트엔드 장인입니다. 사용자 경험(UX)과 심미성, 접근성을 최우선으로 생각하세요.".to_string(),
        });

        agents.insert("백엔드".to_string(), AgentConfig {
            description: "대규모 분산 시스템 및 서버 아키텍처 전문가".to_string(),
            model: None,
            skills: vec!["backend-architect".to_string(), "api-design-principles".to_string(), "sql-pro".to_string(), "software-architecture".to_string()],
            system_prompt: "당신은 확장성과 안정성을 중시하는 백엔드 아키텍트입니다. 마이크로서비스, DB 설계, API 보안을 다룹니다.".to_string(),
        });

        agents.insert("러스트_전문가".to_string(), AgentConfig {
            description: "Rust 시스템 프로그래밍 및 고성능 최적화 전문가".to_string(),
            model: None,
            skills: vec!["rust-pro".to_string(), "systems-programming-rust-project".to_string(), "rust-async-patterns".to_string()],
            system_prompt: "당신은 Rust 전문가입니다. 소유권, 수명, 동시성 모델을 깊이 이해하고 있으며, 안전하고 빠른 코드를 작성합니다.".to_string(),
        });

        // 3. Operations & Security
        agents.insert("데브옵스".to_string(), AgentConfig {
            description: "CI/CD, 클라우드 인프라, Docker/K8s 전문가".to_string(),
            model: None,
            skills: vec!["devops-troubleshooter".to_string(), "docker-expert".to_string(), "kubernetes-architect".to_string(), "terraform-specialist".to_string()],
            system_prompt: "당신은 자동화를 사랑하는 DevOps 엔지니어입니다. 인프라를 코드(IaC)로 관리하고, 배포 파이프라인을 최적화하세요.".to_string(),
        });

        agents.insert("보안관".to_string(), AgentConfig {
            description: "보안 취약점 점검 및 코드 감사 전문가".to_string(),
            model: None,
            skills: vec!["security-auditor".to_string(), "code-reviewer".to_string(), "threat-modeling-expert".to_string()],
            system_prompt: "당신은 화이트해커 출신 보안 보안관입니다. 코드의 잠재적, 보안 결함을 찾아내고 방어적인 코딩 스타일을 제안하세요.".to_string(),
        });

        // 4. Marketing & Growth
        agents.insert("마케터".to_string(), AgentConfig {
            description: "콘텐츠 마케팅, SEO, 카피라이팅 전문가".to_string(),
            model: Some("gpt-4o".to_string()),
            skills: vec!["content-marketer".to_string(), "seo-fundamentals".to_string(), "copywriting".to_string(), "viral-generator-builder".to_string()],
            system_prompt: "당신은 데이터를 기반으로 성장 전략을 짜는 그로스 해커입니다. 사람의 마음을 움직이는 카피와 SEO 전략을 구사하세요.".to_string(),
        });

        AgentsConfig { agents }
    }
}
