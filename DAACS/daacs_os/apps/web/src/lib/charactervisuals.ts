import {
  findAgentMetadataByOfficeRoleSync,
  listAgentsMetadataSync,
} from "./agentsMetadata";
import { readAgentCharacterFile, isTauri } from "../services/tauriCli";

export type CharacterAccent = {
  avatar: string;
  name: string;
  dot: string;
};

export type CharacterVisualDoc = {
  schema_version: number;
  character_id: string;
  accent: CharacterAccent;
  sprite_body_class: string;
  body_color?: string;
  icon: string;
  accessory_id: string;
  accessory_offset_x?: number;
  accessory_offset_y?: number;
};

const BODY_COLOR_HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function parseSafeBodyColorHex(
  raw: string | null | undefined,
): string | null {
  const s = String(raw ?? "").trim();
  if (s === "" || !BODY_COLOR_HEX.test(s)) return null;
  const inner = s.slice(1);
  if (inner.length === 3) {
    return (
      "#" +
      inner
        .split("")
        .map((ch) => ch + ch)
        .join("")
    );
  }
  if (inner.length === 4) {
    const [r, g, b] = inner.split("");
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  if (inner.length === 8) return `#${inner.slice(0, 6)}`;
  return s;
}

export type CharacterBodyPaint = {
  tailwindBgClass: string;
  hexFill: string | null;
};

export function resolveCharacterBodyPaint(
  doc: CharacterVisualDoc | null,
  fallbackTailwindClass: string,
): CharacterBodyPaint {
  const hex = parseSafeBodyColorHex(doc?.body_color);
  if (hex != null) return { tailwindBgClass: "", hexFill: hex };
  const cls = doc?.sprite_body_class?.trim();
  if (cls != null && cls !== "") return { tailwindBgClass: cls, hexFill: null };
  const fb = fallbackTailwindClass.trim();
  return { tailwindBgClass: fb !== "" ? fb : "bg-agent-developer", hexFill: null };
}

const FALLBACK_CHARACTER_RAW_BY_FILENAME: Record<string, string> = {
  "pmData.json":
    '{"schema_version":1,"character_id":"pm","accent":{"avatar":"bg-emerald-500/20 border-emerald-500/40 text-emerald-300","name":"text-emerald-300","dot":"bg-emerald-400"},"body_color":"#6366F1","sprite_body_class":"","icon":"ClipboardList","accessory_id":"pm_clipboard"}',
  "frontendData.json":
    '{"schema_version":1,"character_id":"frontend","accent":{"avatar":"bg-sky-500/20 border-sky-500/40 text-sky-300","name":"text-sky-300","dot":"bg-sky-400"},"body_color":"#3B82F6","sprite_body_class":"","icon":"Code","accessory_id":"dev_headset"}',
  "backendData.json":
    '{"schema_version":1,"character_id":"backend","accent":{"avatar":"bg-indigo-500/20 border-indigo-500/40 text-indigo-300","name":"text-indigo-300","dot":"bg-indigo-400"},"body_color":"#4F46E5","sprite_body_class":"","icon":"Search","accessory_id":"review_glasses"}',
  "reviewerData.json":
    '{"schema_version":1,"character_id":"reviewer","accent":{"avatar":"bg-amber-500/20 border-amber-500/40 text-amber-300","name":"text-amber-300","dot":"bg-amber-400"},"body_color":"#EF4444","sprite_body_class":"","icon":"Search","accessory_id":"review_glasses"}',
  "verifierData.json":
    '{"schema_version":1,"character_id":"verifier","accent":{"avatar":"bg-orange-500/20 border-orange-500/40 text-orange-300","name":"text-orange-300","dot":"bg-orange-400"},"body_color":"#14B8A6","sprite_body_class":"","icon":"ShieldCheck","accessory_id":"verifier_shield"}',
};

export function parseCharacterVisualJson(raw: string): CharacterVisualDoc | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value == null || typeof value !== "object") return null;
    const accent = value.accent as Record<string, unknown> | undefined;
    const avatar = typeof accent?.avatar === "string" ? accent.avatar.trim() : "";
    const name = typeof accent?.name === "string" ? accent.name.trim() : "";
    const dot = typeof accent?.dot === "string" ? accent.dot.trim() : "";
    const spriteBody =
      typeof value.sprite_body_class === "string" ? value.sprite_body_class.trim() : "";
    const bodyColorRaw =
      typeof value.body_color === "string" ? value.body_color.trim() : "";
    const bodyColorNorm = parseSafeBodyColorHex(bodyColorRaw);
    const icon = typeof value.icon === "string" ? value.icon.trim() : "";
    const accessoryId =
      typeof value.accessory_id === "string" ? value.accessory_id.trim() : "";
    const characterId =
      typeof value.character_id === "string" ? value.character_id.trim() : "";
    const schemaVersion =
      typeof value.schema_version === "number" ? value.schema_version : 1;
    const oxRaw = value.accessory_offset_x;
    const oyRaw = value.accessory_offset_y;
    const accessoryOffsetX =
      typeof oxRaw === "number" && Number.isFinite(oxRaw) ? Math.round(oxRaw) : 0;
    const accessoryOffsetY =
      typeof oyRaw === "number" && Number.isFinite(oyRaw) ? Math.round(oyRaw) : 0;
    const hasBodyPaint = bodyColorNorm != null || spriteBody !== "";
    if (
      avatar === "" ||
      name === "" ||
      dot === "" ||
      !hasBodyPaint ||
      icon === "" ||
      accessoryId === ""
    ) {
      return null;
    }
    const doc: CharacterVisualDoc = {
      schema_version: schemaVersion,
      character_id: characterId,
      accent: { avatar, name, dot },
      sprite_body_class: spriteBody,
      icon,
      accessory_id: accessoryId,
    };
    if (bodyColorNorm != null) doc.body_color = bodyColorNorm;
    if (accessoryOffsetX !== 0) doc.accessory_offset_x = accessoryOffsetX;
    if (accessoryOffsetY !== 0) doc.accessory_offset_y = accessoryOffsetY;
    return doc;
  } catch {
    return null;
  }
}

