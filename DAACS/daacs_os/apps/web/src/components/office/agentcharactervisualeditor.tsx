import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  getAgentAccent,
  getAgentSpriteFallbackTailwindClass,
  ACCESSORY_CATALOG_IDS,
  AGENT_ICON_NAME_OPTIONS,
  AgentCharacterAccessory,
} from "../../lib/agentVisuals";
import {
  applyCharacterFileSaveToOfficeVisuals,
  loadCharacterFileContentWithFallback,
  parseCharacterVisualJson,
  parseSafeBodyColorHex,
  type CharacterAccent,
  type CharacterVisualDoc,
} from "../../lib/characterVisuals";
import { useI18n } from "../../i18n";
import { isTauri, saveAgentCharacterFile } from "../../services/tauriCli";
import type { AgentRole } from "../../types/agent";
import { AgentSpriteEyes } from "./AgentSprite";

type CharacterEditorModel = CharacterVisualDoc & {
  accessory_offset_x: number;
  accessory_offset_y: number;
};

function buildEditorModelFromParsed(doc: CharacterVisualDoc): CharacterEditorModel {
  return {
    ...doc,
    accessory_offset_x: doc.accessory_offset_x ?? 0,
    accessory_offset_y: doc.accessory_offset_y ?? 0,
  };
}

function looseCharacterEditorModel(raw: string, fallbackRole: AgentRole): CharacterEditorModel {
  const bodyDefault = getAgentSpriteFallbackTailwindClass(fallbackRole);
  const accent = getAgentAccent(String(fallbackRole));
  const firstAcc = ACCESSORY_CATALOG_IDS[0] ?? "pm_clipboard";
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const ac = v.accent as Record<string, unknown> | undefined;
    const accentOut: CharacterAccent = {
      avatar: typeof ac?.avatar === "string" && ac.avatar.trim() !== "" ? ac.avatar : accent.avatar,
      name: typeof ac?.name === "string" && ac.name.trim() !== "" ? ac.name : accent.name,
      dot: typeof ac?.dot === "string" && ac.dot.trim() !== "" ? ac.dot : accent.dot,
    };
    const accessoryRaw = typeof v.accessory_id === "string" ? v.accessory_id.trim() : "";
    const accessoryId =
      accessoryRaw !== "" && ACCESSORY_CATALOG_IDS.includes(accessoryRaw)
        ? accessoryRaw
        : firstAcc;
    const iconRaw = typeof v.icon === "string" ? v.icon.trim() : "";
    const icon = AGENT_ICON_NAME_OPTIONS.includes(iconRaw) ? iconRaw : "Bot";
    const bodyColorLoose =
      typeof v.body_color === "string" ? parseSafeBodyColorHex(v.body_color.trim()) : null;
    const spriteRaw =
      typeof v.sprite_body_class === "string" ? v.sprite_body_class.trim() : "";
    const sprite =
      bodyColorLoose != null ? "" : spriteRaw !== "" ? spriteRaw : bodyDefault;
    const ox = typeof v.accessory_offset_x === "number" && Number.isFinite(v.accessory_offset_x)
      ? Math.round(v.accessory_offset_x)
      : 0;
    const oy = typeof v.accessory_offset_y === "number" && Number.isFinite(v.accessory_offset_y)
      ? Math.round(v.accessory_offset_y)
      : 0;
    const out: CharacterEditorModel = {
      schema_version: typeof v.schema_version === "number" ? v.schema_version : 1,
      character_id:
        typeof v.character_id === "string" && v.character_id.trim() !== ""
          ? v.character_id.trim()
          : String(fallbackRole),
      accent: accentOut,
      sprite_body_class: sprite,
      icon,
      accessory_id: accessoryId,
      accessory_offset_x: ox,
      accessory_offset_y: oy,
    };
    if (bodyColorLoose != null) out.body_color = bodyColorLoose;
    return out;
  } catch {
    return {
      schema_version: 1,
      character_id: String(fallbackRole),
      accent: { avatar: accent.avatar, name: accent.name, dot: accent.dot },
      sprite_body_class: bodyDefault,
      icon: "Bot",
      accessory_id: firstAcc,
      accessory_offset_x: 0,
      accessory_offset_y: 0,
    };
  }
}

