import type {
  Agent,
  AgentErrorRecord,
  CollaborationVisit,
  AgentEvent,
  AgentMessageRecord,
  AgentRole,
  AgentStatus,
  FileChangeRecord,
  TaskRecord,
  TaskStatus,
  WorkLogEntry,
  WorkLogEntryType,
} from "../types/agent";
import type { OfficeState } from "./officeStore";
import { advancePath, calculatePath, pathDuration } from "../lib/officePathing";
import { buildAgentDataKeys } from "../lib/officeDataScope";
import { buildEffectiveRoutingForFurniture } from "../lib/officeFurniture";

type Getter = () => OfficeState;
type Setter = (
  partial: Partial<OfficeState> | ((state: OfficeState) => Partial<OfficeState>),
) => void;

type WsPayload = Record<string, unknown>;

const TASK_HISTORY_LIMIT = 50;
const FILE_CHANGE_LIMIT = 100;
const AGENT_ERROR_LIMIT = 30;
const AGENT_MESSAGE_LIMIT = 100;
const WORK_LOG_LIMIT = 500;
const NOTIFICATION_LIMIT = 40;
const COLLABORATION_BUBBLE_MS = 1400;
const COLLABORATION_ARRIVAL_BUFFER_MS = 120;

const WORKLOG_TYPES: WorkLogEntryType[] = [
  "chunk",
  "tool_call",
  "tool_result",
  "session_start",
  "done",
  "error",
  "message_sent",
  "message_received",
];

function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && value.trim().length > 0;
}

function asEpochMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return Date.now();
  if (value > 1_000_000_000_000) return value;
  return Math.round(value * 1000);
}

function trim<T>(items: T[], limit: number): T[] {
  if (items.length <= limit) return items;
  return items.slice(items.length - limit);
}

function appendNotifications(
  notifications: OfficeState["notifications"],
  nextNotification: OfficeState["notifications"][number],
): OfficeState["notifications"] {
  return trim([...notifications, nextNotification], NOTIFICATION_LIMIT);
}

function upsertTask(
  tasks: TaskRecord[],
  taskId: string,
  patch: Partial<TaskRecord> & Pick<TaskRecord, "id" | "queuedAt" | "instruction" | "status">,
): TaskRecord[] {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx === -1) {
    return trim([...tasks, patch], TASK_HISTORY_LIMIT);
  }
  const next = [...tasks];
  next[idx] = { ...next[idx], ...patch };
  return trim(next, TASK_HISTORY_LIMIT);
}

function toTaskStatus(value: unknown): TaskStatus | null {
  if (typeof value !== "string") return null;
  if (value === "queued" || value === "running" || value === "completed" || value === "failed") return value;
  if (value === "error") return "failed";
  return null;
}

function toWorkLogType(raw: unknown, eventType: string): WorkLogEntryType {
  if (typeof raw === "string" && WORKLOG_TYPES.includes(raw as WorkLogEntryType)) {
    return raw as WorkLogEntryType;
  }
  if (eventType === "AGENT_TOOL_CALL") return "tool_call";
  if (eventType === "AGENT_TOOL_RESULT") return "tool_result";
  if (eventType === "AGENT_SESSION_STARTED") return "session_start";
  if (eventType === "AGENT_STREAM_DONE") return "done";
  if (eventType === "AGENT_ERROR") return "error";
  if (eventType === "AGENT_MESSAGE_SENT") return "message_sent";
  if (eventType === "AGENT_MESSAGE_RECEIVED") return "message_received";
  return "chunk";
}

function normalizeStatus(status: unknown, fallback: AgentStatus): AgentStatus {
  const allowed: AgentStatus[] = [
    "idle",
    "walking",
    "working",
    "reviewing",
    "meeting",
    "error",
    "celebrating",
  ];
  if (typeof status === "string" && allowed.includes(status as AgentStatus)) return status as AgentStatus;
  if (status === "running") return "working";
  if (status === "failed") return "error";
  if (status === "queued" || status === "completed") return "idle";
  return fallback;
}

function resolveVisitReturnStatus(returnStatus: AgentStatus, agent: Agent): AgentStatus {
  const hasCurrentTask =
    typeof agent.currentTask === "string" && agent.currentTask.trim() !== "";
  if (hasCurrentTask) return returnStatus;
  if (returnStatus === "working" || returnStatus === "reviewing") return "idle";
  return returnStatus;
}

function asPositiveMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : fallback;
}

