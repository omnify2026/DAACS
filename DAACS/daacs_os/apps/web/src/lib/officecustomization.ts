import type { Agent, AgentStatus, Point } from "../types/agent";
import type {
  OfficeAgentAssignment,
  OfficeThemeDocument,
  OfficeZoneDocument,
  ProjectOfficeProfile,
} from "../types/office";
import type { CompanyRuntime, JsonValue } from "../types/runtime";
import { buildOfficeZones, findOfficeZoneForPoint, type RuntimeOfficeZone } from "./runtimeUi";

export type OfficeZonePatch = Partial<
  Pick<
    OfficeZoneDocument,
    "label" | "accent_color" | "row" | "col" | "row_span" | "col_span" | "preset" | "label_position"
  >
>;

export type OfficeThemePatch = Partial<
  Pick<
    OfficeThemeDocument,
    "theme_id" | "shell_color" | "floor_color" | "panel_color" | "accent_color"
  >
>;

export function markOfficeProfileCustomized(
  profile: ProjectOfficeProfile,
  overrides: Partial<ProjectOfficeProfile>,
): ProjectOfficeProfile {
  return {
    ...profile,
    ...overrides,
    metadata: {
      ...profile.metadata,
      source: "customized",
      updated_at: new Date().toISOString(),
    },
  };
}

export function upsertOfficeAssignment(
  assignments: OfficeAgentAssignment[],
  nextAssignment: OfficeAgentAssignment,
): OfficeAgentAssignment[] {
  const filtered = assignments.filter((assignment) => assignment.agent_id !== nextAssignment.agent_id);
  return [...filtered, nextAssignment];
}

export function settleAgentStatus(status: AgentStatus): AgentStatus {
  if (status === "walking" || status === "meeting") {
    return "idle";
  }
  return status;
}

export function buildOfficeRuntimeForProfile(
  projectId: string,
  officeProfile: ProjectOfficeProfile,
  runtime?: CompanyRuntime | null,
): CompanyRuntime {
  if (runtime && runtime.project_id === projectId) {
    return runtime;
  }

  return {
    runtime_id: officeProfile.metadata.runtime_id ?? `local-office-${projectId}`,
    project_id: projectId,
    company_name: officeProfile.name,
    org_graph: {
      office_profile: JSON.parse(JSON.stringify(officeProfile)) as JsonValue,
    },
    agent_instance_ids: [],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "manual",
    owner_ops_state: {},
    created_at: officeProfile.metadata.updated_at,
    updated_at: officeProfile.metadata.updated_at,
  };
}

export function buildOfficeZonesForProfile(
  projectId: string,
  officeProfile: ProjectOfficeProfile,
  runtime?: CompanyRuntime | null,
): RuntimeOfficeZone[] {
  return buildOfficeZones(buildOfficeRuntimeForProfile(projectId, officeProfile, runtime), officeProfile);
}

export function clampPointToZone(point: Point, zone: RuntimeOfficeZone): Point {
  return {
    x: Math.max(zone.left + 24, Math.min(zone.left + zone.width - 24, Math.round(point.x))),
    y: Math.max(zone.top + 24, Math.min(zone.top + zone.height - 24, Math.round(point.y))),
  };
}

export function resolveAgentZoneId(
  agent: Agent,
  officeProfile: ProjectOfficeProfile,
  officeZones: RuntimeOfficeZone[],
): string {
  const assignment = officeProfile.agent_assignments.find(
    (candidate) => candidate.agent_id === agent.id,
  );
  if (assignment?.zone_id && officeZones.some((zone) => zone.id === assignment.zone_id)) {
    return assignment.zone_id;
  }

  const homeZone = agent.uiProfile?.home_zone;
  if (homeZone && officeZones.some((zone) => zone.id === homeZone)) {
    return homeZone;
  }

  return findOfficeZoneForPoint(agent.position, officeZones)?.id ?? officeZones[0]?.id ?? "lobby";
}
