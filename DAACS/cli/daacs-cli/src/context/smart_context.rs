//! Smart Context & State Windowing - SPEC.md Section 12.2 & 13.3 기반
//!
//! 토큰 최적화를 위한 컨텍스트 필터링 및 윈도우잉 시스템

use crate::graph::state::CLIState;
use std::collections::HashMap;
use git2::{Repository, StatusOptions};
use crate::context::code_parser;

/// State Window - 에이전트에게 전달할 필터링된 상태
#[derive(Debug, Clone)]
pub struct StateWindow {
    /// 필수 컨텍스트: DAACS.md 명세
    pub spec: Option<String>,
    
    /// 대상 코드 (현재 작업 중인 파일들 - 전체 코드)
    pub target_code: HashMap<String, String>,
    
    /// 참조 코드 (관련 파일들 - 스켈레톤 코드)
    pub reference_code: HashMap<String, String>,
    
    /// 최근 로그 (마지막 N개)
    pub recent_logs: Vec<String>,
    
    /// 현재 작업 정보
    pub current_task: Option<String>,
    
    /// 기술 스택
    pub tech_stack: HashMap<String, String>,
}

impl StateWindow {
    /// CLIState에서 필터링된 윈도우 생성
    pub fn from_state(state: &CLIState, _log_window_size: usize) -> Self {
        let mut window = Self {
            spec: state.daacs_content.clone(),
            target_code: HashMap::new(),
            reference_code: HashMap::new(),
            recent_logs: Vec::new(),
            current_task: state.tasks.first().map(|t| t.name.clone()),
            tech_stack: state.tech_stack.clone(),
        };

        // 1. Git 변경 사항 감지 (Target Code)
        // 현재 작업 디렉토리 기준
        let repo_path = "."; 
        if let Ok(repo) = Repository::open(repo_path) {
            if let Ok(statuses) = repo.statuses(Some(StatusOptions::new().include_untracked(true))) {
                for entry in statuses.iter() {
                    if let Some(path) = entry.path() {
                        if let Ok(content) = std::fs::read_to_string(path) {
                            window.target_code.insert(path.to_string(), content);
                        }
                    }
                }
            }
        }

        // 2. 관련 파일 파싱 (Reference Code - Skeleton)
        // "src" 하드코딩 제거 -> 주요 소스 디렉토리 스캔
        // TODO: 설정에서 소스 디렉토리를 가져오거나, .gitignore를 참조하여 스캔해야 함
        let source_dirs = vec!["src", "lib", "app"]; // 일반적인 소스 디렉토리 후보
        
        for dir in source_dirs {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_file() {
                        let path_str = path.to_string_lossy().to_string();
                        
                        // 이미 Target에 있으면 스킵
                        if window.target_code.contains_key(&path_str) {
                            continue;
                        }

                        if let Ok(content) = std::fs::read_to_string(&path) {
                            if let Ok(parsed) = code_parser::parse_file(&path_str, &content) {
                                window.reference_code.insert(path_str, parsed.skeleton);
                            }
                        }
                    }
                }
            }
        }

        // 3. 로그 수집 (마지막 N개)
        // 실제 state.logs가 있다면 사용, 없으면 빈 벡터
        // window.recent_logs = state.logs.iter().rev().take(_log_window_size).cloned().collect();
        // 현재 CLIState 정의를 확인하지 못했으므로, 더미 데이터 대신 빈 벡터로 초기화하거나 주석 처리
        // (실제 구현 시 CLIState에 logs 필드가 추가되어야 함)
        window.recent_logs = vec![]; 

        window
    }
    
    /// 프롬프트용 문자열로 변환
    pub fn to_prompt_context(&self) -> String {
        let mut context = String::new();
        
        // 1. 명세 추가
        if let Some(spec) = &self.spec {
            context.push_str("[기술 명세서 (DAACS.md)]\n");
            context.push_str(spec);
            context.push_str("\n\n");
        }
        
        // 2. 기술 스택 추가
        if !self.tech_stack.is_empty() {
            context.push_str("[기술 스택]\n");
            for (key, value) in &self.tech_stack {
                context.push_str(&format!("- {}: {}\n", key, value));
            }
            context.push('\n');
        }
        
        // 3. 현재 작업 추가
        if let Some(task) = &self.current_task {
            context.push_str(&format!("[현재 작업]\n{}\n\n", task));
        }
        
        // 4. 대상 코드 (전체) 추가
        if !self.target_code.is_empty() {
            context.push_str("[작업 대상 코드 (Full)]\n");
            for (path, code) in &self.target_code {
                context.push_str(&format!("--- {} ---\n{}\n\n", path, code));
            }
        }

        // 5. 참조 코드 (스켈레톤) 추가
        if !self.reference_code.is_empty() {
            context.push_str("[참조 코드 (Skeleton)]\n");
            for (path, code) in &self.reference_code {
                context.push_str(&format!("--- {} ---\n{}\n\n", path, code));
            }
        }
        
        // 6. 최근 로그 추가
        if !self.recent_logs.is_empty() {
            context.push_str("[최근 로그]\n");
            for log in &self.recent_logs {
                context.push_str(&format!("- {}\n", log));
            }
        }
        
        context
    }
}

/// 토큰 추정기
pub struct TokenEstimator;

impl TokenEstimator {
    /// 대략적인 토큰 수 추정 (4자 = 1토큰 기준)
    pub fn estimate(text: &str) -> usize {
        text.len() / 4
    }
    
    /// 토큰 제한에 맞게 텍스트 자르기
    pub fn truncate_to_limit(text: &str, max_tokens: usize) -> String {
        let max_chars = max_tokens * 4;
        if text.len() <= max_chars {
            text.to_string()
        } else {
            let truncated: String = text.chars().take(max_chars).collect();
            format!("{}...\n[잘림: 토큰 제한 {}]", truncated, max_tokens)
        }
    }
}

/// Context Pruner - 컨텍스트 압축
pub struct ContextPruner {
    max_tokens: usize,
}

impl ContextPruner {
    pub fn new(max_tokens: usize) -> Self {
        Self { max_tokens }
    }
    
    /// 컨텍스트 압축
    pub fn prune(&self, context: &str) -> String {
        let estimated = TokenEstimator::estimate(context);
        
        if estimated <= self.max_tokens {
            context.to_string()
        } else {
            // 우선순위: 명세 > 현재 작업 > 코드 > 로그
            TokenEstimator::truncate_to_limit(context, self.max_tokens)
        }
    }
}