function appendAgentError(
  state: OfficeState,
  role: AgentRole,
  dataKeys: string[],
  message: string,
  timestampMs: number,
): Partial<OfficeState> {
  const prevRoleErrors = readScopedRows(state.agentErrors, dataKeys);
  const nextError: AgentErrorRecord = {
    id: `err-${role}-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
    agentRole: role,
    error: message,
    timestamp: timestampMs,
  };
  return {
    agentErrors: writeScopedRows(
      state.agentErrors,
      dataKeys,
      trim([...prevRoleErrors, nextError], AGENT_ERROR_LIMIT),
    ),
  };
}

function parseFileChange(role: AgentRole, data: WsPayload, timestampMs: number): FileChangeRecord | null {
  const directPath = typeof data.file_path === "string" ? data.file_path : null;
  const input = typeof data.input === "object" && data.input ? (data.input as WsPayload) : null;
  const inputPath = input && typeof input.file_path === "string"
    ? input.file_path
    : input && typeof input.path === "string"
      ? input.path
      : null;
  const filePath = (directPath ?? inputPath ?? "").trim();
  if (!filePath) return null;

  const toolName = typeof data.tool === "string" ? data.tool : "tool";
  const actionRaw = typeof data.action === "string" ? data.action : "";
  const lowerTool = toolName.toLowerCase();
  let action: FileChangeRecord["action"] = "read";
  if (actionRaw === "create" || actionRaw === "edit" || actionRaw === "read") {
    action = actionRaw;
  } else if (
    lowerTool.includes("create") ||
    lowerTool.includes("new_file") ||
    lowerTool.includes("write")
  ) {
    action = "create";
  } else if (
    lowerTool.includes("edit") ||
    lowerTool.includes("patch") ||
    lowerTool.includes("replace") ||
    lowerTool.includes("rewrite") ||
    lowerTool.includes("append")
  ) {
    action = "edit";
  }

  return {
    id: `file-${role}-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
    agentRole: role,
    filePath,
    action,
    toolName,
    timestamp: timestampMs,
  };
}

function matchesRuntimeAgent(agent: Agent, role: AgentRole, data: WsPayload): boolean {
  const instanceId = typeof data.instance_id === "string" ? data.instance_id : null;
  if (instanceId && agent.instanceId === instanceId) return true;
  if (agent.role === role) return true;
  return agent.id === `agent-${role}`;
}

function resolveAgent(state: OfficeState, role: AgentRole, data: WsPayload): Agent | null {
  return state.agents.find((agent) => matchesRuntimeAgent(agent, role, data)) ?? null;
}

function resolveDataKeys(state: OfficeState, role: AgentRole, data: WsPayload): string[] {
  const agent = resolveAgent(state, role, data);
  return agent ? buildAgentDataKeys(agent) : [role];
}

function readScopedRows<T>(map: Record<string, T[]>, keys: string[]): T[] {
  for (const key of keys) {
    const rows = map[key];
    if (rows && rows.length > 0) return rows;
  }
  return keys.length > 0 ? map[keys[0]] ?? [] : [];
}

function writeScopedRows<T>(map: Record<string, T[]>, keys: string[], rows: T[]): Record<string, T[]> {
  const next = { ...map };
  for (const key of keys) next[key] = rows;
  return next;
}

