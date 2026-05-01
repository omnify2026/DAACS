//! Skill definition and parsing

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub content: String,
    pub triggers: SkillTriggers,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SkillTriggers {
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub file_patterns: Vec<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
}

impl Skill {
    /// Parse a SKILL.md file content
    pub fn parse(content: &str) -> Option<Self> {
        // Split frontmatter and content
        let parts: Vec<&str> = content.splitn(3, "---").collect();
        if parts.len() < 3 {
            return None;
        }

        let frontmatter = parts[1].trim();
        let markdown_content = parts[2].trim();

        // Parse YAML frontmatter
        let mut name = String::new();
        let mut description = String::new();
        let mut triggers = SkillTriggers::default();
        let mut in_description = false;
        let mut description_parts: Vec<String> = Vec::new();

        for line in frontmatter.lines() {
            let line_trimmed = line.trim();
            
            // Handle multi-line description
            if in_description {
                if line_trimmed.is_empty() || (line.starts_with(char::is_alphabetic) && line.contains(':')) {
                    in_description = false;
                    description = description_parts.join(" ").trim().to_string();
                } else {
                    description_parts.push(line_trimmed.to_string());
                    continue;
                }
            }

            if let Some((key, value)) = line_trimmed.split_once(':') {
                let key = key.trim();
                let value = value.trim().trim_matches('"').trim_matches('\'');
                
                match key {
                    "name" => name = value.to_string(),
                    "description" => {
                        if value.starts_with('>') || value.starts_with('|') {
                            // Multi-line YAML string
                            in_description = true;
                        } else if value.is_empty() {
                            // Description on next line
                            in_description = true;
                        } else {
                            description = value.to_string();
                        }
                    }
                    "agents" => {
                        triggers.agents = parse_yaml_array(value);
                    }
                    "file_patterns" => {
                        triggers.file_patterns = parse_yaml_array(value);
                    }
                    "keywords" => {
                        triggers.keywords = parse_yaml_array(value);
                    }
                    _ => {}
                }
            }
        }

        // Handle remaining description
        if in_description && !description_parts.is_empty() {
            description = description_parts.join(" ").trim().to_string();
        }

        if name.is_empty() {
            return None;
        }

        Some(Self {
            name,
            description,
            content: markdown_content.to_string(),
            triggers,
        })
    }

    /// Check if skill matches an agent type
    pub fn matches_agent(&self, agent_type: &str) -> bool {
        if self.triggers.agents.is_empty() {
            return true; // No filter = matches all
        }
        self.triggers.agents.iter().any(|a| {
            a.eq_ignore_ascii_case(agent_type) || agent_type.to_lowercase().contains(&a.to_lowercase())
        })
    }

    /// Check if skill matches a file pattern
    pub fn matches_file(&self, file_path: &str) -> bool {
        if self.triggers.file_patterns.is_empty() {
            return false;
        }
        self.triggers.file_patterns.iter().any(|pattern| {
            if pattern.starts_with("*.") {
                let ext = pattern.trim_start_matches("*.");
                file_path.ends_with(&format!(".{}", ext))
            } else {
                file_path.contains(pattern)
            }
        })
    }

    /// Check if skill matches a keyword in task description
    pub fn matches_keyword(&self, task_description: &str) -> bool {
        if self.triggers.keywords.is_empty() {
            return false;
        }
        let desc_lower = task_description.to_lowercase();
        self.triggers.keywords.iter().any(|kw| desc_lower.contains(&kw.to_lowercase()))
    }
}

fn parse_yaml_array(value: &str) -> Vec<String> {
    let value = value.trim();
    if value.starts_with('[') && value.ends_with(']') {
        value[1..value.len()-1]
            .split(',')
            .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    } else if !value.is_empty() {
        vec![value.to_string()]
    } else {
        vec![]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_skill() {
        let content = r#"---
name: test-skill
description: A test skill for testing
agents: [FrontendDeveloper, BackendDeveloper]
---
# Test Skill
This is the content.
"#;
        let skill = Skill::parse(content).unwrap();
        assert_eq!(skill.name, "test-skill");
        assert_eq!(skill.triggers.agents.len(), 2);
    }

    #[test]
    fn test_parse_multiline_description() {
        let content = r#"---
name: complex-skill
description: >-
  This is a very long description
  that spans multiple lines
---
# Complex Skill
Content here.
"#;
        let skill = Skill::parse(content).unwrap();
        assert_eq!(skill.name, "complex-skill");
        assert!(skill.description.contains("very long description"));
    }
}
