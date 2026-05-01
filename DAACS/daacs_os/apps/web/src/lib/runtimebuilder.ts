import type { Agent } from "../types/agent";
import { getAgentMeta } from "../types/agent";
import type { BlueprintInput } from "../types/runtime";
import {
  CONNECTOR_DESIGN_ASSETS,
  CONNECTOR_DOCS,
  CONNECTOR_GIT,
  CONNECTOR_SEARCH,
  DEFAULT_AGENT_APPROVAL_MODE,
  WORKSPACE_MODE_BUILDER,
  WORKSPACE_MODE_DESIGN,
  WORKSPACE_MODE_RESEARCH,
} from "../constants";
import { buildOperatingProfilePolicies } from "./agentOperatingProfile";

export type FactoryTemplate = {
  id: string;
  label: string;
  description: string;
  roleLabel: string;
  capabilities: string[];
  defaultBundleRole: string;
  accentColor: string;
  icon: string;
  homeZone: string;
  teamAffinity: string;
  primaryWidgets: string[];
  secondaryWidgets: string[];
  workspaceMode: string;
  toolConnectors: string[];
  approvalMode: string;
};

export const FACTORY_TEMPLATES: FactoryTemplate[] = [
  {
    id: "builder",
    label: "Builder",
    description: "Execution-heavy product builder",
    roleLabel: "builder_agent",
    capabilities: ["code_generation", "execution", "delivery"],
    defaultBundleRole: "developer",
    accentColor: "#22C55E",
    icon: "Hammer",
    homeZone: "rd_lab",
    teamAffinity: "development_team",
    primaryWidgets: ["code", "git"],
    secondaryWidgets: ["timeline"],
    workspaceMode: WORKSPACE_MODE_BUILDER,
    toolConnectors: [CONNECTOR_GIT, CONNECTOR_DOCS],
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE,
  },
  {
    id: "researcher",
    label: "Researcher",
    description: "Evidence and synthesis oriented analyst",
    roleLabel: "research_agent",
    capabilities: ["research", "summary", "analysis"],
    defaultBundleRole: "pm",
    accentColor: "#14B8A6",
    icon: "Search",
    homeZone: "strategy_hub",
    teamAffinity: "strategy_team",
    primaryWidgets: ["content", "approval_queue"],
    secondaryWidgets: ["timeline"],
    workspaceMode: WORKSPACE_MODE_RESEARCH,
    toolConnectors: [CONNECTOR_SEARCH, CONNECTOR_DOCS],
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE,
  },
  {
    id: "creative",
    label: "Creative",
    description: "Design, asset, and review oriented agent",
    roleLabel: "creative_agent",
    capabilities: ["design", "assets", "review"],
    defaultBundleRole: "designer",
    accentColor: "#F97316",
    icon: "Palette",
    homeZone: "design_studio",
    teamAffinity: "creative_team",
    primaryWidgets: ["preview", "assets"],
    secondaryWidgets: ["timeline"],
    workspaceMode: WORKSPACE_MODE_DESIGN,
    toolConnectors: [CONNECTOR_DESIGN_ASSETS, CONNECTOR_DOCS],
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE,
  },
];

const TEMPLATE_SIGNAL_MAP: Record<string, string[]> = {
  builder: [
    "builder",
    "build",
    "developer",
    "development",
    "frontend",
    "backend",
    "engineer",
    "implementation",
    "execution",
    "delivery",
    "code",
    "devops",
  ],
  researcher: [
    "research",
    "researcher",
    "analysis",
    "analyst",
    "strategy",
    "planner",
    "planning",
    "pm",
    "product",
    "review",
    "reviewer",
    "ceo",
    "cfo",
    "marketing",
    "marketer",
    "campaign",
    "content",
    "seo",
    "brand",
    "social",
  ],
  creative: [
    "creative",
    "design",
    "designer",
    "asset",
    "assets",
    "figma",
    "visual",
    "branding",
    "ui",
    "ux",
  ],
};

function collectSignalTokens(values: string[]): Set<string> {
  const tokens = new Set<string>();
  for (const value of values) {
    for (const token of value
      .trim()
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean)) {
      tokens.add(token);
    }
  }
  return tokens;
}

export function inferTemplateFromSignals(
  capabilities: string[],
  skillBundleRefs: string[],
  roleLabel?: string,
): FactoryTemplate {
  const signalTokens = collectSignalTokens([
    ...capabilities,
    ...skillBundleRefs,
    roleLabel ?? "",
  ]);
  const normalizedSkills = new Set(
    skillBundleRefs.map((value) => value.trim().toLowerCase()).filter(Boolean),
  );

  const scoredTemplates = FACTORY_TEMPLATES.map((template) => {
    const templateSignals = TEMPLATE_SIGNAL_MAP[template.id] ?? [];
    let score = 0;

    if (normalizedSkills.has(template.defaultBundleRole.toLowerCase())) {
      score += 6;
    }
    if (signalTokens.has(template.id.toLowerCase())) {
      score += 4;
    }
    if (signalTokens.has(template.roleLabel.toLowerCase())) {
      score += 4;
    }

    for (const token of templateSignals) {
      if (signalTokens.has(token)) {
        score += 2;
      }
    }

    return { template, score };
  });

  const bestTemplate = scoredTemplates.reduce(
    (best, current) => (current.score > best.score ? current : best),
    scoredTemplates[0] ?? { template: FACTORY_TEMPLATES[0], score: 0 },
  );

  return bestTemplate.score > 0 ? bestTemplate.template : FACTORY_TEMPLATES[0];
}

