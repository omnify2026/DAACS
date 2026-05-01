import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { DEFAULT_BUNDLED_AGENTS_METADATA_JSON } from "../../lib/defaultBundledAgentsMetadata";
import {
  isDefaultAgentMetadataId,
  mergeAgentsIntoMetadataRoot,
  parseAgentsMetadataJson,
  parseAgentsMetadataRootPayload,
  refreshAgentsMetadataCache,
  serializeAgentsMetadataEntryForJson,
  sortAgentsMetadataEntriesForDisplay,
  type AgentsMetadataEntry,
} from "../../lib/agentsMetadata";
import { hydrateCharacterVisualsFromTauri } from "../../lib/characterVisuals";
import { AgentFactoryModal } from "./AgentFactoryModal";
import { AgentMetadataDetailView } from "./AgentMetadataDetailView";
import { AgentCharacterStaticPreview } from "./AgentSprite";
import { useI18n } from "../../i18n";
import {
  getAgentsMetadataJson,
  isTauri,
  removeAgentUserArtifacts,
  saveAgentsMetadataBundled,
} from "../../services/tauriCli";
import { useOfficeStore } from "../../stores/officeStore";
import type { AgentRole } from "../../types/agent";

type Props = {
  open: boolean;
  onClose: () => void;
};

