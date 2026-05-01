import type { AgentEvent } from "../types/agent";
import type { RuntimeEvent } from "../types/runtime";

type Payload = Record<string, unknown>;

function asPayload(value: unknown): Payload {
  return typeof value === "object" && value !== null
    ? (value as Payload)
    : {};
}

function asTimestampMs(timestamp: string | number): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp > 1_000_000_000_000 ? timestamp : Math.round(timestamp * 1000);
  }
  if (typeof timestamp !== "string") {
    return Date.now();
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asPositiveMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function stepStatusToAgentStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "in_progress":
      return "running";
    case "awaiting_approval":
      return "running";
    case "failed":
      return "failed";
    case "completed":
    case "approved":
      return "completed";
    case "pending":
    case "blocked":
      return "queued";
    default:
      return undefined;
  }
}

function runtimeStatusToAgentStatus(status: string | undefined): string | undefined {
  switch (status) {
    case "planning":
    case "working":
    case "waiting_approval":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "idle":
      return "idle";
    default:
      return undefined;
  }
}

export function isRuntimeEvent(value: unknown): value is RuntimeEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.event_id === "string" &&
    typeof candidate.event_type === "string" &&
    typeof candidate.project_id === "string" &&
    (typeof candidate.timestamp === "string" || typeof candidate.timestamp === "number") &&
    "payload" in candidate
  );
}

