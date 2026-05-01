import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Circle,
  Clock3,
  GitBranch,
  Pin,
  PinOff,
  RefreshCw,
  Send,
  Server,
  X,
} from "lucide-react";

import { DashboardPanel } from "./DashboardPanel";
import { getAgentMeta, type Agent, type AgentRole, type AgentUiProfile } from "../../types/agent";
import { useOfficeStore } from "../../stores/officeStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import * as api from "../../services/agentApi";
import type { AgentDashboardResponse, AgentDashboardTab } from "../../services/agentApi";
import { tStatic } from "../../i18n";
import { agentCanUseIde, buildDashboardFallback } from "../../lib/runtimeUi";
import { buildDashboardSections, mergeRuntimeDashboardTabs, type DashboardSection } from "../../lib/runtimeDashboard";
import { buildAgentDataKeys } from "../../lib/officeDataScope";
import { STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX } from "../../constants";
import {
  isTauri,
  loadPromptingSequencerTodo,
  markPromptingSequencerItemDone,
  getPromptingSequencerChannelIdByOfficeRole,
  type SequencerItem,
  type SequencerTodoList,
} from "../../services/tauriCli";
import { getIdeTreeLocal, getIdeFileLocal } from "../../services/tauriFs";
import { useCliLogStore } from "../../stores/cliLogStore";
import { cliLogMatchesAgent } from "../../lib/agentFocusUtils";

type MonacoEditorProps = {
  language?: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
  options?: Record<string, unknown>;
};

type MonacoEditorComponent = ComponentType<MonacoEditorProps>;

type TauriFsModule = {
  readTextFile: (path: string) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<void>;
};

interface DashboardModalProps {
  role: AgentRole;
  isOpen: boolean;
  onClose: () => void;
}

type TabRenderer = (tab: AgentDashboardTab) => ReactElement;

function readScopedRows<T>(map: Record<string, T[]>, keys: string[]): T[] {
  for (const key of keys) {
    const rows = map[key];
    if (rows && rows.length > 0) return rows;
  }
  return keys.length > 0 ? map[keys[0]] ?? [] : [];
}

async function loadTauriFs(): Promise<TauriFsModule | null> {
  const moduleName = "@tauri-apps/plugin-fs";
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as Partial<TauriFsModule>;
    if (typeof mod.readTextFile === "function" && typeof mod.writeTextFile === "function") {
      return mod as TauriFsModule;
    }
    return null;
  } catch {
    return null;
  }
}

async function tryReadFile(path: string): Promise<string | null> {
  const fs = await loadTauriFs();
  if (!fs) return null;
  try {
    return await fs.readTextFile(path);
  } catch {
    return null;
  }
}

async function tryWriteFile(path: string, content: string): Promise<boolean> {
  const fs = await loadTauriFs();
  if (!fs) return false;
  try {
    await fs.writeTextFile(path, content);
    return true;
  } catch {
    return false;
  }
}

async function loadMonacoEditor(): Promise<MonacoEditorComponent | null> {
  const moduleName = "@monaco-editor/react";
  try {
    const mod = (await import(/* @vite-ignore */ moduleName)) as { default?: MonacoEditorComponent };
    return mod.default ?? null;
  } catch {
    return null;
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
}

function asRecordNumber(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => [k, asNumber(v)] as const)
    .filter(([, v]) => v !== null) as Array<[string, number]>;
  return Object.fromEntries(entries);
}

function asChecklistItems(value: unknown): Array<{ label: string; checked: boolean }> {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const src = item as { label?: unknown; checked?: unknown };
    return {
      label: String(src.label ?? "Untitled"),
      checked: Boolean(src.checked),
    };
  });
}

function formatUsd(value: number | null): string {
  if (value === null) return "-";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border border-[#374151] rounded-lg p-3 bg-[#111827]">
      <h4 className="text-sm text-cyan-300 mb-2">{title}</h4>
      {children}
    </section>
  );
}

function ValueList({ items, empty = tStatic("dashboard.noItems") }: { items: string[]; empty?: string }) {
  if (items.length === 0) {
    return <div className="text-xs text-gray-400">{empty}</div>;
  }
  return (
    <ul className="space-y-1 text-sm">
      {items.map((item, idx) => (
        <li key={`${item}-${idx}`} className="text-gray-200">
          {item}
        </li>
      ))}
    </ul>
  );
}

