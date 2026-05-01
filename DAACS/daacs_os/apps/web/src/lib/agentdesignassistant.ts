import {
  getSavedWorkspacePath,
  isTauri,
  readPromptFileByKey,
  runCliCommand,
} from "../services/tauriCli";
import type { SkillMeta } from "../types/runtime";

export interface BlueprintSuggestion {
  name: string;
  role_label: string;
  capabilities: string[];
  skill_bundle_refs: string[];
  agent_prompt?: string;
  explanation: string;
  accent_color?: string;
  home_zone?: string;
  team_affinity?: string;
  tool_connectors?: string[];
}

const MAX_SELECTED_SKILLS = 12;

const PROMPT_KEY_AGENT_FACTORY_REDESIGN = "agent_factory_redesign";

const FALLBACK_AGENT_FACTORY_REDESIGN =
  "You design DAACS custom agents. Given a user description and a following SKILL CATALOG, return strict JSON only with two keys: prompt (system instructions for the new agent, English only—no Korean or other non-English in the prompt text) and skills (array of 5-12 catalog skill IDs only, no invented IDs).";

function TryParsePromptDocContent(raw: string): string | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    const content = record.content;
    if (typeof content === "string") {
      const trimmed = content.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(content) && content.every((item) => typeof item === "string")) {
      const joined = (content as string[]).join("\n").trim();
      return joined.length > 0 ? joined : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function LoadAgentFactoryRedesignSystemPrompt(): Promise<string> {
  try {
    const raw = await readPromptFileByKey(PROMPT_KEY_AGENT_FACTORY_REDESIGN);
    const body = TryParsePromptDocContent(raw);
    if (body) return body;
  } catch {
    return FALLBACK_AGENT_FACTORY_REDESIGN;
  }
  return FALLBACK_AGENT_FACTORY_REDESIGN;
}

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function toTitleCase(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function normalizeRoleLabel(value: string, fallback = "suggested_agent"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeOptionalStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  return items.length > 0 ? items : undefined;
}

function availableSkillMap(availableSkills: SkillMeta[]): Map<string, string> {
  return new Map(
    availableSkills.map((skill) => [normalizeKey(skill.id), skill.id]),
  );
}

function resolveAvailableSkill(
  value: string,
  availableSkills: SkillMeta[],
): string | null {
  const skillMap = availableSkillMap(availableSkills);
  return skillMap.get(normalizeKey(value)) ?? null;
}

function normalizeSelectedSkills(
  value: unknown,
  availableSkills: SkillMeta[],
): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => resolveAvailableSkill(item, availableSkills))
        .filter((item): item is string => !!item),
    ),
  ].slice(0, MAX_SELECTED_SKILLS);
}

export function extractFirstJsonObject(text: string): string | null {
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
        } else if (char === "\"") {
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

function IntentDerivedRoleLabel(intentSource: string): string {
  const fromIntent = normalizeRoleLabel(intentSource);
  if (fromIntent !== "suggested_agent") return fromIntent;
  return "custom_agent";
}

export function normalizeBlueprintSuggestion(
  value: unknown,
  availableSkills: SkillMeta[],
  intentSource: string,
): BlueprintSuggestion | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const intent = intentSource.trim();

  const promptText =
    normalizeOptionalString(record.prompt) ?? normalizeOptionalString(record.agent_prompt);
  if (!promptText) return null;

  const fromSkills = normalizeSelectedSkills(record.skills, availableSkills);
  const fromSelected = normalizeSelectedSkills(record.selected_skills, availableSkills);
  const fromBundle = normalizeSelectedSkills(record.skill_bundle_refs, availableSkills);
  const fallbackSelectedSkills =
    fromSkills.length > 0 ? fromSkills : fromSelected.length > 0 ? fromSelected : fromBundle;

  if (fallbackSelectedSkills.length === 0) return null;

  const rawRoleLabel = typeof record.role_label === "string" ? record.role_label.trim() : "";
  const normalizedRoleLabel = rawRoleLabel
    ? normalizeRoleLabel(rawRoleLabel)
    : IntentDerivedRoleLabel(intent);

  const explicitName = typeof record.name === "string" ? record.name.trim() : "";
  const headline = intent.split("\n")[0]?.trim() ?? "";
  const name =
    explicitName.length > 0
      ? explicitName
      : headline.length > 0
        ? headline.length > 100
          ? `${headline.slice(0, 97)}...`
          : headline
        : toTitleCase(normalizedRoleLabel);

  const capabilities = normalizeCapabilities(record.capabilities);

  return {
    name,
    role_label: normalizedRoleLabel,
    capabilities,
    skill_bundle_refs: fallbackSelectedSkills,
    agent_prompt: promptText,
    explanation: typeof record.explanation === "string" ? record.explanation.trim() : "",
    accent_color: normalizeOptionalString(record.accent_color),
    home_zone: normalizeOptionalString(record.home_zone),
    team_affinity: normalizeOptionalString(record.team_affinity),
    tool_connectors: normalizeOptionalStringList(record.tool_connectors),
  };
}

function summarizeSkillCatalog(availableSkills: SkillMeta[]): string {
  return availableSkills
    .map((skill) => `- ${skill.id}: ${skill.description || "No description provided."}`)
    .join("\n");
}

export async function suggestAgentBlueprint(
  intent: string,
  availableSkills: SkillMeta[],
  projectId?: string | null,
): Promise<BlueprintSuggestion | null> {
  if (!isTauri() || !intent.trim() || availableSkills.length === 0) {
    return null;
  }

  try {
    const redesignCore = await LoadAgentFactoryRedesignSystemPrompt();
    const systemPrompt = [
      redesignCore,
      "SKILL CATALOG:",
      summarizeSkillCatalog(availableSkills),
    ].join("\n\n");

    const result = await runCliCommand(
      `Design a DAACS custom agent for this intent:\n${intent.trim()}`,
      {
        cwd: getSavedWorkspacePath(projectId),
        systemPrompt,
      },
    );

    if (!result) return null;

    const output = result.stdout.trim() || result.stderr.trim();
    if (!output) return null;

    const jsonBlock = extractFirstJsonObject(output);
    if (!jsonBlock) return null;

    const parsed = JSON.parse(jsonBlock) as unknown;
    return normalizeBlueprintSuggestion(parsed, availableSkills, intent.trim());
  } catch {
    return null;
  }
}
