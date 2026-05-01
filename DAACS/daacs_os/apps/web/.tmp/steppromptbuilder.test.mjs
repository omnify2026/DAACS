var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/constants.ts
var COOKIE_NAME_CSRF, HEADER_NAME_CSRF, DEFAULT_API_BASE, DEFAULT_WS_BASE, AUTH_PATH_PREFIX, PATH_HEALTH, PATH_SKILLS, PATH_SKILLS_CATALOG, PATH_SKILLS_BUNDLES, PATH_BLUEPRINTS, PATH_RUNTIMES, PATH_EXECUTION_PLANS, SKILL_BUNDLE_KEYS;
var init_constants = __esm({
  "src/constants.ts"() {
    COOKIE_NAME_CSRF = "daacs_csrf_token";
    HEADER_NAME_CSRF = "X-CSRF-Token";
    DEFAULT_API_BASE = "http://localhost:8001";
    DEFAULT_WS_BASE = "ws://localhost:8001";
    AUTH_PATH_PREFIX = "/api/auth/";
    PATH_HEALTH = "/health";
    PATH_SKILLS = "/api/skills";
    PATH_SKILLS_CATALOG = "/api/skills/catalog";
    PATH_SKILLS_BUNDLES = "/api/skills/bundles";
    PATH_BLUEPRINTS = "/api/blueprints";
    PATH_RUNTIMES = "/api/runtimes";
    PATH_EXECUTION_PLANS = "/api/execution-plans";
    SKILL_BUNDLE_KEYS = [
      "ceo",
      "pm",
      "developer",
      "reviewer",
      "devops",
      "marketer",
      "designer",
      "cfo"
    ];
  }
});