function parseEditorModel(raw: string, fallbackRole: AgentRole): CharacterEditorModel {
  const strict = parseCharacterVisualJson(raw);
  if (strict != null) return buildEditorModelFromParsed(strict);
  return looseCharacterEditorModel(raw, fallbackRole);
}

function buildCharacterSaveJson(
  model: CharacterEditorModel,
  fallbackRole: AgentRole,
): string {
  const hex = parseSafeBodyColorHex(model.body_color);
  const o: Record<string, unknown> = {
    schema_version: model.schema_version,
    character_id: model.character_id,
    accent: model.accent,
    icon: model.icon,
    accessory_id: model.accessory_id,
  };
  if (hex != null) {
    o.body_color = hex;
    o.sprite_body_class = "";
  } else {
    const cls = model.sprite_body_class?.trim() ?? "";
    o.sprite_body_class =
      cls !== "" ? cls : getAgentSpriteFallbackTailwindClass(fallbackRole);
  }
  if (model.accessory_offset_x !== 0) o.accessory_offset_x = model.accessory_offset_x;
  if (model.accessory_offset_y !== 0) o.accessory_offset_y = model.accessory_offset_y;
  return JSON.stringify(o, null, 2);
}

type DragRef = { startX: number; startY: number; ox: number; oy: number } | null;

type Props = {
  characterFilename: string;
  fallbackRole: AgentRole;
  onClose: () => void;
  onSaved?: () => void;
};

function editorModelBodyPresentation(
  model: CharacterEditorModel,
  fallbackRole: AgentRole,
): { tw: string; fill?: { backgroundColor: string } } {
  const hex = parseSafeBodyColorHex(model.body_color);
  if (hex != null) return { tw: "", fill: { backgroundColor: hex } };
  const cls = model.sprite_body_class?.trim() ?? "";
  if (cls !== "") return { tw: cls, fill: undefined };
  return { tw: getAgentSpriteFallbackTailwindClass(fallbackRole), fill: undefined };
}

