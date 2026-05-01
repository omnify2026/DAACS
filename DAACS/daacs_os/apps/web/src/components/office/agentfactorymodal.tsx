import { X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { hydrateCharacterVisualsFromTauri } from "../../lib/characterVisuals";
import { ensureUserCharacterFileStub } from "../../lib/factoryCharacterFile";
import { findAgentMetadataByIdSync } from "../../lib/agentsMetadata";
import { useI18n } from "../../i18n";
import { isTauri } from "../../services/tauriCli";
import { useOfficeStore } from "../../stores/officeStore";
import type { AgentRole } from "../../types/agent";
import { AgentCharacterVisualEditor } from "./AgentCharacterVisualEditor";
import { AgentFactoryBriefStep } from "./AgentFactoryBriefStep";
import { AgentFactoryEditStep } from "./AgentFactoryEditStep";
import { AgentFactoryPreviewStep } from "./AgentFactoryPreviewStep";
import { StepPill } from "./agentFactoryShared";
import { useAgentFactoryDraft } from "./useAgentFactoryDraft";

interface Props {
  open: boolean;
  onClose: () => void;
  overlayZClass?: string;
}

export function AgentFactoryModal({ open, onClose, overlayZClass = "z-50" }: Props) {
  const { t } = useI18n();
  const { projectId, addNotification, addCustomAgentLocal, clockIn } = useOfficeStore();
  const [characterEditorOpen, setCharacterEditorOpen] = useState(false);
  const [characterEditorFilename, setCharacterEditorFilename] = useState("");
  const factory = useAgentFactoryDraft({
    open,
    t,
    projectId,
    addNotification,
    addCustomAgentLocal,
    clockIn,
    onClose,
  });

  const characterFilenameForPreview = useMemo(() => {
    const id = factory.draft.blueprint.role_label.trim();
    if (id === "") return null;
    const meta = findAgentMetadataByIdSync(id);
    const f = meta?.character?.trim();
    return f != null && f !== "" ? f : `${id}Data.json`;
  }, [factory.draft.blueprint.role_label]);

  const previewRole = factory.draft.previewAgent.role as AgentRole;

  const openCharacterCustomize = useCallback(async () => {
    if (!isTauri()) {
      addNotification({ type: "warning", message: t("factory.characterCustomizeDesktopOnly") });
      return;
    }
    const id = factory.draft.blueprint.role_label.trim();
    if (id === "") {
      addNotification({ type: "warning", message: t("factory.characterCustomizeNeedRole") });
      return;
    }
    const meta = findAgentMetadataByIdSync(id);
    const file = (meta?.character?.trim() || `${id}Data.json`).trim();
    try {
      await ensureUserCharacterFileStub(file, id, previewRole);
      await hydrateCharacterVisualsFromTauri();
    } catch {
      addNotification({ type: "error", message: t("factory.characterCustomizeStubFailed") });
      return;
    }
    setCharacterEditorFilename(file);
    setCharacterEditorOpen(true);
  }, [addNotification, factory.draft.blueprint.role_label, previewRole, t]);

  if (!open) return null;

  return (
    <div
      className={`fixed inset-0 flex items-center justify-center bg-black/60 p-3 sm:p-4 lg:p-6 ${overlayZClass}`}
    >
      <div className="relative flex max-h-[calc(100vh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-[#374151] bg-[#111827] text-white shadow-2xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-[#374151] px-4 py-4 sm:px-5">
          <div>
            <h3 className="text-lg font-bold">{t("factory.title")}</h3>
            <p className="mt-1 text-sm text-gray-400">{t("factory.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#374151] p-2 text-gray-300 transition-colors hover:bg-white/5 hover:text-white"
            aria-label={t("factory.cancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="mb-5 flex flex-wrap gap-2">
            <StepPill label={t("factory.step.brief")} active={factory.state.step === "brief"} />
            <StepPill label={t("factory.step.edit")} active={factory.state.step === "edit"} />
            <StepPill label={t("factory.step.preview")} active={factory.state.step === "preview"} />
          </div>

          {factory.state.step === "brief" ? (
            <AgentFactoryBriefStep
              t={t}
              brief={factory.state.brief}
              aiAvailable={factory.aiAvailable}
              onBriefChange={(brief) => factory.patchState({ brief })}
              onExampleClick={(brief) => factory.patchState({ brief })}
              onManualDesign={factory.startManualDesign}
            />
          ) : null}

          {factory.state.step === "edit" ? (
            <AgentFactoryEditStep
              t={t}
              aiSuggestion={factory.aiSuggestion}
              aiDesigning={factory.aiDesigning}
              canUseAiAssist={factory.canUseAiAssist}
              onAiDesign={() => void factory.handleAiDesign()}
              selectedTemplate={factory.selectedTemplate}
              draft={factory.draft}
              previewRole={previewRole}
              characterFilename={characterFilenameForPreview}
              onCharacterCustomize={() => void openCharacterCustomize()}
              canUseCharacterCustomize={isTauri()}
              name={factory.state.name}
              roleLabel={factory.state.roleLabel}
              capabilities={factory.state.capabilities}
              prompt={factory.state.prompt}
              skillBrowserOpen={factory.state.skillBrowserOpen}
              skillSearch={factory.state.skillSearch}
              filteredSkills={factory.filteredSkills}
              selectedSkills={factory.selectedSkills}
              selectedBundleInfo={factory.selectedBundleInfo}
              onNameChange={(value) => factory.patchState({ name: value })}
              onRoleLabelChange={(value) => factory.patchState({ roleLabel: value })}
              onCapabilitiesChange={(value) => factory.patchState({ capabilities: value })}
              onPromptChange={(value) => factory.patchState({ prompt: value })}
              onSkillBrowserToggle={() =>
                factory.patchState({
                  skillBrowserOpen: !factory.state.skillBrowserOpen,
                })
              }
              onSkillSearchChange={(value) => factory.patchState({ skillSearch: value })}
              onToggleSkillSelection={factory.toggleSkillSelection}
            />
          ) : null}

          {factory.state.step === "preview" ? (
            <AgentFactoryPreviewStep
              t={t}
              draft={factory.draft}
              previewRole={previewRole}
              characterFilename={characterFilenameForPreview}
              selectedSkills={factory.selectedSkills}
              aiSuggestion={factory.aiSuggestion}
              name={factory.state.name}
              roleLabel={factory.state.roleLabel}
              capabilities={factory.state.capabilities}
              prompt={factory.effectivePrompt}
              onCharacterCustomize={() => void openCharacterCustomize()}
              canUseCharacterCustomize={isTauri()}
            />
          ) : null}
        </div>

        {characterEditorOpen ? (
          <div className="absolute inset-0 z-[70] flex items-end justify-center bg-[#050810]/90 p-3 backdrop-blur-sm sm:items-center">
            <div
              role="dialog"
              aria-modal="true"
              className="flex max-h-[min(92vh,800px)] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-[#2A2A4A] bg-[#0a0f18] shadow-xl"
            >
              <div className="flex shrink-0 items-center justify-between border-b border-[#2A2A4A] px-4 py-3">
                <h3 className="text-sm font-semibold text-cyan-200">
                  {t("agentsMetadataEditor.detail.visualEditor.title")}
                </h3>
                <button
                  type="button"
                  onClick={() => setCharacterEditorOpen(false)}
                  className="rounded-lg p-2 text-gray-400 hover:bg-white/10 hover:text-white"
                  aria-label={t("agentsMetadataEditor.close")}
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <AgentCharacterVisualEditor
                  characterFilename={characterEditorFilename}
                  fallbackRole={previewRole}
                  onClose={() => setCharacterEditorOpen(false)}
                  onSaved={() => {
                    void hydrateCharacterVisualsFromTauri();
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}

        <div className="flex shrink-0 justify-end gap-2 border-t border-[#374151] px-4 py-4 sm:px-5">
          {factory.state.step !== "brief" ? (
            <button
              type="button"
              onClick={() =>
                factory.setStep(factory.state.step === "preview" ? "edit" : "brief")
              }
              className="rounded-lg border border-[#374151] px-4 py-2"
            >
              {t("factory.action.back")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-[#374151] px-4 py-2"
          >
            {t("factory.cancel")}
          </button>
          {factory.state.step === "edit" ? (
            <button
              type="button"
              onClick={() => {
                factory.exportBlueprintJson();
                factory.setStep("preview");
              }}
              className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-cyan-100"
            >
              {t("factory.action.preview")}
            </button>
          ) : null}
          {factory.state.step === "preview" ? (
            <button
              type="button"
              onClick={() => void factory.submit()}
              disabled={factory.loading}
              className="rounded-lg bg-cyan-600 px-4 py-2"
            >
              {factory.loading ? t("factory.creating") : t("factory.create")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
