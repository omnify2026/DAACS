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
function buildExecutionGraph(plan, instanceIndex, blueprintIndex) {
  if (!plan) {
    return { lanes: [], nodes: [], edges: [] };
  }
  const laneIds = [...new Set(plan.steps.map((step) => {
    const blueprint = step.assigned_to ? blueprintForInstance(step.assigned_to, instanceIndex, blueprintIndex) : null;
    return blueprint?.ui_profile.team_affinity || "unassigned";
  }))];
  const lanes = laneIds.map((id, index) => ({
    id,
    label: humanize(id),
    index
  }));
  const laneIndex = new Map(lanes.map((lane) => [lane.id, lane]));
  const stepIndex = new Map(plan.steps.map((step) => [step.step_id, step]));
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
  const nodes = plan.steps.map((step) => {
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
  const edges = plan.steps.flatMap(
    (step) => step.depends_on.map((dependency) => ({
      from_step_id: dependency,
      to_step_id: step.step_id,
      state: edgeStateForStep(step)
    }))
  );
  return { lanes, nodes, edges };
}
function buildApprovalQueue(plan, instanceIndex, blueprintIndex) {
  if (!plan) return [];
  return plan.steps.filter((step) => step.status === "awaiting_approval").map((step) => {
    const approverBlueprint = step.approval_required_by ? blueprintForInstance(step.approval_required_by, instanceIndex, blueprintIndex) : null;
    const approverAuthority = approverBlueprint?.ui_profile.authority_level ?? 0;
    return {
      plan_id: plan.plan_id,
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
function buildMeetingView(runtime, plan, instances, instanceIndex, blueprintIndex) {
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
  if (plan && includeAssignedAgents) {
    for (const step of plan.steps) {
      if (!isStepActive(step) || !step.assigned_to) continue;
      participants.set(step.assigned_to, "step");
    }
  }
  if (plan && includeApprovers) {
    for (const step of plan.steps) {
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
  const activePlan2 = pickActivePlan(plans);
  const clusters = buildOrgClusters(bundle2.instances, blueprintIndex);
  const roleToCluster = /* @__PURE__ */ new Map();
  for (const cluster of clusters) {
    for (const roleLabel of cluster.role_labels) {
      roleToCluster.set(roleLabel, cluster.id);
    }
  }
  return {
    activePlan: activePlan2,
    org: {
      clusters,
      edges: buildOrgEdges(bundle2.runtime, clusters, roleToCluster)
    },
    execution: buildExecutionGraph(activePlan2, instanceIndex, blueprintIndex),
    approvalQueue: buildApprovalQueue(activePlan2, instanceIndex, blueprintIndex),
    meeting: buildMeetingView(
      bundle2.runtime,
      activePlan2,
      bundle2.instances,
      instanceIndex,
      blueprintIndex
    )
  };
}

// src/lib/runtimePlan.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
var bundle = {
  runtime: {
    runtime_id: "runtime-phase3",
    project_id: "project-phase3",
    company_name: "Adaptive Runtime",
    org_graph: {
      zones: {
        strategy_hub: { label: "Strategy Hub", accent_color: "#14B8A6", row: 0, col: 3 }
      },
      reporting_lines: [
        { from: "ceo", to: "pm", label: "Direction" },
        { from: "pm", to: "development_team", label: "Delivery" }
      ]
    },
    meeting_protocol: {
      default_roles: ["ceo", "pm"],
      include_assigned_agents: true,
      include_approvers: true,
      layout: "briefing"
    },
    approval_graph: {
      escalation_roles: ["ceo"]
    },
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    agent_instance_ids: ["inst-ceo", "inst-pm", "inst-dev", "inst-design"],
    created_at: "2026-03-26T00:00:00.000Z",
    updated_at: "2026-03-26T00:00:00.000Z"
  },
  blueprints: [
    {
      id: "bp-ceo",
      name: "CEO",
      role_label: "ceo",
      capabilities: ["strategy", "approval"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "CEO",
        title: "CEO",
        avatar_style: "pixel",
        accent_color: "#8B5CF6",
        icon: "Crown",
        home_zone: "ceo_office",
        team_affinity: "executive_team",
        authority_level: 10,
        capability_tags: ["strategy"],
        primary_widgets: ["kpi", "approval_queue"],
        secondary_widgets: ["timeline"],
        focus_mode: "strategy",
        meeting_behavior: "chair"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: ""
    },
    {
      id: "bp-pm",
      name: "PM",
      role_label: "pm",
      capabilities: ["planning", "coordination"],
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
        primary_widgets: ["kanban", "execution_graph"],
        secondary_widgets: ["timeline"],
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
    },
    {
      id: "bp-design",
      name: "Designer",
      role_label: "designer",
      capabilities: ["design", "review"],
      prompt_bundle_ref: null,
      skill_bundle_refs: [],
      tool_policy: {},
      permission_policy: {},
      memory_policy: {},
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Designer",
        title: "Designer",
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
        meeting_behavior: "observe"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "",
      updated_at: ""
    }
  ],
  instances: [
    {
      instance_id: "inst-ceo",
      blueprint_id: "bp-ceo",
      project_id: "project-phase3",
      runtime_status: "working",
      assigned_team: "executive_team",
      current_tasks: ["Approve release"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    },
    {
      instance_id: "inst-pm",
      blueprint_id: "bp-pm",
      project_id: "project-phase3",
      runtime_status: "working",
      assigned_team: "executive_team",
      current_tasks: ["Coordinate launch"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    },
    {
      instance_id: "inst-dev",
      blueprint_id: "bp-dev",
      project_id: "project-phase3",
      runtime_status: "waiting_approval",
      assigned_team: "development_team",
      current_tasks: ["Implement approval UI"],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    },
    {
      instance_id: "inst-design",
      blueprint_id: "bp-design",
      project_id: "project-phase3",
      runtime_status: "idle",
      assigned_team: "creative_team",
      current_tasks: [],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "",
      updated_at: ""
    }
  ]
};
var completedPlan = {
  plan_id: "plan-completed",
  runtime_id: "runtime-phase3",
  goal: "Archive prior sprint",
  created_by: "inst-pm",
  status: "completed",
  created_at: "2026-03-25T00:00:00.000Z",
  updated_at: "2026-03-25T00:00:00.000Z",
  steps: [
    {
      step_id: "old-1",
      label: "Archive",
      description: "Archive old sprint board",
      assigned_to: "inst-pm",
      depends_on: [],
      approval_required_by: null,
      status: "completed",
      input: {},
      output: {},
      started_at: null,
      completed_at: null
    }
  ]
};
var activePlan = {
  plan_id: "plan-active",
  runtime_id: "runtime-phase3",
  goal: "Ship adaptive phase three",
  created_by: "inst-pm",
  status: "paused",
  created_at: "2026-03-26T00:00:00.000Z",
  updated_at: "2026-03-26T00:00:00.000Z",
  steps: [
    {
      step_id: "step-1",
      label: "Frame scope",
      description: "Break work into lanes",
      assigned_to: "inst-pm",
      depends_on: [],
      approval_required_by: null,
      status: "completed",
      input: {},
      output: {},
      started_at: null,
      completed_at: null
    },
    {
      step_id: "step-2",
      label: "Implement UI",
      description: "Ship runtime-aware widgets",
      assigned_to: "inst-dev",
      depends_on: ["step-1"],
      approval_required_by: "inst-ceo",
      status: "awaiting_approval",
      input: {},
      output: {},
      started_at: null,
      completed_at: null
    },
    {
      step_id: "step-3",
      label: "Polish motion",
      description: "Finalize execution overlay",
      assigned_to: "inst-design",
      depends_on: ["step-2"],
      approval_required_by: null,
      status: "blocked",
      input: {},
      output: {},
      started_at: null,
      completed_at: null
    }
  ]
};
var view = buildRuntimePlanView(bundle, [completedPlan, activePlan]);
assert(view.activePlan?.plan_id === "plan-active", "paused/active plan should be selected over completed plans");
assert(view.approvalQueue.length === 1, "awaiting approval step should create one approval item");
assert(view.approvalQueue[0]?.step_id === "step-2", "approval queue should reference the awaiting approval step");
assert(view.approvalQueue[0]?.approver_role_label === "ceo", "approval queue should resolve approver role");
assert(view.meeting.participant_ids.includes("inst-ceo"), "meeting should include default executive approvers");
assert(view.meeting.participant_ids.includes("inst-pm"), "meeting should include default planning role");
assert(view.meeting.participant_ids.includes("inst-dev"), "meeting should include assigned runtime agent");
assert(!view.meeting.participant_ids.includes("inst-design"), "blocked downstream contributors should not join briefing by default");
assert(view.execution.nodes.length === 3, "execution view should include every step node");
assert(view.execution.edges.length === 2, "execution view should include dependency edges");
assert(view.org.clusters.some((cluster) => cluster.id === "executive_team"), "org view should cluster agents by team");
assert(view.org.edges.some((edge) => edge.label === "Delivery"), "org view should preserve reporting lines");
console.log("runtimePlan tests passed");
