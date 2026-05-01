import type {
  AgentBlueprint,
  AgentInstance,
  CompanyRuntime,
  ExecutionPlan,
  ExecutionStep,
  RuntimeBundleResponse,
  StepStatus,
} from "../types/runtime";

type JsonRecord = Record<string, unknown>;

export type OrgCanvasCluster = {
  id: string;
  label: string;
  zone_id: string;
  authority_level: number;
  member_instance_ids: string[];
  role_labels: string[];
};

export type OrgCanvasEdge = {
  from: string;
  to: string;
  label: string;
};

export type ExecutionLane = {
  id: string;
  label: string;
  index: number;
};

export type ExecutionGraphNode = {
  step_id: string;
  label: string;
  status: StepStatus;
  lane_id: string;
  lane_label: string;
  depth: number;
  x: number;
  y: number;
  assigned_to: string | null;
  assigned_role_label: string | null;
  approval_required_by: string | null;
  approver_role_label: string | null;
};

export type ExecutionGraphEdge = {
  from_step_id: string;
  to_step_id: string;
  state: "blocked" | "ready" | "active" | "complete";
};

export type ApprovalQueueItem = {
  plan_id: string;
  step_id: string;
  label: string;
  description: string;
  assigned_to: string | null;
  assigned_role_label: string | null;
  approver_instance_id: string | null;
  approver_role_label: string | null;
  priority: "high" | "medium" | "low";
};

export type MeetingParticipant = {
  instance_id: string;
  role_label: string;
  reason: string;
  seat_order: number;
};

export type RuntimePlanView = {
  activePlan: ExecutionPlan | null;
  org: {
    clusters: OrgCanvasCluster[];
    edges: OrgCanvasEdge[];
  };
  execution: {
    lanes: ExecutionLane[];
    nodes: ExecutionGraphNode[];
    edges: ExecutionGraphEdge[];
  };
  approvalQueue: ApprovalQueueItem[];
  meeting: {
    layout: "roundtable" | "briefing";
    participant_ids: string[];
    participants: MeetingParticipant[];
  };
};

const PLAN_STATUS_RANK: Record<string, number> = {
  active: 0,
  paused: 1,
  draft: 2,
  completed: 3,
  failed: 4,
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
    : [];
}

