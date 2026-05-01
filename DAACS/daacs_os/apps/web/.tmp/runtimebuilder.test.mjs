// src/types/agent.ts
var AGENT_ROLES = [
  "ceo",
  "pm",
  "developer_front",
  "developer_back",
  "devops",
  "marketer",
  "designer",
  "cfo"
];
var AGENT_META = {
  ceo: { name: "CEO", title: "CEO", color: "#8B5CF6", icon: "Crown" },
  pm: { name: "PM", title: "\uD504\uB85C\uC81D\uD2B8 \uB9E4\uB2C8\uC800", color: "#6366F1", icon: "ClipboardList" },
  developer_front: { name: "\uAC1C\uBC1C\uC790 Front", title: "\uD504\uB860\uD2B8\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#3B82F6", icon: "Code" },
  developer_back: { name: "\uAC1C\uBC1C\uC790 Back", title: "\uBC31\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#EF4444", icon: "Search" },
  devops: { name: "\uB370\uBE0C\uC635\uC2A4", title: "\uB370\uBE0C\uC635\uC2A4 \uC5D4\uC9C0\uB2C8\uC5B4", color: "#10B981", icon: "Terminal" },
  marketer: { name: "\uB9C8\uCF00\uD130", title: "\uB9C8\uCF00\uD130", color: "#EC4899", icon: "Megaphone" },
  designer: { name: "\uB514\uC790\uC774\uB108", title: "UI/UX \uB514\uC790\uC774\uB108", color: "#F97316", icon: "Palette" },
  cfo: { name: "CFO", title: "\uC7AC\uBB34", color: "#EAB308", icon: "Calculator" }
};
function isBuiltinAgentRole(value) {
  return typeof value === "string" && AGENT_ROLES.includes(value);
}
function humanizeRoleLabel(role) {
  return role.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function getAgentMeta(role, overrides) {
  const fallback = AGENT_META[isBuiltinAgentRole(role) ? role : "developer_front"];
  const inferredName = humanizeRoleLabel(role);
  return {
    name: overrides?.name?.trim() || (isBuiltinAgentRole(role) ? fallback.name : inferredName),
    title: overrides?.title?.trim() || (isBuiltinAgentRole(role) ? fallback.title : inferredName),
    color: overrides?.color?.trim() || fallback.color,
    icon: overrides?.icon?.trim() || fallback.icon
  };
}

// src/constants.ts
var DEFAULT_AGENT_WORKSPACE_MODE = "adaptive_workspace";
var DEFAULT_AGENT_APPROVAL_MODE = "always_owner";
var DEFAULT_AGENT_APPROVER = "owner_ops";
var DEFAULT_AGENT_INTERACTION_MOVEMENT = "walk_to_desk";
var DEFAULT_AGENT_INTERACTION_SPEECH = "short_bubble";
var DEFAULT_AGENT_INTERACTION_RETURN = "return_to_origin";
var WORKSPACE_MODE_ORCHESTRATION = "orchestration_workspace";
var WORKSPACE_MODE_BUILDER = "builder_workspace";
var WORKSPACE_MODE_RESEARCH = "research_workspace";
var WORKSPACE_MODE_CAMPAIGN = "campaign_workspace";
var WORKSPACE_MODE_DESIGN = "design_workspace";
var WORKSPACE_MODE_OPERATIONS = "operations_workspace";
var WORKSPACE_MODE_FINANCE = "finance_workspace";
var CONNECTOR_INTERNAL_WORKBENCH = "internal_workbench";
var CONNECTOR_GIT = "git_connector";
var CONNECTOR_DEPLOY = "deploy_connector";
var CONNECTOR_SEARCH = "search_connector";
var CONNECTOR_SOCIAL_PUBLISH = "social_publish_connector";
var CONNECTOR_ADS = "ads_connector";
var CONNECTOR_DESIGN_ASSETS = "design_assets_connector";
var CONNECTOR_DOCS = "docs_connector";
var CONNECTOR_RUNTIME_OPS = "runtime_ops_connector";
var CONNECTOR_FINANCE = "finance_connector";

// src/lib/agentOperatingProfile.ts
function asRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function asBoolean(value) {
  return typeof value === "boolean" ? value : null;
}
function normalizeStringList(values) {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}
function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return normalizeStringList(
    value.filter((entry) => typeof entry === "string")
  );
}
function collectSignals(seed) {
  const signals = /* @__PURE__ */ new Set();
  const push = (value) => {
    if (!value) return;
    for (const token of value.toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) {
      signals.add(token);
    }
  };
  push(seed.role);
  push(seed.focusMode);
  for (const capability of seed.capabilities ?? []) push(capability);
  for (const bundleRef of seed.skillBundleRefs ?? []) push(bundleRef);
  return signals;
}
function hasAny(signals, values) {
  return values.some((value) => signals.has(value));
}
function inferWorkspaceMode(signals) {
  if (hasAny(signals, ["pm", "planner", "planning", "approval", "executive", "ceo"])) {
    return WORKSPACE_MODE_ORCHESTRATION;
  }
  if (hasAny(signals, [
    "marketing",
    "marketer",
    "campaign",
    "ads",
    "seo",
    "social",
    "content",
    "brand"
  ])) {
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
  if (hasAny(signals, [
    "builder",
    "developer",
    "development",
    "frontend",
    "backend",
    "code",
    "implementation",
    "execution",
    "delivery"
  ])) {
    return WORKSPACE_MODE_BUILDER;
  }
  return DEFAULT_AGENT_WORKSPACE_MODE;
}
function inferToolConnectors(signals) {
  const connectors = /* @__PURE__ */ new Set([CONNECTOR_INTERNAL_WORKBENCH]);
  if (hasAny(signals, [
    "builder",
    "developer",
    "development",
    "frontend",
    "backend",
    "code",
    "implementation"
  ])) {
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
  if (hasAny(signals, [
    "marketing",
    "marketer",
    "campaign",
    "ads",
    "seo",
    "social",
    "content",
    "brand"
  ])) {
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
function buildInteractionStyle(overrides) {
  return {
    movement_mode: overrides?.movement_mode?.trim() || DEFAULT_AGENT_INTERACTION_MOVEMENT,
    speech_mode: overrides?.speech_mode?.trim() || DEFAULT_AGENT_INTERACTION_SPEECH,
    return_mode: overrides?.return_mode?.trim() || DEFAULT_AGENT_INTERACTION_RETURN
  };
}
function buildAgentOperatingProfile(seed) {
  const toolPolicy = asRecord(seed.toolPolicy) ?? {};
  const approvalPolicy = asRecord(seed.approvalPolicy) ?? {};
  const collaborationPolicy = asRecord(seed.collaborationPolicy) ?? {};
  const interactionStyleRecord = asRecord(collaborationPolicy.interaction_style);
  const signals = collectSignals(seed);
  return {
    workspace_mode: asString(collaborationPolicy.workspace_mode) ?? inferWorkspaceMode(signals),
    tool_connectors: asStringArray(toolPolicy.connectors).length > 0 ? asStringArray(toolPolicy.connectors) : inferToolConnectors(signals),
    allowed_tools: asStringArray(toolPolicy.allowed_tools),
    approval_mode: asString(approvalPolicy.mode) ?? DEFAULT_AGENT_APPROVAL_MODE,
    external_actions_require_approval: asBoolean(approvalPolicy.external_actions_require_approval) ?? true,
    default_approver: asString(approvalPolicy.default_approver) ?? (asBoolean(approvalPolicy.external_actions_require_approval) === false ? null : DEFAULT_AGENT_APPROVER),
    interaction_style: buildInteractionStyle({
      movement_mode: asString(interactionStyleRecord?.movement_mode) ?? void 0,
      speech_mode: asString(interactionStyleRecord?.speech_mode) ?? void 0,
      return_mode: asString(interactionStyleRecord?.return_mode) ?? void 0
    })
  };
}
function buildOperatingProfilePolicies(input) {
  const signals = collectSignals({
    role: input.role,
    capabilities: input.capabilities,
    skillBundleRefs: input.skillBundleRefs,
    focusMode: input.workspaceMode
  });
  const workspaceMode = input.workspaceMode?.trim() || inferWorkspaceMode(signals);
  const toolConnectors = normalizeStringList(input.toolConnectors).length > 0 ? normalizeStringList(input.toolConnectors) : inferToolConnectors(signals);
  const allowedTools = normalizeStringList(input.allowedTools);
  const approvalMode = input.approvalMode?.trim() || DEFAULT_AGENT_APPROVAL_MODE;
  const interactionStyle = buildInteractionStyle(input.interactionStyle);
  const externalActionsRequireApproval = input.externalActionsRequireApproval ?? true;
  const defaultApprover = input.defaultApprover?.trim() || (externalActionsRequireApproval ? DEFAULT_AGENT_APPROVER : null);
  const toolPolicy = {
    allowed_tools: allowedTools,
    connectors: toolConnectors
  };
  const approvalPolicy = {
    mode: approvalMode,
    external_actions_require_approval: externalActionsRequireApproval
  };
  if (defaultApprover) {
    approvalPolicy.default_approver = defaultApprover;
  }
  const collaborationPolicy = {
    workspace_mode: workspaceMode,
    interaction_style: {
      movement_mode: interactionStyle.movement_mode,
      speech_mode: interactionStyle.speech_mode,
      return_mode: interactionStyle.return_mode
    }
  };
  return {
    operatingProfile: buildAgentOperatingProfile({
      role: input.role,
      capabilities: input.capabilities,
      skillBundleRefs: input.skillBundleRefs,
      focusMode: workspaceMode,
      toolPolicy,
      approvalPolicy,
      collaborationPolicy
    }),
    toolPolicy,
    approvalPolicy,
    collaborationPolicy
  };
}

// src/lib/runtimeBuilder.ts
var FACTORY_TEMPLATES = [
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
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE
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
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE
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
    approvalMode: DEFAULT_AGENT_APPROVAL_MODE
  }
];
var TEMPLATE_SIGNAL_MAP = {
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
    "devops"
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
    "social"
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
    "ux"
  ]
};
function collectSignalTokens(values) {
  const tokens = /* @__PURE__ */ new Set();
  for (const value of values) {
    for (const token of value.trim().toLowerCase().split(/[^a-z0-9]+/g).filter(Boolean)) {
      tokens.add(token);
    }
  }
  return tokens;
}
function inferTemplateFromSignals(capabilities, skillBundleRefs, roleLabel) {
  const signalTokens = collectSignalTokens([
    ...capabilities,
    ...skillBundleRefs,
    roleLabel ?? ""
  ]);
  const normalizedSkills = new Set(
    skillBundleRefs.map((value) => value.trim().toLowerCase()).filter(Boolean)
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
    (best, current) => current.score > best.score ? current : best,
    scoredTemplates[0] ?? { template: FACTORY_TEMPLATES[0], score: 0 }
  );
  return bestTemplate.score > 0 ? bestTemplate.template : FACTORY_TEMPLATES[0];
}
function normalizeRoleLabel(value, fallback) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || fallback;
}
function buildFactoryBlueprintDraft(template, input) {
  const name = input.name.trim() || `${template.label} Agent`;
  const roleLabel = normalizeRoleLabel(input.roleLabel ?? name, template.roleLabel);
  const capabilities = input.capabilities?.length ? [...new Set(input.capabilities.map((value) => value.trim()).filter(Boolean))] : template.capabilities;
  const skillBundleRefs = input.skillBundleRefs?.length ? [...new Set(input.skillBundleRefs.map((value) => value.trim()).filter(Boolean))] : [template.defaultBundleRole];
  const toolAllowlist = input.toolAllowlist?.length ? [...new Set(input.toolAllowlist.map((value) => value.trim()).filter(Boolean))] : [];
  const accentColor = input.accentColor?.trim() || template.accentColor;
  const icon = input.icon?.trim() || template.icon;
  const primaryWidgets = input.primaryWidgets?.length ? [...new Set(input.primaryWidgets.map((value) => value.trim()).filter(Boolean))] : template.primaryWidgets;
  const secondaryWidgets = input.secondaryWidgets?.length ? [...new Set(input.secondaryWidgets.map((value) => value.trim()).filter(Boolean))] : template.secondaryWidgets;
  const operatingProfile = buildOperatingProfilePolicies({
    role: roleLabel,
    capabilities,
    skillBundleRefs,
    workspaceMode: input.workspaceMode?.trim(),
    toolConnectors: input.toolConnectors?.length ? input.toolConnectors : void 0,
    allowedTools: toolAllowlist,
    approvalMode: input.approvalMode?.trim() || template.approvalMode
  });
  const blueprint = {
    name,
    role_label: roleLabel,
    capabilities,
    prompt_bundle_ref: input.prompt.trim() || null,
    skill_bundle_refs: skillBundleRefs,
    tool_policy: operatingProfile.toolPolicy,
    permission_policy: input.permissionMode?.trim() ? { mode: input.permissionMode.trim() } : {},
    memory_policy: input.memoryMode?.trim() ? { mode: input.memoryMode.trim() } : {},
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
      meeting_behavior: input.meetingBehavior?.trim() || "adaptive"
    }
  };
  const meta = getAgentMeta(roleLabel, {
    name,
    title: name,
    color: accentColor,
    icon
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
        meeting_behavior: blueprint.ui_profile?.meeting_behavior
      }
    }
  };
}

