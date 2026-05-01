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
function asString(value, fallback) {
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
    label: asString(value.label, fallback.label),
    accent_color: asString(value.accent_color, fallback.accent_color),
    row: asPositiveInt(value.row, fallback.row),
    col: asPositiveInt(value.col, fallback.col),
    row_span: asPositiveSpan(value.row_span, fallback.row_span),
    col_span: asPositiveSpan(value.col_span, fallback.col_span),
    preset: asString(value.preset, fallback.preset),
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
    theme_id: asString(value.theme_id, DEFAULT_THEME.theme_id),
    shell_color: asString(value.shell_color, DEFAULT_THEME.shell_color),
    floor_color: asString(value.floor_color, DEFAULT_THEME.floor_color),
    panel_color: asString(value.panel_color, DEFAULT_THEME.panel_color),
    accent_color: asString(value.accent_color, DEFAULT_THEME.accent_color)
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
    updated_at: asString(value.updated_at, (/* @__PURE__ */ new Date()).toISOString())
  };
}
function normalizeDeskDocuments(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (!isRecord(entry) || !isRecord(entry.anchor)) return [];
    if (typeof entry.anchor.x !== "number" || typeof entry.anchor.y !== "number") return [];
    return [
      {
        id: asString(entry.id, `desk-${index + 1}`),
        zone_id: asString(entry.zone_id, "lobby"),
        label: asString(entry.label, `Desk ${index + 1}`),
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
        id: asString(entry.id, `furniture-${index + 1}`),
        zone_id: asString(entry.zone_id, "lobby"),
        type: asString(entry.type, "plant"),
        anchor: {
          x: Math.round(entry.anchor.x),
          y: Math.round(entry.anchor.y)
        },
        variant: typeof entry.variant === "string" && entry.variant.trim().length > 0 ? entry.variant.trim() : null,
        rotation: typeof entry.rotation === "number" && Number.isFinite(entry.rotation) ? Math.round(entry.rotation) : 0,
        blocks_path: typeof entry.blocks_path === "boolean" ? entry.blocks_path : void 0,
        label: typeof entry.label === "string" && entry.label.trim().length > 0 ? entry.label.trim() : null
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
    office_profile_id: asString(value.office_profile_id, `office-${projectId}`),
    project_id: asString(value.project_id, projectId),
    scope: "project",
    name: asString(
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

// src/lib/officeTemplates.ts
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function buildTemplateFurniture(templateId) {
  const byTemplate = {
    "startup-studio": [
      {
        id: `${templateId}-meeting-table`,
        zone_id: "meeting_room",
        type: "meeting",
        anchor: { x: 600, y: 150 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null
      },
      {
        id: `${templateId}-idea-board`,
        zone_id: "design_studio",
        type: "whiteboard",
        anchor: { x: 1020, y: 110 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Ideas"
      },
      {
        id: `${templateId}-marketing-board`,
        zone_id: "marketing_studio",
        type: "bulletin",
        anchor: { x: 140, y: 370 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Launch"
      },
      {
        id: `${templateId}-lobby-plant`,
        zone_id: "lobby",
        type: "plant",
        anchor: { x: 540, y: 690 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null
      }
    ],
    "engineering-war-room": [
      {
        id: `${templateId}-war-table`,
        zone_id: "meeting_room",
        type: "meeting",
        anchor: { x: 600, y: 150 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: "Ship Room"
      },
      {
        id: `${templateId}-rd-desk-a`,
        zone_id: "rd_lab",
        type: "desk",
        anchor: { x: 920, y: 380 },
        rotation: 0,
        blocks_path: true,
        variant: "standard",
        label: null
      },
      {
        id: `${templateId}-rd-desk-b`,
        zone_id: "rd_lab",
        type: "desk",
        anchor: { x: 1040, y: 380 },
        rotation: 0,
        blocks_path: true,
        variant: "corner",
        label: null
      },
      {
        id: `${templateId}-server-a`,
        zone_id: "server_farm",
        type: "server",
        anchor: { x: 1040, y: 660 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null
      },
      {
        id: `${templateId}-server-b`,
        zone_id: "server_farm",
        type: "server",
        anchor: { x: 1100, y: 660 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null
      }
    ],
    "content-agency": [
      {
        id: `${templateId}-content-wall`,
        zone_id: "marketing_studio",
        type: "bulletin",
        anchor: { x: 180, y: 330 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Campaign Wall"
      },
      {
        id: `${templateId}-design-board`,
        zone_id: "design_studio",
        type: "whiteboard",
        anchor: { x: 1040, y: 100 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Creative Review"
      },
      {
        id: `${templateId}-studio-desk`,
        zone_id: "design_studio",
        type: "desk",
        anchor: { x: 920, y: 180 },
        rotation: 0,
        blocks_path: true,
        variant: "standard",
        label: null
      },
      {
        id: `${templateId}-snack-vending`,
        zone_id: "hallway",
        type: "vending",
        anchor: { x: 690, y: 390 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null
      }
    ]
  };
  return byTemplate;
}
function templateFromBase(templateId, name, description, category, overrides) {
  const base = buildProjectOfficeProfile(`template-${templateId}`);
  const customized = overrides(base);
  return {
    version: 1,
    template_id: templateId,
    name,
    description,
    category,
    theme: cloneJson(customized.theme),
    zones: cloneJson(customized.zones),
    desks: cloneJson(customized.desks),
    furniture: cloneJson(customized.furniture),
    routing: cloneJson(customized.routing),
    updated_at: (/* @__PURE__ */ new Date()).toISOString(),
    system: true
  };
}
function buildDefaultOfficeTemplates() {
  const furniture = buildTemplateFurniture("template");
  return [
    templateFromBase(
      "startup-studio",
      "Startup Studio",
      "Balanced office for product, marketing, and shipping meetings.",
      "startup",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "startup_studio",
          shell_color: "#0B1020",
          floor_color: "#131C2C",
          panel_color: "#1D1733",
          accent_color: "#22D3EE"
        },
        furniture: cloneJson(furniture["startup-studio"])
      })
    ),
    templateFromBase(
      "engineering-war-room",
      "Engineering War Room",
      "Code-heavy office layout with more technical space and server presence.",
      "engineering",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "engineering_war_room",
          shell_color: "#08111B",
          floor_color: "#0F172A",
          panel_color: "#142033",
          accent_color: "#38BDF8"
        },
        zones: base.zones.map(
          (zone) => zone.id === "rd_lab" ? { ...zone, label: "Engineering War Room", row_span: 2 } : zone.id === "server_farm" ? { ...zone, label: "Ops Cluster" } : zone
        ),
        furniture: cloneJson(furniture["engineering-war-room"])
      })
    ),
    templateFromBase(
      "content-agency",
      "Content Agency",
      "Creative-forward office with campaign boards and content review surfaces.",
      "creative",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "content_agency",
          shell_color: "#160D1F",
          floor_color: "#22122B",
          panel_color: "#2B1633",
          accent_color: "#F472B6"
        },
        zones: base.zones.map(
          (zone) => zone.id === "marketing_studio" ? { ...zone, label: "Campaign Studio", col_span: 2 } : zone.id === "design_studio" ? { ...zone, label: "Creative Lab" } : zone
        ),
        furniture: cloneJson(furniture["content-agency"])
      })
    )
  ];
}
function deriveOfficeTemplateFromProject(officeProfile, templateName, description) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const name = templateName?.trim() || `${officeProfile.name} Template`;
  return {
    version: 1,
    template_id: `template-${officeProfile.office_profile_id}`,
    name,
    description: description?.trim() || "Saved from the current office layout.",
    category: "custom",
    theme: cloneJson(officeProfile.theme),
    zones: cloneJson(officeProfile.zones),
    desks: cloneJson(officeProfile.desks),
    furniture: cloneJson(officeProfile.furniture),
    routing: cloneJson(officeProfile.routing),
    updated_at: now,
    system: false
  };
}
function applyOfficeTemplateToProject(projectId, template2, currentOffice) {
  return {
    ...currentOffice,
    project_id: projectId,
    name: `${template2.name}`,
    theme: cloneJson(template2.theme),
    zones: cloneJson(template2.zones),
    desks: cloneJson(template2.desks),
    furniture: cloneJson(template2.furniture),
    agent_assignments: cloneJson(currentOffice.agent_assignments),
    routing: cloneJson(template2.routing),
    metadata: {
      ...currentOffice.metadata,
      source: "customized",
      updated_at: (/* @__PURE__ */ new Date()).toISOString()
    }
  };
}

// src/lib/officeTemplates.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var templates = buildDefaultOfficeTemplates();
assert(templates.length >= 3, "default office templates should be seeded");
var template = templates.find((entry) => entry.template_id === "engineering-war-room");
assert(template, "engineering war room template should exist");
var projectOffice = buildProjectOfficeProfile("project-template-test");
projectOffice.agent_assignments = [
  {
    agent_id: "agent-developer",
    zone_id: "rd_lab",
    spawn_point: { x: 920, y: 410 }
  }
];
var applied = applyOfficeTemplateToProject(
  "project-template-test",
  template,
  projectOffice
);
assert(applied.theme.theme_id === template.theme.theme_id, "template theme should be applied");
assert(applied.furniture.length === template.furniture.length, "template furniture should be copied");
assert(applied.agent_assignments.length === 1, "template application should preserve project agent assignments");
var derived = deriveOfficeTemplateFromProject(projectOffice, "My Office Template", "Saved template");
assert(derived.name === "My Office Template", "derived template should use the provided name");
assert(derived.description === "Saved template", "derived template should use the provided description");
console.log("officeTemplates tests passed");
