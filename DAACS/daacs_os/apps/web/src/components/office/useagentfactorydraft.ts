import { useEffect, useMemo, useState } from "react";

import * as runtimeApi from "../../services/runtimeApi";
import { isTauri } from "../../services/tauriCli";
import { LoadSkillBundleSummary } from "../../lib/skillBundleProvider";
import {
  suggestAgentBlueprint,
  type BlueprintSuggestion,
} from "../../lib/agentDesignAssistant";
import { loadSkillCatalog } from "../../lib/skillCatalog";
import {
  buildFactoryBlueprintDraft,
  inferTemplateFromSignals,
} from "../../lib/runtimeBuilder";
import type { BlueprintInput, SkillBundleSummary, SkillMeta } from "../../types/runtime";
import {
  DEFAULT_FACTORY_SNAPSHOT,
  clearSnapshot,
  loadSnapshot,
  patchFromBlueprint,
  patchFromSuggestion,
  saveSnapshot,
  splitCsv,
  type BuilderDraftSnapshot,
} from "./agentFactoryState";
import type { TranslateFn } from "./agentFactoryShared";

function normalizeFactoryMetadataAgentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function mapTemplateBundleToOfficeRole(bundleRole: string): string {
  const k = bundleRole.trim().toLowerCase();
  if (k === "pm") return "pm";
  if (k === "designer") return "designer";
  if (k === "developer") return "developer_back";
  return "developer";
}

function buildAiRedesignIntentMessage(state: BuilderDraftSnapshot): string {
  const parts: string[] = [];
  const profileDescription = state.capabilities.trim();
  const prompt = state.prompt.trim();
  if (profileDescription !== "") parts.push(`Description: ${profileDescription}`);
  if (prompt !== "") parts.push(`Prompt: ${prompt}`);
  return parts.join("\n\n");
}

type NotificationFn = (notification: {
  type: "success" | "warning" | "error";
  message: string;
}) => void;

type LocalAgentAdder = (draft: {
  name: string;
  roleLabel: string;
  prompt: string;
  capabilities: string[];
  skillBundleRefs: string[];
  uiProfile?: BuilderDraftReturn["previewAgent"]["uiProfile"];
  operatingProfile?: BuilderDraftReturn["previewAgent"]["operatingProfile"];
  metadataAgentId?: string;
  officeRole?: string;
  skillBundleRole?: string;
  characterFilename?: string;
}) => Promise<{ added: boolean }>;

type BuilderDraftReturn = ReturnType<typeof buildFactoryBlueprintDraft>;

interface Args {
  open: boolean;
  t: TranslateFn;
  projectId: string | null;
  addNotification: NotificationFn;
  addCustomAgentLocal: LocalAgentAdder;
  clockIn: () => Promise<void>;
  onClose: () => void;
}

