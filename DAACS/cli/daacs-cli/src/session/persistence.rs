//! 세션 영속성 관리 - SPEC.md Section 3.3 기반
//!
//! 세션을 파일에 저장하고 복원합니다. (~/.daacs/sessions/)

use anyhow::{Result, Context};
use std::path::PathBuf;
use tokio::fs;
use crate::session::session::Session;

/// 세션 저장소 경로
fn get_session_dir() -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".daacs").join("sessions")
}

/// 세션 저장
pub async fn save_session(session: &Session) -> Result<()> {
    let dir = get_session_dir();
    if !dir.exists() {
        fs::create_dir_all(&dir).await?;
    }
    
    let path = dir.join(format!("{}.json", session.id));
    let content = serde_json::to_string_pretty(session)?;
    
    fs::write(path, content).await?;
    Ok(())
}

/// 세션 로드
pub async fn load_session(id: &str) -> Result<Session> {
    let dir = get_session_dir();
    let path = dir.join(format!("{}.json", id));
    
    let content = fs::read_to_string(&path).await
        .context(format!("Session file not found: {}", id))?;
        
    let session: Session = serde_json::from_str(&content)?;
    Ok(session)
}

/// 최신 세션 로드
pub async fn load_latest_session() -> Result<Session> {
    let dir = get_session_dir();
    let mut entries = fs::read_dir(&dir).await?;
    
    let mut latest_session: Option<(Session, std::time::SystemTime)> = None;
    
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(metadata) = fs::metadata(&path).await {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(content) = fs::read_to_string(&path).await {
                        if let Ok(session) = serde_json::from_str::<Session>(&content) {
                            match latest_session {
                                Some((_, latest_time)) => {
                                    if modified > latest_time {
                                        latest_session = Some((session, modified));
                                    }
                                }
                                None => {
                                    latest_session = Some((session, modified));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    latest_session.map(|(s, _)| s).context("No sessions found")
}

/// 세션 목록 조회
pub async fn list_sessions() -> Result<Vec<Session>> {
    let dir = get_session_dir();
    if !dir.exists() {
        return Ok(Vec::new());
    }
    
    let mut entries = fs::read_dir(&dir).await?;
    let mut sessions = Vec::new();
    
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("json") {
            if let Ok(content) = fs::read_to_string(&path).await {
                if let Ok(session) = serde_json::from_str::<Session>(&content) {
                    sessions.push(session);
                }
            }
        }
    }
    
    // 최신순 정렬
    sessions.sort_by(|a, b| b.last_active_at.cmp(&a.last_active_at));
    
    Ok(sessions)
}
