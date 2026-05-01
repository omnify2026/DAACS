import type { BlueprintSuggestion } from "../../lib/agentDesignAssistant";
import type { BlueprintInput } from "../../types/runtime";
import { STORAGE_KEY_FACTORY_DRAFT } from "../../constants";

export type FactoryStep = "brief" | "edit" | "preview";

export type BuilderDraftSnapshot = {
  step: FactoryStep;
  brief: string;
  name: string;
  roleLabel: string;
  capabilities: string;
  skillSearch: string;
  skillBrowserOpen: boolean;
  skillBundleRefs: string[];
  prompt: string;
  accentColor: string;
  homeZone: string;
  teamAffinity: string;
  authorityLevel: string;
  focusMode: string;
  meetingBehavior: string;
  primaryWidgets: string;
  secondaryWidgets: string;
  toolAllowlist: string;
  permissionMode: string;
  memoryMode: string;
  blueprintJson: string;
};

export const DEFAULT_FACTORY_SNAPSHOT: BuilderDraftSnapshot = {
  step: "brief",
  brief: "",
  name: "",
  roleLabel: "",
  capabilities: "",
  skillSearch: "",
  skillBrowserOpen: false,
  skillBundleRefs: [],
  prompt: "",
  accentColor: "",
  homeZone: "",
  teamAffinity: "",
  authorityLevel: "20",
  focusMode: "",
  meetingBehavior: "",
  primaryWidgets: "",
  secondaryWidgets: "",
  toolAllowlist: "",
  permissionMode: "workspace_scoped",
  memoryMode: "session_scoped",
  blueprintJson: "",
};

export const BRIEF_EXAMPLE_KEYS = [
  "factory.example.threeDDeveloper",
  "factory.example.growthMarketer",
  "factory.example.securityAuditor",
  "factory.example.dataEngineer",
  "factory.example.brandDesigner",
  "factory.example.opsStrategist",
] as const;

export function splitCsv(value: string, fallback: string[] = []): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length > 0 ? items : fallback;
}

export function loadSnapshot(): BuilderDraftSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_FACTORY_DRAFT);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BuilderDraftSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      ...DEFAULT_FACTORY_SNAPSHOT,
      ...parsed,
      step:
        parsed.step === "edit" || parsed.step === "preview" ? parsed.step : "brief",
      skillBrowserOpen: parsed.skillBrowserOpen === true,
      skillBundleRefs: Array.isArray(parsed.skillBundleRefs)
        ? parsed.skillBundleRefs.filter((value): value is string => typeof value === "string")
        : [],
    };
  } catch {
    return null;
  }
}

export function saveSnapshot(snapshot: BuilderDraftSnapshot) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY_FACTORY_DRAFT, JSON.stringify(snapshot));
}

export function clearSnapshot() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY_FACTORY_DRAFT);
}

export function patchFromSuggestion(
  suggestion: BlueprintSuggestion,
  description: string,
): Partial<BuilderDraftSnapshot> {
  const appliedPrompt =
    typeof suggestion.agent_prompt === "string" && suggestion.agent_prompt.trim() !== ""
      ? suggestion.agent_prompt.trim()
      : description.trim();
  return {
    step: "edit",
    name: suggestion.name,
    roleLabel: suggestion.role_label,
    capabilities: suggestion.capabilities.join(", "),
    skillBundleRefs: suggestion.skill_bundle_refs,
    prompt: appliedPrompt,
    accentColor: suggestion.accent_color ?? "",
    homeZone: suggestion.home_zone ?? "",
    teamAffinity: suggestion.team_affinity ?? "",
    skillBrowserOpen: false,
  };
}

export function patchFromBlueprint(parsed: BlueprintInput): Partial<BuilderDraftSnapshot> {
  return {
    step: "preview",
    brief:
      typeof parsed.prompt_bundle_ref === "string" ? parsed.prompt_bundle_ref : "",
    name: parsed.name ?? "",
    roleLabel: parsed.role_label ?? "",
    capabilities: (parsed.capabilities ?? []).join(", "),
    skillSearch: "",
    skillBundleRefs: parsed.skill_bundle_refs ?? [],
    prompt:
      typeof parsed.prompt_bundle_ref === "string" ? parsed.prompt_bundle_ref : "",
    accentColor: parsed.ui_profile?.accent_color ?? "",
    homeZone: parsed.ui_profile?.home_zone ?? "",
    teamAffinity: parsed.ui_profile?.team_affinity ?? "",
    authorityLevel: String(parsed.ui_profile?.authority_level ?? 20),
    focusMode: parsed.ui_profile?.focus_mode ?? "",
    meetingBehavior: parsed.ui_profile?.meeting_behavior ?? "",
    primaryWidgets: (parsed.ui_profile?.primary_widgets ?? []).join(", "),
    secondaryWidgets: (parsed.ui_profile?.secondary_widgets ?? []).join(", "),
    toolAllowlist: Array.isArray(
      (parsed.tool_policy as { allowed_tools?: string[] } | undefined)?.allowed_tools,
    )
      ? (
          (parsed.tool_policy as { allowed_tools?: string[] }).allowed_tools ?? []
        ).join(", ")
      : "",
    permissionMode:
      typeof (parsed.permission_policy as { mode?: string } | undefined)?.mode ===
      "string"
        ? (parsed.permission_policy as { mode?: string }).mode ?? "workspace_scoped"
        : "workspace_scoped",
    memoryMode:
      typeof (parsed.memory_policy as { mode?: string } | undefined)?.mode === "string"
        ? (parsed.memory_policy as { mode?: string }).mode ?? "session_scoped"
        : "session_scoped",
  };
}
