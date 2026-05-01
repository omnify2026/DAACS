//! REVIEW.md 파서 - 구조화된 이슈 추출
//!
//! REVIEW.md 내용을 파싱하여 카테고리, 심각도, 파일 경로, 설명을 추출합니다.

use std::path::PathBuf;

/// 이슈 심각도
#[derive(Debug, Clone, PartialEq)]
pub enum IssueLevel {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

impl IssueLevel {
    fn from_str(s: &str) -> Self {
        let lower = s.to_lowercase();
        if lower.contains("critical") || lower.contains("치명") {
            IssueLevel::Critical
        } else if lower.contains("high") || lower.contains("높음") || lower.contains("심각") {
            IssueLevel::High
        } else if lower.contains("medium") || lower.contains("중간") {
            IssueLevel::Medium
        } else if lower.contains("low") || lower.contains("낮음") {
            IssueLevel::Low
        } else {
            IssueLevel::Info
        }
    }
    
    pub fn priority(&self) -> u8 {
        match self {
            IssueLevel::Critical => 1,
            IssueLevel::High => 2,
            IssueLevel::Medium => 3,
            IssueLevel::Low => 4,
            IssueLevel::Info => 5,
        }
    }
}

/// 추출된 리뷰 이슈
#[derive(Debug, Clone)]
pub struct ReviewIssue {
    pub category: String,
    pub severity: IssueLevel,
    pub file_path: Option<PathBuf>,
    pub line_range: Option<(u32, u32)>,
    pub description: String,
    pub raw_text: String,
}

/// REVIEW.md 내용을 파싱하여 이슈 목록 반환
pub fn parse_review_md(content: &str) -> Vec<ReviewIssue> {
    let mut issues = Vec::new();
    let mut current_category = "일반".to_string();
    let mut current_section_lines = Vec::new();
    
    for line in content.lines() {
        // 카테고리 감지 (## 헤더)
        if line.starts_with("## ") {
            // 이전 섹션 처리
            if !current_section_lines.is_empty() {
                if let Some(issue) = extract_issue_from_section(&current_category, &current_section_lines) {
                    issues.push(issue);
                }
                current_section_lines.clear();
            }
            
            let header = line.trim_start_matches('#').trim();
            current_category = categorize_header(header);
        }
        // 이슈 항목 감지 (- 또는 *)
        else if line.trim().starts_with('-') || line.trim().starts_with('*') {
            // 이전 항목 처리
            if !current_section_lines.is_empty() {
                if let Some(issue) = extract_issue_from_section(&current_category, &current_section_lines) {
                    issues.push(issue);
                }
                current_section_lines.clear();
            }
            current_section_lines.push(line.to_string());
        }
        // 연속 라인
        else if !line.trim().is_empty() && !current_section_lines.is_empty() {
            current_section_lines.push(line.to_string());
        }
    }
    
    // 마지막 섹션 처리
    if !current_section_lines.is_empty() {
        if let Some(issue) = extract_issue_from_section(&current_category, &current_section_lines) {
            issues.push(issue);
        }
    }
    
    // 심각도 순 정렬
    issues.sort_by(|a, b| a.severity.priority().cmp(&b.severity.priority()));
    
    issues
}

/// 헤더를 카테고리로 변환
fn categorize_header(header: &str) -> String {
    let lower = header.to_lowercase();
    
    if lower.contains("사양") || lower.contains("spec") || lower.contains("요구사항") {
        "사양 준수".to_string()
    } else if lower.contains("품질") || lower.contains("quality") || lower.contains("코드") {
        "코드 품질".to_string()
    } else if lower.contains("보안") || lower.contains("security") {
        "보안".to_string()
    } else if lower.contains("성능") || lower.contains("performance") {
        "성능".to_string()
    } else if lower.contains("ui") || lower.contains("ux") || lower.contains("디자인") {
        "UI/UX".to_string()
    } else if lower.contains("test") || lower.contains("테스트") {
        "테스트".to_string()
    } else if lower.contains("문서") || lower.contains("doc") {
        "문서화".to_string()
    } else {
        "일반".to_string()
    }
}

/// 섹션에서 이슈 추출
fn extract_issue_from_section(category: &str, lines: &[String]) -> Option<ReviewIssue> {
    if lines.is_empty() {
        return None;
    }
    
    let raw_text = lines.join("\n");
    let first_line = lines[0].trim_start_matches(&['-', '*', ' '][..]).trim();
    
    // 심각도 추출
    let severity = IssueLevel::from_str(&raw_text);
    
    // 파일 경로 추출 (백틱 안의 경로 또는 .ext 확장자)
    let file_path = extract_file_path(&raw_text);
    
    // 라인 범위 추출 (line 123 또는 줄 123 패턴)
    let line_range = extract_line_range(&raw_text);
    
    // 설명: 첫 줄에서 불필요한 부분 제거
    let description = clean_description(first_line);
    
    if description.is_empty() && file_path.is_none() {
        return None;
    }
    
    Some(ReviewIssue {
        category: category.to_string(),
        severity,
        file_path,
        line_range,
        description,
        raw_text,
    })
}

/// 파일 경로 추출
fn extract_file_path(text: &str) -> Option<PathBuf> {
    // 백틱 안의 경로
    if let Some(start) = text.find('`') {
        if let Some(end) = text[start + 1..].find('`') {
            let path = &text[start + 1..start + 1 + end];
            // 파일 확장자가 있으면 경로로 간주
            if path.contains('.') && !path.contains(' ') {
                return Some(PathBuf::from(path));
            }
        }
    }
    
    // 일반 경로 패턴 (src/, backend/, frontend/ 등)
    for word in text.split_whitespace() {
        let clean = word.trim_matches(&['`', ':', ',', '(', ')'][..]);
        if (clean.starts_with("src/") || clean.starts_with("backend/") || 
            clean.starts_with("frontend/") || clean.starts_with("./")) 
            && clean.contains('.') {
            return Some(PathBuf::from(clean));
        }
    }
    
    None
}

/// 라인 범위 추출
fn extract_line_range(text: &str) -> Option<(u32, u32)> {
    let patterns = [
        "line ", "줄 ", "Line ", "라인 ", "L"
    ];
    
    for pattern in patterns {
        if let Some(pos) = text.find(pattern) {
            let after = &text[pos + pattern.len()..];
            let num_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(line) = num_str.parse::<u32>() {
                return Some((line, line));
            }
        }
    }
    
    None
}

/// 설명 정리
fn clean_description(text: &str) -> String {
    let mut desc = text.to_string();
    
    // 심각도 태그 제거
    for tag in ["[Critical]", "[High]", "[Medium]", "[Low]", "[치명]", "[높음]", "[중간]", "[낮음]"] {
        desc = desc.replace(tag, "");
    }
    
    desc.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_simple_review() {
        let content = r#"
## 보안

- [Critical] SQL Injection 취약점: `src/api/users.rs` line 45

## 코드 품질

- 중복 코드 발견: `utils.ts`와 `helpers.ts`에 동일 함수 존재
"#;
        
        let issues = parse_review_md(content);
        assert!(!issues.is_empty());
        assert_eq!(issues[0].severity, IssueLevel::Critical);
        assert_eq!(issues[0].category, "보안");
    }
}
