use colored::*;
use regex::Regex;

/// 간단한 마크다운 -> ANSI 변환기
pub fn render_markdown(text: &str) -> String {
    let mut rendered = text.to_string();

    // 1. Headers (### Header) -> Blue Bold
    let header_re = Regex::new(r"(?m)^#{1,3}\s+(.*)$").unwrap();
    rendered = header_re.replace_all(&rendered, |caps: &regex::Captures| {
        format!("\n{}\n", caps[1].blue().bold().to_string())
    }).to_string();

    // 2. Bold (**bold**) -> Bold
    let bold_re = Regex::new(r"\*\*(.*?)\*\*").unwrap();
    rendered = bold_re.replace_all(&rendered, |caps: &regex::Captures| {
        caps[1].bold().to_string()
    }).to_string();

    // 3. Code Blocks (```rust ... ```) -> Yellow
    // Note: Multiline regex replacement is tricky, simplified here
    let code_block_re = Regex::new(r"```[\w]*\n([\s\S]*?)```").unwrap();
    rendered = code_block_re.replace_all(&rendered, |caps: &regex::Captures| {
        format!("\n{}\n", caps[1].yellow().to_string())
    }).to_string();

    // 4. Inline Code (`code`) -> Cyan
    let inline_code_re = Regex::new(r"`([^`]+)`").unwrap();
    rendered = inline_code_re.replace_all(&rendered, |caps: &regex::Captures| {
        caps[1].cyan().to_string()
    }).to_string();

    // 5. Bullet Points (- item) -> Green Bullet
    let bullet_re = Regex::new(r"(?m)^(\s*)[-•]\s+(.*)$").unwrap();
    rendered = bullet_re.replace_all(&rendered, |caps: &regex::Captures| {
        format!("{}🟢 {}", &caps[1], &caps[2])
    }).to_string();

    rendered
}
