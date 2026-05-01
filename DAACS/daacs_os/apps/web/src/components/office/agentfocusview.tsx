import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";

import * as agentApi from "../../services/agentApi";
import {
  isTauri,
  loadPromptingSequencerTodo,
  markPromptingSequencerItemDone,
  getPromptingSequencerChannelIdByOfficeRole,
  type SequencerItem,
  type SequencerTodoList,
} from "../../services/tauriCli";
import { useI18n } from "../../i18n";
import {
  cliLogMatchesAgent,
  mergeById,
  normalizeRole,
  parseSequencerAgentLabelFromDescription,
  parseTimestamp,
  sequencerCommandBody,
  statusClass,
} from "../../lib/agentFocusUtils";
import { buildAgentDataKeys, messageMatchesAgent } from "../../lib/officeDataScope";
import { useCliLogStore, type CliLogEntry } from "../../stores/cliLogStore";
import { useOfficeStore } from "../../stores/officeStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import type {
  Agent,
  AgentErrorRecord,
  AgentMessageRecord,
  FileChangeRecord,
  WorkLogEntry,
} from "../../types/agent";
import { AgentWorkspaceTab } from "./AgentWorkspaceTab";

interface Props {
  agent: Agent | null;
  onClose: () => void;
}

type FocusTab = "workspace" | "activity" | "logs" | "commands";

const TAB_ORDER: FocusTab[] = ["workspace", "activity", "logs", "commands"];

function readScopedRows<T>(map: Record<string, T[]>, keys: string[]): T[] {
  for (const key of keys) {
    const rows = map[key];
    if (rows && rows.length > 0) return rows;
  }
  return keys.length > 0 ? map[keys[0]] ?? [] : [];
}

function writeScopedRows<T>(map: Record<string, T[]>, keys: string[], rows: T[]): Record<string, T[]> {
  const next = { ...map };
  for (const key of keys) next[key] = rows;
  return next;
}


