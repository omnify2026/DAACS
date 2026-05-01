import type {
  AgentTeam,
  AgentTeamInfo,
  AgentRole,
  AgentStateResponse,
  TaskRecord,
  ClockInResponse,
  CommandResponse,
  IdeFileResponse,
  IdeTreeResponse,
  TeamParallelResponse,
  TeamTaskResponse,
} from "../types/agent";
import { requestJson } from "./httpClient";
import * as workflowApi from "./workflowApi";
import * as factoryApi from "./factoryApi";
import * as collaborationApi from "./collaborationApi";

export type BillingTrack = "byok" | "project";
export const SHIPPED_AUTH_BILLING_TRACK: Extract<BillingTrack, "project"> = "project";

export interface AuthResponse {
  user: {
    id: string;
    email: string;
    plan: string;
    agent_slots: number;
    custom_agent_count: number;
    billing_track: BillingTrack;
    byok_has_claude_key: boolean;
    byok_has_openai_key: boolean;
  };
  memberships: ProjectMembership[];
  access_token: string;
}

export interface ByokSavePayload {
  byok_claude_key?: string;
  byok_openai_key?: string;
}

export interface ByokStatusResponse {
  billing_track: BillingTrack;
  byok_has_claude_key: boolean;
  byok_has_openai_key: boolean;
}

export interface ByokSaveResponse extends ByokStatusResponse {
  status: string;
  updated: {
    byok_claude_key: boolean;
    byok_openai_key: boolean;
  };
}

export interface ProjectMembership {
  project_id: string;
  project_name: string;
  role: string;
  is_owner: boolean;
}

export interface AgentDashboardTab {
  id: string;
  label: string;
  data: Record<string, unknown>;
}

export interface AgentDashboardResponse {
  role: AgentRole;
  display_name: string;
  status: string;
  tabs: AgentDashboardTab[];
  updated_at: string;
}

export interface OwnerDecisionPayload {
  item_id: string;
  title: string;
  source: string;
  action: "approved" | "hold" | "rejected";
  target_type?: "workflow" | "team_run" | "incident" | "execution_intent";
  target_id?: string;
  detail?: string;
  workflow_id?: string;
}

export interface OwnerDecisionRecord extends OwnerDecisionPayload {
  project_id: string;
  target_type?: "workflow" | "team_run" | "incident" | "execution_intent";
  target_id?: string;
  workflow_id?: string;
  applied_effect?: string;
  decided_at: string;
  decided_by: string;
}

export interface OwnerOpsStatusResponse {
  project_id: string;
  team_runs: Record<string, string>;
  incidents: Record<string, string>;
  decisions_count: number;
}

export async function register(
  email: string,
  password: string,
  projectName?: string,
  billingTrack: BillingTrack = SHIPPED_AUTH_BILLING_TRACK,
): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/api/auth/register", {
    method: "POST",
    body: JSON.stringify({
      email,
      password,
      billing_track: billingTrack,
      ...(projectName ? { project_name: projectName } : {}),
    }),
  }, false);
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  }, false);
}

export async function fetchMe(): Promise<AuthResponse> {
  return requestJson<AuthResponse>("/api/auth/me", { method: "GET" }, true);
}

export async function logout(): Promise<{ status: string }> {
  return requestJson<{ status: string }>("/api/auth/logout", { method: "POST" }, true);
}

export async function saveByokKeys(payload: ByokSavePayload): Promise<ByokSaveResponse> {
  return requestJson<ByokSaveResponse>(
    "/api/auth/byok",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
    true,
  );
}

export async function fetchByokStatus(): Promise<ByokStatusResponse> {
  return requestJson<ByokStatusResponse>("/api/auth/byok", { method: "GET" }, true);
}

export async function listProjects(): Promise<ProjectMembership[]> {
  return requestJson<ProjectMembership[]>("/api/auth/projects", { method: "GET" }, true);
}

export async function createProject(projectName: string): Promise<ProjectMembership> {
  return requestJson<ProjectMembership>(
    "/api/auth/projects",
    {
      method: "POST",
      body: JSON.stringify({ project_name: projectName }),
    },
    true,
  );
}

export async function clockIn(projectId: string): Promise<ClockInResponse> {
  return requestJson<ClockInResponse>(`/api/projects/${projectId}/clock-in`, { method: "POST" }, true);
}

export async function clockOut(projectId: string): Promise<{ status: string }> {
  return requestJson<{ status: string }>(`/api/projects/${projectId}/clock-out`, { method: "POST" }, true);
}

