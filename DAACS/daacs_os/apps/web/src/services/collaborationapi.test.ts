import { pathToFileURL } from "node:url";

import { createSession, startRound, stopSession } from "./collaborationApi";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function withMockedFetch<T>(mock: FetchMock, action: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runCollaborationApiRegressionTests(): Promise<void> {
  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: false,
    VITE_UI_ONLY: "false",
  };
  process.env.DAACS_DEV = "false";
  process.env.VITE_UI_ONLY = "false";

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      cookie: "",
    },
  });

  const abortController = new AbortController();
  let createSignalSeen = false;
  let roundSignalSeen = false;
  let stopPathSeen = false;
  let roundProjectCwdSeen = false;

  await withMockedFetch(
    async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/collaboration/proj-1/sessions")) {
        createSignalSeen = init?.signal === abortController.signal;
        return new Response("{\"status\":\"created\",\"session_id\":\"sess-1\",\"shared_goal\":\"Ship it\",\"participants\":[\"pm\"]}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/collaboration/proj-1/sessions/sess-1/rounds")) {
        roundSignalSeen = init?.signal === abortController.signal;
        roundProjectCwdSeen = String(init?.body ?? "").includes('"project_cwd":"/repo/proj-1"');
        return new Response("{\"status\":\"completed\",\"session_id\":\"sess-1\",\"round\":{\"round_id\":\"round-1\",\"created_at\":123},\"artifact\":{\"session_id\":\"sess-1\",\"round_id\":\"round-1\",\"decision\":\"done\",\"open_questions\":[],\"next_actions\":[],\"contributions\":[]}}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/api/collaboration/proj-1/sessions/sess-1/stop")) {
        stopPathSeen = true;
        return new Response("{\"status\":\"stopped\",\"session_id\":\"sess-1\"}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected collaboration request: ${url}`);
    },
    async () => {
      const created = await createSession("proj-1", "Ship it", ["pm"], { signal: abortController.signal });
      assert(created.session_id === "sess-1", "createSession should surface the collaboration session id");

      const started = await startRound("proj-1", "sess-1", "Do the work", ["development_team"], {
        signal: abortController.signal,
        projectCwd: "/repo/proj-1",
      });
      assert(started.round.round_id === "round-1", "startRound should surface the collaboration round id");

      const stopped = await stopSession("proj-1", "sess-1");
      assert(String(stopped.status) === "stopped", "stopSession should target the collaboration stop endpoint");
    },
  );

  assert(createSignalSeen, "createSession should forward AbortSignal to requestJson/fetch");
  assert(roundSignalSeen, "startRound should forward AbortSignal to requestJson/fetch");
  assert(roundProjectCwdSeen, "startRound should forward project_cwd when a workspace is available");
  assert(stopPathSeen, "stopSession should continue using the collaboration stop endpoint");

  console.log("collaborationApi stop/signal regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runCollaborationApiRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
