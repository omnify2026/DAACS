import { expect, type Locator, type Page, type Route } from "@playwright/test";

const STORAGE_KEY_ACCESS_TOKEN = "daacs_access_token";
const STORAGE_KEY_ACTIVE_PROJECT = "daacs_active_project_id";
const STORAGE_KEY_LOCALE = "daacs_locale";

type BillingTrack = "byok" | "project";

type StubByokState = {
  billing_track: BillingTrack;
  byok_has_claude_key: boolean;
  byok_has_openai_key: boolean;
};

type StubBlueprint = Record<string, unknown> & {
  id: string;
  name: string;
  role_label: string;
  ui_profile: Record<string, unknown>;
};

type StubInstance = {
  instance_id: string;
  blueprint_id: string;
  project_id: string;
  runtime_status: string;
  assigned_team: string | null;
  current_tasks: string[];
  context_window_state: Record<string, unknown>;
  memory_bindings: Record<string, unknown>;
  live_metrics: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type SeedOptions = {
  activeProjectId?: string;
};

const baseMemberships = [
  {
    project_id: "project-alpha",
    project_name: "Project Alpha",
    role: "owner",
    is_owner: true,
  },
  {
    project_id: "project-beta",
    project_name: "Project Beta",
    role: "owner",
    is_owner: true,
  },
] as const;

function authPayload(byokState: StubByokState) {
  return {
    user: {
      id: "smoke-user",
      email: "smoke@daacs.local",
      plan: "pro",
      agent_slots: 8,
      custom_agent_count: 0,
      billing_track: byokState.billing_track,
      byok_has_claude_key: byokState.byok_has_claude_key,
      byok_has_openai_key: byokState.byok_has_openai_key,
    },
    memberships: [...baseMemberships],
    access_token: "smoke-access-token",
  };
}

function slugForApiId(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

export async function seedBrowserState(page: Page, options: SeedOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ activeProjectId, storageKeys }) => {
      window.localStorage.clear();
      window.sessionStorage.clear();
      window.localStorage.setItem(storageKeys.locale, "en");
      window.localStorage.setItem(storageKeys.accessToken, "smoke-access-token");
      if (activeProjectId) {
        window.localStorage.setItem(storageKeys.activeProject, activeProjectId);
      }
    },
    {
      activeProjectId: options.activeProjectId,
      storageKeys: {
        accessToken: STORAGE_KEY_ACCESS_TOKEN,
        activeProject: STORAGE_KEY_ACTIVE_PROJECT,
        locale: STORAGE_KEY_LOCALE,
      },
    },
  );
}