export async function getAgents(projectId: string): Promise<AgentStateResponse[]> {
  return requestJson<AgentStateResponse[]>(`/api/agents/${projectId}`);
}

export async function getAgent(projectId: string, role: AgentRole): Promise<AgentStateResponse> {
  return requestJson<AgentStateResponse>(`/api/agents/${projectId}/${role}`);
}

function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeTaskRecord(row: Record<string, unknown>): TaskRecord {
  const statusRaw = typeof row.status === "string" ? row.status : "queued";
  const status: TaskRecord["status"] =
    statusRaw === "running" || statusRaw === "completed" || statusRaw === "failed"
      ? statusRaw
      : statusRaw === "error"
        ? "failed"
        : "queued";
  const result =
    typeof row.result === "object" && row.result ? (row.result as Record<string, unknown>) : undefined;
  const error = typeof result?.error === "string" ? result.error : undefined;
  const resultSummary =
    typeof row.result_summary === "string"
      ? row.result_summary
      : error ?? (typeof result?.output === "string" ? result.output.slice(0, 200) : undefined);

  const queuedAt = toEpochMs(row.created_at) ?? Date.now();
  const startedAt = toEpochMs(row.started_at);
  const completedAt = toEpochMs(row.completed_at);

  return {
    id: String(row.id ?? `task-${queuedAt}`),
    instruction: String(row.description ?? ""),
    status,
    queuedAt,
    startedAt,
    completedAt,
    resultSummary,
    result,
    error,
  };
}

export async function getAgentTaskHistory(
  projectId: string,
  role: AgentRole,
  agentId?: string,
  limit = 50,
): Promise<TaskRecord[]> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const qp = new URLSearchParams({ limit: String(safeLimit) });
  if (agentId) qp.set("agent_id", agentId);
  const rows = await requestJson<Array<Record<string, unknown>>>(
    `/api/agents/${projectId}/${role}/history?${qp.toString()}`,
  );
  return rows.map(normalizeTaskRecord);
}

export async function getAgentEvents(
  projectId: string,
  role: AgentRole,
  agentId?: string,
  eventType?: string,
  limit = 50,
): Promise<Array<Record<string, unknown>>> {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const qp = new URLSearchParams({ limit: String(safeLimit) });
  if (agentId) qp.set("agent_id", agentId);
  if (eventType) qp.set("event_type", eventType);
  return requestJson<Array<Record<string, unknown>>>(`/api/agents/${projectId}/${role}/events?${qp.toString()}`);
}

export async function getAgentDashboard(
  projectId: string,
  role: AgentRole,
): Promise<AgentDashboardResponse> {
  return requestJson<AgentDashboardResponse>(`/api/dashboard/${projectId}/${role}`);
}

