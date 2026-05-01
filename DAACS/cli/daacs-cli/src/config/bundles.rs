use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::fs;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BundlesConfig {
    pub bundles: HashMap<String, BundleDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleDefinition {
    pub description: String,
    pub skills: Vec<String>,
}

impl BundlesConfig {
    /// Load bundles from ~/.daacs/bundles.toml
    /// If not found, returns default built-in bundles
    pub fn load() -> Self {
        let config_path = get_bundles_config_path();
        
        if config_path.exists() {
            if let Ok(content) = fs::read_to_string(&config_path) {
                if let Ok(config) = toml::from_str::<BundlesConfig>(&content) {
                    return config;
                }
            }
        }
        
        // Fallback to defaults
        Self::default_bundles()
    }
    
    pub fn get_bundle(&self, name: &str) -> Option<&BundleDefinition> {
        self.bundles.get(name)
    }

    pub fn default_bundles() -> Self {
        let mut bundles = HashMap::new();
        
        // Essentials
        bundles.insert("essentials".to_string(), BundleDefinition {
            description: "🚀 필수 팩: 기획, Git, 린팅 등 기본기".to_string(),
            skills: vec![
                "concise-planning".to_string(),
                "lint-and-validate".to_string(), 
                "git-pushing".to_string(),
                "kaizen".to_string(),
            ],
        });

        // Web Wizard
        bundles.insert("web-wizard".to_string(), BundleDefinition {
            description: "🌐 웹 마법사: React, Tailwind, SEO 최적화".to_string(),
            skills: vec![
                "frontend-design".to_string(),
                "react-patterns".to_string(),
                "tailwind-patterns".to_string(),
                "form-cro".to_string(),
                "seo-audit".to_string(),
            ],
        });

        // Python Pro
        bundles.insert("python-pro".to_string(), BundleDefinition {
            description: "🐍 파이썬 전문가: FastAPI, Django, Poetry 관리".to_string(),
            skills: vec![
                "python-patterns".to_string(),
                "poetry-manager".to_string(),
                "pytest-mastery".to_string(),
                "fastapi-expert".to_string(),
                "django-guide".to_string(),
            ],
        });

        // Agent Architect
        bundles.insert("agent-architect".to_string(), BundleDefinition {
            description: "🤖 에이전트 설계자: LangGraph, MCP, 프롬프트 엔지니어링".to_string(),
            skills: vec![
                "agent-evaluation".to_string(),
                "langgraph".to_string(),
                "mcp-builder".to_string(),
                "prompt-engineering".to_string(),
            ],
        });
        
        // Startup Founder
        bundles.insert("startup-founder".to_string(), BundleDefinition {
            description: "🦄 스타트업 창업가: 기획(PRD), 피칭, 결제(Stripe) 붙이기".to_string(),
            skills: vec![
                "product-requirements-doc".to_string(),
                "competitor-analysis".to_string(),
                "pitch-deck-creator".to_string(),
                "landing-page-copy".to_string(),
                "stripe-integration".to_string(),
            ],
        });

        // DevOps Cloud
        bundles.insert("devops-cloud".to_string(), BundleDefinition {
            description: "🌧️ 데브옵스 & 클라우드: Docker, AWS, 배포 자동화".to_string(),
            skills: vec![
                "docker-expert".to_string(),
                "aws-serverless".to_string(),
                "environment-setup-guide".to_string(),
                "deployment-procedures".to_string(),
                "bash-linux".to_string(),
            ],
        });

        // Creative Director
        bundles.insert("creative-director".to_string(), BundleDefinition {
            description: "🎨 크리에이티브 디렉터: 브랜딩, 콘텐츠 제작, 디자인 철학".to_string(),
            skills: vec![
                "canvas-design".to_string(),
                "frontend-design".to_string(), 
                "content-creator".to_string(),
                "copy-editing".to_string(),
                "algorithmic-art".to_string(),
            ],
        });

        // Web Designer
        bundles.insert("web-designer".to_string(), BundleDefinition {
            description: "🖌️ 웹 디자이너: 심미적 UI/UX, 3D 웹, 반응형 레이아웃".to_string(),
            skills: vec![
                "ui-ux-pro-max".to_string(),
                "frontend-design".to_string(),
                "3d-web-experience".to_string(),
                "canvas-design".to_string(),
                "responsive-layout".to_string(),
            ],
        });

        // Security Engineer
        bundles.insert("security-engineer".to_string(), BundleDefinition {
            description: "🛡️ 보안 엔지니어: 해킹 방어, 감사, 취약점 점검".to_string(),
            skills: vec![
                "ethical-hacking-methodology".to_string(),
                "burp-suite-testing".to_string(),
                "owasp-top-10".to_string(),
                "linux-privilege-escalation".to_string(),
                "cloud-penetration-testing".to_string(),
            ],
        });

        Self { bundles }
    }
}

fn get_bundles_config_path() -> PathBuf {
    let mut path = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push(".daacs");
    path.push("bundles.toml");
    path
}
