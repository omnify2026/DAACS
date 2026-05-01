import {
  agentCanUseIde,
  buildDashboardFallback,
  buildDeskPositionMap,
  buildMeetingPositionMap,
  buildOfficeZones,
  buildRuntimeAgents,
  findOfficeZoneForPoint,
} from "./runtimeUi";
import { buildProjectOfficeProfile } from "./officeProfile";
import type { RuntimeBundleResponse } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const runtimeBundle: RuntimeBundleResponse = {
  runtime: {
    runtime_id: "runtime-1",
    project_id: "project-1",
    company_name: "Dynamic Studio",
    org_graph: {
      zones: {
        design_studio: { label: "Design Studio", accent_color: "#F97316" },
        research_lab: { label: "Research Lab", accent_color: "#14B8A6" },
      },
    },
    agent_instance_ids: ["inst-1", "inst-2", "inst-3"],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    created_at: "2026-03-25T00:00:00.000Z",
    updated_at: "2026-03-25T00:00:00.000Z",
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
        connectors: ["design_assets_connector", "docs_connector"],
      },
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {
        workspace_mode: "design_workspace",
        interaction_style: {
          movement_mode: "walk_to_desk",
          speech_mode: "short_bubble",
          return_mode: "return_to_origin",
        },
      },
      approval_policy: {
        mode: "always_owner",
        external_actions_require_approval: true,
        default_approver: "owner_ops",
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
        meeting_behavior: "review",
      },
      is_builtin: false,
      owner_user_id: "user-1",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z",
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
        meeting_behavior: "report",
      },
      is_builtin: false,
      owner_user_id: "user-1",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z",
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
        meeting_behavior: "ship",
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "2026-03-25T00:00:00.000Z",
      updated_at: "2026-03-25T00:00:00.000Z",
    },
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
      updated_at: "2026-03-25T00:00:00.000Z",
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
      updated_at: "2026-03-25T00:00:00.000Z",
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
      updated_at: "2026-03-25T00:00:00.000Z",
    },
  ],
};

const agents = buildRuntimeAgents(runtimeBundle);
assert(agents.length === 3, "runtime agents should be created for every instance");

const customAgent = agents.find((agent) => agent.id === "inst-1");
assert(customAgent, "custom runtime agent should exist");
assert(customAgent.role === "brand_designer", "custom runtime role should be preserved");
assert(customAgent.uiProfile?.home_zone === "design_studio", "ui profile should be attached");
assert(customAgent.meta?.color === "#F97316", "runtime color should override builtin fallback");
assert(
  customAgent.operatingProfile?.workspace_mode === "design_workspace",
  "runtime agents should recover workspace mode from stored collaboration policy",
);
assert(
  customAgent.operatingProfile?.tool_connectors.includes("design_assets_connector"),
  "runtime agents should recover connector hints from stored tool policy",
);

const secondAgent = agents.find((agent) => agent.id === "inst-2");
assert(secondAgent?.status === "working", "runtime status should map into office agent status");
assert(secondAgent.position.x !== customAgent.position.x || secondAgent.position.y !== customAgent.position.y, "desk positions should not collapse to the same point");

const meetingMap = buildMeetingPositionMap(agents);
assert(Object.keys(meetingMap).length === agents.length, "meeting positions should exist for every agent");
assert(meetingMap["inst-1"].x !== meetingMap["inst-2"].x || meetingMap["inst-1"].y !== meetingMap["inst-2"].y, "meeting positions should be distributed");

const dashboard = buildDashboardFallback(customAgent);
assert(dashboard.display_name === "Brand Designer", "dashboard should use runtime display name");
assert(dashboard.tabs.some((tab) => tab.id === "preview"), "primary widgets should become dashboard tabs");
assert(!agentCanUseIde(customAgent), "non-code agents should not receive ide access");

const codeDashboard = buildDashboardFallback(agents.find((agent) => agent.id === "inst-3")!);
assert(codeDashboard.tabs.some((tab) => tab.id === "code"), "code-capable agents should expose code widgets");
assert(agentCanUseIde(agents.find((agent) => agent.id === "inst-3")!), "code_generation capability should enable ide access");
assert(
  agents.find((agent) => agent.id === "inst-3")?.operatingProfile?.tool_connectors.includes("git_connector"),
  "code-capable agents should infer builder connectors when explicit policies are absent",
);

const dynamicZones = buildOfficeZones({
  ...runtimeBundle.runtime,
  org_graph: {
    zones: {
      design_studio: { label: "Design Studio", accent_color: "#F97316", row: 0, col: 0 },
      strategy_hub: { label: "Strategy Hub", accent_color: "#22C55E", row: 0, col: 3 },
    },
  },
});
assert(dynamicZones.some((zone) => zone.id === "strategy_hub"), "runtime-defined zones should be preserved");
assert(dynamicZones.find((zone) => zone.id === "strategy_hub")?.col === 3, "runtime-defined zone geometry should be preserved");

const officeProfile = buildProjectOfficeProfile(runtimeBundle.runtime.project_id, runtimeBundle.runtime);
officeProfile.agent_assignments = [
  {
    agent_id: "inst-1",
    zone_id: "lobby",
    desk_id: null,
    spawn_point: { x: 520, y: 690 },
  },
];
const assignedDeskPositions = buildDeskPositionMap(agents, dynamicZones, officeProfile);
assert(
  assignedDeskPositions["inst-1"].x === 520 && assignedDeskPositions["inst-1"].y === 690,
  "explicit office profile spawn points should override default desk placement",
);

const nearestZone = findOfficeZoneForPoint({ x: 1170, y: 760 }, dynamicZones);
assert(nearestZone?.id === "server_farm" || nearestZone?.id === "strategy_hub", "point lookup should resolve the nearest runtime office zone");

console.log("runtimeUi tests passed");