const bundledDocs = new Map<string, CharacterVisualDoc>();
for (const [filename, raw] of Object.entries(FALLBACK_CHARACTER_RAW_BY_FILENAME)) {
  const doc = parseCharacterVisualJson(raw);
  if (doc != null) bundledDocs.set(filename, doc);
}

const overlayDocs = new Map<string, CharacterVisualDoc>();
let overlayRevision = 0;
const overlayListeners = new Set<() => void>();

function bumpOverlayRevision() {
  overlayRevision += 1;
  overlayListeners.forEach((listener) => listener());
}

export function subscribeCharacterVisualOverlay(listener: () => void): () => void {
  overlayListeners.add(listener);
  return () => overlayListeners.delete(listener);
}

export function getCharacterVisualOverlayRevision(): number {
  return overlayRevision;
}

export function tryGetBundledCharacterRaw(filename: string): string | null {
  const key = filename.trim();
  if (key === "") return null;
  const raw = FALLBACK_CHARACTER_RAW_BY_FILENAME[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

export async function loadCharacterFileContentWithFallback(filename: string): Promise<string> {
  const f = filename.trim();
  if (f === "") throw new Error("character_filename_empty");
  if (isTauri()) {
    try {
      const s = await readAgentCharacterFile(f);
      if (s.trim() !== "") return s;
    } catch {
      /**/
    }
  }
  const bundled = tryGetBundledCharacterRaw(f);
  if (bundled != null) return bundled;
  throw new Error("character_load_failed");
}

export function getCharacterDocByFilename(filename: string): CharacterVisualDoc | null {
  const key = filename.trim();
  if (key === "") return null;
  const fromOverlay = overlayDocs.get(key);
  if (fromOverlay != null) return fromOverlay;
  return bundledDocs.get(key) ?? null;
}

export function getCharacterVisualForOfficeRole(
  officeRole: string | null | undefined,
): CharacterVisualDoc | null {
  const normalized = String(officeRole ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (normalized === "") return null;
  const entry = findAgentMetadataByOfficeRoleSync(normalized);
  const file = entry?.character?.trim();
  if (file == null || file === "") return null;
  return getCharacterDocByFilename(file);
}

export async function hydrateCharacterVisualsFromTauri(): Promise<void> {
  if (!isTauri()) return;
  const agents = listAgentsMetadataSync();
  const seen = new Set<string>();
  let changed = false;
  for (const agent of agents) {
    const file = agent.character?.trim();
    if (file == null || file === "" || seen.has(file)) continue;
    seen.add(file);
    try {
      const raw = await readAgentCharacterFile(file);
      const doc = parseCharacterVisualJson(raw);
      if (doc != null) {
        overlayDocs.set(file, doc);
        changed = true;
      } else if (overlayDocs.delete(file)) {
        changed = true;
      }
    } catch {
      if (overlayDocs.delete(file)) changed = true;
    }
  }
  if (changed) bumpOverlayRevision();
}

export async function applyCharacterFileSaveToOfficeVisuals(characterFilename: string): Promise<void> {
  const f = characterFilename.trim();
  if (!isTauri()) {
    bumpOverlayRevision();
    return;
  }
  if (f !== "") {
    try {
      const raw = await readAgentCharacterFile(f);
      const doc = parseCharacterVisualJson(raw);
      if (doc != null) {
        overlayDocs.set(f, doc);
      } else {
        overlayDocs.delete(f);
      }
    } catch {
      overlayDocs.delete(f);
    }
  }
  await hydrateCharacterVisualsFromTauri();
  bumpOverlayRevision();
}
