import type { JsonValue, CompanyRuntime } from "../types/runtime";
import type {
  GlobalOfficeSettingsDocument,
  OfficeDeskDocument,
  OfficeFurnitureDocument,
  OfficeLabelPosition,
  OfficeProfileMetadata,
  OfficeRoutingDocument,
  OfficeThemeDocument,
  OfficeZoneDocument,
  ProjectOfficeProfile,
} from "../types/office";

type RuntimeZoneConfig = {
  label?: string;
  accent_color?: string;
  row?: number;
  col?: number;
  row_span?: number;
  col_span?: number;
  preset?: string;
  label_position?: OfficeLabelPosition;
};

const OFFICE_PROFILE_VERSION = 1 as const;

const DEFAULT_THEME: OfficeThemeDocument = {
  theme_id: "daacs_default",
  shell_color: "#0F0F23",
  floor_color: "#111827",
  panel_color: "#1A1A2E",
  accent_color: "#22D3EE",
};

const DEFAULT_ROUTING: OfficeRoutingDocument = {
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
    generic: 1.35,
  },
};

const DEFAULT_ZONE_ORDER = [
  "ceo_office",
  "meeting_room",
  "design_studio",
  "marketing_studio",
  "hallway",
  "rd_lab",
  "finance_room",
  "lobby",
  "server_farm",
] as const;

const DEFAULT_ZONE_SPECS: Record<string, OfficeZoneDocument> = {
  ceo_office: {
    id: "ceo_office",
    label: "CEO Office",
    accent_color: "#8B5CF6",
    row: 0,
    col: 0,
    row_span: 1,
    col_span: 1,
    preset: "ceo",
    label_position: "top-left",
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
    label_position: "top-left",
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
    label_position: "top-right",
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
    label_position: "top-left",
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
    label_position: "top-left",
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
    label_position: "top-right",
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
    label_position: "bottom-left",
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
    label_position: "bottom-left",
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
    label_position: "bottom-right",
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function humanizeZoneId(zoneId: string): string {
  return zoneId
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : fallback;
}

function asPositiveSpan(value: unknown, fallback: number): number {
  const rounded = asPositiveInt(value, fallback);
  return rounded > 0 ? rounded : fallback;
}

function asLabelPosition(value: unknown, fallback: OfficeLabelPosition): OfficeLabelPosition {
  return value === "top-left" ||
    value === "top-right" ||
    value === "bottom-left" ||
    value === "bottom-right"
    ? value
    : fallback;
}

function asRoutingDocument(value: unknown): OfficeRoutingDocument {
  if (!isRecord(value)) return { ...DEFAULT_ROUTING };

  const preferredZoneCosts = isRecord(value.preferred_zone_costs)
    ? Object.fromEntries(
        Object.entries(value.preferred_zone_costs).flatMap(([key, raw]) =>
          typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? [[key, raw]] : [],
        ),
      )
    : {};

  const blockedCells = Array.isArray(value.blocked_cells)
    ? value.blocked_cells.flatMap((cell) => {
        if (!isRecord(cell)) return [];
        if (typeof cell.x !== "number" || typeof cell.y !== "number") return [];
        return [{ x: Math.round(cell.x), y: Math.round(cell.y) }];
      })
    : [];

  return {
    algorithm: "a_star_grid",
    cell_size: asPositiveSpan(value.cell_size, DEFAULT_ROUTING.cell_size),
    blocked_cells: blockedCells,
    preferred_zone_costs: {
      ...DEFAULT_ROUTING.preferred_zone_costs,
      ...preferredZoneCosts,
    },
  };
}

function fallbackZoneDocument(zoneId: string, index: number): OfficeZoneDocument {
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
    label_position: "top-left",
  };
}

function normalizeZoneDocument(
  zoneId: string,
  value: unknown,
  fallback: OfficeZoneDocument,
): OfficeZoneDocument {
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
    label_position: asLabelPosition(value.label_position, fallback.label_position),
  };
}

