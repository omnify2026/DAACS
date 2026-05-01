//! 설정 관리 - SPEC.md Section 13.4 기반
//!
//! ~/.daacs/config.toml 읽기/쓰기 및 모델 할당 관리

use anyhow::{Result, Context};
use serde::{Serialize, Deserialize};
use std::path::PathBuf;
use std::fs;
use std::sync::RwLock;
use crate::clients::cli_client::ModelProvider;

/// DAACS 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaacsConfig {
    pub models: ModelConfig,
    pub resilience: ResilienceConfig,
    pub api_keys: ApiKeys,
}

/// 모델 할당 설정 (SPEC Section 13.1)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelConfig {
    /// Architect 에이전트 모델
    #[serde(default = "default_architect_model")]
    pub architect: String,

    /// Backend Developer 모델
    #[serde(default = "default_backend_model")]
    pub backend_developer: String,

    /// Frontend Developer 모델
    #[serde(default = "default_frontend_model")]
    pub frontend_developer: String,

    /// DevOps 모델
    #[serde(default = "default_devops_model")]
    pub devops: String,

    /// Reviewer 모델
    #[serde(default = "default_reviewer_model")]
    pub reviewer: String,

    /// Refactorer 모델
    #[serde(default = "default_refactorer_model")]
    pub refactorer: String,

    /// Designer 모델
    #[serde(default = "default_designer_model")]
    pub designer: String,

    /// DocWriter 모델
    #[serde(default = "default_docwriter_model")]
    pub doc_writer: String,
}

/// Resilience 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResilienceConfig {
    /// 최대 재시도 횟수
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,

    /// Fallback 활성화
    #[serde(default = "default_enable_fallback")]
    pub enable_fallback: bool,

    /// 토큰 제한 전략 (summarize | prune | error)
    #[serde(default = "default_token_strategy")]
    pub token_limit_strategy: String,

    /// Git Checkpoint (Time Machine) 활성화
    #[serde(default = "default_use_git_checkpoint")]
    pub use_git_checkpoint: bool,
}

/// API 키 설정
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeys {
    /// GLM API Key (ZhipuAI)
    #[serde(default)]
    pub glm_api_key: Option<String>,

    /// DeepSeek API Key
    #[serde(default)]
    pub deepseek_api_key: Option<String>,

    /// OpenAI API Key (GPT-5)
    #[serde(default)]
    pub openai_api_key: Option<String>,

    /// Anthropic API Key (Claude)
    #[serde(default)]
    pub anthropic_api_key: Option<String>,

    /// Google API Key (Gemini)
    #[serde(default)]
    pub google_api_key: Option<String>,
}

// 기본값 함수들
fn default_architect_model() -> String { "codex".to_string() }
fn default_backend_model() -> String { "claude".to_string() }
fn default_frontend_model() -> String { "claude".to_string() }
fn default_devops_model() -> String { "codex".to_string() }
fn default_reviewer_model() -> String { "codex".to_string() }
fn default_refactorer_model() -> String { "glm-4".to_string() }
fn default_designer_model() -> String { "gemini".to_string() }
fn default_docwriter_model() -> String { "deepseek".to_string() }

fn default_max_retries() -> u32 { 3 }
fn default_enable_fallback() -> bool { true }
fn default_token_strategy() -> String { "summarize".to_string() }
fn default_use_git_checkpoint() -> bool { true }

impl Default for DaacsConfig {
    fn default() -> Self {
        Self {
            models: ModelConfig {
                architect: default_architect_model(),
                backend_developer: default_backend_model(),
                frontend_developer: default_frontend_model(),
                devops: default_devops_model(),
                reviewer: default_reviewer_model(),
                refactorer: default_refactorer_model(),
                designer: default_designer_model(),
                doc_writer: default_docwriter_model(),
            },
            resilience: ResilienceConfig {
                max_retries: default_max_retries(),
                enable_fallback: default_enable_fallback(),
                token_limit_strategy: default_token_strategy(),
                use_git_checkpoint: default_use_git_checkpoint(),
            },
            api_keys: ApiKeys {
                glm_api_key: std::env::var("GLM_API_KEY").ok(),
                deepseek_api_key: std::env::var("DEEPSEEK_API_KEY").ok(),
                openai_api_key: std::env::var("OPENAI_API_KEY").ok(),
                anthropic_api_key: std::env::var("ANTHROPIC_API_KEY").ok(),
                google_api_key: std::env::var("GOOGLE_API_KEY").ok(),
            },
        }
    }
}

