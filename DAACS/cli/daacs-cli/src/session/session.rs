//! 세션 상태 관리 - SPEC.md Section 3.3 기반
//!
//! 세션 ID, 시작 시간, 마지막 활동 시간 등을 관리합니다.

use serde::{Serialize, Deserialize};
use chrono::{DateTime, Local};
use uuid::Uuid;
use std::collections::HashMap;

/// 세션 정보
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub created_at: DateTime<Local>,
    pub last_active_at: DateTime<Local>,
    pub metadata: HashMap<String, String>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    /// 새 세션 생성
    pub fn new() -> Self {
        let now = Local::now();
        Self {
            id: Uuid::new_v4().to_string(),
            created_at: now,
            last_active_at: now,
            metadata: HashMap::new(),
        }
    }
    
    /// 활동 시간 갱신
    pub fn touch(&mut self) {
        self.last_active_at = Local::now();
    }
    
    /// 메타데이터 설정
    pub fn set_metadata(&mut self, key: &str, value: &str) {
        self.metadata.insert(key.to_string(), value.to_string());
        self.touch();
    }
    
    /// 메타데이터 가져오기
    pub fn get_metadata(&self, key: &str) -> Option<&String> {
        self.metadata.get(key)
    }
}
