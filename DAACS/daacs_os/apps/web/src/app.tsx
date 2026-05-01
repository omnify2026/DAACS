/* eslint-disable react-refresh/only-export-components */
/**
 * DAACS OS - Main Application
 */
import React, { useEffect, useCallback, useRef, useState, type ReactNode } from "react";
import { useOfficeStore } from "./stores/officeStore";
import { useWorkflowStore } from "./stores/workflowStore";
import { useLlmSettingsStore } from "./stores/llmSettingsStore";
import { OfficeScene } from "./components/office/OfficeScene";
import { LlmSettingsModal } from "./components/office/LlmSettingsModal";
import { useI18n } from "./i18n";
import {
  createProject,
  fetchMe,
  login,
  register,
  logout as apiLogout,
  type AuthResponse,
  type BillingTrack,
  type ProjectMembership,
  SHIPPED_AUTH_BILLING_TRACK,
} from "./services/agentApi";
void React;
import { CliProviderDevBanner } from "./components/dev/CliProviderDevBanner";
import { CliLogPanel } from "./components/dev/CliLogPanel";
import {
  STORAGE_KEY_ACCESS_TOKEN,
  STORAGE_KEY_ACTIVE_PROJECT,
  STORAGE_KEY_BILLING_TRACK,
} from "./constants";
import { getAuthToken, setAuthToken } from "./services/httpClient";
import { LOCAL_DEV_ACCESS_TOKEN, setLocalDevApiStubEnabled } from "./services/appApiStub";
import { isTauri } from "./services/tauriCli";

type AuthMode = "login" | "signup";
type AuthSource = "login" | "signup" | "session_restore";
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ApiErrorLike = {
  status?: number;
  body?: string;
  message?: string;
};

type RestoreSessionParams = {
  fetchMeFn: () => Promise<AuthResponse>;
  skippedFetchMeApplyRef: { current: boolean };
  applyAuth: (res: AuthResponse, source: AuthSource) => void;
  clearAuthStorageFn: () => void;
  setAuthedUser: (user: AuthResponse["user"] | null) => void;
  setProjectMemberships: (memberships: ProjectMembership[]) => void;
  setAuthError: (message: string | null) => void;
  setAuthChecked: (checked: boolean) => void;
  t: (key: string) => string;
  isCancelled: () => boolean;
};

function buildDevAuthResponse(): AuthResponse {
  return {
    user: {
      id: "dev-local-user",
      email: "dev@local.daacs",
      plan: "dev",
      agent_slots: 8,
      custom_agent_count: 0,
      billing_track: SHIPPED_AUTH_BILLING_TRACK,
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
    access_token: LOCAL_DEV_ACCESS_TOKEN,
  };
}

function normalizeAuthEmail(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value.includes("@")) {
    return `${value}@daacsuser.com`;
  }
  return value;
}

function parseAuthApiError(error: unknown, t: (key: string) => string): string {
  const fallback = error instanceof Error ? error.message : t("auth.required");
  if (!error || typeof error !== "object") return fallback;

  const apiError = error as ApiErrorLike;
  const body = typeof apiError.body === "string" ? apiError.body : "";

  if (body) {
    try {
      const payload = JSON.parse(body) as {
        detail?: string | Array<{ loc?: unknown[]; msg?: string }>;
      };

      if (typeof payload.detail === "string") {
        return payload.detail;
      }

      if (Array.isArray(payload.detail)) {
        const emailIssue = payload.detail.some((d) => Array.isArray(d.loc) && d.loc.map(String).includes("email"));
        if (emailIssue) return t("auth.invalidEmail");

        const passwordIssue = payload.detail.some((d) => Array.isArray(d.loc) && d.loc.map(String).includes("password"));
        if (passwordIssue) return t("auth.invalidPassword");

        const firstMsg = payload.detail.find((d) => typeof d.msg === "string")?.msg;
        if (firstMsg) return firstMsg;
      }
    } catch {
      // Keep fallback for non-JSON errors.
    }
  }

  if (apiError.status === 422) {
    return t("auth.invalidInput");
  }

  return fallback;
}

