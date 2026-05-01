// src/types/agent.ts
var AGENT_ROLES = [
  "ceo",
  "pm",
  "developer",
  "developer_front",
  "developer_back",
  "reviewer",
  "verifier",
  "devops",
  "marketer",
  "designer",
  "cfo"
];
var AGENT_META = {
  ceo: { name: "CEO", title: "CEO", color: "#8B5CF6", icon: "Crown" },
  pm: { name: "PM", title: "\uD504\uB85C\uC81D\uD2B8 \uB9E4\uB2C8\uC800", color: "#6366F1", icon: "ClipboardList" },
  developer: { name: "\uAC1C\uBC1C\uC790", title: "Developer", color: "#3B82F6", icon: "Code" },
  developer_front: { name: "\uAC1C\uBC1C\uC790 Front", title: "\uD504\uB860\uD2B8\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#3B82F6", icon: "Code" },
  developer_back: { name: "\uAC1C\uBC1C\uC790 Back", title: "\uBC31\uC5D4\uB4DC \uAC1C\uBC1C\uC790", color: "#EF4444", icon: "Search" },
  reviewer: { name: "\uB9AC\uBDF0\uC5B4", title: "Reviewer", color: "#EF4444", icon: "Search" },
  verifier: { name: "\uAC80\uC99D\uAD00", title: "Verifier", color: "#14B8A6", icon: "ShieldCheck" },
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

// src/lib/officeProfile.ts
var OFFICE_PROFILE_VERSION = 1;
var DEFAULT_THEME = {
  theme_id: "daacs_default",
  shell_color: "#0F0F23",
  floor_color: "#111827",
  panel_color: "#1A1A2E",
  accent_color: "#22D3EE"
};
var DEFAULT_ROUTING = {
  algorithm: "a_star_grid",
  cell_size: 24,
  blocked_cells: [],
  preferred_zone_costs: {
    hallway: 0.8,
    lobby: 0.9,
    meeting: 1.05,
    ceo: 1.2,
    design: 1.25,
    marketing: 1.25,
    engineering: 1.3,
    finance: 1.3,
    server: 1.3,
    generic: 1.35
  }
};
var DEFAULT_ZONE_ORDER = [
  "ceo_office",
  "meeting_room",
  "design_studio",
  "marketing_studio",
  "hallway",
  "rd_lab",
  "finance_room",
  "lobby",
  "server_farm"
];
var DEFAULT_ZONE_SPECS = {
  ceo_office: {
    id: "ceo_office",
    label: "CEO Office",
    accent_color: "#8B5CF6",
    row: 0,
    col: 0,
    row_span: 1,
    col_span: 1,
    preset: "ceo",
    label_position: "top-left"
  },
  meeting_room: {
    id: "meeting_room",
    label: "Meeting Room",
    accent_color: "#6366F1",
    row: 0,
    col: 1,
    row_span: 1,
    col_span: 1,
    preset: "meeting",
    label_position: "top-left"
  },
  design_studio: {
    id: "design_studio",
    label: "Design Studio",
    accent_color: "#F97316",
    row: 0,
    col: 2,
    row_span: 1,
    col_span: 1,
    preset: "design",
    label_position: "top-right"
  },
  marketing_studio: {
    id: "marketing_studio",
    label: "Marketing Studio",
    accent_color: "#EC4899",
    row: 1,
    col: 0,
    row_span: 1,
    col_span: 1,
    preset: "marketing",
    label_position: "top-left"
  },
  hallway: {
    id: "hallway",
    label: "Hallway",
    accent_color: "#64748B",
    row: 1,
    col: 1,
    row_span: 1,
    col_span: 1,
    preset: "hallway",
    label_position: "top-left"
  },
  rd_lab: {
    id: "rd_lab",
    label: "R&D Lab",
    accent_color: "#3B82F6",
    row: 1,
    col: 2,
    row_span: 1,
    col_span: 1,
    preset: "engineering",
    label_position: "top-right"
  },
  finance_room: {
    id: "finance_room",
    label: "Finance Room",
    accent_color: "#EAB308",
    row: 2,
    col: 0,
    row_span: 1,
    col_span: 1,
    preset: "finance",
    label_position: "bottom-left"
  },
  lobby: {
    id: "lobby",
    label: "Lobby",
    accent_color: "#94A3B8",
    row: 2,
    col: 1,
    row_span: 1,
    col_span: 1,
    preset: "lobby",
    label_position: "bottom-left"
  },
  server_farm: {
    id: "server_farm",
    label: "Server Farm",
    accent_color: "#10B981",
    row: 2,
    col: 2,
    row_span: 1,
    col_span: 1,
    preset: "server",
    label_position: "bottom-right"
  }
};
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function humanizeZoneId(zoneId) {
  return zoneId.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function asString2(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
function asPositiveInt(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : fallback;
}
function asPositiveSpan(value, fallback) {
  const rounded = asPositiveInt(value, fallback);
  return rounded > 0 ? rounded : fallback;
}
function asLabelPosition(value, fallback) {
  return value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right" ? value : fallback;
}
function asRoutingDocument(value) {
  if (!isRecord(value)) return { ...DEFAULT_ROUTING };
  const preferredZoneCosts = isRecord(value.preferred_zone_costs) ? Object.fromEntries(
    Object.entries(value.preferred_zone_costs).flatMap(
      ([key, raw]) => typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? [[key, raw]] : []
    )
  ) : {};
  const blockedCells = Array.isArray(value.blocked_cells) ? value.blocked_cells.flatMap((cell) => {
    if (!isRecord(cell)) return [];
    if (typeof cell.x !== "number" || typeof cell.y !== "number") return [];
    return [{ x: Math.round(cell.x), y: Math.round(cell.y) }];
  }) : [];
  return {
    algorithm: "a_star_grid",
    cell_size: asPositiveSpan(value.cell_size, DEFAULT_ROUTING.cell_size),
    blocked_cells: blockedCells,
    preferred_zone_costs: {
      ...DEFAULT_ROUTING.preferred_zone_costs,
      ...preferredZoneCosts
    }
  };
}
function fallbackZoneDocument(zoneId, index) {
  const columns = 3;
  return {
    id: zoneId,
    label: humanizeZoneId(zoneId),
    accent_color: "#64748B",
    row: Math.floor(index / columns),
    col: index % columns,
    row_span: 1,
    col_span: 1,
    preset: "generic",
    label_position: "top-left"
  };
}
function normalizeZoneDocument(zoneId, value, fallback) {
  if (!isRecord(value)) {
    return { ...fallback };
  }
  return {
    id: zoneId,
    label: asString2(value.label, fallback.label),
    accent_color: asString2(value.accent_color, fallback.accent_color),
    row: asPositiveInt(value.row, fallback.row),
    col: asPositiveInt(value.col, fallback.col),
    row_span: asPositiveSpan(value.row_span, fallback.row_span),
    col_span: asPositiveSpan(value.col_span, fallback.col_span),
    preset: asString2(value.preset, fallback.preset),
    label_position: asLabelPosition(value.label_position, fallback.label_position)
  };
}
function resolveRuntimeZoneConfigs(runtime) {
  if (!runtime || !isRecord(runtime.org_graph)) return {};
  const runtimeZones = isRecord(runtime.org_graph.zones) ? runtime.org_graph.zones : {};
  return Object.fromEntries(
    Object.entries(runtimeZones).map(([zoneId, config]) => [
      zoneId,
      {
        label: isRecord(config) && typeof config.label === "string" ? config.label : void 0,
        accent_color: isRecord(config) && typeof config.accent_color === "string" ? config.accent_color : void 0,
        row: isRecord(config) && typeof config.row === "number" ? asPositiveInt(config.row, 0) : void 0,
        col: isRecord(config) && typeof config.col === "number" ? asPositiveInt(config.col, 0) : void 0,
        row_span: isRecord(config) && typeof config.row_span === "number" ? asPositiveSpan(config.row_span, 1) : void 0,
        col_span: isRecord(config) && typeof config.col_span === "number" ? asPositiveSpan(config.col_span, 1) : void 0,
        preset: isRecord(config) && typeof config.preset === "string" ? config.preset : void 0,
        label_position: isRecord(config) && config.label_position ? asLabelPosition(config.label_position, "top-left") : void 0
      }
    ])
  );
}
function resolveZonesFromRuntime(runtime) {
  const runtimeZones = resolveRuntimeZoneConfigs(runtime);
  const extraZoneIds = Object.keys(runtimeZones).filter(
    (zoneId) => !(zoneId in DEFAULT_ZONE_SPECS)
  );
  const orderedZoneIds = [...DEFAULT_ZONE_ORDER, ...extraZoneIds];
  return orderedZoneIds.map((zoneId, index) => {
    const fallback = DEFAULT_ZONE_SPECS[zoneId] ?? fallbackZoneDocument(zoneId, index);
    const runtimeZone = runtimeZones[zoneId];
    return {
      id: zoneId,
      label: runtimeZone?.label?.trim() || fallback.label,
      accent_color: runtimeZone?.accent_color?.trim() || fallback.accent_color,
      row: runtimeZone?.row ?? fallback.row,
      col: runtimeZone?.col ?? fallback.col,
      row_span: runtimeZone?.row_span ?? fallback.row_span,
      col_span: runtimeZone?.col_span ?? fallback.col_span,
      preset: runtimeZone?.preset?.trim() || fallback.preset,
      label_position: runtimeZone?.label_position ?? fallback.label_position
    };
  });
}
function normalizeTheme(value) {
  if (!isRecord(value)) return { ...DEFAULT_THEME };
  return {
    theme_id: asString2(value.theme_id, DEFAULT_THEME.theme_id),
    shell_color: asString2(value.shell_color, DEFAULT_THEME.shell_color),
    floor_color: asString2(value.floor_color, DEFAULT_THEME.floor_color),
    panel_color: asString2(value.panel_color, DEFAULT_THEME.panel_color),
    accent_color: asString2(value.accent_color, DEFAULT_THEME.accent_color)
  };
}
function normalizeMetadata(value, runtimeId, source) {
  if (!isRecord(value)) {
    return {
      source,
      runtime_id: runtimeId ?? null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
  return {
    source: value.source === "default" || value.source === "runtime" || value.source === "snapshot" || value.source === "customized" ? value.source : source,
    runtime_id: typeof value.runtime_id === "string" && value.runtime_id.trim().length > 0 ? value.runtime_id.trim() : runtimeId ?? null,
    updated_at: asString2(value.updated_at, (/* @__PURE__ */ new Date()).toISOString())
  };
}
function normalizeDeskDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.anchor)) return [];
    if (typeof entry.anchor.x !== "number" || typeof entry.anchor.y !== "number") return [];
    return [
      {
        id: asString2(entry.id, `desk-${index + 1}`),
        zone_id: asString2(entry.zone_id, "lobby"),
        label: asString2(entry.label, `Desk ${index + 1}`),
        anchor: {
          x: Math.round(entry.anchor.x),
          y: Math.round(entry.anchor.y)
        },
        agent_id: typeof entry.agent_id === "string" && entry.agent_id.trim().length > 0 ? entry.agent_id.trim() : null
      }
    ];
  });
}
function normalizeFurnitureDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.anchor)) return [];
    if (typeof entry.anchor.x !== "number" || typeof entry.anchor.y !== "number") return [];
    return [
      {
        id: asString2(entry.id, `furniture-${index + 1}`),
        zone_id: asString2(entry.zone_id, "lobby"),
        type: asString2(entry.type, "plant"),
        anchor: {
          x: Math.round(entry.anchor.x),
          y: Math.round(entry.anchor.y)
        },
        variant: typeof entry.variant === "string" && entry.variant.trim().length > 0 ? entry.variant.trim() : null
      }
    ];
  });
}
function normalizeAssignments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.agent_id !== "string" || typeof entry.zone_id !== "string") {
      return [];
    }
    return [
      {
        agent_id: entry.agent_id.trim(),
        zone_id: entry.zone_id.trim(),
        desk_id: typeof entry.desk_id === "string" && entry.desk_id.trim().length > 0 ? entry.desk_id.trim() : null,
        spawn_point: isRecord(entry.spawn_point) && typeof entry.spawn_point.x === "number" && typeof entry.spawn_point.y === "number" ? {
          x: Math.round(entry.spawn_point.x),
          y: Math.round(entry.spawn_point.y)
        } : null
      }
    ];
  });
}
function resolveOfficeZones(runtime, officeProfile2) {
  if (officeProfile2 && officeProfile2.zones.length > 0) {
    return officeProfile2.zones.map(
      (zone, index) => normalizeZoneDocument(zone.id, zone, DEFAULT_ZONE_SPECS[zone.id] ?? fallbackZoneDocument(zone.id, index))
    );
  }
  return resolveZonesFromRuntime(runtime);
}
function parseProjectOfficeProfile(value, projectId, runtime) {
  if (!isRecord(value)) return null;
  const fallbackZones = resolveZonesFromRuntime(runtime);
  const normalizedZonesInput = Array.isArray(value.zones) ? value.zones.map((zone, index) => {
    const zoneId = isRecord(zone) && typeof zone.id === "string" && zone.id.trim().length > 0 ? zone.id.trim() : `zone-${index + 1}`;
    const fallback = fallbackZones.find((candidate) => candidate.id === zoneId) ?? fallbackZoneDocument(zoneId, index);
    return normalizeZoneDocument(zoneId, zone, fallback);
  }) : fallbackZones;
  return {
    version: OFFICE_PROFILE_VERSION,
    office_profile_id: asString2(value.office_profile_id, `office-${projectId}`),
    project_id: asString2(value.project_id, projectId),
    scope: "project",
    name: asString2(
      value.name,
      runtime?.company_name?.trim() ? `${runtime.company_name} Office` : "Project Office"
    ),
    theme: normalizeTheme(value.theme),
    zones: normalizedZonesInput,
    desks: normalizeDeskDocuments(value.desks),
    furniture: normalizeFurnitureDocuments(value.furniture),
    agent_assignments: normalizeAssignments(value.agent_assignments),
    routing: asRoutingDocument(value.routing),
    metadata: normalizeMetadata(value.metadata, runtime?.runtime_id ?? null, "snapshot")
  };
}
function buildProjectOfficeProfile(projectId, runtime) {
  const orgGraph = isRecord(runtime?.org_graph) ? runtime?.org_graph : null;
  const embeddedProfile = orgGraph && isRecord(orgGraph.office_profile) ? parseProjectOfficeProfile(orgGraph.office_profile, projectId, runtime) : null;
  if (embeddedProfile) {
    return {
      ...embeddedProfile,
      project_id: projectId,
      metadata: {
        ...embeddedProfile.metadata,
        source: embeddedProfile.metadata.source ?? "runtime",
        runtime_id: runtime?.runtime_id ?? embeddedProfile.metadata.runtime_id ?? null
      }
    };
  }
  return {
    version: OFFICE_PROFILE_VERSION,
    office_profile_id: `office-${projectId}`,
    project_id: projectId,
    scope: "project",
    name: runtime?.company_name?.trim() ? `${runtime.company_name} Office` : "Project Office",
    theme: { ...DEFAULT_THEME },
    zones: resolveZonesFromRuntime(runtime),
    desks: [],
    furniture: [],
    agent_assignments: [],
    routing: { ...DEFAULT_ROUTING },
    metadata: {
      source: runtime ? "runtime" : "default",
      runtime_id: runtime?.runtime_id ?? null,
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}

// src/lib/runtimeUi.ts
var LOBBY_ENTRY = { x: 600, y: 760 };
var MEETING_CENTER = { x: 600, y: 134 };
var OFFICE_WIDTH = 1200;
var OFFICE_HEIGHT = 800;
var ZONE_ALIASES = {
  ceo: "ceo_office",
  meeting: "meeting_room",
  factory: "design_studio",
  review_room: "design_studio",
  review_bench: "design_studio",
  design_lab: "design_studio",
  research_lab: "rd_lab",
  war_room: "meeting_room",
  executive_team: "ceo_office"
};
var WIDGET_ALIASES = {
  approval: "alerts",
  approvals: "alerts",
  alert: "alerts",
  summary: "content",
  sources: "content",
  notes: "preview",
  image_review: "preview",
  asset_review: "assets",
  cost: "cost_breakdown",
  budget: "cost_breakdown",
  runway_months: "runway",
  logs: "deploy_log"
};
function normalizeZoneId(homeZone, teamAffinity, zones) {
  const zoneIndex = new Map(zones.map((zone) => [zone.id, zone]));
  const requested = (homeZone || "").trim().toLowerCase();
  if (requested && zoneIndex.has(requested)) return requested;
  if (requested && requested in ZONE_ALIASES) return ZONE_ALIASES[requested];
  const team = (teamAffinity || "").trim().toLowerCase();
  if (team.includes("executive")) return "ceo_office";
  if (team.includes("marketing")) return "marketing_studio";
  if (team.includes("development")) return "rd_lab";
  if (team.includes("research")) return "rd_lab";
  if (team.includes("creative") || team.includes("design")) return "design_studio";
  if (team.includes("finance")) return "finance_room";
  if (team.includes("operations")) return "server_farm";
  if (zoneIndex.has("lobby")) return "lobby";
  return zones[0]?.id ?? "lobby";
}
function clampPoint(point) {
  return {
    x: Math.max(24, Math.min(OFFICE_WIDTH - 24, Math.round(point.x))),
    y: Math.max(24, Math.min(OFFICE_HEIGHT - 24, Math.round(point.y)))
  };
}
function findOfficeZoneForPoint(point, officeZones = buildDefaultOfficeZones()) {
  const containing = officeZones.find(
    (zone) => point.x >= zone.left && point.x <= zone.left + zone.width && point.y >= zone.top && point.y <= zone.top + zone.height
  );
  if (containing) return containing;
  if (officeZones.length === 0) return null;
  return officeZones.reduce((closest, candidate) => {
    const currentDistance = Math.hypot(point.x - closest.center.x, point.y - closest.center.y);
    const candidateDistance = Math.hypot(
      point.x - candidate.center.x,
      point.y - candidate.center.y
    );
    return candidateDistance < currentDistance ? candidate : closest;
  });
}
function assignmentMap(officeProfile2) {
  return new Map(
    (officeProfile2?.agent_assignments ?? []).map((assignment) => [
      assignment.agent_id,
      assignment
    ])
  );
}
function deskAnchorMap(officeProfile2) {
  return new Map(
    (officeProfile2?.desks ?? []).map((desk) => [
      desk.id,
      clampPoint(desk.anchor)
    ])
  );
}
function assignmentZoneId(agent, officeProfile2, officeZones) {
  const assignment = assignmentMap(officeProfile2).get(agent.id);
  if (assignment?.zone_id && officeZones.some((zone) => zone.id === assignment.zone_id)) {
    return assignment.zone_id;
  }
  return normalizeZoneId(
    agent.uiProfile?.home_zone,
    agent.uiProfile?.team_affinity,
    officeZones
  );
}
function explicitAgentPosition(agent, officeProfile2, officeZones) {
  const assignment = assignmentMap(officeProfile2).get(agent.id);
  if (!assignment) return null;
  if (assignment.spawn_point) {
    const zone = officeZones.find((candidate) => candidate.id === assignment.zone_id);
    if (!zone) return clampPoint(assignment.spawn_point);
    return clampPoint({
      x: Math.max(zone.left + 24, Math.min(zone.left + zone.width - 24, assignment.spawn_point.x)),
      y: Math.max(zone.top + 24, Math.min(zone.top + zone.height - 24, assignment.spawn_point.y))
    });
  }
  if (assignment.desk_id) {
    const anchor = deskAnchorMap(officeProfile2).get(assignment.desk_id);
    if (anchor) return anchor;
  }
  return null;
}
function normalizeWidgetId(widgetId) {
  const normalized = widgetId.trim().toLowerCase();
  return WIDGET_ALIASES[normalized] ?? normalized;
}
function statusFromRuntime(runtimeStatus) {
  switch (runtimeStatus) {
    case "working":
    case "planning":
    case "waiting_approval":
      return "working";
    case "completed":
      return "celebrating";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}
function sortAgentsForZone(agents2) {
  return [...agents2].sort((left, right) => {
    const authorityDelta = (right.uiProfile?.authority_level ?? 0) - (left.uiProfile?.authority_level ?? 0);
    if (authorityDelta !== 0) return authorityDelta;
    return left.name.localeCompare(right.name);
  });
}
function buildZoneGridPoints(zone, count) {
  if (count <= 1) return [zone.center];
  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gapX = columns === 1 ? 0 : Math.min(96, zone.width / Math.max(1, columns - 1));
  const gapY = rows === 1 ? 0 : Math.min(88, zone.height / Math.max(1, rows - 1));
  const startX = zone.center.x - gapX * (columns - 1) / 2;
  const startY = zone.center.y - gapY * (rows - 1) / 2;
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: Math.round(startX + column * gapX),
      y: Math.round(startY + row * gapY)
    };
  });
}
function buildDeskPositionMap(agents2, officeZones = buildDefaultOfficeZones(), officeProfile2) {
  const grouped = /* @__PURE__ */ new Map();
  const zoneIndex = new Map(officeZones.map((zone) => [zone.id, zone]));
  const positions = {};
  for (const agent of agents2) {
    const explicitPosition = explicitAgentPosition(agent, officeProfile2, officeZones);
    if (explicitPosition) {
      positions[agent.id] = explicitPosition;
      continue;
    }
    const zoneId = assignmentZoneId(agent, officeProfile2, officeZones);
    const rows = grouped.get(zoneId) ?? [];
    rows.push(agent);
    grouped.set(zoneId, rows);
  }
  for (const [zoneId, zoneAgents] of grouped.entries()) {
    const zone = zoneIndex.get(zoneId) ?? zoneIndex.get("lobby") ?? officeZones[0];
    if (!zone) continue;
    const ordered = sortAgentsForZone(zoneAgents);
    const points = buildZoneGridPoints(zone, ordered.length);
    ordered.forEach((agent, index) => {
      positions[agent.id] = points[index] ?? zone.center;
    });
  }
  return positions;
}
function buildMeetingPositionMap(agents2, participantIds) {
  const participantSet = participantIds && participantIds.length > 0 ? new Set(participantIds) : null;
  const ordered = sortAgentsForZone(
    participantSet ? agents2.filter((agent) => participantSet.has(agent.id)) : agents2
  );
  const total = ordered.length;
  if (total === 0) return {};
  const radius = Math.min(110, Math.max(58, 48 + total * 8));
  const positions = {};
  ordered.forEach((agent, index) => {
    const angle = -Math.PI / 2 + Math.PI * 2 * index / total;
    positions[agent.id] = {
      x: Math.round(MEETING_CENTER.x + Math.cos(angle) * radius),
      y: Math.round(MEETING_CENTER.y + Math.sin(angle) * Math.min(radius, 82))
    };
  });
  return positions;
}
function agentCanUseIde(agent) {
  return (agent.capabilities ?? []).includes("code_generation");
}
function buildKpiTab(agent) {
  return {
    id: "kpi",
    label: "Role Dashboard",
    data: {
      spend_today_usd: 0,
      budget_remaining_usd: 0,
      total_api_calls: 0,
      agent_count: 1,
      by_role_cost: {
        [agent.role]: 0
      }
    }
  };
}
function buildWidgetTab(widgetId, agent) {
  switch (widgetId) {
    case "alerts":
      return {
        id: "alerts",
        label: "Alerts",
        data: {
          alerts: agent.runtimeStatus === "waiting_approval" ? ["Approval requested before release"] : agent.status === "working" ? [`${agent.name} is actively executing work`] : []
        }
      };
    case "timeline":
      return {
        id: "timeline",
        label: "Timeline",
        data: {
          current_task: agent.currentTask ?? `${agent.name} is aligned with ${agent.assignedTeam ?? "the runtime"}`
        }
      };
    case "preview":
      return {
        id: "preview",
        label: "Preview",
        data: {
          notes: [
            `${agent.name} workspace is anchored in ${normalizeZoneId(
              agent.uiProfile?.home_zone,
              agent.uiProfile?.team_affinity,
              buildDefaultOfficeZones()
            )}`
          ]
        }
      };
    case "assets":
      return {
        id: "assets",
        label: "Assets",
        data: {
          assets: [
            `${agent.role}-artifact-01`,
            `${agent.role}-artifact-02`
          ]
        }
      };
    case "code":
      return {
        id: "code",
        label: "Code",
        data: {
          current_task: agent.currentTask ?? `Implement ${agent.role} tasks`,
          last_output: `${agent.name} is ready to work from the runtime plan`
        }
      };
    case "git":
      return {
        id: "git",
        label: "Git",
        data: {
          recent_commits: [`chore(${agent.role}): runtime metadata sync`]
        }
      };
    case "content":
      return {
        id: "content",
        label: "Content",
        data: {
          drafts: [`${agent.name} summary draft`],
          scheduled: []
        }
      };
    case "server":
      return {
        id: "server",
        label: "Server",
        data: {
          cpu_pct: 0,
          mem_pct: 0,
          queue_depth: 0,
          workers_alive: 0
        }
      };
    case "deploy_log":
      return {
        id: "deploy_log",
        label: "Deploy Log",
        data: {
          logs: [`${agent.name} has no deployment events yet`]
        }
      };
    case "runway":
      return {
        id: "runway",
        label: "Runway",
        data: {
          daily_cap_usd: 0,
          today_spent_usd: 0,
          today_remaining_usd: 0,
          history_7d: []
        }
      };
    case "cost_breakdown":
      return {
        id: "cost_breakdown",
        label: "Cost Breakdown",
        data: {
          by_role: { [agent.role]: 0 },
          by_model: {},
          total_calls: 0
        }
      };
    default:
      return {
        id: widgetId,
        label: widgetId.split(/[_-]+/g).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
        data: {
          agent: agent.name,
          role: agent.role,
          status: agent.status
        }
      };
  }
}
function buildDashboardFallback(agent) {
  const widgetIds = [
    "kpi",
    ...agent.uiProfile?.primary_widgets ?? [],
    ...agent.uiProfile?.secondary_widgets ?? []
  ].map(normalizeWidgetId).filter(Boolean);
  const uniqueWidgetIds = [...new Set(widgetIds)];
  const tabs = uniqueWidgetIds.map(
    (widgetId) => widgetId === "kpi" ? buildKpiTab(agent) : buildWidgetTab(widgetId, agent)
  );
  return {
    role: agent.role,
    display_name: agent.meta?.name ?? agent.name,
    status: agent.runtimeStatus ?? agent.status,
    tabs,
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function buildAgentMeta(role, uiProfile, fallbackName) {
  return getAgentMeta(role, {
    name: uiProfile?.display_name || fallbackName,
    title: uiProfile?.title || fallbackName,
    color: uiProfile?.accent_color,
    icon: uiProfile?.icon
  });
}
function buildOfficeZones(runtime, officeProfile2) {
  const zoneSpecs = resolveOfficeZones(runtime, officeProfile2).sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    if (left.col !== right.col) return left.col - right.col;
    return left.id.localeCompare(right.id);
  });
  const totalColumns = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.col + zone.col_span)
  );
  const totalRows = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.row + zone.row_span)
  );
  const cellWidth = OFFICE_WIDTH / totalColumns;
  const cellHeight = OFFICE_HEIGHT / totalRows;
  return zoneSpecs.map((zone) => {
    const width = cellWidth * zone.col_span;
    const height = cellHeight * zone.row_span;
    const left = cellWidth * zone.col;
    const top = cellHeight * zone.row;
    return {
      id: zone.id,
      label: zone.label,
      accentColor: zone.accent_color,
      row: zone.row,
      col: zone.col,
      rowSpan: zone.row_span,
      colSpan: zone.col_span,
      preset: zone.preset,
      labelPosition: zone.label_position,
      left,
      top,
      width,
      height,
      center: {
        x: Math.round(left + width / 2),
        y: Math.round(top + height / 2)
      }
    };
  });
}
function buildDefaultOfficeZones() {
  const runtime = {
    runtime_id: "default-runtime",
    project_id: "default-project",
    company_name: "Default Runtime",
    org_graph: {},
    agent_instance_ids: [],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "manual",
    owner_ops_state: {},
    created_at: "",
    updated_at: ""
  };
  return buildOfficeZones(runtime, buildProjectOfficeProfile(runtime.project_id, runtime));
}
function buildRuntimeAgents(bundle, officeProfile2) {
  const blueprintIndex = new Map(bundle.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const resolvedOfficeProfile = officeProfile2 ?? buildProjectOfficeProfile(bundle.runtime.project_id, bundle.runtime);
  const officeZones = buildOfficeZones(bundle.runtime, resolvedOfficeProfile);
  const seededAgents = bundle.instances.map((instance) => {
    const blueprint = blueprintIndex.get(instance.blueprint_id);
    const role = blueprint?.role_label ?? instance.blueprint_id;
    const uiProfile = blueprint?.ui_profile;
    const meta = buildAgentMeta(role, uiProfile, blueprint?.name ?? role);
    return {
      id: instance.instance_id,
      instanceId: instance.instance_id,
      blueprintId: instance.blueprint_id,
      role,
      name: meta.name,
      meta,
      position: LOBBY_ENTRY,
      path: [],
      status: statusFromRuntime(instance.runtime_status),
      runtimeStatus: instance.runtime_status,
      assignedTeam: instance.assigned_team,
      currentTask: instance.current_tasks[0],
      uiProfile,
      operatingProfile: buildAgentOperatingProfile({
        role,
        capabilities: blueprint?.capabilities ?? [],
        skillBundleRefs: blueprint?.skill_bundle_refs ?? [],
        focusMode: uiProfile?.focus_mode,
        toolPolicy: blueprint?.tool_policy,
        approvalPolicy: blueprint?.approval_policy,
        collaborationPolicy: blueprint?.collaboration_policy
      }),
      capabilities: blueprint?.capabilities ?? [],
      skillBundleRefs: blueprint?.skill_bundle_refs ?? []
    };
  });
  const deskPositions = buildDeskPositionMap(seededAgents, officeZones, resolvedOfficeProfile);
  return seededAgents.map((agent) => ({
    ...agent,
    position: deskPositions[agent.id] ?? LOBBY_ENTRY
  }));
}

// src/lib/runtimeUi.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var runtimeBundle = {
  runtime: {
    runtime_id: "runtime-1",
    project_id: "project-1",
    company_name: "Dynamic Studio",
    org_graph: {
      zones: {
        design_studio: { label: "Design Studio", accent_color: "#F97316" },
        research_lab: { label: "Research Lab", accent_color: "#14B8A6" }
      }
    },
    agent_instance_ids: ["inst-1", "inst-2", "inst-3"],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    created_at: "2026-03-25T00:00:00.000Z",
    updated_at: "2026-03-25T00:00:00.000Z"
  },
  blueprints: [
    {
      id: "bp-design",
      name: "Brand Designer",
      role_label: "brand_designer",
      capabilities: ["design", "assets"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {
        connectors: ["design_assets_connector", "docs_connector"]
      },
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {
        workspace_mode: "design_workspace",
        interaction_style: {
          movement_mode: "walk_to_desk",
          speech_mode: "short_bubble",
          return_mode: "return_to_origin"
        }
      },
      approval_policy: {
        mode: "always_owner",
        external_actions_require_approval: true,
        default_approver: "owner_ops"
      },
      ui_profile: {
        display_name: "Brand Designer",
        title: "Brand Designer",
        avatar_style: "pixel",
        accent_color: "#F97316",
        icon: "Palette",
        home_zone: "design_studio",
        team_affinity: "creative_team",
        authority_level: 5,
        capability_tags: ["design"],
        primary_widgets: ["preview", "assets"],
        secondary_widgets: ["timeline"],
        focus_mode: "visual",
        meeting_behavior: "review"
      },
      is_builtin: false,
      owner_user_id: "user-1",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    },
    {
      id: "bp-research",
      name: "Research Analyst",
      role_label: "research_analyst",
      capabilities: ["research", "summary"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Research Analyst",
        title: "Research Analyst",
        avatar_style: "pixel",
        accent_color: "#14B8A6",
        icon: "Search",
        home_zone: "research_lab",
        team_affinity: "research_team",
        authority_level: 4,
        capability_tags: ["research"],
        primary_widgets: ["summary", "alerts"],
        secondary_widgets: ["logs"],
        focus_mode: "analysis",
        meeting_behavior: "report"
      },
      is_builtin: false,
      owner_user_id: "user-1",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    },
    {
      id: "bp-front",
      name: "Frontend Developer",
      role_label: "developer_front",
      capabilities: ["code_generation", "frontend", "ui"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Frontend Developer",
        title: "Frontend Developer",
        avatar_style: "pixel",
        accent_color: "#3B82F6",
        icon: "Code",
        home_zone: "rd_lab",
        team_affinity: "development_team",
        authority_level: 6,
        capability_tags: ["frontend"],
        primary_widgets: ["code", "git"],
        secondary_widgets: ["timeline"],
        focus_mode: "build",
        meeting_behavior: "ship"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    }
  ],
  instances: [
    {
      instance_id: "inst-1",
      blueprint_id: "bp-design",
      project_id: "project-1",
      runtime_status: "idle",
      assigned_team: "creative_team",
      current_tasks: [],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    },
    {
      instance_id: "inst-2",
      blueprint_id: "bp-research",
      project_id: "project-1",
      runtime_status: "working",
      assigned_team: "research_team",
      current_tasks: ["Draft source map"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    },
    {
      instance_id: "inst-3",
      blueprint_id: "bp-front",
      project_id: "project-1",
      runtime_status: "waiting_approval",
      assigned_team: "development_team",
      current_tasks: ["Implement adaptive dashboard"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z"
    }
  ]
};
var agents = buildRuntimeAgents(runtimeBundle);
assert(agents.length === 3, "runtime agents should be created for every instance");
var customAgent = agents.find((agent) => agent.id === "inst-1");
assert(customAgent, "custom runtime agent should exist");
assert(customAgent.role === "brand_designer", "custom runtime role should be preserved");
assert(customAgent.uiProfile?.home_zone === "design_studio", "ui profile should be attached");
assert(customAgent.meta?.color === "#F97316", "runtime color should override builtin fallback");
assert(
  customAgent.operatingProfile?.workspace_mode === "design_workspace",
  "runtime agents should recover workspace mode from stored collaboration policy"
);
assert(
  customAgent.operatingProfile?.tool_connectors.includes("design_assets_connector"),
  "runtime agents should recover connector hints from stored tool policy"
);
var secondAgent = agents.find((agent) => agent.id === "inst-2");
assert(secondAgent?.status === "working", "runtime status should map into office agent status");
assert(secondAgent.position.x !== customAgent.position.x || secondAgent.position.y !== customAgent.position.y, "desk positions should not collapse to the same point");
var meetingMap = buildMeetingPositionMap(agents);
assert(Object.keys(meetingMap).length === agents.length, "meeting positions should exist for every agent");
assert(meetingMap["inst-1"].x !== meetingMap["inst-2"].x || meetingMap["inst-1"].y !== meetingMap["inst-2"].y, "meeting positions should be distributed");
var dashboard = buildDashboardFallback(customAgent);
assert(dashboard.display_name === "Brand Designer", "dashboard should use runtime display name");
assert(dashboard.tabs.some((tab) => tab.id === "preview"), "primary widgets should become dashboard tabs");
assert(!agentCanUseIde(customAgent), "non-code agents should not receive ide access");
var codeDashboard = buildDashboardFallback(agents.find((agent) => agent.id === "inst-3"));
assert(codeDashboard.tabs.some((tab) => tab.id === "code"), "code-capable agents should expose code widgets");
assert(agentCanUseIde(agents.find((agent) => agent.id === "inst-3")), "code_generation capability should enable ide access");
assert(
  agents.find((agent) => agent.id === "inst-3")?.operatingProfile?.tool_connectors.includes("git_connector"),
  "code-capable agents should infer builder connectors when explicit policies are absent"
);
var dynamicZones = buildOfficeZones({
  ...runtimeBundle.runtime,
  org_graph: {
    zones: {
      design_studio: { label: "Design Studio", accent_color: "#F97316", row: 0, col: 0 },
      strategy_hub: { label: "Strategy Hub", accent_color: "#22C55E", row: 0, col: 3 }
    }
  }
});
assert(dynamicZones.some((zone) => zone.id === "strategy_hub"), "runtime-defined zones should be preserved");
assert(dynamicZones.find((zone) => zone.id === "strategy_hub")?.col === 3, "runtime-defined zone geometry should be preserved");
var officeProfile = buildProjectOfficeProfile(runtimeBundle.runtime.project_id, runtimeBundle.runtime);
officeProfile.agent_assignments = [
  {
    agent_id: "inst-1",
    zone_id: "lobby",
    desk_id: null,
    spawn_point: { x: 520, y: 690 }
  }
];
var assignedDeskPositions = buildDeskPositionMap(agents, dynamicZones, officeProfile);
assert(
  assignedDeskPositions["inst-1"].x === 520 && assignedDeskPositions["inst-1"].y === 690,
  "explicit office profile spawn points should override default desk placement"
);
var nearestZone = findOfficeZoneForPoint({ x: 1170, y: 760 }, dynamicZones);
assert(nearestZone?.id === "server_farm" || nearestZone?.id === "strategy_hub", "point lookup should resolve the nearest runtime office zone");
console.log("runtimeUi tests passed");
