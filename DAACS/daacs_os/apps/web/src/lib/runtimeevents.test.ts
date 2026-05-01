import { runtimeEventToAgentEvents } from "./runtimeEvents";
import type { RuntimeEvent } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const handoffEvent: RuntimeEvent = {
  event_id: "evt-1",
  event_type: "agent_handoff",
  project_id: "project-1",
  runtime_id: "runtime-1",
  timestamp: 1_710_000_000_000,
  payload: {
    from_role: "developer_front",
    to_role: "reviewer",
    instance_id: "agent-dev-1",
    to_instance_id: "agent-review-1",
    from_step_id: "step-dev",
    from_step_label: "Implement feature",
    to_step_id: "step-review",
    to_step_label: "Review change",
    summary: "Implement feature -> Review change",
    handoff_type: "task_complete",
    speech_duration_ms: 1600,
    arrival_buffer_ms: 200,
  },
};

const bridged = runtimeEventToAgentEvents(handoffEvent);
assert(bridged.length === 2, "agent_handoff should bridge into sent and received agent events");

const sent = bridged.find((event) => event.type === "AGENT_MESSAGE_SENT");
const received = bridged.find((event) => event.type === "AGENT_MESSAGE_RECEIVED");

assert(sent, "agent_handoff should emit AGENT_MESSAGE_SENT");
assert(received, "agent_handoff should emit AGENT_MESSAGE_RECEIVED");
assert(sent.agent_role === "developer_front", "sent message should target the source agent role");
assert(received.agent_role === "reviewer", "received message should target the destination agent role");
assert(sent.data.content === "Implement feature -> Review change", "sent message should include handoff summary");
assert(sent.data.from === "developer_front", "sent message should include sender role");
assert(sent.data.to === "reviewer", "sent message should include recipient role");
assert(sent.data.speech_duration_ms === 1600, "sent message should forward speech duration");
assert(sent.data.arrival_buffer_ms === 200, "sent message should forward arrival buffer");
assert(received.data.content === "Implement feature -> Review change", "received message should include handoff summary");

console.log("runtimeEvents tests passed");