function humanize(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseDateScore(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roleLabelForInstance(
  instanceId: string | null | undefined,
  instanceIndex: Map<string, AgentInstance>,
  blueprintIndex: Map<string, AgentBlueprint>,
): string | null {
  if (!instanceId) return null;
  const instance = instanceIndex.get(instanceId);
  if (!instance) return null;
  return blueprintIndex.get(instance.blueprint_id)?.role_label ?? null;
}

function blueprintForInstance(
  instanceId: string,
  instanceIndex: Map<string, AgentInstance>,
  blueprintIndex: Map<string, AgentBlueprint>,
): AgentBlueprint | null {
  const instance = instanceIndex.get(instanceId);
  if (!instance) return null;
  return blueprintIndex.get(instance.blueprint_id) ?? null;
}

function clusterIdForReference(
  reference: string,
  clusters: OrgCanvasCluster[],
  roleToCluster: Map<string, string>,
): string | null {
  if (clusters.some((cluster) => cluster.id === reference)) return reference;
  if (roleToCluster.has(reference)) return roleToCluster.get(reference) ?? null;
  return null;
}

function isStepActive(step: ExecutionStep): boolean {
  return (
    step.status === "in_progress" ||
    step.status === "awaiting_approval" ||
    step.status === "approved"
  );
}

function edgeStateForStep(step: ExecutionStep): ExecutionGraphEdge["state"] {
  if (step.status === "completed" || step.status === "approved" || step.status === "skipped") {
    return "complete";
  }
  if (step.status === "in_progress" || step.status === "awaiting_approval") {
    return "active";
  }
  if (step.status === "pending") return "ready";
  return "blocked";
}

export function pickActivePlan(plans: ExecutionPlan[]): ExecutionPlan | null {
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

function buildOrgClusters(
  instances: AgentInstance[],
  blueprintIndex: Map<string, AgentBlueprint>,
): OrgCanvasCluster[] {
  const grouped = new Map<
    string,
    {
      zone_id: string;
      authority_level: number;
      member_instance_ids: string[];
      role_labels: string[];
    }
  >();

  for (const instance of instances) {
    const blueprint = blueprintIndex.get(instance.blueprint_id);
    const teamId =
      blueprint?.ui_profile.team_affinity ||
      instance.assigned_team ||
      "runtime_team";
    const zoneId = blueprint?.ui_profile.home_zone || "lobby";
    const authority = blueprint?.ui_profile.authority_level ?? 0;
    const current = grouped.get(teamId) ?? {
      zone_id: zoneId,
      authority_level: authority,
      member_instance_ids: [],
      role_labels: [],
    };
    current.zone_id = current.zone_id || zoneId;
    current.authority_level = Math.max(current.authority_level, authority);
    current.member_instance_ids.push(instance.instance_id);
    if (blueprint?.role_label) current.role_labels.push(blueprint.role_label);
    grouped.set(teamId, current);
  }

  return [...grouped.entries()]
    .map(([id, group]) => ({
      id,
      label: humanize(id),
      zone_id: group.zone_id,
      authority_level: group.authority_level,
      member_instance_ids: group.member_instance_ids,
      role_labels: [...new Set(group.role_labels)],
    }))
    .sort((left, right) => {
      if (left.authority_level !== right.authority_level) {
        return right.authority_level - left.authority_level;
      }
      return left.label.localeCompare(right.label);
    });
}

function buildOrgEdges(
  runtime: CompanyRuntime,
  clusters: OrgCanvasCluster[],
  roleToCluster: Map<string, string>,
): OrgCanvasEdge[] {
  const graph = asRecord(runtime.org_graph);
  const reportingLines = Array.isArray(graph.reporting_lines)
    ? graph.reporting_lines
    : [];

  const explicit = reportingLines
    .map((row) => {
      const source = asRecord(row);
      const from = typeof source.from === "string" ? source.from : "";
      const to = typeof source.to === "string" ? source.to : "";
      const label = typeof source.label === "string" ? source.label : "Reports";
      const fromCluster = clusterIdForReference(from, clusters, roleToCluster);
      const toCluster = clusterIdForReference(to, clusters, roleToCluster);
      if (!fromCluster || !toCluster || fromCluster === toCluster) return null;
      return { from: fromCluster, to: toCluster, label };
    })
    .filter((edge): edge is OrgCanvasEdge => edge !== null);

  if (explicit.length > 0) return explicit;

  const executive = clusters.find((cluster) => cluster.id === "executive_team");
  if (!executive) return [];

  return clusters
    .filter((cluster) => cluster.id !== executive.id)
    .map((cluster) => ({
      from: executive.id,
      to: cluster.id,
      label: "Coordination",
    }));
}

function buildExecutionGraph(
  plan: ExecutionPlan | null,
  instanceIndex: Map<string, AgentInstance>,
  blueprintIndex: Map<string, AgentBlueprint>,
): RuntimePlanView["execution"] {
  if (!plan) {
    return { lanes: [], nodes: [], edges: [] };
  }

  const laneIds = [...new Set(plan.steps.map((step) => {
    const blueprint = step.assigned_to
      ? blueprintForInstance(step.assigned_to, instanceIndex, blueprintIndex)
      : null;
    return blueprint?.ui_profile.team_affinity || "unassigned";
  }))];

  const lanes = laneIds.map((id, index) => ({
    id,
    label: humanize(id),
    index,
  }));
  const laneIndex = new Map(lanes.map((lane) => [lane.id, lane]));
  const stepIndex = new Map(plan.steps.map((step) => [step.step_id, step]));
  const depthMemo = new Map<string, number>();

  const resolveDepth = (stepId: string): number => {
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
    const blueprint = step.assigned_to
      ? blueprintForInstance(step.assigned_to, instanceIndex, blueprintIndex)
      : null;
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
        blueprintIndex,
      ),
    };
  });

  const edges = plan.steps.flatMap((step) =>
    step.depends_on.map((dependency) => ({
      from_step_id: dependency,
      to_step_id: step.step_id,
      state: edgeStateForStep(step),
    })),
  );

  return { lanes, nodes, edges };
}

