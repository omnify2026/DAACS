// src/lib/agentDesignAssistant.ts
var MAX_SELECTED_SKILLS = 12;
var DESIGN_SYSTEM_PROMPT_SUFFIX = `
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
  "accent_color": "#22C55E",
  "home_zone": "rd_lab | strategy_hub | design_studio | server_farm",
  "team_affinity": "development_team | strategy_team | creative_team | operations_team",
  "tool_connectors": ["git_connector", "docs_connector"],
  "explanation": "Why this configuration is optimal"
}
`.trim();
function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function toTitleCase(value) {
  return value.split("_").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function normalizeRoleLabel(value, fallback2 = "suggested_agent") {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback2;
}
function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    )
  ];
}
function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function normalizeOptionalStringList(value) {
  if (!Array.isArray(value)) return void 0;
  const items = [
    ...new Set(
      value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
    )
  ];
  return items.length > 0 ? items : void 0;
}
function availableSkillMap(availableSkills) {
  return new Map(
    availableSkills.map((skill) => [normalizeKey(skill.id), skill.id])
  );
}
function resolveAvailableSkill(value, availableSkills) {
  const skillMap = availableSkillMap(availableSkills);
  return skillMap.get(normalizeKey(value)) ?? null;
}
function normalizeSelectedSkills(value, availableSkills) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter((item) => typeof item === "string").map((item) => resolveAvailableSkill(item, availableSkills)).filter((item) => !!item)
    )
  ].slice(0, MAX_SELECTED_SKILLS);
}
function extractFirstJsonObject(text) {
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
        continue;
      }
      if (char !== "}") continue;
      depth -= 1;
      if (depth !== 0) continue;
      const candidate = text.slice(start, index + 1);
      try {
        JSON.parse(candidate);
        return candidate;
      } catch {
        break;
      }
    }
  }
  return null;
}
function normalizeBlueprintSuggestion(value, availableSkills) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const rawRoleLabel = typeof record.role_label === "string" ? record.role_label.trim() : "";
  const normalizedRoleLabel = normalizeRoleLabel(rawRoleLabel);
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : rawRoleLabel ? toTitleCase(normalizedRoleLabel) : "";
  if (!name && !rawRoleLabel) return null;
  const capabilities = normalizeCapabilities(record.capabilities);
  const selectedSkills = normalizeSelectedSkills(record.selected_skills, availableSkills);
  const fallbackSelectedSkills = selectedSkills.length > 0 ? selectedSkills : normalizeSelectedSkills(record.skill_bundle_refs, availableSkills);
  if (fallbackSelectedSkills.length === 0) {
    return null;
  }
  return {
    name: name || toTitleCase(normalizedRoleLabel),
    role_label: normalizedRoleLabel,
    capabilities,
    skill_bundle_refs: fallbackSelectedSkills,
    explanation: typeof record.explanation === "string" ? record.explanation.trim() : "",
    accent_color: normalizeOptionalString(record.accent_color),
    home_zone: normalizeOptionalString(record.home_zone),
    team_affinity: normalizeOptionalString(record.team_affinity),
    tool_connectors: normalizeOptionalStringList(record.tool_connectors)
  };
}

// src/lib/agentDesignAssistant.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var skills = [
  {
    id: "typescript-pro",
    description: "Advanced TypeScript patterns and type safety."
  },
  {
    id: "clean-code",
    description: "Readable, maintainable implementation discipline."
  },
  {
    id: "code-reviewer",
    description: "Review changes for correctness and risk."
  },
  {
    id: "security-auditor",
    description: "Analyze security posture and implementation gaps."
  }
];
var extracted = extractFirstJsonObject(`
The best answer is below.

\`\`\`json
{
  "name": "Security Reviewer",
  "role_label": "security reviewer",
  "capabilities": ["review", "security"],
  "selected_skills": ["code-reviewer", "security-auditor"],
  "accent_color": "#14B8A6",
  "home_zone": "strategy_hub",
  "team_affinity": "strategy_team",
  "tool_connectors": ["search_connector", "docs_connector"],
  "explanation": "Use the reviewer bundle."
}
\`\`\`
`);
assert(extracted !== null, "extractFirstJsonObject should recover a JSON block from markdown output");
var parsed = normalizeBlueprintSuggestion(JSON.parse(extracted), skills);
assert(parsed !== null, "normalizeBlueprintSuggestion should accept a valid JSON payload");
assert(parsed?.role_label === "security_reviewer", "role labels should normalize to snake_case");
assert(parsed?.skill_bundle_refs[0] === "code-reviewer", "selected skills should normalize to canonical skill IDs");
assert(parsed?.accent_color === "#14B8A6", "normalizeBlueprintSuggestion should preserve accent color hints");
assert(parsed?.tool_connectors?.includes("search_connector"), "normalizeBlueprintSuggestion should preserve connector hints");
var fallback = normalizeBlueprintSuggestion(
  {
    name: "Builder Agent",
    role_label: "builder_agent",
    capabilities: ["implementation", "engineer"],
    selected_skills: ["typescript-pro", "clean-code"],
    explanation: "Developer-oriented execution agent."
  },
  skills
);
assert(fallback !== null, "normalizeBlueprintSuggestion should keep structurally valid suggestions");
assert(fallback?.skill_bundle_refs[0] === "typescript-pro", "selected skills should be preserved");
console.log("agentDesignAssistant tests passed");
