use crate::planner::planner_system_prompt;
use crate::reviewer::reviewer_system_prompt;
use crate::verifier::verifier_system_prompt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    Pm,
    Goal,
    Frontend,
    Backend,
    Reviewer,
    Verifier,
    Agent,
}

pub fn pm_skill_planning() -> &'static str {
    planner_system_prompt()
}

pub fn frontend_agent_skills() -> &'static str {
    r#"## Developer skills (clean-code, react/frontend patterns)
- Clean code: SRP, DRY, KISS, YAGNI. Functions small (5–10 lines), one level of abstraction.
- Naming: verb+noun for functions; booleans as is/has/can; constants SCREAMING_SNAKE.
- React/UI: Composition over nesting; guard clauses; avoid barrel imports for heavy components.
- Files: Create all output in the current working directory. Real paths (HTML, CSS, JS/TS, React).
- Reply with a short summary and list of files created."#
}

pub fn backend_agent_skills() -> &'static str {
    r#"## Developer skills (clean-code, api-patterns, fastapi/backend patterns)
- Clean code: SRP, DRY, KISS, YAGNI. Functions small, few arguments, no hidden side effects.
- API design: Clear routes, consistent status codes, validate at boundaries.
- Data: Explicit schemas; validate inputs; handle errors and edge cases.
- Files: Create all output in the current working directory. Real paths (API routes, models, config).
- Reply with a short summary and list of files created."#
}

pub fn system_prompt_for_role(in_role: AgentRole) -> &'static str {
    match in_role {
        AgentRole::Pm => planner_system_prompt(),
        AgentRole::Goal => "You are a senior project manager and technical planner. Analyze the shared goal, break it into tasks, and suggest next steps. Respond with: brief plan, priorities, and concrete next actions for the team (developer, reviewer, verifier, designer).",
        AgentRole::Frontend => {
            static FULL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
            FULL.get_or_init(|| {
                format!(
                    "You are a frontend developer. Execute the assigned tasks. Create all output files in the current working directory. Use real file paths and write real source files (e.g. HTML, CSS, JS/TS, React).\n\n{}",
                    frontend_agent_skills()
                )
            }).as_str()
        }
        AgentRole::Backend => {
            static FULL: std::sync::OnceLock<String> = std::sync::OnceLock::new();
            FULL.get_or_init(|| {
                format!(
                    "You are a backend developer. Execute the assigned tasks. Create all output files in the current working directory. Use real file paths and write real source files (e.g. API routes, models, config).\n\n{}",
                    backend_agent_skills()
                )
            }).as_str()
        }
        AgentRole::Reviewer => reviewer_system_prompt(),
        AgentRole::Verifier => verifier_system_prompt(),
        AgentRole::Agent => "You are an expert team member. Execute the user's instruction precisely. Reply with the result or status.",
    }
}