// src/services/appApiStub.ts
function isRuntimeProjectPath(path) {
  return /^\/api\/projects\/[^/]+\/(runtime|runtime\/bootstrap|instances)$/.test(path);
}
function isExecutionProjectPath(path) {
  return /^\/api\/projects\/[^/]+\/plans(?:\/[^/]+(?:\/(?:steps(?:\/[^/]+\/(?:approve|complete))?|execute|events|ready-steps))?)?$/.test(path);
}
function isBackendOnlyPath(path) {
  const p = path.split("?")[0];
  return p === PATH_HEALTH || p.startsWith(AUTH_PATH_PREFIX) || p === PATH_BLUEPRINTS || p.startsWith(`${PATH_BLUEPRINTS}/`) || p === PATH_RUNTIMES || p.startsWith(`${PATH_RUNTIMES}/`) || p === PATH_EXECUTION_PLANS || p.startsWith(`${PATH_EXECUTION_PLANS}/`) || p === PATH_SKILLS || p.startsWith(`${PATH_SKILLS}/`) || isRuntimeProjectPath(p) || isExecutionProjectPath(p);
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function appApiStub(path, method, body) {
  const p = path.split("?")[0];
  const methodUpper = method.toUpperCase();
  if (methodUpper === "POST" && /^\/api\/ops\/[^/]+\/decisions$/.test(p) && body) {
    try {
      const payload = JSON.parse(body);
      return {
        ...payload,
        decided_at: nowIso(),
        decided_by: "app"
      };
    } catch {
      return { item_id: "", title: "", source: "", action: "hold", decided_at: nowIso(), decided_by: "app" };
    }
  }
  if (methodUpper === "GET" && /^\/api\/ops\/[^/]+\/decisions/.test(p)) {
    return { project_id: "", items: [] };
  }
  if (methodUpper === "GET" && /^\/api\/ops\/[^/]+\/status$/.test(p)) {
    return { project_id: "", team_runs: {}, incidents: {}, decisions_count: 0 };
  }
  if (methodUpper === "GET" && /^\/api\/agents\/[^/]+$/.test(p)) {
    return [];
  }
  if (methodUpper === "GET" && /^\/api\/agents\/[^/]+\/[^/]+$/.test(p) && !p.includes("/history") && !p.includes("/events")) {
    return {
      role: "",
      display_name: "",
      status: "idle",
      tabs: [],
      updated_at: nowIso()
    };
  }
  if (methodUpper === "GET" && /\/history\?/.test(p)) {
    return [];
  }
  if (methodUpper === "GET" && /\/events\?/.test(p)) {
    return [];
  }
  if (methodUpper === "GET" && /^\/api\/dashboard\/[^/]+\/[^/]+$/.test(p) && !p.includes("/ide/")) {
    return {
      role: "",
      display_name: "",
      status: "idle",
      tabs: [],
      updated_at: nowIso()
    };
  }
  if (methodUpper === "POST" && /\/command$/.test(p)) {
    return { status: "ok", message: "" };
  }
  if (methodUpper === "POST" && /\/stream-task$/.test(p)) {
    return { status: "queued", agent: "", note: "" };
  }
  if (methodUpper === "GET" && /\/server-status$/.test(p)) {
    return { started: false, sessions: {} };
  }
  if (methodUpper === "GET" && /^\/api\/workflows\/[^/]+$/.test(p)) {
    return [];
  }
  if (methodUpper === "POST" && /^\/api\/workflows\/[^/]+\/start$/.test(p)) {
    return { workflow_id: "stub", status: "queued" };
  }
  if (methodUpper === "POST" && /\/stop$/.test(p) && /\/workflows\//.test(p)) {
    return { status: "ok" };
  }
  if (methodUpper === "GET" && /^\/api\/teams$/.test(p)) {
    return [];
  }
  if (methodUpper === "POST" && /^\/api\/teams\/[^/]+\/task$/.test(p)) {
    return { status: "ok", task_id: "stub" };
  }
  if (methodUpper === "POST" && /^\/api\/teams\/[^/]+\/parallel$/.test(p)) {
    return { status: "ok", task_ids: [] };
  }
  if (methodUpper === "GET" && /\/ide\/tree$/.test(p)) {
    return { path: "", children: [] };
  }
  if (methodUpper === "GET" && /\/ide\/file\?/.test(p)) {
    return { path: "", content: "" };
  }
  if (methodUpper === "GET" && /^\/api\/skills\/bundles$/.test(p)) {
    return {};
  }
  if (methodUpper === "GET" && /^\/api\/skills\/[^/]+\/[^/]+$/.test(p)) {
    return { role: "", skills: [] };
  }
  if (methodUpper === "POST" && /\/clock-in$/.test(p)) {
    return { status: "ok" };
  }
  if (methodUpper === "POST" && /\/clock-out$/.test(p)) {
    return { status: "ok" };
  }
  if (methodUpper === "POST" && /^\/api\/workflows\/[^/]+\/overnight$/.test(p)) {
    return { status: "ok", run_id: "stub", task_id: "stub" };
  }
  if (methodUpper === "GET" && /\/overnight\/[^/]+$/.test(p)) {
    return {
      run_id: "",
      status: "idle",
      goal: "",
      spent_usd: 0,
      overnight_config: {},
      steps: []
    };
  }
  if (methodUpper === "POST" && /\/overnight\/[^/]+\/stop$/.test(p)) {
    return { status: "ok", run_id: "stub" };
  }
  if (methodUpper === "POST" && /\/overnight\/[^/]+\/resume$/.test(p)) {
    return { status: "ok", run_id: "stub", task_id: "stub" };
  }
  if (methodUpper === "GET" && /\/overnight\/[^/]+\/report$/.test(p)) {
    return {};
  }
  if (methodUpper === "POST" && /^\/api\/collaboration\/[^/]+\/sessions$/.test(p)) {
    return { status: "ok", session_id: "stub", shared_goal: "", participants: [] };
  }
  if (methodUpper === "POST" && /\/sessions\/[^/]+\/rounds$/.test(p)) {
    let promptLabel = "";
    if (body) {
      try {
        const payload = JSON.parse(body);
        promptLabel = typeof payload.prompt === "string" ? payload.prompt : "";
      } catch {
      }
    }
    const goalSummary = promptLabel ? promptLabel.slice(0, 180).trim() : "\uACF5\uC720 \uBAA9\uD45C";
    const roundId = "stub-" + Date.now();
    return {
      status: "ok",
      session_id: "stub",
      round: { round_id: roundId, created_at: Date.now() },
      artifact: {
        session_id: "stub",
        round_id: roundId,
        decision: `PM \uBD84\uC11D: "${goalSummary}". Developer\xB7Reviewer\xB7Designer\uC5D0\uAC8C \uC791\uC5C5 \uC9C0\uC2DC \uC644\uB8CC. \uACB0\uACFC\uB97C \uACF5\uC720 \uBCF4\uB4DC\uC5D0 \uBC18\uC601\uD588\uC2B5\uB2C8\uB2E4.`,
        open_questions: ["\uBAA9\uD45C \uB2EC\uC131\uC744 \uC704\uD574 \uCD94\uAC00\uB85C \uD655\uC778\uD560 \uC0AC\uD56D\uC774 \uC788\uB098\uC694?", "\uC6B0\uC120\uC21C\uC704 \uC870\uC815\uC774 \uD544\uC694\uD55C\uAC00\uC694?"],
        next_actions: [
          "PM: \uBAA9\uD45C \uBD84\uC11D \uBC0F \uD300 \uC9C0\uC2DC \uC644\uB8CC",
          "Developer: \uC694\uAD6C\uC0AC\uD56D \uAD6C\uD604 \uC9C4\uD589",
          "Reviewer: \uCF54\uB4DC \uB9AC\uBDF0 \uB300\uAE30",
          "Designer: UI/UX \uAC80\uD1A0 \uB300\uAE30",
          "PM: \uACB0\uACFC \uC218\uC9D1 \uD6C4 \uACF5\uC720\uBCF4\uB4DC \uBC18\uC601"
        ],
        contributions: []
      }
    };
  }
  if (methodUpper === "GET" && /\/sessions\/[^/]+$/.test(p) && /\/collaboration\//.test(p)) {
    return {};
  }
  if (methodUpper === "POST" && /^\/api\/agent-factory\/[^/]+\/create$/.test(p)) {
    return {
      status: "ok",
      project_id: "",
      agent: { id: "stub", name: "", role: "", prompt: "" },
      slot: { used: 0, total: 0, remaining: 0 }
    };
  }
  if (methodUpper === "POST" && /^\/api\/agent-factory\/[^/]+\/unlock-slot$/.test(p)) {
    return { status: "ok", agent_slots: 0, custom_agent_count: 0 };
  }
  return {};
}
var init_appApiStub = __esm({
  "src/services/appApiStub.ts"() {
    init_constants();
  }
});

// src/services/httpClient.ts
function defaultApiBase() {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return DEFAULT_API_BASE;
}
function defaultWsBase() {
  if (typeof window !== "undefined" && window.location) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  return DEFAULT_WS_BASE;
}
function normalizeApiBase(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "";
  return trimmed.replace(/\/+$/, "");
}
function buildHeaders(init = {}) {
  const headers = new Headers(init);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return headers;
}
function getCookie(name) {
  if (typeof document === "undefined") return null;
  const prefix = `${name}=`;
  const hit = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(prefix));
  if (!hit) return null;
  const raw = hit.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
async function requestJson(path, options = {}, includeAuth = true) {
  if (!isBackendOnlyPath(path)) {
    const method2 = (options.method ?? "GET").toUpperCase();
    const body = typeof options.body === "string" ? options.body : null;
    return Promise.resolve(appApiStub(path, method2, body));
  }
  void includeAuth;
  const method = (options.method ?? "GET").toUpperCase();
  const headers = buildHeaders(options.headers);
  if (CSRF_UNSAFE_METHODS.has(method) && !headers.has(CSRF_HEADER_NAME)) {
    const csrfToken = getCookie(CSRF_COOKIE_NAME);
    if (csrfToken) {
      headers.set(CSRF_HEADER_NAME, csrfToken);
    }
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: options.credentials ?? "include"
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`API ${response.status}: ${body || response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  if (response.status === 204) {
    return void 0;
  }
  return response.json();
}
var API_BASE, WS_BASE, CSRF_COOKIE_NAME, CSRF_HEADER_NAME, CSRF_UNSAFE_METHODS;
var init_httpClient = __esm({
  "src/services/httpClient.ts"() {
    init_constants();
    init_appApiStub();
    API_BASE = normalizeApiBase(import.meta.env.VITE_API_URL ?? defaultApiBase());
    WS_BASE = import.meta.env.VITE_WS_URL ?? defaultWsBase();
    CSRF_COOKIE_NAME = import.meta.env.VITE_CSRF_COOKIE_NAME ?? COOKIE_NAME_CSRF;
    CSRF_HEADER_NAME = import.meta.env.VITE_CSRF_HEADER_NAME ?? HEADER_NAME_CSRF;
    CSRF_UNSAFE_METHODS = /* @__PURE__ */ new Set(["POST", "PUT", "PATCH", "DELETE"]);
  }
});

// src/services/runtimeApi.ts
var runtimeApi_exports = {};
__export(runtimeApi_exports, {
  approvePlanStep: () => approvePlanStep,
  bootstrapRuntime: () => bootstrapRuntime,
  completeStep: () => completeStep,
  createBlueprint: () => createBlueprint,
  createInstance: () => createInstance,
  createPlan: () => createPlan,
  deleteBlueprint: () => deleteBlueprint,
  executePlan: () => executePlan,
  getBlueprint: () => getBlueprint,
  getProjectPlan: () => getProjectPlan,
  getProjectRuntime: () => getProjectRuntime,
  getReadySteps: () => getReadySteps,
  getRuntime: () => getRuntime,
  getRuntimePlan: () => getRuntimePlan,
  getSkillBundleSummary: () => getSkillBundleSummary,
  getSkillCatalog: () => getSkillCatalog,
  getSkillPromptForCustom: () => getSkillPromptForCustom2,
  getSkillPromptForRole: () => getSkillPromptForRole2,
  listBlueprints: () => listBlueprints,
  listPlanEvents: () => listPlanEvents,
  listPlanSteps: () => listPlanSteps,
  listProjectInstances: () => listProjectInstances,
  listProjectPlans: () => listProjectPlans,
  listProjectRuntimes: () => listProjectRuntimes,
  listRuntimeAgents: () => listRuntimeAgents,
  listRuntimePlans: () => listRuntimePlans,
  updateBlueprint: () => updateBlueprint
});
function encodeSegment(value) {
  return encodeURIComponent(value);
}
function normalizeBlueprintInput(input) {
  return {
    capabilities: [],
    skill_bundle_refs: [],
    tool_policy: {},
    permission_policy: {},
    memory_policy: {},
    collaboration_policy: {},
    approval_policy: {},
    ui_profile: {},
    ...input
  };
}
function projectBasePath(projectId) {
  return `/api/projects/${encodeSegment(projectId)}`;
}
function projectRuntimePath(projectId) {
  return `${projectBasePath(projectId)}/runtime`;
}
function projectInstancesPath(projectId) {
  return `${projectBasePath(projectId)}/instances`;
}
function projectPlansPath(projectId) {
  return `${projectBasePath(projectId)}/plans`;
}
async function listBlueprints() {
  return requestJson(PATH_BLUEPRINTS);
}
async function getBlueprint(blueprintId) {
  return requestJson(`${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`);
}
async function createBlueprint(input) {
  return requestJson(PATH_BLUEPRINTS, {
    method: "POST",
    body: JSON.stringify(normalizeBlueprintInput(input))
  });
}
async function updateBlueprint(blueprintId, input) {
  return requestJson(`${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`, {
    method: "PUT",
    body: JSON.stringify(normalizeBlueprintInput(input))
  });
}
async function deleteBlueprint(blueprintId) {
  return requestJson(
    `${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`,
    { method: "DELETE" }
  );
}
async function getRuntime(runtimeId) {
  return requestJson(`${PATH_RUNTIMES}/${encodeSegment(runtimeId)}`);
}
async function listProjectRuntimes(projectId) {
  const qp = new URLSearchParams({ project_id: projectId });
  return requestJson(`${PATH_RUNTIMES}?${qp.toString()}`);
}
async function listRuntimePlans(runtimeId) {
  const qp = new URLSearchParams({ runtime_id: runtimeId });
  return requestJson(`${PATH_EXECUTION_PLANS}?${qp.toString()}`);
}
async function getRuntimePlan(planId) {
  return requestJson(`${PATH_EXECUTION_PLANS}/${encodeSegment(planId)}`);
}
async function listRuntimeAgents(runtimeId) {
  return requestJson(`${PATH_RUNTIMES}/${encodeSegment(runtimeId)}/agents`);
}
async function getProjectRuntime(projectId) {
  return requestJson(projectRuntimePath(projectId));
}
async function bootstrapRuntime(projectId, input = {}) {
  return requestJson(`${projectRuntimePath(projectId)}/bootstrap`, {
    method: "POST",
    body: JSON.stringify(input)
  });
}
async function listProjectInstances(projectId) {
  return requestJson(projectInstancesPath(projectId));
}
async function createInstance(projectId, input) {
  return requestJson(projectInstancesPath(projectId), {
    method: "POST",
    body: JSON.stringify({
      blueprint_id: input.blueprint_id,
      assigned_team: input.assigned_team ?? void 0
    })
  });
}
async function listProjectPlans(projectId) {
  return requestJson(projectPlansPath(projectId));
}
async function createPlan(projectId, input) {
  return requestJson(projectPlansPath(projectId), {
    method: "POST",
    body: JSON.stringify(input)
  });
}
async function getProjectPlan(projectId, planId) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}`
  );
}
async function listPlanSteps(projectId, planId) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps`
  );
}
async function listPlanEvents(projectId, planId) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/events`
  );
}
async function executePlan(projectId, planId, input = {}) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/execute`,
    { method: "POST", body: JSON.stringify(input) }
  );
}
async function getReadySteps(projectId, planId) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/ready-steps`
  );
}
async function completeStep(projectId, planId, stepId, input) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps/${encodeSegment(stepId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}
async function approvePlanStep(projectId, planId, stepId, input = {}) {
  return requestJson(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps/${encodeSegment(stepId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}
async function getSkillBundleSummary() {
  return requestJson(PATH_SKILLS_BUNDLES);
}
async function getSkillCatalog() {
  return requestJson(PATH_SKILLS_CATALOG);
}
async function getSkillPromptForRole2(projectId, role) {
  const data = await requestJson(
    `${PATH_SKILLS}/${encodeSegment(projectId)}/${encodeSegment(role)}`
  );
  return data.system_prompt ?? "";
}
async function getSkillPromptForCustom2(projectId, role, skillIds) {
  const data = await requestJson(
    `${PATH_SKILLS}/${encodeSegment(projectId)}/custom`,
    {
      method: "POST",
      body: JSON.stringify({
        role,
        skill_ids: skillIds
      })
    }
  );
  return data.system_prompt ?? "";
}
var init_runtimeApi = __esm({
  "src/services/runtimeApi.ts"() {
    init_constants();
    init_httpClient();
  }
});

// src/services/tauriCli.ts
init_constants();
function isTauri() {
  return typeof window !== "undefined" && !!window.__TAURI__?.core;
}
var FALLBACK_AGENTS_METADATA_JSON = '{"schema_version":1,"agents":[{"id":"pm","tauri_cli_role_key":"pm"},{"id":"frontend_developer","tauri_cli_role_key":"frontend"},{"id":"backend_developer","tauri_cli_role_key":"backend"}]}';
async function getAgentsMetadataJson() {
  if (!isTauri() || !window.__TAURI__?.core) return FALLBACK_AGENTS_METADATA_JSON;
  try {
    const s = await window.__TAURI__.core.invoke("get_agents_metadata_json");
    if (typeof s === "string" && s.trim().length > 0) return s;
  } catch {
  }
  return FALLBACK_AGENTS_METADATA_JSON;
}
var FALLBACK_SYSTEM_PROMPT = "You are an expert assistant. Execute the user's instruction precisely.";
async function getAgentPrompt(InRole) {
  if (!isTauri() || !window.__TAURI__?.core) return FALLBACK_SYSTEM_PROMPT;
  try {
    const out = await window.__TAURI__.core.invoke("get_agent_prompt", {
      inRole: InRole
    });
    return typeof out === "string" && out.trim().length > 0 ? out : FALLBACK_SYSTEM_PROMPT;
  } catch {
    return FALLBACK_SYSTEM_PROMPT;
  }
}
async function getSkillPromptForRole(role) {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__.core.invoke("get_skill_prompt_for_role", {
      role: role.trim()
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}
async function getSkillPromptForCustom(role, skillIds) {
  if (!isTauri() || !window.__TAURI__?.core) return "";
  try {
    const out = await window.__TAURI__.core.invoke("get_skill_prompt_for_custom", {
      role: role.trim(),
      skillIds
    });
    return typeof out === "string" ? out : "";
  } catch {
    return "";
  }
}

// src/lib/stepPromptBuilder.ts
init_constants();
function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function serializeForPrompt(value) {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}
function toBundleRole(roleLabel) {
  const normalized = normalizeKey(roleLabel).replace(/^bundle_/, "");
  if (normalized.startsWith("developer")) {
    return "developer";
  }
  return normalized;
}
function isBundleKey(value) {
  const normalized = normalizeKey(value);
  return SKILL_BUNDLE_KEYS.includes(normalized);
}
function findAssignedInstance(runtimeBundle2, step2) {
  return runtimeBundle2.instances.find((candidate) => candidate.instance_id === step2.assigned_to);
}
function findAssignedBlueprint(runtimeBundle2, step2) {
  const instance = findAssignedInstance(runtimeBundle2, step2);
  if (!instance) return void 0;
  return runtimeBundle2.blueprints.find((candidate) => candidate.id === instance.blueprint_id);
}
function heuristicCliRole(blueprint) {
  const roleLabel = normalizeKey(blueprint?.role_label);
  const capabilities = new Set((blueprint?.capabilities ?? []).map((item) => normalizeKey(item)));
  if (roleLabel === "pm" || roleLabel.includes("product") || capabilities.has("planning") || capabilities.has("goal_decomposition") || capabilities.has("approval")) {
    return "pm";
  }
  if (roleLabel.includes("front") || roleLabel.includes("design") || capabilities.has("ui") || capabilities.has("ux") || capabilities.has("design")) {
    return "frontend";
  }
  if (roleLabel.includes("back") || roleLabel.includes("devops") || capabilities.has("code_generation") || capabilities.has("api") || capabilities.has("database") || capabilities.has("infrastructure")) {
    return "backend";
  }
  return "agent";
}
function cliRoleFromMetadata(entries, blueprint) {
  if (!blueprint) return null;
  const lookupKeys = [
    normalizeKey(blueprint.role_label),
    normalizeKey(blueprint.name),
    normalizeKey(blueprint.ui_profile.display_name)
  ].filter(Boolean);
  const match = entries.find((entry) => lookupKeys.includes(normalizeKey(entry.id)));
  const cliRoleKey = normalizeKey(match?.tauri_cli_role_key);
  if (cliRoleKey === "pm") return "pm";
  if (cliRoleKey === "frontend") return "frontend";
  if (cliRoleKey === "backend") return "backend";
  return null;
}
function officeRoleFromBlueprint(blueprint) {
  const roleLabel = blueprint?.role_label?.trim();
  return roleLabel && roleLabel.length > 0 ? roleLabel : "pm";
}
async function loadSkillPrompt(runtimeBundle2, blueprint) {
  if (!blueprint) return "";
  const refs = blueprint.skill_bundle_refs.filter(Boolean);
  const bundleRoleFromRef = refs.length === 1 && isBundleKey(refs[0]) ? toBundleRole(refs[0]) : "";
  const bundleRole = bundleRoleFromRef || toBundleRole(blueprint.role_label);
  try {
    if (refs.length > 0 && (refs.length > 1 || !isBundleKey(refs[0]))) {
      if (isTauri()) {
        return await getSkillPromptForCustom(blueprint.role_label, refs);
      }
      const runtimeApi2 = await Promise.resolve().then(() => (init_runtimeApi(), runtimeApi_exports));
      return await runtimeApi2.getSkillPromptForCustom(
        runtimeBundle2.runtime.project_id,
        blueprint.role_label,
        refs
      );
    }
    if (!bundleRole) {
      return "";
    }
    if (isTauri()) {
      return await getSkillPromptForRole(bundleRole);
    }
    const runtimeApi = await Promise.resolve().then(() => (init_runtimeApi(), runtimeApi_exports));
    return await runtimeApi.getSkillPromptForRole(runtimeBundle2.runtime.project_id, bundleRole);
  } catch {
    return "";
  }
}
async function loadAgentsMetadata() {
  try {
    const raw = await getAgentsMetadataJson();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.agents) ? parsed.agents : [];
  } catch {
    return [];
  }
}
async function buildStepCliRequest(runtimeBundle2, plan2, step2) {
  const blueprint = findAssignedBlueprint(runtimeBundle2, step2);
  const instance = findAssignedInstance(runtimeBundle2, step2);
  const metadata = await loadAgentsMetadata();
  const cliRole = cliRoleFromMetadata(metadata, blueprint) ?? heuristicCliRole(blueprint);
  const officeAgentRole = officeRoleFromBlueprint(blueprint);
  const capabilityLine = step2.required_capabilities && step2.required_capabilities.length > 0 ? step2.required_capabilities.join(", ") : blueprint?.capabilities.join(", ") || "general execution";
  const basePrompt = await getAgentPrompt(cliRole);
  const skillPrompt = await loadSkillPrompt(runtimeBundle2, blueprint);
  const systemPrompt = [
    basePrompt.trim(),
    "---",
    skillPrompt.trim() || null,
    skillPrompt.trim() ? "---" : null,
    `You are operating as ${blueprint?.name ?? step2.label} (${blueprint?.role_label ?? officeAgentRole}).`,
    `Runtime company: ${runtimeBundle2.runtime.company_name}`,
    `Capabilities: ${capabilityLine}`,
    `Tool policy: ${serializeForPrompt(blueprint?.tool_policy ?? {})}`,
    `Permission policy: ${serializeForPrompt(blueprint?.permission_policy ?? {})}`,
    `Memory policy: ${serializeForPrompt(blueprint?.memory_policy ?? {})}`,
    "Execute the step directly and return a concrete result that the next step can consume."
  ].filter(Boolean).join("\n\n");
  const instruction = [
    `Goal: ${plan2.goal}`,
    `Plan rationale: ${plan2.plan_rationale || "No explicit rationale provided."}`,
    `Current step: ${step2.label}`,
    step2.description,
    `Assigned runtime agent: ${blueprint?.ui_profile.display_name ?? blueprint?.name ?? instance?.instance_id ?? "unassigned"}`,
    `Selection reason: ${step2.selection_reason || "No explicit selection reason provided."}`,
    `Planner notes: ${step2.planner_notes || "No planner notes provided."}`,
    `Required capabilities: ${capabilityLine}`,
    `Handoff input:
${serializeForPrompt(step2.input)}`,
    "Return the actual work result. When relevant, include a short summary, key actions, deliverables, and remaining risks."
  ].join("\n\n");
  return {
    cliRole,
    officeAgentRole,
    systemPrompt,
    instruction,
    label: step2.label
  };
}

// src/lib/stepPromptBuilder.test.ts
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
Object.assign(globalThis, {
  window: {
    __TAURI__: {
      core: {
        invoke: async (command) => {
          if (command === "get_agents_metadata_json") {
            return JSON.stringify({
              schema_version: 1,
              agents: [{ id: "developer_front", tauri_cli_role_key: "frontend" }]
            });
          }
          if (command === "get_agent_prompt") {
            return "Base frontend system prompt";
          }
          if (command === "get_skill_prompt_for_role") {
            return "## Agent Skills (developer)\n\n### Core Skills\n#### clean-code\nWrite maintainable code.";
          }
          if (command === "get_skill_prompt_for_custom") {
            return "## Agent Skills (developer_3d)\n\n### Core Skills\n#### 3d-web-experience\nBuild immersive 3D interfaces.";
          }
          return "";
        }
      }
    }
  }
});
var runtimeBundle = {
  runtime: {
    runtime_id: "runtime-1",
    project_id: "project-1",
    company_name: "DAACS Labs",
    org_graph: {},
    agent_instance_ids: ["inst-front"],
    meeting_protocol: {},
    approval_graph: {},
    shared_boards: {},
    execution_mode: "assisted",
    owner_ops_state: {},
    created_at: "2026-03-26T00:00:00.000Z",
    updated_at: "2026-03-26T00:00:00.000Z"
  },
  instances: [
    {
      instance_id: "inst-front",
      blueprint_id: "bp-front",
      project_id: "project-1",
      runtime_status: "idle",
      assigned_team: "development_team",
      current_tasks: [],
      context_window_state: {},
      memory_bindings: {},
      live_metrics: {},
      created_at: "2026-03-26T00:00:00.000Z",
      updated_at: "2026-03-26T00:00:00.000Z"
    }
  ],
  blueprints: [
    {
      id: "bp-front",
      name: "Frontend Developer",
      role_label: "developer_front",
      capabilities: ["design", "ui"],
      prompt_bundle_ref: "agent_front",
      skill_bundle_refs: [],
      tool_policy: { shell: true },
      permission_policy: { mode: "standard" },
      memory_policy: { mode: "shared" },
      collaboration_policy: {},
      approval_policy: {},
      ui_profile: {
        display_name: "Frontend Developer",
        title: "Frontend",
        avatar_style: "pixel",
        accent_color: "#3B82F6",
        icon: "Code",
        home_zone: "studio",
        team_affinity: "development_team",
        authority_level: 5,
        capability_tags: ["ui"],
        primary_widgets: ["delivery"],
        secondary_widgets: ["logs"],
        focus_mode: "default",
        meeting_behavior: "standard"
      },
      is_builtin: true,
      owner_user_id: "system",
      created_at: "2026-03-26T00:00:00.000Z",
      updated_at: "2026-03-26T00:00:00.000Z"
    }
  ]
};
var plan = {
  plan_id: "plan-1",
  runtime_id: "runtime-1",
  goal: "Ship the landing page",
  created_by: "pm",
  planner_version: "pm_planner_v1",
  planning_mode: "sequential",
  plan_rationale: "Design first, then implementation.",
  revision: 1,
  status: "active",
  created_at: "2026-03-26T00:00:00.000Z",
  updated_at: "2026-03-26T00:00:00.000Z",
  steps: []
};
var step = {
  step_id: "step-1",
  label: "Design the hero section",
  description: "Create the hero layout and visual direction.",
  assigned_to: "inst-front",
  depends_on: [],
  approval_required_by: null,
  status: "pending",
  required_capabilities: ["design", "ui"],
  selection_reason: "Frontend role owns the hero implementation.",
  approval_reason: null,
  planner_notes: "Keep the visual system consistent with the runtime palette.",
  parallel_group: null,
  input: { goal: "Ship the landing page" },
  output: {},
  started_at: null,
  completed_at: null
};
var request = await buildStepCliRequest(runtimeBundle, plan, step);
assert(request.cliRole === "frontend", "frontend blueprints should resolve to the frontend CLI role");
assert(request.officeAgentRole === "developer_front", "office role should mirror the blueprint role label");
assert(request.systemPrompt.includes("Frontend Developer"), "system prompt should include the assigned blueprint");
assert(request.systemPrompt.includes("## Agent Skills (developer)"), "system prompt should include the injected skill prompt");
assert(request.instruction.includes("Ship the landing page"), "instruction should include the plan goal");
var customRuntimeBundle = {
  ...runtimeBundle,
  blueprints: [
    {
      ...runtimeBundle.blueprints[0],
      role_label: "developer_3d",
      skill_bundle_refs: ["react-best-practices", "3d-web-experience"]
    }
  ]
};
var customRequest = await buildStepCliRequest(customRuntimeBundle, plan, step);
assert(
  customRequest.systemPrompt.includes("## Agent Skills (developer_3d)"),
  "custom skill refs should load the custom skill prompt path"
);
console.log("stepPromptBuilder tests passed");
