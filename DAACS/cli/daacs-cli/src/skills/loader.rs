//! SkillLoader - Load and select skills dynamically (Async)

use std::path::{Path, PathBuf};
use anyhow::Result;
use crate::skills::skill::Skill;
use crate::config::bundles::BundlesConfig;

pub struct SkillLoader {
    skills_dir: PathBuf,
    cache: Vec<Skill>,
}

impl SkillLoader {
    pub fn new(project_path: &Path) -> Self {
        // 1. Check project-local .daacs/skills
        let mut skills_dir = project_path.join(".daacs").join("skills");
        
        // 2. If not found, use the known DAACS CLI root (User Configured)
        if !skills_dir.exists() {
            skills_dir = PathBuf::from(r"C:\Users\Admin\Desktop\DAACS\CLI\daacs-cli\.daacs\skills");
        }
        
        Self {
            skills_dir,
            cache: Vec::new(),
        }
    }

    /// Load all skills from the skills directory asynchronously
    pub async fn load_all(&mut self) -> Result<&[Skill]> {
        if !self.cache.is_empty() {
            // Already loaded
            return Ok(&self.cache);
        }

        if !self.skills_dir.exists() {
            return Ok(&self.cache);
        }

        let mut read_dir = tokio::fs::read_dir(&self.skills_dir).await?;
        let mut tasks = tokio::task::JoinSet::new();

        while let Ok(Some(entry)) = read_dir.next_entry().await {
            let path = entry.path();
            if path.is_dir() {
                let skill_file = path.join("SKILL.md");
                if skill_file.exists() {
                    let path_clone = path.clone();
                    tasks.spawn(async move {
                        match tokio::fs::read_to_string(&skill_file).await {
                            Ok(content) => {
                                if let Some(mut skill) = Skill::parse(&content) {
                                    // [NEW] XML Wrapping Logic
                                    // This helps the LLM distinguish skill instructions from user context
                                    let wrapped_content = format!(
                                        "<skill-instruction>\nBase directory for this skill: {}\n\n{}\n</skill-instruction>",
                                        path_clone.display(),
                                        skill.content
                                    );
                                    skill.content = wrapped_content;
                                    Some(skill)
                                } else {
                                    None
                                }
                            }
                            Err(_) => None,
                        }
                    });
                }
            }
        }

        while let Some(res) = tasks.join_next().await {
            if let Ok(Some(skill)) = res {
                self.cache.push(skill);
            }
        }

        Ok(&self.cache)
    }

    /// Select skills for a specific agent and task (no token limit)
    pub async fn select_skills(
        &mut self,
        agent_type: &str,
        task_description: &str,
    ) -> Result<Vec<Skill>> {
        self.load_all().await?;

        let mut scored_skills: Vec<(i32, Skill)> = Vec::new();
        let agent_keywords = get_agent_keywords(agent_type);
        let task_lower = task_description.to_lowercase();

        for skill in &self.cache {
            let mut score = 0;
            let desc_lower = skill.description.to_lowercase();
            let name_lower = skill.name.to_lowercase();

            // 1. Direct Name Matching (High Priority)
            if task_lower.contains(&name_lower) {
                score += 100;
            }

            // 2. Task Keyword Matching
            for kw in &skill.triggers.keywords {
                let kw_lower = kw.to_lowercase();
                if !kw_lower.is_empty() && task_lower.contains(&kw_lower) {
                    score += 10;
                }
            }
            
            // 3. Agent Type Matching (General Relevance)
            if agent_keywords.iter().any(|kw| desc_lower.contains(kw)) {
                score += 5;
            }

            if score > 0 {
                scored_skills.push((score, skill.clone()));
            }
        }

        scored_skills.sort_by(|a, b| b.0.cmp(&a.0));
        Ok(scored_skills.into_iter().take(5).map(|(_, skill)| skill).collect())
    }

    /// Explicitly load a specific bundle of skills using BundlesConfig
    pub async fn select_by_bundle(&mut self, bundle_name: &str) -> Result<Vec<Skill>> {
        self.load_all().await?;
        
        let config = BundlesConfig::load();
        
        if let Some(bundle_def) = config.get_bundle(bundle_name) {
             let selected: Vec<Skill> = self.cache.iter()
                .filter(|s| bundle_def.skills.contains(&s.name))
                .cloned()
                .collect();
            Ok(selected)
        } else {
            // Bundle not found
            Ok(vec![])
        }
    }

