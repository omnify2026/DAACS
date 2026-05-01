import { create } from "zustand";

import type {
  Agent,
  AgentErrorRecord,
  AgentEvent,
  AgentMessageRecord,
  AgentRole,
  AgentStatus,
  AgentTeam,
  Command,
  FileChangeRecord,
  FurnitureItem,
  GameState,
  Notification,
  PendingTransfer,
  CollaborationVisit,
  Point,
  Room,
  TaskRecord,
  WorkLogEntry,
  AgentUiProfile,
  BuiltinAgentRole,
  SharedAgentReference,
  SharedAgentSyncMode,
} from "../types/agent";
import { getAgentMeta } from "../types/agent";
import type {
  GlobalOfficeStateDocument,
  OfficeFurnitureType,
  OfficeTemplateDocument,
  ProjectOfficeProfile,
  SharedAgentProfileDocument,
} from "../types/office";
import type { RuntimeBundleResponse } from "../types/runtime";
import * as runtimeApi from "../services/runtimeApi";
import { clockIn as backendClockIn, clockOut as backendClockOut } from "../services/agentApi";
import {
  clearLocalOfficeState,
  getAgentPromptByPromptKey,
  isTauri,
  loadGlobalOfficeState,
  loadLocalOfficeState,
  saveFactoryAgentToResources,
  saveGlobalOfficeState,
  saveLocalOfficeState,
} from "../services/tauriCli";
import {
  STORAGE_KEY_GLOBAL_OFFICE_STATE,
  STORAGE_KEY_OFFICE_STATE_PREFIX,
} from "../constants";
import {
  buildDefaultOfficeZones,
  buildDeskPositionMap,
  buildMeetingPositionMap,
  buildOfficeZones,
  buildRuntimeAgents,
  findOfficeZoneForPoint,
  type RuntimeOfficeZone,
} from "../lib/runtimeUi";
import { buildAgentOperatingProfile } from "../lib/agentOperatingProfile";
import { ensureUserCharacterFileStub } from "../lib/factoryCharacterFile";
import { listAgentsMetadataSync, refreshAgentsMetadataCache } from "../lib/agentsMetadata";
import { buildProjectOfficeProfile, parseProjectOfficeProfile } from "../lib/officeProfile";
import {
  buildOfficeZonesForProfile,
  clampPointToZone,
  markOfficeProfileCustomized,
  resolveAgentZoneId,
  settleAgentStatus,
  type OfficeThemePatch,
  type OfficeZonePatch,
  upsertOfficeAssignment,
} from "../lib/officeCustomization";
import {
  buildDefaultGlobalOfficeState,
  createSharedAgentProfile,
  deriveGlobalOfficeProfileFromProject,
  mergeOfficeProfileWithGlobalDefaults,
  parseGlobalOfficeState,
  serializeGlobalOfficeState,
} from "../lib/officeGlobalState";
import {
  buildEffectiveRoutingForFurniture,
  clampFurnitureAnchorToZone,
  createOfficeFurnitureDocument,
  removeOfficeFurniture,
  type OfficeFurniturePatch,
  upsertOfficeFurniture,
} from "../lib/officeFurniture";
import {
  applyOfficeTemplateToProject,
  deriveOfficeTemplateFromProject,
} from "../lib/officeTemplates";
import { buildDefaultOfficeFurniture } from "../lib/officeDefaultFurniture";
import { syncAgentsFromSharedReferences } from "../lib/sharedAgentReferences";
import { calculatePath, pathDuration } from "../lib/officePathing";
import { handleWsEventWithBridge } from "./wsEventBridge";
import { useOfficeSceneStore } from "./officeSceneStore";
import { useWorkflowStore } from "./workflowStore";
import { useAgentCommandStore } from "./agentCommandStore";

const CORE_DEFAULT_AGENT_IDS = new Set<string>([
  "pm",
  "frontend",
  "backend",
  "reviewer",
  "verifier",
]);
const CORE_DEFAULT_AGENT_ROLES: BuiltinAgentRole[] = [
  "pm",
  "developer_front",
  "developer_back",
  "reviewer",
  "verifier",
];
const CORE_DEFAULT_BLUEPRINT_IDS = new Set<string>([
  "builtin-pm",
  "builtin-reviewer",
  "builtin-verifier",
]);
const LEGACY_BUNDLED_IMPLEMENTATION_AGENT_IDS = new Set<string>([
  "developer",
  "designer",
  "devops",
]);

const LOBBY_ENTRY: Point = { x: 600, y: 760 };
const ARRIVAL_START_DELAY_MS = 350;
const ARRIVAL_STAGGER_MS = 700;
const OFFICE_STATE_SNAPSHOT_VERSION = 2;
const OFFICE_STATE_PERSIST_DELAY_MS = 180;
let meetingTransitionTimer: ReturnType<typeof setTimeout> | null = null;
let arrivalTimers: ReturnType<typeof setTimeout>[] = [];
let officePersistTimer: ReturnType<typeof setTimeout> | null = null;

const DEFAULT_HOME_ZONES: Record<BuiltinAgentRole, string> = {
  ceo: "ceo_office",
  pm: "meeting_room",
  developer: "rd_lab",
  developer_front: "rd_lab",
  developer_back: "rd_lab",
  reviewer: "rd_lab",
  verifier: "server_farm",
  devops: "server_farm",
  marketer: "marketing_studio",
  designer: "design_studio",
  cfo: "finance_room",
};

const DEFAULT_TEAM_AFFINITY: Record<BuiltinAgentRole, string> = {
  ceo: "executive_team",
  pm: "executive_team",
  developer: "development_team",
  developer_front: "development_team",
  developer_back: "development_team",
  reviewer: "review_team",
  verifier: "review_team",
  devops: "operations_team",
  marketer: "marketing_team",
  designer: "creative_team",
  cfo: "finance_team",
};

const DEFAULT_ROOMS: Room[] = buildRoomsFromZones(buildDefaultOfficeZones());

interface OfficeStateSnapshot {
  version: number;
  projectId: string;
  officeProfile: ProjectOfficeProfile | null;
  agents: Agent[];
  commandHistory: Command[];
  workLogs: Record<string, WorkLogEntry[]>;
  taskHistory: Record<string, TaskRecord[]>;
  fileChanges: Record<string, FileChangeRecord[]>;
  agentErrors: Record<string, AgentErrorRecord[]>;
  agentMessages: AgentMessageRecord[];
  pendingTransfers: PendingTransfer[];
  collaborationVisits: CollaborationVisit[];
  localAgentSlots: number;
  localCustomAgentCount: number;
}

function buildRoomsFromZones(zones: RuntimeOfficeZone[]): Room[] {
  return zones.map((zone, index) => ({
    id: index,
    name: zone.label,
    row: zone.row,
    col: zone.col,
  }));
}

function buildBuiltinUiProfile(role: BuiltinAgentRole): AgentUiProfile {
  const meta = getAgentMeta(role);
  return {
    display_name: meta.name,
    title: meta.title,
    accent_color: meta.color,
    icon: meta.icon,
    home_zone: DEFAULT_HOME_ZONES[role],
    team_affinity: DEFAULT_TEAM_AFFINITY[role],
    authority_level: role === "ceo" ? 100 : role === "pm" ? 80 : 50,
    capability_tags: [role],
    primary_widgets: [],
    secondary_widgets: [],
    focus_mode: "default",
    meeting_behavior: "standard",
  };
}

function officeStateStorageKey(projectId: string): string {
  return `${STORAGE_KEY_OFFICE_STATE_PREFIX}:${projectId}`;
}

function readGlobalOfficeStateLocal(): GlobalOfficeStateDocument {
  if (typeof localStorage === "undefined") return buildDefaultGlobalOfficeState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY_GLOBAL_OFFICE_STATE);
    if (!raw) return buildDefaultGlobalOfficeState();
    return parseGlobalOfficeState(JSON.parse(raw));
  } catch {
    return buildDefaultGlobalOfficeState();
  }
}

function writeGlobalOfficeStateLocal(globalOfficeState: GlobalOfficeStateDocument): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      STORAGE_KEY_GLOBAL_OFFICE_STATE,
      serializeGlobalOfficeState(globalOfficeState),
    );
  } catch {
    /**/
  }
}

