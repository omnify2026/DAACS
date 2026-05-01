use serde_json::{json, Value};

pub fn recover_json(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();

    // 1. 직접 파싱 시도
    if let Ok(v) = serde_json::from_str::<Value>(trimmed) {
        return Some(v);
    }

    // 2. 텍스트 전체에서 ```json ... ``` 코드블록 찾기 (앞에 설명 문장이 있어도 OK)
    let lower = trimmed.to_lowercase();
    if let Some(fence_start) = lower.find("```json") {
        let after_fence = &trimmed[fence_start + 7..];
        let code_end = after_fence.find("```").unwrap_or(after_fence.len());
        let candidate = after_fence[..code_end].trim();
        if let Ok(v) = serde_json::from_str::<Value>(candidate) {
            return Some(v);
        }
        // 코드블록 안에서도 { } 추출 시도
        if let Some(v) = extract_brace_json(candidate) {
            return Some(v);
        }
    }

    // 3. ``` 코드블록 (json 태그 없음) 찾기
    if let Some(fence_start) = lower.find("```\n").or_else(|| lower.find("``` ")) {
        let after_fence = &trimmed[fence_start + 3..];
        let code_end = after_fence.find("```").unwrap_or(after_fence.len());
        let candidate = after_fence[..code_end].trim();
        if let Ok(v) = serde_json::from_str::<Value>(candidate) {
            return Some(v);
        }
    }

    // 4. 전체 텍스트에서 첫 { 부터 마지막 } 까지 추출
    if let Some(v) = extract_brace_json(trimmed) {
        return Some(v);
    }

    // 5. 잘린(Truncated) JSON 강제 복구 시도
    if let Some(v) = recover_truncated_json(trimmed) {
        return Some(v);
    }

    // 6. 완료 신호 감지
    if lower.contains("done") || lower.contains("goal achieved") || lower.contains("completed") {
        return Some(json!({"action": "done"}));
    }

    None
}

fn recover_truncated_json(text: &str) -> Option<Value> {
    let mut candidate = text.trim().to_string();

    // To avoid capturing the system prompt or inner braces if the output is truncated,
    // we find the last occurrence of the guaranteed root key "status".
    if let Some(idx) = candidate
        .rfind("{ \"status\"")
        .or_else(|| candidate.rfind("{\"status\""))
        .or_else(|| candidate.rfind("{\n  \"status\""))
    {
        candidate = candidate[idx..].to_string();
    } else if let Some(idx) = candidate.rfind('{') {
        candidate = candidate[idx..].to_string();
    } else {
        return None;
    }

    for _ in 0..15 {
        match serde_json::from_str::<Value>(&candidate) {
            Ok(v) => return Some(v),
            Err(e) => {
                let msg = e.to_string();
                if msg.contains("EOF while parsing a string") {
                    candidate.push('"');
                } else if msg.contains("EOF while parsing an object")
                    || msg.contains("EOF while parsing a value")
                {
                    candidate.push('}');
                } else if msg.contains("EOF while parsing a list")
                    || msg.contains("EOF while parsing an array")
                {
                    candidate.push(']');
                } else if msg.contains("expected value") {
                    if candidate.ends_with(':') || candidate.ends_with(": ") {
                        candidate.push_str("\"\"");
                    } else if candidate.ends_with(',') {
                        candidate.pop(); // trailing comma remove
                    } else {
                        candidate.push('}');
                    }
                } else {
                    break;
                }
            }
        }
    }
    None
}

fn extract_brace_json(text: &str) -> Option<Value> {
    // Find the LAST JSON object by parsing from right to left, or by searching for common signatures.
    // Since codex cli echoes the prompt, text might contain `{ "status": ... }` in the middle, and again at the end.
    // Let's find all occurrences of "{" and try to extract a balanced JSON object from there.

    let mut current_idx = 0;
    let mut last_valid = None;

    while let Some(start_idx) = text[current_idx..].find('{') {
        let absolute_start = current_idx + start_idx;

        // Try finding the matching closing brace (simple count)
        let mut depth = 0;
        let mut found_end = None;
        for (i, c) in text[absolute_start..].char_indices() {
            if c == '{' {
                depth += 1;
            } else if c == '}' {
                depth -= 1;
                if depth == 0 {
                    found_end = Some(absolute_start + i);
                    break;
                }
            }
        }

        if let Some(absolute_end) = found_end {
            let candidate = &text[absolute_start..=absolute_end];
            if let Ok(v) = serde_json::from_str::<Value>(candidate) {
                last_valid = Some(v); // Keeps updating, so it will capture the LAST valid JSON block
            }
            // CRITICAL FIX: Skip the entire block to avoid finding nested child objects
            current_idx = absolute_end;
        } else {
            current_idx = absolute_start + 1;
        }
    }

    if last_valid.is_some() {
        return last_valid;
    }

    // Original fallback logic if depth finding failed
    let (start, end) = (text.find('{')?, text.rfind('}')?);
    if start >= end {
        return None;
    }
    let candidate = &text[start..=end];

    if let Ok(v) = serde_json::from_str::<Value>(candidate) {
        return Some(v);
    }

    let fixed = candidate.replace(",}", "}").replace(",]", "]");
    if let Ok(v) = serde_json::from_str::<Value>(&fixed) {
        return Some(v);
    }

    if let Ok(re) = regex::Regex::new(r#"(\{|,)\s*(\w+)\s*:"#) {
        let with_quotes = re.replace_all(&fixed, r#"$1"$2":"#);
        if let Ok(v) = serde_json::from_str::<Value>(&with_quotes) {
            return Some(v);
        }
    }

    None
}
