import { DEFAULT_BUNDLED_AGENTS_METADATA_JSON } from "./defaultBundledAgentsMetadata";

type TauriCore = {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};

type TauriWindow = Window & {
  __TAURI__?: {
    core?: TauriCore;
  };
};

export interface AgentsMetadataEntry {
  id: string;
  display_name: string;
  summary: string;
  office_role: string;
  prompt_key: string;
  prompt_file: string;
  skill_bundle_role: string;
  skill_bundle_refs: string[];
  character?: string;
}

export interface AgentsMetadataDocument {
  schema_version: number;
  agents: AgentsMetadataEntry[];
}

type AgentsMetadataCandidate = Partial<AgentsMetadataEntry> & {
  id?: string;
  display_name?: string;
  summary?: string;
  office_role?: string;
  prompt_key?: string;
  prompt_file?: string;
  skill_bundle_role?: string;
  skill_bundle_refs?: unknown;
  character?: string;
};

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

const DEFAULT_AGENT_METADATA_IDS = new Set<string>([
  "pm",
  "frontend",
  "backend",
  "reviewer",
  "verifier",
]);

export function isDefaultAgentMetadataId(id: string | null | undefined): boolean {
  const k = normalizeKey(id);
  return k !== "" && DEFAULT_AGENT_METADATA_IDS.has(k);
}

const AGENT_METADATA_CARD_DISPLAY_ORDER: Record<string, number> = {
  pm: 0,
  verifier: 1,
  reviewer: 2,
  frontend: 3,
  backend: 4,
};

export function sortAgentsMetadataEntriesForDisplay(
  entries: readonly AgentsMetadataEntry[],
): AgentsMetadataEntry[] {
  const copy = [...entries];
  copy.sort((a, b) => {
    const ra = AGENT_METADATA_CARD_DISPLAY_ORDER[a.id] ?? 1_000;
    const rb = AGENT_METADATA_CARD_DISPLAY_ORDER[b.id] ?? 1_000;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
  return copy;
}

function parseEntry(value: AgentsMetadataCandidate): AgentsMetadataEntry | null {
  const id = normalizeKey(value.id);
  const officeRole = normalizeKey(value.office_role);
  const promptKey = String(value.prompt_key ?? "").trim();
  if (id === "" || officeRole === "" || promptKey === "") return null;
  const characterRaw = String(value.character ?? "").trim();
  return {
    id,
    display_name: String(value.display_name ?? "").trim() || id,
    summary: String(value.summary ?? "").trim(),
    office_role: officeRole,
    prompt_key: promptKey,
    prompt_file: String(value.prompt_file ?? "").trim(),
    skill_bundle_role: normalizeKey(value.skill_bundle_role),
    skill_bundle_refs: Array.isArray(value.skill_bundle_refs)
      ? value.skill_bundle_refs
          .map((item) => String(item ?? "").trim())
          .filter((item) => item.length > 0)
      : [],
    ...(characterRaw !== "" ? { character: characterRaw } : {}),
  };
}

function parseDocument(value: unknown): AgentsMetadataDocument {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return { schema_version: 1, agents: [] };
  }
  const rawAgents = Array.isArray((value as { agents?: unknown }).agents)
    ? ((value as { agents: AgentsMetadataCandidate[] }).agents ?? [])
    : [];
  const seen = new Set<string>();
  const agents: AgentsMetadataEntry[] = [];
  for (const candidate of rawAgents) {
    const entry = parseEntry(candidate);
    if (entry == null || seen.has(entry.id)) continue;
    seen.add(entry.id);
    agents.push(entry);
  }
  return {
    schema_version:
      typeof (value as { schema_version?: unknown }).schema_version === "number"
        ? ((value as { schema_version: number }).schema_version ?? 1)
        : 1,
    agents,
  };
}

export function parseAgentsMetadataJson(raw: string): AgentsMetadataDocument {
  try {
    return parseDocument(JSON.parse(raw));
  } catch {
    return { schema_version: 1, agents: [] };
  }
}

const bundledDocument = parseAgentsMetadataJson(DEFAULT_BUNDLED_AGENTS_METADATA_JSON);
let cachedDocument: AgentsMetadataDocument = bundledDocument;
let loadPromise: Promise<AgentsMetadataDocument> | null = null;

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as TauriWindow).__TAURI__?.core
  );
}

