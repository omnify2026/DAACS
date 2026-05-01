//! DiffPatchAgent - 파일 수정을 위한 diff/patch 처리
//!
//! LLM 출력에서 unified diff를 추출하고 기존 파일에 패치 적용

use std::path::Path;
use anyhow::{Result, Context};
use regex::Regex;

/// Diff 청크 (하나의 변경 블록)
#[derive(Debug, Clone)]
pub struct DiffChunk {
    pub file_path: String,
    pub operation: DiffOperation,
    pub old_start: usize,
    pub old_count: usize,
    pub new_start: usize,
    pub new_count: usize,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DiffOperation {
    Create,   // 새 파일 생성
    Modify,   // 기존 파일 수정
    Delete,   // 파일 삭제
}

#[derive(Debug, Clone)]
pub struct DiffLine {
    pub kind: LineKind,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum LineKind {
    Context,  // 변경 없음 (공백으로 시작)
    Add,      // 추가 (+로 시작)
    Remove,   // 삭제 (-로 시작)
}

/// LLM 출력에서 diff 추출 및 적용
pub struct DiffPatcher;

impl DiffPatcher {
    /// LLM 출력에서 diff 블록들 추출
    pub fn extract_diffs(response: &str) -> Vec<DiffChunk> {
        let mut chunks = Vec::new();
        
        // diff 블록 패턴: ```diff ... ```
        let diff_block_re = Regex::new(r"```diff\s*\n([\s\S]*?)```").unwrap();
        
        for cap in diff_block_re.captures_iter(response) {
            let diff_content = &cap[1];
            if let Some(chunk) = Self::parse_diff_block(diff_content) {
                chunks.push(chunk);
            }
        }
        
        // unified diff 헤더 패턴: --- a/file ... +++ b/file
        let unified_re = Regex::new(r"---\s+a/([^\n]+)\n\+\+\+\s+b/([^\n]+)\n((?:@@[^\n]+\n(?:[+\-\s][^\n]*\n?)*)+)").unwrap();
        
        for cap in unified_re.captures_iter(response) {
            let file_path = cap[2].to_string();
            let hunks = &cap[3];
            
            if let Some(chunk) = Self::parse_unified_hunks(&file_path, hunks) {
                chunks.push(chunk);
            }
        }
        
        chunks
    }
    
    /// 단일 diff 블록 파싱
    fn parse_diff_block(content: &str) -> Option<DiffChunk> {
        let lines: Vec<_> = content.lines().collect();
        if lines.is_empty() {
            return None;
        }
        
        // 파일 경로 추출 시도
        let mut file_path = String::new();
        let mut start_idx = 0;
        
        for (i, line) in lines.iter().enumerate() {
            if line.starts_with("--- ") || line.starts_with("+++ ") {
                if let Some(path) = line.split_whitespace().nth(1) {
                    let clean_path = path.trim_start_matches("a/").trim_start_matches("b/");
                    if !clean_path.is_empty() && clean_path != "/dev/null" {
                        file_path = clean_path.to_string();
                    }
                }
            }
            if line.starts_with("@@") {
                start_idx = i;
                break;
            }
        }
        
        if file_path.is_empty() {
            return None;
        }
        
        // 헝크 헤더 파싱: @@ -start,count +start,count @@
        let hunk_re = Regex::new(r"@@\s*-(\d+)(?:,(\d+))?\s*\+(\d+)(?:,(\d+))?\s*@@").unwrap();
        
        let mut diff_lines = Vec::new();
        let mut old_start = 1;
        let mut old_count = 0;
        let mut new_start = 1;
        let mut new_count = 0;
        
        for line in &lines[start_idx..] {
            if let Some(cap) = hunk_re.captures(line) {
                old_start = cap[1].parse().unwrap_or(1);
                old_count = cap.get(2).map(|m| m.as_str().parse().unwrap_or(1)).unwrap_or(1);
                new_start = cap[3].parse().unwrap_or(1);
                new_count = cap.get(4).map(|m| m.as_str().parse().unwrap_or(1)).unwrap_or(1);
            } else if line.starts_with('+') && !line.starts_with("+++") {
                diff_lines.push(DiffLine {
                    kind: LineKind::Add,
                    content: line[1..].to_string(),
                });
            } else if line.starts_with('-') && !line.starts_with("---") {
                diff_lines.push(DiffLine {
                    kind: LineKind::Remove,
                    content: line[1..].to_string(),
                });
            } else if line.starts_with(' ') || (!line.starts_with('@') && !line.is_empty()) {
                let content = if line.starts_with(' ') { &line[1..] } else { line };
                diff_lines.push(DiffLine {
                    kind: LineKind::Context,
                    content: content.to_string(),
                });
            }
        }
        
        let operation = if old_count == 0 && new_count > 0 {
            DiffOperation::Create
        } else if old_count > 0 && new_count == 0 {
            DiffOperation::Delete
        } else {
            DiffOperation::Modify
        };
        
        Some(DiffChunk {
            file_path,
            operation,
            old_start,
            old_count,
            new_start,
            new_count,
            lines: diff_lines,
        })
    }
    
    /// Unified diff 헝크 파싱
    fn parse_unified_hunks(file_path: &str, hunks: &str) -> Option<DiffChunk> {
        Self::parse_diff_block(&format!("--- a/{}\n+++ b/{}\n{}", file_path, file_path, hunks))
    }
    
