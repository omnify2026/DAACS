import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
void React;

import {
  LobbyScreen,
  ProjectSelectScreen,
  resetAuthScopedLlmSettingsUi,
  restoreSessionAuth,
} from "./app";
import { LlmSettingsModal } from "./components/office/LlmSettingsModal";
import { I18nProvider } from "./i18n";
import { useLlmSettingsStore } from "./stores/llmSettingsStore";
import type { AuthResponse } from "./services/agentApi";
import { setAuthToken } from "./services/httpClient";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function buildAuthResponse(id: string, email: string): AuthResponse {
  return {
    user: {
      id,
      email,
      plan: "dev",
      agent_slots: 8,
      custom_agent_count: 0,
      billing_track: "project",
      byok_has_claude_key: false,
      byok_has_openai_key: false,
    },
    memberships: [
      {
        project_id: "local",
        project_name: "Local Dev",
        role: "owner",
        is_owner: true,
      },
    ],
    access_token: `${id}-token`,
  };
}

type MemoryStorage = {
  clear: () => void;
  getItem: (key: string) => string | null;
  key: (index: number) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
  readonly length: number;
};

function createMemoryStorage(): MemoryStorage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
    get length() {
      return values.size;
    },
  };
}

function withBrowserGlobals<T>(run: () => T): T {
  const originalNavigator = globalThis.navigator;
  const originalLocalStorage = globalThis.localStorage;

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { language: "en-US" },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createMemoryStorage(),
  });

  try {
    return run();
  } finally {
    if (originalNavigator === undefined) {
      delete (globalThis as { navigator?: Navigator }).navigator;
    } else {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
      });
    }

    if (originalLocalStorage === undefined) {
      delete (globalThis as { localStorage?: Storage }).localStorage;
    } else {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: originalLocalStorage,
      });
    }
  }
}

type PreOfficeSurface = "lobby" | "project-select";

function renderAuthenticatedByokSurface(surface: PreOfficeSurface, modalOpen: boolean): string {
  useLlmSettingsStore.setState({
    billingTrack: "project",
    hasClaudeKey: false,
    hasOpenAiKey: false,
    isLoading: false,
    error: null,
    isSaving: false,
    saveError: null,
  });

  return withBrowserGlobals(() =>
    renderToStaticMarkup(
      <I18nProvider>
        <>
          {surface === "project-select" ? (
            <ProjectSelectScreen
              projects={[
                {
                  project_id: "project-alpha",
                  project_name: "Project Alpha",
                  role: "owner",
                  is_owner: true,
                },
              ]}
              onSelectProject={async () => {}}
              onCreateProject={async () => {}}
              onOpenLlmSettings={() => {}}
              selecting={false}
              externalError={null}
            />
          ) : (
            <LobbyScreen onOpenLlmSettings={() => {}} />
          )}
          <LlmSettingsModal open={modalOpen} onClose={() => {}} />
        </>
      </I18nProvider>,
    ),
  );
}

