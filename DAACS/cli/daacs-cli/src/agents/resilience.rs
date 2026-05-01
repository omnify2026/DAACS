//! Resilience: Git Checkpoint & Global Lock - SPEC.md Section 13.3 기반
//!
//! 부분 실패 시 롤백(Time Machine)과 파일 시스템 충돌 방지(Global Lock)를 구현합니다.

use std::path::Path;
use std::sync::Arc;
use parking_lot::RwLock;
use anyhow::{Result, Context};
use git2::{Repository, Signature};

/// Global Lock for File System
pub static GLOBAL_LOCK: once_cell::sync::Lazy<Arc<RwLock<()>>> = 
    once_cell::sync::Lazy::new(|| Arc::new(RwLock::new(())));

/// Git Checkpoint Manager
pub struct GitCheckpoint {
    repo: Repository,
}

impl GitCheckpoint {
    /// 리포지토리 열기 또는 초기화
    pub fn open_or_init(path: &Path) -> Result<Self> {
        let repo = match Repository::open(path) {
            Ok(repo) => repo,
            Err(_) => Repository::init(path)
                .context("Failed to initialize git repository")?,
        };
        
        Ok(Self { repo })
    }
    
    /// 체크포인트 생성 (Task 시작 전)
    pub fn create_checkpoint(&self, task_name: &str) -> Result<String> {
        // 모든 변경사항 스테이징
        let mut index = self.repo.index()?;
        index.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)?;
        index.write()?;
        
        let tree_id = index.write_tree()?;
        let tree = self.repo.find_tree(tree_id)?;
        
        let sig = Signature::now("DAACS", "daacs@local")?;
        let message = format!("[DAACS Checkpoint] Before: {}", task_name);
        
        // HEAD가 있으면 parent로 사용
        let parent_commit = self.repo.head().ok()
            .and_then(|head| head.peel_to_commit().ok());
        
        let parents: Vec<&git2::Commit> = match &parent_commit {
            Some(commit) => vec![commit],
            None => vec![],
        };
        
        let oid = self.repo.commit(
            Some("HEAD"),
            &sig,
            &sig,
            &message,
            &tree,
            &parents,
        )?;
        
        crate::logger::status_update(&format!("Git checkpoint 생성: {}", &oid.to_string()[..7]));
        
        Ok(oid.to_string())
    }
    
    /// 롤백 (Task 실패 시)
    pub fn rollback(&self) -> Result<()> {
        let head = self.repo.head()?;
        let commit = head.peel_to_commit()?;
        
        self.repo.reset(
            commit.as_object(),
            git2::ResetType::Hard,
            None,
        )?;
        
        crate::logger::status_update("Git rollback 완료 (Time Machine)");
        
        Ok(())
    }
}

/// Global Lock을 획득하고 작업 실행
pub async fn with_global_lock<F, T>(f: F) -> T
where
    F: FnOnce() -> T,
{
    let _lock = GLOBAL_LOCK.write();
    crate::logger::status_update("Global Lock 획득");
    let result = f();
    crate::logger::status_update("Global Lock 해제");
    result
}

/// Exponential Backoff Retry
pub async fn retry_with_backoff<F, Fut, T>(
    max_retries: u32,
    mut f: F,
) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut delay = std::time::Duration::from_secs(1);

    for attempt in 0..max_retries {
        match f().await {
            Ok(result) => return Ok(result),
            Err(e) => {
                if attempt + 1 == max_retries {
                    return Err(e);
                }

                crate::logger::log_warning(&format!(
                    "Retry {}/{}: {}초 후 재시도",
                    attempt + 1,
                    max_retries,
                    delay.as_secs()
                ));

                tokio::time::sleep(delay).await;
                delay *= 2; // Exponential backoff
            }
        }
    }

    anyhow::bail!("Max retries exceeded")
}

// ============================================================================
// Fallback & Timeout 메커니즘 (SPEC.md Section 9.2)
// ============================================================================

use crate::clients::cli_client::{ModelProvider, SessionBasedCLIClient};
use std::time::Duration;
use tokio::time::timeout;

/// Fallback 체인 정의
pub fn get_fallback_chain(primary: ModelProvider) -> Vec<ModelProvider> {
    match primary {
        ModelProvider::Claude => vec![
            ModelProvider::Claude,
            ModelProvider::Gemini,
            ModelProvider::Codex,
            ModelProvider::DeepSeek,
            ModelProvider::GLM,
        ],
        ModelProvider::Codex => vec![
            ModelProvider::Codex,
            ModelProvider::Claude,
            ModelProvider::Gemini,
            ModelProvider::DeepSeek,
            ModelProvider::GLM,
        ],
        ModelProvider::Gemini => vec![
            ModelProvider::Gemini,
            ModelProvider::Claude,
            ModelProvider::Codex,
            ModelProvider::DeepSeek,
            ModelProvider::GLM,
        ],
        ModelProvider::GLM => vec![
            ModelProvider::GLM,
            ModelProvider::DeepSeek,
            ModelProvider::Claude,
            ModelProvider::Gemini,
            ModelProvider::Codex,
        ],
        ModelProvider::DeepSeek => vec![
            ModelProvider::DeepSeek,
            ModelProvider::GLM,
            ModelProvider::Claude,
            ModelProvider::Gemini,
            ModelProvider::Codex,
        ],
        ModelProvider::Custom(_) => vec![
            primary.clone(),
            ModelProvider::Claude,
            ModelProvider::Gemini,
        ],
    }
}

