import { AUTH_PATH_PREFIX, PATH_HEALTH } from "../constants";

export { AUTH_PATH_PREFIX };
export const HEALTH_PATH = PATH_HEALTH;
const UI_ONLY_FLAG = "true";
const NODE_DEV_FLAG = "true";
const NODE_UI_ONLY_DEV_ENV = "DAACS_DEV";
const LOCAL_DEV_API_STUB_STORAGE_KEY = "DAACS_LOCAL_DEV_API_STUB";
const MOCK_PROJECTS_STORAGE_KEY = "MOCK_PROJECTS";
const MOCK_BYOK_STATE_STORAGE_KEY = "MOCK_BYOK_STATE";
const MOCK_PLANS_STORAGE_KEY = "MOCK_EXECUTION_PLANS";
export const LOCAL_DEV_ACCESS_TOKEN = "dev-local-access-token";

type BillingTrack = "byok" | "project";
type StubByokState = {
  billing_track: BillingTrack;
  byok_has_claude_key: boolean;
  byok_has_openai_key: boolean;
};

type StubProjectMembership = {
  project_id: string;
  project_name: string;
  role: string;
  is_owner: boolean;
};

type StubExecutionPlan = {
  plan_id: string;
  runtime_id: string;
  goal: string;
  created_by: string;
  planner_version: string;
  planning_mode: string;
  plan_rationale: string;
  revision: number;
  steps: Array<{
    step_id: string;
    label: string;
    description: string;
    assigned_to: string | null;
    depends_on: string[];
    approval_required_by: string | null;
    status: string;
    required_capabilities: string[];
    selection_reason: string | null;
    approval_reason: string | null;
    planner_notes: string | null;
    parallel_group: string | null;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
    started_at: string | null;
    completed_at: string | null;
  }>;
  status: string;
  created_at: string;
  updated_at: string;
};

export function isAppApiStubEnabled(): boolean {
  const viteDevEnabled = import.meta.env?.DEV === true;
  const viteUiOnlyEnabled = import.meta.env?.VITE_UI_ONLY === UI_ONLY_FLAG;
  const localDevApiStubEnabled = isLocalDevApiStubEnabled();

  if (viteDevEnabled && (viteUiOnlyEnabled || localDevApiStubEnabled)) {
    return true;
  }

  if (typeof process === "undefined" || process.env == null) {
    return false;
  }

  const nodeDevEnabled = process.env[NODE_UI_ONLY_DEV_ENV] === NODE_DEV_FLAG;
  const nodeUiOnlyEnabled = process.env.VITE_UI_ONLY === UI_ONLY_FLAG;
  return (
    nodeDevEnabled &&
    (nodeUiOnlyEnabled || localDevApiStubEnabled)
  );
}

function canUseLocalStorage(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function setLocalDevApiStubEnabled(enabled: boolean): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    if (enabled) {
      window.localStorage.setItem(LOCAL_DEV_API_STUB_STORAGE_KEY, UI_ONLY_FLAG);
      return;
    }
    window.localStorage.removeItem(LOCAL_DEV_API_STUB_STORAGE_KEY);
  } catch {
    // Keep the real backend path available when browser storage is blocked.
  }
}

function isLocalDevApiStubEnabled(): boolean {
  if (!canUseLocalStorage()) {
    return false;
  }

  try {
    return window.localStorage.getItem(LOCAL_DEV_API_STUB_STORAGE_KEY) === UI_ONLY_FLAG;
  } catch {
    return false;
  }
}

function stubAuthUser(email: string) {
  return {
    id: "dev-local-user",
    email,
    plan: "dev",
    agent_slots: 8,
    custom_agent_count: 0,
    billing_track: "project",
    byok_has_claude_key: false,
    byok_has_openai_key: false,
  };
}

function defaultStubByokState(): StubByokState {
  return {
    billing_track: "project",
    byok_has_claude_key: false,
    byok_has_openai_key: false,
  };
}

function stubMemberships(projectName?: string) {
  return [
    {
      project_id: "local",
      project_name: projectName?.trim() ? projectName : "Local Dev",
      role: "owner",
      is_owner: true,
    },
  ];
}