function resolveRuntimeZoneConfigs(
  runtime: CompanyRuntime | null | undefined,
): Record<string, RuntimeZoneConfig> {
  if (!runtime || !isRecord(runtime.org_graph)) return {};
  const runtimeZones = isRecord(runtime.org_graph.zones) ? runtime.org_graph.zones : {};

  return Object.fromEntries(
    Object.entries(runtimeZones).map(([zoneId, config]) => [
      zoneId,
      {
        label: isRecord(config) && typeof config.label === "string" ? config.label : undefined,
        accent_color:
          isRecord(config) && typeof config.accent_color === "string"
            ? config.accent_color
            : undefined,
        row:
          isRecord(config) && typeof config.row === "number"
            ? asPositiveInt(config.row, 0)
            : undefined,
        col:
          isRecord(config) && typeof config.col === "number"
            ? asPositiveInt(config.col, 0)
            : undefined,
        row_span:
          isRecord(config) && typeof config.row_span === "number"
            ? asPositiveSpan(config.row_span, 1)
            : undefined,
        col_span:
          isRecord(config) && typeof config.col_span === "number"
            ? asPositiveSpan(config.col_span, 1)
            : undefined,
        preset: isRecord(config) && typeof config.preset === "string" ? config.preset : undefined,
        label_position:
          isRecord(config) && config.label_position
            ? asLabelPosition(config.label_position, "top-left")
            : undefined,
      },
    ]),
  );
}

function resolveZonesFromRuntime(runtime: CompanyRuntime | null | undefined): OfficeZoneDocument[] {
  const runtimeZones = resolveRuntimeZoneConfigs(runtime);
  const extraZoneIds = Object.keys(runtimeZones).filter(
    (zoneId) => !(zoneId in DEFAULT_ZONE_SPECS),
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
      label_position: runtimeZone?.label_position ?? fallback.label_position,
    };
  });
}

function normalizeTheme(value: unknown): OfficeThemeDocument {
  if (!isRecord(value)) return { ...DEFAULT_THEME };
  return {
    theme_id: asString(value.theme_id, DEFAULT_THEME.theme_id),
    shell_color: asString(value.shell_color, DEFAULT_THEME.shell_color),
    floor_color: asString(value.floor_color, DEFAULT_THEME.floor_color),
    panel_color: asString(value.panel_color, DEFAULT_THEME.panel_color),
    accent_color: asString(value.accent_color, DEFAULT_THEME.accent_color),
  };
}

function normalizeMetadata(
  value: unknown,
  runtimeId: string | null | undefined,
  source: OfficeProfileMetadata["source"],
): OfficeProfileMetadata {
  if (!isRecord(value)) {
    return {
      source,
      runtime_id: runtimeId ?? null,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    source:
      value.source === "default" ||
      value.source === "runtime" ||
      value.source === "snapshot" ||
      value.source === "customized"
        ? value.source
        : source,
    runtime_id:
      typeof value.runtime_id === "string" && value.runtime_id.trim().length > 0
        ? value.runtime_id.trim()
        : runtimeId ?? null,
    furniture_initialized: value.furniture_initialized === true,
    updated_at: asString(value.updated_at, new Date().toISOString()),
  };
}

function normalizeDeskDocuments(value: unknown): OfficeDeskDocument[] {
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
          y: Math.round(entry.anchor.y),
        },
        agent_id:
          typeof entry.agent_id === "string" && entry.agent_id.trim().length > 0
            ? entry.agent_id.trim()
            : null,
      },
    ];
  });
}

function normalizeFurnitureDocuments(value: unknown): OfficeFurnitureDocument[] {
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
          y: Math.round(entry.anchor.y),
        },
        variant:
          typeof entry.variant === "string" && entry.variant.trim().length > 0
            ? entry.variant.trim()
            : null,
        rotation:
          typeof entry.rotation === "number" && Number.isFinite(entry.rotation)
            ? Math.round(entry.rotation)
            : 0,
        blocks_path: typeof entry.blocks_path === "boolean" ? entry.blocks_path : undefined,
        label:
          typeof entry.label === "string" && entry.label.trim().length > 0
            ? entry.label.trim()
            : null,
      },
    ];
  });
}

function normalizeAssignments(value: unknown): ProjectOfficeProfile["agent_assignments"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.agent_id !== "string" || typeof entry.zone_id !== "string") {
      return [];
    }
    return [
      {
        agent_id: entry.agent_id.trim(),
        zone_id: entry.zone_id.trim(),
        desk_id:
          typeof entry.desk_id === "string" && entry.desk_id.trim().length > 0
            ? entry.desk_id.trim()
            : null,
        spawn_point:
          isRecord(entry.spawn_point) &&
          typeof entry.spawn_point.x === "number" &&
          typeof entry.spawn_point.y === "number"
            ? {
                x: Math.round(entry.spawn_point.x),
                y: Math.round(entry.spawn_point.y),
              }
            : null,
      },
    ];
  });
}