function buildApprovalQueue(
  plan: ExecutionPlan | null,
  instanceIndex: Map<string, AgentInstance>,
  blueprintIndex: Map<string, AgentBlueprint>,
): ApprovalQueueItem[] {
  if (!plan) return [];

  return plan.steps
    .filter((step) => step.status === "awaiting_approval")
    .map((step) => {
      const approverBlueprint = step.approval_required_by
        ? blueprintForInstance(step.approval_required_by, instanceIndex, blueprintIndex)
        : null;
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
          blueprintIndex,
        ),
        priority: approverAuthority >= 9 ? "high" : approverAuthority >= 6 ? "medium" : "low",
      };
    });
}

function buildMeetingView(
  runtime: CompanyRuntime,
  plan: ExecutionPlan | null,
  instances: AgentInstance[],
  instanceIndex: Map<string, AgentInstance>,
  blueprintIndex: Map<string, AgentBlueprint>,
): RuntimePlanView["meeting"] {
  const protocol = asRecord(runtime.meeting_protocol);
  const participants = new Map<string, string>();

  const includeRole = (roleLabel: string, reason: string) => {
    for (const instance of instances) {
      const blueprint = blueprintIndex.get(instance.blueprint_id);
      if (blueprint?.role_label === roleLabel) {
        participants.set(instance.instance_id, reason);
      }
    }
  };

  for (const roleLabel of [
    ...asStringArray(protocol.default_roles),
    ...asStringArray(protocol.participant_roles),
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

  const layout =
    protocol.layout === "briefing" ? "briefing" : "roundtable";

  const rows = [...participants.entries()]
    .map(([instanceId, reason]) => {
      const blueprint = blueprintForInstance(instanceId, instanceIndex, blueprintIndex);
      return {
        instance_id: instanceId,
        role_label: blueprint?.role_label ?? instanceId,
        reason,
        seat_order: blueprint?.ui_profile.authority_level
          ? -blueprint.ui_profile.authority_level
          : 0,
      };
    })
    .sort((left, right) => {
      if (left.seat_order !== right.seat_order) return left.seat_order - right.seat_order;
      return left.role_label.localeCompare(right.role_label);
    })
    .map((participant, index) => ({
      ...participant,
      seat_order: index,
    }));

  return {
    layout,
    participant_ids: rows.map((participant) => participant.instance_id),
    participants: rows,
  };
}

export function buildRuntimePlanView(
  bundle: RuntimeBundleResponse,
  plans: ExecutionPlan[],
): RuntimePlanView {
  const blueprintIndex = new Map(bundle.blueprints.map((blueprint) => [blueprint.id, blueprint]));
  const instanceIndex = new Map(bundle.instances.map((instance) => [instance.instance_id, instance]));
  const activePlan = pickActivePlan(plans);
  const clusters = buildOrgClusters(bundle.instances, blueprintIndex);
  const roleToCluster = new Map<string, string>();

  for (const cluster of clusters) {
    for (const roleLabel of cluster.role_labels) {
      roleToCluster.set(roleLabel, cluster.id);
    }
  }

  return {
    activePlan,
    org: {
      clusters,
      edges: buildOrgEdges(bundle.runtime, clusters, roleToCluster),
    },
    execution: buildExecutionGraph(activePlan, instanceIndex, blueprintIndex),
    approvalQueue: buildApprovalQueue(activePlan, instanceIndex, blueprintIndex),
    meeting: buildMeetingView(
      bundle.runtime,
      activePlan,
      bundle.instances,
      instanceIndex,
      blueprintIndex,
    ),
  };
}