function startCollaborationVisit(
  get: Getter,
  set: Setter,
  from: AgentRole,
  to: AgentRole,
  summary: string,
  timestampMs: number,
  timing?: {
    speechDurationMs?: number;
    arrivalBufferMs?: number;
  },
): void {
  const state = get();
  if (from === to) return;
  if (!summary.trim()) return;
  if (state.collaborationVisits.some((visit) => visit.from === from && visit.stage !== "returning")) {
    return;
  }

  const visitor = state.agents.find((agent) => agent.role === from);
  const host = state.agents.find((agent) => agent.role === to);
  if (!visitor || !host) return;

  const visitId = `visit-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`;
  const visit: CollaborationVisit = {
    id: visitId,
    from,
    to,
    summary,
    stage: "departing",
    timestamp: timestampMs,
  };
  const origin = visitor.position;
  const returnStatus = visitor.status === "walking" ? ("idle" as AgentStatus) : visitor.status;
  const returnMessage = visitor.message;
  const target = host.position;
  const speechDurationMs = timing?.speechDurationMs ?? COLLABORATION_BUBBLE_MS;
  const arrivalBufferMs = timing?.arrivalBufferMs ?? COLLABORATION_ARRIVAL_BUFFER_MS;
  const routing = state.officeProfile
    ? buildEffectiveRoutingForFurniture(
        state.officeProfile.routing,
        state.officeProfile.furniture,
      )
    : undefined;
  const outboundPath = calculatePath(
    origin,
    target,
    state.officeZones,
    routing,
  );
  const outboundMs = pathDuration(outboundPath);
  const returnPath = calculatePath(
    target,
    origin,
    state.officeZones,
    routing,
  );
  const returnMs = pathDuration(returnPath);
  const speakingAtMs = outboundMs + arrivalBufferMs;
  const returningAtMs = speakingAtMs + speechDurationMs;
  const completeAtMs = returningAtMs + returnMs;
  const elapsedMs = Math.max(0, Date.now() - timestampMs);
  if (elapsedMs >= completeAtMs + arrivalBufferMs) {
    return;
  }

  set((current) => ({
    collaborationVisits: [...current.collaborationVisits, visit],
    agents: current.agents.map((agent) =>
      agent.id === visitor.id
        ? {
            ...agent,
            ...(() => {
              if (elapsedMs < speakingAtMs) {
                const outboundProgress = advancePath(outboundPath, elapsedMs);
                return {
                  status: "walking" as AgentStatus,
                  path: outboundProgress.completed ? [] : outboundProgress.remainingPath,
                  position: outboundProgress.position,
                };
              }
              if (elapsedMs < returningAtMs) {
                return {
                  status: "meeting" as AgentStatus,
                  path: [],
                  position: target,
                };
              }
              const returnElapsedMs = elapsedMs - returningAtMs;
              const returnProgress = advancePath(returnPath, returnElapsedMs);
              return {
                status: returnProgress.completed
                  ? resolveVisitReturnStatus(returnStatus, agent)
                  : ("walking" as AgentStatus),
                path: returnProgress.completed ? [] : returnProgress.remainingPath,
                position: returnProgress.position,
              };
            })(),
          }
        : agent,
    ),
  }));

  const speakingDelayMs = Math.max(0, speakingAtMs - elapsedMs);
  if (elapsedMs < speakingAtMs) {
    window.setTimeout(() => {
      const current = get();
      if (!current.collaborationVisits.some((entry) => entry.id === visitId)) return;
      const currentHost = current.agents.find((agent) => agent.role === to);
      const arrivedTarget = currentHost?.position ?? target;
      set((next) => ({
        collaborationVisits: next.collaborationVisits.map((entry) =>
          entry.id === visitId ? { ...entry, stage: "speaking" } : entry,
        ),
        agents: next.agents.map((agent) =>
          agent.id === visitor.id
            ? {
                ...agent,
                position: arrivedTarget,
                path: [],
                status: "meeting",
                message: returnMessage,
              }
            : agent,
        ),
      }));
    }, speakingDelayMs);
  } else if (elapsedMs < returningAtMs) {
    set((next) => ({
      collaborationVisits: next.collaborationVisits.map((entry) =>
        entry.id === visitId ? { ...entry, stage: "speaking" } : entry,
      ),
    }));
  } else {
    set((next) => ({
      collaborationVisits: next.collaborationVisits.map((entry) =>
        entry.id === visitId ? { ...entry, stage: "returning" } : entry,
      ),
    }));
  }

  const returnDelayMs = Math.max(0, returningAtMs - elapsedMs);
  if (elapsedMs < returningAtMs) {
    window.setTimeout(() => {
      const current = get();
      if (!current.collaborationVisits.some((entry) => entry.id === visitId)) return;
      set((next) => ({
        collaborationVisits: next.collaborationVisits.map((entry) =>
          entry.id === visitId ? { ...entry, stage: "returning" } : entry,
        ),
        agents: next.agents.map((agent) =>
          agent.id === visitor.id
            ? {
                ...agent,
                status: "walking",
                path: returnPath,
                position: target,
                message: returnMessage,
              }
            : agent,
        ),
      }));
    }, returnDelayMs);
  }

  const cleanupDelayMs = Math.max(0, completeAtMs - elapsedMs + arrivalBufferMs);
  window.setTimeout(() => {
    const finalState = get();
    if (!finalState.collaborationVisits.some((entry) => entry.id === visitId)) return;
    set((done) => ({
      collaborationVisits: done.collaborationVisits.filter((entry) => entry.id !== visitId),
      agents: done.agents.map((agent) =>
        agent.id === visitor.id
          ? {
              ...agent,
              position: origin,
              path: [],
              status: resolveVisitReturnStatus(returnStatus, agent),
              message: returnMessage,
            }
          : agent,
      ),
    }));
  }, cleanupDelayMs);
}