async function loadRuntimeDocument(): Promise<AgentsMetadataDocument | null> {
  if (!isTauriRuntime()) return null;
  try {
    const raw = await (window as TauriWindow).__TAURI__!.core!.invoke("get_agents_metadata_json");
    if (typeof raw !== "string" || raw.trim() === "") return null;
    return parseAgentsMetadataJson(raw);
  } catch {
    return null;
  }
}

function searchKeys(entry: AgentsMetadataEntry): string[] {
  const keys = new Set<string>();
  const push = (value: string | null | undefined) => {
    const normalized = normalizeKey(value);
    if (normalized !== "") keys.add(normalized);
  };
  push(entry.id);
  push(entry.display_name);
  push(entry.office_role);
  push(entry.prompt_key);
  return Array.from(keys);
}

export function getAgentsMetadataDocumentSync(): AgentsMetadataDocument {
  return cachedDocument;
}

export async function loadAgentsMetadataDocument(): Promise<AgentsMetadataDocument> {
  if (loadPromise != null) return loadPromise;
  loadPromise = (async () => {
    const runtimeDocument = await loadRuntimeDocument();
    if (isTauriRuntime()) {
      cachedDocument = runtimeDocument ?? { schema_version: 1, agents: [] };
    } else {
      cachedDocument = runtimeDocument?.agents.length ? runtimeDocument : bundledDocument;
    }
    loadPromise = null;
    return cachedDocument;
  })();
  return loadPromise;
}

export async function refreshAgentsMetadataCache(): Promise<AgentsMetadataDocument> {
  loadPromise = null;
  const runtimeDocument = await loadRuntimeDocument();
  if (isTauriRuntime()) {
    cachedDocument = runtimeDocument ?? { schema_version: 1, agents: [] };
    return cachedDocument;
  }
  if (runtimeDocument != null && runtimeDocument.agents.length > 0) {
    cachedDocument = runtimeDocument;
    return cachedDocument;
  }
  cachedDocument = bundledDocument;
  return cachedDocument;
}

export function listAgentsMetadataSync(): AgentsMetadataEntry[] {
  return getAgentsMetadataDocumentSync().agents;
}

export async function listAgentsMetadata(): Promise<AgentsMetadataEntry[]> {
  const document = await loadAgentsMetadataDocument();
  return document.agents;
}

export function findAgentMetadataByCandidatesSync(
  candidates: Array<string | null | undefined>,
  entries: AgentsMetadataEntry[] = listAgentsMetadataSync(),
): AgentsMetadataEntry | null {
  const normalizedCandidates = candidates
    .map((value) => normalizeKey(value))
    .filter((value) => value.length > 0);
  if (normalizedCandidates.length === 0) return null;
  return (
    entries.find((entry) =>
      searchKeys(entry).some((key) => normalizedCandidates.includes(key)),
    ) ?? null
  );
}

export async function findAgentMetadataByCandidates(
  candidates: Array<string | null | undefined>,
): Promise<AgentsMetadataEntry | null> {
  const entries = await listAgentsMetadata();
  return findAgentMetadataByCandidatesSync(candidates, entries);
}

export function findAgentMetadataByIdSync(id: string): AgentsMetadataEntry | null {
  return findAgentMetadataByCandidatesSync([id]);
}

export async function findAgentMetadataById(id: string): Promise<AgentsMetadataEntry | null> {
  return findAgentMetadataByCandidates([id]);
}

export function findAgentMetadataByOfficeRoleSync(role: string): AgentsMetadataEntry | null {
  const normalizedRole = normalizeKey(role);
  if (normalizedRole === "") return null;
  return (
    listAgentsMetadataSync().find((entry) => normalizeKey(entry.office_role) === normalizedRole) ??
    null
  );
}

export async function findAgentMetadataByOfficeRole(role: string): Promise<AgentsMetadataEntry | null> {
  const normalizedRole = normalizeKey(role);
  if (normalizedRole === "") return null;
  const entries = await listAgentsMetadata();
  return (
    entries.find((entry) => normalizeKey(entry.office_role) === normalizedRole) ?? null
  );
}

