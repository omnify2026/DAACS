/* eslint-disable react-hooks/set-state-in-effect */
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  extractPromptFileBasename,
  isDefaultAgentMetadataId,
  mergeAgentsIntoMetadataRoot,
  normalizeAgentsMetadataEntryFromFields,
  type AgentsMetadataEntry,
} from "../../lib/agentsMetadata";
import { useI18n } from "../../i18n";
import { parsePromptDocFromJson, serializePromptDocForJson } from "../../lib/promptDoc";
import type { AgentRole } from "../../types/agent";
import { getBundledPromptTextByKeySync, readPromptFileByKey, savePromptFileByKey } from "../../services/tauriCli";
import { AgentCharacterVisualEditor } from "./AgentCharacterVisualEditor";
import { AgentCharacterStaticPreview } from "./AgentSprite";

export type AgentMetadataDetailViewProps = {
  originalAgentId: string;
  agents: AgentsMetadataEntry[];
  metadataRoot: Record<string, unknown>;
  canPersist: boolean;
  onBack: () => void;
  onPersist: (
    nextAgents: AgentsMetadataEntry[],
    nextRoot: Record<string, unknown>,
    selectedIdAfter: string,
  ) => Promise<void>;
};

function cloneEntry(entry: AgentsMetadataEntry): AgentsMetadataEntry {
  return {
    ...entry,
    skill_bundle_refs: [...entry.skill_bundle_refs],
  };
}

