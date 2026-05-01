import { create } from "zustand";
import {
  fetchByokStatus,
  saveByokKeys,
  type BillingTrack,
} from "../services/agentApi";
import type { ApiErrorShape } from "../services/httpClient";

interface LlmSettingsState {
  billingTrack: BillingTrack | null;
  hasClaudeKey: boolean;
  hasOpenAiKey: boolean;
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  saveError: string | null;

  fetchSettings: () => Promise<void>;
  saveSettings: (claudeKey: string, openAiKey: string) => Promise<boolean>;
  clearErrors: () => void;
  reset: () => void;
}

const INITIAL_LLM_SETTINGS_STATE = {
  billingTrack: "project",
  hasClaudeKey: false,
  hasOpenAiKey: false,
  isLoading: false,
  error: null,
  isSaving: false,
  saveError: null,
} satisfies Pick<
  LlmSettingsState,
  "billingTrack" | "hasClaudeKey" | "hasOpenAiKey" | "isLoading" | "error" | "isSaving" | "saveError"
>;

let llmSettingsLifecycleVersion = 0;

function normalizeBillingTrack(value: unknown): BillingTrack {
  return typeof value === "string" && value.trim().toLowerCase() === "byok" ? "byok" : "project";
}

function parseStructuredErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Record<string, unknown>;
  const directMessage =
    typeof candidate.detail === "string"
      ? candidate.detail
      : typeof candidate.message === "string"
        ? candidate.message
        : typeof candidate.error === "string"
          ? candidate.error
          : null;

  if (directMessage && directMessage.trim()) {
    return directMessage.trim();
  }

  return null;
}

function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  const structuredMessage = parseStructuredErrorMessage(error);
  if (structuredMessage) {
    return structuredMessage;
  }

  const apiError =
    error && typeof error === "object" && "body" in error ? (error as Partial<ApiErrorShape> & { body?: unknown }) : null;
  if (typeof apiError?.body === "string" && apiError.body.trim()) {
    try {
      const parsed = JSON.parse(apiError.body) as unknown;
      const parsedMessage = parseStructuredErrorMessage(parsed);
      if (parsedMessage) {
        return parsedMessage;
      }
    } catch {
      return apiError.body.trim();
    }

    return apiError.body.trim();
  }

  return fallback;
}

export const useLlmSettingsStore = create<LlmSettingsState>((set) => ({
  ...INITIAL_LLM_SETTINGS_STATE,

  fetchSettings: async () => {
    const requestVersion = llmSettingsLifecycleVersion;
    set({
      isLoading: true,
      error: null,
      saveError: null,
    });
    try {
      const status = await fetchByokStatus();
      if (requestVersion !== llmSettingsLifecycleVersion) {
        return;
      }
      set({
        billingTrack: normalizeBillingTrack(status.billing_track),
        hasClaudeKey: status.byok_has_claude_key,
        hasOpenAiKey: status.byok_has_openai_key,
        isLoading: false,
        error: null,
        saveError: null,
      });
    } catch (e) {
      if (requestVersion !== llmSettingsLifecycleVersion) {
        return;
      }
      const msg = getApiErrorMessage(e, "Failed to load BYOK settings");
      set({
        error: msg,
        isLoading: false,
      });
    }
  },

  saveSettings: async (claudeKey: string, openAiKey: string) => {
    const requestVersion = llmSettingsLifecycleVersion;
    set({
      isSaving: true,
      error: null,
      saveError: null,
    });
    try {
      const response = await saveByokKeys({
        ...(claudeKey.trim() ? { byok_claude_key: claudeKey.trim() } : {}),
        ...(openAiKey.trim() ? { byok_openai_key: openAiKey.trim() } : {}),
      });
      if (requestVersion !== llmSettingsLifecycleVersion) {
        return false;
      }
      set({
        billingTrack: normalizeBillingTrack(response.billing_track),
        hasClaudeKey: response.byok_has_claude_key,
        hasOpenAiKey: response.byok_has_openai_key,
        isSaving: false,
        error: null,
        saveError: null,
      });
      return true;
    } catch (e) {
      if (requestVersion !== llmSettingsLifecycleVersion) {
        return false;
      }
      const msg = getApiErrorMessage(e, "Failed to save BYOK settings");
      set({
        saveError: msg,
        isSaving: false,
      });
      return false;
    }
  },

  clearErrors: () => set({ error: null, saveError: null }),

  reset: () => {
    llmSettingsLifecycleVersion += 1;
    set({ ...INITIAL_LLM_SETTINGS_STATE });
  },
}));
