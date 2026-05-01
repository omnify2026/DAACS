/* eslint-disable react-hooks/set-state-in-effect */
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n";
import { isTauri } from "../../services/tauriCli";
import { useCliLogStore } from "../../stores/cliLogStore";
import { useOfficeStore } from "../../stores/officeStore";
import type { AgentRole, Command, WorkLogEntry } from "../../types/agent";
import { getAgentMeta } from "../../types/agent";
import { GoalMeetingPanel } from "./GoalMeetingPanel";
import { SharedBoardPanel } from "./SharedBoardPanel";

export type AgentWorkspaceTab = "task" | "activity" | "log";

type AgentWorkspaceProps = {
  open: boolean;
  onClose: () => void;
  onOpenFactory?: () => void;
  initialTab?: AgentWorkspaceTab;
};

type UnifiedLogItem = {
  id: string;
  ts: number;
  kind: "command" | "cli" | "work";
  role: AgentRole | null;
  headline: string;
  detail: string;
};

const statusTone: Record<string, string> = {
  idle: "text-slate-300 bg-slate-500/15",
  working: "text-emerald-300 bg-emerald-500/15",
  walking: "text-amber-300 bg-amber-500/15",
  meeting: "text-violet-300 bg-violet-500/15",
  error: "text-rose-300 bg-rose-500/15",
  celebrating: "text-cyan-300 bg-cyan-500/15",
};