    /// Get paths of selected skills (Legacy for process based CLI)
    pub async fn get_skill_paths(
        &mut self,
        agent_type: &str,
        task_description: &str,
    ) -> Result<Vec<PathBuf>> {
        let skills = self.select_skills(agent_type, task_description).await?;
        
        let paths = skills.iter()
            .map(|skill| self.skills_dir.join(&skill.name))
            .filter(|path| path.exists())
            .collect();
            
        Ok(paths)
    }

    /// Get paths for a specific bundle
    pub async fn get_bundle_paths(&mut self, bundle_name: &str) -> Result<Vec<PathBuf>> {
        let skills = self.select_by_bundle(bundle_name).await?;
        
        let paths = skills.iter()
            .map(|skill| self.skills_dir.join(&skill.name))
            .filter(|path| path.exists())
            .collect();
            
        Ok(paths)
    }

    /// Build a context string from selected skills
    pub async fn build_context(
        &mut self,
        agent_type: &str,
        task_description: &str,
        _file_paths: &[String],
    ) -> Result<String> {
        let skills = self.select_skills(agent_type, task_description).await?;
        
        if skills.is_empty() {
            return Ok(String::new());
        }

        let mut context = String::from("[Loaded Skills]\n\n");
        for skill in skills {
            // Note: skill.content is already XML wrapped by load_all
            context.push_str(&format!("### Skill: {} ({})\n", skill.name, skill.description));
            context.push_str(&skill.content);
            context.push_str("\n\n---\n\n");
        }

        Ok(context)
    }

    /// Build context from a specific bundle
    pub async fn build_bundle_context(&mut self, bundle_name: &str) -> Result<String> {
        let skills = self.select_by_bundle(bundle_name).await?;
        if skills.is_empty() {
            return Ok(String::new());
        }

        let config = BundlesConfig::load();
        let desc = config.get_bundle(bundle_name).map(|b| b.description.as_str()).unwrap_or("Custom Bundle");

        let mut context = String::from(format!("[Loaded Bundle: {} ({})]\n\n", bundle_name, desc));
        for skill in skills {
            context.push_str(&format!("### {} ({})\n", skill.name, skill.description));
            context.push_str(&skill.content);
            context.push_str("\n\n---\n\n");
        }

        Ok(context)
    }

    /// Check if skills directory exists
    pub fn has_skills(&self) -> bool {
        self.skills_dir.exists()
    }

    /// Sync skills from .daacs/skills to .claude/skills
    pub fn sync_claude_skills(&self) -> Result<()> {
        let claude_skills_dir = self.skills_dir.parent().unwrap().parent().unwrap().join(".claude").join("skills");
        
        if !self.skills_dir.exists() {
            return Ok(());
        }

        if !claude_skills_dir.exists() {
            std::fs::create_dir_all(&claude_skills_dir)?;
        }

        // Keep sync synchronous for now as it's a file copy operation usually done at init
        for entry in std::fs::read_dir(&self.skills_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_dir() {
                let folder_name = path.file_name().unwrap();
                let target_path = claude_skills_dir.join(folder_name);
                
                if !target_path.exists() {
                    std::fs::create_dir_all(&target_path)?;
                    let src_skill_md = path.join("SKILL.md");
                    let dst_skill_md = target_path.join("SKILL.md");
                    if src_skill_md.exists() {
                        std::fs::copy(src_skill_md, dst_skill_md)?;
                        crate::logger::status_update(&format!("Synced skill to .claude: {:?}", folder_name));
                    }
                }
            }
        }
        
        Ok(())
    }
}

/// Get keywords for matching skills based on agent type
fn get_agent_keywords(agent_type: &str) -> Vec<&'static str> {
    match agent_type.to_lowercase().as_str() {
        "frontenddeveloper" | "frontend" => vec![
            "react", "next.js", "nextjs", "typescript", "javascript", "frontend",
            "tailwind", "css", "ui", "ux", "component", "vue", "angular", "svelte",
            "web design", "responsive", "accessibility"
        ],
        "backenddeveloper" | "backend" => vec![
            "fastapi", "python", "api", "backend", "rest", "graphql", "database",
            "postgres", "sql", "server", "async", "django", "flask", "node",
            "express", "authentication", "security"
        ],
        "reviewer" => vec![
            "code review", "quality", "security", "performance", "testing",
            "lint", "best practices", "audit", "vulnerability"
        ],
        "designer" => vec![
            "design", "ui", "ux", "color", "typography", "layout", "figma",
            "tailwind", "css", "theme", "dark mode"
        ],
        "devops" => vec![
            "docker", "kubernetes", "ci/cd", "deployment", "infrastructure",
            "terraform", "aws", "gcp", "azure", "monitoring", "devops"
        ],
        _ => vec![]
    }
}
