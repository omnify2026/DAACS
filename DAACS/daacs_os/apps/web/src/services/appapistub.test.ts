import { pathToFileURL } from "node:url";

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

export async function runAppApiStubRegressionTests(): Promise<void> {
  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: true,
    VITE_UI_ONLY: "true",
  };
  process.env.DAACS_DEV = "true";
  process.env.VITE_UI_ONLY = "true";

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
    },
  });

  const { appApiStub, isAppApiStubEnabled, setLocalDevApiStubEnabled } = await import("./appApiStub");

  assert(isAppApiStubEnabled(), "appApiStub should only activate in explicit DEV + VITE_UI_ONLY mode");

  const loginResponse = appApiStub<{
    user: { billing_track: string; byok_has_claude_key: boolean; byok_has_openai_key: boolean };
    memberships: Array<{ project_id: string; project_name: string; is_owner: boolean }>;
  }>("/api/auth/login", "POST", JSON.stringify({ email: "dev@local.daacs" }));

  assert(loginResponse.user.billing_track === "project", "Stub login should default to the shipped project lane");
  assert(loginResponse.memberships.length === 1, "Stub login should keep the default local project membership");

  const registerResponse = appApiStub<{
    user: { billing_track: string };
    memberships: Array<{ project_name: string }>;
  }>(
    "/api/auth/register",
    "POST",
    JSON.stringify({ email: "dev@local.daacs", project_name: "Proof Project", billing_track: "byok" }),
  );

  assert(registerResponse.user.billing_track === "byok", "Stub register should persist an explicit BYOK billing track");
  assert(
    registerResponse.memberships[0]?.project_name === "Proof Project",
    "Stub register should reflect the requested project name in the returned membership list",
  );

  const saveResponse = appApiStub<{
    status: string;
    billing_track: string;
    byok_has_claude_key: boolean;
    byok_has_openai_key: boolean;
    updated: { byok_claude_key: boolean; byok_openai_key: boolean };
  }>(
    "/api/auth/byok",
    "POST",
    JSON.stringify({ byok_claude_key: "sk-ant-proof", byok_openai_key: "sk-openai-proof" }),
  );

  assert(saveResponse.status === "ok", "Stub BYOK save should resolve with an ok status");
  assert(saveResponse.billing_track === "byok", "Stub BYOK save should keep the account in the BYOK lane");
  assert(saveResponse.byok_has_claude_key && saveResponse.byok_has_openai_key, "Stub BYOK save should persist both stored-key flags");
  assert(
    saveResponse.updated.byok_claude_key && saveResponse.updated.byok_openai_key,
    "Stub BYOK save should report which credentials were updated in this request",
  );

  const byokStatus = appApiStub<{
    billing_track: string;
    byok_has_claude_key: boolean;
    byok_has_openai_key: boolean;
  }>("/api/auth/byok", "GET");
  const meResponse = appApiStub<{
    user: { billing_track: string; byok_has_claude_key: boolean; byok_has_openai_key: boolean };
  }>("/api/auth/me", "GET");

  assert(byokStatus.billing_track === "byok", "Stub BYOK status should surface the persisted billing track");
  assert(byokStatus.byok_has_claude_key && byokStatus.byok_has_openai_key, "Stub BYOK status should surface the persisted key flags");
  assert(
    meResponse.user.billing_track === "byok" &&
      meResponse.user.byok_has_claude_key &&
      meResponse.user.byok_has_openai_key,
    "Stub auth/me should reflect the same persisted BYOK state as the dedicated BYOK endpoint",
  );

  let workflowGuardError: unknown = null;
  try {
    appApiStub("/api/workflows/local/start", "POST");
  } catch (error) {
    workflowGuardError = error;
  }

  assert(workflowGuardError instanceof Error, "UI-only workflow starts should fail closed through the stub");
  assert(
    workflowGuardError.message.includes("UI-only development mode does not provide workflow execution"),
    `Expected the UI-only workflow guardrail message, got ${String(workflowGuardError)}`,
  );

  const previewPlan = appApiStub<{
    plan_id: string;
    status: string;
    steps: Array<{ label: string; status: string }>;
    plan_rationale: string;
  }>("/api/projects/local/plans", "POST", JSON.stringify({ goal: "Build a todo app" }));

  assert(previewPlan.status === "draft", "UI-only plan creation should produce a preview draft");
  assert(previewPlan.steps.length >= 4, "UI-only plan preview should show the main execution phases");
  assert(
    previewPlan.plan_rationale.includes("cannot execute local agent work"),
    "UI-only plan preview should clearly say it is not real execution",
  );

  let planExecuteGuardError: unknown = null;
  try {
    appApiStub(`/api/projects/local/plans/${previewPlan.plan_id}/execute`, "POST");
  } catch (error) {
    planExecuteGuardError = error;
  }

  assert(planExecuteGuardError instanceof Error, "UI-only plan execution should fail closed through the stub");

  let collaborationGuardError: unknown = null;
  try {
    appApiStub("/api/collaboration/local/sessions", "POST", JSON.stringify({ shared_goal: "Build it" }));
  } catch (error) {
    collaborationGuardError = error;
  }

  assert(collaborationGuardError instanceof Error, "UI-only collaboration sessions should not fake completed artifacts");
  assert(
    collaborationGuardError.message.includes("UI-only development mode does not provide workflow execution"),
    `Expected the UI-only collaboration guardrail message, got ${String(collaborationGuardError)}`,
  );

  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: true,
    VITE_UI_ONLY: "false",
  };
  process.env.DAACS_DEV = "true";
  process.env.VITE_UI_ONLY = "false";
  window.localStorage.clear();

  assert(!isAppApiStubEnabled(), "The app stub should stay off in DEV unless UI-only or local Dev login enables it");
  setLocalDevApiStubEnabled(true);
  assert(isAppApiStubEnabled(), "Local Dev login should enable the app stub for the rest of the dev session");
  const clockInResponse = appApiStub<{ status: string }>("/api/projects/local/clock-in", "POST");
  assert(clockInResponse.status === "ok", "Local Dev login should make lobby clock-in resolve through the app stub");
  setLocalDevApiStubEnabled(false);
  assert(!isAppApiStubEnabled(), "Clearing local Dev login should return normal auth flows to the backend path");

  console.log("appApiStub BYOK/settings lane regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAppApiStubRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