export function parseSocketPayload(raw: string): RuntimeEvent | null {
  try {
    const parsed = JSON.parse(raw);
    return isRuntimeEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function runtimeEventToAgentEvents(event: RuntimeEvent): AgentEvent[] {
  const payload = asPayload(event.payload);
  const timestamp = asTimestampMs(event.timestamp);
  const role = asString(payload.role_label);
  const instanceId = asString(payload.assigned_to) ?? asString(payload.instance_id);
  const stepId = asString(payload.step_id);
  const stepLabel = asString(payload.label) ?? asString(payload.step_label) ?? "";
  const status = asString(payload.status);

  switch (event.event_type) {
    case "step_status_changed": {
      if (!role) return [];
      const events: AgentEvent[] = [];
      const bridgedStatus = stepStatusToAgentStatus(status);
      if (bridgedStatus) {
        events.push({
          type: "AGENT_STATUS_UPDATED",
          agent_role: role,
          timestamp,
          data: {
            status: bridgedStatus,
            current_task: stepLabel,
            message: stepLabel,
            instance_id: instanceId,
            task_id: stepId,
          },
        });
      }

      if (status === "completed" || status === "approved") {
        events.push({
          type: "AGENT_TASK_COMPLETED",
          agent_role: role,
          timestamp,
          data: {
            task_id: stepId,
            instruction: stepLabel,
            instance_id: instanceId,
            result_summary: asString(payload.summary) ?? stepLabel,
            result: payload.output,
          },
        });
      }

      if (status === "failed") {
        events.push({
          type: "AGENT_TASK_FAILED",
          agent_role: role,
          timestamp,
          data: {
            task_id: stepId,
            instruction: stepLabel,
            instance_id: instanceId,
            error: asString(payload.error) ?? "Step failed",
          },
        });
      }

      if (status === "awaiting_approval") {
        const approvalRole = asString(payload.approval_role_label) ?? role;
        events.push({
          type: "APPROVAL_REQUESTED",
          agent_role: approvalRole,
          timestamp,
          data: {
            step_id: stepId,
            step_label: stepLabel,
            requested_by_role: role,
            requested_by_instance_id: instanceId,
            approval_required_by: asString(payload.approval_required_by),
            approval_role_label: approvalRole,
          },
        });
      }

      return events;
    }
    case "approval_requested": {
      const approvalRole = asString(payload.approval_role_label) ?? role;
      if (!approvalRole) return [];
      return [
        {
          type: "APPROVAL_REQUESTED",
          agent_role: approvalRole,
          timestamp,
          data: {
            step_id: stepId,
            step_label: stepLabel,
            requested_by_role: role,
            requested_by_instance_id: instanceId,
            approval_required_by: asString(payload.approval_required_by),
            approval_role_label: approvalRole,
          },
        },
      ];
    }
    case "approval_granted": {
      if (!role) return [];
      return [
        {
          type: "APPROVAL_GRANTED",
          agent_role: role,
          timestamp,
          data: {
            step_id: stepId,
            step_label: stepLabel,
            approved_by_role: asString(payload.approved_by_role_label),
            approved_by_user_id: asString(payload.approved_by_user_id),
          },
        },
      ];
    }
    case "agent_status_changed": {
      if (!role) return [];
      return [
        {
          type: "AGENT_STATUS_UPDATED",
          agent_role: role,
          timestamp,
          data: {
            status: runtimeStatusToAgentStatus(asString(payload.status)) ?? "idle",
            current_task: asString(payload.current_task),
            message: asString(payload.message),
            instance_id: instanceId,
          },
        },
      ];
    }
    // ── 에이전트 활동 전용 이벤트 (Step 3-4) ──
    case "agent_working": {
      if (!role) return [];
      return [
        {
          type: "AGENT_STATUS_UPDATED",
          agent_role: role,
          timestamp,
          data: {
            status: "running",
            current_task: asString(payload.step_label),
            message: asString(payload.step_label),
            instance_id: instanceId,
          },
        },
      ];
    }
    case "agent_idle": {
      if (!role) return [];
      return [
        {
          type: "AGENT_STATUS_UPDATED",
          agent_role: role,
          timestamp,
          data: {
            status: "idle",
            current_task: undefined,
            message: "Waiting for next task",
            instance_id: instanceId,
          },
        },
      ];
    }
    case "agent_handoff": {
      const fromRole = asString(payload.from_role);
      const toRole = asString(payload.to_role);
      const summary =
        asString(payload.summary) ??
        asString(payload.content) ??
        [asString(payload.from_step_label), asString(payload.to_step_label)]
          .filter((value): value is string => typeof value === "string")
          .join(" -> ");
      const speechDurationMs = asPositiveMs(payload.speech_duration_ms);
      const arrivalBufferMs = asPositiveMs(payload.arrival_buffer_ms);
      const events: AgentEvent[] = [];
      if (fromRole) {
        events.push({
          type: "AGENT_MESSAGE_SENT",
          agent_role: fromRole,
          timestamp,
          data: {
            from: fromRole,
            to: toRole,
            content: summary,
            to_role: toRole,
            from_instance_id: instanceId,
            to_instance_id: asString(payload.to_instance_id),
            from_step_id: asString(payload.from_step_id),
            from_step_label: asString(payload.from_step_label),
            to_step_id: asString(payload.to_step_id),
            to_step_label: asString(payload.to_step_label),
            handoff_type: asString(payload.handoff_type) ?? "task_complete",
            speech_duration_ms: speechDurationMs,
            arrival_buffer_ms: arrivalBufferMs,
            instance_id: instanceId,
          },
        });
      }
      if (toRole) {
        events.push({
          type: "AGENT_MESSAGE_RECEIVED",
          agent_role: toRole,
          timestamp,
          data: {
            from: fromRole,
            to: toRole,
            content: summary,
            from_role: fromRole,
            from_instance_id: instanceId,
            from_step_id: asString(payload.from_step_id),
            from_step_label: asString(payload.from_step_label),
            to_step_id: asString(payload.to_step_id),
            to_step_label: asString(payload.to_step_label),
            handoff_type: asString(payload.handoff_type) ?? "task_complete",
            speech_duration_ms: speechDurationMs,
            arrival_buffer_ms: arrivalBufferMs,
            instance_id: asString(payload.to_instance_id),
          },
        });
      }
      return events;
    }
    case "agent_reviewing": {
      if (!role) return [];
      const events: AgentEvent[] = [
        {
          type: "AGENT_STATUS_UPDATED",
          agent_role: role,
          timestamp,
          data: {
            status: "reviewing",
            current_task: asString(payload.step_label),
            message: `Reviewing: ${asString(payload.step_label) ?? ""}`,
            instance_id: instanceId,
          },
        },
      ];
      // 리뷰 요청도 함께 발행
      const requestedByRole = asString(payload.requested_by_role);
      if (requestedByRole) {
        events.push({
          type: "APPROVAL_REQUESTED",
          agent_role: role,
          timestamp,
          data: {
            step_id: asString(payload.step_id),
            step_label: asString(payload.step_label),
            requested_by_role: requestedByRole,
            requested_by_instance_id: asString(payload.requested_by),
          },
        });
      }
      return events;
    }
    default:
      return [];
  }
}