export type FactoryDraftInput = {
  name: string;
  prompt: string;
  roleLabel?: string;
  capabilities?: string[];
  skillBundleRefs?: string[];
  toolAllowlist?: string[];
  permissionMode?: string;
  memoryMode?: string;
  accentColor?: string;
  icon?: string;
  homeZone?: string;
  teamAffinity?: string;
  authorityLevel?: number;
  focusMode?: string;
  meetingBehavior?: string;
  primaryWidgets?: string[];
  secondaryWidgets?: string[];
  workspaceMode?: string;
  toolConnectors?: string[];
  approvalMode?: string;
};

export type FactoryBlueprintDraft = {
  blueprint: BlueprintInput;
  previewAgent: Agent;
};

function normalizeRoleLabel(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function buildFactoryBlueprintDraft(
  template: FactoryTemplate,
  input: FactoryDraftInput,
): FactoryBlueprintDraft {
  const name = input.name.trim() || `${template.label} Agent`;
  const roleLabel = normalizeRoleLabel(input.roleLabel ?? name, template.roleLabel);
  const capabilities = input.capabilities?.length
    ? [...new Set(input.capabilities.map((value) => value.trim()).filter(Boolean))]
    : template.capabilities;
  const skillBundleRefs = input.skillBundleRefs?.length
    ? [...new Set(input.skillBundleRefs.map((value) => value.trim()).filter(Boolean))]
    : [template.defaultBundleRole];
  const toolAllowlist = input.toolAllowlist?.length
    ? [...new Set(input.toolAllowlist.map((value) => value.trim()).filter(Boolean))]
    : [];
  const accentColor = input.accentColor?.trim() || template.accentColor;
  const icon = input.icon?.trim() || template.icon;
  const primaryWidgets = input.primaryWidgets?.length
    ? [...new Set(input.primaryWidgets.map((value) => value.trim()).filter(Boolean))]
    : template.primaryWidgets;
  const secondaryWidgets = input.secondaryWidgets?.length
    ? [...new Set(input.secondaryWidgets.map((value) => value.trim()).filter(Boolean))]
    : template.secondaryWidgets;
  const operatingProfile = buildOperatingProfilePolicies({
    role: roleLabel,
    capabilities,
    skillBundleRefs,
    workspaceMode: input.workspaceMode?.trim(),
    toolConnectors: input.toolConnectors?.length ? input.toolConnectors : undefined,
    allowedTools: toolAllowlist,
    approvalMode: input.approvalMode?.trim() || template.approvalMode,
  });

  const blueprint: BlueprintInput = {
    name,
    role_label: roleLabel,
    capabilities,
    prompt_bundle_ref: input.prompt.trim() || null,
    skill_bundle_refs: skillBundleRefs,
    tool_policy: operatingProfile.toolPolicy,
    permission_policy: input.permissionMode?.trim()
      ? { mode: input.permissionMode.trim() }
      : {},
    memory_policy: input.memoryMode?.trim()
      ? { mode: input.memoryMode.trim() }
      : {},
    collaboration_policy: operatingProfile.collaborationPolicy,
    approval_policy: operatingProfile.approvalPolicy,
    ui_profile: {
      display_name: name,
      title: name,
      accent_color: accentColor,
      icon,
      home_zone: input.homeZone?.trim() || template.homeZone,
      team_affinity: input.teamAffinity?.trim() || template.teamAffinity,
      authority_level: input.authorityLevel ?? 20,
      capability_tags: capabilities,
      primary_widgets: primaryWidgets,
      secondary_widgets: secondaryWidgets,
      focus_mode: input.focusMode?.trim() || template.id,
      meeting_behavior: input.meetingBehavior?.trim() || "adaptive",
    },
  };

  const meta = getAgentMeta(roleLabel, {
    name,
    title: name,
    color: accentColor,
    icon,
  });

  return {
    blueprint,
    previewAgent: {
      id: `preview-${roleLabel}`,
      role: roleLabel,
      name,
      meta,
      position: { x: 0, y: 0 },
      path: [],
      status: "idle",
      runtimeStatus: "idle",
      capabilities,
      operatingProfile: operatingProfile.operatingProfile,
      assignedTeam: blueprint.ui_profile?.team_affinity ?? null,
      uiProfile: {
        display_name: name,
        title: name,
        accent_color: accentColor,
        icon,
        home_zone: blueprint.ui_profile?.home_zone,
        team_affinity: blueprint.ui_profile?.team_affinity,
        authority_level: blueprint.ui_profile?.authority_level,
        capability_tags: capabilities,
        primary_widgets: primaryWidgets,
        secondary_widgets: secondaryWidgets,
        focus_mode: blueprint.ui_profile?.focus_mode,
        meeting_behavior: blueprint.ui_profile?.meeting_behavior,
      },
    },
  };
}
