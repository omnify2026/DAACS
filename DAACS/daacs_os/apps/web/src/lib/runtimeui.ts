import type { AgentDashboardResponse, AgentDashboardTab } from "../services/agentApi";
import {
  getAgentMeta,
  type Agent,
  type AgentRole,
  type AgentStatus,
  type AgentUiProfile,
  type Point,
} from "../types/agent";
import type { OfficeAgentAssignment, ProjectOfficeProfile } from "../types/office";
import type { AgentBlueprint, CompanyRuntime, RuntimeBundleResponse } from "../types/runtime";
import { resolveLegacyAgentRole } from "../types/agentCompat";
import { buildAgentOperatingProfile } from "./agentOperatingProfile";
import { findAgentMetadataByCandidatesSync } from "./agentsMetadata";
import { buildProjectOfficeProfile, resolveOfficeZones } from "./officeProfile";

export type RuntimeOfficeZone = {
  id: string;
  label: string;
  accentColor: string;
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  preset: string;
  labelPosition: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  left: number;
  top: number;
  width: number;
  height: number;
  center: Point;
};

const LOBBY_ENTRY: Point = { x: 600, y: 760 };
const MEETING_CENTER: Point = { x: 600, y: 134 };
const OFFICE_WIDTH = 1200;
const OFFICE_HEIGHT = 800;

const ZONE_ALIASES: Record<string, string> = {
  ceo: "ceo_office",
  meeting: "meeting_room",
  factory: "design_studio",
  review_room: "design_studio",
  review_bench: "design_studio",
  design_lab: "design_studio",
  research_lab: "rd_lab",
  war_room: "meeting_room",
  executive_team: "ceo_office",
};

const WIDGET_ALIASES: Record<string, string> = {
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
  logs: "deploy_log",
};

function normalizeZoneId(
  homeZone: string | undefined,
  teamAffinity: string | undefined,
  zones: RuntimeOfficeZone[],
): string {
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

function clampPoint(point: Point): Point {
  return {
    x: Math.max(24, Math.min(OFFICE_WIDTH - 24, Math.round(point.x))),
    y: Math.max(24, Math.min(OFFICE_HEIGHT - 24, Math.round(point.y))),
  };
}

export function findOfficeZoneForPoint(
  point: Point,
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
): RuntimeOfficeZone | null {
  const containing = officeZones.find(
    (zone) =>
      point.x >= zone.left &&
      point.x <= zone.left + zone.width &&
      point.y >= zone.top &&
      point.y <= zone.top + zone.height,
  );
  if (containing) return containing;
  if (officeZones.length === 0) return null;

  return officeZones.reduce((closest, candidate) => {
    const currentDistance = Math.hypot(point.x - closest.center.x, point.y - closest.center.y);
    const candidateDistance = Math.hypot(
      point.x - candidate.center.x,
      point.y - candidate.center.y,
    );
    return candidateDistance < currentDistance ? candidate : closest;
  });
}

function assignmentMap(
  officeProfile?: ProjectOfficeProfile | null,
): Map<string, OfficeAgentAssignment> {
  return new Map(
    (officeProfile?.agent_assignments ?? []).map((assignment) => [
      assignment.agent_id,
      assignment,
    ]),
  );
}

function deskAnchorMap(
  officeProfile?: ProjectOfficeProfile | null,
): Map<string, Point> {
  return new Map(
    (officeProfile?.desks ?? []).map((desk) => [
      desk.id,
      clampPoint(desk.anchor),
    ]),
  );
}

function assignmentZoneId(
  agent: Agent,
  officeProfile: ProjectOfficeProfile | null | undefined,
  officeZones: RuntimeOfficeZone[],
): string {
  const assignment = assignmentMap(officeProfile).get(agent.id);
  if (assignment?.zone_id && officeZones.some((zone) => zone.id === assignment.zone_id)) {
    return assignment.zone_id;
  }
  return normalizeZoneId(
    agent.uiProfile?.home_zone,
    agent.uiProfile?.team_affinity,
    officeZones,
  );
}

function explicitAgentPosition(
  agent: Agent,
  officeProfile: ProjectOfficeProfile | null | undefined,
  officeZones: RuntimeOfficeZone[],
): Point | null {
  const assignment = assignmentMap(officeProfile).get(agent.id);
  if (!assignment) return null;

  if (assignment.spawn_point) {
    const zone = officeZones.find((candidate) => candidate.id === assignment.zone_id);
    if (!zone) return clampPoint(assignment.spawn_point);
    return clampPoint({
      x: Math.max(zone.left + 24, Math.min(zone.left + zone.width - 24, assignment.spawn_point.x)),
      y: Math.max(zone.top + 24, Math.min(zone.top + zone.height - 24, assignment.spawn_point.y)),
    });
  }

  if (assignment.desk_id) {
    const anchor = deskAnchorMap(officeProfile).get(assignment.desk_id);
    if (anchor) return anchor;
  }

  return null;
}

function normalizeWidgetId(widgetId: string): string {
  const normalized = widgetId.trim().toLowerCase();
  return WIDGET_ALIASES[normalized] ?? normalized;
}

function statusFromRuntime(runtimeStatus: string | undefined): AgentStatus {
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

function sortAgentsForZone(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    const authorityDelta = (right.uiProfile?.authority_level ?? 0) - (left.uiProfile?.authority_level ?? 0);
    if (authorityDelta !== 0) return authorityDelta;
    return left.name.localeCompare(right.name);
  });
}

