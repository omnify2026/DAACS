/* eslint-disable react-hooks/set-state-in-effect */
import React, { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { X, Check, AlertCircle, Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { useLlmSettingsStore } from "../../stores/llmSettingsStore";
void React;

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Canonical auth/BYOK settings modal */
export function LlmSettingsModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const {
    billingTrack,
    hasClaudeKey,
    hasOpenAiKey,
    isLoading,
    error,
    isSaving,
    saveError,
    fetchSettings,
    saveSettings,
    clearErrors,
  } = useLlmSettingsStore();

  const [claudeKey, setClaudeKey] = useState("");
  const [openAiKey, setOpenAiKey] = useState("");
  const [saved, setSaved] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) return;
    void fetchSettings();
    clearErrors();
    setSaved(false);
    setClaudeKey("");
    setOpenAiKey("");
  }, [open, fetchSettings, clearErrors]);

  useEffect(() => {
    if (!open || typeof document === "undefined") return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleSave = async () => {
    setSaved(false);
    const ok = await saveSettings(claudeKey, openAiKey);
    if (!ok) return;
    setSaved(true);
    setClaudeKey("");
    setOpenAiKey("");
    window.setTimeout(() => setSaved(false), 2000);
  };

  const isValid = claudeKey.trim().length > 0 || openAiKey.trim().length > 0;
  const isSaveUnavailable = !isValid || isSaving;

  const handleOverlayKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const focusables = overlayRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    );

    if (!focusables || focusables.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;

    if (event.shiftKey) {
      if (active === first || active === overlayRef.current) {
        event.preventDefault();
        last.focus();
      }
      return;
    }

    if (active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/80 p-3 backdrop-blur-sm sm:p-4 lg:p-6"
      data-testid="llm-settings-modal"
      data-office-overlay="true"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onKeyDown={handleOverlayKeyDown}
    >
      <div
        className="relative z-[141] flex max-h-[calc(100vh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#374151] bg-[#111827] text-white shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#374151] px-5 py-4">
          <div>
            <h3 id={titleId} className="text-lg font-bold">{t("byok.title")}</h3>
            <p id={descriptionId} className="mt-1 text-sm text-gray-400">{t("byok.subtitle")}</p>
          </div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            data-testid="llm-settings-close"
            className="rounded-lg border border-[#374151] p-2 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
          <div className="rounded-lg border border-[#374151] bg-[#1F2937] px-3 py-2 text-sm text-gray-300">
            <div className="flex items-center justify-between gap-3">
              <span className="font-medium">{t("auth.billingTrack")}</span>
              <span className="rounded-full border border-[#4B5563] px-2 py-0.5 text-xs uppercase tracking-wide text-gray-200">
                {billingTrack ?? t("common.unknown")}
              </span>
            </div>
          </div>

          {isLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("llm.settings.loading")}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-[#374151] bg-[#1F2937] px-3 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Claude</div>
              <div className="mt-2 text-sm text-gray-200">
                {hasClaudeKey ? t("llm.settings.status.configured") : t("llm.settings.status.missing")}
              </div>
            </div>
            <div className="rounded-lg border border-[#374151] bg-[#1F2937] px-3 py-3">
              <div className="text-xs font-medium uppercase tracking-wide text-gray-500">OpenAI</div>
              <div className="mt-2 text-sm text-gray-200">
                {hasOpenAiKey ? t("llm.settings.status.configured") : t("llm.settings.status.missing")}
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">{t("byok.claude")}</label>
            <input
              type="password"
              value={claudeKey}
              onChange={(e) => setClaudeKey(e.target.value)}
              placeholder={t("byok.placeholder.claude")}
              data-testid="llm-settings-claude-input"
              className="w-full rounded-lg border border-[#374151] bg-[#1F2937] px-3 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-amber-500/50"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-300">{t("byok.openai")}</label>
            <input
              type="password"
              value={openAiKey}
              onChange={(e) => setOpenAiKey(e.target.value)}
              placeholder={t("byok.placeholder.openai")}
              data-testid="llm-settings-openai-input"
              className="w-full rounded-lg border border-[#374151] bg-[#1F2937] px-3 py-2.5 text-sm text-white placeholder-gray-500 outline-none focus:border-amber-500/50"
            />
          </div>

          {!isValid && (
            <div className="text-xs text-gray-500">{t("byok.required")}</div>
          )}

          {saveError && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {saveError}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-[#374151] px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg border border-[#374151] px-4 py-2 text-sm text-gray-300 transition-colors hover:bg-white/5"
          >
            {t("llm.settings.cancel")}
          </button>
          <button
            onClick={() => {
              if (isSaveUnavailable) return;
              void handleSave();
            }}
            aria-disabled={isSaveUnavailable}
            data-testid="llm-settings-save"
            className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
              isSaveUnavailable
                ? "cursor-not-allowed bg-amber-600/50 opacity-60"
                : "bg-amber-600 hover:bg-amber-500"
            }`}
          >
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {saved && <Check className="h-4 w-4" />}
            {saved ? t("byok.saved") : t("byok.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