function readLocalSnapshot(projectId: string): OfficeStateSnapshot | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(officeStateStorageKey(projectId));
    if (!raw) return null;
    return parseOfficeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function normalizeAgentKey(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function isCoreDefaultAgent(agent: Pick<Agent, "id" | "blueprintId">): boolean {
  return (
    CORE_DEFAULT_AGENT_IDS.has(normalizeAgentKey(agent.id)) ||
    CORE_DEFAULT_BLUEPRINT_IDS.has(normalizeAgentKey(agent.blueprintId))
  );
}

function isLegacyBundledImplementationAgent(agent: Pick<Agent, "id" | "promptKey">): boolean {
  const id = normalizeAgentKey(agent.id);
  const promptKey = normalizeAgentKey(agent.promptKey);
  return (
    LEGACY_BUNDLED_IMPLEMENTATION_AGENT_IDS.has(id) &&
    [
      "agent_developer",
      "agent_designer",
      "agent_devops",
      "agent_frontend",
      "agent_backend",
    ].includes(promptKey)
  );
}

function pruneLegacyBundledImplementationAgents(agents: Agent[]): Agent[] {
  return agents.filter((agent) => !isLegacyBundledImplementationAgent(agent));
}

function shouldKeepAgentScopedKey(key: string, activeAgentIds: Set<string>): boolean {
  const normalized = normalizeAgentKey(key).replace(/^agent:/, "");
  return activeAgentIds.has(normalized) || CORE_DEFAULT_AGENT_IDS.has(normalized);
}

function filterAgentScopedRecord<T>(
  record: Record<string, T>,
  activeAgentIds: Set<string>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => shouldKeepAgentScopedKey(key, activeAgentIds)),
  );
}

function shouldKeepAgentMessage(message: AgentMessageRecord, activeAgentIds: Set<string>): boolean {
  const idRefs = [message.fromAgentId, message.toAgentId].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  if (idRefs.length > 0) {
    return idRefs.every((value) => shouldKeepAgentScopedKey(value, activeAgentIds));
  }
  const roleRefs = [message.from, message.to].filter(
    (value): value is string => typeof value === "string" && value.trim() !== "",
  );
  return roleRefs.length > 0 &&
    roleRefs.every((value) => shouldKeepAgentScopedKey(value, activeAgentIds));
}

function shouldKeepCommand(command: Command, activeAgentIds: Set<string>): boolean {
  if (command.agentId && activeAgentIds.has(normalizeAgentKey(command.agentId))) {
    return true;
  }
  return CORE_DEFAULT_AGENT_IDS.has(normalizeAgentKey(command.agentRole));
}

function sanitizePersistedOfficeSnapshotForAgents(
  snapshot: OfficeStateSnapshot,
  activeAgents: Agent[],
): OfficeStateSnapshot {
  const activeRoster = pruneLegacyBundledImplementationAgents(activeAgents);
  const activeAgentIds = new Set(activeRoster.map((agent) => normalizeAgentKey(agent.id)));
  const agents = pruneLegacyBundledImplementationAgents(snapshot.agents);
  const localCustomAgentCount = agents.filter((agent) => !isCoreDefaultAgent(agent)).length;
  const shouldResetLegacyCoreOnlyHistory =
    snapshot.version < OFFICE_STATE_SNAPSHOT_VERSION && localCustomAgentCount === 0;
  if (shouldResetLegacyCoreOnlyHistory) {
    return {
      ...snapshot,
      version: OFFICE_STATE_SNAPSHOT_VERSION,
      agents,
      commandHistory: [],
      workLogs: {},
      taskHistory: {},
      fileChanges: {},
      agentErrors: {},
      agentMessages: [],
      pendingTransfers: [],
      collaborationVisits: [],
      localCustomAgentCount,
    };
  }
  return {
    ...snapshot,
    version: OFFICE_STATE_SNAPSHOT_VERSION,
    agents,
    commandHistory: snapshot.commandHistory.filter((command) =>
      shouldKeepCommand(command, activeAgentIds),
    ),
    workLogs: filterAgentScopedRecord(snapshot.workLogs, activeAgentIds),
    taskHistory: filterAgentScopedRecord(snapshot.taskHistory, activeAgentIds),
    fileChanges: Object.fromEntries(
      Object.entries(snapshot.fileChanges).filter(([key]) =>
        shouldKeepAgentScopedKey(key, activeAgentIds),
      ),
    ),
    agentErrors: filterAgentScopedRecord(snapshot.agentErrors, activeAgentIds),
    agentMessages: snapshot.agentMessages.filter((message) =>
      shouldKeepAgentMessage(message, activeAgentIds),
    ),
    pendingTransfers: snapshot.pendingTransfers.filter(
      (transfer) =>
        shouldKeepAgentScopedKey(transfer.from, activeAgentIds) &&
        shouldKeepAgentScopedKey(transfer.to, activeAgentIds),
    ),
    collaborationVisits: [],
    localCustomAgentCount,
  };
}

function writeLocalSnapshot(projectId: string, snapshot: OfficeStateSnapshot): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(officeStateStorageKey(projectId), JSON.stringify(snapshot));
  } catch {
    /**/
  }
}

function clearLocalSnapshot(projectId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(officeStateStorageKey(projectId));
  } catch {
    /**/
  }
}

function parseOfficeSnapshot(value: unknown): OfficeStateSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<OfficeStateSnapshot>;
  if (typeof candidate.projectId !== "string" || !Array.isArray(candidate.agents)) {
    return null;
  }
  return {
    version:
      typeof candidate.version === "number"
        ? candidate.version
        : OFFICE_STATE_SNAPSHOT_VERSION,
    projectId: candidate.projectId,
    officeProfile: parseProjectOfficeProfile(candidate.officeProfile, candidate.projectId),
    agents: pruneLegacyBundledImplementationAgents(candidate.agents),
    commandHistory: Array.isArray(candidate.commandHistory) ? candidate.commandHistory : [],
    workLogs: candidate.workLogs ?? {},
    taskHistory: candidate.taskHistory ?? {},
    fileChanges: candidate.fileChanges ?? {},
    agentErrors: candidate.agentErrors ?? {},
    agentMessages: Array.isArray(candidate.agentMessages) ? candidate.agentMessages : [],
    pendingTransfers: Array.isArray(candidate.pendingTransfers) ? candidate.pendingTransfers : [],
    collaborationVisits: [],
    localAgentSlots:
      typeof candidate.localAgentSlots === "number" ? candidate.localAgentSlots : 8,
    localCustomAgentCount:
      typeof candidate.localCustomAgentCount === "number"
        ? candidate.localCustomAgentCount
        : candidate.agents.filter(
            (InAgent) => InAgent != null && !isCoreDefaultAgent(InAgent),
          ).length,
  };
}

function buildOfficeSnapshot(state: OfficeState): OfficeStateSnapshot | null {
  if (!state.projectId) return null;
  return {
    version: OFFICE_STATE_SNAPSHOT_VERSION,
    projectId: state.projectId,
    officeProfile: state.officeProfile,
    agents: state.agents,
    commandHistory: state.commandHistory,
    workLogs: state.workLogs,
    taskHistory: state.taskHistory,
    fileChanges: state.fileChanges,
    agentErrors: state.agentErrors,
    agentMessages: state.agentMessages,
    pendingTransfers: state.pendingTransfers,
    collaborationVisits: [],
    localAgentSlots: state.localAgentSlots,
    localCustomAgentCount: state.localCustomAgentCount,
  };
}

async function persistOfficeSnapshot(projectId: string, snapshot: OfficeStateSnapshot): Promise<void> {
  writeLocalSnapshot(projectId, snapshot);
  if (isTauri()) {
    await saveLocalOfficeState(projectId, snapshot);
  }
}

async function persistGlobalOfficeState(globalOfficeState: GlobalOfficeStateDocument): Promise<void> {
  writeGlobalOfficeStateLocal(globalOfficeState);
  if (isTauri()) {
    await saveGlobalOfficeState(globalOfficeState);
  }
}

async function restoreOfficeSnapshot(projectId: string): Promise<OfficeStateSnapshot | null> {
  if (isTauri()) {
    const tauriSnapshot = parseOfficeSnapshot(
      await loadLocalOfficeState<OfficeStateSnapshot>(projectId),
    );
    if (tauriSnapshot) {
      writeLocalSnapshot(projectId, tauriSnapshot);
      return tauriSnapshot;
    }
  }
  return readLocalSnapshot(projectId);
}

async function restoreGlobalOfficeState(): Promise<GlobalOfficeStateDocument> {
  if (isTauri()) {
    const tauriSnapshot = parseGlobalOfficeState(
      await loadGlobalOfficeState<GlobalOfficeStateDocument>(),
    );
    writeGlobalOfficeStateLocal(tauriSnapshot);
    return tauriSnapshot;
  }
  return readGlobalOfficeStateLocal();
}

function effectiveOfficeRouting(
  officeProfile: ProjectOfficeProfile | null | undefined,
) {
  if (!officeProfile) return null;
  return buildEffectiveRoutingForFurniture(officeProfile.routing, officeProfile.furniture);
}

function syncAgentsWithGlobalState(
  agents: Agent[],
  globalOfficeState: GlobalOfficeStateDocument,
): Agent[] {
  return syncAgentsFromSharedReferences(agents, globalOfficeState.shared_agents);
}

function upsertOfficeTemplate(
  officeTemplates: OfficeTemplateDocument[],
  nextTemplate: OfficeTemplateDocument,
): OfficeTemplateDocument[] {
  return [
    ...officeTemplates.filter((template) => template.template_id !== nextTemplate.template_id),
    nextTemplate,
  ];
}

async function clearPersistedOfficeSnapshot(projectId: string): Promise<void> {
  clearLocalSnapshot(projectId);
  if (isTauri()) {
    await clearLocalOfficeState(projectId);
  }
}