export function useAgentFactoryDraft({
  open,
  t,
  projectId,
  addNotification,
  addCustomAgentLocal,
  clockIn,
  onClose,
}: Args) {
  const initialSnapshot = useMemo(() => loadSnapshot(), []);
  const [state, setState] = useState<BuilderDraftSnapshot>(
    initialSnapshot ?? DEFAULT_FACTORY_SNAPSHOT,
  );
  const [bundleSummary, setBundleSummary] = useState<SkillBundleSummary>({});
  const [skillCatalog, setSkillCatalog] = useState<SkillMeta[]>([]);
  const [aiDesigning, setAiDesigning] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<BlueprintSuggestion | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setState(loadSnapshot() ?? DEFAULT_FACTORY_SNAPSHOT);
    setAiSuggestion(null);
  }, [open]);

  const selectedTemplate = useMemo(
    () =>
      inferTemplateFromSignals(
        splitCsv(state.capabilities),
        state.skillBundleRefs,
        state.roleLabel,
      ),
    [state.capabilities, state.roleLabel, state.skillBundleRefs],
  );
  const effectiveAccentColor =
    state.accentColor.trim() ||
    aiSuggestion?.accent_color ||
    selectedTemplate.accentColor;
  const effectiveHomeZone =
    state.homeZone.trim() || aiSuggestion?.home_zone || selectedTemplate.homeZone;
  const effectiveTeamAffinity =
    state.teamAffinity.trim() ||
    aiSuggestion?.team_affinity ||
    selectedTemplate.teamAffinity;
  const effectivePrompt = state.prompt.trim() || state.brief.trim();

  const draft = useMemo(
    () =>
      buildFactoryBlueprintDraft(selectedTemplate, {
        name: state.name,
        prompt: effectivePrompt,
        roleLabel: state.roleLabel,
        capabilities: splitCsv(state.capabilities, selectedTemplate.capabilities),
        skillBundleRefs: state.skillBundleRefs,
        toolAllowlist: splitCsv(state.toolAllowlist),
        permissionMode: state.permissionMode,
        memoryMode: state.memoryMode,
        accentColor: effectiveAccentColor,
        homeZone: effectiveHomeZone,
        teamAffinity: effectiveTeamAffinity,
        authorityLevel: Number.parseInt(state.authorityLevel, 10) || 20,
        focusMode: state.focusMode.trim() || selectedTemplate.id,
        meetingBehavior: state.meetingBehavior.trim() || "adaptive",
        primaryWidgets: splitCsv(state.primaryWidgets, selectedTemplate.primaryWidgets),
        secondaryWidgets: splitCsv(
          state.secondaryWidgets,
          selectedTemplate.secondaryWidgets,
        ),
        toolConnectors: aiSuggestion?.tool_connectors,
      }),
    [
      aiSuggestion?.tool_connectors,
      effectiveAccentColor,
      effectiveHomeZone,
      effectivePrompt,
      effectiveTeamAffinity,
      selectedTemplate,
      state,
    ],
  );
  const selectedSkills = useMemo(
    () =>
      state.skillBundleRefs.map((skillId) => ({
        id: skillId,
        meta: skillCatalog.find((skill) => skill.id === skillId),
      })),
    [skillCatalog, state.skillBundleRefs],
  );
  const filteredSkills = useMemo(() => {
    const query = state.skillSearch.trim().toLowerCase();
    if (!query) return skillCatalog;
    return skillCatalog.filter((skill) =>
      `${skill.id} ${skill.description} ${skill.category ?? ""} ${skill.displayName ?? ""}`
        .toLowerCase()
        .includes(query),
    );
  }, [skillCatalog, state.skillSearch]);
  const selectedBundleInfo =
    state.skillBundleRefs.length === 1
      ? bundleSummary[state.skillBundleRefs[0]]
      : undefined;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loadSkillData = async () => {
      try {
        const [bundleResult, nextCatalog] = await Promise.all([
          LoadSkillBundleSummary(),
          loadSkillCatalog(),
        ]);
        const nextSummary = bundleResult.summary;
        if (!cancelled) {
          setBundleSummary(nextSummary);
          setSkillCatalog(nextCatalog);
        }
      } catch {
        if (!cancelled) {
          setBundleSummary({});
          setSkillCatalog([]);
        }
      }
    };
    void loadSkillData();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    saveSnapshot(state);
  }, [open, state]);

  const patchState = (patch: Partial<BuilderDraftSnapshot>) => {
    setState((current) => ({ ...current, ...patch }));
  };

  const startManualDesign = () => {
    patchState({
      prompt: state.prompt.trim() || state.brief.trim(),
      skillBundleRefs:
        state.skillBundleRefs.length > 0
          ? state.skillBundleRefs
          : [selectedTemplate.defaultBundleRole],
      step: "edit",
    });
    setAiSuggestion(null);
  };

  const handleAiDesign = async () => {
    const aiIntent = buildAiRedesignIntentMessage(state);
    if (!isTauri() || aiDesigning || !aiIntent.trim() || skillCatalog.length === 0) {
      return;
    }
    setAiDesigning(true);
    try {
      const suggestion = await suggestAgentBlueprint(aiIntent, skillCatalog, projectId);
      if (!suggestion) {
        addNotification({ type: "warning", message: t("factory.warning.aiInvalid") });
        return;
      }
      setAiSuggestion(suggestion);
      patchState(patchFromSuggestion(suggestion, aiIntent));
      addNotification({ type: "success", message: t("factory.notice.aiApplied") });
    } finally {
      setAiDesigning(false);
    }
  };

  const exportBlueprintJson = () => {
    patchState({ blueprintJson: JSON.stringify(draft.blueprint, null, 2) });
  };

  const importBlueprintJson = () => {
    try {
      const parsed = JSON.parse(state.blueprintJson) as BlueprintInput;
      patchState(patchFromBlueprint(parsed));
      setAiSuggestion(null);
      addNotification({ type: "success", message: t("factory.notice.imported") });
    } catch (error) {
      addNotification({
        type: "error",
        message: error instanceof Error ? error.message : t("factory.warning.invalidJson"),
      });
    }
  };

  const submit = async () => {
    if (loading) return;
    if (!projectId && !isTauri()) return;
    if (state.skillBundleRefs.length === 0) {
      addNotification({
        type: "warning",
        message: t("factory.warning.skillsRequired"),
      });
      return;
    }
    setLoading(true);
    console.info("[AgentFactory] Submit started", {
      step: state.step,
      roleLabel: draft.blueprint.role_label,
      skillCount: state.skillBundleRefs.length,
      isTauri: isTauri(),
    });
    try {
      if (isTauri()) {
        const metaId = normalizeFactoryMetadataAgentId(draft.blueprint.role_label);
        const res = await addCustomAgentLocal({
          name: draft.blueprint.name,
          roleLabel: draft.blueprint.role_label,
          prompt: effectivePrompt,
          capabilities: draft.blueprint.capabilities ?? [],
          skillBundleRefs: state.skillBundleRefs,
          uiProfile: draft.previewAgent.uiProfile,
          operatingProfile: draft.previewAgent.operatingProfile,
          metadataAgentId: metaId !== "" ? metaId : undefined,
          officeRole: mapTemplateBundleToOfficeRole(selectedTemplate.defaultBundleRole),
          skillBundleRole: selectedTemplate.defaultBundleRole,
          characterFilename: metaId !== "" ? `${metaId}Data.json` : undefined,
        });
        if (!res.added) {
          console.error("[AgentFactory] Local agent create failed", {
            roleLabel: draft.blueprint.role_label,
            metadataId: metaId,
            skillCount: state.skillBundleRefs.length,
          });
          addNotification({ type: "warning", message: t("factory.noSlot") });
        } else {
          console.info("[AgentFactory] Local agent created", {
            roleLabel: draft.blueprint.role_label,
            metadataId: metaId,
          });
          clearSnapshot();
          addNotification({
            type: "success",
            message: t("factory.created", { name: draft.blueprint.name }),
          });
          onClose();
        }
        return;
      }
      await runtimeApi.bootstrapRuntime(projectId!, {});
      const blueprint = await runtimeApi.createBlueprint(draft.blueprint);
      await runtimeApi.createInstance(projectId!, {
        blueprint_id: blueprint.id,
        assigned_team: draft.blueprint.ui_profile?.team_affinity,
      });
      console.info("[AgentFactory] Runtime agent created", {
        blueprintId: blueprint.id,
        roleLabel: draft.blueprint.role_label,
      });
      clearSnapshot();
      await clockIn();
      addNotification({
        type: "success",
        message: t("factory.created", { name: draft.blueprint.name }),
      });
      onClose();
    } catch (error) {
      console.error("[AgentFactory] Submit failed", {
        roleLabel: draft.blueprint.role_label,
        error: error instanceof Error ? error.message : String(error),
      });
      addNotification({
        type: "error",
        message: error instanceof Error ? error.message : t("factory.failed"),
      });
    } finally {
      setLoading(false);
    }
  };

  return {
    state,
    patchState,
    setStep: (step: BuilderDraftSnapshot["step"]) => patchState({ step }),
    bundleSummary,
    skillCatalog,
    aiDesigning,
    aiSuggestion,
    loading,
    selectedTemplate,
    effectiveHomeZone,
    effectiveTeamAffinity,
    draft,
    selectedSkills,
    filteredSkills,
    selectedBundleInfo,
    effectivePrompt,
    aiAvailable: isTauri(),
    canUseAiAssist:
      isTauri() &&
      !aiDesigning &&
      (!!state.prompt.trim() || !!state.capabilities.trim()) &&
      skillCatalog.length > 0,
    toggleSkillSelection: (skillId: string) => {
      const alreadySelected = state.skillBundleRefs.includes(skillId);
      if (!alreadySelected && state.skillBundleRefs.length >= 12) {
        addNotification({
          type: "warning",
          message: t("factory.warning.skillLimit"),
        });
        return;
      }
      patchState({
        skillBundleRefs: alreadySelected
          ? state.skillBundleRefs.filter((value) => value !== skillId)
          : [...state.skillBundleRefs, skillId],
      });
    },
    startManualDesign,
    handleAiDesign,
    exportBlueprintJson,
    importBlueprintJson,
    submit,
  };
}