export function resolveOfficeZones(
  runtime: CompanyRuntime | null | undefined,
  officeProfile?: ProjectOfficeProfile | null,
): OfficeZoneDocument[] {
  if (officeProfile && officeProfile.zones.length > 0) {
    return officeProfile.zones.map((zone, index) =>
      normalizeZoneDocument(zone.id, zone, DEFAULT_ZONE_SPECS[zone.id] ?? fallbackZoneDocument(zone.id, index)),
    );
  }
  return resolveZonesFromRuntime(runtime);
}

export function parseProjectOfficeProfile(
  value: unknown,
  projectId: string,
  runtime?: CompanyRuntime | null,
): ProjectOfficeProfile | null {
  if (!isRecord(value)) return null;

  const fallbackZones = resolveZonesFromRuntime(runtime);
  const normalizedZonesInput = Array.isArray(value.zones)
    ? value.zones.map((zone, index) => {
        const zoneId =
          isRecord(zone) && typeof zone.id === "string" && zone.id.trim().length > 0
            ? zone.id.trim()
            : `zone-${index + 1}`;
        const fallback =
          fallbackZones.find((candidate) => candidate.id === zoneId) ??
          fallbackZoneDocument(zoneId, index);
        return normalizeZoneDocument(zoneId, zone, fallback);
      })
    : fallbackZones;

  return {
    version: OFFICE_PROFILE_VERSION,
    office_profile_id: asString(value.office_profile_id, `office-${projectId}`),
    project_id: asString(value.project_id, projectId),
    scope: "project",
    name: asString(
      value.name,
      runtime?.company_name?.trim() ? `${runtime.company_name} Office` : "Project Office",
    ),
    theme: normalizeTheme(value.theme),
    zones: normalizedZonesInput,
    desks: normalizeDeskDocuments(value.desks),
    furniture: normalizeFurnitureDocuments(value.furniture),
    agent_assignments: normalizeAssignments(value.agent_assignments),
    routing: asRoutingDocument(value.routing),
    metadata: normalizeMetadata(value.metadata, runtime?.runtime_id ?? null, "snapshot"),
  };
}

export function buildProjectOfficeProfile(
  projectId: string,
  runtime?: CompanyRuntime | null,
): ProjectOfficeProfile {
  const orgGraph = isRecord(runtime?.org_graph) ? runtime?.org_graph : null;
  const embeddedProfile =
    orgGraph && isRecord(orgGraph.office_profile)
      ? parseProjectOfficeProfile(orgGraph.office_profile, projectId, runtime)
      : null;
  if (embeddedProfile) {
    return {
      ...embeddedProfile,
      project_id: projectId,
      metadata: {
        ...embeddedProfile.metadata,
        source: embeddedProfile.metadata.source ?? "runtime",
        runtime_id: runtime?.runtime_id ?? embeddedProfile.metadata.runtime_id ?? null,
      },
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
      furniture_initialized: false,
      updated_at: new Date().toISOString(),
    },
  };
}

export function serializeProjectOfficeProfile(profile: ProjectOfficeProfile): string {
  return JSON.stringify(profile, null, 2);
}

export function embedOfficeProfileInOrgGraph(
  orgGraph: JsonValue,
  officeProfile: ProjectOfficeProfile,
): JsonValue {
  const base = isRecord(orgGraph) ? { ...orgGraph } : {};
  const serializedProfile = JSON.parse(
    JSON.stringify(officeProfile),
  ) as JsonValue;
  return {
    ...base,
    zones: Object.fromEntries(
      officeProfile.zones.map((zone) => [
        zone.id,
        {
          label: zone.label,
          accent_color: zone.accent_color,
          row: zone.row,
          col: zone.col,
          row_span: zone.row_span,
          col_span: zone.col_span,
          preset: zone.preset,
          label_position: zone.label_position,
        },
      ]),
    ),
    office_profile: serializedProfile,
  };
}

export function buildDefaultGlobalOfficeSettings(): GlobalOfficeSettingsDocument {
  return {
    version: OFFICE_PROFILE_VERSION,
    settings_id: "global-office-settings",
    scope: "global",
    default_office_profile_id: null,
    default_template_id: null,
    shared_agent_ids: [],
    office_profile_ids: [],
    office_template_ids: [],
    theme: { ...DEFAULT_THEME },
    updated_at: new Date().toISOString(),
  };
}