function AgentMetadataCard({
  entry,
  onSelect,
}: {
  entry: AgentsMetadataEntry;
  onSelect: (agentId: string) => void;
}) {
  const { t } = useI18n();
  const role = entry.office_role as AgentRole;

  return (
    <motion.article
      layout
      role="button"
      tabIndex={0}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex w-full min-w-0 cursor-pointer flex-col rounded-xl border border-[#2A2A4A] bg-[#111827]/85 backdrop-blur-sm p-3.5 pt-4 shadow-lg min-h-[min(22rem,70vh)] transition-colors hover:border-cyan-500/35 hover:bg-[#141c2e]/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500/50"
      onClick={() => onSelect(entry.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(entry.id);
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-center gap-1.5 px-0.5">
        <h2 className="text-center text-xs font-semibold leading-tight text-white line-clamp-3 min-w-0 flex-1">
          {entry.display_name}
        </h2>
        {isDefaultAgentMetadataId(entry.id) && (
          <span className="shrink-0 rounded border border-amber-500/35 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-amber-200/95">
            {t("agentsMetadataEditor.card.defaultAgent")}
          </span>
        )}
      </div>
      <div className="mt-2 space-y-2 text-[10px]">
        <div>
          <div className="text-gray-500 uppercase tracking-wide">{t("agentsMetadataEditor.card.id")}</div>
          <p className="mt-0.5 break-all font-mono text-cyan-400/95">{entry.id}</p>
        </div>
        <div>
          <div className="text-gray-500 uppercase tracking-wide text-center">
            {t("agentsMetadataEditor.card.character")}
          </div>
          <div className="mt-1 flex justify-center rounded-lg border border-[#2A2A4A]/80 bg-[#0b1220]/90 py-2">
            <AgentCharacterStaticPreview role={role} characterFilename={entry.character ?? null} />
          </div>
        </div>
      </div>
      <div className="mt-3 flex min-h-0 flex-1 flex-col border-t border-white/5 pt-3">
        <div className="text-[10px] uppercase tracking-wide text-gray-500">
          {t("agentsMetadataEditor.card.skills")} ({entry.skill_bundle_refs.length})
        </div>
        <ul className="mt-2 flex max-h-[min(14rem,40vh)] flex-col gap-1.5 overflow-y-auto overscroll-contain pr-0.5">
          {entry.skill_bundle_refs.map((skillId) => (
            <li key={skillId}>
              <span
                className="block rounded-md border border-[#2A2A4A] bg-[#0b1220] px-2 py-1 text-[10px] leading-snug text-gray-400 break-words"
                title={skillId}
              >
                {skillId}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </motion.article>
  );
}

export function AgentsMetadataEditorModal({ open, onClose }: Props) {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentsMetadataEntry[]>([]);
  const [metadataRoot, setMetadataRoot] = useState<Record<string, unknown> | null>(null);
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [metadataActionBusy, setMetadataActionBusy] = useState(false);
  const [showFactoryModal, setShowFactoryModal] = useState(false);
  const [error, setError] = useState("");
  const [lastFocusedAgentId, setLastFocusedAgentId] = useState<string | null>(null);
  const applyRawAgentsMetadata = useCallback((raw: string) => {
    const payload = parseAgentsMetadataRootPayload(raw);
    if (payload != null) {
      setMetadataRoot(payload.root);
      setAgents(payload.agents);
      return;
    }
    const doc = parseAgentsMetadataJson(raw);
    setAgents(doc.agents);
    setMetadataRoot({
      schema_version: doc.schema_version,
      agents: doc.agents.map(serializeAgentsMetadataEntryForJson),
    });
  }, []);

  const loadFromSource = useCallback(async () => {
    setError("");
    setLoading(true);
    try {
      let raw: string;
      if (isTauri()) {
        raw = await getAgentsMetadataJson();
      } else {
        raw = DEFAULT_BUNDLED_AGENTS_METADATA_JSON;
      }
      applyRawAgentsMetadata(raw);
      if (isTauri()) {
        await refreshAgentsMetadataCache();
        await hydrateCharacterVisualsFromTauri();
      }
    } catch (exc) {
      const msg = exc instanceof Error ? exc.message : String(exc);
      setError(msg);
      if (!isTauri()) {
        const fallback = DEFAULT_BUNDLED_AGENTS_METADATA_JSON;
        applyRawAgentsMetadata(fallback);
      }
    } finally {
      setLoading(false);
    }
  }, [applyRawAgentsMetadata]);

  const handlePersistAgentMetadata = useCallback(
    async (
      nextAgents: AgentsMetadataEntry[],
      nextRoot: Record<string, unknown>,
      selectedIdAfter: string,
    ) => {
      if (!isTauri()) {
        throw new Error("save_requires_desktop");
      }
      const pretty = JSON.stringify(nextRoot, null, 2);
      await saveAgentsMetadataBundled(pretty);
      setAgents(nextAgents);
      setMetadataRoot(nextRoot);
      setDetailAgentId(selectedIdAfter);
      await refreshAgentsMetadataCache();
      await hydrateCharacterVisualsFromTauri();
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    void loadFromSource();
  }, [open, loadFromSource]);

  useEffect(() => {
    if (!open) {
      setDetailAgentId(null);
      setLastFocusedAgentId(null);
      setShowFactoryModal(false);
    }
  }, [open]);

  useEffect(() => {
    if (detailAgentId == null) return;
    if (!agents.some((a) => a.id === detailAgentId)) {
      setDetailAgentId(null);
    }
  }, [agents, detailAgentId]);

  const agentsForCardGrid = useMemo(() => sortAgentsMetadataEntriesForDisplay(agents), [agents]);

  const deleteTargetId = detailAgentId ?? lastFocusedAgentId;
  const canDeleteTarget =
    deleteTargetId != null &&
    !isDefaultAgentMetadataId(deleteTargetId) &&
    agents.some((a) => a.id === deleteTargetId);

  const handleDeleteAgent = useCallback(async () => {
    if (!isTauri() || metadataRoot == null || deleteTargetId == null || !canDeleteTarget) return;
    const msg = t("agentsMetadataEditor.deleteConfirm", { id: deleteTargetId });
    if (!window.confirm(msg)) return;
    const removed = agents.find((a) => a.id === deleteTargetId) ?? null;
    setError("");
    setMetadataActionBusy(true);
    try {
      const nextAgents = agents.filter((a) => a.id !== deleteTargetId);
      const nextRoot = mergeAgentsIntoMetadataRoot(metadataRoot, nextAgents);
      const pretty = JSON.stringify(nextRoot, null, 2);
      await saveAgentsMetadataBundled(pretty);
      if (removed != null) {
        await removeAgentUserArtifacts({
          agentId: removed.id,
          promptKey: removed.prompt_key,
          characterFilename: removed.character ?? null,
        });
      }
      setAgents(nextAgents);
      setMetadataRoot(nextRoot);
      if (detailAgentId === deleteTargetId) {
        setDetailAgentId(null);
      }
      const keepFocus =
        lastFocusedAgentId != null &&
        lastFocusedAgentId !== deleteTargetId &&
        nextAgents.some((a) => a.id === lastFocusedAgentId);
      setLastFocusedAgentId(keepFocus ? lastFocusedAgentId : null);
      await refreshAgentsMetadataCache();
      await hydrateCharacterVisualsFromTauri();
      useOfficeStore.getState().reconcileOfficeAgentsWithMetadata();
      const office = useOfficeStore.getState();
      if (office.projectId != null) {
        void office.clockIn();
      }
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setMetadataActionBusy(false);
    }
  }, [
    agents,
    canDeleteTarget,
    deleteTargetId,
    detailAgentId,
    lastFocusedAgentId,
    metadataRoot,
    t,
  ]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[72] flex flex-col p-2 sm:p-3 pointer-events-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-[#050810]/88 backdrop-blur-[2px] pointer-events-none"
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="agents-metadata-editor-title"
            className="relative flex flex-1 min-h-0 flex-col rounded-2xl border border-[#2A2A4A] bg-[#0a0f18]/97 shadow-[0_0_60px_rgba(0,0,0,0.45)] backdrop-blur-md overflow-hidden"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 12, opacity: 0 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex flex-wrap items-center justify-between gap-3 px-3 py-2 sm:px-4 sm:py-3 border-b border-[#2A2A4A]/90 bg-[#0c1220]/95">
              <div className="min-w-0">
                <h1
                  id="agents-metadata-editor-title"
                  className="text-base sm:text-lg font-semibold text-cyan-300"
                >
                  {t("agentsMetadataEditor.title")}
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setShowFactoryModal(true)}
                  disabled={loading || metadataActionBusy}
                  className="px-3 py-2 rounded-lg border border-[#2A2A4A] text-xs text-gray-200 hover:bg-white/5 disabled:opacity-50"
                >
                  {t("agentsMetadataEditor.addAgent")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteAgent()}
                  disabled={
                    !isTauri() ||
                    metadataRoot == null ||
                    !canDeleteTarget ||
                    loading ||
                    metadataActionBusy
                  }
                  className="px-3 py-2 rounded-lg border border-rose-500/40 text-xs text-rose-200/95 hover:bg-rose-500/15 disabled:opacity-50"
                >
                  {t("agentsMetadataEditor.deleteAgent")}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="p-2 rounded-xl hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                  aria-label={t("agentsMetadataEditor.close")}
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </header>
            {!isTauri() && (
              <div className="shrink-0 px-3 sm:px-4 py-2 text-xs text-amber-200/95 bg-amber-500/10 border-b border-amber-500/20">
                {t("agentsMetadataEditor.browserBundledHint")}
              </div>
            )}
            {error !== "" && (
              <div className="shrink-0 px-3 sm:px-4 py-2 text-xs text-rose-200 bg-rose-500/10 border-b border-rose-500/25 font-mono break-all">
                {error}
              </div>
            )}
            <div className="relative flex min-h-0 flex-1 flex-col">
              {detailAgentId != null && metadataRoot != null ? (
                <AgentMetadataDetailView
                  originalAgentId={detailAgentId}
                  agents={agents}
                  metadataRoot={metadataRoot}
                  canPersist={isTauri()}
                  onBack={() => setDetailAgentId(null)}
                  onPersist={handlePersistAgentMetadata}
                />
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:py-4">
                  {loading && agents.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-12">{t("agentsMetadataEditor.loading")}</p>
                  ) : agents.length === 0 ? (
                    <p className="text-sm text-gray-400 text-center py-12">{t("agentsMetadataEditor.gridEmpty")}</p>
                  ) : (
                    <div className="mx-auto grid w-full max-w-[1600px] grid-cols-1 content-start justify-items-center gap-4 sm:grid-cols-[repeat(auto-fill,minmax(max(13.5rem,calc((100%-4rem)/5)),1fr))] sm:justify-items-stretch">
                      {agentsForCardGrid.map((entry) => (
                        <AgentMetadataCard
                          key={entry.id}
                          entry={entry}
                          onSelect={(id) => {
                            setLastFocusedAgentId(id);
                            setDetailAgentId(id);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
          <AgentFactoryModal
            open={showFactoryModal}
            overlayZClass="z-[80]"
            onClose={() => {
              setShowFactoryModal(false);
              void loadFromSource();
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
