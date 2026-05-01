//! FileTracker - 프로젝트 내 파일 상태 추적
//!
//! 기존 파일을 추적하여 LLM이 전체 파일 대신 diff만 생성하도록 지원

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use anyhow::Result;
use sha2::{Sha256, Digest};

/// 파일 상태 정보
#[derive(Debug, Clone)]
pub struct FileState {
    pub path: PathBuf,
    pub relative_path: String,
    pub hash: String,
    pub line_count: usize,
    pub byte_size: usize,
    pub summary: String,  // LLM 컨텍스트용 요약 (50자 이내)
}

impl FileState {
    pub fn from_path(base: &Path, path: &Path) -> Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let hash = format!("{:x}", Sha256::digest(content.as_bytes()))[..8].to_string();
        let line_count = content.lines().count();
        let byte_size = content.len();
        
        let relative_path = path.strip_prefix(base)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| path.to_string_lossy().to_string());
        
        // 파일 요약 생성 (함수/구조체 이름 추출)
        let summary = generate_summary(&content, &relative_path);
        
        Ok(Self {
            path: path.to_path_buf(),
            relative_path,
            hash,
            line_count,
            byte_size,
            summary,
        })
    }
    
    /// LLM 프롬프트용 컨텍스트 문자열 생성
    pub fn to_context(&self) -> String {
        format!(
            "[기존 파일: {}] ({} 줄, {}) - {}",
            self.relative_path,
            self.line_count,
            self.hash,
            self.summary
        )
    }
}

/// 파일 트래커
pub struct FileTracker {
    base_path: PathBuf,
    files: HashMap<String, FileState>,
    extensions: Vec<String>,
}

impl FileTracker {
    pub fn new(base_path: &Path) -> Self {
        Self {
            base_path: base_path.to_path_buf(),
            files: HashMap::new(),
            extensions: vec![
                "rs".to_string(), "py".to_string(), "ts".to_string(), 
                "tsx".to_string(), "js".to_string(), "jsx".to_string(),
                "html".to_string(), "css".to_string(), "json".to_string(),
                "toml".to_string(), "yaml".to_string(), "md".to_string(),
            ],
        }
    }
    
    /// 프로젝트 스캔 및 파일 추적
    pub fn scan(&mut self) -> Result<usize> {
        self.files.clear();
        self.scan_dir(&self.base_path.clone())?;
        Ok(self.files.len())
    }
    
    fn scan_dir(&mut self, dir: &Path) -> Result<()> {
        if !dir.exists() || !dir.is_dir() {
            return Ok(());
        }
        
        // 무시할 디렉토리
        let dir_name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(dir_name, "target" | "node_modules" | ".git" | ".daacs" | "__pycache__" | "dist" | "build") {
            return Ok(());
        }
        
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            
            if path.is_dir() {
                self.scan_dir(&path)?;
            } else if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if self.extensions.contains(&ext.to_lowercase()) {
                        if let Ok(state) = FileState::from_path(&self.base_path, &path) {
                            self.files.insert(state.relative_path.clone(), state);
                        }
                    }
                }
            }
        }
        
        Ok(())
    }
    
    /// 특정 파일이 존재하는지 확인
    pub fn exists(&self, relative_path: &str) -> bool {
        self.files.contains_key(relative_path)
    }
    
    /// 파일 상태 가져오기
    pub fn get(&self, relative_path: &str) -> Option<&FileState> {
        self.files.get(relative_path)
    }
    
    /// 모든 파일 목록
    pub fn all_files(&self) -> Vec<&FileState> {
        self.files.values().collect()
    }
    
    /// LLM 프롬프트용 컨텍스트 생성 (관련 파일만)
    pub fn build_context(&self, keywords: &[&str]) -> String {
        let relevant: Vec<_> = self.files.values()
            .filter(|f| {
                let path_lower = f.relative_path.to_lowercase();
                let summary_lower = f.summary.to_lowercase();
                keywords.iter().any(|kw| {
                    path_lower.contains(&kw.to_lowercase()) || 
                    summary_lower.contains(&kw.to_lowercase())
                })
            })
            .take(10)  // 최대 10개 파일
            .collect();
        
        if relevant.is_empty() {
            return String::new();
        }
        
        let mut context = String::from("[프로젝트 기존 파일]\n");
        for file in relevant {
            context.push_str(&format!("- {}\n", file.to_context()));
        }
        context.push_str("\n※ 기존 파일 수정 시 전체 재작성 대신 변경점(diff)만 출력하세요.\n");
        
        context
    }
    
    /// 파일 변경 후 상태 업데이트
    pub fn update(&mut self, relative_path: &str) -> Result<()> {
        let full_path = self.base_path.join(relative_path);
        if full_path.exists() {
            let state = FileState::from_path(&self.base_path, &full_path)?;
            self.files.insert(relative_path.to_string(), state);
        } else {
            self.files.remove(relative_path);
        }
        Ok(())
    }
}