export async function installApiStubs(page: Page): Promise<void> {
  const byokState: StubByokState = {
    billing_track: "project",
    byok_has_claude_key: false,
    byok_has_openai_key: false,
  };
  const runtimeBlueprints: StubBlueprint[] = [];
  const runtimeInstances: StubInstance[] = [];

  const buildRuntimeBundle = (projectId: string) => ({
    runtime: {
      runtime_id: `runtime-${projectId}`,
      project_id: projectId,
      company_name: "Smoke Runtime",
      org_graph: {},
      agent_instance_ids: runtimeInstances.map((instance) => instance.instance_id),
      meeting_protocol: {},
      approval_graph: {},
      shared_boards: {},
      execution_mode: "manual",
      owner_ops_state: {},
      created_at: "2026-04-29T00:00:00.000Z",
      updated_at: "2026-04-29T00:00:00.000Z",
    },
    instances: runtimeInstances.filter((instance) => instance.project_id === projectId),
    blueprints: runtimeBlueprints,
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method().toUpperCase();

    if (method === "GET" && path === "/api/auth/me") {
      await fulfillJson(route, authPayload(byokState));
      return;
    }

    if (method === "POST" && path === "/api/auth/login") {
      await fulfillJson(route, authPayload(byokState));
      return;
    }

    if (method === "GET" && path === "/api/auth/projects") {
      await fulfillJson(route, [...baseMemberships]);
      return;
    }

    if (method === "GET" && path === "/api/auth/byok") {
      await fulfillJson(route, byokState);
      return;
    }

    if (method === "POST" && path === "/api/auth/byok") {
      const payload = request.postDataJSON() as {
        byok_claude_key?: string;
        byok_openai_key?: string;
      };

      if (payload.byok_claude_key?.trim()) {
        byokState.byok_has_claude_key = true;
      }
      if (payload.byok_openai_key?.trim()) {
        byokState.byok_has_openai_key = true;
      }
      if (byokState.byok_has_claude_key || byokState.byok_has_openai_key) {
        byokState.billing_track = "byok";
      }

      await fulfillJson(route, {
        ...byokState,
        status: "ok",
        updated: {
          byok_claude_key: Boolean(payload.byok_claude_key?.trim()),
          byok_openai_key: Boolean(payload.byok_openai_key?.trim()),
        },
      });
      return;
    }

    if (method === "GET" && /\/api\/ops\/[^/]+\/decisions$/.test(path)) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      await fulfillJson(route, { project_id: projectId, items: [] });
      return;
    }

    if (method === "GET" && /\/api\/ops\/[^/]+\/status$/.test(path)) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      await fulfillJson(route, {
        project_id: projectId,
        team_runs: {},
        incidents: {},
        decisions_count: 0,
      });
      return;
    }

    if (method === "GET" && /\/api\/projects\/[^/]+\/execution-intents$/.test(path)) {
      await fulfillJson(route, []);
      return;
    }

    if (method === "GET" && /\/api\/projects\/[^/]+\/plans$/.test(path)) {
      await fulfillJson(route, []);
      return;
    }

    if (method === "POST" && /\/api\/projects\/[^/]+\/clock-in$/.test(path)) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      await fulfillJson(route, {
        project_id: projectId,
        agents: [],
      });
      return;
    }

    if (method === "POST" && /\/api\/projects\/[^/]+\/clock-out$/.test(path)) {
      await fulfillJson(route, { status: "ok" });
      return;
    }

    if (method === "POST" && /^\/api\/projects\/[^/]+\/runtime\/bootstrap$/.test(path)) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      await fulfillJson(route, buildRuntimeBundle(projectId));
      return;
    }

    if (method === "GET" && /^\/api\/projects\/[^/]+\/runtime$/.test(path) && runtimeInstances.length > 0) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      await fulfillJson(route, buildRuntimeBundle(projectId));
      return;
    }

    if (method === "POST" && path === "/api/blueprints") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      const name = typeof payload.name === "string" ? payload.name : "Smoke Builder";
      const roleLabel =
        typeof payload.role_label === "string" ? payload.role_label : "smoke_builder";
      const uiProfile =
        typeof payload.ui_profile === "object" && payload.ui_profile != null
          ? (payload.ui_profile as Record<string, unknown>)
          : {};
      const blueprint: StubBlueprint = {
        ...payload,
        id: `blueprint-${slugForApiId(roleLabel, "smoke_builder")}`,
        name,
        role_label: roleLabel,
        capabilities: Array.isArray(payload.capabilities) ? payload.capabilities : [],
        prompt_bundle_ref: null,
        skill_bundle_refs: Array.isArray(payload.skill_bundle_refs)
          ? payload.skill_bundle_refs
          : [],
        tool_policy: payload.tool_policy ?? {},
        permission_policy: payload.permission_policy ?? {},
        memory_policy: payload.memory_policy ?? {},
        collaboration_policy: payload.collaboration_policy ?? {},
        approval_policy: payload.approval_policy ?? {},
        ui_profile: {
          display_name: name,
          title: roleLabel,
          avatar_style: "builder",
          accent_color: "#22C55E",
          icon: "Hammer",
          home_zone: "rd_lab",
          team_affinity: "development_team",
          authority_level: 20,
          capability_tags: Array.isArray(payload.capabilities) ? payload.capabilities : [],
          primary_widgets: ["code", "git"],
          secondary_widgets: ["timeline"],
          focus_mode: "builder",
          meeting_behavior: "adaptive",
          ...uiProfile,
        },
        is_builtin: false,
        owner_user_id: "smoke-user",
        created_at: "2026-04-29T00:00:00.000Z",
        updated_at: "2026-04-29T00:00:00.000Z",
      };
      runtimeBlueprints.push(blueprint);
      await fulfillJson(route, blueprint);
      return;
    }

    if (method === "POST" && /^\/api\/projects\/[^/]+\/instances$/.test(path)) {
      const projectId = path.split("/")[3] ?? "project-alpha";
      const payload = request.postDataJSON() as {
        blueprint_id?: string;
        assigned_team?: string | null;
      };
      const blueprintId = payload.blueprint_id ?? "blueprint-smoke-builder";
      const instance: StubInstance = {
        instance_id: `instance-${runtimeInstances.length + 1}`,
        blueprint_id: blueprintId,
        project_id: projectId,
        runtime_status: "idle",
        assigned_team: payload.assigned_team ?? "development_team",
        current_tasks: [],
        context_window_state: {},
        memory_bindings: {},
        live_metrics: {},
        created_at: "2026-04-29T00:00:00.000Z",
        updated_at: "2026-04-29T00:00:00.000Z",
      };
      runtimeInstances.push(instance);
      await fulfillJson(route, instance);
      return;
    }

    if (/\/api\/projects\/[^/]+\/runtime(\/bootstrap)?$/.test(path)) {
      await fulfillJson(route, { detail: "smoke runtime fallback" }, 500);
      return;
    }

    await fulfillJson(route, { detail: `Unhandled smoke route: ${method} ${path}` }, 500);
  });
}

