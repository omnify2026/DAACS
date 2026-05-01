use infra_error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedStepResult {
    pub step_number: u32,
    pub body_markdown: String,
    pub files_created: Vec<String>,
    pub commands: Vec<String>,
    pub task_completed: bool,
    pub raw: String,
}

pub fn parse_step_result(raw: &str) -> AppResult<Option<ParsedStepResult>> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(None);
    }

    let (step_number, body_start, body_end) = match find_step_block(text) {
        Some(bounds) => bounds,
        None => return Ok(None),
    };

    let body = text[body_start..body_end].trim();
    let body_without_files = remove_tag_block(body, "FilesCreated").trim().to_string();
    let task_completed = text.contains(&format!("{{END_TASK_{step_number}}}"));

    if !task_completed {
        return Err(AppError::Message(format!(
            "sequencer step result is missing {{END_TASK_{step_number}}}"
        )));
    }

    Ok(Some(ParsedStepResult {
        step_number,
        body_markdown: body_without_files,
        files_created: extract_list_block(body, "FilesCreated"),
        commands: extract_command_block(text),
        task_completed,
        raw: text.to_string(),
    }))
}

fn find_step_block(text: &str) -> Option<(u32, usize, usize)> {
    let start = text.find("[STEP_")?;
    let after_prefix = &text[start + 6..];
    let digits_len = after_prefix
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .count();
    if digits_len == 0 {
        return None;
    }
    let digits = &after_prefix[..digits_len];
    let suffix = &after_prefix[digits_len..];
    if !suffix.starts_with("_RESULT]") {
        return None;
    }

    let step_number = digits.parse::<u32>().ok()?;
    let body_start = start + 6 + digits_len + "_RESULT]".len();
    let end_tag = format!("[/STEP_{step_number}_RESULT]");
    let end = text[body_start..].find(&end_tag)?;
    Some((step_number, body_start, body_start + end))
}

fn remove_tag_block(body: &str, tag: &str) -> String {
    let open = format!("[{tag}]");
    let close = format!("[/{tag}]");
    match (body.find(&open), body.find(&close)) {
        (Some(start), Some(end)) if end >= start => {
            let before = body[..start].trim_end();
            let after = body[end + close.len()..].trim_start();
            match (before.is_empty(), after.is_empty()) {
                (true, true) => String::new(),
                (false, true) => before.to_string(),
                (true, false) => after.to_string(),
                (false, false) => format!("{before}\n\n{after}"),
            }
        }
        _ => body.to_string(),
    }
}

fn extract_list_block(body: &str, tag: &str) -> Vec<String> {
    let open = format!("[{tag}]");
    let close = format!("[/{tag}]");
    let Some(start) = body.find(&open) else {
        return Vec::new();
    };
    let inner_start = start + open.len();
    let Some(end_rel) = body[inner_start..].find(&close) else {
        return Vec::new();
    };
    body[inner_start..inner_start + end_rel]
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            let payload = trimmed
                .strip_prefix('-')
                .or_else(|| trimmed.strip_prefix('*'))
                .unwrap_or(trimmed)
                .trim();
            (!payload.is_empty()).then(|| payload.to_string())
        })
        .collect()
}

fn extract_command_block(text: &str) -> Vec<String> {
    extract_tagged_commands(text, "Commands")
        .or_else(|| extract_tagged_commands(text, "Command"))
        .unwrap_or_default()
}

fn extract_tagged_commands(text: &str, tag: &str) -> Option<Vec<String>> {
    let open = format!("[{tag}]");
    let close = format!("[/{tag}]");
    let open_start = text.find(&open)?;
    let inner_start = open_start + open.len();
    let close_rel = text[inner_start..].find(&close)?;
    Some(
        text[inner_start..inner_start + close_rel]
            .lines()
            .filter_map(|line| {
                let trimmed = line.trim();
                let payload = if let Some((_, rest)) = trimmed.split_once('.') {
                    if trimmed.chars().take_while(|ch| ch.is_ascii_digit()).count() > 0 {
                        rest.trim()
                    } else {
                        trimmed
                    }
                } else {
                    trimmed
                };
                (!payload.is_empty()).then(|| payload.to_string())
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::parse_step_result;

    #[test]
    fn parses_sequencer_result_with_files_and_commands() {
        let raw = r#"
[STEP_1_RESULT]
Implemented runtime parser.

[FilesCreated]
backend/src/planner/runtime/message_parser.rs
[/FilesCreated]
[/STEP_1_RESULT]
[Command]
1. cargo test
[/Command]
{END_TASK_1}
"#;

        let parsed = parse_step_result(raw).unwrap().unwrap();
        assert_eq!(parsed.step_number, 1);
        assert_eq!(parsed.body_markdown, "Implemented runtime parser.");
        assert_eq!(
            parsed.files_created,
            vec!["backend/src/planner/runtime/message_parser.rs"]
        );
        assert_eq!(parsed.commands, vec!["cargo test"]);
        assert!(parsed.task_completed);
    }

    #[test]
    fn returns_none_for_non_sequencer_output() {
        assert!(parse_step_result("plain text").unwrap().is_none());
    }

    #[test]
    fn parses_plural_commands_block() {
        let raw = r#"
[STEP_2_RESULT]
Implemented bridge fallback.
[/STEP_2_RESULT]
[Commands]
1. cargo test -p daacs_desktop
2. cargo test -p backend
[/Commands]
{END_TASK_2}
"#;

        let parsed = parse_step_result(raw).unwrap().unwrap();
        assert_eq!(parsed.step_number, 2);
        assert_eq!(
            parsed.commands,
            vec![
                "cargo test -p daacs_desktop".to_string(),
                "cargo test -p backend".to_string()
            ]
        );
    }
}
