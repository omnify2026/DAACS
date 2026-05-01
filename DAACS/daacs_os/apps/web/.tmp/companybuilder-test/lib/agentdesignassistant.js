import { getSavedWorkspacePath, getSkillPromptForCustom, isTauri, runCliCommand, } from "../services/tauriCli";
const MAX_SELECTED_SKILLS = 12;
const DESIGN_SYSTEM_PROMPT_SUFFIX = `
You are an AI Agent Architect designing a DAACS custom agent.

Given a user's intent and the available skill catalog, select 5 to 12 skills that best match the role.
Prefer concrete, implementation-relevant skill IDs from the catalog. Do not invent skill IDs.
Prefer concise, concrete capability names.

Return ONLY valid JSON with this exact structure:
{
  "name": "Agent Name",
  "role_label": "snake_case_role",
  "capabilities": ["cap1", "cap2"],
  "selected_skills": ["skill-id-1", "skill-id-2"],
  "explanation": "Why this configuration is optimal"
}
`.trim();
function normalizeKey(value) {
    return String(value ?? "")
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
}
function toTitleCase(value) {
    return value
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
export function normalizeRoleLabel(value, fallback = "suggested_agent") {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return normalized || fallback;
}
function normalizeCapabilities(value) {
    if (!Array.isArray(value))
        return [];
    return [
        ...new Set(value
            .filter((item) => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)),
    ];
}
function availableSkillMap(availableSkills) {
    return new Map(availableSkills.map((skill) => [normalizeKey(skill.id), skill.id]));
}
function resolveAvailableSkill(value, availableSkills) {
    const skillMap = availableSkillMap(availableSkills);
    return skillMap.get(normalizeKey(value)) ?? null;
}
function normalizeSelectedSkills(value, availableSkills) {
    if (!Array.isArray(value))
        return [];
    return [
        ...new Set(value
            .filter((item) => typeof item === "string")
            .map((item) => resolveAvailableSkill(item, availableSkills))
            .filter((item) => !!item)),
    ].slice(0, MAX_SELECTED_SKILLS);
}
export function extractFirstJsonObject(text) {
    for (let start = 0; start < text.length; start++) {
        if (text[start] !== "{")
            continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index++) {
            const char = text[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                }
                else if (char === "\\") {
                    escaped = true;
                }
                else if (char === "\"") {
                    inString = false;
                }
                continue;
            }
            if (char === "\"") {
                inString = true;
                continue;
            }
            if (char === "{") {
                depth += 1;
                continue;
            }
            if (char !== "}")
                continue;
            depth -= 1;
            if (depth !== 0)
                continue;
            const candidate = text.slice(start, index + 1);
            try {
                JSON.parse(candidate);
                return candidate;
            }
            catch {
                break;
            }
        }
    }
    return null;
}
export function normalizeBlueprintSuggestion(value, availableSkills) {
    if (!value || typeof value !== "object")
        return null;
    const record = value;
    const rawRoleLabel = typeof record.role_label === "string" ? record.role_label.trim() : "";
    const normalizedRoleLabel = normalizeRoleLabel(rawRoleLabel);
    const name = typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : rawRoleLabel
            ? toTitleCase(normalizedRoleLabel)
            : "";
    if (!name && !rawRoleLabel)
        return null;
    const capabilities = normalizeCapabilities(record.capabilities);
    const selectedSkills = normalizeSelectedSkills(record.selected_skills, availableSkills);
    const fallbackSelectedSkills = selectedSkills.length > 0
        ? selectedSkills
        : normalizeSelectedSkills(record.skill_bundle_refs, availableSkills);
    if (fallbackSelectedSkills.length === 0) {
        return null;
    }
    return {
        name: name || toTitleCase(normalizedRoleLabel),
        role_label: normalizedRoleLabel,
        capabilities,
        skill_bundle_refs: fallbackSelectedSkills,
        explanation: typeof record.explanation === "string" ? record.explanation.trim() : "",
    };
}
function summarizeSkillCatalog(availableSkills) {
    return availableSkills
        .map((skill) => `- ${skill.id}: ${skill.description || "No description provided."}`)
        .join("\n");
}
export async function suggestAgentBlueprint(intent, availableSkills) {
    if (!isTauri() || !intent.trim() || availableSkills.length === 0) {
        return null;
    }
    try {
        const architectPrompt = await getSkillPromptForCustom("agent_architect", [
            "ai-agents-architect",
            "product-manager-toolkit",
        ]);
        const systemPrompt = [
            architectPrompt.trim() || null,
            DESIGN_SYSTEM_PROMPT_SUFFIX,
            "SKILL CATALOG:",
            summarizeSkillCatalog(availableSkills),
        ]
            .filter(Boolean)
            .join("\n\n---\n\n");
        const result = await runCliCommand(`Design a DAACS custom agent for this intent:\n${intent.trim()}`, {
            cwd: getSavedWorkspacePath(),
            systemPrompt,
        });
        if (!result)
            return null;
        const output = result.stdout.trim() || result.stderr.trim();
        if (!output)
            return null;
        const jsonBlock = extractFirstJsonObject(output);
        if (!jsonBlock)
            return null;
        const parsed = JSON.parse(jsonBlock);
        return normalizeBlueprintSuggestion(parsed, availableSkills);
    }
    catch {
        return null;
    }
}