function getStoredMockProjects(): StubProjectMembership[] {
  if (!canUseLocalStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(MOCK_PROJECTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is StubProjectMembership =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as StubProjectMembership).project_id === "string" &&
        typeof (item as StubProjectMembership).project_name === "string" &&
        typeof (item as StubProjectMembership).role === "string" &&
        typeof (item as StubProjectMembership).is_owner === "boolean",
    );
  } catch {
    return [];
  }
}

function saveStoredMockProjects(projects: StubProjectMembership[]): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(MOCK_PROJECTS_STORAGE_KEY, JSON.stringify(projects));
  } catch {
    // Ignore storage failures in explicit UI-only mode.
  }
}

function readStoredPlans(): StubExecutionPlan[] {
  if (!canUseLocalStorage()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(MOCK_PLANS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item): item is StubExecutionPlan =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as StubExecutionPlan).plan_id === "string" &&
        typeof (item as StubExecutionPlan).runtime_id === "string" &&
        typeof (item as StubExecutionPlan).goal === "string" &&
        Array.isArray((item as StubExecutionPlan).steps),
    );
  } catch {
    return [];
  }
}

function saveStoredPlans(plans: StubExecutionPlan[]): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(MOCK_PLANS_STORAGE_KEY, JSON.stringify(plans));
  } catch {
    // Ignore storage failures in explicit UI-only mode.
  }
}

function parseProjectPlanPath(path: string): { projectId: string; planId?: string; suffix?: string } | null {
  const match = /^\/api\/projects\/([^/]+)\/plans(?:\/([^/]+)(?:\/(.+))?)?$/.exec(path);
  if (!match) {
    return null;
  }

  return {
    projectId: decodeURIComponent(match[1] ?? ""),
    planId: match[2] ? decodeURIComponent(match[2]) : undefined,
    suffix: match[3],
  };
}