export async function restoreSessionAuth({
  fetchMeFn,
  skippedFetchMeApplyRef,
  applyAuth,
  clearAuthStorageFn,
  setAuthedUser,
  setProjectMemberships,
  setAuthError,
  setAuthChecked,
  t,
  isCancelled,
}: RestoreSessionParams): Promise<void> {
  const storedToken = getAuthToken();
  if (!storedToken) {
    if (!isCancelled()) {
      setAuthError(null);
      setAuthChecked(true);
    }
    return;
  }

  try {
    const me = await fetchMeFn();
    if (isCancelled() || skippedFetchMeApplyRef.current) return;
    applyAuth(me, "session_restore");
  } catch (error) {
    if (isCancelled()) return;
    const maybeApi = error as ApiErrorLike;
    if (maybeApi?.status === 401 || maybeApi?.status === 403) {
      clearAuthStorageFn();
      setAuthedUser(null);
      setProjectMemberships([]);
      setAuthError(null);
    } else {
      setAuthError(t("auth.restoreFailed"));
    }
  } finally {
    if (!isCancelled()) setAuthChecked(true);
  }
}

export function resetAuthScopedLlmSettingsUi(
  closeModal: (open: boolean) => void,
): void {
  useLlmSettingsStore.getState().reset();
  closeModal(false);
}

function persistBillingTrack(billingTrack: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY_BILLING_TRACK, billingTrack);
  } catch {
    // Keep auth flow functional even when storage is unavailable.
  }
}

function clearAuthStorage(): void {
  setAuthToken(null);
  setLocalDevApiStubEnabled(false);
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(STORAGE_KEY_ACCESS_TOKEN);
    window.localStorage.removeItem(STORAGE_KEY_BILLING_TRACK);
  } catch {
    // Keep auth flow functional even when storage is unavailable.
  }
}

function readStoredActiveProject(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY_ACTIVE_PROJECT)?.trim();
    return stored ? stored : null;
  } catch {
    return null;
  }
}

function persistActiveProject(projectId: string | null): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    if (projectId && projectId.trim() !== "") {
      window.localStorage.setItem(STORAGE_KEY_ACTIVE_PROJECT, projectId);
      return;
    }
    window.localStorage.removeItem(STORAGE_KEY_ACTIVE_PROJECT);
  } catch {
    // Keep project selection functional even when storage is unavailable.
  }
}

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div className="w-full h-screen bg-bg-deep flex items-center justify-center px-6 relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-surface to-bg-deep pointer-events-none" />
      <div className="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[760px] h-[760px] bg-neon-blue/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[560px] h-[560px] bg-neon-purple/10 rounded-full blur-[120px] pointer-events-none" />
      <div className="scanline-overlay" />

      <div className="relative z-10 w-full max-w-xl rounded-2xl border border-border bg-bg-deep/80 shadow-2xl">
        <div className="flex items-center gap-1.5 px-4 py-3 bg-bg-surface/70 border-b border-border rounded-t-2xl">
          <div className="w-2.5 h-2.5 rounded-full bg-error/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-warning/70" />
          <div className="w-2.5 h-2.5 rounded-full bg-success/70" />
          <span className="ml-2 text-[10px] text-text-muted terminal-text">auth_boot.sh</span>
        </div>

        <div className="p-6 md:p-8 space-y-6 text-text">
          <div className="space-y-2">
            <div className="pixel-text text-base text-neon-blue neon-glow-blue">DAACS OS</div>
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="text-sm text-text-muted">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function LocaleToggle({
  showLogout,
  onLogout,
}: {
  showLogout: boolean;
  onLogout?: () => void;
}) {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="rounded-full border border-[#2A2A4A] bg-[#111127]/80 backdrop-blur px-1 py-1 flex items-center gap-1">
      <button
        onClick={() => setLocale("ko")}
        className={`px-3 py-1 text-xs rounded-full transition-colors ${locale === "ko" ? "bg-cyan-500 text-black font-semibold" : "text-gray-300 hover:text-white"}`}
      >
        KR
      </button>
      <button
        onClick={() => setLocale("en")}
        className={`px-3 py-1 text-xs rounded-full transition-colors ${locale === "en" ? "bg-cyan-500 text-black font-semibold" : "text-gray-300 hover:text-white"}`}
      >
        EN
      </button>
      {showLogout && onLogout && (
        <button
          onClick={onLogout}
          className="px-3 py-1 text-xs rounded-full text-rose-300 hover:text-white border border-rose-500/40"
        >
          {t("auth.logout")}
        </button>
      )}
    </div>
  );
}

