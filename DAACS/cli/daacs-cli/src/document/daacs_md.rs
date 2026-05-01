//! DAACS.md 생성/파싱

use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use tokio::fs;

/// DAACS.md 템플릿 생성
pub fn generate_template(
    goal: &str,
    tech_stack: &HashMap<String, String>,
    features: &[String],
    context: &HashMap<String, String>,
) -> String {
    let mut md = String::new();

    // 1. 헤더
    md.push_str(&format!("# {}\n\n", goal));
    md.push_str("> DAACS CLI에서 생성됨\n\n");

    // 2. 개요
    md.push_str("## 1. 개요\n");
    if let Some(vibe) = context.get("vibe") {
        md.push_str(&format!("- **분위기**: {}\n", vibe));
    }
    if let Some(platform) = context.get("platform") {
        md.push_str(&format!("- **플랫폼**: {}\n", platform));
    }
    md.push('\n');

    // 3. 기술 스택
    md.push_str("## 2. 기술 스택\n");
    for (key, value) in tech_stack {
        md.push_str(&format!("- **{}**: {}\n", key, value));
    }
    md.push('\n');

    // 4. 기능 목록
    md.push_str("## 3. 기능 목록\n");
    for feature in features {
        md.push_str(&format!("- [ ] {}\n", feature));
    }
    md.push('\n');

    // 5. 디렉터리 구조
    md.push_str("## 4. 디렉터리 구조\n");
    md.push_str("```\n.\n├── backend/\n├── frontend/\n└── README.md\n```\n");

    md
}

/// DAACS.md 저장
pub async fn save_file(path: &Path, content: &str) -> Result<()> {
    fs::write(path, content).await?;
    Ok(())
}

/// DAACS.md 파싱 (TODO: 구조화 파싱)
pub async fn parse_file(path: &Path) -> Result<String> {
    let content = fs::read_to_string(path).await?;
    Ok(content)
}
