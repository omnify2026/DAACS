import {
  CONNECTOR_ADS,
  CONNECTOR_DEPLOY,
  CONNECTOR_DESIGN_ASSETS,
  CONNECTOR_DOCS,
  CONNECTOR_FINANCE,
  CONNECTOR_GIT,
  CONNECTOR_INTERNAL_WORKBENCH,
  CONNECTOR_RUNTIME_OPS,
  CONNECTOR_SEARCH,
  CONNECTOR_SOCIAL_PUBLISH,
  DEFAULT_AGENT_APPROVAL_MODE,
  DEFAULT_AGENT_APPROVER,
  DEFAULT_AGENT_INTERACTION_MOVEMENT,
  DEFAULT_AGENT_INTERACTION_RETURN,
  DEFAULT_AGENT_INTERACTION_SPEECH,
  DEFAULT_AGENT_WORKSPACE_MODE,
  WORKSPACE_MODE_BUILDER,
  WORKSPACE_MODE_CAMPAIGN,
  WORKSPACE_MODE_DESIGN,
  WORKSPACE_MODE_FINANCE,
  WORKSPACE_MODE_OPERATIONS,
  WORKSPACE_MODE_ORCHESTRATION,
  WORKSPACE_MODE_RESEARCH,
} from "../constants";
import type { AgentInteractionStyle, AgentOperatingProfile } from "../types/agent";
import type { JsonValue } from "../types/runtime";

type OperatingProfileSeed = {
  role?: string | null;
  capabilities?: string[];
  skillBundleRefs?: string[];
  focusMode?: string | null;
  toolPolicy?: JsonValue;
  approvalPolicy?: JsonValue;
  collaborationPolicy?: JsonValue;
};

type OperatingProfilePolicyInput = {
  role?: string | null;
  capabilities?: string[];
  skillBundleRefs?: string[];
  workspaceMode?: string | null;
  toolConnectors?: string[];
  allowedTools?: string[];
  approvalMode?: string | null;
  externalActionsRequireApproval?: boolean;
  defaultApprover?: string | null;
  interactionStyle?: Partial<AgentInteractionStyle> | null;
};

type OperatingProfilePolicies = {
  operatingProfile: AgentOperatingProfile;
  toolPolicy: Record<string, JsonValue>;
  approvalPolicy: Record<string, JsonValue>;
  collaborationPolicy: Record<string, JsonValue>;
};

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, JsonValue>;
}

function asString(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asBoolean(value: JsonValue | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeStringList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeStringList(
    value.filter((entry): entry is string => typeof entry === "string"),
  );
}

function collectSignals(
  seed: Omit<OperatingProfileSeed, "toolPolicy" | "approvalPolicy" | "collaborationPolicy">,
): Set<string> {
  const signals = new Set<string>();
  const push = (value: string | null | undefined) => {
    if (!value) return;
    for (const token of value
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean)) {
      signals.add(token);
    }
  };

  push(seed.role);
  push(seed.focusMode);
  for (const capability of seed.capabilities ?? []) push(capability);
  for (const bundleRef of seed.skillBundleRefs ?? []) push(bundleRef);
  return signals;
}

function hasAny(signals: Set<string>, values: string[]): boolean {
  return values.some((value) => signals.has(value));
}

function inferWorkspaceMode(signals: Set<string>): string {
  if (hasAny(signals, ["pm", "planner", "planning", "approval", "executive", "ceo"])) {
    return WORKSPACE_MODE_ORCHESTRATION;
  }
  if (
    hasAny(signals, [
      "marketing",
      "marketer",
      "campaign",
      "ads",
      "seo",
      "social",
      "content",
      "brand",
    ])
  ) {
    return WORKSPACE_MODE_CAMPAIGN;
  }
  if (hasAny(signals, ["research", "analysis", "analyst", "search", "insight", "strategy"])) {
    return WORKSPACE_MODE_RESEARCH;
  }
  if (hasAny(signals, ["design", "designer", "creative", "asset", "ui", "ux"])) {
    return WORKSPACE_MODE_DESIGN;
  }
  if (hasAny(signals, ["devops", "ops", "operations", "deploy", "infrastructure", "runtime"])) {
    return WORKSPACE_MODE_OPERATIONS;
  }
  if (hasAny(signals, ["finance", "cfo", "budget", "cost"])) {
    return WORKSPACE_MODE_FINANCE;
  }
  if (
    hasAny(signals, [
      "builder",
      "developer",
      "development",
      "frontend",
      "backend",
      "code",
      "implementation",
      "execution",
      "delivery",
    ])
  ) {
    return WORKSPACE_MODE_BUILDER;
  }
  return DEFAULT_AGENT_WORKSPACE_MODE;
}