    /// 패치 적용
    pub fn apply_patch(base_path: &Path, chunk: &DiffChunk) -> Result<String> {
        // [Safety Check] 블랙리스트 파일 보호
        if is_protected_file(&chunk.file_path) {
            return Err(anyhow::anyhow!("🚫 Protected file access blocked: {}", chunk.file_path));
        }

        // Path Sanity Check
        if chunk.file_path.contains("..") || chunk.file_path.starts_with("/") || chunk.file_path.contains(":") {
             return Err(anyhow::anyhow!("🚫 Unsafe file path blocked: {}", chunk.file_path));
        }

        let file_path = base_path.join(&chunk.file_path);
        
        match chunk.operation {
            DiffOperation::Create => {
                // 새 파일 생성
                let content: String = chunk.lines.iter()
                    .filter(|l| l.kind == LineKind::Add || l.kind == LineKind::Context)
                    .map(|l| format!("{}\n", l.content))
                    .collect();
                
                if let Some(parent) = file_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&file_path, &content)?;
                Ok(format!("Created: {}", chunk.file_path))
            }
            DiffOperation::Delete => {
                if file_path.exists() {
                    std::fs::remove_file(&file_path)?;
                }
                Ok(format!("Deleted: {}", chunk.file_path))
            }
            DiffOperation::Modify => {
                if !file_path.exists() {
                    anyhow::bail!("파일이 존재하지 않습니다: {}", chunk.file_path);
                }
                
                let original = std::fs::read_to_string(&file_path)
                    .with_context(|| format!("파일 읽기 실패: {}", chunk.file_path))?;
                
                let patched = Self::apply_hunk(&original, chunk)?;
                std::fs::write(&file_path, &patched)?;
                
                Ok(format!("Modified: {} ({} lines changed)", chunk.file_path, chunk.lines.len()))
            }
        }
    }
    
    /// 헝크를 파일 내용에 적용
    fn apply_hunk(original: &str, chunk: &DiffChunk) -> Result<String> {
        let lines: Vec<_> = original.lines().collect();
        let mut result = Vec::new();
        
        // old_start는 1-indexed
        let start_idx = chunk.old_start.saturating_sub(1);
        
        // 변경 전 라인들 복사
        for line in lines.iter().take(start_idx) {
            result.push(line.to_string());
        }
        
        // diff 적용
        let mut original_idx = start_idx;
        for diff_line in &chunk.lines {
            match diff_line.kind {
                LineKind::Context => {
                    // 원본과 일치하는지 확인 (옵션)
                    result.push(diff_line.content.clone());
                    original_idx += 1;
                }
                LineKind::Add => {
                    result.push(diff_line.content.clone());
                }
                LineKind::Remove => {
                    // 원본에서 해당 라인 스킵
                    original_idx += 1;
                }
            }
        }
        
        // 나머지 라인들 복사
        for line in lines.iter().skip(original_idx) {
            result.push(line.to_string());
        }
        
        Ok(result.join("\n"))
    }
    
    /// 응답에 diff가 포함되어 있는지 확인
    pub fn contains_diff(response: &str) -> bool {
        response.contains("```diff") || 
        response.contains("--- a/") ||
        response.contains("@@ -")
    }
    
    /// 응답에 전체 파일 블록이 포함되어 있는지 확인
    pub fn contains_file_blocks(response: &str) -> bool {
        response.contains("### File:") || response.contains("```rust") || 
        response.contains("```python") || response.contains("```typescript")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_extract_diff() {
        let response = r#"
변경사항:

```diff
--- a/src/main.rs
+++ b/src/main.rs
@@ -10,3 +10,5 @@
 fn main() {
+    println!("Hello");
+    println!("World");
 }
```
"#;
        let diffs = DiffPatcher::extract_diffs(response);
        assert_eq!(diffs.len(), 1);
        assert_eq!(diffs[0].file_path, "src/main.rs");
        assert_eq!(diffs[0].operation, DiffOperation::Modify);
    }
    
    #[test]
    fn test_apply_hunk() {
        let original = "line1\nline2\nline3\n";
        let chunk = DiffChunk {
            file_path: "test.txt".to_string(),
            operation: DiffOperation::Modify,
            old_start: 2,
            old_count: 1,
            new_start: 2,
            new_count: 2,
            lines: vec![
                DiffLine { kind: LineKind::Remove, content: "line2".to_string() },
                DiffLine { kind: LineKind::Add, content: "new_line2".to_string() },
                DiffLine { kind: LineKind::Add, content: "new_line2b".to_string() },
            ],
        };
        
        let result = DiffPatcher::apply_hunk(original, &chunk).unwrap();
        assert!(result.contains("new_line2"));
        assert!(result.contains("new_line2b"));
        assert!(!result.contains("line2\n"));
    }
}

/// 보호된 파일인지 확인 (블랙리스트)
fn is_protected_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    matches!(
        lower.as_str(),
        "daacs.md" | "plan.md" | "task.md" | "review.md" | "test_report.md" | "design.md"
    ) || lower.starts_with(".daacs") 
      || lower.starts_with(".git")
      || lower.starts_with("target")
}