// src/lib/runtimeBuilder.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var builderTemplate = FACTORY_TEMPLATES.find((template) => template.id === "builder");
assert(builderTemplate, "builder template should exist");
var draft = buildFactoryBlueprintDraft(builderTemplate, {
  name: "Strategy Scout",
  prompt: "Turn the quarterly launch brief into a runnable execution plan.",
  roleLabel: "strategy_scout",
  capabilities: ["research", "planning", "approval"],
  skillBundleRefs: ["pm"],
  toolAllowlist: ["workspace.read", "terminal.exec"],
  permissionMode: "owner_required",
  memoryMode: "session_scoped",
  accentColor: "#14B8A6",
  homeZone: "strategy_hub",
  teamAffinity: "strategy_team",
  authorityLevel: 42,
  focusMode: "strategy",
  meetingBehavior: "briefing",
  primaryWidgets: ["timeline", "execution_graph"],
  secondaryWidgets: ["approval_queue", "logs"]
});
assert(draft.blueprint.name === "Strategy Scout", "builder draft should preserve the chosen blueprint name");
assert(draft.blueprint.role_label === "strategy_scout", "builder draft should normalize the chosen role label");
assert(draft.blueprint.capabilities?.includes("approval"), "builder draft should persist custom capabilities");
assert(draft.blueprint.skill_bundle_refs?.[0] === "pm", "builder draft should persist explicit skill bundle refs");
assert(draft.blueprint.ui_profile?.home_zone === "strategy_hub", "builder draft should preserve selected home zone");
assert(draft.blueprint.ui_profile?.team_affinity === "strategy_team", "builder draft should preserve selected team affinity");
assert(draft.blueprint.ui_profile?.primary_widgets?.includes("execution_graph"), "builder draft should allow runtime execution widgets");
assert(draft.previewAgent.uiProfile?.meeting_behavior === "briefing", "preview agent should mirror builder meeting behavior");
assert(
  Array.isArray(draft.blueprint.tool_policy.allowed_tools),
  "builder draft should persist tool policy allowlist"
);
assert(
  Array.isArray(draft.blueprint.tool_policy.connectors) && (draft.blueprint.tool_policy.connectors ?? []).length > 0,
  "builder draft should persist operating-profile connector hints"
);
assert(
  draft.blueprint.collaboration_policy.workspace_mode === "orchestration_workspace",
  "builder draft should persist workspace mode via collaboration policy"
);
assert(
  draft.blueprint.approval_policy.external_actions_require_approval === true,
  "builder draft should require approval for external actions by default"
);
assert(
  draft.previewAgent.operatingProfile?.interaction_style.movement_mode === "walk_to_desk",
  "preview agent should expose the default interaction choreography"
);
assert(
  draft.blueprint.permission_policy.mode === "owner_required",
  "builder draft should persist permission mode"
);
var defaultDraft = buildFactoryBlueprintDraft(builderTemplate, {
  name: "Builder Default",
  prompt: "Ship the backlog."
});
assert(
  defaultDraft.blueprint.skill_bundle_refs?.[0] === "developer",
  "builder template should default to the developer bundle"
);
assert(
  defaultDraft.previewAgent.operatingProfile?.tool_connectors.includes("git_connector"),
  "builder template should derive builder connectors for preview agents"
);
var inferredBuilder = inferTemplateFromSignals(
  ["code_generation", "execution"],
  ["developer"],
  "frontend_builder"
);
assert(
  inferredBuilder.id === "builder",
  "inferTemplateFromSignals should classify implementation-heavy roles as builder"
);
var inferredResearcher = inferTemplateFromSignals(
  ["research", "analysis"],
  ["pm"],
  "strategy_researcher"
);
assert(
  inferredResearcher.id === "researcher",
  "inferTemplateFromSignals should classify research-oriented roles as researcher"
);
var inferredCreative = inferTemplateFromSignals(
  ["design", "assets"],
  ["designer"],
  "visual_designer"
);
assert(
  inferredCreative.id === "creative",
  "inferTemplateFromSignals should classify design-oriented roles as creative"
);
console.log("runtimeBuilder tests passed");