function inferToolConnectors(signals: Set<string>): string[] {
  const connectors = new Set<string>([CONNECTOR_INTERNAL_WORKBENCH]);

  if (
    hasAny(signals, [
      "builder",
      "developer",
      "development",
      "frontend",
      "backend",
      "code",
      "implementation",
    ])
  ) {
    connectors.add(CONNECTOR_GIT);
    connectors.add(CONNECTOR_DOCS);
  }
  if (hasAny(signals, ["devops", "ops", "operations", "deploy", "runtime", "infrastructure"])) {
    connectors.add(CONNECTOR_RUNTIME_OPS);
    connectors.add(CONNECTOR_DEPLOY);
  }
  if (hasAny(signals, ["research", "analysis", "analyst", "search", "strategy", "insight"])) {
    connectors.add(CONNECTOR_SEARCH);
    connectors.add(CONNECTOR_DOCS);
  }
  if (
    hasAny(signals, [
      "marketing",
      "marketer",
      "campaign",
      "ads",
      "seo",
      "social",
      "content",
      "brand",
    ])
  ) {
    connectors.add(CONNECTOR_SOCIAL_PUBLISH);
    connectors.add(CONNECTOR_ADS);
    connectors.add(CONNECTOR_DOCS);
  }
  if (hasAny(signals, ["design", "designer", "creative", "asset", "ui", "ux"])) {
    connectors.add(CONNECTOR_DESIGN_ASSETS);
    connectors.add(CONNECTOR_DOCS);
  }
  if (hasAny(signals, ["finance", "cfo", "budget", "cost"])) {
    connectors.add(CONNECTOR_FINANCE);
    connectors.add(CONNECTOR_DOCS);
  }
  if (hasAny(signals, ["pm", "planner", "planning", "approval", "executive", "ceo"])) {
    connectors.add(CONNECTOR_DOCS);
  }

  return [...connectors];
}

function buildInteractionStyle(
  overrides?: Partial<AgentInteractionStyle> | null,
): AgentInteractionStyle {
  return {
    movement_mode: overrides?.movement_mode?.trim() || DEFAULT_AGENT_INTERACTION_MOVEMENT,
    speech_mode: overrides?.speech_mode?.trim() || DEFAULT_AGENT_INTERACTION_SPEECH,
    return_mode: overrides?.return_mode?.trim() || DEFAULT_AGENT_INTERACTION_RETURN,
  };
}

export function buildAgentOperatingProfile(seed: OperatingProfileSeed): AgentOperatingProfile {
  const toolPolicy = asRecord(seed.toolPolicy) ?? {};
  const approvalPolicy = asRecord(seed.approvalPolicy) ?? {};
  const collaborationPolicy = asRecord(seed.collaborationPolicy) ?? {};
  const interactionStyleRecord = asRecord(collaborationPolicy.interaction_style);
  const signals = collectSignals(seed);

  return {
    workspace_mode:
      asString(collaborationPolicy.workspace_mode) ?? inferWorkspaceMode(signals),
    tool_connectors:
      asStringArray(toolPolicy.connectors).length > 0
        ? asStringArray(toolPolicy.connectors)
        : inferToolConnectors(signals),
    allowed_tools: asStringArray(toolPolicy.allowed_tools),
    approval_mode: asString(approvalPolicy.mode) ?? DEFAULT_AGENT_APPROVAL_MODE,
    external_actions_require_approval:
      asBoolean(approvalPolicy.external_actions_require_approval) ?? true,
    default_approver:
      asString(approvalPolicy.default_approver) ??
      (asBoolean(approvalPolicy.external_actions_require_approval) === false
        ? null
        : DEFAULT_AGENT_APPROVER),
    interaction_style: buildInteractionStyle({
      movement_mode: asString(interactionStyleRecord?.movement_mode) ?? undefined,
      speech_mode: asString(interactionStyleRecord?.speech_mode) ?? undefined,
      return_mode: asString(interactionStyleRecord?.return_mode) ?? undefined,
    }),
  };
}

export function buildOperatingProfilePolicies(
  input: OperatingProfilePolicyInput,
): OperatingProfilePolicies {
  const signals = collectSignals({
    role: input.role,
    capabilities: input.capabilities,
    skillBundleRefs: input.skillBundleRefs,
    focusMode: input.workspaceMode,
  });
  const workspaceMode = input.workspaceMode?.trim() || inferWorkspaceMode(signals);
  const toolConnectors =
    normalizeStringList(input.toolConnectors).length > 0
      ? normalizeStringList(input.toolConnectors)
      : inferToolConnectors(signals);
  const allowedTools = normalizeStringList(input.allowedTools);
  const approvalMode = input.approvalMode?.trim() || DEFAULT_AGENT_APPROVAL_MODE;
  const interactionStyle = buildInteractionStyle(input.interactionStyle);
  const externalActionsRequireApproval = input.externalActionsRequireApproval ?? true;
  const defaultApprover =
    input.defaultApprover?.trim() ||
    (externalActionsRequireApproval ? DEFAULT_AGENT_APPROVER : null);

  const toolPolicy: Record<string, JsonValue> = {
    allowed_tools: allowedTools,
    connectors: toolConnectors,
  };
  const approvalPolicy: Record<string, JsonValue> = {
    mode: approvalMode,
    external_actions_require_approval: externalActionsRequireApproval,
  };
  if (defaultApprover) {
    approvalPolicy.default_approver = defaultApprover;
  }
  const collaborationPolicy: Record<string, JsonValue> = {
    workspace_mode: workspaceMode,
    interaction_style: {
      movement_mode: interactionStyle.movement_mode,
      speech_mode: interactionStyle.speech_mode,
      return_mode: interactionStyle.return_mode,
    },
  };

  return {
    operatingProfile: buildAgentOperatingProfile({
      role: input.role,
      capabilities: input.capabilities,
      skillBundleRefs: input.skillBundleRefs,
      focusMode: workspaceMode,
      toolPolicy,
      approvalPolicy,
      collaborationPolicy,
    }),
    toolPolicy,
    approvalPolicy,
    collaborationPolicy,
  };
}