function FormatTs(InTs: number, InLocale: string): string {
  try {
    return new Date(InTs).toLocaleString(InLocale === "ko" ? "ko-KR" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(InTs);
  }
}

function Truncate(InText: string, InMax: number): string {
  const s = (InText ?? "").trim();
  if (s.length <= InMax) return s;
  return `${s.slice(0, InMax)}…`;
}

function BuildUnifiedLogs(
  commandHistory: Command[],
  cliEntries: ReturnType<typeof useCliLogStore.getState>["entries"],
  workLogs: ReturnType<typeof useOfficeStore.getState>["workLogs"],
): UnifiedLogItem[] {
  const out: UnifiedLogItem[] = [];

  for (const c of commandHistory) {
    out.push({
      id: `cmd-${c.id}`,
      ts: c.timestamp,
      kind: "command",
      role: c.agentRole,
      headline: `[Command] ${getAgentMeta(c.agentRole).name} · ${c.status}`,
      detail: `${c.message}${c.response ? `\n→ ${Truncate(c.response, 400)}` : ""}`,
    });
  }

  for (const e of cliEntries) {
    out.push({
      id: e.id,
      ts: e.timestamp,
      kind: "cli",
      role: e.officeAgentRole ?? null,
      headline: `[CLI] ${e.label ?? "run"} · ${e.provider ?? "?"} · exit ${e.exit_code}`,
      detail: [
        e.stdin ? `in: ${Truncate(e.stdin, 500)}` : "",
        e.stdout ? `out: ${Truncate(e.stdout, 800)}` : "",
        e.stderr ? `err: ${Truncate(e.stderr, 500)}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
  }

  for (const role of Object.keys(workLogs) as AgentRole[]) {
    const list = workLogs[role] ?? [];
    for (const w of list) {
      out.push({
        id: `work-${role}-${w.id}`,
        ts: w.timestamp,
        kind: "work",
        role,
        headline: `[${getAgentMeta(role).name}] ${w.type}`,
        detail: Truncate(w.content ?? "", 900),
      });
    }
  }

  out.sort((a, b) => b.ts - a.ts);
  return out;
}

function AgentDirectAssignBlock({
  onOpenFactory,
}: {
  onOpenFactory?: () => void;
}) {
  const { t } = useI18n();
  const { agents, projectId, sendCommand, selectAgent, addNotification } = useOfficeStore();
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (agents.length === 0) {
      setSelectedAgentId(null);
      return;
    }
    setSelectedAgentId((prev) => {
      if (prev && agents.some((a) => a.id === prev)) return prev;
      return agents[0]?.id ?? null;
    });
  }, [agents]);

  const canAssignWeb = projectId != null || isTauri();
  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const assignDisabled =
    sending || !instruction.trim() || !selectedAgent || agents.length === 0 || !canAssignWeb;

  const handleAssign = async () => {
    if (assignDisabled || !selectedAgent) return;
    setSending(true);
    const trimmed = instruction.trim();
    const lenBefore = useOfficeStore.getState().commandHistory.length;
    await sendCommand(selectedAgent.role, trimmed, selectedAgent.id);
    const hist = useOfficeStore.getState().commandHistory;
    const newCmd = hist[lenBefore];
    if (newCmd?.status === "completed") {
      selectAgent(selectedAgent.id);
      setInstruction("");
      addNotification({ type: "success", message: t("agentCommand.sent") });
    }
    setSending(false);
  };

  return (
    <div
      className="rounded-xl border border-[#2A2A4A] bg-[#111827]/88 backdrop-blur-md p-4 space-y-4"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div>
        <h3 className="text-sm font-semibold text-cyan-300">{t("agentCommand.title")}</h3>
        <p className="mt-1 text-xs text-gray-400">{t("agentCommand.subtitle")}</p>
      </div>
      {!canAssignWeb && (
        <div className="text-sm text-amber-300/95 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
          {t("agentCommand.needProject")}
        </div>
      )}
      {agents.length === 0 ? (
        <div className="text-sm text-gray-400">{t("agentCommand.noAgents")}</div>
      ) : (
        <div className="space-y-2">
          <label htmlFor="agent-ws-command-target" className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
            {t("agentCommand.target")}
          </label>
          <select
            id="agent-ws-command-target"
            value={selectedAgentId ?? ""}
            onChange={(e) => setSelectedAgentId(e.target.value || null)}
            className="w-full rounded-lg bg-[#0b1220] border border-[#2A2A4A] px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.meta?.name ?? a.name ?? getAgentMeta(a.role).name}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-2">
        <label htmlFor="agent-ws-instruction" className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
          {t("agentCommand.instruction")}
        </label>
        <textarea
          id="agent-ws-instruction"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={6}
          className="w-full min-h-[120px] rounded-lg bg-[#0b1220] border border-[#2A2A4A] p-3 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
          placeholder={t("agentCommand.placeholder")}
          disabled={agents.length === 0}
        />
      </div>
      {onOpenFactory && (
        <button
          type="button"
          onClick={onOpenFactory}
          className="text-xs px-3 py-2 rounded-lg border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/15 transition-colors"
        >
          {t("hud.addAgent")}
        </button>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => void handleAssign()}
          disabled={assignDisabled}
          className="px-5 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-45 disabled:pointer-events-none text-sm font-medium"
        >
          {sending ? t("agentCommand.assigning") : t("agentCommand.assign")}
        </button>
      </div>
    </div>
  );
}

function AgentActivityTab() {
  const { t, locale } = useI18n();
  const agents = useOfficeStore((s) => s.agents);
  const workLogs = useOfficeStore((s) => s.workLogs);

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-5 w-full max-w-[1600px] mx-auto"
      onPointerDown={(e) => e.stopPropagation()}
    >
      {agents.length === 0 ? (
        <p className="text-sm text-gray-400 sm:col-span-2 lg:col-span-3 xl:col-span-4">{t("agentWorkspace.activity.empty")}</p>
      ) : (
        agents.map((agent) => {
          const meta = getAgentMeta(agent.role);
          const recent = (workLogs[agent.role] ?? []).slice(-8).reverse() as WorkLogEntry[];
          const tone = statusTone[agent.status] ?? statusTone.idle;
          return (
            <div
              key={agent.id}
              className="min-w-0 rounded-xl border border-[#2A2A4A] bg-[#111827]/80 backdrop-blur-sm p-4 space-y-3 flex flex-col h-full"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">{meta?.name ?? agent.role}</div>
                  <div className="text-[11px] text-gray-500">{meta?.title ?? ""}</div>
                </div>
                <span className={`text-[10px] px-2 py-1 rounded-full font-medium ${tone}`}>{agent.status}</span>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">{t("agentWorkspace.activity.currentWork")}</div>
                <p className="text-sm text-gray-200 whitespace-pre-wrap">{agent.currentTask?.trim() || t("focus.noTask")}</p>
                {agent.message?.trim() && (
                  <p className="text-xs text-gray-400 mt-2 border-t border-white/5 pt-2">{agent.message}</p>
                )}
              </div>
              {recent.length > 0 && (
                <div className="mt-auto flex flex-col flex-1 min-h-0 pt-1">
                  <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-2 shrink-0">{t("agentWorkspace.activity.recentOps")}</div>
                  <ul className="space-y-2 max-h-40 sm:max-h-48 overflow-y-auto text-xs min-h-0">
                    {recent.map((entry) => (
                      <li key={entry.id} className="border border-[#1f2937] rounded-md px-2 py-1.5 bg-[#020617]/50">
                        <div className="flex justify-between gap-2 text-[10px] text-gray-500">
                          <span>{entry.type}</span>
                          <span>{FormatTs(entry.timestamp, locale)}</span>
                        </div>
                        <div className="text-gray-300 mt-0.5 whitespace-pre-wrap break-words">{Truncate(entry.content, 320)}</div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

function AgentLogTab() {
  const { t, locale } = useI18n();
  const commandHistory = useOfficeStore((s) => s.commandHistory);
  const workLogs = useOfficeStore((s) => s.workLogs);
  const cliEntries = useCliLogStore((s) => s.entries);
  const clearCli = useCliLogStore((s) => s.clear);

  const merged = useMemo(
    () => BuildUnifiedLogs(commandHistory, cliEntries, workLogs),
    [commandHistory, cliEntries, workLogs],
  );

  return (
    <div className="max-w-5xl mx-auto space-y-3" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-400">{t("agentWorkspace.log.hint")}</p>
        {cliEntries.length > 0 && (
          <button
            type="button"
            onClick={() => clearCli()}
            className="text-[11px] px-2 py-1 rounded border border-amber-500/40 text-amber-200 hover:bg-amber-500/10"
          >
            {t("agentWorkspace.log.clearCli")}
          </button>
        )}
      </div>
      {merged.length === 0 ? (
        <p className="text-sm text-gray-400 py-8 text-center">{t("agentWorkspace.log.empty")}</p>
      ) : (
        <ul className="space-y-2 max-h-[calc(100vh-14rem)] overflow-y-auto pr-1">
          {merged.map((item) => (
            <li
              key={item.id}
              className="rounded-lg border border-[#2A2A4A] bg-[#0b1220]/90 px-3 py-2.5 text-xs text-gray-200"
            >
              <div className="flex flex-wrap justify-between gap-2 text-[10px] text-gray-500">
                <span className="font-medium text-gray-300">{item.headline}</span>
                <span>{FormatTs(item.ts, locale)}</span>
              </div>
              {item.detail ? (
                <pre className="mt-2 text-[11px] text-gray-400 whitespace-pre-wrap break-words font-mono">{item.detail}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AgentWorkspace({ open, onClose, onOpenFactory, initialTab }: AgentWorkspaceProps) {
  const { t } = useI18n();
  const [tab, setTab] = useState<AgentWorkspaceTab>("task");

  useEffect(() => {
    if (open) setTab(initialTab ?? "task");
  }, [open, initialTab]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[72] flex flex-col p-2 sm:p-3 pointer-events-auto"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div
            className="absolute inset-0 bg-[#050810]/88 backdrop-blur-[2px] pointer-events-none"
            aria-hidden
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-workspace-title"
            className="relative flex flex-1 min-h-0 flex-col rounded-2xl border border-[#2A2A4A] bg-[#0a0f18]/97 shadow-[0_0_60px_rgba(0,0,0,0.45)] backdrop-blur-md overflow-hidden"
            initial={{ y: 12, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 12, opacity: 0 }}
            transition={{ type: "spring", damping: 28, stiffness: 320 }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <header className="shrink-0 flex items-center justify-between gap-3 px-3 py-2 sm:px-4 sm:py-3 border-b border-[#2A2A4A]/90 bg-[#0c1220]/95">
              <div>
                <h1 id="agent-workspace-title" className="text-base sm:text-lg font-semibold text-cyan-300">
                  {t("agentWorkspace.title")}
                </h1>
                <p className="text-[11px] sm:text-xs text-gray-500 mt-0.5">{t("agentWorkspace.subtitle")}</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="p-2 rounded-xl hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0"
                aria-label={t("agentWorkspace.close")}
              >
                <X className="w-5 h-5" />
              </button>
            </header>
            <nav className="shrink-0 flex gap-1 px-3 sm:px-4 pt-1.5 border-b border-[#2A2A4A]/60 bg-[#0a0f18]/80">
              {(
                [
                  ["task", t("agentWorkspace.tab.task")] as const,
                  ["activity", t("agentWorkspace.tab.activity")] as const,
                  ["log", t("agentWorkspace.tab.log")] as const,
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`px-4 py-2.5 text-xs sm:text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
                    tab === id
                      ? "text-cyan-300 border-cyan-500 bg-white/[0.04]"
                      : "text-gray-400 border-transparent hover:text-white hover:bg-white/[0.02]"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-3 sm:px-4 sm:py-4">
              {tab === "task" && (
                <div className="space-y-6 max-w-4xl mx-auto">
                  <div onPointerDown={(e) => e.stopPropagation()} className="space-y-6">
                    <GoalMeetingPanel />
                    <SharedBoardPanel />
                  </div>
                  <AgentDirectAssignBlock onOpenFactory={onOpenFactory} />
                </div>
              )}
              {tab === "activity" && <AgentActivityTab />}
              {tab === "log" && <AgentLogTab />}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
