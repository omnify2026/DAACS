import { create } from "zustand";

import type { AgentRole } from "../types/agent";

export interface CliLogEntry {
  id: string;
  stdin?: string;
  systemPrompt?: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  provider?: string;
  timestamp: number;
  label?: string;
  officeAgentRole?: AgentRole | null;
  officeAgentId?: string | null;
  skillRequestParsed?: string[] | null;
  skillInjectedRefs?: string[] | null;
  skillRequestDroppedRefs?: string[] | null;
}

const MAX_ENTRIES = 50;
const MAX_LOG_FIELD_CHARS = 4000;
const MAX_LOG_TRACE_ITEMS = 12;
const MAX_LOG_TRACE_ITEM_CHARS = 200;

function truncateLogField(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length <= MAX_LOG_FIELD_CHARS) {
    return value;
  }

  const marker = `\n...[truncated ${value.length - MAX_LOG_FIELD_CHARS} chars]...\n`;
  const headLength = Math.max(0, Math.floor((MAX_LOG_FIELD_CHARS - marker.length) * 0.65));
  const tailLength = Math.max(0, MAX_LOG_FIELD_CHARS - marker.length - headLength);
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

function truncateTraceValues(values: string[] | null | undefined): string[] | null | undefined {
  if (values == null) {
    return values;
  }

  return values.slice(0, MAX_LOG_TRACE_ITEMS).map((value) => {
    if (value.length <= MAX_LOG_TRACE_ITEM_CHARS) {
      return value;
    }
    return `${value.slice(0, MAX_LOG_TRACE_ITEM_CHARS)}...[truncated]`;
  });
}

function sanitizeEntry(inEntry: Omit<CliLogEntry, "id" | "timestamp">): Omit<CliLogEntry, "id" | "timestamp"> {
  return {
    ...inEntry,
    stdin: truncateLogField(inEntry.stdin),
    systemPrompt: truncateLogField(inEntry.systemPrompt),
    stdout: truncateLogField(inEntry.stdout) ?? "",
    stderr: truncateLogField(inEntry.stderr) ?? "",
    skillRequestParsed: truncateTraceValues(inEntry.skillRequestParsed),
    skillInjectedRefs: truncateTraceValues(inEntry.skillInjectedRefs),
    skillRequestDroppedRefs: truncateTraceValues(inEntry.skillRequestDroppedRefs),
  };
}

interface CliLogState {
  entries: CliLogEntry[];
  panelOpen: boolean;
  addEntry: (inEntry: Omit<CliLogEntry, "id" | "timestamp">) => void;
  clear: () => void;
  setPanelOpen: (inOpen: boolean) => void;
}

export const useCliLogStore = create<CliLogState>((set) => ({
  entries: [],
  panelOpen: false,

  addEntry: (inEntry) =>
    set((s) => ({
      entries: [
        {
          ...sanitizeEntry(inEntry),
          id: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          timestamp: Date.now(),
        },
        ...s.entries,
      ].slice(0, MAX_ENTRIES),
    })),

  clear: () => set({ entries: [] }),

  setPanelOpen: (inOpen) => set({ panelOpen: inOpen }),
}));
