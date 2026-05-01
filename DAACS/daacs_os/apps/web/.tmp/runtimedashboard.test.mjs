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

// src/lib/runtimeUi.ts
var LOBBY_ENTRY = { x: 600, y: 760 };
var OFFICE_WIDTH = 1200;
var OFFICE_HEIGHT = 800;
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
    accentColor: "#8B5CF6",
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    preset: "ceo",
    labelPosition: "top-left"
  },
  meeting_room: {
    id: "meeting_room",
    label: "Meeting Room",
    accentColor: "#6366F1",
    row: 0,
    col: 1,
    rowSpan: 1,
    colSpan: 1,
    preset: "meeting",
    labelPosition: "top-left"
  },
  design_studio: {
    id: "design_studio",
    label: "Design Studio",
    accentColor: "#F97316",
    row: 0,
    col: 2,
    rowSpan: 1,
    colSpan: 1,
    preset: "design",
    labelPosition: "top-right"
  },
  marketing_studio: {
    id: "marketing_studio",
    label: "Marketing Studio",
    accentColor: "#EC4899",
    row: 1,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    preset: "marketing",
    labelPosition: "top-left"
  },
  hallway: {
    id: "hallway",
    label: "Hallway",
    accentColor: "#64748B",
    row: 1,
    col: 1,
    rowSpan: 1,
    colSpan: 1,
    preset: "hallway",
    labelPosition: "top-left"
  },
  rd_lab: {
    id: "rd_lab",
    label: "R&D Lab",
    accentColor: "#3B82F6",
    row: 1,
    col: 2,
    rowSpan: 1,
    colSpan: 1,
    preset: "engineering",
    labelPosition: "top-right"
  },
  finance_room: {
    id: "finance_room",
    label: "Finance Room",
    accentColor: "#EAB308",
    row: 2,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    preset: "finance",
    labelPosition: "bottom-left"
  },
  lobby: {
    id: "lobby",
    label: "Lobby",
    accentColor: "#94A3B8",
    row: 2,
    col: 1,
    rowSpan: 1,
    colSpan: 1,
    preset: "lobby",
    labelPosition: "bottom-left"
  },
  server_farm: {
    id: "server_farm",
    label: "Server Farm",
    accentColor: "#10B981",
    row: 2,
    col: 2,
    rowSpan: 1,
    colSpan: 1,
    preset: "server",
    labelPosition: "bottom-right"
  }
};
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
function humanizeZoneId(zoneId) {
  return zoneId.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function asPositiveInt(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return rounded >= 0 ? rounded : null;
}
function asPositiveSpan(value) {
  const rounded = asPositiveInt(value);
  return rounded && rounded > 0 ? rounded : null;
}
function fallbackZoneSpec(zoneId, index) {
  const defaultColumns = 3;
  return {
    id: zoneId,
    label: humanizeZoneId(zoneId),
    accentColor: "#64748B",
    row: Math.floor(index / defaultColumns),
    col: index % defaultColumns,
    rowSpan: 1,
    colSpan: 1,
    preset: "generic",
    labelPosition: "top-left"
  };
}
function resolveRuntimeZoneConfigs(runtime) {
  const runtimeZones = runtime?.org_graph?.zones ?? {};
  return Object.fromEntries(
    Object.entries(runtimeZones).map(([zoneId, config]) => [
      zoneId,
      {
        label: typeof config?.label === "string" ? config.label : void 0,
        accent_color: typeof config?.accent_color === "string" ? config.accent_color : void 0,
        row: asPositiveInt(config?.row) ?? void 0,
        col: asPositiveInt(config?.col) ?? void 0,
        row_span: asPositiveSpan(config?.row_span) ?? void 0,
        col_span: asPositiveSpan(config?.col_span) ?? void 0,
        preset: typeof config?.preset === "string" ? config.preset : void 0,
        label_position: config?.label_position === "top-left" || config?.label_position === "top-right" || config?.label_position === "bottom-left" || config?.label_position === "bottom-right" ? config.label_position : void 0
      }
    ])
  );
}
function resolveZoneSpecs(runtime) {
  const runtimeZones = resolveRuntimeZoneConfigs(runtime);
  const extraZoneIds = Object.keys(runtimeZones).filter(
    (zoneId) => !(zoneId in DEFAULT_ZONE_SPECS)
  );
  const orderedZoneIds = [...DEFAULT_ZONE_ORDER, ...extraZoneIds];
  return orderedZoneIds.map((zoneId, index) => {
    const fallback = DEFAULT_ZONE_SPECS[zoneId] ?? fallbackZoneSpec(zoneId, index);
    const runtimeZone = runtimeZones[zoneId];
    return {
      id: zoneId,
      label: runtimeZone?.label?.trim() || fallback.label,
      accentColor: runtimeZone?.accent_color?.trim() || fallback.accentColor,
      row: runtimeZone?.row ?? fallback.row,
      col: runtimeZone?.col ?? fallback.col,
      rowSpan: runtimeZone?.row_span ?? fallback.rowSpan,
      colSpan: runtimeZone?.col_span ?? fallback.colSpan,
      preset: runtimeZone?.preset?.trim() || fallback.preset,
      labelPosition: runtimeZone?.label_position ?? fallback.labelPosition
    };
  });
}
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
function buildDeskPositionMap(agents2, officeZones = buildDefaultOfficeZones()) {
  const grouped = /* @__PURE__ */ new Map();
  const zoneIndex = new Map(officeZones.map((zone) => [zone.id, zone]));
  for (const agent of agents2) {
    const zoneId = normalizeZoneId(
      agent.uiProfile?.home_zone,
      agent.uiProfile?.team_affinity,
      officeZones
    );
    const rows = grouped.get(zoneId) ?? [];
    rows.push(agent);
    grouped.set(zoneId, rows);
  }
  const positions = {};
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
function buildAgentMeta(role, uiProfile, fallbackName) {
  return getAgentMeta(role, {
    name: uiProfile?.display_name || fallbackName,
    title: uiProfile?.title || fallbackName,
    color: uiProfile?.accent_color,
    icon: uiProfile?.icon
  });
}
function buildOfficeZones(runtime) {
  const zoneSpecs = resolveZoneSpecs(runtime).sort((left, right) => {
    if (left.row !== right.row) return left.row - right.row;
    if (left.col !== right.col) return left.col - right.col;
    return left.id.localeCompare(right.id);
  });
  const totalColumns = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.col + zone.colSpan)
  );
  const totalRows = Math.max(
    3,
    ...zoneSpecs.map((zone) => zone.row + zone.rowSpan)
  );
  const cellWidth = OFFICE_WIDTH / totalColumns;
  const cellHeight = OFFICE_HEIGHT / totalRows;
  return zoneSpecs.map((zone) => {
    const width = cellWidth * zone.colSpan;
    const height = cellHeight * zone.rowSpan;
    const left = cellWidth * zone.col;
    const top = cellHeight * zone.row;
    return {
      id: zone.id,
      label: zone.label,
      accentColor: zone.accentColor,
      row: zone.row,
      col: zone.col,
      rowSpan: zone.rowSpan,
      colSpan: zone.colSpan,
      preset: zone.preset,
      labelPosition: zone.labelPosition,
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
  return buildOfficeZones({
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
  });
}
function buildRuntimeAgents(bundle2) {
  const blueprintIndex = new Map(bundle2.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const officeZones = buildOfficeZones(bundle2.runtime);
  const seededAgents = bundle2.instances.map((instance) => {
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
      capabilities: blueprint?.capabilities ?? []
    };
  });
  const deskPositions = buildDeskPositionMap(seededAgents, officeZones);
  return seededAgents.map((agent) => ({
    ...agent,
    position: deskPositions[agent.id] ?? LOBBY_ENTRY
  }));
}

// src/lib/runtimePlan.ts
var PLAN_STATUS_RANK = {
  active: 0,
  paused: 1,
  draft: 2,
  completed: 3,
  failed: 4
};
function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function asStringArray(value) {
  return Array.isArray(value) ? value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean) : [];
}
function humanize(value) {
  return value.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function parseDateScore(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function roleLabelForInstance(instanceId, instanceIndex, blueprintIndex) {
  if (!instanceId) return null;
  const instance = instanceIndex.get(instanceId);
  if (!instance) return null;
  return blueprintIndex.get(instance.blueprint_id)?.role_label ?? null;
}
function blueprintForInstance(instanceId, instanceIndex, blueprintIndex) {
  const instance = instanceIndex.get(instanceId);
  if (!instance) return null;
  return blueprintIndex.get(instance.blueprint_id) ?? null;
}
function clusterIdForReference(reference, clusters, roleToCluster) {
  if (clusters.some((cluster) => cluster.id === reference)) return reference;
  if (roleToCluster.has(reference)) return roleToCluster.get(reference) ?? null;
  return null;
}
function isStepActive(step) {
  return step.status === "in_progress" || step.status === "awaiting_approval" || step.status === "approved";
}
function edgeStateForStep(step) {
  if (step.status === "completed" || step.status === "approved" || step.status === "skipped") {
    return "complete";
  }
  if (step.status === "in_progress" || step.status === "awaiting_approval") {
    return "active";
  }
  if (step.status === "pending") return "ready";
  return "blocked";
}
function pickActivePlan(plans) {
  if (plans.length === 0) return null;
  return [...plans].sort((left, right) => {
    const leftRank = PLAN_STATUS_RANK[left.status] ?? 99;
    const rightRank = PLAN_STATUS_RANK[right.status] ?? 99;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const updatedDelta = parseDateScore(right.updated_at) - parseDateScore(left.updated_at);
    if (updatedDelta !== 0) return updatedDelta;
    return parseDateScore(right.created_at) - parseDateScore(left.created_at);
  })[0] ?? null;
}
function buildOrgClusters(instances, blueprintIndex) {
  const grouped = /* @__PURE__ */ new Map();
  for (const instance of instances) {
    const blueprint = blueprintIndex.get(instance.blueprint_id);
    const teamId = blueprint?.ui_profile.team_affinity || instance.assigned_team || "runtime_team";
    const zoneId = blueprint?.ui_profile.home_zone || "lobby";
    const authority = blueprint?.ui_profile.authority_level ?? 0;
    const current = grouped.get(teamId) ?? {
      zone_id: zoneId,
      authority_level: authority,
      member_instance_ids: [],
      role_labels: []
    };
    current.zone_id = current.zone_id || zoneId;
    current.authority_level = Math.max(current.authority_level, authority);
    current.member_instance_ids.push(instance.instance_id);
    if (blueprint?.role_label) current.role_labels.push(blueprint.role_label);
    grouped.set(teamId, current);
  }
  return [...grouped.entries()].map(([id, group]) => ({
    id,
    label: humanize(id),
    zone_id: group.zone_id,
    authority_level: group.authority_level,
    member_instance_ids: group.member_instance_ids,
    role_labels: [...new Set(group.role_labels)]
  })).sort((left, right) => {
    if (left.authority_level !== right.authority_level) {
      return right.authority_level - left.authority_level;
    }
    return left.label.localeCompare(right.label);
  });
}
function buildOrgEdges(runtime, clusters, roleToCluster) {
  const graph = asRecord(runtime.org_graph);
  const reportingLines = Array.isArray(graph.reporting_lines) ? graph.reporting_lines : [];
  const explicit = reportingLines.map((row) => {
    const source = asRecord(row);
    const from = typeof source.from === "string" ? source.from : "";
    const to = typeof source.to === "string" ? source.to : "";
    const label = typeof source.label === "string" ? source.label : "Reports";
    const fromCluster = clusterIdForReference(from, clusters, roleToCluster);
    const toCluster = clusterIdForReference(to, clusters, roleToCluster);
    if (!fromCluster || !toCluster || fromCluster === toCluster) return null;
    return { from: fromCluster, to: toCluster, label };
  }).filter((edge) => edge !== null);
  if (explicit.length > 0) return explicit;
  const executive = clusters.find((cluster) => cluster.id === "executive_team");
  if (!executive) return [];
  return clusters.filter((cluster) => cluster.id !== executive.id).map((cluster) => ({
    from: executive.id,
    to: cluster.id,
    label: "Coordination"
  }));
}
function buildExecutionGraph(plan2, instanceIndex, blueprintIndex) {
  if (!plan2) {
    return { lanes: [], nodes: [], edges: [] };
  }
  const laneIds = [...new Set(plan2.steps.map((step) => {
    const blueprint = step.assigned_to ? blueprintForInstance(step.assigned_to, instanceIndex, blueprintIndex) : null;
    return blueprint?.ui_profile.team_affinity || "unassigned";
  }))];
  const lanes = laneIds.map((id, index) => ({
    id,
    label: humanize(id),
    index
  }));
  const laneIndex = new Map(lanes.map((lane) => [lane.id, lane]));
  const stepIndex = new Map(plan2.steps.map((step) => [step.step_id, step]));
  const depthMemo = /* @__PURE__ */ new Map();
  const resolveDepth = (stepId) => {
    const existing = depthMemo.get(stepId);
    if (typeof existing === "number") return existing;
    const step = stepIndex.get(stepId);
    if (!step || step.depends_on.length === 0) {
      depthMemo.set(stepId, 0);
      return 0;
    }
    const depth = Math.max(...step.depends_on.map((dependency) => resolveDepth(dependency))) + 1;
    depthMemo.set(stepId, depth);
    return depth;
  };
  const nodes = plan2.steps.map((step) => {
    const blueprint = step.assigned_to ? blueprintForInstance(step.assigned_to, instanceIndex, blueprintIndex) : null;
    const laneId = blueprint?.ui_profile.team_affinity || "unassigned";
    const lane = laneIndex.get(laneId) ?? { id: laneId, label: humanize(laneId), index: 0 };
    const depth = resolveDepth(step.step_id);
    return {
      step_id: step.step_id,
      label: step.label,
      status: step.status,
      lane_id: laneId,
      lane_label: lane.label,
      depth,
      x: 36 + depth * 164,
      y: 48 + lane.index * 92,
      assigned_to: step.assigned_to,
      assigned_role_label: roleLabelForInstance(step.assigned_to, instanceIndex, blueprintIndex),
      approval_required_by: step.approval_required_by,
      approver_role_label: roleLabelForInstance(
        step.approval_required_by,
        instanceIndex,
        blueprintIndex
      )
    };
  });
  const edges = plan2.steps.flatMap(
    (step) => step.depends_on.map((dependency) => ({
      from_step_id: dependency,
      to_step_id: step.step_id,
      state: edgeStateForStep(step)
    }))
  );
  return { lanes, nodes, edges };
}
function buildApprovalQueue(plan2, instanceIndex, blueprintIndex) {
  if (!plan2) return [];
  return plan2.steps.filter((step) => step.status === "awaiting_approval").map((step) => {
    const approverBlueprint = step.approval_required_by ? blueprintForInstance(step.approval_required_by, instanceIndex, blueprintIndex) : null;
    const approverAuthority = approverBlueprint?.ui_profile.authority_level ?? 0;
    return {
      plan_id: plan2.plan_id,
      step_id: step.step_id,
      label: step.label,
      description: step.description,
      assigned_to: step.assigned_to,
      assigned_role_label: roleLabelForInstance(step.assigned_to, instanceIndex, blueprintIndex),
      approver_instance_id: step.approval_required_by,
      approver_role_label: roleLabelForInstance(
        step.approval_required_by,
        instanceIndex,
        blueprintIndex
      ),
      priority: approverAuthority >= 9 ? "high" : approverAuthority >= 6 ? "medium" : "low"
    };
  });
}
function buildMeetingView(runtime, plan2, instances, instanceIndex, blueprintIndex) {
  const protocol = asRecord(runtime.meeting_protocol);
  const participants = /* @__PURE__ */ new Map();
  const includeRole = (roleLabel, reason) => {
    for (const instance of instances) {
      const blueprint = blueprintIndex.get(instance.blueprint_id);
      if (blueprint?.role_label === roleLabel) {
        participants.set(instance.instance_id, reason);
      }
    }
  };
  for (const roleLabel of [
    ...asStringArray(protocol.default_roles),
    ...asStringArray(protocol.participant_roles)
  ]) {
    includeRole(roleLabel, "protocol");
  }
  for (const instanceId of asStringArray(protocol.participant_instance_ids)) {
    if (instanceIndex.has(instanceId)) {
      participants.set(instanceId, "protocol");
    }
  }
  const includeAssignedAgents = protocol.include_assigned_agents !== false;
  const includeApprovers = protocol.include_approvers !== false;
  if (plan2 && includeAssignedAgents) {
    for (const step of plan2.steps) {
      if (!isStepActive(step) || !step.assigned_to) continue;
      participants.set(step.assigned_to, "step");
    }
  }
  if (plan2 && includeApprovers) {
    for (const step of plan2.steps) {
      if (step.status !== "awaiting_approval" || !step.approval_required_by) continue;
      participants.set(step.approval_required_by, "approval");
    }
  }
  const layout = protocol.layout === "briefing" ? "briefing" : "roundtable";
  const rows = [...participants.entries()].map(([instanceId, reason]) => {
    const blueprint = blueprintForInstance(instanceId, instanceIndex, blueprintIndex);
    return {
      instance_id: instanceId,
      role_label: blueprint?.role_label ?? instanceId,
      reason,
      seat_order: blueprint?.ui_profile.authority_level ? -blueprint.ui_profile.authority_level : 0
    };
  }).sort((left, right) => {
    if (left.seat_order !== right.seat_order) return left.seat_order - right.seat_order;
    return left.role_label.localeCompare(right.role_label);
  }).map((participant, index) => ({
    ...participant,
    seat_order: index
  }));
  return {
    layout,
    participant_ids: rows.map((participant) => participant.instance_id),
    participants: rows
  };
}
function buildRuntimePlanView(bundle2, plans) {
  const blueprintIndex = new Map(bundle2.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const instanceIndex = new Map(bundle2.instances.map((instance) => [instance.instance_id, instance]));
  const activePlan = pickActivePlan(plans);
  const clusters = buildOrgClusters(bundle2.instances, blueprintIndex);
  const roleToCluster = /* @__PURE__ */ new Map();
  for (const cluster of clusters) {
    for (const roleLabel of cluster.role_labels) {
      roleToCluster.set(roleLabel, cluster.id);
    }
  }
  return {
    activePlan,
    org: {
      clusters,
      edges: buildOrgEdges(bundle2.runtime, clusters, roleToCluster)
    },
    execution: buildExecutionGraph(activePlan, instanceIndex, blueprintIndex),
    approvalQueue: buildApprovalQueue(activePlan, instanceIndex, blueprintIndex),
    meeting: buildMeetingView(
      bundle2.runtime,
      activePlan,
      bundle2.instances,
      instanceIndex,
      blueprintIndex
    )
  };
}

// src/constants.ts
var DASHBOARD_WIDGET_APPROVAL_QUEUE = "approval_queue";
var DASHBOARD_WIDGET_EXECUTION_GRAPH = "execution_graph";
var DASHBOARD_WIDGET_MEETING_BRIEF = "meeting_brief";
var DASHBOARD_WIDGET_ORG_CHART = "org_chart";
var DASHBOARD_SECTION_PRIORITY = "priority";
var DASHBOARD_SECTION_PRIMARY = "primary";
var DASHBOARD_SECTION_SECONDARY = "secondary";
var DASHBOARD_SECTION_CONTEXT = "context";

// src/lib/runtimeDashboard.ts
var WIDGET_ALIASES = {
  approval: DASHBOARD_WIDGET_APPROVAL_QUEUE,
  approvals: DASHBOARD_WIDGET_APPROVAL_QUEUE,
  graph: DASHBOARD_WIDGET_EXECUTION_GRAPH,
  execution_dag: DASHBOARD_WIDGET_EXECUTION_GRAPH,
  meeting: DASHBOARD_WIDGET_MEETING_BRIEF,
  org: DASHBOARD_WIDGET_ORG_CHART,
  logs: "deploy_log"
};
function normalizeWidgetId(widgetId) {
  const normalized = widgetId.trim().toLowerCase();
  return WIDGET_ALIASES[normalized] ?? normalized;
}
function humanize2(value) {
  return value.split(/[_-]+/g).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}
function hasWidget(tabs2, widgetId) {
  return tabs2.some((tab) => tab.id === widgetId);
}
function placeholderTab(widgetId) {
  return {
    id: widgetId,
    label: humanize2(widgetId),
    data: {}
  };
}
function runtimeTab(widgetId, planView2) {
  if (widgetId === DASHBOARD_WIDGET_EXECUTION_GRAPH) {
    if (!planView2.activePlan) return null;
    return {
      id: widgetId,
      label: "Execution Graph",
      data: {
        goal: planView2.activePlan.goal,
        plan_status: planView2.activePlan.status,
        lanes: planView2.execution.lanes,
        nodes: planView2.execution.nodes,
        edges: planView2.execution.edges
      }
    };
  }
  if (widgetId === DASHBOARD_WIDGET_APPROVAL_QUEUE) {
    if (planView2.approvalQueue.length === 0) return null;
    return {
      id: widgetId,
      label: "Approval Queue",
      data: {
        items: planView2.approvalQueue
      }
    };
  }
  if (widgetId === DASHBOARD_WIDGET_MEETING_BRIEF) {
    if (planView2.meeting.participants.length === 0) return null;
    return {
      id: widgetId,
      label: "Meeting Brief",
      data: {
        layout: planView2.meeting.layout,
        participants: planView2.meeting.participants
      }
    };
  }
  if (widgetId === DASHBOARD_WIDGET_ORG_CHART) {
    if (planView2.org.clusters.length === 0) return null;
    return {
      id: widgetId,
      label: "Org Chart",
      data: {
        clusters: planView2.org.clusters,
        edges: planView2.org.edges
      }
    };
  }
  return null;
}
function mergeRuntimeDashboardTabs(baseTabs, agent, planView2) {
  const nextTabs = [...baseTabs];
  const desiredWidgets = [
    ...agent.uiProfile?.primary_widgets ?? [],
    ...agent.uiProfile?.secondary_widgets ?? []
  ].map(normalizeWidgetId).filter(Boolean);
  for (const widgetId of desiredWidgets) {
    if (!hasWidget(nextTabs, widgetId)) {
      nextTabs.push(placeholderTab(widgetId));
    }
  }
  if (planView2) {
    for (const widgetId of [
      DASHBOARD_WIDGET_EXECUTION_GRAPH,
      DASHBOARD_WIDGET_APPROVAL_QUEUE,
      DASHBOARD_WIDGET_MEETING_BRIEF,
      DASHBOARD_WIDGET_ORG_CHART
    ]) {
      const tab = runtimeTab(widgetId, planView2);
      if (!tab) continue;
      const existingIndex = nextTabs.findIndex((row) => row.id === widgetId);
      if (existingIndex >= 0) {
        nextTabs[existingIndex] = tab;
      } else {
        nextTabs.push(tab);
      }
    }
  }
  return [...new Map(nextTabs.map((tab) => [tab.id, tab])).values()];
}
function pickExistingWidgets(tabs2, requestedWidgetIds, seen) {
  const available = new Set(tabs2.map((tab) => tab.id));
  const picked = [];
  for (const widgetId of requestedWidgetIds.map(normalizeWidgetId)) {
    if (!available.has(widgetId) || seen.has(widgetId)) continue;
    picked.push(widgetId);
    seen.add(widgetId);
  }
  return picked;
}
function buildDashboardSections(tabs2, agent, planView2) {
  const seen = /* @__PURE__ */ new Set();
  const sections2 = [];
  const priorityWidgetIds = pickExistingWidgets(
    tabs2,
    [
      planView2?.approvalQueue.length ? DASHBOARD_WIDGET_APPROVAL_QUEUE : "",
      planView2?.activePlan ? DASHBOARD_WIDGET_EXECUTION_GRAPH : "",
      planView2?.meeting.participants.length ? DASHBOARD_WIDGET_MEETING_BRIEF : ""
    ].filter(Boolean),
    seen
  );
  if (priorityWidgetIds.length > 0) {
    sections2.push({
      id: DASHBOARD_SECTION_PRIORITY,
      title: "Priority",
      widget_ids: priorityWidgetIds
    });
  }
  const primaryWidgetIds = pickExistingWidgets(
    tabs2,
    agent.uiProfile?.primary_widgets ?? [],
    seen
  );
  if (primaryWidgetIds.length > 0) {
    sections2.push({
      id: DASHBOARD_SECTION_PRIMARY,
      title: "Primary",
      widget_ids: primaryWidgetIds
    });
  }
  const secondaryWidgetIds = pickExistingWidgets(
    tabs2,
    agent.uiProfile?.secondary_widgets ?? [],
    seen
  );
  if (secondaryWidgetIds.length > 0) {
    sections2.push({
      id: DASHBOARD_SECTION_SECONDARY,
      title: "Secondary",
      widget_ids: secondaryWidgetIds
    });
  }
  const contextWidgetIds = pickExistingWidgets(
    tabs2,
    [DASHBOARD_WIDGET_ORG_CHART, "alerts", "deploy_log", "logs"],
    seen
  );
  if (contextWidgetIds.length > 0) {
    sections2.push({
      id: DASHBOARD_SECTION_CONTEXT,
      title: "Context",
      widget_ids: contextWidgetIds
    });
  }
  return sections2;
}

// src/lib/runtimeDashboard.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var bundle = {
  runtime: {
    runtime_id: "runtime-dashboard",
    project_id: "project-dashboard",
    company_name: "Dashboard Runtime",
    org_graph: {},
    meeting_protocol: { default_roles: ["pm"], include_assigned_agents: true, include_approvers: true },
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    agent_instance_ids: ["inst-pm", "inst-dev"],
    created_at: "",
    updated_at: ""
  },
  blueprints: [
    {
      id: "bp-pm",
      name: "PM",
      role_label: "pm",
      capabilities: ["planning"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "PM",
        title: "PM",
        avatar_style: "pixel",
        accent_color: "#6366F1",
        icon: "ClipboardList",
        home_zone: "meeting_room",
        team_affinity: "executive_team",
        authority_level: 8,
        capability_tags: ["planning"],
        primary_widgets: ["kanban", "timeline"],
        secondary_widgets: ["logs"],
        focus_mode: "coordination",
        meeting_behavior: "facilitate"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: ""
    },
    {
      id: "bp-dev",
      name: "Frontend",
      role_label: "developer_front",
      capabilities: ["code_generation", "frontend"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Frontend",
        title: "Frontend",
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
        meeting_behavior: "report"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: ""
    }
  ],
  instances: [
    {
      instance_id: "inst-pm",
      blueprint_id: "bp-pm",
      project_id: "project-dashboard",
      runtime_status: "working",
      assigned_team: "executive_team",
      current_tasks: ["Coordinate"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    },
    {
      instance_id: "inst-dev",
      blueprint_id: "bp-dev",
      project_id: "project-dashboard",
      runtime_status: "waiting_approval",
      assigned_team: "development_team",
      current_tasks: ["Implement"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    }
  ]
};
var plan = {
  plan_id: "plan-dashboard",
  runtime_id: "runtime-dashboard",
  goal: "Finish adaptive dashboard",
  created_by: "inst-pm",
  status: "paused",
  created_at: "",
  updated_at: "",
  steps: [
    {
      step_id: "step-dashboard",
      label: "Implement adaptive dashboard",
      description: "Add runtime-aware widget sections",
      assigned_to: "inst-dev",
      depends_on: [],
      approval_required_by: "inst-pm",
      status: "awaiting_approval",
      input: {},
      output: {},
      started_at: null,
      completed_at: null
    }
  ]
};
var agents = buildRuntimeAgents(bundle);
var developer = agents.find((agent) => agent.id === "inst-dev");
assert(developer, "developer agent should exist");
var planView = buildRuntimePlanView(bundle, [plan]);
var tabs = mergeRuntimeDashboardTabs([], developer, planView);
var sections = buildDashboardSections(tabs, developer, planView);
assert(tabs.some((tab) => tab.id === "execution_graph"), "runtime dashboard should inject execution graph widget");
assert(tabs.some((tab) => tab.id === "approval_queue"), "runtime dashboard should inject approval queue widget");
assert(sections[0]?.id === "priority", "priority runtime widgets should render in the first section");
assert(sections[0]?.widget_ids.includes("approval_queue"), "priority section should expose pending approvals");
assert(sections[0]?.widget_ids.includes("execution_graph"), "priority section should expose active execution graph");
assert(sections.some((section) => section.id === "primary" && section.widget_ids.includes("code")), "primary section should preserve code widget from ui profile");
assert(sections.some((section) => section.id === "secondary" && section.widget_ids.includes("timeline")), "secondary section should preserve secondary widgets");
console.log("runtimeDashboard tests passed");
