import type { CliLogEntry } from "../stores/cliLogStore";
import type { AgentRole, TaskRecord } from "../types/agent";
import { isBuiltinAgentRole } from "../types/agent";

const CODE_FILE_PATTERN = /\b[\w./-]+\.(tsx|ts|jsx|js|css|scss|html|svg|json|md)\b/gi;

export function mergeById<T extends { id: string }>(
  existing: T[],
  incoming: T[],
  limit: number,
  sortBy?: (item: T) => number,
): T[] {
  const merged = new Map<string, T>();
  for (const item of existing) merged.set(item.id, item);
  for (const item of incoming) {
    const prev = merged.get(item.id);
    merged.set(item.id, prev ? { ...prev, ...item } : item);
  }
  const rows = [...merged.values()];
  if (sortBy) rows.sort((left, right) => sortBy(left) - sortBy(right));
  if (rows.length <= limit) return rows;
  return rows.slice(rows.length - limit);
}

export function parseTimestamp(raw: unknown): number {
  if (typeof raw === "number") {
    return raw > 1_000_000_000_000 ? raw : raw * 1000;
  }
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function normalizeRole(value: unknown, fallback: AgentRole): AgentRole {
  if (typeof value === "string" && isBuiltinAgentRole(value)) {
    return value as AgentRole;
  }
  return fallback;
}

function toCompact(value: unknown, max = 320): string {
  if (typeof value === "string") return value.slice(0, max);
  if (value && typeof value === "object") return JSON.stringify(value).slice(0, max);
  return String(value ?? "").slice(0, max);
}

export function extractFileRefs(text: string, max = 6): string[] {
  const found = text.match(CODE_FILE_PATTERN);
  if (!found) return [];
  return [...new Set(found.map((value) => value.trim()))].slice(0, max);
}

export function parseSequencerAgentLabelFromDescription(description: string): string | null {
  const match = (description ?? "").trim().match(/^([a-z0-9_]+)\s*->\s*/i);
  return match ? match[1] : null;
}

export function sequencerCommandBody(description: string): string {
  const raw = (description ?? "").trim();
  const arrow = raw.indexOf("->");
  if (arrow === -1) return raw;
  return raw.slice(arrow + 2).trim() || raw;
}

export function buildOutputLines(_InRole: AgentRole, task: TaskRecord): string[] {
  const result = task.result ?? {};
  const llmResponse = typeof result.llm_response === "string" ? result.llm_response.trim() : "";
  const lines: string[] = [];

  const files = result.files;
  if (Array.isArray(files) && files.length > 0) lines.push(`files: ${files.join(", ")}`);
  if (files && typeof files === "object") {
    const names = Object.keys(files as Record<string, unknown>);
    if (names.length > 0) lines.push(`files: ${names.join(", ")}`);
  }
  const newFiles = result.new_files;
  if (Array.isArray(newFiles) && newFiles.length > 0) lines.push(`new_files: ${newFiles.join(", ")}`);

  const preferredKeys = ["task_board", "daily_costs", "deployment_log", "content_plan", "decision"];
  for (const key of preferredKeys) {
    const value = (result as Record<string, unknown>)[key];
    if (value != null) {
      lines.push(`${key}: ${toCompact(value)}`);
    }
  }

  if (llmResponse) {
    const fileRefs = extractFileRefs(llmResponse).filter((name) => name.endsWith(".tsx") || name.endsWith(".css"));
    if (fileRefs.length > 0) {
      lines.push(`design_files: ${fileRefs.join(", ")}`);
    }
  }

  if (llmResponse) lines.push(llmResponse.slice(0, 500));
  if (task.resultSummary) lines.push(task.resultSummary);
  if (task.error) lines.push(task.error);

  const unique = [...new Set(lines.map((line) => line.trim()).filter(Boolean))];
  if (unique.length > 0) return unique;
  if (Object.keys(result).length > 0) return [JSON.stringify(result).slice(0, 500)];
  return [];
}

export function statusClass(status: TaskRecord["status"]): string {
  if (status === "completed") return "bg-emerald-500/20 text-emerald-300 border-emerald-400/40";
  if (status === "running") return "bg-cyan-500/20 text-cyan-300 border-cyan-400/40";
  if (status === "failed") return "bg-rose-500/20 text-rose-300 border-rose-400/40";
  return "bg-slate-500/20 text-slate-300 border-slate-400/40";
}

export function cliLogMatchesAgent(entry: CliLogEntry, role: AgentRole, agentId?: string | null): boolean {
  const normalizeOfficeRole = (inRole: string): AgentRole | null => {
    const key = (inRole ?? "").trim().toLowerCase();
    if (key === "frontend") return "developer_front";
    if (key === "backend") return "developer_back";
    if (isBuiltinAgentRole(key)) return key;
    return null;
  };
  const normalizedAgentId = (agentId ?? "").trim().toLowerCase();
  const roleKeyNorm = String(role ?? "").trim().toLowerCase();

  const roleMatchesOfficeKey = (officeRaw: string): boolean => {
    const key = (officeRaw ?? "").trim().toLowerCase();
    if (key === "") return false;
    const mapped = normalizeOfficeRole(officeRaw);
    if (mapped != null) return mapped === role;
    return key === roleKeyNorm;
  };

  if (normalizedAgentId !== "" && entry.officeAgentId != null) {
    return entry.officeAgentId.trim().toLowerCase() === normalizedAgentId;
  }
  if (entry.officeAgentRole != null) {
    if (roleMatchesOfficeKey(String(entry.officeAgentRole))) return true;
  }
  const label = entry.label ?? "";
  const agentCommandMatch = label.match(/AgentCommand\(\s*([^)]+)\)/i);
  if (agentCommandMatch?.[1]) {
    const raw = agentCommandMatch[1].split(",")[0]?.trim().toLowerCase() ?? "";
    if (normalizedAgentId !== "" && raw === normalizedAgentId) return true;
    if (roleMatchesOfficeKey(raw)) return true;
  }
  const idMatch = label.match(/PromptingSequencer\(\s*([^)]+)\)/i);
  if (idMatch) {
    const inner = (idMatch[1] ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
    if (normalizedAgentId !== "") {
      if (inner === "plan") return normalizedAgentId === "pm";
      return inner === normalizedAgentId;
    }
    if (inner === "plan") return role === "pm";
    return roleMatchesOfficeKey(inner);
  }
  const seqCmdMatch = label.match(/PromptingSequencerCommand\(\s*([^)]+)\)/i);
  if (seqCmdMatch?.[1]) {
    const inner = seqCmdMatch[1].split(",")[0]?.trim().toLowerCase() ?? "";
    if (normalizedAgentId !== "" && inner === normalizedAgentId) return true;
    return roleMatchesOfficeKey(inner);
  }
  if (label.startsWith("Agent: ")) {
    const tail = label.slice("Agent: ".length).trim();
    return roleMatchesOfficeKey(tail);
  }
  return false;
}
