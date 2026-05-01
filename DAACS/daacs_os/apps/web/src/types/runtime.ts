export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WidgetGroup {
  id: string;
  label: string;
  widgets: string[];
}

export interface DashboardSchema {
  summary: JsonValue;
  widget_groups: WidgetGroup[];
  priority_panels: string[];
  actions: string[];
  alerts: string[];
  logs: string[];
}

export interface UiProfile {
  display_name: string;
  title: string;
  avatar_style: string;
  accent_color: string;
  icon: string;
  home_zone: string;
  team_affinity: string;
  authority_level: number;
  capability_tags: string[];
  primary_widgets: string[];
  secondary_widgets: string[];
  focus_mode: string;
  meeting_behavior: string;
}

export interface ToolPolicyConfig {
  allowed_tools?: string[];
  connectors?: string[];
}

export interface ApprovalPolicyConfig {
  mode?: string;
  external_actions_require_approval?: boolean;
  default_approver?: string | null;
}

export interface InteractionStyleConfig {
  movement_mode?: string;
  speech_mode?: string;
  return_mode?: string;
}

export interface CollaborationPolicyConfig {
  workspace_mode?: string;
  interaction_style?: InteractionStyleConfig;
}

export interface BlueprintInput {
  name: string;
  role_label: string;
  capabilities?: string[];
  prompt_bundle_ref?: string | null;
  skill_bundle_refs?: string[];
  tool_policy?: JsonValue;
  permission_policy?: JsonValue;
  memory_policy?: JsonValue;
  collaboration_policy?: JsonValue;
  approval_policy?: JsonValue;
  ui_profile?: Partial<UiProfile>;
}

export interface AgentBlueprint {
  id: string;
  name: string;
  role_label: string;
  capabilities: string[];
  prompt_bundle_ref: string | null;
  skill_bundle_refs: string[];
  tool_policy: JsonValue;
  permission_policy: JsonValue;
  memory_policy: JsonValue;
  collaboration_policy: JsonValue;
  approval_policy: JsonValue;
  ui_profile: UiProfile;
  is_builtin: boolean;
  owner_user_id: string;
  created_at: string;
  updated_at: string;
}

export type RuntimeStatus =
  | "idle"
  | "planning"
  | "working"
  | "waiting_approval"
  | "completed"
  | "failed";

export interface AgentInstance {
  instance_id: string;
  blueprint_id: string;
  project_id: string;
  runtime_status: RuntimeStatus;
  assigned_team: string | null;
  current_tasks: string[];
  context_window_state: JsonValue;
  memory_bindings: JsonValue;
  live_metrics: JsonValue;
  created_at: string;
  updated_at: string;
}

export type ExecutionMode = "manual" | "assisted" | "autonomous";

export interface CompanyRuntime {
  runtime_id: string;
  project_id: string;
  company_name: string;
  org_graph: JsonValue;
  agent_instance_ids: string[];
  meeting_protocol: JsonValue;
  approval_graph: JsonValue;
  shared_boards: JsonValue;
  execution_mode: ExecutionMode;
  owner_ops_state: JsonValue;
  created_at: string;
  updated_at: string;
}

export interface RuntimeBundleResponse {
  runtime: CompanyRuntime;
  instances: AgentInstance[];
  blueprints: AgentBlueprint[];
}

export type PlanStatus = "draft" | "active" | "paused" | "completed" | "failed";

export type StepStatus =
  | "pending"
  | "blocked"
  | "in_progress"
  | "awaiting_approval"
  | "approved"
  | "completed"
  | "failed"
  | "skipped";

export interface ExecutionStep {
  step_id: string;
  label: string;
  description: string;
  assigned_to: string | null;
  depends_on: string[];
  approval_required_by: string | null;
  status: StepStatus;
  required_capabilities?: string[];
  selection_reason?: string | null;
  approval_reason?: string | null;
  planner_notes?: string | null;
  parallel_group?: string | null;
  input: JsonValue;
  output: JsonValue;
  started_at: string | null;
  completed_at: string | null;
}

export interface ExecutionPlan {
  plan_id: string;
  runtime_id: string;
  goal: string;
  created_by: string;
  planner_version?: string;
  planning_mode?: string;
  plan_rationale?: string;
  revision?: number;
  steps: ExecutionStep[];
  status: PlanStatus;
  created_at: string;
  updated_at: string;
}

export type ExecutionIntentKind =
  | "open_pull_request"
  | "deploy_release"
  | "publish_content"
  | "launch_campaign"
  | "publish_asset"
  | "run_ops_action"
  | "submit_budget_update";

export type ExecutionIntentStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed";

export interface CreateExecutionIntentInput {
  kind: ExecutionIntentKind;
  title: string;
  description: string;
  target: string;
  connector_id: string;
  payload: JsonValue;
}

export interface ExecutionIntent {
  intent_id: string;
  project_id: string;
  runtime_id?: string | null;
  created_by?: string | null;
  agent_id: string;
  agent_role: string;
  kind: ExecutionIntentKind;
  title: string;
  description: string;
  target: string;
  connector_id: string;
  payload: JsonValue;
  status: ExecutionIntentStatus;
  requires_approval: boolean;
  created_at: string;
  updated_at?: string;
  approved_at?: string | null;
  resolved_at?: string | null;
  note?: string | null;
  result_summary?: string | null;
  result_payload?: JsonValue | null;
}

export interface StepListResponse {
  plan_id: string;
  steps: ExecutionStep[];
}

export type RuntimeEventType =
  | "plan_created"
  | "step_status_changed"
  | "approval_requested"
  | "approval_granted"
  | "plan_started"
  | "plan_completed"
  | "plan_failed"
  | "execution_intent_created"
  | "execution_intent_status_changed"
  | "connector_execution_started"
  | "connector_execution_completed"
  | "connector_execution_failed"
  | "agent_status_changed"
  | "runtime_updated"
  // ── 에이전트 활동 전용 이벤트 (Step 3-4) ──
  | "agent_working"
  | "agent_idle"
  | "agent_handoff"
  | "agent_reviewing";

export interface RuntimeEvent {
  event_id: string;
  event_type: RuntimeEventType;
  payload: JsonValue;
  project_id: string;
  runtime_id?: string | null;
  plan_id?: string | null;
  step_id?: string | null;
  actor_id?: string | null;
  sequence_no?: number;
  timestamp: string | number;
  created_at?: string;
}

export interface SkillBundleInfo {
  description: string;
  core_count: number;
  support_count: number;
  core_skills: string[];
  support_skills: string[];
}

export type SkillBundleSummary = Record<string, SkillBundleInfo>;

export interface SkillMeta {
  id: string;
  description: string;
  category?: string | null;
  displayName?: string | null;
}