export async function submitOwnerDecision(
  projectId: string,
  payload: OwnerDecisionPayload,
): Promise<OwnerDecisionRecord> {
  return requestJson<OwnerDecisionRecord>(`/api/ops/${projectId}/decisions`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function listOwnerDecisions(
  projectId: string,
  limit = 50,
): Promise<{ project_id: string; items: OwnerDecisionRecord[] }> {
  return requestJson<{ project_id: string; items: OwnerDecisionRecord[] }>(
    `/api/ops/${projectId}/decisions?limit=${encodeURIComponent(String(limit))}`,
  );
}

export async function getOwnerOpsStatus(
  projectId: string,
): Promise<OwnerOpsStatusResponse> {
  return requestJson<OwnerOpsStatusResponse>(`/api/ops/${projectId}/status`);
}

export async function sendCommand(
  projectId: string,
  role: AgentRole,
  message: string,
): Promise<CommandResponse> {
  return requestJson<CommandResponse>(`/api/agents/${projectId}/${role}/command`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

export async function startWorkflow(
  projectId: string,
  workflowName: string,
): Promise<{ workflow_id: string; status: string }> {
  return workflowApi.startWorkflow(projectId, workflowName);
}

export async function getWorkflows(projectId: string): Promise<Array<{ id: string; name: string; status: string }>> {
  return requestJson<Array<{ id: string; name: string; status: string }>>(`/api/workflows/${projectId}`);
}

export async function stopWorkflow(
  projectId: string,
  workflowId: string,
): Promise<{ status: string }> {
  return workflowApi.stopWorkflow(projectId, workflowId);
}

export async function startOvernightWorkflow(
  projectId: string,
  payload: workflowApi.OvernightStartPayload,
): Promise<{ status: string; run_id: string; task_id: string }> {
  return workflowApi.startOvernightWorkflow(projectId, payload);
}

export async function getOvernightWorkflowStatus(
  projectId: string,
  runId: string,
): Promise<workflowApi.OvernightStatusResponse> {
  return workflowApi.getOvernightWorkflowStatus(projectId, runId);
}

export async function stopOvernightWorkflow(
  projectId: string,
  runId: string,
): Promise<{ status: string; run_id: string }> {
  return workflowApi.stopOvernightWorkflow(projectId, runId);
}

export async function resumeOvernightWorkflow(
  projectId: string,
  runId: string,
  payload: { additional_budget_usd?: number; additional_time_minutes?: number; additional_iterations?: number },
): Promise<{ status: string; run_id: string; task_id: string }> {
  return workflowApi.resumeOvernightWorkflow(projectId, runId, payload);
}

export async function getTeams(): Promise<AgentTeamInfo[]> {
  return requestJson<AgentTeamInfo[]>("/api/teams");
}

export async function submitTeamTask(
  projectId: string,
  team: AgentTeam,
  instruction: string,
  context: Record<string, unknown> = {},
): Promise<TeamTaskResponse> {
  return workflowApi.submitTeamTask(projectId, { team, instruction, context });
}

export async function submitParallelTeamTasks(
  projectId: string,
  items: Array<{ team: AgentTeam; instruction: string; context?: Record<string, unknown> }>,
): Promise<TeamParallelResponse> {
  return workflowApi.submitParallelTeamTasks(projectId, items);
}

export async function streamAgentTask(
  projectId: string,
  role: AgentRole,
  instruction: string,
  context: Record<string, unknown> = {},
): Promise<{ status: string; agent: string; note: string }> {
  return requestJson<{ status: string; agent: string; note: string }>(`/api/agents/${projectId}/${role}/stream-task`, {
    method: "POST",
    body: JSON.stringify({ instruction, context }),
  });
}

export async function getAgentServerStatus(projectId: string): Promise<{ started: boolean; sessions?: Record<string, unknown> }> {
  return requestJson<{ started: boolean; sessions?: Record<string, unknown> }>(`/api/agents/${projectId}/server-status`);
}

export async function getIdeTree(projectId: string): Promise<IdeTreeResponse> {
  return requestJson<IdeTreeResponse>(`/api/dashboard/${projectId}/ide/tree`);
}

export async function getIdeFile(projectId: string, path: string): Promise<IdeFileResponse> {
  const qp = new URLSearchParams({ path });
  return requestJson<IdeFileResponse>(`/api/dashboard/${projectId}/ide/file?${qp.toString()}`);
}

export async function getSkillBundles(): Promise<Record<string, { core: string[]; support: string[] }>> {
  return requestJson<Record<string, { core: string[]; support: string[] }>>("/api/skills/bundles");
}

export async function getAgentSkills(
  projectId: string,
  role: AgentRole,
): Promise<{ role: string; skills: string[] }> {
  return requestJson<{ role: string; skills: string[] }>(`/api/skills/${projectId}/${role}`);
}

export async function healthCheck(): Promise<{ status: string }> {
  return requestJson<{ status: string }>("/health", {}, false);
}

export async function createCustomAgent(
  projectId: string,
  prompt: string,
  preferredRole?: string,
  color?: string,
) {
  return factoryApi.createCustomAgent(projectId, prompt, preferredRole, color);
}

export async function unlockAgentSlot(projectId: string) {
  return factoryApi.unlockSlot(projectId);
}

export async function createCollaborationSession(
  projectId: string,
  sharedGoal: string,
  participants: string[],
  options?: { signal?: AbortSignal; projectCwd?: string | null },
) {
  return collaborationApi.createSession(projectId, sharedGoal, participants, options);
}

export async function startCollaborationRound(
  projectId: string,
  sessionId: string,
  prompt: string,
  teams: string[],
  options?: { signal?: AbortSignal; projectCwd?: string | null },
) {
  return collaborationApi.startRound(projectId, sessionId, prompt, teams, options);
}

export async function getCollaborationSession(projectId: string, sessionId: string) {
  return collaborationApi.getSession(projectId, sessionId);
}

export async function stopCollaborationSession(projectId: string, sessionId: string) {
  return collaborationApi.stopSession(projectId, sessionId);
}
