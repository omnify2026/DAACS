import {
  extractFirstJsonObject,
  normalizeRoleLabel,
} from "./agentDesignAssistant";
import {
  getSavedWorkspacePath,
  getSkillPromptForCustom,
  isTauri,
  runCliCommand,
} from "../services/tauriCli";
import type { SkillMeta } from "../types/runtime";

export interface CompanyBuildRequest {
  goal: string;
  industry?: string;
  teamSize?: number;
}

export interface AgentSpec {
  name: string;
  role_label: string;
  selected_skills: string[];
  responsibilities: string;
}

export interface CompanyBuildPlan {
  company_name: string;
  agents: AgentSpec[];
  rationale: string;
}

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

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function summarizeSkillCatalog(availableSkills: SkillMeta[]): string {
  return availableSkills
    .map((skill) => `- ${skill.id}: ${skill.description || "No description provided."}`)
    .join("\n");
}

function resolveAvailableSkill(value: string, availableSkills: SkillMeta[]): string | null {
  const lookup = new Map(availableSkills.map((skill) => [normalizeKey(skill.id), skill.id]));
  return lookup.get(normalizeKey(value)) ?? null;
}

function normalizeAgentSpec(value: unknown, availableSkills: SkillMeta[]): AgentSpec | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const roleLabel = typeof record.role_label === "string" ? record.role_label.trim() : "";
  const responsibilities =
    typeof record.responsibilities === "string" ? record.responsibilities.trim() : "";
  const selectedSkills = Array.isArray(record.selected_skills)
    ? [
        ...new Set(
          record.selected_skills
            .filter((item): item is string => typeof item === "string")
            .map((item) => resolveAvailableSkill(item, availableSkills))
            .filter((item): item is string => !!item),
        ),
      ].slice(0, MAX_AGENT_SKILLS)
    : [];

  if (!name || !roleLabel || !responsibilities || selectedSkills.length === 0) {
    return null;
  }

  return {
    name,
    role_label: normalizeRoleLabel(roleLabel),
    selected_skills: selectedSkills,
    responsibilities,
  };
}

export function normalizeCompanyBuildPlan(
  value: unknown,
  availableSkills: SkillMeta[],
): CompanyBuildPlan | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const companyName =
    typeof record.company_name === "string" && record.company_name.trim()
      ? record.company_name.trim()
      : "Generated Company";
  const agents = Array.isArray(record.agents)
    ? record.agents
        .map((agent) => normalizeAgentSpec(agent, availableSkills))
        .filter((agent): agent is AgentSpec => agent !== null)
        .slice(0, MAX_AGENT_COUNT)
    : [];
  if (agents.length === 0) return null;

  return {
    company_name: companyName,
    agents,
    rationale: typeof record.rationale === "string" ? record.rationale.trim() : "",
  };
}

export async function designCompany(
  request: CompanyBuildRequest,
  skillCatalog: SkillMeta[],
  projectId?: string | null,
): Promise<CompanyBuildPlan | null> {
  if (!isTauri() || !request.goal.trim() || skillCatalog.length === 0) {
    return null;
  }

  try {
    const architectPrompt = await getSkillPromptForCustom("company_architect", [
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

    const result = await runCliCommand(userPrompt, {
      cwd: getSavedWorkspacePath(projectId),
      systemPrompt: [
        architectPrompt.trim() || null,
        COMPANY_BUILDER_PROMPT,
        "SKILL CATALOG:",
        summarizeSkillCatalog(skillCatalog),
      ]
        .filter(Boolean)
        .join("\n\n---\n\n"),
    });

    if (!result) return null;

    const output = result.stdout.trim() || result.stderr.trim();
    if (!output) return null;

    const jsonBlock = extractFirstJsonObject(output);
    if (!jsonBlock) return null;

    return normalizeCompanyBuildPlan(JSON.parse(jsonBlock), skillCatalog);
  } catch {
    return null;
  }
}
