import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runOfficeStoreRegressionTests(): Promise<void> {
  const source = readFileSync(path.join(currentDir, "officeStore.ts"), "utf8");

  assert(
    source.includes('import { clockIn as backendClockIn, clockOut as backendClockOut } from "../services/agentApi";'),
    "officeStore should import backend clock-in and clock-out helpers so lobby transitions are synchronized with the server runtime",
  );

  const clockInIndex = source.indexOf("clockIn: async () => {");
  const backendClockInIndex = source.indexOf("await backendClockIn(projectId);");
  const payloadIndex = source.indexOf("const payload = await loadClockInPayload(projectId);");
  assert(
    clockInIndex >= 0 && backendClockInIndex > clockInIndex && payloadIndex > backendClockInIndex,
    "officeStore clockIn should call the backend clock-in endpoint before loading runtime payloads and entering the office scene",
  );

  const clockOutIndex = source.indexOf("clockOut: async () => {");
  const backendClockOutIndex = source.indexOf("await backendClockOut(projectId);");
  const clearSnapshotIndex = source.indexOf("await clearPersistedOfficeSnapshot(projectId);");
  assert(
    clockOutIndex >= 0 && backendClockOutIndex > clockOutIndex && clearSnapshotIndex > backendClockOutIndex,
    "officeStore clockOut should best-effort notify the backend before clearing local office state",
  );

  assert(
    source.includes("const taskTrim = String(task ?? \"\").trim();") &&
      source.includes("currentTask: hasTask ? taskTrim : undefined") &&
      source.includes('status: hasTask ? ("working" as AgentStatus) : ("idle" as AgentStatus)'),
    "officeStore setAgentTask should clear agent status back to idle when a task is cleared by id",
  );

  assert(
    source.includes('const CORE_DEFAULT_AGENT_IDS = new Set<string>([') &&
      source.includes('"frontend"') &&
      source.includes('"backend"') &&
      source.includes('const CORE_DEFAULT_AGENT_ROLES: BuiltinAgentRole[] = [') &&
      source.includes('"developer_front"') &&
      source.includes('"developer_back"') &&
      source.includes("const LEGACY_BUNDLED_IMPLEMENTATION_AGENT_IDS = new Set<string>") &&
      source.includes("pruneLegacyBundledImplementationAgents(candidate.agents)") &&
      source.includes("sanitizePersistedOfficeSnapshotForAgents(snapshot, syncedAgents)") &&
      source.includes("function ensureCoreDefaultAgents("),
    "officeStore should keep shipped frontend/backend defaults while pruning only legacy implementation agents from persisted local state",
  );

  assert(
    source.includes("function CountLocalCustomAgents(InAgents: Agent[]): number") &&
      source.includes("return InAgents.filter((InAgent) => !isCoreDefaultAgent(InAgent)).length;"),
    "officeStore should count user-created implementation agents even when they use developer-style office roles",
  );

  console.log("officeStore backend clock sync regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runOfficeStoreRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
