import { findAgentMetadataByIdSync, findAgentMetadataByOfficeRoleSync } from "../lib/agentsMetadata";

export type BuiltinAgentRole =
  | "ceo"
  | "pm"
  | "developer"
  | "developer_front"
  | "developer_back"
  | "reviewer"
  | "verifier"
  | "devops"
  | "marketer"
  | "designer"
  | "cfo";

export type AgentRole = BuiltinAgentRole | (string & {});

export const AGENT_ROLES: BuiltinAgentRole[] = [
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
  "cfo",
];

export type AgentStatus =
  | "idle"
  | "walking"
  | "working"
  | "reviewing"
  | "meeting"
  | "error"
  | "celebrating";

export interface AgentMeta {
  name: string;
  title: string;
  color: string;
  icon: string;
}

export interface AgentUiProfile {
  display_name?: string;
  title?: string;
  accent_color?: string;
  icon?: string;
  home_zone?: string;
  team_affinity?: string;
  authority_level?: number;
  capability_tags?: string[];
  primary_widgets?: string[];
  secondary_widgets?: string[];
  focus_mode?: string;
  meeting_behavior?: string;
}

export interface AgentInteractionStyle {
  movement_mode: string;
  speech_mode: string;
  return_mode: string;
}

export interface AgentOperatingProfile {
  workspace_mode: string;
  tool_connectors: string[];
  allowed_tools: string[];
  approval_mode: string;
  external_actions_require_approval: boolean;
  default_approver: string | null;
  interaction_style: AgentInteractionStyle;
}

export type SharedAgentSyncMode = "linked" | "detached";

export interface SharedAgentReference {
  global_agent_id: string;
  source_project_id?: string | null;
  sync_mode: SharedAgentSyncMode;
  imported_at: string;
}

export const AGENT_META: Record<BuiltinAgentRole, AgentMeta> = {
  ceo: { name: "CEO", title: "CEO", color: "#8B5CF6", icon: "Crown" },
  pm: { name: "PM", title: "프로젝트 매니저", color: "#6366F1", icon: "ClipboardList" },
  developer: { name: "개발자", title: "Developer", color: "#3B82F6", icon: "Code" },
  developer_front: { name: "개발자 Front", title: "프론트엔드 개발자", color: "#3B82F6", icon: "Code" },
  developer_back: { name: "개발자 Back", title: "백엔드 개발자", color: "#EF4444", icon: "Search" },
  reviewer: { name: "리뷰어", title: "Reviewer", color: "#EF4444", icon: "Search" },
  verifier: { name: "검증관", title: "Verifier", color: "#14B8A6", icon: "ShieldCheck" },
  devops: { name: "데브옵스", title: "데브옵스 엔지니어", color: "#10B981", icon: "Terminal" },
  marketer: { name: "마케터", title: "마케터", color: "#EC4899", icon: "Megaphone" },
  designer: { name: "디자이너", title: "UI/UX 디자이너", color: "#F97316", icon: "Palette" },
  cfo: { name: "CFO", title: "재무", color: "#EAB308", icon: "Calculator" },
};

export function isBuiltinAgentRole(value: string | null | undefined): value is BuiltinAgentRole {
  return typeof value === "string" && AGENT_ROLES.includes(value as BuiltinAgentRole);
}