export async function launchAtProjectSelection(page: Page): Promise<void> {
  await seedBrowserState(page);
  await installApiStubs(page);
  await page.goto("/");
  if (await page.getByText("Account Access").isVisible().catch(() => false)) {
    await page.getByPlaceholder("name@example.com").fill("smoke@daacs.local");
    await page.getByPlaceholder("Password (min 8 chars)").fill("smoke-password");
    await page.getByRole("button", { name: "Login" }).last().click();
  }
  await expect(page.getByText("Select Project")).toBeVisible();
}

export async function launchAtLobby(page: Page): Promise<void> {
  await seedBrowserState(page, { activeProjectId: "project-alpha" });
  await installApiStubs(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Clock In" })).toBeVisible();
}

export async function enterOfficeFromProjectSelection(page: Page): Promise<void> {
  await launchAtProjectSelection(page);
  await page.getByRole("button", { name: "Project Alpha" }).click();
  await expect(page.getByRole("button", { name: "Clock In" })).toBeVisible();
  await page.getByRole("button", { name: "Clock In" }).click();
  await expect(page.getByTestId("planner-toggle")).toBeVisible();
}

export async function openByokFromHud(page: Page): Promise<void> {
  await page.getByTestId("hud-main-menu-button").click();
  await page.getByTestId("hud-byok-settings-menu-item").click();
  await expect(page.getByTestId("llm-settings-modal")).toBeVisible();
}

async function elementCenter(locator: Locator): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return {
    x: (box?.x ?? 0) + (box?.width ?? 0) / 2,
    y: (box?.y ?? 0) + (box?.height ?? 0) / 2,
  };
}

export async function expectCoveredByModal(page: Page, locator: Locator): Promise<void> {
  const point = await elementCenter(locator);
  const isCovered = await page.evaluate(({ x, y }) => {
    const element = document.elementFromPoint(x, y);
    return element?.closest('[data-testid="llm-settings-modal"]') !== null;
  }, point);
  expect(isCovered).toBe(true);
}

export async function clickElementCenter(page: Page, locator: Locator): Promise<void> {
  const point = await elementCenter(locator);
  await page.mouse.click(point.x, point.y);
}

export async function expectActiveElementInModal(page: Page): Promise<void> {
  const isInsideModal = await page.evaluate(() => {
    const activeElement = document.activeElement;
    return activeElement instanceof HTMLElement
      && activeElement.closest('[data-testid="llm-settings-modal"]') !== null;
  });
  expect(isInsideModal).toBe(true);
}
