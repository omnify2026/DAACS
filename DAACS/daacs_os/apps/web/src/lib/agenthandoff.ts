import type {
  ExecutionStep,
  JsonValue,
  RuntimeBundleResponse,
} from "../types/runtime";

export interface HandoffMessage {
  from_agent_id: string;
  to_agent_id: string;
  type: "task_complete" | "review_request" | "question" | "feedback";
  content: string;
  artifacts?: string[];
}

function assignedRoleLabel(
  runtimeBundle: RuntimeBundleResponse,
  assignedTo: string | null,
): string {
  if (!assignedTo) return "unassigned";
  const instance = runtimeBundle.instances.find((candidate) => candidate.instance_id === assignedTo);
  if (!instance) return assignedTo;
  const blueprint = runtimeBundle.blueprints.find((candidate) => candidate.id === instance.blueprint_id);
  return blueprint?.role_label ?? assignedTo;
}

function inferHandoffType(nextStep: ExecutionStep): HandoffMessage["type"] {
  const label = `${nextStep.label} ${nextStep.description}`.toLowerCase();
  if (label.includes("review") || label.includes("audit")) {
    return "review_request";
  }
  if (label.includes("feedback")) {
    return "feedback";
  }
  if (label.includes("question")) {
    return "question";
  }
  return "task_complete";
}

export function handoffToNextAgent(
  runtimeBundle: RuntimeBundleResponse,
  completedStep: ExecutionStep,
  nextStep: ExecutionStep,
  result: string,
): HandoffMessage {
  const fromRole = assignedRoleLabel(runtimeBundle, completedStep.assigned_to);
  const toRole = assignedRoleLabel(runtimeBundle, nextStep.assigned_to);

  return {
    from_agent_id: completedStep.assigned_to ?? fromRole,
    to_agent_id: nextStep.assigned_to ?? toRole,
    type: inferHandoffType(nextStep),
    content: [
      `Completed step: ${completedStep.label}`,
      `Next step: ${nextStep.label}`,
      `From: ${fromRole}`,
      `To: ${toRole}`,
      "",
      result.trim() || "(no result content)",
    ].join("\n"),
  };
}

export function attachHandoffsToInput(
  input: JsonValue,
  handoffs: HandoffMessage[],
): JsonValue {
  if (handoffs.length === 0) {
    return input;
  }

  const inputRecord =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, JsonValue>)
      : { original_input: input };
  const existing = Array.isArray(inputRecord.handoff_messages)
    ? inputRecord.handoff_messages
    : [];

  return {
    ...inputRecord,
    handoff_messages: [...existing, ...handoffs] as JsonValue,
  };
}