function humanizeRoleLabel(role: AgentRole): string {
  return role
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getAgentMeta(
  role: AgentRole,
  overrides?: Partial<AgentMeta> | null,
): AgentMeta {
  const fallback = AGENT_META[isBuiltinAgentRole(role) ? role : "developer_front"];
  const metadata = findAgentMetadataByIdSync(String(role)) ?? findAgentMetadataByOfficeRoleSync(role);
  const inferredName = humanizeRoleLabel(role);
  const metadataName = metadata?.display_name?.trim();
  const metadataTitle = metadata?.summary?.trim();
  const overrideName = overrides?.name?.trim();
  const overrideTitle = overrides?.title?.trim();
  return {
    name:
      overrideName ||
      metadataName ||
      (isBuiltinAgentRole(role) ? fallback.name : inferredName),
    title:
      overrideTitle ||
      metadataTitle ||
      (isBuiltinAgentRole(role) ? fallback.title : inferredName),
    color: overrides?.color?.trim() || fallback.color,
    icon: overrides?.icon?.trim() || fallback.icon,
  };
}

export interface Point {
  x: number;
  y: number;
}

export interface Agent {
  id: string;
  role: AgentRole;
  name: string;
  position: Point;
  path: Point[];
  status: AgentStatus;
  blueprintId?: string;
  instanceId?: string;
  promptKey?: string;
  capabilities?: string[];
  skillBundleRefs?: string[];
  assignedTeam?: string | null;
  runtimeStatus?: string;
  uiProfile?: AgentUiProfile;
  operatingProfile?: AgentOperatingProfile;
  meta?: AgentMeta;
  message?: string;
  currentTask?: string;
  sharedAgentRef?: SharedAgentReference | null;
}

export interface AgentEvent {
  type: string;
  agent_role: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export type MessageType =
  | "task"
  | "response"
  | "info"
  | "error"
  | "request"
  | "reject"
  | "done"
  | "command"
  | "status_update";

export interface Notification {
  id: string;
  type: "info" | "success" | "warning" | "error";
  message: string;
  agentRole?: AgentRole;
  action?: "open_goal_recovery";
  actionLabel?: string;
  timestamp: number;
}

export interface Command {
  id: string;
  agentRole: AgentRole;
  agentId?: string;
  message: string;
  timestamp: number;
  status: "pending" | "processing" | "completed" | "failed";
  response?: string;
}

export interface WorkflowStep {
  from: AgentRole;
  to: AgentRole;
  task: string;
}

export interface ActiveWorkflow {
  workflowId?: string;
  name: string;
  displayName: string;
  steps: WorkflowStep[];
  currentStep: number;
  status: "running" | "completed" | "failed";
}

export type GameState = "LOBBY" | "OFFICE" | "MEETING";

export type FurnitureType =
  | "desk"
  | "server"
  | "meeting"
  | "plant"
  | "whiteboard"
  | "vending"
  | "safe"
  | "bulletin"
  | "empty";

export interface FurnitureItem {
  id: string;
  type: FurnitureType;
  position: Point;
  zone: number;
}

export interface Room {
  id: number;
  name: string;
  row: number;
  col: number;
}

export interface AgentStateResponse {
  role: string;
  status: string;
  current_task: string | null;
  message: string | null;
  position: { x: number; y: number };
  skills?: string[];
}

export interface ClockInResponse {
  project_id: string;
  agents: AgentStateResponse[];
}

export interface CommandResponse {
  status: string;
  agent_role: string;
  message: string;
}

export interface IdeFileEntry {
  path: string;
  size_bytes: number;
  modified_at: string;
  language: string;
}

export interface IdeTreeResponse {
  project_id: string;
  exists: boolean;
  root: string;
  files: IdeFileEntry[];
  read_only: boolean;
}

export interface IdeFileResponse {
  project_id: string;
  path: string;
  language: string;
  content: string;
  read_only: boolean;
}

export type WorkLogEntryType =
  | "chunk"
  | "tool_call"
  | "tool_result"
  | "session_start"
  | "done"
  | "error"
  | "message_sent"
  | "message_received";

export interface WorkLogEntry {
  id: string;
  type: WorkLogEntryType;
  content: string;
  timestamp: number;
  toolName?: string;
}

export type TaskStatus = "queued" | "running" | "completed" | "failed";

export interface TaskRecord {
  id: string;
  instruction: string;
  status: TaskStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  resultSummary?: string;
  result?: Record<string, unknown>;
  error?: string;
}

export interface FileChangeRecord {
  id: string;
  agentRole: AgentRole;
  filePath: string;
  action: "create" | "edit" | "read";
  toolName: string;
  timestamp: number;
}

export interface AgentErrorRecord {
  id: string;
  agentRole: AgentRole;
  error: string;
  timestamp: number;
}

export interface AgentMessageRecord {
  id: string;
  from: AgentRole;
  to: AgentRole;
  fromAgentId?: string;
  toAgentId?: string;
  content: string;
  direction: "sent" | "received";
  timestamp: number;
}

export interface PendingTransfer {
  id: string;
  from: AgentRole;
  to: AgentRole;
  summary: string;
  timestamp: number;
}

export type CollaborationVisitStage = "departing" | "speaking" | "returning";

export interface CollaborationVisit {
  id: string;
  from: AgentRole;
  to: AgentRole;
  summary: string;
  stage: CollaborationVisitStage;
  timestamp: number;
}

export type AgentTeam =
  | "development_team"
  | "review_team"
  | "marketing_team"
  | "operations_team"
  | "executive_team";

export interface AgentTeamInfo {
  team: AgentTeam;
  display_name: string;
  description: string;
  roles: AgentRole[];
}

export interface TeamTaskResponse {
  status: string;
  project_id: string;
  team: AgentTeam;
  task_ids: Record<string, string>;
  agent_count: number;
}

export interface TeamParallelResponse {
  status: string;
  project_id: string;
  submitted: Record<
    string,
    {
      instruction: string;
      task_ids: Record<string, string>;
      agent_count: number;
    }
  >;
  errors: Array<Record<string, string>>;
}

export interface CollaborationContribution {
  team?: string;
  agent_role?: string;
  task_id?: string | null;
  status?: string;
  summary?: string;
  open_questions?: string[];
  next_actions?: string[];
  details?: Record<string, unknown>;
}

export interface CollaborationArtifact {
  session_id: string;
  round_id: string;
  status?: string;
  artifact_type?: string;
  artifact_workspace?: string;
  workspace_path?: string;
  output_path?: string;
  decision: string;
  refined_goal?: string;
  acceptance_criteria?: string[];
  deliverables?: string[];
  project_fit_summary?: string;
  open_questions: string[];
  next_actions: string[];
  contributions: CollaborationContribution[];
}
