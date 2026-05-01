import assert from "node:assert/strict";
import type { Agent, AgentEvent } from "../types/agent";
import type { OfficeState } from "./officeStore";
import { handleWsEventWithBridge } from "./wsEventBridge";

type TimerCallback = () => void;

function createAgent(id: string, role: string, x: number, status: Agent["status"], currentTask?: string): Agent {
  return {
    id,
    role,
    name: id,
    position: { x, y: 0 },
    path: [],
    status,
    currentTask,
  };
}

function runQueuedTimers(timers: TimerCallback[]): void {
  while (timers.length > 0) {
    const next = timers.shift();
    next?.();
  }
}

export async function runWsEventBridgeRegressionTests(): Promise<void> {
  const timers: TimerCallback[] = [];
  const runtime = globalThis as typeof globalThis & {
    window?: { setTimeout?: (callback: TimerCallback, timeout?: number) => number };
  };
  const previousWindow = runtime.window;
  const previousSetTimeout = previousWindow?.setTimeout;
  const hadWindow = Object.prototype.hasOwnProperty.call(runtime, "window");
  const fakeSetTimeout = (callback: TimerCallback) => {
    timers.push(callback);
    return timers.length;
  };
  if (previousWindow != null) {
    Object.defineProperty(previousWindow, "setTimeout", {
      configurable: true,
      value: fakeSetTimeout,
    });
  } else {
    Object.defineProperty(runtime, "window", {
      configurable: true,
      value: { setTimeout: fakeSetTimeout },
      writable: true,
    });
  }

  try {
    let state = {
      agents: [
        createAgent("pm", "pm", 0, "idle"),
        createAgent("verifier", "verifier", 100, "working", "checking"),
      ],
      collaborationVisits: [],
      agentMessages: [],
      taskHistory: {},
      agentErrors: {},
      officeZones: [],
      officeProfile: undefined,
    } as unknown as OfficeState;

    const get = () => state;
    const set = (partial: Partial<OfficeState> | ((current: OfficeState) => Partial<OfficeState>)) => {
      const patch = typeof partial === "function" ? partial(state) : partial;
      state = { ...state, ...patch };
    };

    const timestamp = Date.now();
    handleWsEventWithBridge(get, set, {
      type: "AGENT_MESSAGE_SENT",
      agent_role: "verifier",
      timestamp,
      data: {
        from: "verifier",
        to: "pm",
        content: "작업 완료",
      },
    } satisfies AgentEvent);

    handleWsEventWithBridge(get, set, {
      type: "AGENT_STATUS_UPDATED",
      agent_role: "verifier",
      timestamp: timestamp + 1,
      data: {
        status: "completed",
        current_task: "",
      },
    } satisfies AgentEvent);

    runQueuedTimers(timers);

    const verifier = state.agents.find((agent) => agent.id === "verifier");
    assert.equal(
      verifier?.status,
      "idle",
      "collaboration return should not resurrect a completed verifier task as working",
    );
  } finally {
    if (previousWindow != null) {
      Object.defineProperty(previousWindow, "setTimeout", {
        configurable: true,
        value: previousSetTimeout,
      });
    } else if (hadWindow) {
      Object.defineProperty(runtime, "window", {
        configurable: true,
        value: previousWindow,
        writable: true,
      });
    } else {
      Reflect.deleteProperty(runtime, "window");
    }
  }

  console.log("wsEventBridge collaboration status regression passed");
}
