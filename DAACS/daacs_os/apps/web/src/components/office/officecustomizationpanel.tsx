import { motion } from "framer-motion";
import {
  Download,
  Globe2,
  Save,
  Settings2,
  Share2,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n";
import { OFFICE_FURNITURE_LIBRARY } from "../../lib/officeFurniture";
import type { OfficeThemePatch, OfficeZonePatch } from "../../lib/officeCustomization";
import { useOfficeStore } from "../../stores/officeStore";
import type { OfficeFurnitureType } from "../../types/office";

const ZONE_PRESETS = [
  "ceo",
  "meeting",
  "design",
  "marketing",
  "hallway",
  "engineering",
  "finance",
  "lobby",
  "server",
  "generic",
] as const;

const FURNITURE_TYPES = Object.keys(OFFICE_FURNITURE_LIBRARY) as OfficeFurnitureType[];

type OfficeCustomizationPanelProps = { onClose: () => void };
type CustomizationTab = "layout" | "templates";

function humanizeToken(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function localizedPresetLabel(
  preset: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const key = `officeCustomization.preset.${preset}`;
  const translated = t(key);
  return translated === key ? humanizeToken(preset) : translated;
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[#2A2A4A] bg-[#0F0F23]/70 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-300">
        {title}
      </div>
      {subtitle ? <p className="mt-2 text-xs text-gray-400">{subtitle}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function TabButton({
  active,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  label: string;
  meta: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`min-w-0 flex-1 rounded-2xl border px-4 py-3 text-left transition-colors ${
        active
          ? "border-cyan-400/40 bg-cyan-500/12 text-white"
          : "border-[#2A2A4A] bg-[#0F0F23]/65 text-gray-300 hover:border-cyan-400/20 hover:bg-white/5"
      }`}
    >
      <div className="truncate text-sm font-semibold">{label}</div>
      <div className="mt-1 truncate text-[11px] text-gray-400">{meta}</div>
    </button>
  );
}

export function OfficeCustomizationPanel({ onClose }: OfficeCustomizationPanelProps) {
  const { t } = useI18n();
  const store = useOfficeStore();
  const {
    officeProfile,
    globalOfficeState,
    agents,
    editMode,
    editFurnitureMode,
    editFurniturePlacementType,
    toggleEditMode,
    updateOfficeTheme,
    updateGlobalTheme,
    promoteCurrentOfficeToGlobalDefault,
    clearGlobalDefaultOffice,
    shareAgentGlobally,
    removeSharedAgent,
    importSharedAgentToOffice,
    saveCurrentOfficeAsTemplate,
    applyOfficeTemplate,
    setDefaultOfficeTemplate,
    updateOfficeZone,
    setEditFurnitureMode,
    setEditFurniturePlacementType,
    setAgentSharedSyncMode,
    saveOfficeProfile,
    addNotification,
  } = store;

  const [activeTab, setActiveTab] = useState<CustomizationTab>("layout");
  const [isSaving, setIsSaving] = useState(false);
  const [isGlobalSaving, setIsGlobalSaving] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [latestSavedTemplateId, setLatestSavedTemplateId] = useState<string | null>(null);
  const [localTheme, setLocalTheme] = useState(
    officeProfile?.theme ?? {
      shell_color: "#1A1A2E",
      floor_color: "#111827",
      panel_color: "#2A2A4A",
      accent_color: "#22D3EE",
    },
  );
  const [localGlobalTheme, setLocalGlobalTheme] = useState(
    globalOfficeState.settings.theme ?? {
      shell_color: "#111827",
      floor_color: "#111827",
      panel_color: "#111827",
      accent_color: "#111827",
    },
  );
  const [localZoneAccentById, setLocalZoneAccentById] = useState<Record<string, string>>(
    Object.fromEntries((officeProfile?.zones ?? []).map((zone) => [zone.id, zone.accent_color])),
  );

  const inputClass =
    "mt-1 w-full rounded-xl border border-[#2A2A4A] bg-[#0B1220] px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-400/50";
  const panelShellClass =
    "fixed right-4 top-20 bottom-4 z-[60] w-[min(440px,calc(100vw-1rem))]";

  useEffect(() => {
    if (!officeProfile) return;
    setLocalTheme(officeProfile.theme);
    setLocalZoneAccentById(
      Object.fromEntries(officeProfile.zones.map((zone) => [zone.id, zone.accent_color])),
    );
  }, [officeProfile]);

  useEffect(() => {
    setLocalGlobalTheme(
      globalOfficeState.settings.theme ?? {
        shell_color: "#111827",
        floor_color: "#111827",
        panel_color: "#111827",
        accent_color: "#111827",
      },
    );
  }, [globalOfficeState.settings.theme]);

  const zones = officeProfile?.zones ?? [];
  const defaultTemplateId = globalOfficeState.settings.default_template_id;
  const globalDefaultProfile =
    globalOfficeState.settings.default_office_profile_id != null
      ? globalOfficeState.office_profiles.find(
          (profile) =>
            profile.office_profile_id === globalOfficeState.settings.default_office_profile_id,
        ) ?? null
      : null;
  const linkedSharedAgentIds = new Set(
    agents.flatMap((agent) =>
      agent.sharedAgentRef?.global_agent_id ? [agent.sharedAgentRef.global_agent_id] : [],
    ),
  );
  const tabMeta = useMemo(
    () => ({
      layout: `${zones.length} ${t("officeCustomization.metaRooms")}`,
      templates: `${globalOfficeState.office_templates.length} ${t("officeCustomization.metaTemplates")}`,
    }),
    [globalOfficeState.office_templates.length, t, zones.length],
  );
  const sortedTemplates = useMemo(() => {
    const templates = [...globalOfficeState.office_templates];
    templates.sort((left, right) => {
      if (latestSavedTemplateId) {
        if (left.template_id === latestSavedTemplateId) return -1;
        if (right.template_id === latestSavedTemplateId) return 1;
      }
      if (defaultTemplateId) {
        if (left.template_id === defaultTemplateId) return -1;
        if (right.template_id === defaultTemplateId) return 1;
      }
      return new Date(right.updated_at).getTime() - new Date(left.updated_at).getTime();
    });
    return templates;
  }, [defaultTemplateId, globalOfficeState.office_templates, latestSavedTemplateId]);

  if (!officeProfile) {
    return (
      <motion.aside
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 24 }}
        className={panelShellClass}
        data-office-settings-panel="true"
        data-testid="office-customization-panel"
      >
        <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-[#2A2A4A] bg-[#1A1A2E]/95 shadow-2xl backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3 border-b border-[#2A2A4A] px-5 py-4">
            <div className="text-sm font-bold text-white font-['Press_Start_2P']">
              {t("officeCustomization.title")}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="p-5 text-sm text-gray-300">{t("officeCustomization.noProfile")}</div>
        </div>
      </motion.aside>
    );
  }

  const updateThemeField = (
    field: keyof typeof officeProfile.theme,
    value: string,
  ) => updateOfficeTheme({ [field]: value } as OfficeThemePatch);

  const updateGlobalThemeField = async (
    field: keyof NonNullable<typeof globalOfficeState.settings.theme>,
    value: string,
  ) => {
    await updateGlobalTheme({ [field]: value } as OfficeThemePatch);
  };

  const updateZoneField = (
    zoneId: string,
    field: keyof OfficeZonePatch,
    value: string | number,
  ) => updateOfficeZone(zoneId, { [field]: value } as OfficeZonePatch);

  const handleStartEdit = () => {
    if (!editMode) {
      toggleEditMode();
    }
  };

  const handleExitEdit = () => {
    if (editMode) {
      toggleEditMode();
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const result = await saveOfficeProfile(officeProfile);
      addNotification({
        type: result ? "success" : "error",
        message: result ? t("officeCustomization.saved") : t("officeCustomization.saveFailed"),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handlePromoteGlobalDefault = async () => {
    setIsGlobalSaving(true);
    try {
      await promoteCurrentOfficeToGlobalDefault();
      addNotification({
        type: "success",
        message: t("officeCustomization.globalDefaultSaved"),
      });
    } finally {
      setIsGlobalSaving(false);
    }
  };

  const handleClearGlobalDefault = async () => {
    setIsGlobalSaving(true);
    try {
      await clearGlobalDefaultOffice();
      addNotification({
        type: "success",
        message: t("officeCustomization.globalDefaultCleared"),
      });
    } finally {
      setIsGlobalSaving(false);
    }
  };

  const handleSaveTemplate = async () => {
    const savedTemplate = await saveCurrentOfficeAsTemplate(
      templateName.trim() || officeProfile.name,
      t("officeCustomization.templateDescriptionDefault", { office: officeProfile.name }),
    );
    setLatestSavedTemplateId(savedTemplate?.template_id ?? null);
    setActiveTab("templates");
    addNotification({ type: "success", message: t("officeCustomization.templateSaved") });
    setTemplateName("");
  };

  const handleSetDefaultTemplate = async (templateId: string | null) => {
    await setDefaultOfficeTemplate(templateId);
    addNotification({
      type: "success",
      message: templateId
        ? t("officeCustomization.defaultTemplateSaved")
        : t("officeCustomization.defaultTemplateCleared"),
    });
  };

  const handleFinishEdit = async () => {
    await handleSave();
    if (editMode) {
      toggleEditMode();
    }
    onClose();
  };

  const formatTemplateUpdatedAt = (value: string) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(parsed);
  };

  if (editMode) {
    return (
      <motion.aside
        initial={{ opacity: 0, x: 24 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 24 }}
        className={panelShellClass}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-cyan-400/30 bg-[#10182C]/94 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-cyan-400/20 px-5 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-white">
                  {t("officeCustomization.editSessionTitle")}
                </div>
                <p className="mt-2 text-xs text-cyan-100/80">
                  {t("officeCustomization.editSessionHint")}
                </p>
              </div>
              <button
                type="button"
                onClick={handleExitEdit}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            <SectionCard
              title={t("officeCustomization.quickGuideTitle")}
              subtitle={t("officeCustomization.quickGuideBody")}
            >
              <div className="rounded-2xl border border-cyan-400/20 bg-cyan-500/8 px-4 py-4 text-sm text-cyan-100">
                <div>{t("officeCustomization.objectMoveHint")}</div>
                <div className="mt-3 text-[11px] text-cyan-100/75">
                  {officeProfile.furniture.length} {t("officeCustomization.metaItems")}
                </div>
              </div>
            </SectionCard>

            <SectionCard
              title={t("officeCustomization.objectTools")}
              subtitle={t("officeCustomization.objectToolbarIntro")}
            >
              <div className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditFurnitureMode("move")}
                    className={`rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
                      editFurnitureMode === "move"
                        ? "border-cyan-400/40 bg-cyan-500/15 text-cyan-50"
                        : "border-[#2A2A4A] bg-white/5 text-gray-200"
                    }`}
                  >
                    {t("officeCustomization.objectModeMove")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditFurnitureMode("delete")}
                    className={`rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
                      editFurnitureMode === "delete"
                        ? "border-rose-400/40 bg-rose-500/15 text-rose-100"
                        : "border-[#2A2A4A] bg-white/5 text-gray-200"
                    }`}
                  >
                    {t("officeCustomization.objectModeDelete")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditFurniturePlacementType(null)}
                    className={`rounded-full border px-3 py-2 text-xs font-semibold transition-colors ${
                      editFurniturePlacementType == null
                        ? "border-amber-400/40 bg-amber-500/15 text-amber-100"
                        : "border-[#2A2A4A] bg-white/5 text-gray-200"
                    }`}
                  >
                    {t("officeCustomization.objectPlacementClear")}
                  </button>
                </div>

                <div className="flex flex-wrap gap-2">
                  {FURNITURE_TYPES.map((type) => (
                    <button
                      key={`edit-tool-${type}`}
                      type="button"
                      onClick={() => {
                        setEditFurnitureMode("move");
                        setEditFurniturePlacementType(type);
                      }}
                      className={`rounded-full border px-3 py-2 text-[11px] font-semibold transition-colors ${
                        editFurniturePlacementType === type
                          ? "border-violet-400/40 bg-violet-500/15 text-violet-100"
                          : "border-[#2A2A4A] bg-white/5 text-gray-200"
                      }`}
                    >
                      {t(OFFICE_FURNITURE_LIBRARY[type].label_key)}
                    </button>
                  ))}
                </div>

                <div className="rounded-xl border border-[#2A2A4A] bg-[#0B1220]/80 px-3 py-3 text-[11px] text-gray-300">
                  {editFurniturePlacementType
                    ? t("officeCustomization.objectPlacementHint", {
                        object: t(OFFICE_FURNITURE_LIBRARY[editFurniturePlacementType].label_key),
                      })
                    : editFurnitureMode === "delete"
                      ? t("officeCustomization.objectDeleteHint")
                      : t("officeCustomization.objectMoveHint")}
                </div>
              </div>
            </SectionCard>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-cyan-400/20 px-4 py-4">
            <button
              type="button"
              onClick={handleExitEdit}
              className="rounded-full border border-[#2A2A4A] bg-white/5 px-4 py-2 text-xs font-semibold text-gray-200 transition-colors hover:border-cyan-400/30 hover:text-white"
            >
              {t("officeCustomization.backToSettings")}
            </button>
            <button
              type="button"
              onClick={() => void handleFinishEdit()}
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-4 py-2 text-xs font-semibold text-emerald-100 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? t("officeCustomization.saving") : t("officeCustomization.finishEdit")}
            </button>
          </div>
        </div>
      </motion.aside>
    );
  }

  return (
    <motion.aside
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 24 }}
      className={panelShellClass}
      data-office-settings-panel="true"
      data-testid="office-customization-panel"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex h-full flex-col overflow-hidden rounded-3xl border border-[#2A2A4A] bg-[#1A1A2E]/95 shadow-2xl backdrop-blur-xl">
        <div className="border-b border-[#2A2A4A] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-bold text-white font-['Press_Start_2P']">
                <Settings2 className="h-4 w-4 text-cyan-300" />
                <span>{t("officeCustomization.title")}</span>
              </div>
              <p className="mt-2 text-xs text-gray-400">{t("officeCustomization.subtitle")}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-full border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-100 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {isSaving ? t("officeCustomization.saving") : t("officeCustomization.save")}
              </button>
              <button
                type="button"
                onClick={handleStartEdit}
                className="rounded-full border border-cyan-400/40 bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-100 transition-colors hover:bg-cyan-500/20"
              >
                {t("officeCustomization.editModeOff")}
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1 text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="mt-4 flex gap-2">
            <TabButton
              active={activeTab === "layout"}
              label={t("officeCustomization.tab.layout")}
              meta={tabMeta.layout}
              onClick={() => setActiveTab("layout")}
            />
            <TabButton
              active={activeTab === "templates"}
              label={t("officeCustomization.tab.templates")}
              meta={tabMeta.templates}
              onClick={() => setActiveTab("templates")}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          {activeTab === "layout" ? (
            <div className="space-y-4">
              <SectionCard
                title={t("officeCustomization.quickGuideTitle")}
                subtitle={t("officeCustomization.layoutIntro")}
              >
                <div className="space-y-3 rounded-2xl border border-cyan-400/20 bg-cyan-500/8 px-4 py-4 text-sm text-cyan-100">
                  <div>{t("officeCustomization.dragHint")}</div>
                  <div className="text-[11px] text-cyan-100/75">
                    {t("officeCustomization.dragObjectsHint")}
                  </div>
                  <button
                    type="button"
                    onClick={handleStartEdit}
                    className="inline-flex items-center justify-center rounded-full border border-cyan-400/40 bg-cyan-500/15 px-4 py-2 text-xs font-semibold text-cyan-50 transition-colors hover:bg-cyan-500/25"
                  >
                    {t("officeCustomization.editModeOff")}
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.theme")}
                subtitle={t("officeCustomization.themeIntro")}
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  {(
                    [
                      ["shell_color", t("officeCustomization.shellColor")],
                      ["floor_color", t("officeCustomization.floorColor")],
                      ["panel_color", t("officeCustomization.panelColor")],
                      ["accent_color", t("officeCustomization.accentColor")],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field} className="block text-[11px] text-gray-400">
                      {label}
                      <div className="mt-1 flex items-center gap-2 rounded-xl border border-[#2A2A4A] bg-[#111127] px-2 py-2">
                        <input
                          type="color"
                          value={localTheme[field as keyof typeof localTheme] as string}
                          onInput={(event) => {
                            const nextValue = event.currentTarget.value;
                            setLocalTheme((prev) => ({
                              ...prev,
                              [field]: nextValue,
                            }));
                          }}
                          onMouseUp={(event) =>
                            updateThemeField(
                              field as keyof typeof officeProfile.theme,
                              event.currentTarget.value,
                            )
                          }
                          className="h-9 w-10 rounded border-0 bg-transparent p-0"
                        />
                        <code className="text-xs text-white">
                          {localTheme[field as keyof typeof localTheme] as string}
                        </code>
                      </div>
                    </label>
                  ))}
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.rooms")}
                subtitle={t("officeCustomization.layoutRoomsIntro")}
              >
                <div className="space-y-4">
                  {zones.map((zone) => (
                    <div
                      key={zone.id}
                      className="rounded-xl border border-[#2A2A4A] bg-[#111127]/90 p-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white">{zone.label}</div>
                          <div className="text-[11px] text-gray-500">
                            {localizedPresetLabel(zone.preset, t)}
                          </div>
                        </div>
                        <input
                          type="color"
                          value={localZoneAccentById[zone.id] ?? zone.accent_color}
                          onInput={(event) =>
                            setLocalZoneAccentById((prev) => ({
                              ...prev,
                              [zone.id]: event.currentTarget.value,
                            }))
                          }
                          onMouseUp={(event) =>
                            updateOfficeZone(zone.id, { accent_color: event.currentTarget.value })
                          }
                          className="h-10 w-11 rounded border-0 bg-transparent p-0"
                        />
                      </div>
                      <div className="mt-3 grid gap-3 md:grid-cols-2">
                        <label className="block text-[11px] text-gray-400">
                          {t("officeCustomization.roomLabel")}
                          <input
                            value={zone.label}
                            onChange={(event) =>
                              updateZoneField(zone.id, "label", event.target.value)
                            }
                            className={inputClass}
                          />
                        </label>
                        <label className="block text-[11px] text-gray-400">
                          {t("officeCustomization.preset")}
                          <select
                            value={zone.preset}
                            onChange={(event) =>
                              updateZoneField(zone.id, "preset", event.target.value)
                            }
                            className={inputClass}
                          >
                            {ZONE_PRESETS.map((preset) => (
                              <option key={preset} value={preset}>
                                {localizedPresetLabel(preset, t)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </div>
          ) : (
            <div className="space-y-4">
              <SectionCard
                title={t("officeCustomization.templates")}
                subtitle={t("officeCustomization.templatesIntro")}
              >
                <div className="space-y-3 rounded-2xl border border-[#2A2A4A] bg-[#111127]/90 p-3">
                  <input
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder={t("officeCustomization.templateNamePlaceholder")}
                    className="w-full rounded-xl border border-[#2A2A4A] bg-[#0B1220] px-3 py-2 text-sm text-white outline-none transition focus:border-cyan-400/50"
                  />
                  <button
                    type="button"
                    onClick={() => void handleSaveTemplate()}
                    className="inline-flex items-center gap-2 rounded-full border border-violet-400/35 bg-violet-500/10 px-3 py-2 text-[11px] font-semibold text-violet-100"
                  >
                    <Save className="h-3.5 w-3.5" />
                    {t("officeCustomization.saveTemplate")}
                  </button>
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.templates")}
                subtitle={t("officeCustomization.defaultTemplateHint")}
              >
                <div className="space-y-3">
                  {sortedTemplates.length === 0 ? (
                    <div className="rounded-2xl border border-dashed border-[#2A2A4A] px-4 py-6 text-sm text-gray-400">
                      {t("officeCustomization.templatesIntro")}
                    </div>
                  ) : (
                    sortedTemplates.map((template) => (
                      <div
                        key={template.template_id}
                        className={`rounded-2xl border bg-[#111127]/90 p-4 transition-colors ${
                          latestSavedTemplateId === template.template_id
                            ? "border-cyan-400/40 shadow-[0_0_0_1px_rgba(34,211,238,0.12)]"
                            : "border-[#2A2A4A]"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold text-white">
                                {template.name}
                              </div>
                              {defaultTemplateId === template.template_id ? (
                                <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-amber-200">
                                  {t("officeCustomization.defaultTemplateBadge")}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 text-[11px] text-gray-400">
                              {template.description}
                            </div>
                            <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-gray-500">
                              {formatTemplateUpdatedAt(template.updated_at)}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            {([
                              template.theme.shell_color,
                              template.theme.floor_color,
                              template.theme.panel_color,
                              template.theme.accent_color,
                            ] as const).map((color, index) => (
                              <span
                                key={`${template.template_id}-swatch-${index}`}
                                className="h-4 w-4 rounded-full border border-white/10"
                                style={{ backgroundColor: color }}
                              />
                            ))}
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => applyOfficeTemplate(template.template_id)}
                            className="inline-flex items-center gap-1 rounded-full border border-cyan-400/35 px-2.5 py-1.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-500/10"
                          >
                            <Download className="h-3 w-3" />
                            {t("officeCustomization.applyTemplate")}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void handleSetDefaultTemplate(
                                defaultTemplateId === template.template_id
                                  ? null
                                  : template.template_id,
                              )
                            }
                            className="inline-flex items-center gap-1 rounded-full border border-amber-400/35 px-2.5 py-1.5 text-[11px] text-amber-100 transition-colors hover:bg-amber-500/10"
                          >
                            <Star className="h-3 w-3" />
                            {defaultTemplateId === template.template_id
                              ? t("officeCustomization.clearDefaultTemplate")
                              : t("officeCustomization.setDefaultTemplate")}
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.globalDefaults")}
                subtitle={globalDefaultProfile?.name ?? t("officeCustomization.globalDefaultNone")}
              >
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    {(
                      [
                        ["shell_color", t("officeCustomization.shellColor")],
                        ["floor_color", t("officeCustomization.floorColor")],
                        ["panel_color", t("officeCustomization.panelColor")],
                        ["accent_color", t("officeCustomization.accentColor")],
                      ] as const
                    ).map(([field, label]) => (
                      <label key={`global-${field}`} className="block text-[11px] text-gray-400">
                        {label}
                        <div className="mt-1 flex items-center gap-2 rounded-xl border border-[#2A2A4A] bg-[#0B1220] px-2 py-2">
                          <input
                            type="color"
                            value={
                              (localGlobalTheme[
                                field as keyof typeof localGlobalTheme
                              ] as string | undefined) ?? "#111827"
                            }
                            onInput={(event) => {
                              const nextValue = event.currentTarget.value;
                              setLocalGlobalTheme((prev) => ({
                                ...prev,
                                [field]: nextValue,
                              }));
                            }}
                            onMouseUp={(event) =>
                              void updateGlobalThemeField(
                                field as keyof NonNullable<typeof globalOfficeState.settings.theme>,
                                event.currentTarget.value,
                              )
                            }
                            className="h-9 w-10 rounded border-0 bg-transparent p-0"
                          />
                          <code className="text-xs text-white">
                            {(localGlobalTheme[
                              field as keyof typeof localGlobalTheme
                            ] as string | undefined) ?? "#111827"}
                          </code>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void handlePromoteGlobalDefault()}
                      disabled={isGlobalSaving}
                      className="inline-flex items-center gap-2 rounded-full border border-violet-400/40 bg-violet-500/15 px-3 py-2 text-[11px] font-semibold text-violet-100 disabled:opacity-50"
                    >
                      <Globe2 className="h-3.5 w-3.5" />
                      {t("officeCustomization.makeGlobalDefault")}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleClearGlobalDefault()}
                      disabled={isGlobalSaving || !globalDefaultProfile}
                      className="inline-flex items-center gap-2 rounded-full border border-[#2A2A4A] bg-white/5 px-3 py-2 text-[11px] font-semibold text-gray-200 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      {t("officeCustomization.clearGlobalDefault")}
                    </button>
                  </div>
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.shareCurrentAgents")}
                subtitle={t("officeCustomization.shareCurrentAgentsIntro")}
              >
                <div className="space-y-3">
                  {agents.map((agent) => (
                    <div
                      key={agent.id}
                      className="rounded-xl border border-[#2A2A4A] bg-[#111127]/90 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-white">{agent.name}</div>
                          <div className="text-[11px] text-gray-500">
                            {humanizeToken(agent.role)}
                          </div>
                          {agent.sharedAgentRef ? (
                            <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-violet-300">
                              {agent.sharedAgentRef.sync_mode === "linked"
                                ? t("officeCustomization.sharedLinkLinked")
                                : t("officeCustomization.sharedLinkDetached")}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {agent.sharedAgentRef ? (
                            <button
                              type="button"
                              onClick={() =>
                                setAgentSharedSyncMode(
                                  agent.id,
                                  agent.sharedAgentRef?.sync_mode === "linked"
                                    ? "detached"
                                    : "linked",
                                )
                              }
                              className="inline-flex items-center gap-1 rounded-full border border-violet-400/35 px-2.5 py-1.5 text-[11px] text-violet-100 transition-colors hover:bg-violet-500/10"
                            >
                              <Share2 className="h-3 w-3" />
                              {agent.sharedAgentRef.sync_mode === "linked"
                                ? t("officeCustomization.detachLink")
                                : t("officeCustomization.relinkLink")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void shareAgentGlobally(agent.id)}
                              className="inline-flex items-center gap-1 rounded-full border border-violet-400/35 px-2.5 py-1.5 text-[11px] text-violet-100 transition-colors hover:bg-violet-500/10"
                            >
                              <Share2 className="h-3 w-3" />
                              {t("officeCustomization.shareAgent")}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard
                title={t("officeCustomization.sharedCatalog")}
                subtitle={t("officeCustomization.sharedCatalogIntro")}
              >
                <div className="space-y-3">
                  {globalOfficeState.shared_agents.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#2A2A4A] px-3 py-4 text-sm text-gray-400">
                      {t("officeCustomization.noSharedAgents")}
                    </div>
                  ) : (
                    globalOfficeState.shared_agents.map((sharedAgent) => (
                      <div
                        key={sharedAgent.global_agent_id}
                        className="rounded-xl border border-[#2A2A4A] bg-[#111127]/90 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-semibold text-white">{sharedAgent.name}</div>
                            <div className="text-[11px] text-gray-500">
                              {sharedAgent.role_label}
                            </div>
                            {sharedAgent.source_project_id ? (
                              <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-gray-500">
                                {t("officeCustomization.sharedSourceProject", {
                                  project: sharedAgent.source_project_id,
                                })}
                              </div>
                            ) : null}
                            <div className="mt-1 text-[10px] uppercase tracking-[0.16em] text-violet-300">
                              {linkedSharedAgentIds.has(sharedAgent.global_agent_id)
                                ? t("officeCustomization.sharedLinkLinked")
                                : t("officeCustomization.sharedLinkAvailable")}
                            </div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {!linkedSharedAgentIds.has(sharedAgent.global_agent_id) ? (
                              <button
                                type="button"
                                onClick={() => void importSharedAgentToOffice(sharedAgent.global_agent_id)}
                                className="inline-flex items-center gap-1 rounded-full border border-cyan-400/35 px-2.5 py-1.5 text-[11px] text-cyan-100 transition-colors hover:bg-cyan-500/10"
                              >
                                <Download className="h-3 w-3" />
                                {t("officeCustomization.importAgent")}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              onClick={() => void removeSharedAgent(sharedAgent.global_agent_id)}
                              className="inline-flex items-center gap-1 rounded-full border border-rose-400/35 px-2.5 py-1.5 text-[11px] text-rose-100 transition-colors hover:bg-rose-500/10"
                            >
                              <Trash2 className="h-3 w-3" />
                              {t("officeCustomization.removeSharedAgent")}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>
            </div>
          )}
        </div>
      </div>
    </motion.aside>
  );
}