export function resolveAgentIdForOfficeRoleSync(role: string): string | null {
  return findAgentMetadataByOfficeRoleSync(role)?.id ?? null;
}

export function resolveOfficeRoleForAgentIdSync(agentId: string): string | null {
  return findAgentMetadataByIdSync(agentId)?.office_role ?? null;
}

export function toRosterAgentMetaList(
  document: AgentsMetadataDocument = getAgentsMetadataDocumentSync(),
): Array<{
  id: string;
  prompt_key: string;
  display_name: string;
  summary: string;
  office_role: string;
  skill_bundle_role: string;
  skill_bundle_refs: string[];
}> {
  return document.agents.map((entry) => ({
    id: entry.id,
    prompt_key: entry.prompt_key,
    display_name: entry.display_name,
    summary: entry.summary,
    office_role: entry.office_role,
    skill_bundle_role: entry.skill_bundle_role,
    skill_bundle_refs: entry.skill_bundle_refs,
  }));
}

export function serializeAgentsMetadataDocument(
  document: AgentsMetadataDocument = getAgentsMetadataDocumentSync(),
): string {
  return JSON.stringify(document, null, 2);
}

export function extractPromptFileBasename(inPromptFile: string): string {
  const s = inPromptFile.trim().replace(/\\/g, "/");
  if (s === "") return "";
  const segments = s.split("/");
  const leaf = segments[segments.length - 1] ?? "";
  const dot = leaf.lastIndexOf(".");
  if (dot <= 0) return leaf;
  return leaf.slice(0, dot);
}

export function serializeAgentsMetadataEntryForJson(entry: AgentsMetadataEntry): Record<string, unknown> {
  const characterRaw = entry.character?.trim() ?? "";
  const base: Record<string, unknown> = {
    id: entry.id,
    display_name: entry.display_name,
    summary: entry.summary,
    office_role: entry.office_role,
    prompt_key: entry.prompt_key,
    prompt_file: entry.prompt_file,
    skill_bundle_role: entry.skill_bundle_role,
    skill_bundle_refs: [...entry.skill_bundle_refs],
  };
  if (characterRaw !== "") {
    base.character = characterRaw;
  }
  return base;
}

export function normalizeAgentsMetadataEntryFromFields(input: {
  id: string;
  display_name: string;
  summary: string;
  office_role: string;
  prompt_key: string;
  prompt_file: string;
  skill_bundle_role: string;
  skill_bundle_refs: string[];
  character: string;
}): AgentsMetadataEntry | null {
  const id = normalizeKey(input.id);
  const officeRole = normalizeKey(input.office_role);
  const promptKey = String(input.prompt_key ?? "").trim();
  if (id === "" || officeRole === "" || promptKey === "") return null;
  const characterRaw = String(input.character ?? "").trim();
  return {
    id,
    display_name: String(input.display_name ?? "").trim() || id,
    summary: String(input.summary ?? "").trim(),
    office_role: officeRole,
    prompt_key: promptKey,
    prompt_file: String(input.prompt_file ?? "").trim(),
    skill_bundle_role: normalizeKey(input.skill_bundle_role),
    skill_bundle_refs: (input.skill_bundle_refs ?? [])
      .map((item) => String(item ?? "").trim())
      .filter((item) => item.length > 0),
    ...(characterRaw !== "" ? { character: characterRaw } : {}),
  };
}

export function parseAgentsMetadataRootPayload(raw: string): {
  root: Record<string, unknown>;
  agents: AgentsMetadataEntry[];
} | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const root = { ...(parsed as Record<string, unknown>) };
    const document = parseAgentsMetadataJson(raw);
    return { root, agents: document.agents };
  } catch {
    return null;
  }
}

export function mergeAgentsIntoMetadataRoot(
  root: Record<string, unknown>,
  agents: AgentsMetadataEntry[],
): Record<string, unknown> {
  return {
    ...root,
    agents: agents.map(serializeAgentsMetadataEntryForJson),
  };
}
