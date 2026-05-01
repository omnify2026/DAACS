//! Checkpoint 관리 - 워크플로우 상태 저장/복원
//!
//! CLIState를 파일에 저장하고 복원하여 중단된 작업을 재개할 수 있게 합니다.

use anyhow::{Result, Context};
use std::path::PathBuf;
use tokio::fs;
use crate::graph::state::CLIState;

/// Checkpoint 저장소 경로
fn get_checkpoint_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".daacs").join("checkpoints")
}

/// Checkpoint 저장 (CLIState 전체 저장)
pub async fn save_checkpoint(state: &CLIState, session_id: &str) -> Result<()> {
    let dir = get_checkpoint_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).await?;
    }

    let path = dir.join(format!("{}.json", session_id));
    let content = serde_json::to_string_pretty(state)?;

    fs::write(path, content).await?;

    crate::logger::status_update(&format!("💾 Checkpoint 저장: {}", session_id));

    Ok(())
}

/// Checkpoint 로드 (CLIState 복원)
pub async fn load_checkpoint(session_id: &str) -> Result<CLIState> {
    let dir = get_checkpoint_dir();
    let path = dir.join(format!("{}.json", session_id));

    if !path.exists() {
        anyhow::bail!("Checkpoint가 존재하지 않습니다: {}", session_id);
    }

    let content = fs::read_to_string(&path).await
        .context(format!("Checkpoint 파일 읽기 실패: {}", session_id))?;

    let state: CLIState = serde_json::from_str(&content)?;

    crate::logger::status_update(&format!("📂 Checkpoint 로드: {}", session_id));
    crate::logger::status_update(&format!("  현재 Phase: {:?}", state.current_phase));
    crate::logger::status_update(&format!("  완료된 Task: {}/{}",
        state.tasks.iter().filter(|t| matches!(t.status, crate::graph::state::TaskStatus::Completed)).count(),
        state.tasks.len()
    ));

    Ok(state)
}

/// 최신 Checkpoint 로드
pub async fn load_latest_checkpoint() -> Result<CLIState> {
    let dir = get_checkpoint_dir();
    if !dir.exists() {
        anyhow::bail!("Checkpoint가 존재하지 않습니다");
    }

    let mut entries = fs::read_dir(&dir).await?;
    let mut latest_checkpoint: Option<(CLIState, std::time::SystemTime)> = None;

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(metadata) = fs::metadata(&path).await {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(content) = fs::read_to_string(&path).await {
                        if let Ok(state) = serde_json::from_str::<CLIState>(&content) {
                            match latest_checkpoint {
                                Some((_, latest_time)) => {
                                    if modified > latest_time {
                                        latest_checkpoint = Some((state, modified));
                                    }
                                }
                                None => {
                                    latest_checkpoint = Some((state, modified));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    latest_checkpoint.map(|(s, _)| s).context("Checkpoint를 찾을 수 없습니다")
}

/// Checkpoint 목록 조회
pub async fn list_checkpoints() -> Result<Vec<CheckpointInfo>> {
    let dir = get_checkpoint_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = fs::read_dir(&dir).await?;
    let mut checkpoints = Vec::new();

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path).await {
                if let Ok(state) = serde_json::from_str::<CLIState>(&content) {
                    if let Ok(metadata) = fs::metadata(&path).await {
                        if let Ok(modified) = metadata.modified() {
                            checkpoints.push(CheckpointInfo {
                                session_id: path.file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or("unknown")
                                    .to_string(),
                                goal: state.goal.clone(),
                                current_phase: state.current_phase.clone(),
                                tasks_completed: state.tasks.iter()
                                    .filter(|t| matches!(t.status, crate::graph::state::TaskStatus::Completed))
                                    .count(),
                                tasks_total: state.tasks.len(),
                                modified_at: modified,
                            });
                        }
                    }
                }
            }
        }
    }

    // 최신순 정렬
    checkpoints.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    Ok(checkpoints)
}

/// Checkpoint 정보
#[derive(Debug, Clone)]
pub struct CheckpointInfo {
    pub session_id: String,
    pub goal: String,
    pub current_phase: crate::graph::state::Phase,
    pub tasks_completed: usize,
    pub tasks_total: usize,
    pub modified_at: std::time::SystemTime,
}

/// Checkpoint 삭제
pub async fn delete_checkpoint(session_id: &str) -> Result<()> {
    let dir = get_checkpoint_dir();
    let path = dir.join(format!("{}.json", session_id));

    if path.exists() {
        fs::remove_file(path).await?;
        crate::logger::status_update(&format!("🗑️  Checkpoint 삭제: {}", session_id));
    }

    Ok(())
}

/// 오래된 Checkpoint 정리 (30일 이상)
pub async fn cleanup_old_checkpoints(days: u64) -> Result<usize> {
    let dir = get_checkpoint_dir();
    if !dir.exists() {
        return Ok(0);
    }

    let mut entries = fs::read_dir(&dir).await?;
    let mut deleted_count = 0;
    let cutoff = std::time::SystemTime::now() - std::time::Duration::from_secs(days * 24 * 60 * 60);

    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if let Ok(metadata) = fs::metadata(&path).await {
            if let Ok(modified) = metadata.modified() {
                if modified < cutoff
                    && fs::remove_file(&path).await.is_ok() {
                        deleted_count += 1;
                    }
            }
        }
    }

    if deleted_count > 0 {
        crate::logger::status_update(&format!("🗑️  오래된 Checkpoint {} 개 정리 완료", deleted_count));
    }

    Ok(deleted_count)
}
