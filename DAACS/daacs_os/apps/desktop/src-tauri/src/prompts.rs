use omni_ai_core::AgentRole;
use omni_utilities::try_load_prompt;
use std::path::PathBuf;

const LOCAL_STATE_APP_DIR: &str = "DAACS";

fn prompt_base_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .to_path_buf()
}

fn user_prompt_base_path() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(LOCAL_STATE_APP_DIR)
}

pub fn load_prompt_content_merged(prompt_name: &str) -> Option<String> {
    let key = prompt_name.trim();
    if key.is_empty() {
        return None;
    }
    try_load_prompt(user_prompt_base_path(), key)
        .or_else(|| try_load_prompt(prompt_base_path(), key))
        .map(|d| d.content)
}

fn prompt_name_for_role(in_role: AgentRole) -> &'static str {
    match in_role {
        AgentRole::Pm => "agent_pm",
        AgentRole::Goal => "agent_goal",
        AgentRole::Frontend => "agent_frontend",
        AgentRole::Backend => "agent_backend",
        AgentRole::Agent => "agent_agent",
        AgentRole::Reviewer => "agent_reviewer",
        AgentRole::Verifier => "agent_verifier",
    }
}

pub fn get_agent_prompt_content(in_role: AgentRole) -> Option<String> {
    let name = prompt_name_for_role(in_role);
    load_prompt_content_merged(name)
}

#[cfg(test)]
fn prompt_assets_guardrail_violations() -> Vec<String> {
    const GUARDED_PROMPTS: &[&str] = &[
        "agent_pm",
        "agent_frontend",
        "agent_backend",
        "agent_reviewer",
        "agent_verifier",
        "rfi_gate",
    ];
    // Keep bundled prompts free of leftover demo-domain phrasing.
    const BANNED_PHRASES: &[&str] = &[
        "league of legends",
        "draft advisor",
        "pick recommender",
        "champion recommendation",
        "data dragon",
        "riot games",
        "champion select",
        "pick ban",
        "ban pick",
        "롤 픽창",
        "픽밴",
        "챔피언 추천",
        "밴: 아리",
    ];
    let mut violations = Vec::new();
    let base_path = prompt_base_path();

    for prompt_name in GUARDED_PROMPTS {
        let Some(doc) = try_load_prompt(&base_path, prompt_name) else {
            violations.push(format!("{prompt_name}: bundled prompt file is missing"));
            continue;
        };

        let lowered = doc.content.to_lowercase();
        for phrase in BANNED_PHRASES {
            if lowered.contains(phrase) {
                violations.push(format!(
                    "{prompt_name}: banned demo-domain phrase detected: `{phrase}`"
                ));
            }
        }
    }

    violations
}

#[cfg(test)]
mod tests {
    use super::prompt_assets_guardrail_violations;

    #[test]
    fn bundled_prompt_assets_remain_domain_agnostic() {
        let violations = prompt_assets_guardrail_violations();
        assert!(
            violations.is_empty(),
            "prompt asset guardrail violations:\n{}",
            violations.join("\n")
        );
    }
}
