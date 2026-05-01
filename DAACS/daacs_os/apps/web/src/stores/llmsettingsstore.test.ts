import { pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

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

async function withMockedFetch<T>(mock: FetchMock, action: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock as typeof fetch;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function runLlmSettingsStoreRegressionTests(): Promise<void> {
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

  const { setAuthToken } = await import("../services/httpClient");
  const { useLlmSettingsStore } = await import("./llmSettingsStore");

  useLlmSettingsStore.setState({
    billingTrack: "project",
    hasClaudeKey: false,
    hasOpenAiKey: false,
    isLoading: false,
    error: "stale fetch error",
    isSaving: false,
    saveError: "stale save error",
  });

  await withMockedFetch(
    async (input, init) => {
      assert(String(input).endsWith("/api/auth/byok"), "fetchSettings should read the BYOK auth endpoint");
      assert(init?.method === "GET", "fetchSettings should issue a GET request");
      assert(init?.credentials === "include", "fetchSettings should preserve credentialed backend requests");
      return new Response(
        "{\"billing_track\":\"  ProJect  \",\"byok_has_claude_key\":true,\"byok_has_openai_key\":false}",
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        await useLlmSettingsStore.getState().fetchSettings();
      } finally {
        setAuthToken(null);
      }
    },
  );

  let state = useLlmSettingsStore.getState();
  assert(state.billingTrack === "project", "fetchSettings should surface the current billing track");
  assert(state.hasClaudeKey === true, "fetchSettings should surface stored Claude key presence");
  assert(state.hasOpenAiKey === false, "fetchSettings should surface missing OpenAI key presence");
  assert(state.error === null, "fetchSettings should clear prior load errors on success");
  assert(state.saveError === null, "fetchSettings should also clear stale save errors on success");

  await withMockedFetch(
    async (input, init) => {
      assert(String(input).endsWith("/api/auth/byok"), "saveSettings should target the BYOK auth endpoint");
      assert(init?.method === "POST", "saveSettings should issue a POST request");
      assert(init?.credentials === "include", "saveSettings should preserve credentialed backend requests");
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as {
        byok_claude_key?: string;
        byok_openai_key?: string;
      };
      assert(requestBody.byok_claude_key === "sk-ant-live", "saveSettings should trim and forward the Claude key");
      assert(requestBody.byok_openai_key === "sk-openai-live", "saveSettings should trim and forward the OpenAI key");
      return new Response(
        "{\"status\":\"saved\",\"billing_track\":\"  ByOk  \",\"byok_has_claude_key\":true,\"byok_has_openai_key\":true,\"updated\":{\"byok_claude_key\":true,\"byok_openai_key\":true}}",
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        const ok = await useLlmSettingsStore.getState().saveSettings("  sk-ant-live  ", " sk-openai-live ");
        assert(ok, "saveSettings should resolve true when the backend accepts the BYOK payload");
      } finally {
        setAuthToken(null);
      }
    },
  );

  state = useLlmSettingsStore.getState();
  assert(state.billingTrack === "byok", "saveSettings should reflect a BYOK billing-track switch after saving keys");
  assert(state.hasClaudeKey === true, "saveSettings should retain the Claude key presence flag");
  assert(state.hasOpenAiKey === true, "saveSettings should retain the OpenAI key presence flag");
  assert(state.error === null, "saveSettings should also clear stale load errors on success");
  assert(state.saveError === null, "saveSettings should clear prior save errors on success");

  await withMockedFetch(
    async () => {
      throw new Error("transient BYOK fetch failure");
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        await useLlmSettingsStore.getState().fetchSettings();
      } finally {
        setAuthToken(null);
      }
    },
  );

  state = useLlmSettingsStore.getState();
  assert(
    state.billingTrack === "byok",
    "fetchSettings should preserve the last known billing track when a refresh fails transiently",
  );
  assert(
    state.hasClaudeKey === true,
    "fetchSettings should preserve the last known Claude key state when a refresh fails transiently",
  );
  assert(
    state.hasOpenAiKey === true,
    "fetchSettings should preserve the last known OpenAI key state when a refresh fails transiently",
  );
  assert(state.error === "transient BYOK fetch failure", "fetchSettings should surface the transient refresh failure");

  await withMockedFetch(
    async () => {
      throw new Error("transient BYOK save failure");
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        const ok = await useLlmSettingsStore.getState().saveSettings("sk-ant-rotated", "sk-openai-rotated");
        assert(ok === false, "saveSettings should resolve false when the backend save fails transiently");
      } finally {
        setAuthToken(null);
      }
    },
  );

  state = useLlmSettingsStore.getState();
  assert(
    state.billingTrack === "byok",
    "saveSettings should preserve the last known billing track when a save fails transiently",
  );
  assert(
    state.hasClaudeKey === true,
    "saveSettings should preserve the last known Claude key state when a save fails transiently",
  );
  assert(
    state.hasOpenAiKey === true,
    "saveSettings should preserve the last known OpenAI key state when a save fails transiently",
  );
  assert(state.saveError === "transient BYOK save failure", "saveSettings should surface the transient save failure");

  await withMockedFetch(
    async () => {
      return new Response("{\"detail\":\"Missing or invalid API key\"}", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        await useLlmSettingsStore.getState().fetchSettings();
      } finally {
        setAuthToken(null);
      }
    },
  );

  state = useLlmSettingsStore.getState();
  assert(state.error === "Missing or invalid API key", "fetchSettings should surface backend detail payloads from API errors");

  await withMockedFetch(
    async () => {
      return new Response("{\"detail\":\"Provider rejected BYOK key\"}", {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      setAuthToken("test-access-token");
      try {
        const ok = await useLlmSettingsStore.getState().saveSettings("sk-ant-invalid", "");
        assert(ok === false, "saveSettings should still resolve false when the backend rejects the BYOK key");
      } finally {
        setAuthToken(null);
      }
    },
  );

  state = useLlmSettingsStore.getState();
  assert(state.saveError === "Provider rejected BYOK key", "saveSettings should surface backend detail payloads from API errors");

  {
    let resolveFetch: ((value: Response) => void) | null = null;

    useLlmSettingsStore.setState({
      billingTrack: "byok",
      hasClaudeKey: true,
      hasOpenAiKey: true,
      isLoading: false,
      error: "stale fetch error",
      isSaving: false,
      saveError: "stale save error",
    });

    const pendingFetch = withMockedFetch(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
      async () => {
        setAuthToken("test-access-token");
        try {
          return await useLlmSettingsStore.getState().fetchSettings();
        } finally {
          setAuthToken(null);
        }
      },
    );

    assert(resolveFetch != null, "fetchSettings lifecycle guard test should capture the pending backend response");
    const completeFetch: (value: Response) => void = resolveFetch;

    useLlmSettingsStore.getState().reset();
    completeFetch(
      new Response(
        "{\"billing_track\":\"byok\",\"byok_has_claude_key\":true,\"byok_has_openai_key\":true}",
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    await pendingFetch;

    state = useLlmSettingsStore.getState();
    assert(
      state.billingTrack === "project",
      "reset should prevent stale fetch completions from a prior account from restoring the old billing track",
    );
    assert(state.hasClaudeKey === false, "reset should prevent stale fetch completions from restoring Claude key state");
    assert(state.hasOpenAiKey === false, "reset should prevent stale fetch completions from restoring OpenAI key state");
    assert(state.isLoading === false, "reset should leave the store out of the loading state after a stale fetch resolves");
    assert(state.error === null, "reset should clear stale fetch errors");
    assert(state.saveError === null, "reset should clear stale save errors");
  }

  {
    let resolveSave: ((value: Response) => void) | null = null;

    useLlmSettingsStore.setState({
      billingTrack: "project",
      hasClaudeKey: false,
      hasOpenAiKey: false,
      isLoading: false,
      error: "stale fetch error",
      isSaving: false,
      saveError: "stale save error",
    });

    const pendingSave = withMockedFetch(
      async () =>
        await new Promise<Response>((resolve) => {
          resolveSave = resolve;
        }),
      async () => {
        setAuthToken("test-access-token");
        try {
          return await useLlmSettingsStore.getState().saveSettings("sk-ant-next", "sk-openai-next");
        } finally {
          setAuthToken(null);
        }
      },
    );

    assert(resolveSave != null, "saveSettings lifecycle guard test should capture the pending backend response");
    const completeSave: (value: Response) => void = resolveSave;

    useLlmSettingsStore.getState().reset();
    completeSave(
      new Response(
        "{\"status\":\"saved\",\"billing_track\":\"byok\",\"byok_has_claude_key\":true,\"byok_has_openai_key\":true,\"updated\":{\"byok_claude_key\":true,\"byok_openai_key\":true}}",
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const ok = await pendingSave;

    assert(ok === false, "stale save completions should resolve false after the account lifecycle resets");
    state = useLlmSettingsStore.getState();
    assert(
      state.billingTrack === "project",
      "reset should prevent stale save completions from a prior account from switching the billing track",
    );
    assert(state.hasClaudeKey === false, "reset should prevent stale save completions from restoring Claude key state");
    assert(state.hasOpenAiKey === false, "reset should prevent stale save completions from restoring OpenAI key state");
    assert(state.isSaving === false, "reset should leave the store out of the saving state after a stale save resolves");
    assert(state.error === null, "reset should clear stale load errors after a stale save resolves");
    assert(state.saveError === null, "reset should clear stale save errors after a stale save resolves");
  }

  console.log("llmSettingsStore BYOK lifecycle regressions passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runLlmSettingsStoreRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
