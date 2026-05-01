"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeCompanyBuildPlan = normalizeCompanyBuildPlan;
exports.designCompany = designCompany;
const agentDesignAssistant_1 = require("./agentDesignAssistant");
const tauriCli_1 = require("../services/tauriCli");
const MAX_AGENT_COUNT = 8;
const MAX_AGENT_SKILLS = 12;
const COMPANY_BUILDER_PROMPT = `
You are designing an AI company organization for DAACS.

Given a business goal, define a practical team of 3 to 8 AI agents.
For each agent:
- choose a clear name
- choose a snake_case role_label
- choose 5 to 12 skills from the catalog
- explain that agent's concrete responsibilities

Return ONLY valid JSON with this exact structure:
{
  "company_name": "Name",
  "agents": [
    {
      "name": "Agent Name",
      "role_label": "snake_case_role",
      "selected_skills": ["skill-id-1", "skill-id-2"],
      "responsibilities": "What this agent owns"
    }
  ],
  "rationale": "Why this team shape fits the goal"
}
`.trim();
function normalizeKey(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
}
function summarizeSkillCatalog(availableSkills) {
    return availableSkills
        .map((skill) => `- ${skill.id}: ${skill.description || "No description provided."}`)
        .join("\n");
}
function resolveAvailableSkill(value, availableSkills) {
    const lookup = new Map(availableSkills.map((skill) => [normalizeKey(skill.id), skill.id]));
    return lookup.get(normalizeKey(value)) ?? null;
}
function normalizeAgentSpec(value, availableSkills) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const roleLabel = typeof record.role_label === "string" ? record.role_label.trim() : "";
    const responsibilities = typeof record.responsibilities === "string" ? record.responsibilities.trim() : "";
    const selectedSkills = Array.isArray(record.selected_skills)
        ? [
            ...new Set(record.selected_skills
                .filter((item) => typeof item === "string")
                .map((item) => resolveAvailableSkill(item, availableSkills))
                .filter((item) => !!item)),
        ].slice(0, MAX_AGENT_SKILLS)
        : [];
    if (!name || !roleLabel || !responsibilities || selectedSkills.length === 0) {
        return null;
    }
    return {
        name,
        role_label: (0, agentDesignAssistant_1.normalizeRoleLabel)(roleLabel),
        selected_skills: selectedSkills,
        responsibilities,
    };
}
function normalizeCompanyBuildPlan(value, availableSkills) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const companyName = typeof record.company_name === "string" && record.company_name.trim()
        ? record.company_name.trim()
        : "Generated Company";
    const agents = Array.isArray(record.agents)
        ? record.agents
            .map((agent) => normalizeAgentSpec(agent, availableSkills))
            .filter((agent) => agent !== null)
            .slice(0, MAX_AGENT_COUNT)
        : [];
    if (agents.length === 0)
        return null;
    return {
        company_name: companyName,
        agents,
        rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
    };
}
async function designCompany(request, skillCatalog) {
    if (!(0, tauriCli_1.isTauri)() || !request.goal.trim() || skillCatalog.length === 0) {
        return null;
    }
    try {
        const architectPrompt = await (0, tauriCli_1.getSkillPromptForCustom)("company_architect", [
            "ai-agents-architect",
            "product-manager-toolkit",
            "team-composition-analysis",
        ]);
        const userPrompt = [
            `Business goal: ${request.goal.trim()}`,
            request.industry?.trim() ? `Industry: ${request.industry.trim()}` : null,
            request.teamSize ? `Preferred team size: ${request.teamSize}` : null,
        ]
            .filter(Boolean)
            .join("\n");
        const result = await (0, tauriCli_1.runCliCommand)(userPrompt, {
            cwd: (0, tauriCli_1.getSavedWorkspacePath)(),
            systemPrompt: [
                architectPrompt.trim() || null,
                COMPANY_BUILDER_PROMPT,
                "SKILL CATALOG:",
                summarizeSkillCatalog(skillCatalog),
            ]
                .filter(Boolean)
                .join("\n\n---\n\n"),
        });
        if (!result)
            return null;
        const output = result.stdout.trim() || result.stderr.trim();
        if (!output)
            return null;
        const jsonBlock = (0, agentDesignAssistant_1.extractFirstJsonObject)(output);
        if (!jsonBlock)
            return null;
        return normalizeCompanyBuildPlan(JSON.parse(jsonBlock), skillCatalog);
    }
    catch {
        return null;
    }
}