export function handleWsEventWithBridge(get: Getter, set: Setter, event: AgentEvent): void {
  const state = get();
  const role = isAgentRole(event.agent_role) ? event.agent_role : null;
  const data = (event.data ?? {}) as WsPayload;
  const timestampMs = asEpochMs(event.timestamp);

  if (event.type === "AGENT_STATUS_UPDATED" && role) {
    const dataKeys = resolveDataKeys(state, role, data);
    const status = normalizeStatus(data.status, "idle");
    const taskStatus = toTaskStatus(data.status);
    const message = typeof data.message === "string" ? data.message : undefined;
    const currentTask = typeof data.current_task === "string" ? data.current_task : undefined;
    const nextAgents = state.agents.map((a: Agent) =>
      matchesRuntimeAgent(a, role, data)
        ? {
            ...a,
            status,
            message: message ?? a.message,
            currentTask: currentTask ?? a.currentTask,
          }
        : a,
    );

    let nextTaskHistory = state.taskHistory;
    if (taskStatus === "running" || status === "working") {
      const roleTasks = readScopedRows(state.taskHistory, dataKeys);
      const queued = [...roleTasks].reverse().find((t) => t.status === "queued");
      if (queued) {
        nextTaskHistory = writeScopedRows(
          state.taskHistory,
          dataKeys,
          upsertTask(roleTasks, queued.id, {
            ...queued,
            id: queued.id,
            instruction: queued.instruction,
            queuedAt: queued.queuedAt,
            status: "running",
            startedAt: timestampMs,
          }),
        );
      }
    }

    set({ agents: nextAgents, taskHistory: nextTaskHistory });
    return;
  }

  if (event.type === "AGENT_TASK_QUEUED" && role) {
    const dataKeys = resolveDataKeys(state, role, data);
    const taskId = typeof data.task_id === "string" ? data.task_id : `task-${timestampMs}`;
    const instruction = typeof data.instruction === "string" ? data.instruction : "";
    const roleTasks = readScopedRows(state.taskHistory, dataKeys);
    set({
      taskHistory: writeScopedRows(
        state.taskHistory,
        dataKeys,
        upsertTask(roleTasks, taskId, {
          id: taskId,
          instruction,
          status: "queued",
          queuedAt: timestampMs,
        }),
      ),
    });
    return;
  }

  if (event.type === "AGENT_TASK_COMPLETED" && role) {
    const dataKeys = resolveDataKeys(state, role, data);
    const taskId = typeof data.task_id === "string" ? data.task_id : `task-${timestampMs}`;
    const resultSummary = typeof data.result_summary === "string" ? data.result_summary : "";
    const result =
      typeof data.result === "object" && data.result ? (data.result as Record<string, unknown>) : undefined;
    const roleTasks = readScopedRows(state.taskHistory, dataKeys);
    const existing = roleTasks.find((t) => t.id === taskId);
    const instruction =
      existing?.instruction ??
      (typeof data.instruction === "string" ? data.instruction : existing?.instruction ?? "");

    set({
      taskHistory: writeScopedRows(
        state.taskHistory,
        dataKeys,
        upsertTask(roleTasks, taskId, {
          id: taskId,
          instruction,
          queuedAt: existing?.queuedAt ?? timestampMs,
          status: "completed",
          startedAt: existing?.startedAt ?? timestampMs,
          completedAt: timestampMs,
          resultSummary,
          result,
        }),
      ),
    });
    return;
  }

  if (event.type === "AGENT_TASK_FAILED" && role) {
    const dataKeys = resolveDataKeys(state, role, data);
    const taskId = typeof data.task_id === "string" ? data.task_id : `task-${timestampMs}`;
    const error = typeof data.error === "string" ? data.error : "Task failed";
    const roleTasks = readScopedRows(state.taskHistory, dataKeys);
    const existing = roleTasks.find((t) => t.id === taskId);
    const instruction =
      existing?.instruction ??
      (typeof data.instruction === "string" ? data.instruction : "");

    set((current) => {
      const baseTasks = readScopedRows(current.taskHistory, dataKeys);
      const nextTasks = upsertTask(baseTasks, taskId, {
        id: taskId,
        instruction,
        queuedAt: existing?.queuedAt ?? timestampMs,
        status: "failed",
        startedAt: existing?.startedAt,
        completedAt: timestampMs,
        error,
      });

      const errorPatch = appendAgentError(current, role, dataKeys, error, timestampMs);
      return {
        taskHistory: writeScopedRows(current.taskHistory, dataKeys, nextTasks),
        ...errorPatch,
      };
    });
    return;
  }

  if (event.type === "AGENT_ERROR" && role) {
    const message = typeof data.error === "string" ? data.error : (typeof data.content === "string" ? data.content : "Error");
    const dataKeys = resolveDataKeys(state, role, data);
    const errorPatch = appendAgentError(state, role, dataKeys, message, timestampMs);
    const nextAgents = state.agents.map((a: Agent) =>
      matchesRuntimeAgent(a, role, data) ? { ...a, status: "error" as AgentStatus, message } : a,
    );
    set({ ...errorPatch, agents: nextAgents });
    return;
  }

  if (event.type === "APPROVAL_REQUESTED" && role) {
    const stepLabel = typeof data.step_label === "string" ? data.step_label : "Approval requested";
    const requestedByRole = isAgentRole(data.requested_by_role) ? data.requested_by_role : undefined;
    const targetAgent = resolveAgent(state, role, data);
    const notification = {
      id: `notif-approval-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
      type: "warning" as const,
      message: `${stepLabel} requires approval`,
      agentRole: role,
      timestamp: timestampMs,
    };
    const nextMessages = requestedByRole
      ? trim(
          [
            ...state.agentMessages,
            {
              id: `approval-msg-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
              from: requestedByRole,
              to: role,
              toAgentId: targetAgent?.id,
              content: stepLabel,
              direction: "received" as const,
              timestamp: timestampMs,
            },
          ],
          AGENT_MESSAGE_LIMIT,
        )
      : state.agentMessages;

    set({
      notifications: appendNotifications(state.notifications, notification),
      agentMessages: nextMessages,
    });
    return;
  }

  if (event.type === "APPROVAL_GRANTED" && role) {
    const stepLabel = typeof data.step_label === "string" ? data.step_label : "Approval granted";
    set({
      notifications: appendNotifications(state.notifications, {
        id: `notif-approved-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
        type: "success",
        message: `${stepLabel} approved`,
        agentRole: role,
        timestamp: timestampMs,
      }),
    });
    return;
  }

  if ((event.type === "AGENT_MESSAGE_SENT" || event.type === "AGENT_MESSAGE_RECEIVED") && role) {
    const from = isAgentRole(data.from) ? data.from : role;
    const to = isAgentRole(data.to) ? data.to : role;
    const content = typeof data.content === "string" ? data.content : "";
    const direction: AgentMessageRecord["direction"] = event.type === "AGENT_MESSAGE_SENT" ? "sent" : "received";
    const message: AgentMessageRecord = {
      id: `msg-${role}-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      to,
      fromAgentId: typeof data.from_instance_id === "string" ? data.from_instance_id : undefined,
      toAgentId: typeof data.to_instance_id === "string" ? data.to_instance_id : undefined,
      content,
      direction,
      timestamp: timestampMs,
    };

    const nextMessages = trim([...state.agentMessages, message], AGENT_MESSAGE_LIMIT);
    set({ agentMessages: nextMessages });
    if (event.type === "AGENT_MESSAGE_SENT" && content.trim().length > 0) {
      startCollaborationVisit(get, set, from, to, content, timestampMs, {
        speechDurationMs: asPositiveMs(
          data.speech_duration_ms,
          COLLABORATION_BUBBLE_MS,
        ),
        arrivalBufferMs: asPositiveMs(
          data.arrival_buffer_ms,
          COLLABORATION_ARRIVAL_BUFFER_MS,
        ),
      });
    }
    return;
  }

  if (event.type.startsWith("AGENT_STREAM_") || event.type.startsWith("AGENT_TOOL_") || event.type === "AGENT_ERROR") {
    if (!role) return;
    const dataKeys = resolveDataKeys(state, role, data);

    const logType = toWorkLogType(data.stream_type, event.type);
    let content = typeof data.content === "string" ? data.content : "";
    const errorText = typeof data.error === "string" ? data.error : "";
    if (!content && event.type === "AGENT_ERROR" && errorText !== "") {
      content = errorText;
    }
    const toolName = typeof data.tool === "string" ? data.tool : undefined;
    const entry: WorkLogEntry = {
      id: `log-${role}-${timestampMs}-${Math.random().toString(36).slice(2, 8)}`,
      type: logType,
      content,
      timestamp: timestampMs,
      toolName,
    };

    const nextLogs = trim([...readScopedRows(state.workLogs, dataKeys), entry], WORK_LOG_LIMIT);
    const patch: Partial<OfficeState> = {
      workLogs: writeScopedRows(state.workLogs, dataKeys, nextLogs),
    };

    if (event.type === "AGENT_TOOL_CALL") {
      const fileChange = parseFileChange(role, data, timestampMs);
      if (fileChange) {
        const prev = readScopedRows(state.fileChanges, dataKeys);
        patch.fileChanges = writeScopedRows(
          state.fileChanges,
          dataKeys,
          trim([...prev, fileChange], FILE_CHANGE_LIMIT),
        );
      }
    }

    set(patch);
  }
}