function buildZoneGridPoints(zone: RuntimeOfficeZone, count: number): Point[] {
  if (count <= 1) return [zone.center];

  const columns = Math.max(1, Math.min(3, Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const gapX = columns === 1 ? 0 : Math.min(96, zone.width / Math.max(1, columns - 1));
  const gapY = rows === 1 ? 0 : Math.min(88, zone.height / Math.max(1, rows - 1));
  const startX = zone.center.x - (gapX * (columns - 1)) / 2;
  const startY = zone.center.y - (gapY * (rows - 1)) / 2;

  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return {
      x: Math.round(startX + column * gapX),
      y: Math.round(startY + row * gapY),
    };
  });
}

export function buildDeskPositionMap(
  agents: Agent[],
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
  officeProfile?: ProjectOfficeProfile | null,
): Record<string, Point> {
  const grouped = new Map<string, Agent[]>();
  const zoneIndex = new Map(officeZones.map((zone) => [zone.id, zone]));
  const positions: Record<string, Point> = {};
  for (const agent of agents) {
    const explicitPosition = explicitAgentPosition(agent, officeProfile, officeZones);
    if (explicitPosition) {
      positions[agent.id] = explicitPosition;
      continue;
    }
    const zoneId = assignmentZoneId(agent, officeProfile, officeZones);
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

export function buildMeetingPositionMap(
  agents: Agent[],
  participantIds?: string[],
): Record<string, Point> {
  const participantSet =
    participantIds && participantIds.length > 0 ? new Set(participantIds) : null;
  const ordered = sortAgentsForZone(
    participantSet ? agents.filter((agent) => participantSet.has(agent.id)) : agents,
  );
  const total = ordered.length;
  if (total === 0) return {};

  const radius = Math.min(110, Math.max(58, 48 + total * 8));
  const positions: Record<string, Point> = {};
  ordered.forEach((agent, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
    positions[agent.id] = {
      x: Math.round(MEETING_CENTER.x + Math.cos(angle) * radius),
      y: Math.round(MEETING_CENTER.y + Math.sin(angle) * Math.min(radius, 82)),
    };
  });
  return positions;
}

export function agentCanUseIde(agent: Pick<Agent, "capabilities">): boolean {
  return (agent.capabilities ?? []).includes("code_generation");
}

function buildKpiTab(agent: Agent): AgentDashboardTab {
  return {
    id: "kpi",
    label: "Role Dashboard",
    data: {
      spend_today_usd: 0,
      budget_remaining_usd: 0,
      total_api_calls: 0,
      agent_count: 1,
      by_role_cost: {
        [agent.role]: 0,
      },
    },
  };
}

function buildWidgetTab(widgetId: string, agent: Agent): AgentDashboardTab {
  switch (widgetId) {
    case "alerts":
      return {
        id: "alerts",
        label: "Alerts",
        data: {
          alerts: agent.runtimeStatus === "waiting_approval"
            ? ["Approval requested before release"]
            : agent.status === "working"
              ? [`${agent.name} is actively executing work`]
              : [],
        },
      };
    case "timeline":
      return {
        id: "timeline",
        label: "Timeline",
        data: {
          current_task: agent.currentTask ?? `${agent.name} is aligned with ${agent.assignedTeam ?? "the runtime"}`,
        },
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
              buildDefaultOfficeZones(),
            )}`,
          ],
        },
      };
    case "assets":
      return {
        id: "assets",
        label: "Assets",
        data: {
          assets: [
            `${agent.role}-artifact-01`,
            `${agent.role}-artifact-02`,
          ],
        },
      };
    case "code":
      return {
        id: "code",
        label: "Code",
        data: {
          current_task: agent.currentTask ?? `Implement ${agent.role} tasks`,
          last_output: `${agent.name} is ready to work from the runtime plan`,
        },
      };
    case "git":
      return {
        id: "git",
        label: "Git",
        data: {
          recent_commits: [`chore(${agent.role}): runtime metadata sync`],
        },
      };
    case "content":
      return {
        id: "content",
        label: "Content",
        data: {
          drafts: [`${agent.name} summary draft`],
          scheduled: [],
        },
      };
    case "server":
      return {
        id: "server",
        label: "Server",
        data: {
          cpu_pct: 0,
          mem_pct: 0,
          queue_depth: 0,
          workers_alive: 0,
        },
      };
    case "deploy_log":
      return {
        id: "deploy_log",
        label: "Deploy Log",
        data: {
          logs: [`${agent.name} has no deployment events yet`],
        },
      };
    case "runway":
      return {
        id: "runway",
        label: "Runway",
        data: {
          daily_cap_usd: 0,
          today_spent_usd: 0,
          today_remaining_usd: 0,
          history_7d: [],
        },
      };
    case "cost_breakdown":
      return {
        id: "cost_breakdown",
        label: "Cost Breakdown",
        data: {
          by_role: { [agent.role]: 0 },
          by_model: {},
          total_calls: 0,
        },
      };
    default:
      return {
        id: widgetId,
        label: widgetId
          .split(/[_-]+/g)
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        data: {
          agent: agent.name,
          role: agent.role,
          status: agent.status,
        },
      };
  }
}

export function buildDashboardFallback(agent: Agent): AgentDashboardResponse {
  const widgetIds = [
    "kpi",
    ...(agent.uiProfile?.primary_widgets ?? []),
    ...(agent.uiProfile?.secondary_widgets ?? []),
  ]
    .map(normalizeWidgetId)
    .filter(Boolean);
  const uniqueWidgetIds = [...new Set(widgetIds)];
  const tabs = uniqueWidgetIds.map((widgetId) =>
    widgetId === "kpi" ? buildKpiTab(agent) : buildWidgetTab(widgetId, agent),
  );

  return {
    role: agent.role,
    display_name: agent.meta?.name ?? agent.name,
    status: agent.runtimeStatus ?? agent.status,
    tabs,
    updated_at: new Date().toISOString(),
  };
}

function buildAgentMeta(role: string, uiProfile: AgentUiProfile | undefined, fallbackName: string) {
  return getAgentMeta(role, {
    name: uiProfile?.display_name || fallbackName,
    title: uiProfile?.title || fallbackName,
    color: uiProfile?.accent_color,
    icon: uiProfile?.icon,
  });
}

function resolveOfficeRoleForRuntimeBlueprint(
  blueprint: AgentBlueprint | undefined,
): AgentRole {
  if (blueprint == null) return "developer_front";
  const match = findAgentMetadataByCandidatesSync([
    blueprint.prompt_bundle_ref,
    blueprint.role_label,
    blueprint.name,
    blueprint.ui_profile?.display_name,
    blueprint.ui_profile?.title,
  ]);
  const fromMetadata = match?.office_role?.trim();
  if (fromMetadata != null && fromMetadata !== "") return fromMetadata as AgentRole;
  return resolveLegacyAgentRole(blueprint);
}

export function buildOfficeZones(
  runtime: CompanyRuntime,
  officeProfile?: ProjectOfficeProfile | null,
): RuntimeOfficeZone[] {
  const zoneSpecs = resolveOfficeZones(runtime, officeProfile).sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    if (left.col !== right.col) return left.col - right.col;
    return left.id.localeCompare(right.id);
  });
  const totalColumns = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.col + zone.col_span),
  );
  const totalRows = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.row + zone.row_span),
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
        y: Math.round(top + height / 2),
      },
    };
  });
}

export function buildDefaultOfficeZones(): RuntimeOfficeZone[] {
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
    updated_at: "",
  } satisfies CompanyRuntime;
  return buildOfficeZones(runtime, buildProjectOfficeProfile(runtime.project_id, runtime));
}

export function buildRuntimeAgents(
  bundle: RuntimeBundleResponse,
  officeProfile?: ProjectOfficeProfile | null,
): Agent[] {
  const blueprintIndex = new Map(bundle.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const resolvedOfficeProfile =
    officeProfile ?? buildProjectOfficeProfile(bundle.runtime.project_id, bundle.runtime);
  const officeZones = buildOfficeZones(bundle.runtime, resolvedOfficeProfile);

  const seededAgents = bundle.instances.map((instance) => {
    const blueprint = blueprintIndex.get(instance.blueprint_id);
    const role = resolveOfficeRoleForRuntimeBlueprint(blueprint);
    const uiProfile = blueprint?.ui_profile;
    const meta = buildAgentMeta(role, uiProfile, blueprint?.name ?? role);

    return {
      id: instance.instance_id,
      instanceId: instance.instance_id,
      blueprintId: instance.blueprint_id,
      promptKey: blueprint?.prompt_bundle_ref ?? undefined,
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
        collaborationPolicy: blueprint?.collaboration_policy,
      }),
      capabilities: blueprint?.capabilities ?? [],
      skillBundleRefs: blueprint?.skill_bundle_refs ?? [],
    } satisfies Agent;
  });

  const deskPositions = buildDeskPositionMap(seededAgents, officeZones, resolvedOfficeProfile);
  return seededAgents.map((agent) => ({
    ...agent,
    position: deskPositions[agent.id] ?? LOBBY_ENTRY,
  }));
}