/// 파일 내용에서 요약 생성
fn generate_summary(content: &str, path: &str) -> String {
    let ext = path.rsplit('.').next().unwrap_or("");
    
    match ext {
        "rs" => extract_rust_summary(content),
        "py" => extract_python_summary(content),
        "ts" | "tsx" | "js" | "jsx" => extract_js_summary(content),
        _ => truncate_first_line(content),
    }
}

fn extract_rust_summary(content: &str) -> String {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("pub struct ") || trimmed.starts_with("struct ") {
            if let Some(name) = trimmed.split_whitespace().nth(2).or_else(|| trimmed.split_whitespace().nth(1)) {
                items.push(format!("struct {}", name.trim_end_matches('{')));
            }
        } else if trimmed.starts_with("pub fn ") || trimmed.starts_with("fn ") || trimmed.starts_with("pub async fn ") || trimmed.starts_with("async fn ") {
            if let Some(name) = trimmed.split('(').next() {
                let fn_name = name.split_whitespace().last().unwrap_or("");
                items.push(format!("fn {}", fn_name));
            }
        }
        if items.len() >= 3 { break; }
    }
    if items.is_empty() { truncate_first_line(content) } else { items.join(", ") }
}

fn extract_python_summary(content: &str) -> String {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("class ") {
            if let Some(name) = trimmed.strip_prefix("class ").and_then(|s| s.split(['(', ':']).next()) {
                items.push(format!("class {}", name.trim()));
            }
        } else if trimmed.starts_with("def ") || trimmed.starts_with("async def ") {
            if let Some(name) = trimmed.split('(').next() {
                let fn_name = name.split_whitespace().last().unwrap_or("");
                items.push(format!("def {}", fn_name));
            }
        }
        if items.len() >= 3 { break; }
    }
    if items.is_empty() { truncate_first_line(content) } else { items.join(", ") }
}

fn extract_js_summary(content: &str) -> String {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.contains("function ") || trimmed.contains("const ") && trimmed.contains(" = ") {
            if let Some(name) = trimmed.split(['(', '=', ':']).next() {
                let parts: Vec<_> = name.split_whitespace().collect();
                if let Some(fn_name) = parts.last() {
                    items.push(fn_name.to_string());
                }
            }
        } else if trimmed.starts_with("export ") || trimmed.starts_with("class ") {
            if let Some(name) = trimmed.split_whitespace().find(|w| w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)) {
                items.push(name.to_string());
            }
        }
        if items.len() >= 3 { break; }
    }
    if items.is_empty() { truncate_first_line(content) } else { items.join(", ") }
}

fn truncate_first_line(content: &str) -> String {
    content.lines().next()
        .map(|l| if l.chars().count() > 50 { format!("{}...", l.chars().take(47).collect::<String>()) } else { l.to_string() })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_rust_summary() {
        let content = r#"
pub struct User {
    name: String,
}

pub fn create_user() {}
pub async fn get_user() {}
"#;
        let summary = extract_rust_summary(content);
        assert!(summary.contains("struct User"));
        assert!(summary.contains("fn create_user"));
    }
}