export function AgentMetadataDetailView({
  originalAgentId,
  agents,
  metadataRoot,
  canPersist,
  onBack,
  onPersist,
}: AgentMetadataDetailViewProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<AgentsMetadataEntry | null>(null);
  const [newSkill, setNewSkill] = useState("");
  const [formError, setFormError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [saveMessage, setSaveMessage] = useState("");
  const [characterEditOpen, setCharacterEditOpen] = useState(false);
  const [promptDescription, setPromptDescription] = useState("");
  const [promptContentText, setPromptContentText] = useState("");
  const [promptLoadState, setPromptLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [promptLoadError, setPromptLoadError] = useState("");
  const [promptSaveState, setPromptSaveState] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [promptSaveMessage, setPromptSaveMessage] = useState("");

  const baseline = useMemo(
    () => agents.find((a) => a.id === originalAgentId) ?? null,
    [agents, originalAgentId],
  );

  useEffect(() => {
    if (baseline == null) {
      setDraft(null);
      return;
    }
    setDraft(cloneEntry(baseline));
    setFormError("");
    setSaveState("idle");
    setSaveMessage("");
    setPromptLoadError("");
    setPromptSaveMessage("");
    setPromptSaveState("idle");
  }, [baseline, originalAgentId]);

  const promptKey = draft?.prompt_key.trim() ?? "";

  useEffect(() => {
    if (promptKey === "") {
      setPromptDescription("");
      setPromptContentText("");
      setPromptLoadState("idle");
      setPromptLoadError("");
      return;
    }
    const key = promptKey;
    if (!canPersist) {
      const text = getBundledPromptTextByKeySync(key);
      setPromptDescription("");
      setPromptContentText(text);
      setPromptLoadState("ready");
      setPromptLoadError("");
      return;
    }
    let cancelled = false;
    setPromptLoadState("loading");
    setPromptLoadError("");
    void readPromptFileByKey(key)
      .then((raw) => {
        if (cancelled) return;
        const parsed = parsePromptDocFromJson(raw);
        setPromptDescription(parsed.description);
        setPromptContentText(parsed.contentText);
        setPromptLoadState("ready");
      })
      .catch((exc) => {
        if (cancelled) return;
        setPromptLoadState("error");
        setPromptLoadError(exc instanceof Error ? exc.message : String(exc));
      });
    return () => {
      cancelled = true;
    };
  }, [promptKey, canPersist, baseline?.id]);

  const promptLabel = useMemo(() => {
    if (draft == null) return "";
    return extractPromptFileBasename(draft.prompt_file);
  }, [draft]);

  const roleForPreview = (draft?.office_role ?? "pm") as AgentRole;

  const openCharacterEditor = useCallback(() => {
    setCharacterEditOpen(true);
  }, []);

  const handleSavePrompt = useCallback(async () => {
    if (draft == null || !canPersist || draft.prompt_key.trim() === "" || isDefaultAgentMetadataId(originalAgentId)) return;
    setPromptSaveState("saving");
    setPromptSaveMessage("");
    try {
      const json = serializePromptDocForJson(promptDescription, promptContentText);
      await savePromptFileByKey(draft.prompt_key.trim(), json);
      setPromptSaveState("ok");
      setPromptSaveMessage(t("agentsMetadataEditor.detail.savedPrompt"));
    } catch (exc) {
      setPromptSaveState("error");
      setPromptSaveMessage(exc instanceof Error ? exc.message : String(exc));
    }
  }, [canPersist, draft, originalAgentId, promptContentText, promptDescription, t]);

  const handleSaveMetadata = useCallback(async () => {
    if (draft == null || isDefaultAgentMetadataId(originalAgentId)) return;
    setFormError("");
    setSaveMessage("");
    const normalized = normalizeAgentsMetadataEntryFromFields({
      id: draft.id,
      display_name: draft.display_name,
      summary: draft.summary,
      office_role: draft.office_role,
      prompt_key: draft.prompt_key,
      prompt_file: draft.prompt_file,
      skill_bundle_role: draft.skill_bundle_role,
      skill_bundle_refs: draft.skill_bundle_refs,
      character: draft.character ?? "",
    });
    if (normalized == null) {
      setFormError(t("agentsMetadataEditor.detail.validation.required"));
      return;
    }
    const idx = agents.findIndex((a) => a.id === originalAgentId);
    if (idx < 0) {
      setFormError(t("agentsMetadataEditor.detail.validation.missingAgent"));
      return;
    }
    if (normalized.id !== originalAgentId) {
      const clash = agents.some((a, i) => i !== idx && a.id === normalized.id);
      if (clash) {
        setFormError(t("agentsMetadataEditor.detail.validation.duplicateId"));
        return;
      }
    }
    if (!canPersist) {
      setFormError(t("agentsMetadataEditor.detail.saveNeedsDesktop"));
      return;
    }
    const nextAgents = agents.map((a, i) => (i === idx ? normalized : a));
    const nextRoot = mergeAgentsIntoMetadataRoot(metadataRoot, nextAgents);
    setSaveState("saving");
    try {
      await onPersist(nextAgents, nextRoot, normalized.id);
      setSaveState("ok");
      setSaveMessage(t("agentsMetadataEditor.detail.saved"));
    } catch (exc) {
      setSaveState("error");
      setSaveMessage(exc instanceof Error ? exc.message : String(exc));
    }
  }, [agents, canPersist, draft, metadataRoot, onPersist, originalAgentId, t]);

  const addSkill = useCallback(() => {
    if (isDefaultAgentMetadataId(originalAgentId)) return;
    const s = newSkill.trim();
    if (s === "" || draft == null) return;
    if (draft.skill_bundle_refs.includes(s)) {
      setNewSkill("");
      return;
    }
    setDraft({ ...draft, skill_bundle_refs: [...draft.skill_bundle_refs, s] });
    setNewSkill("");
  }, [draft, newSkill, originalAgentId]);

  const removeSkillAt = useCallback((index: number) => {
    if (isDefaultAgentMetadataId(originalAgentId)) return;
    setDraft((d) => {
      if (d == null) return d;
      const next = d.skill_bundle_refs.filter((_, i) => i !== index);
      return { ...d, skill_bundle_refs: next };
    });
  }, [originalAgentId]);

  const updateSkillAt = useCallback((index: number, value: string) => {
    if (isDefaultAgentMetadataId(originalAgentId)) return;
    setDraft((d) => {
      if (d == null) return d;
      const next = [...d.skill_bundle_refs];
      next[index] = value;
      return { ...d, skill_bundle_refs: next };
    });
  }, [originalAgentId]);

  if (draft == null) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <button
          type="button"
          onClick={onBack}
          className="self-start flex items-center gap-2 rounded-lg border border-[#2A2A4A] px-3 py-2 text-xs text-gray-200 hover:bg-white/5"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("agentsMetadataEditor.detail.back")}
        </button>
        <p className="text-sm text-rose-300">{t("agentsMetadataEditor.detail.notFound")}</p>
      </div>
    );
  }

  const defaultAgentLocked = isDefaultAgentMetadataId(originalAgentId);

  return (
    <div className="relative flex flex-1 min-h-0 flex-col">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-[#2A2A4A]/80 px-3 py-2 sm:px-4">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-2 rounded-lg border border-[#2A2A4A] px-3 py-2 text-xs text-gray-200 hover:bg-white/5"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("agentsMetadataEditor.detail.back")}
        </button>
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-cyan-200 truncate sm:text-base">
          {draft.display_name}
        </h2>
        <button
          type="button"
          disabled={!canPersist || saveState === "saving" || defaultAgentLocked}
          onClick={() => void handleSaveMetadata()}
          className="rounded-lg bg-cyan-600/80 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500/90 disabled:opacity-40"
        >
          {saveState === "saving"
            ? t("agentsMetadataEditor.detail.saving")
            : t("agentsMetadataEditor.detail.save")}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6">
        {defaultAgentLocked && (
          <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100/95">
            {t("agentsMetadataEditor.detail.defaultAgentReadOnly")}
          </p>
        )}
        {formError !== "" && (
          <p className="mb-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {formError}
          </p>
        )}
        {saveMessage !== "" && (
          <p
            className={`mb-3 rounded-lg border px-3 py-2 text-xs ${
              saveState === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-rose-500/30 bg-rose-500/10 text-rose-200"
            }`}
          >
            {saveMessage}
          </p>
        )}

        <div className="mx-auto grid max-w-3xl gap-6">
          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {t("agentsMetadataEditor.detail.promptFile")}
            </h3>
            <p className="mt-2 font-mono text-sm text-cyan-300/95">{promptLabel || "—"}</p>
          </section>

          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
                {t("agentsMetadataEditor.detail.characterPreview")}
              </h3>
              <button
                type="button"
                onClick={openCharacterEditor}
                className="rounded-lg border border-[#2A2A4A] px-3 py-1.5 text-[11px] text-gray-200 hover:bg-white/5"
              >
                {t("agentsMetadataEditor.detail.editCharacter")}
              </button>
            </div>
            <div className="mt-4 flex justify-center rounded-lg border border-[#2A2A4A]/60 bg-[#050810]/60 py-6">
              <div className="origin-top scale-[1.65]">
                <AgentCharacterStaticPreview
                  role={roleForPreview}
                  characterFilename={draft.character ?? null}
                />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {t("agentsMetadataEditor.detail.summary")}
            </h3>
            <textarea
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
              readOnly={defaultAgentLocked}
              rows={4}
              className={`mt-2 w-full resize-y rounded-lg border border-[#2A2A4A] bg-[#050810] px-3 py-2 text-sm text-gray-200 placeholder:text-gray-600 focus:border-cyan-500/50 focus:outline-none ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
            />
          </section>

          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {t("agentsMetadataEditor.detail.skills")}
            </h3>
            <ul className="mt-3 space-y-2">
              {draft.skill_bundle_refs.map((skillId, index) => (
                <li key={`${skillId}-${index}`} className="flex gap-2">
                  <input
                    value={skillId}
                    onChange={(e) => updateSkillAt(index, e.target.value)}
                    readOnly={defaultAgentLocked}
                    className={`min-w-0 flex-1 rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-1.5 font-mono text-xs text-gray-300 ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                  />
                  {!defaultAgentLocked && (
                    <button
                      type="button"
                      onClick={() => removeSkillAt(index)}
                      className="shrink-0 rounded-lg border border-rose-500/30 p-2 text-rose-300 hover:bg-rose-500/10"
                      aria-label={t("agentsMetadataEditor.detail.removeSkill")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!defaultAgentLocked && (
              <div className="mt-3 flex gap-2">
                <input
                  value={newSkill}
                  onChange={(e) => setNewSkill(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addSkill();
                    }
                  }}
                  placeholder={t("agentsMetadataEditor.detail.newSkillPlaceholder")}
                  className="min-w-0 flex-1 rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-1.5 font-mono text-xs text-gray-300"
                />
                <button
                  type="button"
                  onClick={addSkill}
                  className="flex shrink-0 items-center gap-1 rounded-lg border border-[#2A2A4A] px-3 py-1.5 text-xs text-gray-200 hover:bg-white/5"
                >
                  <Plus className="h-4 w-4" />
                  {t("agentsMetadataEditor.detail.addSkill")}
                </button>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {t("agentsMetadataEditor.detail.promptEditorSection")}
            </h3>
            {!canPersist && draft.prompt_key.trim() === "" && (
              <p className="mt-2 text-[10px] text-amber-200/90">{t("agentsMetadataEditor.detail.promptKeyMissing")}</p>
            )}
            {!canPersist && draft.prompt_key.trim() !== "" && promptLoadState === "ready" && (
              <div className="mt-3 space-y-2">
                <label className="block text-[10px] text-gray-500">
                  {t("agentsMetadataEditor.detail.promptBundledBody")}
                  <textarea
                    value={promptContentText}
                    readOnly
                    rows={14}
                    className="mt-1 w-full resize-y rounded-lg border border-[#2A2A4A] bg-[#050810]/80 px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-300 min-h-[12rem] opacity-90 cursor-default"
                  />
                </label>
                <p className="text-[10px] text-gray-500 leading-relaxed">{t("agentsMetadataEditor.detail.promptBundledSyncHint")}</p>
              </div>
            )}
            {canPersist && draft.prompt_key.trim() === "" && (
              <p className="mt-2 text-[10px] text-amber-200/90">{t("agentsMetadataEditor.detail.promptKeyMissing")}</p>
            )}
            {canPersist && draft.prompt_key.trim() !== "" && promptLoadState === "loading" && (
              <p className="mt-3 text-xs text-gray-400">{t("agentsMetadataEditor.detail.loadingPrompt")}</p>
            )}
            {canPersist && draft.prompt_key.trim() !== "" && promptLoadState === "error" && (
              <p className="mt-3 text-xs text-rose-300">{promptLoadError}</p>
            )}
            {canPersist && draft.prompt_key.trim() !== "" && promptLoadState === "ready" && (
              <div className="mt-3 space-y-3">
                <label className="block text-[10px] text-gray-500">
                  {t("agentsMetadataEditor.detail.promptDescription")}
                  <input
                    value={promptDescription}
                    onChange={(e) => setPromptDescription(e.target.value)}
                    readOnly={defaultAgentLocked}
                    className={`mt-1 w-full rounded-lg border border-[#2A2A4A] bg-[#050810] px-3 py-2 text-xs text-gray-200 ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                  />
                </label>
                <label className="block text-[10px] text-gray-500">
                  {t("agentsMetadataEditor.detail.promptContent")}
                  <textarea
                    value={promptContentText}
                    onChange={(e) => setPromptContentText(e.target.value)}
                    readOnly={defaultAgentLocked}
                    rows={14}
                    className={`mt-1 w-full resize-y rounded-lg border border-[#2A2A4A] bg-[#050810] px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-200 focus:border-cyan-500/50 focus:outline-none min-h-[12rem] ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                  />
                </label>
                {!defaultAgentLocked && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={promptSaveState === "saving"}
                      onClick={() => void handleSavePrompt()}
                      className="rounded-lg bg-cyan-600/80 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500/90 disabled:opacity-40"
                    >
                      {promptSaveState === "saving"
                        ? t("agentsMetadataEditor.detail.savingPrompt")
                        : t("agentsMetadataEditor.detail.savePrompt")}
                    </button>
                  </div>
                )}
                {!defaultAgentLocked && promptSaveMessage !== "" && (
                  <p
                    className={`text-[10px] ${
                      promptSaveState === "ok" ? "text-emerald-300/90" : "text-rose-300"
                    }`}
                  >
                    {promptSaveMessage}
                  </p>
                )}
                {!defaultAgentLocked && (
                  <p className="text-[10px] text-gray-500 leading-relaxed">
                    {t("agentsMetadataEditor.detail.promptEditorHint")}
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-[#2A2A4A] bg-[#0b1220]/80 p-4">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-gray-500">
              {t("agentsMetadataEditor.detail.fields")}
            </h3>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="block text-[10px] text-gray-500">
                {t("agentsMetadataEditor.card.id")}
                <input
                  value={draft.id}
                  onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                  readOnly={defaultAgentLocked}
                  className={`mt-1 w-full rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-1.5 font-mono text-xs text-cyan-300 ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                />
              </label>
              <label className="block text-[10px] text-gray-500">
                {t("agentsMetadataEditor.detail.displayName")}
                <input
                  value={draft.display_name}
                  onChange={(e) => setDraft({ ...draft, display_name: e.target.value })}
                  readOnly={defaultAgentLocked}
                  className={`mt-1 w-full rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-1.5 text-xs text-gray-200 ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                />
              </label>
              <label className="block text-[10px] text-gray-500 sm:col-span-2">
                {t("agentsMetadataEditor.detail.officeRole")}
                <input
                  value={draft.office_role}
                  onChange={(e) => setDraft({ ...draft, office_role: e.target.value })}
                  readOnly={defaultAgentLocked}
                  className={`mt-1 w-full rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-1.5 font-mono text-xs text-gray-300 ${defaultAgentLocked ? "opacity-70 cursor-not-allowed" : ""}`}
                />
              </label>
            </div>
          </section>
        </div>
      </div>

      <AnimatePresence>
        {characterEditOpen && (
          <motion.div
            className="absolute inset-0 z-[80] flex items-end justify-center sm:items-center p-3 bg-[#050810]/90 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              className="flex max-h-[min(92vh,800px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2A2A4A] bg-[#0a0f18] shadow-xl"
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 20, opacity: 0 }}
            >
              <div className="flex shrink-0 items-center justify-between border-b border-[#2A2A4A] px-4 py-3">
                <h3 className="text-sm font-semibold text-cyan-200">
                  {t("agentsMetadataEditor.detail.visualEditor.title")}
                </h3>
                <button
                  type="button"
                  onClick={() => setCharacterEditOpen(false)}
                  className="rounded-lg p-2 text-gray-400 hover:bg-white/10 hover:text-white"
                  aria-label={t("agentsMetadataEditor.close")}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <AgentCharacterVisualEditor
                  characterFilename={draft.character?.trim() ?? ""}
                  fallbackRole={roleForPreview}
                  onClose={() => setCharacterEditOpen(false)}
                />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