function HorizontalBars({ values, unit }: { values: Record<string, number>; unit?: "usd" | "count" }) {
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return <div className="text-xs text-gray-400">{tStatic("dashboard.noData")}</div>;
  }

  const max = Math.max(...entries.map(([, value]) => value), 1);

  return (
    <div className="space-y-2">
      {entries.map(([label, value]) => {
        const ratio = Math.max(0, Math.min(100, (value / max) * 100));
        const display = unit === "usd" ? `$${formatUsd(value)}` : value.toLocaleString();
        return (
          <div key={label}>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-gray-300">{label}</span>
              <span className="text-gray-400">{display}</span>
            </div>
            <div className="h-2 rounded bg-[#0b1220] overflow-hidden">
              <div className="h-full bg-cyan-500/70" style={{ width: `${ratio}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SevenDayBars({ values }: { values: Array<{ date: string; spent: number }> }) {
  if (values.length === 0) {
    return <div className="text-xs text-gray-400">{tStatic("dashboard.noHistory")}</div>;
  }

  const max = Math.max(...values.map((x) => x.spent), 1);
  return (
    <div className="flex items-end gap-2 h-24">
      {values.map((item) => {
        const ratio = Math.max(0, Math.min(1, item.spent / max));
        const h = Math.max(4, Math.round(ratio * 80));
        return (
          <div key={`${item.date}-${item.spent}`} className="flex flex-col items-center gap-1 flex-1 min-w-0">
            <div className="w-full bg-cyan-500/70 rounded-t" style={{ height: `${h}px` }} title={`${item.date}: $${formatUsd(item.spent)}`} />
            <span className="text-[10px] text-gray-500 truncate w-full text-center">{item.date.slice(5)}</span>
          </div>
        );
      })}
    </div>
  );
}

function GenericFallback({ tab }: { tab: AgentDashboardTab }) {
  return (
    <Section title={tab.label}>
      <pre className="text-xs text-gray-200 whitespace-pre-wrap break-words">{JSON.stringify(tab.data ?? {}, null, 2)}</pre>
    </Section>
  );
}

function renderKpi(tab: AgentDashboardTab): ReactElement {
  const data = tab.data ?? {};
  const byRole = asRecordNumber(data.by_role_cost);
  return (
    <Section title={tab.label}>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.spend")}: ${formatUsd(asNumber(data.spend_today_usd))}</div>
        <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.budgetLeft")}: ${formatUsd(asNumber(data.budget_remaining_usd))}</div>
        <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.calls")}: {asNumber(data.total_api_calls)?.toLocaleString() ?? "-"}</div>
        <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.agents")}: {asNumber(data.agent_count)?.toLocaleString() ?? "-"}</div>
      </div>
      <div className="mt-3">
        <HorizontalBars values={byRole} unit="usd" />
      </div>
    </Section>
  );
}

function renderAlerts(tab: AgentDashboardTab): ReactElement {
  const alerts = asStringArray(tab.data?.alerts);
  return (
    <Section title={tab.label}>
      {alerts.length === 0 ? (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noActiveAlerts")}</div>
      ) : (
        <ul className="space-y-2">
          {alerts.map((alert, idx) => (
            <li key={`${alert}-${idx}`} className="flex items-start gap-2 text-sm text-amber-200">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-300" />
              <span>{alert}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function renderKanban(tab: AgentDashboardTab): ReactElement {
  const data = tab.data ?? {};
  const columns: Array<{ key: string; title: string }> = [
    { key: "ready", title: tStatic("dashboard.ready") },
    { key: "in_progress", title: tStatic("dashboard.inProgress") },
    { key: "review", title: tStatic("dashboard.review") },
    { key: "done", title: tStatic("dashboard.done") },
  ];
  return (
    <Section title={tab.label}>
      <div className="grid grid-cols-2 gap-2">
        {columns.map((column) => (
          <div key={column.key} className="bg-[#0b1220] rounded p-2">
            <div className="text-xs text-gray-400 mb-1 uppercase">{column.title}</div>
            <ValueList items={asStringArray(data[column.key as keyof typeof data])} empty={tStatic("dashboard.noItems")} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function renderTimeline(tab: AgentDashboardTab): ReactElement {
  const currentTask = asNullableString(tab.data?.current_task);
  return (
    <Section title={tab.label}>
      {currentTask ? (
        <div className="flex items-center gap-2 text-sm text-gray-200">
          <Clock3 className="w-4 h-4 text-cyan-300" />
          <span className="text-cyan-200">{tStatic("dashboard.inProgressLabel")}</span>
          <span>{currentTask}</span>
        </div>
      ) : (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noActiveTask")}</div>
      )}
    </Section>
  );
}

function renderCode(tab: AgentDashboardTab): ReactElement {
  const currentTask = asNullableString(tab.data?.current_task);
  const lastOutput = asNullableString(tab.data?.last_output);
  return (
    <Section title={tab.label}>
      <div className="space-y-2">
        <div>
          <div className="text-xs text-gray-400 mb-1">{tStatic("dashboard.currentTask")}</div>
          <pre className="text-xs bg-[#0b1220] border border-[#1f2937] text-cyan-200 rounded p-2 font-mono whitespace-pre-wrap break-words">
            {currentTask ?? tStatic("dashboard.idle")}
          </pre>
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">{tStatic("dashboard.lastOutput")}</div>
          <pre className="text-xs bg-[#0b1220] border border-[#1f2937] text-emerald-200 rounded p-2 font-mono whitespace-pre-wrap break-words max-h-48 overflow-auto">
            {lastOutput ?? tStatic("dashboard.idle")}
          </pre>
        </div>
      </div>
    </Section>
  );
}

function renderGit(tab: AgentDashboardTab): ReactElement {
  return (
    <Section title={tab.label}>
      <ValueList items={asStringArray(tab.data?.recent_commits)} empty={tStatic("dashboard.noCommits")} />
    </Section>
  );
}

function renderPrList(tab: AgentDashboardTab): ReactElement {
  return (
    <Section title={tab.label}>
      <ValueList items={asStringArray(tab.data?.pull_requests)} empty={tStatic("dashboard.noPrs")} />
    </Section>
  );
}

function renderChecklist(tab: AgentDashboardTab): ReactElement {
  const items = asChecklistItems(tab.data?.items);
  return (
    <Section title={tab.label}>
      <ul className="space-y-1">
        {items.map((item, idx) => (
          <li key={`${item.label}-${idx}`} className="text-sm text-gray-200 flex items-center gap-2" aria-checked={item.checked}>
            {item.checked ? <CheckCircle2 className="w-4 h-4 text-emerald-400" /> : <Circle className="w-4 h-4 text-gray-500" />}
            <span>{item.label}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function SequencerTodoSection({
  projectId,
  role,
}: {
  projectId: string | null;
  role: AgentRole;
}): ReactElement | null {
  const [todo, setTodo] = useState<SequencerTodoList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [channelId, setChannelId] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri() || !projectId) {
      setTodo(null);
      setError(null);
      setChannelId(null);
      return;
    }
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const resolvedChannelId = await getPromptingSequencerChannelIdByOfficeRole(role);
        if (cancelled) return;
        if (resolvedChannelId == null || resolvedChannelId.trim() === "") {
          setChannelId(null);
          setTodo(null);
          return;
        }
        setChannelId(resolvedChannelId);
        const data = await loadPromptingSequencerTodo(projectId, resolvedChannelId);
        if (cancelled) return;
        setTodo(data);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [projectId, role]);

  const handleMarkDone = async (item: SequencerItem) => {
    if (!isTauri() || !projectId || !todo || !channelId) return;
    const updated = await markPromptingSequencerItemDone(projectId, channelId, item.number);
    if (updated) setTodo(updated);
  };

  if (!isTauri() || !projectId) return null;

  return (
    <Section title={tStatic("dashboard.roleDashboard")}>
      {error && <div className="text-xs text-rose-300 mb-2">{error}</div>}
      {loading && <div className="text-xs text-gray-400 mb-2">{tStatic("dashboard.loading")}</div>}
      {!loading && !todo && !error && (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noItems")}</div>
      )}
      {todo && (
        <div className="space-y-2">
          <div className="text-xs text-gray-400">
            {todo.main_task_name
              ? `${tStatic("dashboard.currentTask")}: ${todo.main_task_name}`
              : tStatic("dashboard.currentTask")}
          </div>
          <ul className="space-y-1 text-sm">
            {todo.items.map((item) => {
              const isCurrent =
                item.status === "in_progress" ||
                (item.status === "pending" &&
                  !todo.items.some(
                    (other) =>
                      other.number < item.number &&
                      (other.status === "pending" || other.status === "in_progress"),
                  ));
              return (
                <li
                  key={item.number}
                  className={`flex items-start gap-2 rounded border px-2 py-1 ${
                    isCurrent
                      ? "border-cyan-500/60 bg-cyan-500/10"
                      : "border-[#374151] bg-[#0b1220]"
                  }`}
                >
                  <div className="mt-0.5 text-xs text-gray-400">#{item.number}</div>
                  <div className="flex-1">
                    <div className="text-sm text-gray-100">{item.title}</div>
                    <div className="text-xs text-gray-400 whitespace-pre-wrap break-words">
                      {item.description}
                    </div>
                  </div>
                  {item.status !== "done" && (
                    <button
                      type="button"
                      onClick={() => void handleMarkDone(item)}
                      className="ml-2 px-2 py-1 rounded bg-emerald-600 text-[11px] text-white"
                    >
                      {tStatic("dashboard.done")}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Section>
  );
}

function renderServer(tab: AgentDashboardTab): ReactElement {
  const containers = asStringArray(tab.data?.containers);
  return (
    <Section title={tab.label}>
      {containers.length === 0 ? (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noContainers")}</div>
      ) : (
        <ul className="space-y-2">
          {containers.map((container, idx) => (
            <li key={`${container}-${idx}`} className="flex items-center gap-2 text-sm text-gray-200">
              <Server className="w-4 h-4 text-cyan-300" />
              <span>{container}</span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function renderDeployLog(tab: AgentDashboardTab): ReactElement {
  const logs = asStringArray(tab.data?.logs);
  const visible = logs.slice(0, 50);
  const hiddenCount = Math.max(0, logs.length - visible.length);
  return (
    <Section title={tab.label}>
      {logs.length === 0 ? (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noDeployLogs")}</div>
      ) : (
        <div className="space-y-2">
          <pre className="text-xs font-mono bg-[#0b1220] border border-[#1f2937] text-emerald-200 rounded p-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">
            {visible.join("\n")}
          </pre>
          {hiddenCount > 0 && <div className="text-xs text-gray-400">{tStatic("dashboard.moreLines", { count: hiddenCount })}</div>}
        </div>
      )}
    </Section>
  );
}

function renderSeo(tab: AgentDashboardTab): ReactElement {
  return (
    <Section title={tab.label}>
      <div className="text-xs text-gray-400">{tStatic("dashboard.seoPending")}</div>
    </Section>
  );
}

function renderContent(tab: AgentDashboardTab): ReactElement {
  return (
    <Section title={tab.label}>
      <ValueList items={asStringArray(tab.data?.items)} empty={tStatic("dashboard.noContentItems")} />
    </Section>
  );
}

function renderPreview(tab: AgentDashboardTab): ReactElement {
  return (
    <Section title={tab.label}>
      <div className="space-y-2">
        <div className="text-xs text-gray-400">{tStatic("dashboard.previewUnavailable")}</div>
        <div className="h-20 rounded border border-dashed border-[#374151] bg-[#0b1220]" />
      </div>
    </Section>
  );
}

function renderAssets(tab: AgentDashboardTab): ReactElement {
  const assets = asStringArray(tab.data?.assets);
  return (
    <Section title={tab.label}>
      {assets.length === 0 ? (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noAssets")}</div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {assets.map((asset, idx) => (
            <div key={`${asset}-${idx}`} className="bg-[#0b1220] border border-[#1f2937] rounded p-2 text-xs text-gray-200 truncate" title={asset}>
              {asset}
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

function renderRunway(tab: AgentDashboardTab): ReactElement {
  const dailyCap = asNumber(tab.data?.daily_cap_usd) ?? 0;
  const spent = asNumber(tab.data?.today_spent_usd) ?? 0;
  const remaining = asNumber(tab.data?.today_remaining_usd) ?? 0;
  const rawRatio = dailyCap > 0 ? (spent / dailyCap) * 100 : 0;
  const ratio = Math.max(0, Math.min(100, rawRatio));
  const historyRaw = Array.isArray(tab.data?.history_7d) ? (tab.data?.history_7d as Array<Record<string, unknown>>) : [];
  const history = historyRaw
    .map((item) => ({ date: String(item.date ?? ""), spent: asNumber(item.spent) ?? 0 }))
    .filter((item) => item.date);

  return (
    <Section title={tab.label}>
      <div className="space-y-3">
        <div className="text-xs grid grid-cols-3 gap-2">
          <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.cap")}: ${formatUsd(dailyCap)}</div>
          <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.spent")}: ${formatUsd(spent)}</div>
          <div className="bg-[#0b1220] rounded p-2">{tStatic("dashboard.remaining")}: ${formatUsd(remaining)}</div>
        </div>
        <div>
          <div className="h-2 rounded bg-[#0b1220] overflow-hidden">
            <div className={rawRatio > 100 ? "h-full bg-rose-500" : "h-full bg-cyan-500"} style={{ width: `${ratio}%` }} />
          </div>
          <div className="text-[11px] text-gray-400 mt-1">{tStatic("dashboard.dailyCapUsed", { percent: Math.round(rawRatio) })}</div>
        </div>
        <SevenDayBars values={history} />
      </div>
    </Section>
  );
}

function renderCostBreakdown(tab: AgentDashboardTab): ReactElement {
  const byRole = asRecordNumber(tab.data?.by_role);
  const byModel = asRecordNumber(tab.data?.by_model);
  const totalCalls = asNumber(tab.data?.total_calls);

  return (
    <Section title={tab.label}>
      <div className="space-y-3">
        <div className="text-xs text-gray-300">{tStatic("dashboard.totalCalls")}: {totalCalls?.toLocaleString() ?? "0"}</div>
        <div>
          <div className="text-xs text-gray-400 mb-1">{tStatic("dashboard.byRole")}</div>
          <HorizontalBars values={byRole} unit="usd" />
        </div>
        <div>
          <div className="text-xs text-gray-400 mb-1">{tStatic("dashboard.byModel")}</div>
          <HorizontalBars values={byModel} unit="usd" />
        </div>
      </div>
    </Section>
  );
}

type DashboardLayoutState = {
  pinned: string[];
  order: string[];
};

function renderApprovalQueue(tab: AgentDashboardTab): ReactElement {
  const items = Array.isArray(tab.data?.items) ? (tab.data.items as Array<Record<string, unknown>>) : [];

  return (
    <Section title={tab.label}>
      {items.length === 0 ? (
        <div className="text-xs text-gray-400">{tStatic("dashboard.noItems")}</div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const stepId = String(item.step_id ?? "");
            const label = String(item.label ?? stepId ?? "Approval");
            const approver = asNullableString(item.approver_role_label) ?? "Owner";
            const assigned = asNullableString(item.assigned_role_label) ?? "Unassigned";
            const priority = String(item.priority ?? "medium").toUpperCase();
            return (
              <div key={stepId || label} className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-medium text-white">{label}</div>
                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                    {priority}
                  </span>
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  {assigned} {"->"} {approver}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function renderExecutionGraph(tab: AgentDashboardTab): ReactElement {
  const goal = asNullableString(tab.data?.goal);
  const planStatus = asNullableString(tab.data?.plan_status);
  const lanes = Array.isArray(tab.data?.lanes) ? (tab.data.lanes as Array<Record<string, unknown>>) : [];
  const nodes = Array.isArray(tab.data?.nodes) ? (tab.data.nodes as Array<Record<string, unknown>>) : [];
  const groupedByLane = new Map<string, Array<Record<string, unknown>>>();

  for (const node of nodes) {
    const laneLabel = asNullableString(node.lane_label) ?? "Unassigned";
    const rows = groupedByLane.get(laneLabel) ?? [];
    rows.push(node);
    groupedByLane.set(laneLabel, rows);
  }

  return (
    <Section title={tab.label}>
      <div className="space-y-3">
        <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
          <div className="text-xs text-gray-400">{goal ?? tStatic("dashboard.noDataLoaded")}</div>
          <div className="mt-1 text-sm text-cyan-200">{planStatus ?? "draft"}</div>
        </div>
        <div className="grid gap-3 xl:grid-cols-2">
          {(lanes.length > 0 ? lanes : [{ label: "Unassigned" }]).map((lane) => {
            const laneLabel = asNullableString(lane.label) ?? "Unassigned";
            const laneNodes = (groupedByLane.get(laneLabel) ?? []).sort(
              (left, right) => (asNumber(left.depth) ?? 0) - (asNumber(right.depth) ?? 0),
            );
            return (
              <div key={laneLabel} className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
                <div className="text-xs uppercase tracking-[0.18em] text-gray-400">{laneLabel}</div>
                <div className="mt-2 space-y-2">
                  {laneNodes.map((node) => (
                    <div key={String(node.step_id ?? node.label ?? laneLabel)} className="rounded-md border border-[#243041] bg-[#111827] p-2">
                      <div className="text-sm font-medium text-white">{String(node.label ?? "Step")}</div>
                      <div className="mt-1 flex items-center justify-between text-[11px] text-gray-400">
                        <span>{asNullableString(node.assigned_role_label) ?? "Unassigned"}</span>
                        <span>{String(node.status ?? "pending")}</span>
                      </div>
                    </div>
                  ))}
                  {laneNodes.length === 0 && <div className="text-xs text-gray-500">{tStatic("dashboard.noItems")}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function renderMeetingBrief(tab: AgentDashboardTab): ReactElement {
  const layout = asNullableString(tab.data?.layout) ?? "roundtable";
  const participants = Array.isArray(tab.data?.participants)
    ? (tab.data.participants as Array<Record<string, unknown>>)
    : [];

  return (
    <Section title={tab.label}>
      <div className="space-y-3">
        <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] px-3 py-2 text-xs text-gray-300">
          Layout: {layout}
        </div>
        <div className="space-y-2">
          {participants.map((participant) => (
            <div
              key={String(participant.instance_id ?? participant.role_label ?? layout)}
              className="flex items-center justify-between rounded-lg border border-[#1f2937] bg-[#0b1220] px-3 py-2"
            >
              <div>
                <div className="text-sm text-white">{String(participant.role_label ?? "Participant")}</div>
                <div className="text-[11px] text-gray-400">{String(participant.reason ?? "runtime")}</div>
              </div>
              <div className="text-xs text-cyan-200">#{String(participant.seat_order ?? 0)}</div>
            </div>
          ))}
          {participants.length === 0 && <div className="text-xs text-gray-400">{tStatic("dashboard.noItems")}</div>}
        </div>
      </div>
    </Section>
  );
}

function renderOrgChart(tab: AgentDashboardTab): ReactElement {
  const clusters = Array.isArray(tab.data?.clusters) ? (tab.data.clusters as Array<Record<string, unknown>>) : [];
  const edges = Array.isArray(tab.data?.edges) ? (tab.data.edges as Array<Record<string, unknown>>) : [];

  return (
    <Section title={tab.label}>
      <div className="space-y-3">
        <div className="grid gap-2 xl:grid-cols-2">
          {clusters.map((cluster) => (
            <div key={String(cluster.id ?? cluster.label ?? "cluster")} className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
              <div className="text-sm font-medium text-white">{String(cluster.label ?? "Cluster")}</div>
              <div className="mt-1 text-[11px] text-gray-400">
                {(Array.isArray(cluster.role_labels) ? cluster.role_labels : [])
                  .map((value) => String(value))
                  .join(", ") || tStatic("dashboard.noItems")}
              </div>
            </div>
          ))}
        </div>
        {edges.length > 0 && (
          <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
            <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.18em] text-gray-400">
              <GitBranch className="h-3.5 w-3.5 text-cyan-300" />
              Reporting Lines
            </div>
            <div className="space-y-1 text-sm text-gray-200">
              {edges.map((edge) => (
                <div key={`${String(edge.from ?? "")}-${String(edge.to ?? "")}-${String(edge.label ?? "")}`}>
                  {String(edge.from ?? "Cluster")} {"->"} {String(edge.to ?? "Cluster")} ({String(edge.label ?? "link")})
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

function readDashboardLayout(role: AgentRole): DashboardLayoutState {
  if (typeof window === "undefined") return { pinned: [], order: [] };
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX}:${role}`);
    if (!raw) return { pinned: [], order: [] };
    const parsed = JSON.parse(raw) as Partial<DashboardLayoutState>;
    return {
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned.map(String) : [],
      order: Array.isArray(parsed.order) ? parsed.order.map(String) : [],
    };
  } catch {
    return { pinned: [], order: [] };
  }
}

function writeDashboardLayout(role: AgentRole, layout: DashboardLayoutState) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${STORAGE_KEY_DASHBOARD_LAYOUT_PREFIX}:${role}`, JSON.stringify(layout));
}

function sortWidgetIdsByLayout(widgetIds: string[], order: string[]): string[] {
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  return [...widgetIds].sort((left, right) => {
    const leftIndex = orderIndex.get(left);
    const rightIndex = orderIndex.get(right);
    if (leftIndex != null && rightIndex != null) return leftIndex - rightIndex;
    if (leftIndex != null) return -1;
    if (rightIndex != null) return 1;
    return left.localeCompare(right);
  });
}

function applyDashboardLayout(
  sections: DashboardSection[],
  tabs: AgentDashboardTab[],
  layout: DashboardLayoutState,
): DashboardSection[] {
  const available = new Set(tabs.map((tab) => tab.id));
  const pinned = layout.pinned.filter((widgetId) => available.has(widgetId));
  const ordered = layout.order.filter((widgetId) => available.has(widgetId));
  const sectionRows = sections
    .map((section) => ({
      ...section,
      widget_ids: sortWidgetIdsByLayout(
        section.widget_ids.filter((widgetId) => !pinned.includes(widgetId)),
        ordered,
      ),
    }))
    .filter((section) => section.widget_ids.length > 0);

  const assigned = new Set(sectionRows.flatMap((section) => section.widget_ids));
  const remainder = sortWidgetIdsByLayout(
    tabs.map((tab) => tab.id).filter((widgetId) => !assigned.has(widgetId) && !pinned.includes(widgetId)),
    ordered,
  );

  const nextSections = [...sectionRows];
  if (remainder.length > 0) {
    nextSections.push({
      id: "more_widgets",
      title: tStatic("phase3.dashboard.moreWidgets"),
      widget_ids: remainder,
    });
  }

  if (pinned.length === 0) return nextSections;
  return [
    {
      id: "pinned",
      title: tStatic("phase3.dashboard.pinned"),
      widget_ids: sortWidgetIdsByLayout(pinned, ordered),
    },
    ...nextSections,
  ];
}

const TAB_RENDERERS: Record<string, TabRenderer> = {
  kpi: renderKpi,
  alerts: renderAlerts,
  kanban: renderKanban,
  timeline: renderTimeline,
  code: renderCode,
  git: renderGit,
  pr_list: renderPrList,
  checklist: renderChecklist,
  server: renderServer,
  deploy_log: renderDeployLog,
  seo: renderSeo,
  content: renderContent,
  preview: renderPreview,
  assets: renderAssets,
  runway: renderRunway,
  cost_breakdown: renderCostBreakdown,
  approval_queue: renderApprovalQueue,
  execution_graph: renderExecutionGraph,
  meeting_brief: renderMeetingBrief,
  org_chart: renderOrgChart,
};

function RoleTabView({ tab }: { tab: AgentDashboardTab }) {
  const renderer = TAB_RENDERERS[tab.id];
  return renderer ? renderer(tab) : <GenericFallback tab={tab} />;
}

const FALLBACK_WIDGETS: Record<string, { primary: string[]; secondary: string[]; capabilities?: string[] }> = {
  ceo: { primary: ["alerts", "timeline"], secondary: [] },
  pm: { primary: ["kanban", "timeline"], secondary: [] },
  developer: { primary: ["code", "git", "checklist"], secondary: ["timeline"], capabilities: ["code_generation"] },
  developer_front: { primary: ["code", "git"], secondary: ["timeline"], capabilities: ["code_generation", "frontend"] },
  developer_back: { primary: ["code", "checklist"], secondary: ["alerts"], capabilities: ["code_generation", "backend"] },
  reviewer: { primary: ["checklist", "alerts"], secondary: ["timeline"], capabilities: ["review"] },
  verifier: { primary: ["checklist", "deploy_log"], secondary: ["server"], capabilities: ["verification"] },
  devops: { primary: ["server", "deploy_log"], secondary: [] },
  marketer: { primary: ["content"], secondary: ["timeline"] },
  designer: { primary: ["preview", "assets"], secondary: ["timeline"] },
  cfo: { primary: ["runway", "cost_breakdown"], secondary: ["alerts"] },
};

function buildFallbackUiProfile(role: AgentRole): AgentUiProfile {
  const meta = getAgentMeta(role);
  const widgets = FALLBACK_WIDGETS[role] ?? { primary: ["timeline"], secondary: [] };
  return {
    display_name: meta.name,
    title: meta.title,
    accent_color: meta.color,
    icon: meta.icon,
    home_zone: "lobby",
    team_affinity: "fallback_team",
    authority_level: 10,
    capability_tags: [role],
    primary_widgets: widgets.primary,
    secondary_widgets: widgets.secondary,
    focus_mode: "fallback",
    meeting_behavior: "standard",
  };
}

function buildFallbackAgent(role: AgentRole): Agent {
  const meta = getAgentMeta(role);
  const widgets = FALLBACK_WIDGETS[role] ?? { primary: ["timeline"], secondary: [] };
  return {
    id: `dashboard-${role}`,
    role,
    name: meta.name,
    meta,
    position: { x: 0, y: 0 },
    path: [],
    status: "idle",
    runtimeStatus: "idle",
    uiProfile: buildFallbackUiProfile(role),
    capabilities: widgets.capabilities ?? [],
  };
}

function buildMockDashboard(role: AgentRole, agent?: Agent): AgentDashboardResponse {
  return buildDashboardFallback(agent ?? buildFallbackAgent(role));
}

export function DashboardModal({ role, isOpen, onClose }: DashboardModalProps) {
  const { projectId, agents, commandHistory, sendCommand, addNotification, workLogs } = useOfficeStore();
  const cliEntries = useCliLogStore((s) => s.entries);
  const planView = useWorkflowStore((state) => state.planView);
  const isUiOnlyMode = import.meta.env.VITE_UI_ONLY === "true";
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.role === role) ?? buildFallbackAgent(role),
    [agents, role],
  );
  const headerMeta = activeAgent.meta ?? getAgentMeta(role);
  const canUseIde = agentCanUseIde(activeAgent);
  const [tab, setTab] = useState<"overview" | "activity" | "command" | "ide">("overview");
  const [command, setCommand] = useState("");
  const [idePath, setIdePath] = useState("");
  const [ideContent, setIdeContent] = useState("");
  const [loading, setLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboardData, setDashboardData] = useState<AgentDashboardResponse | null>(null);
  const [dashboardLayout, setDashboardLayout] = useState<DashboardLayoutState>(() => readDashboardLayout(role));
  const [MonacoEditor, setMonacoEditor] = useState<MonacoEditorComponent | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    console.trace("[DashboardModal] opened", { role, tab });
  }, [isOpen, role, tab]);

  const roleCommands = useMemo(() => commandHistory.filter((x) => x.agentRole === role), [commandHistory, role]);
  const roleScopeKeys = useMemo(() => buildAgentDataKeys(activeAgent), [activeAgent]);
  const roleLogs = useMemo(() => {
    const streamLogs = readScopedRows(workLogs, roleScopeKeys);
    const cliLogs = cliEntries
      .filter((entry) => cliLogMatchesAgent(entry, role, activeAgent.id))
      .map((entry) => {
        const skillTraceLines: string[] = [];
        if ((entry.skillRequestParsed?.length ?? 0) > 0) {
          skillTraceLines.push(`Parsed: ${entry.skillRequestParsed!.join(", ")}`);
        }
        if ((entry.skillInjectedRefs?.length ?? 0) > 0) {
          skillTraceLines.push(`Injected (bundle): ${entry.skillInjectedRefs!.join(", ")}`);
        }
        if ((entry.skillRequestDroppedRefs?.length ?? 0) > 0) {
          skillTraceLines.push(`Not in bundle: ${entry.skillRequestDroppedRefs!.join(", ")}`);
        }
        const skillTraceBlock =
          skillTraceLines.length > 0 ? `## Skill request trace\n${skillTraceLines.join("\n")}` : "";
        return {
        id: entry.id,
        type: "tool_result" as const,
        content: [
          entry.systemPrompt ? `## System Prompt\n${entry.systemPrompt}` : "",
          skillTraceBlock,
          entry.stdin ? `## Input\n${entry.stdin}` : "",
          entry.stdout ? `## Stdout\n${entry.stdout}` : "",
          entry.stderr ? `## Stderr\n${entry.stderr}` : "",
        ]
          .filter((v) => v.trim() !== "")
          .join("\n\n"),
        timestamp: entry.timestamp,
        toolName: entry.label ?? "cli",
      };
      });
    return [...streamLogs, ...cliLogs]
      .sort((left, right) => right.timestamp - left.timestamp)
      .slice(0, 120);
  }, [workLogs, roleScopeKeys, cliEntries, activeAgent.id, role]);
  const effectiveDashboard = useMemo(() => dashboardData ?? buildMockDashboard(role, activeAgent), [activeAgent, dashboardData, role]);
  const overviewTabs = useMemo(
    () => mergeRuntimeDashboardTabs(effectiveDashboard.tabs ?? [], activeAgent, planView),
    [activeAgent, effectiveDashboard.tabs, planView],
  );
  const overviewSections = useMemo(
    () =>
      applyDashboardLayout(
        buildDashboardSections(overviewTabs, activeAgent, planView),
        overviewTabs,
        dashboardLayout,
      ),
    [activeAgent, dashboardLayout, overviewTabs, planView],
  );
  const tabIndex = useMemo(
    () => new Map(overviewTabs.map((item) => [item.id, item])),
    [overviewTabs],
  );

  useEffect(() => {
    setDashboardLayout(readDashboardLayout(role));
  }, [role]);

  useEffect(() => {
    writeDashboardLayout(role, dashboardLayout);
  }, [dashboardLayout, role]);

  useEffect(() => {
    if (!canUseIde && tab === "ide") {
      setTab("overview");
    }
  }, [canUseIde, tab]);

  useEffect(() => {
    if (!isOpen || tab !== "ide" || MonacoEditor) return;
    let cancelled = false;
    const run = async () => {
      const editor = await loadMonacoEditor();
      if (!cancelled && editor) {
        setMonacoEditor(() => editor);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isOpen, tab, MonacoEditor]);

  const loadDashboard = useCallback(async () => {
    if (!isOpen) return;
    if (isUiOnlyMode || !projectId) {
      setDashboardData(buildMockDashboard(role, activeAgent));
      setDashboardError(null);
      return;
    }
    setDashboardLoading(true);
    setDashboardError(null);
    try {
      const data = await api.getAgentDashboard(projectId, role);
      setDashboardData(data);
    } catch (err) {
      setDashboardData(buildMockDashboard(role, activeAgent));
      setDashboardError(err instanceof Error ? err.message : tStatic("dashboard.loadFailed"));
    } finally {
      setDashboardLoading(false);
    }
  }, [activeAgent, projectId, isOpen, role, isUiOnlyMode]);

  useEffect(() => {
    if (!isOpen) return;
    if (!projectId && !isUiOnlyMode) return;
    void loadDashboard();
  }, [isOpen, isUiOnlyMode, loadDashboard, projectId]);

  useEffect(() => {
    if (!isOpen || !projectId || tab !== "ide") return;
    const load = async () => {
      try {
        if (isTauri()) {
          const tree = await getIdeTreeLocal(".");
          if (!tree?.files?.length) {
            setIdePath("");
            setIdeContent("");
            return;
          }
          const first = tree.files[0];
          if (!first) return;
          setIdePath(first.path);
          const file = await getIdeFileLocal(first.path);
          setIdeContent(file?.content ?? "");
          return;
        }
        const tree = await api.getIdeTree(projectId);
        const first = tree.files[0];
        if (!first) return;
        setIdePath(first.path);
        const file = await api.getIdeFile(projectId, first.path);
        setIdeContent(file.content);
      } catch {
        setIdePath("");
        setIdeContent("");
      }
    };
    void load();
  }, [isOpen, projectId, tab]);

  const submitCommand = async () => {
    if (!command.trim()) return;
    await sendCommand(role, command.trim());
    setCommand("");
  };

  const saveIde = async () => {
    if (!idePath) return;
    setLoading(true);
    const ok = await tryWriteFile(idePath, ideContent);
    addNotification({
      type: ok ? "success" : "warning",
      message: ok ? tStatic("dashboard.savedLocal") : tStatic("dashboard.tauriUnavailableSave"),
    });
    setLoading(false);
  };

  const loadLocal = async () => {
    if (!idePath) return;
    setLoading(true);
    const content = await tryReadFile(idePath);
    if (content !== null) {
      setIdeContent(content);
      addNotification({ type: "success", message: tStatic("dashboard.loadedLocal") });
    } else {
      addNotification({ type: "warning", message: tStatic("dashboard.tauriUnavailableLoad") });
    }
    setLoading(false);
  };

  const togglePinned = (widgetId: string) => {
    setDashboardLayout((prev) => {
      const nextPinned = prev.pinned.includes(widgetId)
        ? prev.pinned.filter((id) => id !== widgetId)
        : [...prev.pinned, widgetId];
      return {
        pinned: nextPinned,
        order: prev.order.includes(widgetId) ? prev.order : [...prev.order, widgetId],
      };
    });
  };

  const moveWidget = (sectionWidgetIds: string[], widgetId: string, direction: -1 | 1) => {
    setDashboardLayout((prev) => {
      const orderedSection = sortWidgetIdsByLayout(sectionWidgetIds, prev.order);
      const index = orderedSection.indexOf(widgetId);
      const swapIndex = index + direction;
      if (index < 0 || swapIndex < 0 || swapIndex >= orderedSection.length) return prev;

      const nextSection = [...orderedSection];
      [nextSection[index], nextSection[swapIndex]] = [nextSection[swapIndex], nextSection[index]];
      return {
        ...prev,
        order: [...prev.order.filter((id) => !sectionWidgetIds.includes(id)), ...nextSection],
      };
    });
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/60 z-40"
            data-testid="dashboard-modal-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none">
            <motion.div
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.95 }}
              className="pointer-events-auto w-full max-w-5xl h-[76vh] bg-[#0b1220] border border-[#1f2937] rounded-2xl overflow-hidden text-white"
              data-testid="dashboard-modal"
            >
              <div className="h-1" style={{ backgroundColor: headerMeta.color }} />
              <div className="flex items-center justify-between px-5 py-3 border-b border-[#1f2937]">
                <div>
                  <div className="font-bold">{headerMeta.name}</div>
                  <div className="text-xs text-gray-400">{headerMeta.title}</div>
                </div>
                <button onClick={onClose} className="p-2 rounded-lg hover:bg-white/10">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="px-5 py-2 border-b border-[#1f2937] flex gap-2">
                <button onClick={() => setTab("overview")} className={`px-3 py-1.5 rounded-lg text-sm ${tab === "overview" ? "bg-cyan-600" : "bg-[#111827]"}`}>
                  {tStatic("dashboard.tab.dashboard")}
                </button>
                <button onClick={() => setTab("activity")} className={`px-3 py-1.5 rounded-lg text-sm ${tab === "activity" ? "bg-cyan-600" : "bg-[#111827]"}`}>
                  {tStatic("dashboard.tab.activity")}
                </button>
                <button onClick={() => setTab("command")} className={`px-3 py-1.5 rounded-lg text-sm ${tab === "command" ? "bg-cyan-600" : "bg-[#111827]"}`}>
                  {tStatic("dashboard.tab.command")}
                </button>
                {canUseIde && (
                  <button onClick={() => setTab("ide")} className={`px-3 py-1.5 rounded-lg text-sm ${tab === "ide" ? "bg-cyan-600" : "bg-[#111827]"}`}>
                    {tStatic("dashboard.tab.ide")}
                  </button>
                )}
              </div>

              <div className="h-[calc(76vh-106px)] p-5 overflow-hidden">
                {tab === "overview" && (
                  <DashboardPanel title={tStatic("dashboard.roleDashboard")}>
                    <div className="space-y-3 h-full overflow-auto">
                      <div className="flex items-center justify-between">
                        <div className="text-xs text-gray-400">
                          {effectiveDashboard ? tStatic("dashboard.updatedAt", { time: new Date(effectiveDashboard.updated_at).toLocaleString() }) : tStatic("dashboard.noDataLoaded")}
                        </div>
                        <button
                          onClick={() => void loadDashboard()}
                          className="px-2 py-1 rounded-md bg-[#1f2937] text-xs inline-flex items-center gap-1"
                          disabled={dashboardLoading}
                        >
                          <RefreshCw className={`w-3.5 h-3.5 ${dashboardLoading ? "animate-spin" : ""}`} />
                          {tStatic("dashboard.refresh")}
                        </button>
                      </div>
                      {dashboardError && <div className="text-sm text-rose-300">{dashboardError}</div>}
                      {dashboardLoading && <div className="text-sm text-gray-300">{tStatic("dashboard.loading")}</div>}
                      {!dashboardLoading && effectiveDashboard && (
                        <div className="space-y-3">
                          {planView && (
                            <div className="grid gap-3 md:grid-cols-3">
                              <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">Plan</div>
                                <div className="mt-1 text-sm text-cyan-200">{planView.activePlan?.goal ?? tStatic("phase3.hud.noPlan")}</div>
                              </div>
                              <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">Approvals</div>
                                <div className="mt-1 text-sm text-cyan-200">{planView.approvalQueue.length}</div>
                              </div>
                              <div className="rounded-lg border border-[#1f2937] bg-[#0b1220] p-3">
                                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">Meeting</div>
                                <div className="mt-1 text-sm text-cyan-200">{planView.meeting.participants.length} participants</div>
                              </div>
                            </div>
                          )}
                          {(role === "pm" || agentCanUseIde(activeAgent)) && (
                            <SequencerTodoSection projectId={projectId} role={role} />
                          )}
                          {overviewSections.map((section) => (
                            <div key={section.id} className="space-y-2">
                              <div className="text-[11px] uppercase tracking-[0.18em] text-gray-400">
                                {section.title}
                              </div>
                              <div className="grid gap-3 xl:grid-cols-2">
                                {section.widget_ids.map((widgetId, index) => {
                                  const item = tabIndex.get(widgetId);
                                  if (!item) return null;
                                  const isPinned = dashboardLayout.pinned.includes(widgetId);
                                  return (
                                    <div key={`${section.id}-${widgetId}`} className="relative">
                                      <div className="absolute right-3 top-3 z-10 flex gap-1">
                                        <button
                                          type="button"
                                          onClick={() => togglePinned(widgetId)}
                                          className="rounded-md border border-[#374151] bg-[#0b1220] p-1 text-gray-300 hover:text-white"
                                          title={isPinned ? tStatic("phase3.dashboard.unpin") : tStatic("phase3.dashboard.pin")}
                                        >
                                          {isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => moveWidget(section.widget_ids, widgetId, -1)}
                                          disabled={index === 0}
                                          className="rounded-md border border-[#374151] bg-[#0b1220] p-1 text-gray-300 hover:text-white disabled:opacity-40"
                                          title={tStatic("phase3.dashboard.moveUp")}
                                        >
                                          <ArrowUp className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => moveWidget(section.widget_ids, widgetId, 1)}
                                          disabled={index === section.widget_ids.length - 1}
                                          className="rounded-md border border-[#374151] bg-[#0b1220] p-1 text-gray-300 hover:text-white disabled:opacity-40"
                                          title={tStatic("phase3.dashboard.moveDown")}
                                        >
                                          <ArrowDown className="h-3.5 w-3.5" />
                                        </button>
                                      </div>
                                      <div className="[&>section]:pr-20">
                                        <RoleTabView tab={item} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </DashboardPanel>
                )}

                {tab === "activity" && (
                  <DashboardPanel title={tStatic("dashboard.activityStream")}>
                    <div className="h-[28rem] overflow-auto bg-[#111827] border border-[#374151] rounded-lg p-3 text-sm space-y-2">
                      {roleLogs.length === 0 && <div className="text-gray-400">{tStatic("dashboard.noLogs")}</div>}
                      {roleLogs.map((log) => (
                        <div key={log.id} className="border-b border-[#1f2937] pb-2">
                          <div className="flex items-center justify-between">
                            <span className="text-cyan-300 text-xs uppercase">{log.type}</span>
                            <span className="text-[11px] text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <div className="mt-1 text-gray-100 whitespace-pre-wrap break-words">{log.content}</div>
                          {log.toolName && <div className="text-[11px] text-amber-300 mt-1">{tStatic("dashboard.tool")}: {log.toolName}</div>}
                        </div>
                      ))}
                    </div>
                  </DashboardPanel>
                )}

                {tab === "command" && (
                  <DashboardPanel title={tStatic("dashboard.commandConsole")}>
                    <div className="space-y-3">
                      <div className="h-80 overflow-auto bg-[#111827] border border-[#374151] rounded-lg p-3 text-sm space-y-2">
                        {roleCommands.map((c) => (
                          <div key={c.id} className="border-b border-[#1f2937] pb-2">
                            <div className="text-cyan-300">$ {c.message}</div>
                            <div className="text-xs text-gray-500">{new Date(c.timestamp).toLocaleString()}</div>
                            {c.response && <div className="text-gray-200 mt-1">{c.response}</div>}
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <input
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                          className="flex-1 bg-[#111827] border border-[#374151] rounded-lg px-3 py-2"
                          placeholder={tStatic("dashboard.typeCommand")}
                        />
                        <button onClick={submitCommand} className="px-4 py-2 bg-cyan-600 rounded-lg inline-flex items-center gap-2">
                          <Send className="w-4 h-4" />
                          {tStatic("dashboard.send")}
                        </button>
                      </div>
                    </div>
                  </DashboardPanel>
                )}

                {tab === "ide" && (
                  <DashboardPanel title={tStatic("dashboard.workspaceIde")}>
                    <div className="space-y-3 h-full flex flex-col">
                      <div className="flex gap-2">
                        <input
                          value={idePath}
                          onChange={(e) => setIdePath(e.target.value)}
                          className="flex-1 bg-[#111827] border border-[#374151] rounded-lg px-3 py-2 text-sm"
                          placeholder={tStatic("dashboard.workspaceFilePath")}
                        />
                        <button onClick={loadLocal} disabled={loading} className="px-3 py-2 bg-[#1f2937] rounded-lg text-sm">
                          {tStatic("dashboard.loadLocal")}
                        </button>
                        <button onClick={saveIde} disabled={loading} className="px-3 py-2 bg-cyan-600 rounded-lg text-sm">
                          {tStatic("dashboard.save")}
                        </button>
                      </div>
                      <div className="flex-1 border border-[#374151] rounded-lg overflow-hidden">
                        {MonacoEditor ? (
                          <MonacoEditor
                            language="typescript"
                            value={ideContent}
                            onChange={(v) => setIdeContent(v ?? "")}
                            options={{
                              minimap: { enabled: false },
                              fontSize: 13,
                              readOnly: false,
                              automaticLayout: true,
                            }}
                          />
                        ) : (
                          <textarea
                            value={ideContent}
                            onChange={(e) => setIdeContent(e.target.value)}
                            className="w-full h-full bg-[#0b1220] text-gray-100 p-3 font-mono text-sm outline-none resize-none"
                            spellCheck={false}
                          />
                        )}
                      </div>
                    </div>
                  </DashboardPanel>
                )}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