function mergePersistedAgents(runtimeAgents: Agent[], persistedAgents: Agent[]): Agent[] {
  if (persistedAgents.length === 0) return runtimeAgents;
  const persistedById = new Map(persistedAgents.map((agent) => [agent.id, agent]));
  const mergedAgents = runtimeAgents.map((agent) => {
    const persisted = persistedById.get(agent.id);
    if (!persisted) {
      return agent;
    }
    return {
      ...agent,
      promptKey: agent.promptKey ?? persisted.promptKey,
      position: agent.position,
      path: [],
      runtimeStatus: persisted.runtimeStatus ?? agent.runtimeStatus,
      status: agent.status,
      currentTask: agent.currentTask,
      message: agent.message,
      sharedAgentRef: persisted.sharedAgentRef ?? agent.sharedAgentRef,
      capabilities: persisted.capabilities ?? agent.capabilities,
      skillBundleRefs: persisted.skillBundleRefs ?? agent.skillBundleRefs,
      operatingProfile: persisted.operatingProfile ?? agent.operatingProfile,
      assignedTeam: persisted.assignedTeam ?? agent.assignedTeam,
    };
  });
  return mergedAgents;
}

const FALLBACK_ARRIVAL_PRIORITY: Record<BuiltinAgentRole, number> = {
  ceo: 0,
  pm: 1,
  developer: 2,
  developer_front: 2,
  developer_back: 3,
  reviewer: 4,
  verifier: 5,
  devops: 6,
  marketer: 7,
  designer: 8,
  cfo: 9,
};

function orderAgentsForArrival(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    const leftPriority =
      typeof left.uiProfile?.authority_level === "number"
        ? -left.uiProfile.authority_level
        : FALLBACK_ARRIVAL_PRIORITY[left.role as BuiltinAgentRole] ?? Number.MAX_SAFE_INTEGER;
    const rightPriority =
      typeof right.uiProfile?.authority_level === "number"
        ? -right.uiProfile.authority_level
        : FALLBACK_ARRIVAL_PRIORITY[right.role as BuiltinAgentRole] ?? Number.MAX_SAFE_INTEGER;

    if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    return left.name.localeCompare(right.name);
  });
}

interface OfficeState {
  projectId: string | null;
  wsConnected: boolean;
  gameState: GameState;
  agents: Agent[];
  selectedAgentId: string | null;
  notifications: Notification[];
  showSettings: boolean;
  editMode: boolean;
  editFurnitureMode: "move" | "delete";
  editFurniturePlacementType: OfficeFurnitureType | null;
  furniture: FurnitureItem[];
  rooms: Room[];
  officeProfile: ProjectOfficeProfile | null;
  globalOfficeState: GlobalOfficeStateDocument;
  officeZones: RuntimeOfficeZone[];
  deskPositions: Record<string, Point>;
  meetingPositions: Record<string, Point>;
  commandHistory: Command[];
  workLogs: Record<string, WorkLogEntry[]>;
  taskHistory: Record<string, TaskRecord[]>;
  fileChanges: Record<string, FileChangeRecord[]>;
  agentErrors: Record<string, AgentErrorRecord[]>;
  agentMessages: AgentMessageRecord[];
  pendingTransfers: PendingTransfer[];
  collaborationVisits: CollaborationVisit[];
  arrivingAgentIds: string[];
  localAgentSlots: number;
  localCustomAgentCount: number;

  setProjectId: (id: string | null) => void;
  hydrateGlobalOfficeState: () => Promise<void>;
  syncRuntimeBundle: (bundle: RuntimeBundleResponse | null) => void;
  saveOfficeProfile: (officeProfile: ProjectOfficeProfile) => Promise<RuntimeBundleResponse | null>;
  updateGlobalTheme: (patch: OfficeThemePatch) => Promise<void>;
  promoteCurrentOfficeToGlobalDefault: () => Promise<void>;
  clearGlobalDefaultOffice: () => Promise<void>;
  shareAgentGlobally: (agentId: string) => Promise<void>;
  removeSharedAgent: (globalAgentId: string) => Promise<void>;
  importSharedAgentToOffice: (globalAgentId: string) => Promise<void>;
  saveCurrentOfficeAsTemplate: (
    name?: string,
    description?: string,
  ) => Promise<OfficeTemplateDocument | null>;
  applyOfficeTemplate: (templateId: string) => void;
  setDefaultOfficeTemplate: (templateId: string | null) => Promise<void>;
  updateOfficeName: (name: string) => void;
  updateOfficeTheme: (patch: OfficeThemePatch) => void;
  updateOfficeZone: (zoneId: string, patch: OfficeZonePatch) => void;
  addOfficeFurniture: (zoneId: string, type: OfficeFurnitureType) => void;
  updateOfficeFurniture: (furnitureId: string, patch: OfficeFurniturePatch) => void;
  removeOfficeFurniture: (furnitureId: string) => void;
  placeOfficeFurnitureAtPoint: (type: OfficeFurnitureType, point: Point) => void;
  setEditFurnitureMode: (mode: "move" | "delete") => void;
  setEditFurniturePlacementType: (type: OfficeFurnitureType | null) => void;
  setAgentSharedSyncMode: (agentId: string, syncMode: SharedAgentSyncMode) => void;
  assignAgentToZone: (agentId: string, zoneId: string) => void;
  moveAgentToPoint: (agentId: string, point: Point) => void;
  resetAgentPlacement: (agentId: string) => void;
  addCustomAgentLocal: (draft: LocalCustomAgentDraft) => Promise<{
    added: boolean;
    agent: { id: string; name: string; role: string; prompt: string; promptKey?: string };
    slot: { used: number; total: number; remaining: number };
  }>;
  buildCompanyAgentsLocal: (drafts: LocalCustomAgentDraft[]) => Promise<{ created: number; skipped: number }>;
  unlockSlotLocal: () => { agent_slots: number; custom_agent_count: number };
  setWsConnected: (v: boolean) => void;
  clockIn: () => Promise<void>;
  clockOut: () => Promise<void>;
  reconcileOfficeAgentsWithMetadata: () => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  setAgentTask: (id: string, task: string) => void;
  setAgentTaskByRole: (role: AgentRole, task: string) => void;
  triggerAgentError: (id: string, message: string) => void;
  selectAgent: (id: string | null) => void;
  startMeeting: () => void;
  endMeeting: () => void;
  handleWsEvent: (event: AgentEvent) => void;
  clearWorkLog: (role: AgentRole) => void;
  dismissTransfer: (id: string) => void;
  dismissCollaborationVisit: (id: string) => void;
  runTeamTask: (team: AgentTeam, instruction: string) => Promise<void>;
  runTeamSwarm: () => Promise<void>;
  sendCommand: (role: AgentRole, message: string, agentId?: string | null) => Promise<void>;
  addNotification: (n: Omit<Notification, "id" | "timestamp">) => void;
  dismissNotification: (id: string) => void;
  setGameState: (s: GameState) => void;
  toggleSettings: () => void;
  toggleEditMode: () => void;
}

const makeDefaultAgents = (
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
): Agent[] => {
  const metadataAgents = listAgentsMetadataSync();
  if (metadataAgents.length > 0) {
    return buildMetadataDefaultAgents(metadataAgents, officeZones);
  }
  const seededAgents = CORE_DEFAULT_AGENT_ROLES.map((role) => {
    const uiProfile = buildBuiltinUiProfile(role);
    return {
      id: `agent-${role}`,
      role,
      name: getAgentMeta(role).name,
      meta: getAgentMeta(role),
      uiProfile,
      operatingProfile: buildAgentOperatingProfile({
        role,
        capabilities: [role],
        focusMode: uiProfile.focus_mode,
      }),
      assignedTeam: DEFAULT_TEAM_AFFINITY[role],
      runtimeStatus: "idle",
      position: LOBBY_ENTRY,
      path: [],
      status: "idle" as AgentStatus,
      capabilities: [role],
    };
  });
  return applyOfficeLayout(seededAgents, officeZones).agents;
};

function ensureCoreDefaultAgents(
  agents: Agent[],
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
): Agent[] {
  const normalizedIds = new Set(agents.map((agent) => normalizeAgentKey(agent.id)));
  const normalizedRoles = new Set(agents.map((agent) => normalizeAgentKey(agent.role)));
  const missingDefaults = makeDefaultAgents(officeZones).filter((agent) => {
    const id = normalizeAgentKey(agent.id);
    const role = normalizeAgentKey(agent.role);
    return (
      (CORE_DEFAULT_AGENT_IDS.has(id) || CORE_DEFAULT_AGENT_ROLES.includes(agent.role as BuiltinAgentRole)) &&
      !normalizedIds.has(id) &&
      !normalizedRoles.has(role)
    );
  });
  if (missingDefaults.length === 0) return agents;
  return applyOfficeLayout([...agents, ...missingDefaults], officeZones).agents;
}

