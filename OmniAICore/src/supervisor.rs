use serde::{Deserialize, Serialize};

use crate::recovery;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SupervisorDecision {
    pub action: String,
    pub reason: String,
    pub focus_keywords: Vec<String>,
    pub notes: String,
}

fn fallback_review(reason: String, notes: String) -> SupervisorDecision {
    SupervisorDecision {
        action: "review".to_string(),
        reason,
        focus_keywords: Vec::new(),
        notes,
    }
}

pub fn parse_supervisor_decision(content: &str) -> Result<SupervisorDecision, String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return Ok(fallback_review(
            "Supervisor returned empty response".to_string(),
            "Empty response from LLM".to_string(),
        ));
    }

    if let Ok(decision) = serde_json::from_str::<SupervisorDecision>(trimmed) {
        return Ok(decision);
    }

    if let Some(recovered) = recovery::recover_json(trimmed) {
        if let Ok(decision) = serde_json::from_value::<SupervisorDecision>(recovered.clone()) {
            return Ok(decision);
        }
        if let Some(inner) = recovered.get("action") {
            if inner.is_object() {
                if let Ok(decision) = serde_json::from_value::<SupervisorDecision>(inner.clone()) {
                    return Ok(decision);
                }
            }
        }
    }

    let preview = trimmed.chars().take(160).collect::<String>();
    Ok(fallback_review(
        "Supervisor response was not valid JSON".to_string(),
        format!("Unparseable supervisor output: {}", preview),
    ))
}