function TopBar({
  showLogout,
  onLogout,
  onDevLogin,
  showLocaleToggle = true,
}: {
  showLogout: boolean;
  onLogout?: () => void;
  onDevLogin?: () => void;
  showLocaleToggle?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="fixed top-3 right-64 z-[80] flex max-w-[min(56rem,calc(100vw-17rem))] flex-wrap items-center justify-end gap-3">
      <CliProviderDevBanner />
      {onDevLogin != null && (
        <button
          type="button"
          onClick={onDevLogin}
          className="rounded-full border border-amber-500/50 bg-amber-950/80 backdrop-blur px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-900/90 hover:text-white transition-colors"
        >
          {t("auth.devLogin")}
        </button>
      )}
      {showLocaleToggle && <LocaleToggle showLogout={showLogout} onLogout={onLogout} />}
    </div>
  );
}

function AuthScreen({
  onAuthenticated,
  externalError,
}: {
  onAuthenticated: (res: AuthResponse, source: AuthSource) => void;
  externalError: string | null;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [projectName, setProjectName] = useState("");
  const [billingTrack, setBillingTrack] = useState<BillingTrack>(SHIPPED_AUTH_BILLING_TRACK);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password.trim() || submitting) return;

    const normalizedEmail = normalizeAuthEmail(email);
    if (!EMAIL_REGEX.test(normalizedEmail)) {
      setError(t("auth.invalidEmail"));
      return;
    }

    setSubmitting(true);
    setError(null);
    setLocalDevApiStubEnabled(false);
    try {
      const res =
        mode === "login"
          ? await login(normalizedEmail, password)
          : await register(normalizedEmail, password, projectName.trim() || undefined, billingTrack);
      onAuthenticated(res, mode);
    } catch (e) {
      const parsed = parseAuthApiError(e, t);
      const raw = e instanceof Error ? e.message : String(e ?? parsed);
      const authPath = isTauri() ? "tauri" : "web";
      setError(`[${authPath}:${mode}] ${raw || parsed}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell title={t("auth.title")} subtitle={t("auth.subtitle")}>
      <div className="space-y-5">
        <div className="rounded-xl border border-border bg-bg-surface/40 p-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => {
              setMode("login");
              setError(null);
            }}
            className={`rounded-lg py-2 text-sm transition-colors ${mode === "login" ? "bg-neon-blue/80 text-black font-semibold" : "bg-bg-deep text-text-muted hover:text-text"}`}
          >
            {t("auth.loginTab")}
          </button>
          <button
            onClick={() => {
              setMode("signup");
              setError(null);
            }}
            className={`rounded-lg py-2 text-sm transition-colors ${mode === "signup" ? "bg-neon-blue/80 text-black font-semibold" : "bg-bg-deep text-text-muted hover:text-text"}`}
          >
            {t("auth.signupTab")}
          </button>
        </div>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-text-muted">{t("auth.email")}</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              className="w-full bg-bg-deep border border-border rounded-lg px-3 py-2"
              placeholder={t("auth.placeholder.email")}
            />
            <span className="text-[11px] text-text-muted">{t("auth.emailHint")}</span>
          </label>

          <label className="block space-y-1">
            <span className="text-xs text-text-muted">{t("auth.password")}</span>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              className="w-full bg-bg-deep border border-border rounded-lg px-3 py-2"
              placeholder={t("auth.placeholder.password")}
            />
          </label>

          {mode === "signup" && (
            <>
              <label className="block space-y-1">
                <span className="text-xs text-text-muted">{t("auth.projectNameOptional")}</span>
                <input
                  value={projectName}
                  onChange={(e) => setProjectName(e.target.value)}
                  className="w-full bg-bg-deep border border-border rounded-lg px-3 py-2"
                  placeholder={t("auth.placeholder.project")}
                />
              </label>
              <div className="rounded-lg border border-border bg-bg-surface/30 p-3 space-y-2">
                <div className="text-xs text-text-muted">{t("track.desc")}</div>
                <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-deep/70 px-3 py-2">
                  <input
                    type="radio"
                    name="billing-track"
                    checked={billingTrack === "project"}
                    onChange={() => setBillingTrack("project")}
                    className="mt-0.5"
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-text">{t("track.project")}</div>
                    <div className="text-[11px] text-text-muted">{t("track.projectDesc")}</div>
                  </div>
                </label>
                <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-deep/70 px-3 py-2">
                  <input
                    type="radio"
                    name="billing-track"
                    checked={billingTrack === "byok"}
                    onChange={() => setBillingTrack("byok")}
                    className="mt-0.5"
                  />
                  <div className="space-y-1">
                    <div className="text-sm font-medium text-text">{t("track.byok")}</div>
                    <div className="text-[11px] text-text-muted">{t("track.byokDesc")}</div>
                  </div>
                </label>
              </div>
              <div className="rounded-lg border border-border bg-bg-surface/30 px-3 py-2 text-[11px] text-text-muted">
                {billingTrack === "byok" ? t("track.byokHint") : t("track.projectHint")}
              </div>
            </>
          )}
        </div>

        {(error || externalError) && (
          <div className="text-sm text-rose-300 break-all">{error ?? externalError}</div>
        )}

        <button
          onClick={submit}
          disabled={submitting}
          className="w-full bg-neon-blue/90 text-black hover:bg-neon-blue rounded-lg py-3 font-semibold disabled:opacity-70 transition-colors"
        >
          {submitting
            ? mode === "login"
              ? t("auth.loggingIn")
              : t("auth.signingUp")
            : mode === "login"
              ? t("auth.login")
              : t("auth.signup")}
        </button>
      </div>
    </AuthShell>
  );
}

export function ProjectSelectScreen({
  projects,
  onSelectProject,
  onCreateProject,
  onOpenLlmSettings,
  selecting,
  externalError,
}: {
  projects: ProjectMembership[];
  onSelectProject: (projectId: string) => Promise<void>;
  onCreateProject: (projectName: string) => Promise<void>;
  onOpenLlmSettings: () => void;
  selecting: boolean;
  externalError: string | null;
}) {
  const { t } = useI18n();
  const [projectName, setProjectName] = useState("");
  const [creating, setCreating] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const createNew = async () => {
    if (!projectName.trim() || creating || selecting) return;
    setCreating(true);
    setLocalError(null);
    try {
      await onCreateProject(projectName.trim());
      setProjectName("");
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : t("project.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="w-full min-h-screen bg-[#0A0A10] flex items-center justify-center p-6 relative overflow-hidden text-white">
      {/* Background Ambience */}
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-600/20 blur-[120px] rounded-full pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-cyan-600/10 blur-[120px] rounded-full pointer-events-none" />

      <div className="relative w-full max-w-xl p-10 rounded-[2rem] bg-white/[0.02] border border-white/5 backdrop-blur-2xl shadow-2xl">
        <div className="text-center mb-10">
          <div
            className="font-['Press_Start_2P'] text-3xl text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-violet-400 mb-4 inline-block tracking-wider"
            style={{ textShadow: "0 4px 20px rgba(0,243,255,0.2)" }}
          >
            {t("project.title")}
          </div>
          <p className="text-gray-400 text-sm font-light">
            {t("project.subtitle")}
          </p>
          <div className="mt-4 flex flex-col items-center gap-3">
            <p className="max-w-md text-xs text-gray-500">{t("track.settingsEntryHint")}</p>
            <button
              type="button"
              onClick={onOpenLlmSettings}
              disabled={selecting || creating}
              data-testid="project-select-manage-keys"
              className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-semibold tracking-wide text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("track.manageKeys")}
            </button>
          </div>
        </div>

        <div className="space-y-8">
          {/* Project List */}
          <div className="space-y-3">
            <div className="flex items-center gap-2 px-1">
              <div className="w-1.5 h-4 bg-violet-500 rounded-full shadow-[0_0_8px_rgba(139,92,246,0.5)]" />
              <div className="text-sm font-semibold tracking-wide text-gray-200">
                {t("project.listTitle")}
              </div>
            </div>
            
            {projects.length === 0 ? (
              <div className="rounded-xl border border-white/5 bg-black/20 px-6 py-6 text-center text-sm text-gray-500 shadow-inner">
                {t("project.empty")}
              </div>
            ) : (
              <div className="space-y-3 max-h-[260px] overflow-auto pr-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                {projects.map((project) => (
                  <button
                    key={project.project_id}
                    onClick={() => onSelectProject(project.project_id)}
                    disabled={selecting || creating}
                    className="group w-full relative flex items-center justify-between text-left rounded-xl border border-white/5 bg-white/[0.03] px-5 py-4 hover:bg-white/[0.08] hover:border-violet-500/30 hover:shadow-[0_0_20px_rgba(139,92,246,0.15)] transition-all duration-300 disabled:opacity-50 overflow-hidden"
                  >
                    <div className="absolute inset-0 bg-gradient-to-r from-violet-500/0 via-violet-500/0 to-violet-500/10 translate-x-[-100%] group-hover:translate-x-0 transition-transform duration-500" />
                    <div className="relative z-10">
                      <div className="text-base font-medium text-gray-100 group-hover:text-white transition-colors">{project.project_name}</div>
                      <div className="text-[11px] text-gray-500 font-mono mt-1 tracking-wider">{project.project_id}</div>
                    </div>
                    <div className="relative z-10 w-8 h-8 rounded-full bg-white/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity transform group-hover:translate-x-0 translate-x-2">
                       <span className="text-violet-300 text-lg">→</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-gradient-to-r from-transparent via-white/10 to-transparent" />

          {/* Create Project */}
          <div className="space-y-4">
            <div className="flex items-center gap-2 px-1">
              <div className="w-1.5 h-4 bg-cyan-500 rounded-full shadow-[0_0_8px_rgba(6,182,212,0.5)]" />
              <div className="text-sm font-semibold tracking-wide text-gray-200">
                {t("project.createTitle")}
              </div>
            </div>
            <div className="relative">
              <input
                value={projectName}
                onChange={(e) => setProjectName(e.target.value)}
                placeholder={t("project.createPlaceholder")}
                className="w-full bg-black/40 border border-white/10 hover:border-white/20 focus:border-cyan-500/50 rounded-xl px-5 py-4 text-white placeholder-gray-600 outline-none shadow-inner transition-all duration-300"
              />
            </div>
            <button
              onClick={createNew}
              disabled={creating || selecting || !projectName.trim()}
              className="w-full relative overflow-hidden bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl py-3.5 font-bold tracking-wide shadow-[0_0_20px_rgba(6,182,212,0.3)] disabled:opacity-50 disabled:cursor-not-allowed transform hover:-translate-y-0.5 active:translate-y-0 transition-all duration-200"
            >
              <div className="relative z-10">{creating ? t("project.creating") : t("project.create")}</div>
              {/* Shine effect */}
              <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent group-hover:animate-[shimmer_1.5s_infinite]" />
            </button>
          </div>

          {(externalError || localError) && (
            <div className="text-sm text-center text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg p-3 break-all animate-pulse">
              {externalError ?? localError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function LobbyScreen({ onOpenLlmSettings }: { onOpenLlmSettings: () => void }) {
  const { t } = useI18n();
  const { clockIn } = useOfficeStore();
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const handleStart = async () => {
    if (isStarting) return;

    setStartError(null);
    setIsStarting(true);

    try {
      await clockIn();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : t("lobby.clockInFail"));
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <div className="w-full min-h-screen bg-[#0F0F23] flex items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full text-center">
        <div className="mx-auto max-w-xl space-y-8 p-10 rounded-3xl bg-white/[0.01] border border-white/[0.02] backdrop-blur-3xl shadow-2xl">
          <div
            className="font-['Press_Start_2P'] text-5xl text-transparent bg-clip-text bg-gradient-to-b from-cyan-300 to-cyan-500 tracking-wider inline-block"
            style={{ textShadow: "0 0 25px rgba(0,243,255,0.4)" }}
          >
            DAACS OS
          </div>

          <div className="text-gray-400 text-sm font-medium tracking-[0.2em] uppercase">{t("brand.tagline")}</div>

          <div className="mx-auto max-w-[560px] space-y-3">
            <div className="text-sm text-gray-400">{t("lobby.settingsHint")}</div>
            <button
              type="button"
              onClick={onOpenLlmSettings}
              disabled={isStarting}
              data-testid="lobby-manage-keys"
              className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-200 transition-colors hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("track.manageKeys")}
            </button>
          </div>

          <button
            onClick={handleStart}
            disabled={isStarting}
            className={`relative overflow-hidden px-10 py-4 text-white font-bold rounded-2xl text-lg transition-all duration-300 shadow-[0_0_30px_rgba(139,92,246,0.3)] ${
              isStarting
                ? "bg-violet-800/80 cursor-not-allowed border-violet-700"
                : "bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 hover:scale-105 border-t border-white/20"
            }`}
          >
            <span className="relative z-10">{isStarting ? t("lobby.starting") : t("lobby.clockIn")}</span>
          </button>

          {startError && (
            <div className="text-sm text-rose-400 max-w-[560px] mx-auto break-all bg-rose-500/10 p-3 rounded-xl border border-rose-500/20">
              {startError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function MainApp() {
  const { t } = useI18n();
  const isUiOnlyMode = import.meta.env?.DEV === true && import.meta.env?.VITE_UI_ONLY === "true";
  const skippedFetchMeApplyRef = useRef(false);
  const [authChecked, setAuthChecked] = useState<boolean>(isUiOnlyMode);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authedUser, setAuthedUser] = useState<AuthResponse["user"] | null>(null);
  const [projectMemberships, setProjectMemberships] = useState<ProjectMembership[]>([]);
  const [projectSelecting, setProjectSelecting] = useState(false);
  const [showLlmSettingsModal, setShowLlmSettingsModal] = useState(false);

  const { projectId, gameState, setProjectId, clockOut } = useOfficeStore();
  const runtimeBundle = useWorkflowStore((state) => state.runtimeBundle);

  const applyAuth = useCallback(
    (res: AuthResponse, source: AuthSource = "login") => {
      setAuthedUser(res.user);
      setProjectMemberships(res.memberships ?? []);
      setAuthToken(res.access_token);
      persistBillingTrack(res.user.billing_track);

      setAuthError(null);
      if (source === "session_restore") {
        const saved = readStoredActiveProject();
        if (saved && (res.memberships ?? []).some((m) => m.project_id === saved)) {
          setProjectId(saved);
        }
      } else {
        setProjectId(null);
        persistActiveProject(null);
      }
    },
    [setProjectId],
  );

  const handleDevLogin = useCallback(() => {
    skippedFetchMeApplyRef.current = true;
    setLocalDevApiStubEnabled(true);
    applyAuth(buildDevAuthResponse(), "login");
    setAuthChecked(true);
    setAuthError(null);
  }, [applyAuth]);

  const onDevLoginForBar = !isUiOnlyMode && authedUser == null ? handleDevLogin : undefined;

  useEffect(() => {
    if (isUiOnlyMode) return;
    let cancelled = false;
    void restoreSessionAuth({
      fetchMeFn: fetchMe,
      skippedFetchMeApplyRef,
      applyAuth,
      clearAuthStorageFn: clearAuthStorage,
      setAuthedUser,
      setProjectMemberships,
      setAuthError,
      setAuthChecked,
      t,
      isCancelled: () => cancelled,
    });
    return () => {
      cancelled = true;
    };
  }, [applyAuth, isUiOnlyMode, t]);

  useEffect(() => {
    useOfficeStore.getState().syncRuntimeBundle(runtimeBundle);
  }, [runtimeBundle]);

  useEffect(() => {
    resetAuthScopedLlmSettingsUi(setShowLlmSettingsModal);
  }, [authedUser?.id]);

  useEffect(() => {
    const preOfficeSurfaceVisible =
      (authedUser != null && projectId == null) || gameState === "LOBBY";
    if (!preOfficeSurfaceVisible && showLlmSettingsModal) {
      setShowLlmSettingsModal(false);
    }
  }, [authedUser, gameState, projectId, showLlmSettingsModal]);

  const logout = async () => {
    try {
      if (gameState !== "LOBBY") {
        await clockOut();
      }
    } catch {
      // best effort
    }
    try {
      await apiLogout();
    } catch {
      // best effort
    }
    clearAuthStorage();
    setAuthedUser(null);
    setProjectMemberships([]);
    setAuthError(null);
    setProjectId(null);
    persistActiveProject(null);
    setAuthChecked(true);
  };

  const selectProject = useCallback(
    async (nextProjectId: string) => {
      if (!nextProjectId || projectSelecting) return;
      setProjectSelecting(true);
      setAuthError(null);
      try {
        if (gameState !== "LOBBY") {
          await clockOut();
        }
      } catch {
        // best effort
      } finally {
        setProjectId(nextProjectId);
        persistActiveProject(nextProjectId);
        setProjectSelecting(false);
      }
    },
    [clockOut, gameState, projectSelecting, setProjectId],
  );

  const createAndSelectProject = useCallback(
    async (projectName: string) => {
      const created = await createProject(projectName);
      setProjectMemberships((prev) => [created, ...prev.filter((p) => p.project_id !== created.project_id)]);
      await selectProject(created.project_id);
    },
    [selectProject],
  );

  if (!isUiOnlyMode) {
    if (!authChecked) {
      return (
        <>
          <TopBar showLogout={false} onDevLogin={onDevLoginForBar} />
          <div className="w-full h-screen bg-[#0F0F23] flex items-center justify-center text-gray-300">
            {t("auth.loading")}
          </div>
          <CliLogPanel />
        </>
      );
    }

    if (!authedUser) {
      return (
        <>
          <TopBar showLogout={false} onDevLogin={onDevLoginForBar} />
          <AuthScreen onAuthenticated={applyAuth} externalError={authError} />
          <CliLogPanel />
        </>
      );
    }

    if (!projectId) {
      return (
        <>
          <TopBar showLogout onLogout={logout} onDevLogin={onDevLoginForBar} />
          <ProjectSelectScreen
            projects={projectMemberships}
            onSelectProject={selectProject}
            onCreateProject={createAndSelectProject}
            onOpenLlmSettings={() => setShowLlmSettingsModal(true)}
            selecting={projectSelecting}
            externalError={authError}
          />
          <LlmSettingsModal open={showLlmSettingsModal} onClose={() => setShowLlmSettingsModal(false)} />
          <CliLogPanel />
        </>
      );
    }
  }

  if (gameState === "LOBBY") {
    return (
      <>
        <TopBar
          showLogout={!isUiOnlyMode}
          onLogout={!isUiOnlyMode ? logout : undefined}
          onDevLogin={onDevLoginForBar}
        />
        <LobbyScreen onOpenLlmSettings={() => setShowLlmSettingsModal(true)} />
        <LlmSettingsModal open={showLlmSettingsModal} onClose={() => setShowLlmSettingsModal(false)} />
        <CliLogPanel />
      </>
    );
  }

  return (
    <>
      <TopBar
        showLogout={!isUiOnlyMode}
        onLogout={!isUiOnlyMode ? logout : undefined}
        onDevLogin={onDevLoginForBar}
        showLocaleToggle={false}
      />
      <OfficeScene onLogout={logout} showLogout={!isUiOnlyMode} />
      <CliLogPanel />
    </>
  );
}

export default function App() {
  return <MainApp />;
}