function AccessoryStripThumb({
  accessoryId,
  selected,
  onPick,
  bodyTw,
  bodyFillStyle,
}: {
  accessoryId: string;
  selected: boolean;
  onPick: () => void;
  bodyTw: string;
  bodyFillStyle?: { backgroundColor: string };
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex shrink-0 flex-col items-center gap-1 rounded-xl border p-2 transition-colors ${
        selected ? "border-cyan-400/80 bg-cyan-500/10" : "border-[#2A2A4A] bg-[#0b1220]/90 hover:border-[#3d3d5c]"
      }`}
    >
      <div className="relative h-[4.5rem] w-[3.25rem] overflow-visible">
        <div className="absolute left-1/2 top-1 origin-top -translate-x-1/2 scale-[0.72]">
          <div className="relative">
            <div
              className={`relative w-10 h-9 ${bodyTw} rounded-t-full rounded-b-sm border-2 border-black/20 shadow-md`}
              style={bodyFillStyle}
            >
              <AgentSpriteEyes status="idle" />
            </div>
            <AgentCharacterAccessory accessoryId={accessoryId} fallbackRole="pm" />
          </div>
        </div>
      </div>
      <span className="max-w-[5.5rem] truncate font-mono text-[9px] text-gray-400">{accessoryId}</span>
    </button>
  );
}

export function AgentCharacterVisualEditor({
  characterFilename,
  fallbackRole,
  onClose,
  onSaved,
}: Props) {
  const { t } = useI18n();
  const [model, setModel] = useState<CharacterEditorModel | null>(null);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const dragRef = useRef<DragRef>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);

  const file = characterFilename.trim();

  useEffect(() => {
    let cancelled = false;
    setLoadError("");
    if (file === "") {
      setModel(null);
      setLoadError(t("agentsMetadataEditor.detail.characterEdit.needFilename"));
      return;
    }
    void loadCharacterFileContentWithFallback(file)
      .then((raw) => {
        if (cancelled) return;
        setModel(parseEditorModel(raw, fallbackRole));
      })
      .catch(() => {
        if (cancelled) return;
        setModel(null);
        setLoadError(t("agentsMetadataEditor.detail.characterEdit.loadFailed"));
      });
    return () => {
      cancelled = true;
    };
  }, [file, fallbackRole, t]);

  const handleSave = useCallback(async () => {
    if (model == null || file === "") return;
    if (!isTauri()) {
      setSaveError(t("agentsMetadataEditor.detail.characterEdit.browserOnly"));
      return;
    }
    const json = buildCharacterSaveJson(model, fallbackRole);
    if (parseCharacterVisualJson(json) == null) {
      setSaveError(t("agentsMetadataEditor.detail.characterEdit.invalidShape"));
      return;
    }
    setSaveError("");
    setSaveState("saving");
    try {
      await saveAgentCharacterFile(file, json);
      await applyCharacterFileSaveToOfficeVisuals(file);
      onSaved?.();
      onClose();
    } catch (exc) {
      setSaveError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setSaveState("idle");
    }
  }, [file, model, onClose, onSaved, t, fallbackRole]);

  const onPreviewPointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0 || model == null) return;
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      ox: model.accessory_offset_x,
      oy: model.accessory_offset_y,
    };
    previewRef.current?.setPointerCapture(e.pointerId);
  }, [model]);

  const onPreviewPointerMove = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (d == null || model == null) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    const nx = Math.max(-48, Math.min(48, Math.round(d.ox + dx)));
    const ny = Math.max(-48, Math.min(48, Math.round(d.oy + dy)));
    setModel((m) => (m == null ? m : { ...m, accessory_offset_x: nx, accessory_offset_y: ny }));
  }, [model]);

  const endDrag = useCallback((e: ReactPointerEvent) => {
    if (dragRef.current != null) {
      dragRef.current = null;
      try {
        previewRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        /**/
      }
    }
  }, []);

  const bodyPaint = useMemo(() => {
    if (model == null) {
      return {
        tw: "",
        fill: undefined as { backgroundColor: string } | undefined,
      };
    }
    return editorModelBodyPresentation(model, fallbackRole);
  }, [model, fallbackRole]);

  const colorPickerValue =
    parseSafeBodyColorHex(model?.body_color) ?? "#6366F1";

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loadError !== "" && (
          <p className="mb-3 text-xs text-amber-200">{loadError}</p>
        )}
        {saveError !== "" && (
          <p className="mb-3 text-xs text-rose-200">{saveError}</p>
        )}
        {model != null && (
          <div className="space-y-4">
            <p className="text-[11px] text-gray-500">{t("agentsMetadataEditor.detail.visualEditor.dragHint")}</p>
            <div
              ref={previewRef}
              role="presentation"
              className="relative mx-auto flex min-h-[200px] max-w-md cursor-grab touch-none select-none items-start justify-center rounded-xl border border-[#2A2A4A] bg-[#050810] py-10 active:cursor-grabbing"
              onPointerDown={onPreviewPointerDown}
              onPointerMove={onPreviewPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <div className="origin-top scale-[1.85]">
                <div className="relative">
                  <div
                    className={`relative w-10 h-9 ${bodyPaint.tw} rounded-t-full rounded-b-sm shadow-lg border-2 border-black/20 overflow-visible`}
                    style={bodyPaint.fill}
                  >
                    <AgentSpriteEyes status="idle" />
                  </div>
                  <div
                    className={`absolute top-4 -left-1.5 w-3 h-3 ${bodyPaint.tw} rounded-full border border-black/10`}
                    style={bodyPaint.fill}
                  />
                  <div
                    className={`absolute top-4 -right-1.5 w-3 h-3 ${bodyPaint.tw} rounded-full border border-black/10`}
                    style={bodyPaint.fill}
                  />
                  <div className="flex justify-center gap-1.5 -mt-0.5">
                    <div
                      className={`w-2.5 h-3 ${bodyPaint.tw} rounded-b-full border border-black/10`}
                      style={bodyPaint.fill}
                    />
                    <div
                      className={`w-2.5 h-3 ${bodyPaint.tw} rounded-b-full border border-black/10`}
                      style={bodyPaint.fill}
                    />
                  </div>
                  <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-1.5 bg-black/20 rounded-full blur-[2px]" />
                  <AgentCharacterAccessory
                    accessoryId={model.accessory_id}
                    fallbackRole={fallbackRole}
                    translatePx={{
                      x: model.accessory_offset_x,
                      y: model.accessory_offset_y,
                    }}
                  />
                </div>
              </div>
            </div>

            <div>
              <h4 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-gray-500">
                {t("agentsMetadataEditor.detail.visualEditor.accessories")}
              </h4>
              <div className="flex gap-2 overflow-x-auto overflow-y-hidden pb-2 pt-1">
                {ACCESSORY_CATALOG_IDS.map((id) => (
                  <AccessoryStripThumb
                    key={id}
                    accessoryId={id}
                    selected={model.accessory_id === id}
                    bodyTw={bodyPaint.tw}
                    bodyFillStyle={bodyPaint.fill}
                    onPick={() => setModel((m) => (m == null ? m : { ...m, accessory_id: id }))}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-[10px] text-gray-500 sm:col-span-2">
                {t("agentsMetadataEditor.detail.visualEditor.bodyColor")}
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <input
                    type="color"
                    value={colorPickerValue}
                    onChange={(e) =>
                      setModel((m) =>
                        m == null
                          ? m
                          : {
                              ...m,
                              body_color: e.target.value,
                              sprite_body_class: "",
                            },
                      )
                    }
                    className="h-9 w-14 cursor-pointer rounded border border-[#2A2A4A] bg-[#050810] p-0.5"
                  />
                  <input
                    type="text"
                    value={model.body_color ?? ""}
                    onChange={(e) =>
                      setModel((m) =>
                        m == null
                          ? m
                          : {
                              ...m,
                              body_color: e.target.value,
                              sprite_body_class: "",
                            },
                      )
                    }
                    placeholder="#RRGGBB"
                    spellCheck={false}
                    className="min-w-[7rem] flex-1 rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-2 font-mono text-xs text-gray-200"
                  />
                </div>
                <p className="mt-1 text-[10px] text-gray-600">
                  {t("agentsMetadataEditor.detail.visualEditor.bodyColorHint")}
                </p>
              </label>
              <label className="block text-[10px] text-gray-500">
                {t("agentsMetadataEditor.detail.visualEditor.icon")}
                <select
                  value={AGENT_ICON_NAME_OPTIONS.includes(model.icon) ? model.icon : "Bot"}
                  onChange={(e) =>
                    setModel((m) => (m == null ? m : { ...m, icon: e.target.value }))
                  }
                  className="mt-1 w-full rounded-lg border border-[#2A2A4A] bg-[#050810] px-2 py-2 font-mono text-xs text-gray-200"
                >
                  {AGENT_ICON_NAME_OPTIONS.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-[#2A2A4A] px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-[#2A2A4A] px-4 py-2 text-xs text-gray-200 hover:bg-white/5"
        >
          {t("agentsMetadataEditor.detail.characterEdit.cancel")}
        </button>
        <button
          type="button"
          disabled={model == null || !isTauri() || file === "" || saveState === "saving"}
          onClick={() => void handleSave()}
          className="rounded-lg bg-cyan-600/80 px-4 py-2 text-xs font-medium text-white hover:bg-cyan-500/90 disabled:opacity-40"
        >
          {saveState === "saving"
            ? t("agentsMetadataEditor.detail.saving")
            : t("agentsMetadataEditor.detail.characterEdit.save")}
        </button>
      </div>
    </>
  );
}
