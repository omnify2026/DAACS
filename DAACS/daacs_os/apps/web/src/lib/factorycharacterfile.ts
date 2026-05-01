import {
  ACCESSORY_CATALOG_IDS,
  getAgentAccent,
  getAgentSpriteFallbackTailwindClass,
} from "./agentVisuals";
import { isTauri, readAgentCharacterFile, saveAgentCharacterFile } from "../services/tauriCli";
import type { AgentRole } from "../types/agent";

export async function ensureUserCharacterFileStub(
  characterFilename: string,
  agentId: string,
  fallbackRole: AgentRole,
): Promise<void> {
  const file = characterFilename.trim();
  if (!isTauri() || file === "") return;
  try {
    const raw = await readAgentCharacterFile(file);
    if (raw.trim() !== "") return;
  } catch {
    // Missing stubs should fall through to local stub creation.
  }
  const accent = getAgentAccent(String(fallbackRole));
  const firstAcc = ACCESSORY_CATALOG_IDS[0] ?? "pm_clipboard";
  const bodyDefault = getAgentSpriteFallbackTailwindClass(fallbackRole);
  const cid = String(agentId ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const obj = {
    schema_version: 1,
    character_id: cid !== "" ? cid : String(fallbackRole),
    accent: { avatar: accent.avatar, name: accent.name, dot: accent.dot },
    sprite_body_class: bodyDefault,
    icon: "Bot",
    accessory_id: firstAcc,
  };
  await saveAgentCharacterFile(file, JSON.stringify(obj, null, 2));
}