function buildStoredPlan(projectId: string, goal: string): StubExecutionPlan {
  const timestamp = nowIso();
  const planId = `stub-plan-${Date.now()}`;
  const stepBase = [
    ["scaffold", "Prepare scope", "Clarify the target output and minimum files before any execution."],
    ["implementation", "Implementation work", "Assign implementation work to the appropriate user-created or bundled developer agent."],
    ["review", "Review work", "Review the produced artifact for missing requirements and regressions."],
    ["verify", "Verify execution", "Run build, smoke, or static checks before calling the work complete."],
  ] as const;

  return {
    plan_id: planId,
    runtime_id: `stub-runtime-${projectId}`,
    goal,
    created_by: "pm",
    planner_version: "ui-only-stub",
    planning_mode: "ui-only-preview",
    plan_rationale:
      "UI-only mode can preview a plan, but cannot execute local agent work. Use the desktop/Tauri runtime for real artifact generation.",
    revision: 1,
    steps: stepBase.map(([id, label, description], index) => ({
      step_id: `${planId}-${id}`,
      label,
      description,
      assigned_to: index === 0 ? "pm" : index === 1 ? "developer" : index === 2 ? "reviewer" : "verifier",
      depends_on: index === 0 ? [] : [`${planId}-${stepBase[index - 1][0]}`],
      approval_required_by: null,
      status: "pending",
      required_capabilities: [],
      selection_reason: null,
      approval_reason: null,
      planner_notes: "Preview-only plan generated by the browser UI stub.",
      parallel_group: null,
      input: {},
      output: {},
      started_at: null,
      completed_at: null,
    })),
    status: "draft",
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function getStoredMockByokState(): StubByokState {
  if (!canUseLocalStorage()) {
    return defaultStubByokState();
  }

  try {
    const raw = window.localStorage.getItem(MOCK_BYOK_STATE_STORAGE_KEY);
    if (!raw) {
      return defaultStubByokState();
    }
    const parsed = JSON.parse(raw) as Partial<StubByokState>;
    return {
      billing_track: parsed.billing_track === "byok" ? "byok" : "project",
      byok_has_claude_key: parsed.byok_has_claude_key === true,
      byok_has_openai_key: parsed.byok_has_openai_key === true,
    };
  } catch {
    return defaultStubByokState();
  }
}

function saveStoredMockByokState(state: StubByokState): void {
  if (!canUseLocalStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(MOCK_BYOK_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures in explicit UI-only mode.
  }
}

function listStubMemberships(projectName?: string): StubProjectMembership[] {
  return [...stubMemberships(projectName), ...getStoredMockProjects()];
}

function createStoredMockProject(projectName?: string): StubProjectMembership {
  const project: StubProjectMembership = {
    project_id: `local-${Date.now()}`,
    project_name: projectName?.trim() ? projectName.trim() : "Local Dev",
    role: "owner",
    is_owner: true,
  };
  saveStoredMockProjects([...getStoredMockProjects(), project]);
  return project;
}

function nowIso(): string {
  return new Date().toISOString();
}

function throwUiOnlyWorkflowUnavailable(path: string): never {
  throw new Error(
    `UI-only development mode does not provide workflow execution for ${path}. ` +
      "Disable VITE_UI_ONLY or connect a real backend before starting workflow or overnight runs.",
  );
}

export function appApiStub<T>(path: string, method: string, body?: string | null): T {
  if (!isAppApiStubEnabled()) {
    throw new Error("appApiStub is only available in UI-only or local Dev login development mode.");
  }

  const rawPath = path;
  const p = rawPath.split("?")[0];
  const methodUpper = method.toUpperCase();

  if (methodUpper === "GET" && (p === "/health" || p === PATH_HEALTH)) {
    return { status: "ok", service: "daacs-ui-dev-stub" } as T;
  }
  if (methodUpper === "POST" && p === "/api/auth/login" && body) {
    try {
      const j = JSON.parse(body) as { email?: string };
      const email = typeof j.email === "string" && j.email.trim() !== "" ? j.email.trim() : "dev@local.daacs";
      const byokState = getStoredMockByokState();
      return {
        user: {
          ...stubAuthUser(email),
          ...byokState,
        },
        memberships: listStubMemberships(),
        access_token: LOCAL_DEV_ACCESS_TOKEN,
      } as T;
    } catch {
      const byokState = getStoredMockByokState();
      return {
        user: {
          ...stubAuthUser("dev@local.daacs"),
          ...byokState,
        },
        memberships: listStubMemberships(),
        access_token: LOCAL_DEV_ACCESS_TOKEN,
      } as T;
    }
  }
  if (methodUpper === "POST" && p === "/api/auth/register" && body) {
    try {
      const j = JSON.parse(body) as { email?: string; project_name?: string; billing_track?: "byok" | "project" };
      const email = typeof j.email === "string" && j.email.trim() !== "" ? j.email.trim() : "dev@local.daacs";
      const pn = typeof j.project_name === "string" ? j.project_name : undefined;
      const byokState: StubByokState = {
        ...defaultStubByokState(),
        billing_track: j.billing_track === "byok" ? "byok" : "project",
      };
      saveStoredMockByokState(byokState);
      return {
        user: {
          ...stubAuthUser(email),
          ...byokState,
        },
        memberships: listStubMemberships(pn),
        access_token: LOCAL_DEV_ACCESS_TOKEN,
      } as T;
    } catch {
      const byokState = getStoredMockByokState();
      return {
        user: {
          ...stubAuthUser("dev@local.daacs"),
          ...byokState,
        },
        memberships: listStubMemberships(),
        access_token: LOCAL_DEV_ACCESS_TOKEN,
      } as T;
    }
  }
  if (methodUpper === "GET" && p === "/api/auth/me") {
    const byokState = getStoredMockByokState();
    return {
      user: {
        ...stubAuthUser("dev@local.daacs"),
        ...byokState,
      },
      memberships: listStubMemberships(),
      access_token: LOCAL_DEV_ACCESS_TOKEN,
    } as T;
  }
  if (methodUpper === "GET" && p === "/api/auth/projects") {
    return listStubMemberships() as T;
  }
  if (methodUpper === "POST" && p === "/api/auth/projects") {
    let projectName: string | undefined;
    if (body) {
      try {
        const j = JSON.parse(body) as { project_name?: string };
        projectName = typeof j.project_name === "string" ? j.project_name : undefined;
      } catch {
        projectName = undefined;
      }
    }
    return createStoredMockProject(projectName) as T;
  }
  if (methodUpper === "POST" && p === "/api/auth/logout") {
    return { status: "ok" } as T;
  }
  if (methodUpper === "GET" && p === "/api/auth/byok") {
    return getStoredMockByokState() as T;
  }
  if (methodUpper === "POST" && p === "/api/auth/byok") {
    let payload: { byok_claude_key?: string; byok_openai_key?: string } = {};
    if (body) {
      try {
        payload = JSON.parse(body) as typeof payload;
      } catch {
        payload = {};
      }
    }

    const currentState = getStoredMockByokState();
    const nextState: StubByokState = {
      billing_track:
        currentState.billing_track === "byok" ||
        typeof payload.byok_claude_key === "string" ||
        typeof payload.byok_openai_key === "string"
          ? "byok"
          : "project",
      byok_has_claude_key:
        currentState.byok_has_claude_key || typeof payload.byok_claude_key === "string",
      byok_has_openai_key:
        currentState.byok_has_openai_key || typeof payload.byok_openai_key === "string",
    };
    saveStoredMockByokState(nextState);

    return {
      status: "ok",
      ...nextState,
      updated: {
        byok_claude_key: typeof payload.byok_claude_key === "string",
        byok_openai_key: typeof payload.byok_openai_key === "string",
      },
    } as T;
  }
  if (methodUpper === "POST" && /^\/api\/auth\/ws-ticket\//.test(p)) {
    return { ticket: "stub-ticket", token_type: "ws_ticket", expires_in: 3600 } as T;
  }
  if (methodUpper === "GET" && p === "/api/skills/catalog") {
    return [] as T;
  }

  if (methodUpper === "POST" && /^\/api\/ops\/[^/]+\/decisions$/.test(p) && body) {
    try {
      const payload = JSON.parse(body) as Record<string, unknown>;
      return {
        ...payload,
        decided_at: nowIso(),
        decided_by: "app",
      } as T;
    } catch {
      return { item_id: "", title: "", source: "", action: "hold", decided_at: nowIso(), decided_by: "app" } as T;
    }
  }
  if (methodUpper === "GET" && /^\/api\/ops\/[^/]+\/decisions/.test(p)) {
    return { project_id: "", items: [] } as T;
  }
  if (methodUpper === "GET" && /^\/api\/ops\/[^/]+\/status$/.test(p)) {
    return { project_id: "", team_runs: {}, incidents: {}, decisions_count: 0 } as T;
  }
  if (methodUpper === "GET" && /^\/api\/agents\/[^/]+$/.test(p)) {
    return [] as T;
  }
  if (methodUpper === "GET" && /^\/api\/agents\/[^/]+\/[^/]+$/.test(p) && !p.includes("/history") && !p.includes("/events")) {
    return {
      role: "",
      display_name: "",
      status: "idle",
      tabs: [],
      updated_at: nowIso(),
    } as T;
  }
  if (methodUpper === "GET" && /\/history\?/.test(rawPath)) {
    return [] as T;
  }
  if (methodUpper === "GET" && /\/events\?/.test(rawPath)) {
    return [] as T;
  }
  if (methodUpper === "GET" && /^\/api\/dashboard\/[^/]+\/[^/]+$/.test(p) && !p.includes("/ide/")) {
    return {
      role: "",
      display_name: "",
      status: "idle",
      tabs: [],
      updated_at: nowIso(),
    } as T;
  }
  if (methodUpper === "POST" && /\/command$/.test(p)) {
    return { status: "ok", message: "" } as T;
  }
  if (methodUpper === "POST" && /\/stream-task$/.test(p)) {
    return { status: "queued", agent: "", note: "" } as T;
  }
  if (methodUpper === "GET" && /\/server-status$/.test(p)) {
    return { started: false, sessions: {} } as T;
  }
  if (methodUpper === "GET" && /^\/api\/workflows\/[^/]+$/.test(p)) {
    return [] as T;
  }
  if (methodUpper === "POST" && /^\/api\/workflows\/[^/]+\/start$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "POST" && /\/stop$/.test(p) && /\/workflows\//.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "GET" && /^\/api\/teams$/.test(p)) {
    return [] as T;
  }
  if (methodUpper === "POST" && /^\/api\/teams\/[^/]+\/task$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "POST" && /^\/api\/teams\/[^/]+\/parallel$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "GET" && /\/ide\/tree$/.test(p)) {
    return { path: "", children: [] } as T;
  }
  if (methodUpper === "GET" && /\/ide\/file\?/.test(rawPath)) {
    return { path: "", content: "" } as T;
  }
  if (methodUpper === "GET" && /^\/api\/skills\/bundles$/.test(p)) {
    return {} as T;
  }
  if (methodUpper === "GET" && /^\/api\/skills\/[^/]+\/[^/]+$/.test(p)) {
    return { role: "", skills: [] } as T;
  }
  if (methodUpper === "POST" && /\/clock-in$/.test(p)) {
    return { status: "ok" } as T;
  }
  if (methodUpper === "POST" && /\/clock-out$/.test(p)) {
    return { status: "ok" } as T;
  }
  if (methodUpper === "POST" && /^\/api\/workflows\/[^/]+\/overnight$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "GET" && /\/overnight\/[^/]+$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "POST" && /\/overnight\/[^/]+\/stop$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "POST" && /\/overnight\/[^/]+\/resume$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "GET" && /\/overnight\/[^/]+\/report$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  const projectPlanPath = parseProjectPlanPath(p);
  if (projectPlanPath != null) {
    if (methodUpper === "GET" && projectPlanPath.planId == null) {
      return readStoredPlans().filter((plan) => plan.runtime_id === `stub-runtime-${projectPlanPath.projectId}`) as T;
    }
    if (methodUpper === "POST" && projectPlanPath.planId == null) {
      let goal = "Untitled plan";
      if (body) {
        try {
          const payload = JSON.parse(body) as { goal?: string };
          if (typeof payload.goal === "string" && payload.goal.trim() !== "") {
            goal = payload.goal.trim();
          }
        } catch {
          goal = "Untitled plan";
        }
      }
      const plan = buildStoredPlan(projectPlanPath.projectId, goal);
      saveStoredPlans([plan, ...readStoredPlans()]);
      return plan as T;
    }
    if (methodUpper === "GET" && projectPlanPath.planId != null && projectPlanPath.suffix == null) {
      const plan = readStoredPlans().find((item) => item.plan_id === projectPlanPath.planId);
      return (plan ?? buildStoredPlan(projectPlanPath.projectId, "Untitled plan")) as T;
    }
    if (methodUpper === "GET" && projectPlanPath.suffix === "steps") {
      const plan = readStoredPlans().find((item) => item.plan_id === projectPlanPath.planId);
      return { plan_id: projectPlanPath.planId ?? "", steps: plan?.steps ?? [] } as T;
    }
    if (methodUpper === "GET" && projectPlanPath.suffix === "events") {
      return [] as T;
    }
    if (methodUpper === "GET" && projectPlanPath.suffix === "ready-steps") {
      return [] as T;
    }
    if (methodUpper === "POST") {
      return throwUiOnlyWorkflowUnavailable(p);
    }
  }
  if (methodUpper === "POST" && /^\/api\/collaboration\/[^/]+\/sessions$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "POST" && /\/sessions\/[^/]+\/stop$/.test(p)) {
    return {
      status: "stopped",
      session_id: "stub",
      shared_goal: "",
      participants: [],
      stopped: true,
      stop_reason: "user_requested",
    } as T;
  }
  if (methodUpper === "POST" && /\/sessions\/[^/]+\/rounds$/.test(p)) {
    return throwUiOnlyWorkflowUnavailable(p);
  }
  if (methodUpper === "GET" && /\/sessions\/[^/]+$/.test(p) && /\/collaboration\//.test(p)) {
    return {} as T;
  }
  if (methodUpper === "POST" && /^\/api\/agent-factory\/[^/]+\/create$/.test(p)) {
    return {
      status: "ok",
      project_id: "",
      agent: { id: "stub", name: "", role: "", prompt: "" },
      slot: { used: 0, total: 0, remaining: 0 },
    } as T;
  }
  if (methodUpper === "POST" && /^\/api\/agent-factory\/[^/]+\/unlock-slot$/.test(p)) {
    return { status: "ok", agent_slots: 0, custom_agent_count: 0 } as T;
  }

  throw new Error(`No UI-only stub is defined for ${methodUpper} ${rawPath}.`);
}