/// 타임아웃 포함 실행
pub async fn execute_with_timeout<F, Fut, T>(
    operation_name: &str,
    timeout_secs: u64,
    operation: F,
) -> Result<T>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    match timeout(Duration::from_secs(timeout_secs), operation()).await {
        Ok(result) => result,
        Err(_) => anyhow::bail!("{}: 타임아웃 ({}초)", operation_name, timeout_secs),
    }
}

/// Fallback 체인으로 실행
pub async fn execute_with_fallback(
    prompt: &str,
    primary_model: ModelProvider,
    working_dir: std::path::PathBuf,
    max_retries: u32,
    timeout_secs: u64,
) -> Result<(String, ModelProvider)> {
    let fallback_chain = get_fallback_chain(primary_model.clone());

    for (index, model) in fallback_chain.iter().enumerate() {
        let client = SessionBasedCLIClient::new(model.clone(), working_dir.clone());
        let model_name = format!("{:?}", model);

        crate::logger::status_update(&format!(
            "{}모델 시도: {}",
            if index > 0 { "Fallback " } else { "" },
            model_name
        ));

        // 재시도 + 타임아웃 적용
        let prompt_owned = prompt.to_string();
        let model_name_for_closure = model_name.clone();
        let result = retry_with_backoff(max_retries, || {
            let p = prompt_owned.clone();
            let c = client.clone();
            let mn = model_name_for_closure.clone();
            async move {
                execute_with_timeout(
                    &format!("{} execute", mn),
                    timeout_secs,
                    || c.execute(&p)
                ).await
            }
        }).await;

        match result {
            Ok(response) => {
                if index > 0 {
                    crate::logger::status_update(&format!(
                        "✅ Fallback 성공: {}",
                        model_name
                    ));
                }
                return Ok((response, model.clone()));
            }
            Err(e) => {
                crate::logger::log_warning(&format!(
                    "모델 {} 실패: {}",
                    model_name, e
                ));
            }
        }
    }

    anyhow::bail!("모든 Fallback 모델이 실패했습니다")
}

// ============================================================================
// Circuit Breaker (SPEC.md Section 9.3)
// ============================================================================

/// Circuit Breaker 상태
#[derive(Debug, Clone, PartialEq)]
pub enum CircuitState {
    Closed,    // 정상 작동
    Open,      // 차단 (실패 임계치 초과)
    HalfOpen,  // 테스트 중
}

/// Circuit Breaker 구현
pub struct CircuitBreaker {
    state: CircuitState,
    failure_count: u32,
    failure_threshold: u32,
    success_count: u32,
    success_threshold: u32,
    last_failure_time: Option<std::time::Instant>,
    reset_timeout: Duration,
}

impl CircuitBreaker {
    pub fn new(failure_threshold: u32, success_threshold: u32, reset_timeout_secs: u64) -> Self {
        Self {
            state: CircuitState::Closed,
            failure_count: 0,
            failure_threshold,
            success_count: 0,
            success_threshold,
            last_failure_time: None,
            reset_timeout: Duration::from_secs(reset_timeout_secs),
        }
    }

    /// 요청 허용 여부 확인
    pub fn allow_request(&mut self) -> bool {
        match self.state {
            CircuitState::Closed => true,
            CircuitState::Open => {
                if let Some(last_failure) = self.last_failure_time {
                    if last_failure.elapsed() >= self.reset_timeout {
                        self.state = CircuitState::HalfOpen;
                        self.success_count = 0;
                        return true;
                    }
                }
                false
            }
            CircuitState::HalfOpen => true,
        }
    }

    /// 성공 기록
    pub fn record_success(&mut self) {
        match self.state {
            CircuitState::Closed => {
                self.failure_count = 0;
            }
            CircuitState::HalfOpen => {
                self.success_count += 1;
                if self.success_count >= self.success_threshold {
                    self.state = CircuitState::Closed;
                    self.failure_count = 0;
                    crate::logger::status_update("Circuit Breaker: Closed (복구됨)");
                }
            }
            CircuitState::Open => {}
        }
    }

    /// 실패 기록
    pub fn record_failure(&mut self) {
        match self.state {
            CircuitState::Closed => {
                self.failure_count += 1;
                if self.failure_count >= self.failure_threshold {
                    self.state = CircuitState::Open;
                    self.last_failure_time = Some(std::time::Instant::now());
                    crate::logger::log_warning(&format!(
                        "Circuit Breaker: Open (연속 {} 실패)",
                        self.failure_count
                    ));
                }
            }
            CircuitState::HalfOpen => {
                self.state = CircuitState::Open;
                self.last_failure_time = Some(std::time::Instant::now());
                self.success_count = 0;
            }
            CircuitState::Open => {}
        }
    }

    /// 현재 상태 반환
    pub fn state(&self) -> &CircuitState {
        &self.state
    }
}