export async function runAppRegressionTests(): Promise<void> {
  const mainSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "main.tsx"), "utf8");
  assert(
    mainSource.includes("import { I18nProvider } from './i18n'") &&
      !mainSource.includes("import { I18nProvider } from './i18n.tsx'"),
    "Main entry should import I18nProvider through the same module id that useI18n consumers import",
  );
  assert(
    mainSource.indexOf("<I18nProvider>") < mainSource.indexOf("<ErrorBoundary>"),
    "Main entry should keep I18nProvider outside ErrorBoundary so every recovery screen stays inside locale context",
  );

  const projectSelectionClosed = renderAuthenticatedByokSurface("project-select", false);
  const projectSelectionOpened = renderAuthenticatedByokSurface("project-select", true);
  const lobbyClosed = renderAuthenticatedByokSurface("lobby", false);
  const lobbyOpened = renderAuthenticatedByokSurface("lobby", true);

  assert(
    projectSelectionClosed.includes("You can preload account-level BYOK keys before choosing a project.") &&
      projectSelectionClosed.includes('data-testid="project-select-manage-keys"') &&
      !projectSelectionClosed.includes('data-testid="llm-settings-modal"'),
    "Project selection should render an authenticated BYOK entry point before the shared modal is opened",
  );

  assert(
    projectSelectionOpened.includes('data-testid="project-select-manage-keys"') &&
      projectSelectionOpened.includes('data-testid="llm-settings-modal"') &&
      projectSelectionOpened.includes("Users can store their own API keys on the account and use BYOK when needed.") &&
      projectSelectionOpened.includes("Billing Track"),
    "Project selection should render the shared BYOK modal content once the authenticated entry flow opens it",
  );

  assert(
    lobbyClosed.includes("You can save account-level BYOK keys before entering the office.") &&
      lobbyClosed.includes('data-testid="lobby-manage-keys"') &&
      !lobbyClosed.includes('data-testid="llm-settings-modal"'),
    "Lobby should render the same authenticated BYOK entry point before the shared modal is opened",
  );

  assert(
    lobbyOpened.includes('data-testid="lobby-manage-keys"') &&
      lobbyOpened.includes('data-testid="llm-settings-modal"') &&
      lobbyOpened.includes("Users can store their own API keys on the account and use BYOK when needed.") &&
      lobbyOpened.includes("Billing Track"),
    "Lobby should render the shared BYOK modal content once the authenticated entry flow opens it",
  );

  {
    useLlmSettingsStore.setState({
      billingTrack: "byok",
      hasClaudeKey: true,
      hasOpenAiKey: true,
      isLoading: true,
      error: "stale load error",
      isSaving: true,
      saveError: "stale save error",
    });
    const modalStates: boolean[] = [];

    resetAuthScopedLlmSettingsUi((open) => {
      modalStates.push(open);
    });

    const state = useLlmSettingsStore.getState();
    assert(
      JSON.stringify(modalStates) === JSON.stringify([false]),
      `Auth-scoped LLM settings reset should close the shared modal, got ${JSON.stringify(modalStates)}`,
    );
    assert(state.billingTrack === "project", "Auth-scoped reset should restore the default billing track");
    assert(state.hasClaudeKey === false, "Auth-scoped reset should clear the Claude key presence flag");
    assert(state.hasOpenAiKey === false, "Auth-scoped reset should clear the OpenAI key presence flag");
    assert(state.isLoading === false, "Auth-scoped reset should clear stale loading state");
    assert(state.error === null, "Auth-scoped reset should clear stale load errors");
    assert(state.isSaving === false, "Auth-scoped reset should clear stale saving state");
    assert(state.saveError === null, "Auth-scoped reset should clear stale save errors");
  }

  {
    setAuthToken("seed-restore-token");
    let clearedAuth = false;
    let authedUser: AuthResponse["user"] | null = buildAuthResponse("seed", "seed@local.dev").user;
    let memberships = buildAuthResponse("seed", "seed@local.dev").memberships;
    let authError: string | null = null;
    let authChecked = false;

    await restoreSessionAuth({
      fetchMeFn: async () => {
        throw { status: 502, message: "upstream auth failure" };
      },
      skippedFetchMeApplyRef: { current: false },
      applyAuth: () => {
        throw new Error("restore failure should not apply auth state");
      },
      clearAuthStorageFn: () => {
        clearedAuth = true;
      },
      setAuthedUser: (user) => {
        authedUser = user;
      },
      setProjectMemberships: (nextMemberships) => {
        memberships = nextMemberships;
      },
      setAuthError: (message) => {
        authError = message;
      },
      setAuthChecked: (checked) => {
        authChecked = checked;
      },
      t: (key) => key,
      isCancelled: () => false,
    });

    assert(!clearedAuth, "Non-401/403 restore failures should preserve persisted auth state");
    assert(
      authedUser?.id === "seed",
      `Non-401/403 restore failures should preserve the restored user, got ${String(authedUser?.id)}`,
    );
    assert(
      memberships.length === 1 && memberships[0]?.project_id === "local",
      "Non-401/403 restore failures should preserve restored memberships",
    );
    assert(
      authError === "auth.restoreFailed",
      `Non-401/403 restore failures should surface auth.restoreFailed, got ${String(authError)}`,
    );
    assert(authChecked, "Restore failures should still mark auth as checked");
    setAuthToken(null);
  }

  {
    setAuthToken("pending-restore-token");
    const skippedFetchMeApplyRef = { current: false };
    const appliedSources: string[] = [];
    let appliedUserId: string | null = null;
    let resolveFetchMe: ((value: AuthResponse) => void) | null = null;
    let authChecked = false;

    const applyAuth = (response: AuthResponse, source: string) => {
      appliedSources.push(source);
      appliedUserId = response.user.id;
      if (source === "login") {
        skippedFetchMeApplyRef.current = true;
      }
    };

    const pendingRestore = restoreSessionAuth({
      fetchMeFn: async () =>
        await new Promise<AuthResponse>((resolve) => {
          resolveFetchMe = resolve;
        }),
      skippedFetchMeApplyRef,
      applyAuth,
      clearAuthStorageFn: () => {},
      setAuthedUser: () => {},
      setProjectMemberships: () => {},
      setAuthError: () => {},
      setAuthChecked: (checked) => {
        authChecked = checked;
      },
      t: (key) => key,
      isCancelled: () => false,
    });

    const devLogin = buildAuthResponse("dev-login-user", "dev-login@local.dev");
    const staleRestore = buildAuthResponse("stale-restore-user", "stale-restore@local.dev");
    assert(resolveFetchMe != null, "Restore helper should begin fetchMe before the dev login wins");
    const completeFetchMe: (value: AuthResponse) => void = resolveFetchMe;
    applyAuth(devLogin, "login");
    completeFetchMe(staleRestore);
    await pendingRestore;

    assert(
      JSON.stringify(appliedSources) === JSON.stringify(["login"]),
      `Late restore results should not apply after a dev login wins, got ${JSON.stringify(appliedSources)}`,
    );
    assert(
      appliedUserId === devLogin.user.id,
      `Late restore results should not clobber the dev login user, got ${String(appliedUserId)}`,
    );
    assert(authChecked, "Skipped restore applies should still mark auth as checked");
    setAuthToken(null);
  }

  console.log("App pre-office BYOK access and auth-scoped reset regressions passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAppRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