function buildMetadataDefaultAgents(
  InMetadataAgents: Array<{
    id: string;
    display_name: string;
    prompt_key: string;
    office_role: string;
    skill_bundle_refs?: string[];
  }>,
  InOfficeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
): Agent[] {
  const seededAgents: Agent[] = [];
  for (const meta of InMetadataAgents) {
    const metadataId = String(meta.id ?? "").trim().toLowerCase();
    if (metadataId === "") continue;
    const role = (String(meta.office_role ?? "").trim().toLowerCase() || "developer") as AgentRole;
    const inferredMeta = getAgentMeta(role, {
      name: String(meta.display_name ?? "").trim() || metadataId,
      title: String(meta.display_name ?? "").trim() || metadataId,
    });
    const uiProfile: AgentUiProfile = {
      display_name: inferredMeta.name,
      title: inferredMeta.title,
      accent_color: inferredMeta.color,
      icon: inferredMeta.icon,
      home_zone:
        role in DEFAULT_HOME_ZONES ? DEFAULT_HOME_ZONES[role as BuiltinAgentRole] : "lobby",
      team_affinity:
        role in DEFAULT_TEAM_AFFINITY ? DEFAULT_TEAM_AFFINITY[role as BuiltinAgentRole] : "custom_team",
      authority_level: role === "pm" ? 9 : 5,
      capability_tags: [metadataId],
      primary_widgets: ["timeline"],
      secondary_widgets: [],
      focus_mode: "default",
      meeting_behavior: "standard",
    };
    seededAgents.push({
      id: metadataId,
      role,
      name: inferredMeta.name,
      promptKey: String(meta.prompt_key ?? "").trim() || undefined,
      meta: inferredMeta,
      uiProfile,
      operatingProfile: buildAgentOperatingProfile({
        role,
        capabilities: [metadataId],
        focusMode: uiProfile.focus_mode,
      }),
      assignedTeam: uiProfile.team_affinity ?? "custom_team",
      runtimeStatus: "idle",
      position: LOBBY_ENTRY,
      path: [],
      status: "idle" as AgentStatus,
      capabilities: [metadataId],
      skillBundleRefs: Array.isArray(meta.skill_bundle_refs) ? meta.skill_bundle_refs : [],
    });
  }
  return applyOfficeLayout(seededAgents, InOfficeZones).agents;
}

type LocalCustomAgentDraft = {
  name: string;
  roleLabel: string;
  prompt: string;
  summary?: string;
  capabilities: string[];
  skillBundleRefs: string[];
  uiProfile?: AgentUiProfile;
  operatingProfile?: Agent["operatingProfile"];
  sharedAgentRef?: SharedAgentReference | null;
  metadataAgentId?: string;
  officeRole?: string;
  skillBundleRole?: string;
  characterFilename?: string;
};

function CountLocalCustomAgents(InAgents: Agent[]): number {
  return InAgents.filter((InAgent) => !isCoreDefaultAgent(InAgent)).length;
}

function NormalizeFactoryMetadataAgentId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function MapSkillBundleRoleToOfficeRole(bundleRole: string): AgentRole {
  const k = bundleRole.trim().toLowerCase();
  if (k === "pm") return "pm";
  if (k === "designer") return "designer";
  if (k === "developer") return "developer_back";
  return "developer";
}

let notifCounter = 0;

function clearArrivalTimers(): void {
  for (const timer of arrivalTimers) clearTimeout(timer);
  arrivalTimers = [];
}

function applyOfficeLayout(
  agents: Agent[],
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
  officeProfile?: ProjectOfficeProfile | null,
) {
  const deskPositions = buildDeskPositionMap(agents, officeZones, officeProfile);
  const meetingPositions = buildMeetingPositionMap(agents);

  return {
    deskPositions,
    meetingPositions,
    agents: agents.map((agent) => ({
      ...agent,
      position: deskPositions[agent.id] ?? agent.position ?? LOBBY_ENTRY,
    })),
  };
}

async function loadClockInPayload(projectId: string): Promise<{
  agents: Agent[];
  officeProfile: ProjectOfficeProfile;
  officeZones: RuntimeOfficeZone[];
  rooms: Room[];
  runtimeBundle: RuntimeBundleResponse | null;
}> {
  const globalOfficeState = await restoreGlobalOfficeState();
  try {
    const bundle = await runtimeApi.getProjectRuntimeBestEffort(projectId);
    if (!bundle) {
      throw new Error("runtime_unavailable");
    }
    const officeProfile = mergeOfficeProfileWithGlobalDefaults(
      buildProjectOfficeProfile(projectId, bundle.runtime),
      globalOfficeState,
    );
    const runtimeAgents = buildRuntimeAgents(bundle, officeProfile);
    const officeZones = buildOfficeZones(bundle.runtime, officeProfile);
    return {
      officeProfile,
      agents: ensureCoreDefaultAgents(
        runtimeAgents.length > 0 ? runtimeAgents : makeDefaultAgents(officeZones),
        officeZones,
      ),
      officeZones,
      rooms: buildRoomsFromZones(officeZones),
      runtimeBundle: bundle,
    };
  } catch {
    const officeProfile = mergeOfficeProfileWithGlobalDefaults(
      buildProjectOfficeProfile(projectId),
      globalOfficeState,
    );
    const officeZones = buildDefaultOfficeZones();
    return {
      officeProfile,
      agents: ensureCoreDefaultAgents(makeDefaultAgents(officeZones), officeZones),
      officeZones,
      rooms: buildRoomsFromZones(officeZones),
      runtimeBundle: null,
    };
  }
}

function syncOfficeStateFromRuntime(
  state: OfficeState,
  bundle: RuntimeBundleResponse,
): Partial<OfficeState> | null {
  if (!state.projectId || state.projectId !== bundle.runtime.project_id || state.gameState === "LOBBY") {
    return null;
  }

  const officeProfile = mergeOfficeProfileWithGlobalDefaults(
    buildProjectOfficeProfile(bundle.runtime.project_id, bundle.runtime),
    state.globalOfficeState,
  );
  const officeZones = buildOfficeZones(bundle.runtime, officeProfile);
  const runtimeAgents = buildRuntimeAgents(bundle, officeProfile);
  const mergedAgents = syncAgentsWithGlobalState(
    mergePersistedAgents(runtimeAgents, state.agents),
    state.globalOfficeState,
  );
  const layout = applyOfficeLayout(mergedAgents, officeZones, officeProfile);
  const previousById = new Map(state.agents.map((agent) => [agent.id, agent] as const));
  const nextAgents = layout.agents.map((agent) => {
    const previous = previousById.get(agent.id);
    if (!previous) return agent;
    const preserveMotion =
      previous.status === "walking" ||
      previous.status === "meeting" ||
      previous.path.length > 1;
    return {
      ...agent,
      status: preserveMotion ? previous.status : agent.status,
      position: preserveMotion ? previous.position : agent.position,
      path: preserveMotion ? previous.path : [],
      message: preserveMotion ? previous.message : agent.message,
      currentTask: previous.currentTask ?? agent.currentTask,
    };
  });

  return {
    officeProfile,
    officeZones,
    rooms: buildRoomsFromZones(officeZones),
    deskPositions: layout.deskPositions,
    meetingPositions:
      state.gameState === "MEETING" ? state.meetingPositions : layout.meetingPositions,
    agents: nextAgents,
    selectedAgentId:
      state.selectedAgentId && nextAgents.some((agent) => agent.id === state.selectedAgentId)
        ? state.selectedAgentId
        : null,
  };
}

function applyLocalOfficeProfile(
  state: OfficeState,
  officeProfile: ProjectOfficeProfile,
  agents: Agent[] = state.agents,
): Partial<OfficeState> {
  const projectId = state.projectId ?? officeProfile.project_id;
  const runtime = useWorkflowStore.getState().runtimeBundle?.runtime;
  const officeZones = buildOfficeZonesForProfile(projectId, officeProfile, runtime);
  const materializedOfficeProfile =
    officeProfile.furniture.length === 0 && officeProfile.metadata.furniture_initialized !== true
      ? {
          ...officeProfile,
          furniture: buildDefaultOfficeFurniture(officeZones),
          metadata: {
            ...officeProfile.metadata,
            furniture_initialized: true,
            updated_at: new Date().toISOString(),
          },
        }
      : officeProfile;
  const layout = applyOfficeLayout(agents, officeZones, materializedOfficeProfile);

  return {
    officeProfile: materializedOfficeProfile,
    officeZones,
    rooms: buildRoomsFromZones(officeZones),
    deskPositions: layout.deskPositions,
    meetingPositions:
      state.gameState === "MEETING" ? state.meetingPositions : layout.meetingPositions,
    agents: layout.agents,
    selectedAgentId:
      state.selectedAgentId && layout.agents.some((agent) => agent.id === state.selectedAgentId)
        ? state.selectedAgentId
        : null,
  };
}