impl DaacsConfig {
    /// 설정 파일 경로 가져오기 (~/.daacs/config.toml)
    pub fn config_path() -> Result<PathBuf> {
        let home = dirs::home_dir()
            .context("홈 디렉토리를 찾을 수 없습니다")?;

        let daacs_dir = home.join(".daacs");

        // ~/.daacs 디렉토리 생성
        if !daacs_dir.exists() {
            fs::create_dir_all(&daacs_dir)
                .context("~/.daacs 디렉토리 생성 실패")?;
        }

        Ok(daacs_dir.join("config.toml"))
    }

    /// 설정 파일 로드
    pub fn load() -> Result<Self> {
        let path = Self::config_path()?;

        if !path.exists() {
            // 설정 파일이 없으면 기본값으로 생성
            let default_config = Self::default();
            default_config.save()?;
            return Ok(default_config);
        }

        let content = fs::read_to_string(&path)
            .context("설정 파일 읽기 실패")?;

        let config: DaacsConfig = toml::from_str(&content)
            .context("설정 파일 파싱 실패")?;

        Ok(config)
    }

    /// 설정 파일 저장
    pub fn save(&self) -> Result<()> {
        let path = Self::config_path()?;

        let toml_content = toml::to_string_pretty(self)
            .context("설정 직렬화 실패")?;

        fs::write(&path, toml_content)
            .context("설정 파일 쓰기 실패")?;

        crate::logger::status_update(&format!("설정 저장: {}", path.display()));

        Ok(())
    }

    /// 모델 이름 -> ModelProvider 변환
    pub fn parse_model_provider(&self, model_name: &str) -> ModelProvider {
        let lower = model_name.to_lowercase();
        if lower.starts_with("glm") {
            return ModelProvider::GLM;
        }
        match lower.as_str() {
            "claude" => ModelProvider::Claude,
            "codex" => ModelProvider::Codex,
            "gemini" => ModelProvider::Gemini,
            "deepseek" => ModelProvider::DeepSeek,
            custom => ModelProvider::Custom(custom.to_string()),
        }
    }

    /// Architect 모델 가져오기
    pub fn get_architect_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.architect)
    }

    /// Backend Developer 모델 가져오기
    pub fn get_backend_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.backend_developer)
    }

    /// Frontend Developer 모델 가져오기
    pub fn get_frontend_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.frontend_developer)
    }

    /// DevOps 모델 가져오기
    pub fn get_devops_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.devops)
    }

    /// Reviewer 모델 가져오기
    pub fn get_reviewer_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.reviewer)
    }

    /// Refactorer 모델 가져오기
    pub fn get_refactorer_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.refactorer)
    }

    /// Designer 모델 가져오기
    pub fn get_designer_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.designer)
    }

    /// DocWriter 모델 가져오기
    pub fn get_docwriter_model(&self) -> ModelProvider {
        self.parse_model_provider(&self.models.doc_writer)
    }
}

/// 글로벌 설정 인스턴스
static CONFIG: once_cell::sync::OnceCell<RwLock<DaacsConfig>> = once_cell::sync::OnceCell::new();

/// 글로벌 설정 초기화
pub fn init() -> Result<()> {
    let config = DaacsConfig::load()?;
    CONFIG
        .set(RwLock::new(config))
        .map_err(|_| anyhow::anyhow!("설정이 이미 초기화되었습니다"))?;
    Ok(())
}

/// 글로벌 설정 가져오기
pub fn get() -> DaacsConfig {
    CONFIG
        .get()
        .expect("설정이 초기화되지 않았습니다. config::init()을 먼저 호출하세요.")
        .read()
        .expect("config lock failed")
        .clone()
}

/// 글로벌 설정 업데이트
pub fn set(config: DaacsConfig) -> Result<()> {
    if let Some(lock) = CONFIG.get() {
        let mut guard = lock.write().expect("config lock failed");
        *guard = config;
        return Ok(());
    }

    CONFIG
        .set(RwLock::new(config))
        .map_err(|_| anyhow::anyhow!("설정이 이미 초기화되었습니다"))?;
    Ok(())
}

/// 설정 파일을 다시 로드해 글로벌 설정을 갱신
pub fn reload() -> Result<()> {
    let config = DaacsConfig::load()?;
    set(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        let config = DaacsConfig::default();
        assert_eq!(config.models.architect, "codex");
        assert_eq!(config.resilience.max_retries, 3);
        assert_eq!(config.resilience.enable_fallback, true);
    }

    #[test]
    fn test_model_provider_parse() {
        let config = DaacsConfig::default();
        assert!(matches!(config.get_architect_model(), ModelProvider::Codex));
        assert!(matches!(config.get_devops_model(), ModelProvider::Codex));
    }
}
