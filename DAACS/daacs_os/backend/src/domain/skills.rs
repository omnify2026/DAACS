use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use infra_error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const ENV_SKILLS_PATH: &str = "DAACS_SKILLS_PATH";
const ENV_BUNDLES_PATH: &str = "DAACS_AGENT_BUNDLES_PATH";
const FALLBACK_SKILLS_PATH: &str = ".daacs/skills";
const HOME_CLAUDE_SKILLS_PATH: &str = ".claude/skills";
const HOME_CODEX_SKILLS_PATH: &str = ".codex/skills";
const FALLBACK_BUNDLES_PATH: &str = "agent_bundles.yaml";
const DESKTOP_RESOURCES_BUNDLES_RELATIVE_PATH: &str =
    "apps/desktop/Resources/skills/agent_bundles.yaml";
const BUNDLE_PREFIX: &str = "bundle_";

pub type SharedSkillLoader = Arc<Mutex<SkillLoader>>;

#[derive(Debug, Clone)]
pub struct SkillContent {
    pub name: String,
    pub description: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillMeta {
    pub id: String,
    pub description: String,
    pub category: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SkillBundle {
    pub role: String,
    pub description: String,
    pub core_skills: Vec<SkillContent>,
    pub support_skills: Vec<SkillContent>,
    pub shared_skills: Vec<SkillContent>,
}

impl SkillBundle {
    pub fn has_any_skills(&self) -> bool {
        !self.core_skills.is_empty()
            || !self.support_skills.is_empty()
            || !self.shared_skills.is_empty()
    }

    pub fn to_system_prompt(&self, include_support: bool) -> String {
        if !self.has_any_skills() {
            return String::new();
        }

        let mut parts = vec![
            format!("## Agent Skills ({})", self.role),
            format!("{}\n", self.description),
        ];

        append_section(&mut parts, "Core Skills", &self.core_skills);
        if include_support {
            append_section(&mut parts, "Support Skills", &self.support_skills);
        }
        append_section(&mut parts, "Shared Skills", &self.shared_skills);

        parts.join("\n")
    }
}

fn append_section(parts: &mut Vec<String>, heading: &str, skills: &[SkillContent]) {
    if skills.is_empty() {
        return;
    }

    parts.push(format!("### {}", heading));
    for skill in skills {
        parts.push(format!("#### {}", skill.name));
        if !skill.description.is_empty() {
            parts.push(format!("*{}*\n", skill.description));
        }
        parts.push(skill.body.clone());
        parts.push(String::new());
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
struct BundleConfig {
    #[serde(default)]
    bundles: HashMap<String, AgentBundleConfig>,
    #[serde(default)]
    shared: SharedConfig,
    #[serde(default)]
    policy: PolicyConfig,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct AgentBundleConfig {
    #[serde(default)]
    description: String,
    #[serde(default)]
    core_skills: Vec<String>,
    #[serde(default)]
    support_skills: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
struct SharedConfig {
    #[serde(default)]
    description: String,
    #[serde(default)]
    skills: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct PolicyConfig {
    #[serde(default = "default_max_skills")]
    max_skills_per_agent: usize,
    #[serde(default = "default_load_strategy")]
    load_strategy: String,
    #[serde(default)]
    fallback_on_missing: bool,
}

impl Default for PolicyConfig {
    fn default() -> Self {
        Self {
            max_skills_per_agent: default_max_skills(),
            load_strategy: default_load_strategy(),
            fallback_on_missing: true,
        }
    }
}

fn default_max_skills() -> usize {
    12
}

fn default_load_strategy() -> String {
    "core_first".to_string()
}

pub struct SkillLoader {
    config: BundleConfig,
    skill_index: HashMap<String, PathBuf>,
    cache: HashMap<String, SkillContent>,
}

impl SkillLoader {
    pub fn new(skill_roots: Vec<PathBuf>, config_path: &Path) -> AppResult<Self> {
        let config_text = std::fs::read_to_string(config_path)?;
        let config = serde_yaml::from_str::<BundleConfig>(&config_text)
            .map_err(|error| AppError::Message(error.to_string()))?;
        Ok(Self {
            config,
            skill_index: build_skill_index(&skill_roots),
            cache: HashMap::new(),
        })
    }

    fn parse_skill_md(&mut self, skill_name: &str) -> Option<SkillContent> {
        if let Some(cached) = self.cache.get(skill_name) {
            return Some(cached.clone());
        }

        let skill_path = self.skill_index.get(skill_name)?.clone();
        let text = match std::fs::read_to_string(&skill_path) {
            Ok(value) => value,
            Err(_) => {
                return if self.config.policy.fallback_on_missing {
                    None
                } else {
                    Some(SkillContent {
                        name: skill_name.to_string(),
                        description: String::new(),
                        body: format!("Skill file missing: {}", skill_path.display()),
                    })
                };
            }
        };

        let skill = SkillContent {
            name: skill_name.to_string(),
            description: parse_frontmatter_description(&text),
            body: parse_skill_body(&text),
        };
        self.cache.insert(skill_name.to_string(), skill.clone());
        Some(skill)
    }

    fn load_skill_list(&mut self, names: &[String]) -> Vec<SkillContent> {
        names
            .iter()
            .filter_map(|name| self.parse_skill_md(name))
            .collect()
    }

    pub fn available_skill_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.skill_index.keys().cloned().collect();
        ids.sort();
        ids
    }

    pub fn get_skill_catalog(&self) -> Vec<SkillMeta> {
        self.available_skill_ids()
            .into_iter()
            .filter_map(|skill_id| build_skill_meta(&skill_id, self.skill_index.get(&skill_id)?))
            .collect()
    }

    pub fn load_bundle(&mut self, role: &str) -> SkillBundle {
        let bundle_role = normalize_bundle_role(role);
        let Some(agent_cfg) = self.config.bundles.get(bundle_role.as_str()).cloned() else {
            return SkillBundle {
                role: bundle_role,
                description: String::new(),
                core_skills: vec![],
                support_skills: vec![],
                shared_skills: vec![],
            };
        };

        let policy = self.config.policy.clone();
        let core_skills = self.load_skill_list(&agent_cfg.core_skills);
        let support_skills = match policy.load_strategy.as_str() {
            "all" => self.load_skill_list(&agent_cfg.support_skills),
            "core_first" => {
                let remaining = policy
                    .max_skills_per_agent
                    .saturating_sub(core_skills.len());
                let names: Vec<String> = agent_cfg
                    .support_skills
                    .iter()
                    .take(remaining)
                    .cloned()
                    .collect();
                self.load_skill_list(&names)
            }
            _ => vec![],
        };
        let shared_skills = self.load_skill_list(&self.config.shared.skills.clone());

        SkillBundle {
            role: bundle_role,
            description: agent_cfg.description,
            core_skills,
            support_skills,
            shared_skills,
        }
    }

    pub fn load_custom_skills(&mut self, skill_ids: &[String], role: &str) -> SkillBundle {
        let shared_names = self.config.shared.skills.clone();
        let selected_skills = self.load_skill_list(skill_ids);
        let shared_skills = self.load_skill_list(&shared_names);
        let shared_description = self.config.shared.description.trim();
        let description = if shared_description.is_empty() {
            format!(
                "Custom agent with {} selected skills.",
                selected_skills.len()
            )
        } else {
            format!(
                "Custom agent with {} selected skills. Shared skill context: {}",
                selected_skills.len(),
                shared_description
            )
        };

        SkillBundle {
            role: role.trim().to_string(),
            description,
            core_skills: selected_skills,
            support_skills: vec![],
            shared_skills,
        }
    }

    pub fn get_bundle_summary(&self) -> serde_json::Value {
        let mut bundles = serde_json::Map::new();
        for (role, config) in &self.config.bundles {
            bundles.insert(
                role.clone(),
                serde_json::json!({
                    "description": config.description,
                    "core_count": config.core_skills.len(),
                    "support_count": config.support_skills.len(),
                    "core_skills": config.core_skills,
                    "support_skills": config.support_skills,
                }),
            );
        }
        serde_json::Value::Object(bundles)
    }
}

pub fn load_shared_skill_loader() -> AppResult<SharedSkillLoader> {
    let loader = SkillLoader::new(resolve_skill_roots(), &resolve_bundles_config())?;
    Ok(Arc::new(Mutex::new(loader)))
}

fn parse_frontmatter_description(text: &str) -> String {
    parse_frontmatter_value(text, "description").unwrap_or_default()
}

fn parse_frontmatter_category(text: &str) -> Option<String> {
    parse_frontmatter_value(text, "category")
}

fn parse_frontmatter_value(text: &str, key: &str) -> Option<String> {
    let Some((frontmatter, _)) = split_frontmatter(text) else {
        return None;
    };

    match serde_yaml::from_str::<HashMap<String, serde_yaml::Value>>(frontmatter.trim()) {
        Ok(values) => values
            .get(key)
            .and_then(serde_yaml::Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string),
        Err(_) => None,
    }
}

fn parse_skill_body(text: &str) -> String {
    match split_frontmatter(text) {
        Some((_, body)) => body.trim().to_string(),
        None => text.trim().to_string(),
    }
}

fn split_frontmatter(text: &str) -> Option<(&str, &str)> {
    if !text.starts_with("---") {
        return None;
    }

    let remainder = text.get(3..)?;
    let end = remainder.find("\n---")?;
    let frontmatter = remainder[..end].trim_matches('\n');
    let body = remainder.get(end + 4..)?.trim_start_matches('\n');
    Some((frontmatter, body))
}

pub fn resolve_skill_roots() -> Vec<PathBuf> {
    if let Some(path) = env_path(ENV_SKILLS_PATH) {
        return vec![path];
    }

    let mut candidates = vec![];
    if let Some(cwd) = current_dir_path() {
        candidates.push(cwd.join(FALLBACK_SKILLS_PATH));
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(FALLBACK_SKILLS_PATH));
        candidates.push(home.join(HOME_CLAUDE_SKILLS_PATH));
        candidates.push(home.join(HOME_CODEX_SKILLS_PATH));
    }

    let mut roots = vec![];
    for candidate in candidates {
        if candidate.exists() && !roots.iter().any(|known: &PathBuf| known == &candidate) {
            roots.push(candidate);
        }
    }

    if roots.is_empty() {
        vec![PathBuf::from(FALLBACK_SKILLS_PATH)]
    } else {
        roots
    }
}

pub fn resolve_bundles_config() -> PathBuf {
    if let Some(path) = env_path(ENV_BUNDLES_PATH) {
        return path;
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let daacs_os_root = manifest_dir.parent();
    let candidates = [daacs_os_root.map(|root| root.join(DESKTOP_RESOURCES_BUNDLES_RELATIVE_PATH))];

    for candidate in candidates.into_iter().flatten() {
        if candidate.exists() {
            return candidate;
        }
    }

    // DAACS runtime no longer falls back to the legacy Python services tree.
    PathBuf::from(FALLBACK_BUNDLES_PATH)
}

fn env_path(key: &str) -> Option<PathBuf> {
    let raw = std::env::var(key).ok()?;
    let path = PathBuf::from(raw.trim());
    if path.exists() {
        Some(path)
    } else {
        None
    }
}

fn current_dir_path() -> Option<PathBuf> {
    std::env::current_dir().ok()
}

pub fn normalize_bundle_role(role_label: &str) -> String {
    let mut key = role_label.trim().to_lowercase().replace([' ', '-'], "_");
    if let Some(stripped) = key.strip_prefix(BUNDLE_PREFIX) {
        key = stripped.to_string();
    }

    match key.as_str() {
        "developer_front" | "developer_back" | "frontend" | "backend" | "front" | "front_end"
        | "back" | "back_end" | "developer" | "프론트" | "프론트엔드" | "백엔드" | "서버"
        | "개발자" | "구현자" => "developer".to_string(),
        "피엠" | "기획" | "기획자" => "pm".to_string(),
        "리뷰" | "리뷰어" | "검토" | "검토자" => "reviewer".to_string(),
        "검증" | "검증자" | "검수" | "검수자" => "verifier".to_string(),
        "배포" | "인프라" | "운영" => "devops".to_string(),
        "디자인" | "디자이너" => "designer".to_string(),
        "ceo" | "pm" | "reviewer" | "devops" | "marketer" | "designer" | "cfo" => key,
        _ => key,
    }
}

fn build_skill_index(skill_roots: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut index = HashMap::new();
    for root in skill_roots {
        index_skill_directory(root, &mut index);
    }
    index
}

fn index_skill_directory(dir: &Path, index: &mut HashMap<String, PathBuf>) {
    if !dir.exists() {
        return;
    }

    let skill_path = dir.join("SKILL.md");
    if skill_path.is_file() {
        if let Some(id) = dir
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            index
                .entry(id.to_string())
                .or_insert_with(|| skill_path.clone());
        }
        return;
    }

    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            index_skill_directory(&entry.path(), index);
        }
    }
}

fn build_skill_meta(skill_id: &str, skill_path: &Path) -> Option<SkillMeta> {
    let text = std::fs::read_to_string(skill_path).ok()?;
    Some(SkillMeta {
        id: skill_id.to_string(),
        description: parse_frontmatter_description(&text),
        category: parse_frontmatter_category(&text),
    })
}

#[cfg(test)]
mod tests {
    use super::normalize_bundle_role;

    #[test]
    fn normalize_bundle_role_accepts_runtime_role_aliases() {
        assert_eq!(normalize_bundle_role("frontend"), "developer");
        assert_eq!(normalize_bundle_role("developer-front"), "developer");
        assert_eq!(normalize_bundle_role("백엔드"), "developer");
        assert_eq!(normalize_bundle_role("리뷰어"), "reviewer");
        assert_eq!(normalize_bundle_role("검수자"), "verifier");
        assert_eq!(normalize_bundle_role("배포"), "devops");
    }
}