export const useOfficeStore = create<OfficeState>((set, get) => ({
  projectId: null,
  wsConnected: false,
  gameState: "LOBBY",
  agents: [],
  selectedAgentId: null,
  notifications: [],
  showSettings: false,
  editMode: false,
  editFurnitureMode: "move",
  editFurniturePlacementType: null,
  furniture: [],
  rooms: DEFAULT_ROOMS,
  officeProfile: null,
  globalOfficeState: readGlobalOfficeStateLocal(),
  officeZones: buildDefaultOfficeZones(),
  deskPositions: {},
  meetingPositions: {},
  commandHistory: [],
  workLogs: {},
  taskHistory: {},
  fileChanges: {},
  agentErrors: {},
  agentMessages: [],
  pendingTransfers: [],
  collaborationVisits: [],
  arrivingAgentIds: [],
  localAgentSlots: 8,
  localCustomAgentCount: 0,

  setProjectId: (id) => {
    set({ projectId: id });
    void get().hydrateGlobalOfficeState();
  },

  hydrateGlobalOfficeState: async () => {
    const globalOfficeState = await restoreGlobalOfficeState();
    set((state) => {
      const nextAgents = syncAgentsWithGlobalState(state.agents, globalOfficeState);
      if (!state.officeProfile) {
        return {
          globalOfficeState,
          agents: nextAgents,
        };
      }
      const mergedOfficeProfile = mergeOfficeProfileWithGlobalDefaults(
        state.officeProfile,
        globalOfficeState,
      );
      return {
        globalOfficeState,
        ...applyLocalOfficeProfile(state, mergedOfficeProfile, nextAgents),
      };
    });
  },

  syncRuntimeBundle: (bundle) => {
    if (!bundle) return;
    set((state) => syncOfficeStateFromRuntime(state, bundle) ?? {});
  },

  saveOfficeProfile: async (officeProfile) => {
    const projectId = get().projectId;
    if (!projectId) return null;

    try {
      const bundle = await runtimeApi.updateProjectOfficeProfile(projectId, officeProfile);
      get().syncRuntimeBundle(bundle);
      useWorkflowStore.getState().syncRuntimeBundle(bundle);
      return bundle;
    } catch {
      return null;
    }
  },

  updateGlobalTheme: async (patch) => {
    const state = get();
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      settings: {
        ...state.globalOfficeState.settings,
        theme: {
          ...state.globalOfficeState.settings.theme,
          ...patch,
        },
        updated_at: new Date().toISOString(),
      },
    };
    set({ globalOfficeState: nextGlobalOfficeState });
    await persistGlobalOfficeState(nextGlobalOfficeState);
    if (state.officeProfile) {
      const mergedProfile = mergeOfficeProfileWithGlobalDefaults(
        state.officeProfile,
        nextGlobalOfficeState,
      );
      set((current) => applyLocalOfficeProfile(current, mergedProfile));
    }
  },

  promoteCurrentOfficeToGlobalDefault: async () => {
    const state = get();
    if (!state.officeProfile) return;
    const profile = deriveGlobalOfficeProfileFromProject(state.officeProfile);
    const officeProfiles = [
      ...state.globalOfficeState.office_profiles.filter(
        (candidate) => candidate.office_profile_id !== profile.office_profile_id,
      ),
      profile,
    ];
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      office_profiles: officeProfiles,
      settings: {
        ...state.globalOfficeState.settings,
        default_office_profile_id: profile.office_profile_id,
        office_profile_ids: officeProfiles.map((candidate) => candidate.office_profile_id),
        updated_at: new Date().toISOString(),
      },
    };
    set({ globalOfficeState: nextGlobalOfficeState });
    await persistGlobalOfficeState(nextGlobalOfficeState);
  },

  clearGlobalDefaultOffice: async () => {
    const state = get();
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      settings: {
        ...state.globalOfficeState.settings,
        default_office_profile_id: null,
        updated_at: new Date().toISOString(),
      },
    };
    set({ globalOfficeState: nextGlobalOfficeState });
    await persistGlobalOfficeState(nextGlobalOfficeState);
  },

  shareAgentGlobally: async (agentId) => {
    const state = get();
    const agent = state.agents.find((candidate) => candidate.id === agentId);
    if (!agent) return;
    const prompt = agent.promptKey ? await getAgentPromptByPromptKey(agent.promptKey) : "";
    const sharedAgent = {
      ...createSharedAgentProfile(agent, state.projectId),
      prompt,
    } satisfies SharedAgentProfileDocument;
    const sharedAgents = [
      ...state.globalOfficeState.shared_agents.filter(
        (candidate) => candidate.global_agent_id !== sharedAgent.global_agent_id,
      ),
      sharedAgent,
    ];
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      shared_agents: sharedAgents,
      settings: {
        ...state.globalOfficeState.settings,
        shared_agent_ids: sharedAgents.map((candidate) => candidate.global_agent_id),
        updated_at: new Date().toISOString(),
      },
    };
    set({
      globalOfficeState: nextGlobalOfficeState,
      agents: syncAgentsWithGlobalState(state.agents, nextGlobalOfficeState),
    });
    await persistGlobalOfficeState(nextGlobalOfficeState);
  },

  removeSharedAgent: async (globalAgentId) => {
    const state = get();
    const sharedAgents = state.globalOfficeState.shared_agents.filter(
      (candidate) => candidate.global_agent_id !== globalAgentId,
    );
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      shared_agents: sharedAgents,
      settings: {
        ...state.globalOfficeState.settings,
        shared_agent_ids: sharedAgents.map((candidate) => candidate.global_agent_id),
        updated_at: new Date().toISOString(),
      },
    };
    set({
      globalOfficeState: nextGlobalOfficeState,
      agents: syncAgentsWithGlobalState(state.agents, nextGlobalOfficeState),
    });
    await persistGlobalOfficeState(nextGlobalOfficeState);
  },

  importSharedAgentToOffice: async (globalAgentId) => {
    const sharedAgent = get().globalOfficeState.shared_agents.find(
      (candidate) => candidate.global_agent_id === globalAgentId,
    );
    if (!sharedAgent) return;
    const existingLinkedAgent = get().agents.find(
      (candidate) => candidate.sharedAgentRef?.global_agent_id === globalAgentId,
    );
    if (existingLinkedAgent) return;
    await get().addCustomAgentLocal({
      name: sharedAgent.name,
      roleLabel: sharedAgent.role_label,
      prompt:
        sharedAgent.prompt.trim() ||
        sharedAgent.summary?.trim() ||
        `${sharedAgent.name} shared workspace agent`,
      summary: sharedAgent.summary ?? undefined,
      capabilities: sharedAgent.capabilities,
      skillBundleRefs: sharedAgent.skill_bundle_refs,
      uiProfile: sharedAgent.ui_profile as AgentUiProfile,
      operatingProfile: sharedAgent.operating_profile as unknown as Agent["operatingProfile"],
      sharedAgentRef: {
        global_agent_id: sharedAgent.global_agent_id,
        source_project_id: sharedAgent.source_project_id ?? null,
        sync_mode: "linked",
        imported_at: new Date().toISOString(),
      },
    });
  },

  saveCurrentOfficeAsTemplate: async (name, description) => {
    const state = get();
    if (!state.officeProfile) return null;
    const nextTemplate = deriveOfficeTemplateFromProject(
      state.officeProfile,
      name,
      description,
    );
    const officeTemplates = upsertOfficeTemplate(
      state.globalOfficeState.office_templates,
      nextTemplate,
    );
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      office_templates: officeTemplates,
      settings: {
        ...state.globalOfficeState.settings,
        office_template_ids: officeTemplates.map((template) => template.template_id),
        updated_at: new Date().toISOString(),
      },
    };
    set({ globalOfficeState: nextGlobalOfficeState });
    await persistGlobalOfficeState(nextGlobalOfficeState);
    return nextTemplate;
  },

  applyOfficeTemplate: (templateId) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const template = state.globalOfficeState.office_templates.find(
        (candidate) => candidate.template_id === templateId,
      );
      if (!template) return {};
      const officeProfile = applyOfficeTemplateToProject(
        state.projectId ?? state.officeProfile.project_id,
        template,
        state.officeProfile,
      );
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  setDefaultOfficeTemplate: async (templateId) => {
    const state = get();
    const nextTemplateId =
      templateId && state.globalOfficeState.office_templates.some(
        (template) => template.template_id === templateId,
      )
        ? templateId
        : null;
    const nextGlobalOfficeState: GlobalOfficeStateDocument = {
      ...state.globalOfficeState,
      settings: {
        ...state.globalOfficeState.settings,
        default_template_id: nextTemplateId,
        updated_at: new Date().toISOString(),
      },
    };
    set((current) => ({
      globalOfficeState: nextGlobalOfficeState,
      agents: syncAgentsWithGlobalState(current.agents, nextGlobalOfficeState),
    }));
    await persistGlobalOfficeState(nextGlobalOfficeState);
  },

  updateOfficeName: (name) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const nextName = name.trim();
      if (!nextName) return {};
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        name: nextName,
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  updateOfficeTheme: (patch) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        theme: {
          ...state.officeProfile.theme,
          ...patch,
        },
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  updateOfficeZone: (zoneId, patch) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const zone = state.officeProfile.zones.find((candidate) => candidate.id === zoneId);
      if (!zone) return {};

      const normalizedPatch: OfficeZonePatch = {
        ...patch,
        row:
          typeof patch.row === "number" && Number.isFinite(patch.row)
            ? Math.max(0, Math.round(patch.row))
            : undefined,
        col:
          typeof patch.col === "number" && Number.isFinite(patch.col)
            ? Math.max(0, Math.round(patch.col))
            : undefined,
        row_span:
          typeof patch.row_span === "number" && Number.isFinite(patch.row_span)
            ? Math.max(1, Math.round(patch.row_span))
            : undefined,
        col_span:
          typeof patch.col_span === "number" && Number.isFinite(patch.col_span)
            ? Math.max(1, Math.round(patch.col_span))
            : undefined,
      };

      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        zones: state.officeProfile.zones.map((candidate) =>
          candidate.id === zoneId
            ? {
                ...candidate,
                ...normalizedPatch,
                label:
                  typeof normalizedPatch.label === "string" && normalizedPatch.label.trim().length > 0
                    ? normalizedPatch.label.trim()
                    : candidate.label,
                accent_color:
                  typeof normalizedPatch.accent_color === "string" &&
                  normalizedPatch.accent_color.trim().length > 0
                    ? normalizedPatch.accent_color.trim()
                    : candidate.accent_color,
                preset:
                  typeof normalizedPatch.preset === "string" && normalizedPatch.preset.trim().length > 0
                    ? normalizedPatch.preset.trim()
                    : candidate.preset,
              }
            : candidate,
        ),
      });

      return applyLocalOfficeProfile(state, officeProfile);
    }),

  addOfficeFurniture: (zoneId, type) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const zone = state.officeZones.find((candidate) => candidate.id === zoneId);
      if (!zone) return {};
      const nextFurniture = createOfficeFurnitureDocument(zone, type);
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        furniture: upsertOfficeFurniture(state.officeProfile.furniture, nextFurniture),
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  updateOfficeFurniture: (furnitureId, patch) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const currentFurniture = state.officeProfile.furniture.find(
        (candidate) => candidate.id === furnitureId,
      );
      if (!currentFurniture) return {};
      const nextZoneId = patch.zone_id ?? currentFurniture.zone_id;
      const nextZone = state.officeZones.find((candidate) => candidate.id === nextZoneId);
      if (!nextZone) return {};
      const anchor = clampFurnitureAnchorToZone(
        patch.anchor ?? currentFurniture.anchor,
        nextZone,
      );
      const nextFurniture = {
        ...currentFurniture,
        ...patch,
        zone_id: nextZoneId,
        anchor,
        rotation:
          typeof patch.rotation === "number" && Number.isFinite(patch.rotation)
            ? Math.round(patch.rotation)
            : currentFurniture.rotation ?? 0,
      };
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        furniture: upsertOfficeFurniture(state.officeProfile.furniture, nextFurniture),
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  removeOfficeFurniture: (furnitureId) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        furniture: removeOfficeFurniture(state.officeProfile.furniture, furnitureId),
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  placeOfficeFurnitureAtPoint: (type, point) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const zone = findOfficeZoneForPoint(point, state.officeZones);
      if (!zone) return {};
      const nextFurniture = {
        ...createOfficeFurnitureDocument(zone, type),
        anchor: clampFurnitureAnchorToZone(point, zone),
      };
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        furniture: upsertOfficeFurniture(state.officeProfile.furniture, nextFurniture),
      });
      return applyLocalOfficeProfile(state, officeProfile);
    }),

  setEditFurnitureMode: (mode) => set({ editFurnitureMode: mode }),

  setEditFurniturePlacementType: (type) => set({ editFurniturePlacementType: type }),

  setAgentSharedSyncMode: (agentId, syncMode) =>
    set((state) => {
      const target = state.agents.find((agent) => agent.id === agentId);
      if (!target?.sharedAgentRef) return {};

      const nextAgents = state.agents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              sharedAgentRef: {
                ...agent.sharedAgentRef!,
                sync_mode: syncMode,
              },
            }
          : agent,
      );

      return {
        agents:
          syncMode === "linked"
            ? syncAgentsWithGlobalState(nextAgents, state.globalOfficeState)
            : nextAgents,
      };
    }),

  assignAgentToZone: (agentId, zoneId) =>
    set((state) => {
      if (!state.officeProfile || !state.officeZones.some((zone) => zone.id === zoneId)) {
        return {};
      }
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        agent_assignments: upsertOfficeAssignment(state.officeProfile.agent_assignments, {
          agent_id: agentId,
          zone_id: zoneId,
          desk_id: null,
          spawn_point: null,
        }),
      });
      const nextAgents = state.agents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              path: [],
              status: settleAgentStatus(agent.status),
              uiProfile: {
                ...agent.uiProfile,
                home_zone: zoneId,
              },
            }
          : agent,
      );
      return applyLocalOfficeProfile(state, officeProfile, nextAgents);
    }),

  moveAgentToPoint: (agentId, point) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const officeZones = buildOfficeZonesForProfile(
        state.projectId ?? state.officeProfile.project_id,
        state.officeProfile,
        useWorkflowStore.getState().runtimeBundle?.runtime,
      );
      const zone = findOfficeZoneForPoint(point, officeZones);
      if (!zone) return {};

      const clamped = clampPointToZone(point, zone);
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        agent_assignments: upsertOfficeAssignment(state.officeProfile.agent_assignments, {
          agent_id: agentId,
          zone_id: zone.id,
          desk_id: null,
          spawn_point: clamped,
        }),
      });
      const nextAgents = state.agents.map((agent) =>
        agent.id === agentId
          ? {
              ...agent,
              position: clamped,
              path: [],
              status: settleAgentStatus(agent.status),
              uiProfile: {
                ...agent.uiProfile,
                home_zone: zone.id,
              },
            }
          : agent,
      );
      return applyLocalOfficeProfile(state, officeProfile, nextAgents);
    }),

  resetAgentPlacement: (agentId) =>
    set((state) => {
      if (!state.officeProfile) return {};
      const agent = state.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return {};

      const officeZones = buildOfficeZonesForProfile(
        state.projectId ?? state.officeProfile.project_id,
        state.officeProfile,
        useWorkflowStore.getState().runtimeBundle?.runtime,
      );
      const zoneId = resolveAgentZoneId(agent, state.officeProfile, officeZones);
      const officeProfile = markOfficeProfileCustomized(state.officeProfile, {
        agent_assignments: upsertOfficeAssignment(state.officeProfile.agent_assignments, {
          agent_id: agentId,
          zone_id: zoneId,
          desk_id: null,
          spawn_point: null,
        }),
      });
      const nextAgents = state.agents.map((candidate) =>
        candidate.id === agentId
          ? {
              ...candidate,
              path: [],
              status: settleAgentStatus(candidate.status),
              uiProfile: {
                ...candidate.uiProfile,
                home_zone: zoneId,
              },
            }
          : candidate,
      );
      return applyLocalOfficeProfile(state, officeProfile, nextAgents);
    }),

  addCustomAgentLocal: async (draft) => {
    const name = draft.name.trim() || draft.prompt.slice(0, 20).trim() || "Custom";
    const normalizedMeta = NormalizeFactoryMetadataAgentId(
      draft.metadataAgentId ?? draft.roleLabel,
    );
    const metadataId =
      normalizedMeta !== "" ? normalizedMeta : `custom_${Date.now()}`;
    const id = metadataId;
    const role = (draft.roleLabel.trim() || metadataId) as AgentRole;
    const prompt = draft.prompt.trim();
    const capabilities = draft.capabilities.length > 0 ? draft.capabilities : ["custom"];
    const skillBundleRefs = draft.skillBundleRefs.filter(Boolean);
    const profile = draft.uiProfile;
    const stateNow = get();
    const existingById = stateNow.agents.find((InAgent) => InAgent.id === id) ?? null;
    const used = stateNow.agents.length;
    const total = stateNow.localAgentSlots;
    const remaining = total - used;
    if (existingById == null && remaining <= 0) {
      console.error("[OfficeStore] No local slot available for custom agent", {
        metadataId: metadataId,
        roleLabel: draft.roleLabel,
        used,
        total,
      });
      return {
        added: false,
        agent: { id, name, role, prompt },
        slot: { used, total, remaining: 0 },
      };
    }
    let promptKey: string | undefined;
    if (isTauri()) {
      const summaryRaw = (draft.summary ?? "").trim();
      const summary =
        summaryRaw !== ""
          ? summaryRaw
          : capabilities.length > 0
            ? capabilities.slice(0, 6).join(", ")
            : name;
      const skillBundleRole =
        draft.skillBundleRole?.trim() ||
        skillBundleRefs[0]?.trim() ||
        "developer";
      const officeRole = (
        draft.officeRole?.trim() ||
        MapSkillBundleRoleToOfficeRole(skillBundleRole)
      ) as AgentRole;
      const characterFilename =
        draft.characterFilename?.trim() || `${metadataId}Data.json`;
      try {
        await ensureUserCharacterFileStub(characterFilename, metadataId, officeRole);
      } catch (InError) {
        console.error("[OfficeStore] Character stub creation failed", {
          metadataId,
          characterFilename,
          officeRole,
          error: InError instanceof Error ? InError.message : String(InError),
        });
        return {
          added: false,
          agent: { id, name, role, prompt },
          slot: { used, total, remaining },
        };
      }
      const saved = await saveFactoryAgentToResources({
        agentId: metadataId,
        displayName: name,
        summary,
        promptText: prompt,
        skillBundleRefs,
        officeRole,
        skillBundleRole,
        characterFilename,
      });
      if (!saved.ok) {
        console.error("[OfficeStore] save_factory_agent returned failure", {
          metadataId,
          officeRole,
          skillBundleRole,
          characterFilename,
        });
        return {
          added: false,
          agent: { id, name, role, prompt },
          slot: { used, total, remaining },
        };
      }
      promptKey = saved.promptKey;
      await refreshAgentsMetadataCache();
      console.info("[OfficeStore] Custom agent resources saved", {
        metadataId,
        promptKey,
        characterFilename,
      });
    }
    set((s) => {
      const customUiProfile: AgentUiProfile = {
        display_name: name,
        title: profile?.title || name,
        accent_color: profile?.accent_color || "#22C55E",
        icon: profile?.icon || "Sparkles",
        home_zone: profile?.home_zone || "lobby",
        team_affinity: profile?.team_affinity || "custom_team",
        authority_level: profile?.authority_level ?? 10,
        capability_tags:
          profile?.capability_tags && profile.capability_tags.length > 0
            ? profile.capability_tags
            : [...capabilities, ...skillBundleRefs],
        primary_widgets:
          profile?.primary_widgets && profile.primary_widgets.length > 0
            ? profile.primary_widgets
            : ["timeline"],
        secondary_widgets: profile?.secondary_widgets ?? [],
        focus_mode: profile?.focus_mode || "custom",
        meeting_behavior: profile?.meeting_behavior || "adaptive",
      };
      const operatingProfile =
        draft.operatingProfile ??
        buildAgentOperatingProfile({
          role,
          capabilities,
          skillBundleRefs,
          focusMode: customUiProfile.focus_mode,
        });
      const nextAgents = [
        ...s.agents.filter((InAgent) => InAgent.id !== id),
        {
          id,
          role,
          name,
          promptKey,
          meta: getAgentMeta(role, {
            name,
            title: name,
            color: customUiProfile.accent_color,
            icon: customUiProfile.icon,
          }),
          uiProfile: customUiProfile,
          operatingProfile,
          assignedTeam: customUiProfile.team_affinity ?? "custom_team",
          runtimeStatus: "idle",
          position: LOBBY_ENTRY,
          path: [],
          status: "idle" as AgentStatus,
          capabilities,
          skillBundleRefs,
          sharedAgentRef: draft.sharedAgentRef ?? null,
        } satisfies Agent,
      ];
      const layout = applyOfficeLayout(nextAgents, s.officeZones, s.officeProfile);
      return {
        localCustomAgentCount: CountLocalCustomAgents(layout.agents),
        agents: layout.agents,
        deskPositions: layout.deskPositions,
        meetingPositions: layout.meetingPositions,
      };
    });
    const nextUsed = get().agents.length;
    const nextTotal = get().localAgentSlots;
    return {
      added: true,
      agent: { id, name, role, prompt, promptKey },
      slot: { used: nextUsed, total: nextTotal, remaining: nextTotal - nextUsed },
    };
  },

  buildCompanyAgentsLocal: async (drafts) => {
    let created = 0;
    let skipped = 0;
    for (const draft of drafts) {
      const result = await get().addCustomAgentLocal(draft);
      if (result.added) {
        created += 1;
      } else {
        skipped += 1;
      }
    }
    return { created, skipped };
  },

  unlockSlotLocal: () => {
    set((s) => ({ localAgentSlots: s.localAgentSlots + 1 }));
    const state = get();
    return { agent_slots: state.localAgentSlots, custom_agent_count: state.localCustomAgentCount };
  },
  setWsConnected: (v) => {
    set({ wsConnected: v });
    useWorkflowStore.getState().setRealtimeConnected(v, get().projectId);
  },

  clockIn: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    clearArrivalTimers();
    await refreshAgentsMetadataCache();

    try {
      await backendClockIn(projectId);
    } catch {
    }

    const globalOfficeState = await restoreGlobalOfficeState();
    const payload = await loadClockInPayload(projectId);
    const snapshot = await restoreOfficeSnapshot(projectId);
    const officeProfile = snapshot?.officeProfile ?? payload.officeProfile;
    const officeZones = payload.runtimeBundle
      ? buildOfficeZones(payload.runtimeBundle.runtime, officeProfile)
      : buildDefaultOfficeZones();
    const mergedAgents = snapshot
      ? mergePersistedAgents(payload.agents, snapshot.agents)
      : payload.agents;
    const syncedAgents = syncAgentsWithGlobalState(mergedAgents, globalOfficeState);
    const sanitizedSnapshot = snapshot
      ? sanitizePersistedOfficeSnapshotForAgents(snapshot, syncedAgents)
      : null;
    const layout = applyOfficeLayout(syncedAgents, officeZones, officeProfile);
    const agents = layout.agents;
    const desiredStatusById = Object.fromEntries(
      agents.map((agent) => [agent.id, agent.status] as const),
    );

    const seededAgents = agents.map((agent) => ({
      ...agent,
      position: LOBBY_ENTRY,
      path: [],
      status: "idle" as AgentStatus,
    }));

    set({
      agents: seededAgents,
      rooms: buildRoomsFromZones(officeZones),
      globalOfficeState,
      officeProfile,
      officeZones,
      deskPositions: layout.deskPositions,
      meetingPositions: layout.meetingPositions,
      commandHistory: sanitizedSnapshot?.commandHistory ?? [],
      workLogs: sanitizedSnapshot?.workLogs ?? {},
      taskHistory: sanitizedSnapshot?.taskHistory ?? {},
      fileChanges: sanitizedSnapshot?.fileChanges ?? {},
      agentErrors: sanitizedSnapshot?.agentErrors ?? {},
      agentMessages: sanitizedSnapshot?.agentMessages ?? [],
      pendingTransfers: sanitizedSnapshot?.pendingTransfers ?? [],
      collaborationVisits: [],
      localAgentSlots: snapshot?.localAgentSlots ?? 8,
      localCustomAgentCount: CountLocalCustomAgents(syncedAgents),
      gameState: "OFFICE",
      arrivingAgentIds: agents.map((a) => a.id),
    });
    if (payload.runtimeBundle) {
      useWorkflowStore.getState().syncRuntimeBundle(payload.runtimeBundle);
      await useWorkflowStore.getState().refreshPlans(projectId);
    } else {
      useWorkflowStore.getState().reset();
    }
    useOfficeSceneStore.getState().setArrivingAgentIds(agents.map((a) => a.id));

    const arrivalOrder = orderAgentsForArrival(seededAgents);
    let maxDoneAt = 0;

    arrivalOrder.forEach((agent, idx) => {
      const startAt = ARRIVAL_START_DELAY_MS + idx * ARRIVAL_STAGGER_MS;
      const startTimer = setTimeout(() => {
        const current = get().agents.find((a) => a.id === agent.id);
        if (!current) return;

        const target = layout.deskPositions[agent.id] ?? current.position;
        const path = calculatePath(
          current.position,
          target,
          officeZones,
          effectiveOfficeRouting(officeProfile),
        );
        const walkMs = pathDuration(path);

        set((s) => ({
          agents: s.agents.map((a) =>
            a.id === agent.id
              ? {
                  ...a,
                  status: "walking",
                  path,
                  position: target,
                }
              : a,
          ),
        }));

        const arriveTimer = setTimeout(() => {
          set((s) => ({
            agents: s.agents.map((a) =>
              a.id === agent.id
                ? {
                    ...a,
                    path: [],
                    position: target,
                    status: desiredStatusById[agent.id] && desiredStatusById[agent.id] !== "walking"
                      ? desiredStatusById[agent.id]
                      : "idle",
                  }
                : a,
            ),
          }));
        }, walkMs + 120);

        arrivalTimers.push(arriveTimer);
      }, startAt);

      arrivalTimers.push(startTimer);

      const samplePath = calculatePath(
        LOBBY_ENTRY,
        layout.deskPositions[agent.id] ?? LOBBY_ENTRY,
        officeZones,
        effectiveOfficeRouting(officeProfile),
      );
      const doneAt = startAt + pathDuration(samplePath) + 180;
      if (doneAt > maxDoneAt) maxDoneAt = doneAt;
    });

    const clearBadgeTimer = setTimeout(() => {
      set({ arrivingAgentIds: [] });
      useOfficeSceneStore.getState().setArrivingAgentIds([]);
    }, maxDoneAt + 150);
    arrivalTimers.push(clearBadgeTimer);
  },

  clockOut: async () => {
    const projectId = get().projectId;
    if (meetingTransitionTimer) {
      clearTimeout(meetingTransitionTimer);
      meetingTransitionTimer = null;
    }
    clearArrivalTimers();
    if (officePersistTimer) {
      clearTimeout(officePersistTimer);
      officePersistTimer = null;
    }
    if (projectId) {
      try {
        await backendClockOut(projectId);
      } catch {
        // best effort; local teardown should still complete
      }
    }
    if (projectId) {
      await clearPersistedOfficeSnapshot(projectId);
    }
    useWorkflowStore.getState().reset();
    useAgentCommandStore.getState().reset();
    set({
      gameState: "LOBBY",
      agents: [],
      rooms: DEFAULT_ROOMS,
      officeProfile: null,
      officeZones: buildDefaultOfficeZones(),
      deskPositions: {},
      meetingPositions: {},
      commandHistory: [],
      workLogs: {},
      taskHistory: {},
      fileChanges: {},
      agentErrors: {},
      agentMessages: [],
      pendingTransfers: [],
      collaborationVisits: [],
      selectedAgentId: null,
      arrivingAgentIds: [],
      localAgentSlots: 8,
      localCustomAgentCount: 0,
    });
  },

  reconcileOfficeAgentsWithMetadata: () => {
    set((state) => {
      if (state.gameState !== "OFFICE") {
        return {};
      }
      const metadataAgents = listAgentsMetadataSync();
      const fresh = buildMetadataDefaultAgents(metadataAgents, state.officeZones);
      const prevById = new Map(state.agents.map((a) => [a.id, a]));
      const merged = fresh.map((agent) => {
        const prev = prevById.get(agent.id);
        if (!prev) {
          return agent;
        }
        return {
          ...agent,
          position: prev.position,
          path: prev.path,
          status: prev.status,
          message: prev.message,
          currentTask: prev.currentTask,
          runtimeStatus: prev.runtimeStatus,
          sharedAgentRef: prev.sharedAgentRef,
        };
      });
      const layout = applyOfficeLayout(merged, state.officeZones, state.officeProfile);
      return {
        agents: layout.agents,
        deskPositions: layout.deskPositions,
        meetingPositions: layout.meetingPositions,
        selectedAgentId:
          state.selectedAgentId && layout.agents.some((a) => a.id === state.selectedAgentId)
            ? state.selectedAgentId
            : null,
      };
    });
  },

  updateAgent: (id, updates) =>
    set((s) => ({ agents: s.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)) })),

  setAgentTask: (id, task) =>
    set((s) => {
      const taskTrim = String(task ?? "").trim();
      const hasTask = taskTrim !== "";
      return {
        agents: s.agents.map((a) =>
          a.id === id
            ? {
                ...a,
                currentTask: hasTask ? taskTrim : undefined,
                status: hasTask ? ("working" as AgentStatus) : ("idle" as AgentStatus),
              }
            : a,
        ),
      };
    }),

  setAgentTaskByRole: (role, task) =>
    set((s) => {
      const roleNorm = String(role ?? "").toLowerCase();
      const taskTrim = String(task ?? "").trim();
      const hasTask = taskTrim !== "";
      return {
        agents: s.agents.map((a) =>
          String(a.role ?? "").toLowerCase() === roleNorm
            ? {
                ...a,
                currentTask: hasTask ? taskTrim : undefined,
                status: hasTask ? ("working" as AgentStatus) : ("idle" as AgentStatus),
              }
            : a,
        ),
      };
    }),

  triggerAgentError: (id, message) =>
    set((s) => ({
      agents: s.agents.map((a) => (a.id === id ? { ...a, status: "error", message } : a)),
    })),

  selectAgent: (id) => set({ selectedAgentId: id }),

  startMeeting: () => {
    if (meetingTransitionTimer) clearTimeout(meetingTransitionTimer);
    const current = get().agents;
    const participantIds =
      useWorkflowStore.getState().planView?.meeting.participant_ids ?? current.map((agent) => agent.id);
    const participantSet = new Set(participantIds);
    const meetingPositions = buildMeetingPositionMap(current, participantIds);
    const movingAgents = current.map((a) => {
      if (!participantSet.has(a.id)) {
        return {
          ...a,
          path: [],
          status: a.status === "meeting" ? ("idle" as AgentStatus) : a.status,
        };
      }
      const target = meetingPositions[a.id] ?? a.position;
      return {
        ...a,
        status: "walking" as AgentStatus,
        path: calculatePath(
          a.position,
          target,
          get().officeZones,
          effectiveOfficeRouting(get().officeProfile),
        ),
      };
    });
    const duration = Math.max(0, ...movingAgents.map((a) => pathDuration(a.path)));

    set({ gameState: "MEETING", agents: movingAgents, meetingPositions });

    meetingTransitionTimer = setTimeout(() => {
      set((s) => ({
        agents: s.agents.map((a) => ({
          ...a,
          status: participantSet.has(a.id) ? "meeting" : a.status === "walking" ? "idle" : a.status,
          position: participantSet.has(a.id) ? (meetingPositions[a.id] ?? a.position) : a.position,
          path: [],
        })),
      }));
      meetingTransitionTimer = null;
    }, duration + 100);
  },

  endMeeting: () => {
    if (meetingTransitionTimer) clearTimeout(meetingTransitionTimer);
    const current = get().agents;
    const deskPositions =
      Object.keys(get().deskPositions).length > 0
        ? get().deskPositions
        : buildDeskPositionMap(current, get().officeZones);
    const movingAgents = current.map((a) => {
      const target = deskPositions[a.id] ?? a.position;
      return {
        ...a,
        status: "walking" as AgentStatus,
        path: calculatePath(
          a.position,
          target,
          get().officeZones,
          effectiveOfficeRouting(get().officeProfile),
        ),
      };
    });
    const duration = Math.max(0, ...movingAgents.map((a) => pathDuration(a.path)));

    set({ gameState: "OFFICE", agents: movingAgents, deskPositions });

    meetingTransitionTimer = setTimeout(() => {
      set((s) => ({
        agents: s.agents.map((a) => ({
          ...a,
          status: "idle",
          position: deskPositions[a.id] ?? a.position,
          path: [],
        })),
      }));
      meetingTransitionTimer = null;
    }, duration + 100);
  },

  handleWsEvent: (event) => {
    handleWsEventWithBridge(get, set, event);
  },

  clearWorkLog: (role) => set((s) => ({ workLogs: { ...s.workLogs, [role]: [] } })),
  dismissTransfer: (id) => set((s) => ({ pendingTransfers: s.pendingTransfers.filter((x) => x.id !== id) })),
  dismissCollaborationVisit: (id) =>
    set((s) => ({ collaborationVisits: s.collaborationVisits.filter((visit) => visit.id !== id) })),

  runTeamTask: async (team, instruction) => {
    const projectId = get().projectId;
    if (!projectId) return;
    await useWorkflowStore.getState().runTeamTask(projectId, team, instruction, get().addNotification);
  },

  runTeamSwarm: async () => {
    const projectId = get().projectId;
    if (!projectId) return;
    await useWorkflowStore.getState().runTeamSwarm(projectId, get().addNotification);
  },

  sendCommand: async (role, message, agentId) => {
    const projectId = get().projectId;
    if (!projectId) return;
    let promptKey: string | undefined;
    if (agentId != null && agentId !== "") {
      const ag = get().agents.find((a) => a.id === agentId);
      const k = ag?.promptKey?.trim();
      if (k != null && k !== "") {
        promptKey = k;
      }
    }
    await useAgentCommandStore.getState().sendCommand(
      projectId,
      role,
      agentId ?? null,
      message,
      get().addNotification,
      { promptKey: promptKey ?? null },
    );
    set({ commandHistory: useAgentCommandStore.getState().commandHistory });
  },

  addNotification: (n) => {
    const id = `notif-${++notifCounter}`;
    set((s) => ({ notifications: [...s.notifications, { ...n, id, timestamp: Date.now() }].slice(-40) }));
  },

  dismissNotification: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  setGameState: (s) => set({ gameState: s }),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),
  toggleEditMode: () =>
    set((s) => ({
      editMode: !s.editMode,
      editFurnitureMode: "move",
      editFurniturePlacementType: null,
    })),
}));

export type { OfficeState };

useAgentCommandStore.subscribe((cmd) => {
  useOfficeStore.setState({
    commandHistory: cmd.commandHistory,
  });
});

useOfficeStore.subscribe((state) => {
  if (!state.projectId || state.gameState === "LOBBY" || state.agents.length === 0) {
    return;
  }
  const snapshot = buildOfficeSnapshot(state);
  if (!snapshot) {
    return;
  }
  if (officePersistTimer) {
    clearTimeout(officePersistTimer);
  }
  officePersistTimer = setTimeout(() => {
    officePersistTimer = null;
    void persistOfficeSnapshot(snapshot.projectId, snapshot);
  }, OFFICE_STATE_PERSIST_DELAY_MS);
});
