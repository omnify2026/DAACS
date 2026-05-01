#[derive(Debug, Default, Clone, serde::Serialize)]
pub struct PmTaskLists {
    pub frontend: Vec<String>,
    pub backend: Vec<String>,
    pub reviewer: Vec<String>,
    pub verifier: Vec<String>,
    pub unstructured: Vec<String>,
}

fn is_section_header(line: &str) -> bool {
    let s = line.trim();
    if s.is_empty() {
        return false;
    }
    let rest = s.trim_end_matches(':');
    rest.chars().all(|c| c.is_ascii_uppercase() || c == '_') && rest.len() > 0 && s.ends_with(':')
}

fn take_list(in_text: &str, in_marker: &str) -> Vec<String> {
    let mut out = Vec::new();
    let idx = match in_text.find(in_marker) {
        Some(i) => i,
        None => return out,
    };
    let after = &in_text[idx + in_marker.len()..];
    for line in after.lines() {
        if is_section_header(line) {
            break;
        }
        let trimmed = line.trim();
        if let Some(stripped) = trimmed
            .strip_prefix('-')
            .or_else(|| trimmed.strip_prefix('*'))
        {
            let task = stripped.trim();
            if !task.eq_ignore_ascii_case("(none)") && !task.is_empty() {
                out.push(task.to_string());
            }
        }
    }
    out
}

fn take_unstructured(in_text: &str) -> Vec<String> {
    let text = in_text.trim();
    if text.is_empty() {
        return vec![];
    }
    let mut out = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || is_section_header(trimmed) {
            continue;
        }
        if let Some(stripped) = trimmed
            .strip_prefix('-')
            .or_else(|| trimmed.strip_prefix('*'))
        {
            let item = stripped.trim();
            if !item.is_empty() && !item.eq_ignore_ascii_case("(none)") {
                out.push(item.to_string());
            }
        }
    }
    if out.is_empty() {
        out.push(text.to_string());
    }
    out
}

pub fn parse_pm_task_lists(in_stdout: &str) -> PmTaskLists {
    let text = in_stdout.trim();
    let frontend = take_list(text, "FRONTEND_TASKS:");
    let backend = take_list(text, "BACKEND_TASKS:");
    let reviewer = take_list(text, "REVIEWER_TASKS:");
    let verifier = take_list(text, "VERIFIER_TASKS:");
    let has_structured_tasks =
        !frontend.is_empty() || !backend.is_empty() || !reviewer.is_empty() || !verifier.is_empty();
    PmTaskLists {
        frontend,
        backend,
        reviewer,
        verifier,
        unstructured: if has_structured_tasks {
            vec![]
        } else {
            take_unstructured(text)
        },
    }
}