export function AgentFocusView({ agent, onClose }: Props) {
  const { t } = useI18n();
  const {
    projectId,
    workLogs,
    commandHistory,
    sendCommand,
    addNotification,
    taskHistory,
    fileChanges,
    agentErrors,
    agentMessages,
  } = useOfficeStore();

  const cliLogEntries = useCliLogStore((s) => s.entries);
  const planView = useWorkflowStore((s) => s.planView);
  const executionIntents = useWorkflowStore((s) => s.executionIntents);
  const stepHandoffs = useWorkflowStore((s) => s.stepHandoffs);
  const createExecutionIntent = useWorkflowStore((s) => s.createExecutionIntent);
  const scopeKeys = useMemo(() => (agent ? buildAgentDataKeys(agent) : []), [agent]);


  const [activeTab, setActiveTab] = useState<FocusTab>("workspace");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sequencerTodo, setSequencerTodo] = useState<SequencerTodoList | null>(null);
  const [sequencerLoading, setSequencerLoading] = useState(false);
  const [sequencerError, setSequencerError] = useState<string | null>(null);

  useEffect(() => {
    if (!agent || !projectId) return;
    let disposed = false;

    const loadHistory = async () => {
      setLoadingHistory(true);
      try {
        const [tasks, events] = await Promise.all([
          agentApi.getAgentTaskHistory(projectId, agent.role, agent.id, 50),
          agentApi.getAgentEvents(projectId, agent.role, agent.id, undefined, 80),
        ]);

        if (disposed) return;

        const loadedFileChanges: FileChangeRecord[] = [];
        const loadedErrors: AgentErrorRecord[] = [];
        const loadedMessages: AgentMessageRecord[] = [];

        for (const row of events) {
          const id = String(row.id ?? `evt-${Math.random().toString(36).slice(2, 8)}`);
          const createdAt = parseTimestamp(row.created_at);
          const eventType = String(row.event_type ?? "");
          const data =
            row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};

          if (eventType === "file_change") {
            const filePath = String(data.file_path ?? "").trim();
            if (!filePath) continue;
            const actionRaw = String(data.action ?? "read");
            const action: FileChangeRecord["action"] =
              actionRaw === "create" || actionRaw === "edit" || actionRaw === "read"
                ? actionRaw
                : "read";
            loadedFileChanges.push({
              id,
              agentRole: agent.role,
              filePath,
              action,
              toolName: String(data.tool ?? "tool"),
              timestamp: createdAt,
            });
            continue;
          }

          if (eventType === "error") {
            loadedErrors.push({
              id,
              agentRole: agent.role,
              error: String(data.error ?? "error"),
              timestamp: createdAt,
            });
            continue;
          }

          if (eventType === "message_sent" || eventType === "message_received") {
            loadedMessages.push({
              id,
              from: normalizeRole(data.from, agent.role),
              to: normalizeRole(data.to, agent.role),
              fromAgentId:
                normalizeRole(data.from, agent.role) === agent.role ? agent.id : undefined,
              toAgentId:
                normalizeRole(data.to, agent.role) === agent.role ? agent.id : undefined,
              content: String(data.content ?? ""),
              direction: eventType === "message_sent" ? "sent" : "received",
              timestamp: createdAt,
            });
          }
        }

        useOfficeStore.setState((s) => ({
          taskHistory: writeScopedRows(
            s.taskHistory,
            buildAgentDataKeys(agent),
            mergeById(readScopedRows(s.taskHistory, buildAgentDataKeys(agent)), tasks, 50, (x) => x.queuedAt),
          ),
          fileChanges: writeScopedRows(
            s.fileChanges,
            buildAgentDataKeys(agent),
            mergeById(
              readScopedRows(s.fileChanges, buildAgentDataKeys(agent)),
              loadedFileChanges,
              100,
              (x) => x.timestamp,
            ),
          ),
          agentErrors: writeScopedRows(
            s.agentErrors,
            buildAgentDataKeys(agent),
            mergeById(
              readScopedRows(s.agentErrors, buildAgentDataKeys(agent)),
              loadedErrors,
              30,
              (x) => x.timestamp,
            ),
          ),
          agentMessages: mergeById(s.agentMessages, loadedMessages, 100, (x) => x.timestamp),
        }));
      } catch {
        // Keep real-time only data when history loading fails.
      } finally {
        if (!disposed) setLoadingHistory(false);
      }
    };

    void loadHistory();
    return () => {
      disposed = true;
    };
  }, [agent, projectId]);

  const sequencerProjectName = projectId ?? "local";

  useEffect(() => {
    if (!agent || !isTauri()) {
      setSequencerTodo(null);
      setSequencerError(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setSequencerLoading(true);
      setSequencerError(null);
      try {
        const channelId = await getPromptingSequencerChannelIdByOfficeRole(agent.role);
        if (channelId == null || channelId.trim() === "") {
          if (!cancelled) setSequencerTodo(null);
          return;
        }
        const data = await loadPromptingSequencerTodo(sequencerProjectName, channelId);
        const empty: SequencerTodoList = {
          main_task_name: "",
          project_name: sequencerProjectName,
          channel_id: channelId,
          items: [],
        };
        if (!cancelled) setSequencerTodo(data ?? empty);
      } catch (e) {
        if (!cancelled) setSequencerError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setSequencerLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [sequencerProjectName, agent]);

  const roleLogs = useMemo(() => {
    if (!agent) return [];
    return readScopedRows(workLogs, scopeKeys).slice(-30).reverse();
  }, [workLogs, agent, scopeKeys]);

  const mergedFocusLogs = useMemo(() => {
    if (!agent) return [];
    type Merged = { kind: "cli"; at: number; cli: CliLogEntry } | { kind: "stream"; at: number; stream: WorkLogEntry };
    const out: Merged[] = [];
    if (isTauri()) {
      for (const e of cliLogEntries) {
        if (cliLogMatchesAgent(e, agent.role, agent.id)) {
          out.push({ kind: "cli", at: e.timestamp, cli: e });
        }
      }
    }
    for (const log of roleLogs) {
      out.push({ kind: "stream", at: log.timestamp, stream: log });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, 100);
  }, [agent, cliLogEntries, roleLogs]);

  const roleCommands = useMemo(() => {
    if (!agent) return [];
    return commandHistory
      .filter((x) => (x.agentId ? x.agentId === agent.id : x.agentRole === agent.role))
      .slice(-20)
      .reverse();
  }, [commandHistory, agent]);

  const roleTasks = useMemo(() => {
    if (!agent) return [];
    const rows = readScopedRows(taskHistory, scopeKeys);
    return [...rows].sort(
      (a, b) =>
        (b.completedAt ?? b.startedAt ?? b.queuedAt) - (a.completedAt ?? a.startedAt ?? a.queuedAt),
    );
  }, [taskHistory, agent, scopeKeys]);

  const roleFileChanges = useMemo(() => {
    if (!agent) return [];
    return [...readScopedRows(fileChanges, scopeKeys)].sort((a, b) => b.timestamp - a.timestamp);
  }, [fileChanges, agent, scopeKeys]);

  const roleErrors = useMemo(() => {
    if (!agent) return [];
    return [...readScopedRows(agentErrors, scopeKeys)].sort((a, b) => b.timestamp - a.timestamp);
  }, [agentErrors, agent, scopeKeys]);

  const roleMessages = useMemo(() => {
    if (!agent) return [];
    return agentMessages
      .filter((m) => messageMatchesAgent(m, agent))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100);
  }, [agentMessages, agent]);

  const workspaceHandoffs = useMemo(() => {
    if (!agent) return [];
    const instanceRef = agent.instanceId ?? agent.id;
    return Object.values(stepHandoffs)
      .flat()
      .filter(
        (handoff) =>
          handoff.from_agent_id === instanceRef ||
          handoff.to_agent_id === instanceRef ||
          handoff.from_agent_id === agent.role ||
          handoff.to_agent_id === agent.role,
      )
      .slice(0, 24);
  }, [agent, stepHandoffs]);

  const toolLogs = useMemo(
    () => roleLogs.filter((log) => log.type === "tool_call" || log.type === "tool_result"),
    [roleLogs],
  );

  const sequencerItemsOrdered = useMemo(() => {
    if (!sequencerTodo?.items?.length) return [];
    const items = [...sequencerTodo.items];
    const active = items.filter((x) => x.status !== "done");
    const done = items.filter((x) => x.status === "done");
    active.sort((a, b) => a.number - b.number || (a.title ?? "").localeCompare(b.title ?? ""));
    done.sort((a, b) => a.number - b.number || (a.title ?? "").localeCompare(b.title ?? ""));
    return [...active, ...done];
  }, [sequencerTodo]);

  const sequencerItemsVisible = useMemo(() => {
    if (!sequencerItemsOrdered.length) return [];
    return sequencerItemsOrdered.filter((item) => {
      const isCurrent =
        item.status === "in_progress" ||
        (item.status === "pending" &&
          !sequencerItemsOrdered.some(
            (other) =>
              other.number < item.number &&
              (other.status === "pending" || other.status === "in_progress"),
          ));
      return item.status === "done" || isCurrent;
    });
  }, [sequencerItemsOrdered]);

  const runCommand = async (text: string) => {
    if (!agent || !text.trim()) return;
    try {
      await sendCommand(agent.role, text.trim(), agent.id);
      addNotification({
        type: "success",
        message: t("focus.commandSent", { name: agent.name }),
        agentRole: agent.role,
      });
    } catch (err) {
      addNotification({
        type: "error",
        message: err instanceof Error ? err.message : t("focus.commandFailed"),
        agentRole: agent.role,
      });
    }
  };

  const handleSequencerMarkDone = async (InItem: SequencerItem) => {
    if (!sequencerTodo || agent == null) return;
    const channelId = await getPromptingSequencerChannelIdByOfficeRole(agent.role);
    if (channelId == null || channelId.trim() === "") return;
    const updated = await markPromptingSequencerItemDone(sequencerProjectName, channelId, InItem.number);
    if (updated !== null) setSequencerTodo(updated);
  };

  const renderWorkspace = () =>
    agent ? (
      <AgentWorkspaceTab
        agent={agent}
        data={{
          tasks: roleTasks,
          file_changes: roleFileChanges,
          errors: roleErrors,
          messages: roleMessages,
          tool_logs: toolLogs,
          merged_logs: mergedFocusLogs,
          plan_view: planView,
          handoffs: workspaceHandoffs,
          execution_intents: executionIntents,
        }}
        t={t}
        onRunCommand={runCommand}
        onCreateIntent={async (intent) => {
          const created = await createExecutionIntent(projectId, agent.id, agent.role, intent);
          addNotification({
            type: "info",
            message: t("workspace.intent.queued", { title: created.title }),
            agentRole: agent.role,
          });
        }}
      />
    ) : null;

  const renderActivity = () => (
    <div className="space-y-4">
      {isTauri() && (
        <section>
          <h4 className="mb-2 text-xs uppercase tracking-wide text-cyan-300">
            {t("focus.sequencerTodo")}
          </h4>
          {sequencerError && (
            <div className="mb-2 text-xs text-rose-300">{sequencerError}</div>
          )}
          {sequencerLoading && (
            <div className="text-xs text-gray-400">{t("focus.loadingHistory")}</div>
          )}
          {!sequencerLoading && sequencerTodo !== null && sequencerItemsVisible.length === 0 && (
            <div className="text-gray-400">{t("focus.empty.sequencerTodo")}</div>
          )}
          {!sequencerLoading && sequencerTodo !== null && sequencerItemsVisible.length > 0 && (
            <div>
              {sequencerTodo.main_task_name && (
                <div className="text-xs text-gray-400 mb-3 px-0.5">
                  {t("focus.sequencerMainTask")}:{" "}
                  <span className="text-gray-200">{sequencerTodo.main_task_name}</span>
                </div>
              )}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {sequencerItemsVisible.map((item) => {
                  const isCurrent =
                    item.status === "in_progress" ||
                    (item.status === "pending" &&
                      !sequencerItemsOrdered.some(
                        (other) =>
                          other.number < item.number &&
                          (other.status === "pending" || other.status === "in_progress"),
                      ));
                  const agentTag = parseSequencerAgentLabelFromDescription(item.description);
                  const bodyText = sequencerCommandBody(item.description);
                  return (
                    <article
                      key={item.number}
                      className={`flex flex-col overflow-hidden rounded-2xl border shadow-lg shadow-black/30 transition-colors ${
                        isCurrent
                          ? "border-cyan-500/50 bg-gradient-to-b from-cyan-950/40 via-[#0f172a] to-[#0a0f18] ring-1 ring-cyan-500/20"
                          : "border-[#2d3a4f] bg-gradient-to-b from-[#141c2e] to-[#0a0f18]"
                      }`}
                    >
                      <header className="flex items-center justify-between gap-2 border-b border-white/5 bg-black/25 px-3 py-2.5">
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-xs font-bold text-cyan-200">
                            {item.number}
                          </span>
                          <div className="min-w-0">
                            <div className="truncate text-[13px] font-semibold text-gray-100">{item.title}</div>
                            {agentTag && (
                              <div className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-cyan-400/90">
                                {agentTag}
                              </div>
                            )}
                          </div>
                        </div>
                        <span
                          className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                            item.status === "done"
                              ? "border-emerald-400/35 bg-emerald-500/15 text-emerald-300"
                              : item.status === "in_progress"
                                ? "border-amber-400/35 bg-amber-500/15 text-amber-200"
                                : "border-slate-500/40 bg-slate-600/20 text-slate-300"
                          }`}
                        >
                          {item.status}
                        </span>
                      </header>
                      <div className="flex flex-1 flex-col px-3 py-3">
                        <p className="text-[12px] leading-relaxed text-gray-400 whitespace-pre-wrap break-words">
                          {bodyText}
                        </p>
                        {item.status !== "done" && (
                          <div className="mt-3 flex justify-end border-t border-white/5 pt-3">
                            <button
                              type="button"
                              onClick={() => void handleSequencerMarkDone(item)}
                              className="rounded-lg bg-emerald-600/90 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-500"
                            >
                              {t("goal.sequencerMarkDone")}
                            </button>
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      )}

      <section>
        <h4 className="mb-2 text-xs uppercase tracking-wide text-cyan-300">{t("focus.tasks")}</h4>
      {loadingHistory && (
        <div className="text-xs text-cyan-300">{t("focus.loadingHistory")}</div>
      )}
      {roleTasks.length === 0 && !loadingHistory && <div className="text-gray-400">{t("focus.empty.activity")}</div>}
      {roleTasks.map((task) => (
        <div key={task.id} className="rounded-lg border border-[#374151] bg-[#0b1220] p-3">
          <div className="flex items-center justify-between gap-2">
            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${statusClass(task.status)}`}>
              {t(`focus.status.${task.status}`)}
            </span>
            <span className="text-xs text-gray-500">{new Date(task.queuedAt).toLocaleString()}</span>
          </div>
          <div className="mt-2 text-sm text-gray-100 break-words">{task.instruction || t("focus.noInstruction")}</div>
          {task.resultSummary && (
            <div className="mt-2 text-xs text-cyan-200 whitespace-pre-wrap break-words">{task.resultSummary}</div>
          )}
          {task.error && <div className="mt-2 text-xs text-rose-300 whitespace-pre-wrap break-words">{task.error}</div>}
        </div>
      ))}
      </section>
      {roleErrors.length > 0 && (
        <div className="space-y-2 pt-2">
          <div className="text-xs uppercase tracking-wide text-rose-300">{t("focus.errors")}</div>
          {roleErrors.slice(0, 5).map((err) => (
            <div key={err.id} className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-xs text-rose-200">
              <div className="text-[11px] text-rose-300">{new Date(err.timestamp).toLocaleString()}</div>
              <div className="mt-1 whitespace-pre-wrap break-words">{err.error}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );


  const renderLogs = () => (
    <div className="space-y-3 max-h-[min(420px,50vh)] overflow-y-auto pr-1">
      {mergedFocusLogs.length === 0 && <div className="text-gray-400">{t("focus.empty.logs")}</div>}
      {mergedFocusLogs.map((row) =>
        row.kind === "cli" ? (
          <div
            key={row.cli.id}
            className="rounded-lg border border-emerald-500/25 bg-[#0b1220] p-3 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-2">
              <span className="font-medium text-emerald-300">
                {t("focus.log.cli")}
                {row.cli.label ? ` · ${row.cli.label}` : ""}
              </span>
              <span className="text-[11px] text-gray-500">
                {new Date(row.cli.timestamp).toLocaleString()}
                {row.cli.provider != null && row.cli.provider !== "" ? ` · ${row.cli.provider}` : ""}
                {` · exit ${row.cli.exit_code}`}
              </span>
            </div>
            <div className="mt-2 space-y-2">
              {(row.cli.systemPrompt ?? "").trim() !== "" && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-400/90">
                    {t("focus.log.systemPrompt")}
                  </div>
                  <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-amber-950/30 p-2 font-mono text-[11px] text-amber-100/95">
                    {row.cli.systemPrompt}
                  </pre>
                </div>
              )}
              {((row.cli.skillRequestParsed?.length ?? 0) > 0 ||
                (row.cli.skillInjectedRefs?.length ?? 0) > 0 ||
                (row.cli.skillRequestDroppedRefs?.length ?? 0) > 0) && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-cyan-400/90">
                    {t("focus.log.skillTrace")}
                  </div>
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded-md bg-cyan-950/25 p-2 font-mono text-[11px] text-cyan-100/90">
                    {[
                      (row.cli.skillRequestParsed?.length ?? 0) > 0
                        ? `${t("focus.log.skillParsed")}: ${row.cli.skillRequestParsed!.join(", ")}`
                        : "",
                      (row.cli.skillInjectedRefs?.length ?? 0) > 0
                        ? `${t("focus.log.skillInjectedList")}: ${row.cli.skillInjectedRefs!.join(", ")}`
                        : "",
                      (row.cli.skillRequestDroppedRefs?.length ?? 0) > 0
                        ? `${t("focus.log.skillDroppedList")}: ${row.cli.skillRequestDroppedRefs!.join(", ")}`
                        : "",
                    ]
                      .filter((line) => line.trim() !== "")
                      .join("\n")}
                  </pre>
                </div>
              )}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t("focus.log.stdin")}</div>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[11px] text-gray-200">
                  {(row.cli.stdin ?? "").trim() !== "" ? row.cli.stdin : "-"}
                </pre>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{t("focus.log.stdout")}</div>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/30 p-2 font-mono text-[11px] text-gray-100">
                  {(row.cli.stdout ?? "").trim() !== "" ? row.cli.stdout : "-"}
                </pre>
              </div>
              {(row.cli.stderr ?? "").trim() !== "" && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-400/90">{t("focus.log.stderr")}</div>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-rose-950/40 p-2 font-mono text-[11px] text-rose-100">
                    {row.cli.stderr}
                  </pre>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div key={row.stream.id} className="rounded-lg border border-[#374151] bg-[#0b1220] p-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="uppercase text-cyan-300">
                {t("focus.log.stream")} · {row.stream.type}
              </span>
              <span className="text-gray-500">{new Date(row.stream.timestamp).toLocaleTimeString()}</span>
            </div>
            <div className="mt-1 whitespace-pre-wrap break-words text-gray-100">{row.stream.content}</div>
          </div>
        ),
      )}
    </div>
  );

  const renderCommands = () => (
    <div className="space-y-2">
      {roleCommands.length === 0 && <div className="text-gray-400">{t("focus.empty.commands")}</div>}
      {roleCommands.map((cmd) => (
        <div key={cmd.id} className="rounded-lg border border-[#374151] bg-[#0b1220] p-2 text-xs">
          <div className="text-cyan-200">$ {cmd.message}</div>
          <div className="mt-1 text-gray-500">
            {new Date(cmd.timestamp).toLocaleString()} - {cmd.status}
          </div>
          {cmd.response && <div className="mt-1 whitespace-pre-wrap break-words text-gray-200">{cmd.response}</div>}
        </div>
      ))}
    </div>
  );

  const renderTab = () => {
    if (activeTab === "workspace") return renderWorkspace();
    if (activeTab === "activity") return renderActivity();
    if (activeTab === "logs") return renderLogs();
    return renderCommands();
  };

  return (
    <AnimatePresence>
      {agent && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 16 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, y: 8 }}
            className="h-[min(760px,88vh)] w-[min(1080px,94vw)] overflow-hidden rounded-2xl border border-[#374151] bg-[#111827] p-5 text-white"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-lg font-bold">{agent.name}</div>
                <div className="mt-1 text-sm text-gray-300 uppercase">
                  {t("focus.statusLine", { role: agent.role, status: agent.status })}
                </div>
                <div className="mt-1 text-sm text-gray-400">{agent.currentTask ?? t("focus.noTask")}</div>
              </div>
              <button onClick={onClose} className="rounded-lg bg-[#1f2937] px-3 py-2 text-sm">
                {t("focus.close")}
              </button>
            </div>


            <div className="mt-4 flex flex-wrap gap-2 border-b border-[#263041] pb-3">
              {TAB_ORDER.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-md px-3 py-1.5 text-sm transition ${
                    activeTab === tab
                      ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/40"
                      : "bg-[#161f2e] text-gray-300 border border-transparent hover:border-[#2d3748]"
                  }`}
                >
                  {t(`focus.tab.${tab}`)}
                </button>
              ))}
            </div>

            <div className="mt-3 h-[calc(100%-254px)] overflow-auto pr-1">{renderTab()}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
