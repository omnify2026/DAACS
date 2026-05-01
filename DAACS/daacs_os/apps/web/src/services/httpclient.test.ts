import { pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type ApiErrorShape = {
  status: number;
  body: string;
};

type RegisterRequestBody = {
  email?: string;
  password?: string;
  project_name?: string;
  billing_track?: string;
};

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

async function expectApiError(
  action: () => Promise<unknown>,
  expectedStatus: number,
  expectedBody: string,
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected request to fail with ${expectedStatus}`);
  } catch (error) {
    const apiError = error as Partial<ApiErrorShape>;
    assert(apiError.status === expectedStatus, `Expected status ${expectedStatus}, got ${String(apiError.status)}`);
    assert(apiError.body === expectedBody, `Expected body "${expectedBody}", got "${String(apiError.body)}"`);
  }
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

function createThrowingStorage(): Storage {
  const fail = (): never => {
    throw new Error("storage blocked");
  };

  return {
    get length() {
      return 0;
    },
    clear: fail,
    getItem: () => fail(),
    key: () => null,
    removeItem: () => fail(),
    setItem: () => fail(),
  };
}

export async function runHttpClientRegressionTests(): Promise<void> {
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

  const { requestJson, setAuthToken } = await import("./httpClient");
  const {
    createProject,
    fetchByokStatus,
    fetchMe,
    listProjects,
    login,
    register,
    saveByokKeys,
  } = await import("./agentApi");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createThrowingStorage(),
    },
  });

  setAuthToken("blocked-token");
  assert(setAuthToken(null) === undefined, "setAuthToken should fail soft when storage access throws");

  await withMockedFetch(
    async (_input, init) => {
      const headers = new Headers(init?.headers ?? {});
      assert(
        headers.get("authorization") === "Bearer blocked-token",
        "requestJson should preserve Authorization headers via the in-memory fallback when storage is unavailable",
      );
      return new Response("{\"ok\":true}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const response = await requestJson<{ ok: boolean }>("/api/health", { method: "GET" }, true);
      assert(response.ok === true, "requestJson should remain usable when token storage is unavailable");
    },
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
    },
  });

  await withMockedFetch(
    async () =>
      new Response("backend unavailable", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    async () => {
      await expectApiError(
        () => requestJson("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "dev@local" }) }, false),
        503,
        "backend unavailable",
      );
    },
  );

  await withMockedFetch(
    async (input) => {
      assert(
        String(input).endsWith("/api/auth/login"),
        `browser production requests without VITE_API_BASE_URL should use same-origin paths, got ${String(input)}`,
      );
      return new Response("{\"detail\":\"invalid credentials\"}", {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await expectApiError(
        () => login("dev@local.daacs", "secret-password"),
        401,
        "{\"detail\":\"invalid credentials\"}",
      );
    },
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI__: { core: {} },
      localStorage: createMemoryStorage(),
    },
  });
  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: true,
    VITE_UI_ONLY: "false",
  };

  await withMockedFetch(
    async (input, init) => {
      assert(String(input) === "http://127.0.0.1:8001/api/auth/register", "desktop auth should target the Rust auth server");
      assert(init?.credentials === "include", "desktop auth should preserve credentialed backend requests");
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as RegisterRequestBody;
      assert(requestBody.email === "desktop@local.daacs", "desktop auth register should forward email");
      assert(requestBody.password === "secret-password", "desktop auth register should forward password");
      assert(requestBody.project_name === "Desktop Dev", "desktop auth register should forward project_name");
      return new Response("{\"user\":{\"id\":\"desktop-user\",\"email\":\"desktop@local.daacs\",\"plan\":\"free\",\"agent_slots\":2,\"custom_agent_count\":0,\"billing_track\":\"project\",\"byok_has_claude_key\":false,\"byok_has_openai_key\":false},\"memberships\":[],\"access_token\":\"desktop-token\"}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      const response = await register("desktop@local.daacs", "secret-password", "Desktop Dev");
      assert(response.access_token === "desktop-token", "desktop auth register should return backend auth payload");
    },
  );

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
    },
  });
  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: false,
    VITE_UI_ONLY: "false",
  };

  await withMockedFetch(
    async (input, init) => {
      assert(init?.credentials === "include", "register should preserve credentialed backend requests");
      assert(String(input).endsWith("/api/auth/register"), "register should stay on the project-backed auth endpoint");
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as RegisterRequestBody;
      assert(requestBody.billing_track === "project", "register should default to the shipped project billing_track");
      assert(requestBody.project_name === "Local Dev", "register should preserve optional project_name");
      return new Response("{\"detail\":\"project signup unavailable\"}", {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await expectApiError(
        () => register("dev@local.daacs", "secret-password", "Local Dev"),
        501,
        "{\"detail\":\"project signup unavailable\"}",
      );
    },
  );

  await withMockedFetch(
    async (input, init) => {
      assert(init?.credentials === "include", "register should preserve credentialed backend requests");
      assert(String(input).endsWith("/api/auth/register"), "register should stay on the project-backed auth endpoint");
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as RegisterRequestBody;
      assert(requestBody.billing_track === "byok", "register should still forward an explicit BYOK billing_track");
      assert(requestBody.project_name === "Local Dev", "register should preserve optional project_name");
      return new Response("{\"detail\":\"project signup unavailable\"}", {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    },
    async () => {
      await expectApiError(
        () => register("dev@local.daacs", "secret-password", "Local Dev", "byok"),
        501,
        "{\"detail\":\"project signup unavailable\"}",
      );
    },
  );

  let byokFetchCalls = 0;
  await withMockedFetch(
    async (input, init) => {
      byokFetchCalls += 1;
      assert(init?.credentials === "include", "BYOK requests should preserve credentialed backend requests");
      if (String(input).endsWith("/api/auth/byok") && init?.method === "POST") {
        const headers = new Headers(init?.headers ?? {});
        const requestBody = JSON.parse(String(init?.body ?? "{}")) as { byok_claude_key?: string };
        assert(requestBody.byok_claude_key === "sk-ant-test", "saveByokKeys should forward the key payload");
        assert(
          headers.get("X-CSRF-Token") === "csrf-cookie-value",
          "cookie-authenticated BYOK writes should forward the CSRF header",
        );
        return new Response("{\"status\":\"saved\",\"billing_track\":\"byok\",\"byok_has_claude_key\":true,\"byok_has_openai_key\":false,\"updated\":{\"byok_claude_key\":true,\"byok_openai_key\":false}}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(input).endsWith("/api/auth/byok") && init?.method === "GET") {
        const headers = new Headers(init?.headers ?? {});
        assert(
          headers.get("X-CSRF-Token") == null,
          "safe BYOK status reads should not send the CSRF header",
        );
        return new Response("{\"billing_track\":\"project\",\"byok_has_claude_key\":false,\"byok_has_openai_key\":false}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected BYOK request: ${String(input)} ${String(init?.method ?? "GET")}`);
    },
    async () => {
      setAuthToken("test-access-token");
      globalThis.document.cookie = "daacs_csrf_token=csrf-cookie-value";
      try {
        const saveResponse = await saveByokKeys({ byok_claude_key: "sk-ant-test" });
        assert(saveResponse.billing_track === "byok", "saveByokKeys should surface the backend billing track");
        const statusResponse = await fetchByokStatus();
        assert(statusResponse.billing_track === "project", "fetchByokStatus should read live backend status");
        assert(byokFetchCalls === 2, "BYOK auth should issue the expected backend requests");
      } finally {
        setAuthToken(null);
        globalThis.document.cookie = "";
      }
    },
  );

  await withMockedFetch(
    async () =>
      new Response("{\"user\":{\"id\":\"unexpected-success\"}}", {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await expectApiError(
        () => requestJson("/api/auth/me", { method: "GET" }, true),
        502,
        "{\"user\":{\"id\":\"unexpected-success\"}}",
      );
    },
  );

  await withMockedFetch(
    async () =>
      new Response("{\"detail\":\"upstream auth failure\"}", {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await expectApiError(() => login("dev@local.daacs", "secret-password"), 502, "{\"detail\":\"upstream auth failure\"}");
      await expectApiError(() => fetchMe(), 502, "{\"detail\":\"upstream auth failure\"}");
      await expectApiError(() => listProjects(), 502, "{\"detail\":\"upstream auth failure\"}");
      await expectApiError(() => createProject("Regression Project"), 502, "{\"detail\":\"upstream auth failure\"}");
      await expectApiError(
        () => register("dev@local.daacs", "secret-password", "Regression Project"),
        502,
        "{\"detail\":\"upstream auth failure\"}",
      );
    },
  );

  console.log("httpClient failure propagation tests passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runHttpClientRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
