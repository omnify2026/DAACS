import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  Clock3,
  Crown,
  GitBranch,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getAgentMeta } from "../../types/agent";
import type { Agent, AgentRole, Command, Notification } from "../../types/agent";
import type { ExecutionIntent, ExecutionPlan } from "../../types/runtime";
import { getOwnerOpsStatus, listOwnerDecisions, submitOwnerDecision } from "../../services/agentApi";
import type { OwnerDecisionRecord } from "../../services/agentApi";
import type { OwnerOpsStatusResponse } from "../../services/agentApi";
import { useI18n } from "../../i18n";
import type { RuntimePlanView } from "../../lib/runtimePlan";

type DecisionPriority = "high" | "medium" | "low";
type DecisionAction = "approved" | "hold" | "rejected";

interface DecisionItem {
  id: string;
  title: string;
  detail: string;
  source: string;
  priority: DecisionPriority;
  role?: AgentRole;
  planId?: string;
  stepId?: string;
  intentId?: string;
  targetType: "workflow" | "team_run" | "incident" | "execution_intent";
  targetId: string;
}

interface TraceItem {
  id: string;
  ts: number;
  actor: string;
  action: string;
  state: "done" | "in_progress" | "failed" | "info";
  role?: AgentRole;
}

interface OwnerOpsPanelProps {
  agents: Agent[];
  notifications: Notification[];
  commandHistory: Command[];
  activePlan: ExecutionPlan | null;
  planView: RuntimePlanView | null;
  executionIntents: ExecutionIntent[];
  teamExecutionRunning: boolean;
  onFocusRole: (role: AgentRole) => void;
  onApproveStep: (planId: string, stepId: string) => Promise<void>;
  onDecideIntent: (intentId: string, action: DecisionAction) => Promise<ExecutionIntent | null>;
  projectId: string | null;
  addNotification: (n: Omit<Notification, "id" | "timestamp">) => void;
  className?: string;
}

const PRIORITY_STYLE: Record<DecisionPriority, string> = {
  high: "bg-rose-500/20 text-rose-300 border-rose-500/40",
  medium: "bg-amber-500/20 text-amber-300 border-amber-500/40",
  low: "bg-slate-500/20 text-slate-300 border-slate-500/40",
};

const TRACE_STYLE: Record<TraceItem["state"], string> = {
  done: "text-emerald-300",
  in_progress: "text-cyan-300",
  failed: "text-rose-300",
  info: "text-gray-300",
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function buildDecisionQueue(
  notifications: Notification[],
  activePlan: ExecutionPlan | null,
  planView: RuntimePlanView | null,
  executionIntents: ExecutionIntent[],
  errorCount: number,
  teamExecutionRunning: boolean,
  t: (key: string, vars?: Record<string, string | number>) => string,
): DecisionItem[] {
  const items: DecisionItem[] = [];

  if (activePlan) {
    const completedSteps = activePlan.steps.filter((step) => step.status === "completed" || step.status === "approved").length;
    items.push({
      id: `plan-${activePlan.plan_id}`,
      title: t("phase3.owner.activePlan"),
      detail: `${activePlan.goal} • ${completedSteps}/${activePlan.steps.length}`,
      source: "Plan",
      priority: "medium",
      role: "pm",
      planId: activePlan.plan_id,
      targetType: "workflow",
      targetId: activePlan.plan_id,
    });
  }

  for (const approval of planView?.approvalQueue ?? []) {
    items.unshift({
      id: `approval-${approval.step_id}`,
      title: approval.label,
      detail: `${approval.assigned_role_label ?? t("owner.system")} -> ${approval.approver_role_label ?? t("owner.system")}`,
      source: "Approval",
      priority: approval.priority,
      role: approval.assigned_role_label as AgentRole | undefined,
      planId: approval.plan_id,
      stepId: approval.step_id,
      targetType: "workflow",
      targetId: `${approval.plan_id}:${approval.step_id}`,
    });
  }

  for (const intent of executionIntents.filter((row) => row.status === "pending_approval")) {
    items.unshift({
      id: `intent-${intent.intent_id}`,
      title: intent.title,
      detail: `${intent.kind} -> ${intent.target}`,
      source: "Intent",
      priority: "high",
      role: intent.agent_role as AgentRole,
      intentId: intent.intent_id,
      targetType: "execution_intent",
      targetId: intent.intent_id,
    });
  }

  if (teamExecutionRunning) {
    items.push({
      id: "team-run-active",
      title: t("owner.parallelTeamRun"),
      detail: t("owner.parallelTeamRunDetail"),
      source: "Team",
      priority: "medium",
      role: "pm",
      targetType: "team_run",
      targetId: "team-run-active",
    });
  }

  if (errorCount > 0) {
    items.push({
      id: "error-escalation",
      title: t("owner.errorEscalation", { count: errorCount }),
      detail: t("owner.errorEscalationDetail"),
      source: "Ops",
      priority: "high",
      role: "devops",
      targetType: "incident",
      targetId: "incident-global",
    });
  }

  const fromNotifications = notifications
    .filter(
      (n) =>
        (n.type === "warning" || n.type === "error" || n.type === "info") &&
        Boolean(n.agentRole),
    )
    .slice(-6)
    .reverse()
    .map((n) => ({
      id: `notif-${n.id}`,
      title: n.message.length > 44 ? `${n.message.slice(0, 44)}...` : n.message,
      detail: `${n.agentRole ? getAgentMeta(n.agentRole).name : t("owner.system")} at ${formatTime(n.timestamp)}`,
      source: "Alert",
      priority: n.type === "error" ? ("high" as const) : n.type === "warning" ? ("medium" as const) : ("low" as const),
      role: n.agentRole,
      targetType: n.type === "error" || n.type === "warning" ? ("incident" as const) : ("team_run" as const),
      targetId: `notif-${n.id}`,
    }));

  return [...items, ...fromNotifications].slice(0, 7);
}

function buildTraceItems(
  commandHistory: Command[],
  notifications: Notification[],
  planView: RuntimePlanView | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): TraceItem[] {
  const commandItems: TraceItem[] = commandHistory.slice(-10).map((cmd) => ({
    id: `cmd-${cmd.id}`,
    ts: cmd.timestamp,
    actor: getAgentMeta(cmd.agentRole).name,
    action: cmd.message.length > 46 ? `${cmd.message.slice(0, 46)}...` : cmd.message,
    state:
      cmd.status === "completed"
        ? "done"
        : cmd.status === "failed"
          ? "failed"
          : "in_progress",
    role: cmd.agentRole,
  }));

  const notificationItems: TraceItem[] = notifications
    .filter((n) => n.agentRole)
    .slice(-8)
    .map((n) => ({
      id: `ntf-${n.id}`,
      ts: n.timestamp,
      actor: n.agentRole ? getAgentMeta(n.agentRole).name : t("owner.system"),
      action: n.message.length > 46 ? `${n.message.slice(0, 46)}...` : n.message,
      state: n.type === "error" ? "failed" : n.type === "success" ? "done" : "info",
      role: n.agentRole,
    }));

  const workflowItems: TraceItem[] = (planView?.execution.nodes ?? []).map((node) => ({
    id: `plan-${node.step_id}`,
    ts: Date.now(),
    actor: node.assigned_role_label ?? t("owner.workflowEngine"),
    action: node.label,
    state:
      node.status === "completed" || node.status === "approved"
        ? "done"
        : node.status === "failed"
          ? "failed"
          : node.status === "in_progress" || node.status === "awaiting_approval"
            ? "in_progress"
            : "info",
    role: node.assigned_role_label as AgentRole | undefined,
  }));

  return [...workflowItems, ...commandItems, ...notificationItems]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 12);
}

function metricCard(label: string, value: string, accent: string) {
  return (
    <div className="rounded-lg border border-[#2A2A4A]/50 bg-[#0F0F23]/70 p-2.5">
      <div className="text-[9px] text-gray-400 uppercase tracking-wider">{label}</div>
      <div className="mt-1 text-[16px] font-bold" style={{ color: accent }}>{value}</div>
    </div>
  );
}

export function OwnerOpsPanel({
  agents,
  notifications,
  commandHistory,
  activePlan,
  planView,
  executionIntents,
  teamExecutionRunning,
  onFocusRole,
  onApproveStep,
  onDecideIntent,
  projectId,
  addNotification,
  className,
}: OwnerOpsPanelProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [decisionState, setDecisionState] = useState<Record<string, DecisionAction>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [decisionHistory, setDecisionHistory] = useState<OwnerDecisionRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [opsStatus, setOpsStatus] = useState<OwnerOpsStatusResponse | null>(null);

  const errorCount = agents.filter((a) => a.status === "error").length;
  const activeCount = agents.filter((a) => a.status === "working" || a.status === "walking" || a.status === "meeting").length;
  const completedCommands = commandHistory.filter((c) => c.status === "completed").length;
  const failedCommands = commandHistory.filter((c) => c.status === "failed").length;
  const totalScoredCommands = completedCommands + failedCommands;
  const delegationScore = totalScoredCommands === 0 ? 100 : Math.max(0, Math.round((completedCommands / totalScoredCommands) * 100));
  const opsReliability = Math.max(0, 100 - failedCommands * 8 - errorCount * 12);

  const decisions = useMemo(
    () =>
      buildDecisionQueue(
        notifications,
        activePlan,
        planView,
        executionIntents,
        errorCount,
        teamExecutionRunning,
        t,
      ),
    [notifications, activePlan, planView, executionIntents, errorCount, teamExecutionRunning, t],
  );
  const traces = useMemo(
    () => buildTraceItems(commandHistory, notifications, planView, t),
    [commandHistory, notifications, planView, t],
  );

  const unresolvedDecisions = decisions.filter((d) => !decisionState[d.id]).length;

  const loadDecisionHistory = useCallback(async () => {
    if (!projectId) {
      setDecisionHistory([]);
      return;
    }
    try {
      setHistoryLoading(true);
      const res = await listOwnerDecisions(projectId, 20);
      setDecisionHistory(res.items ?? []);
    } finally {
      setHistoryLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    void loadDecisionHistory();
  }, [open, loadDecisionHistory]);

  const loadOpsStatus = useCallback(async () => {
    if (!projectId) {
      setOpsStatus(null);
      return;
    }
    try {
      const status = await getOwnerOpsStatus(projectId);
      setOpsStatus(status);
    } catch {
      // keep last known status
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    void loadOpsStatus();
    const timer = setInterval(() => {
      void loadOpsStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [open, loadOpsStatus]);

  const applyDecision = async (item: DecisionItem, action: DecisionAction) => {
    setDecisionState((prev) => ({ ...prev, [item.id]: action }));

    try {
      setSubmittingId(item.id);
      if (item.intentId) {
        const decided = await onDecideIntent(item.intentId, action);
        if (!decided) return;
        addNotification({
          type:
            decided.status === "failed"
              ? "error"
              : action === "approved"
                ? "success"
                : action === "rejected"
                  ? "warning"
                  : "info",
          message:
            decided.status === "completed"
              ? t("owner.intentCompleted", { title: decided.title })
              : decided.status === "failed"
                ? t("owner.intentFailed", { title: decided.title })
                : t("owner.decisionSaved", { action: action.toUpperCase() }),
          agentRole: item.role,
        });
        return;
      }
      if (!projectId) {
        addNotification({ type: "error", message: t("owner.projectNotSelected") });
        return;
      }
      const result = await submitOwnerDecision(projectId, {
        item_id: item.id,
        title: item.title,
        source: item.source,
        action,
        target_type: item.targetType,
        target_id: item.targetId,
        detail: item.detail,
        workflow_id: item.planId,
      });
      if (action === "approved" && item.planId && item.stepId) {
        await onApproveStep(item.planId, item.stepId);
      }
      await loadDecisionHistory();
      addNotification({
        type: "success",
        message: result.applied_effect
          ? t("owner.decisionSavedWithEffect", { action: action.toUpperCase(), effect: result.applied_effect })
          : t("owner.decisionSaved", { action: action.toUpperCase() }),
        agentRole: item.role,
      });
    } catch (err) {
      addNotification({
        type: "error",
        message: err instanceof Error ? err.message : t("owner.decisionSaveFailed"),
        agentRole: item.role,
      });
    } finally {
      setSubmittingId(null);
    }
  };

  return (
    <div className={className}>
      <AnimatePresence initial={false}>
        {open ? (
          <motion.aside
            key="owner-open"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            data-testid="owner-ops-panel"
            className="w-[400px] max-[1450px]:w-[340px] max-md:w-[calc(100vw-1rem)] h-[min(72vh,640px)] rounded-2xl border border-[#2A2A4A] bg-[#111127]/92 shadow-2xl backdrop-blur-xl overflow-hidden"
          >
            <div className="h-1 bg-gradient-to-r from-[#7C3AED] via-[#00F3FF] to-[#F43F5E]" />
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#2A2A4A]/60">
              <div className="flex items-center gap-2.5">
                <div className="rounded-lg p-1.5 bg-[#7C3AED]/20 border border-[#7C3AED]/40">
                  <Crown className="w-4 h-4 text-[#A78BFA]" />
                </div>
                <div>
                  <div className="font-['Press_Start_2P'] text-[10px] text-cyan-300 tracking-wide">OWNER OPS</div>
                  <div className="text-[10px] text-gray-400">{t("owner.subtitle")}</div>
                </div>
              </div>
              <button
                onClick={() => setOpen(false)}
                data-testid="owner-ops-close-button"
                className="rounded-md p-1.5 text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
                aria-label={t("owner.closePanel")}
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
            </div>

            <div className="h-[calc(100%-62px)] overflow-auto p-3 space-y-3">
              <section className="rounded-xl border border-[#2A2A4A]/50 bg-[#0F0F23]/45 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-300 uppercase tracking-wider">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-300" />
                    {t("owner.decisionQueue")}
                  </div>
                  <span className="text-[10px] text-amber-300">{t("owner.pending", { count: unresolvedDecisions })}</span>
                </div>
                <div className="space-y-2">
                  {decisions.length === 0 && (
                    <div className="text-[10px] text-gray-500 px-1 py-2">{t("owner.noPending")}</div>
                  )}
                  {decisions.map((item) => {
                    const action = decisionState[item.id];
                    const disabled = submittingId === item.id;
                    return (
                      <div key={item.id} className="rounded-lg border border-[#2A2A4A]/50 bg-[#111126]/70 p-2">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-[11px] text-white/85 leading-tight">{item.title}</div>
                            <div className="mt-1 text-[9px] text-gray-400">{item.detail}</div>
                          </div>
                          <span className={`shrink-0 text-[8px] px-2 py-0.5 rounded-full border ${PRIORITY_STYLE[item.priority]}`}>
                            {item.priority.toUpperCase()}
                          </span>
                        </div>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-[9px] text-gray-500">{item.source}</span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => void applyDecision(item, "approved")}
                              className={`px-1.5 py-1 rounded-md text-[9px] border transition-colors ${
                                action === "approved"
                                  ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/40"
                                  : "bg-transparent text-gray-400 border-[#2A2A4A] hover:text-emerald-300 hover:border-emerald-500/30"
                              }`}
                              disabled={disabled}
                            >
                              {t("owner.approve")}
                            </button>
                            <button
                              onClick={() => void applyDecision(item, "hold")}
                              className={`px-1.5 py-1 rounded-md text-[9px] border transition-colors ${
                                action === "hold"
                                  ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                                  : "bg-transparent text-gray-400 border-[#2A2A4A] hover:text-amber-300 hover:border-amber-500/30"
                              }`}
                              disabled={disabled}
                            >
                              {t("owner.hold")}
                            </button>
                            <button
                              onClick={() => void applyDecision(item, "rejected")}
                              className={`px-1.5 py-1 rounded-md text-[9px] border transition-colors ${
                                action === "rejected"
                                  ? "bg-rose-500/20 text-rose-300 border-rose-500/40"
                                  : "bg-transparent text-gray-400 border-[#2A2A4A] hover:text-rose-300 hover:border-rose-500/30"
                              }`}
                              disabled={disabled}
                            >
                              {t("owner.reject")}
                            </button>
                          </div>
                        </div>
                        {item.role && (
                          <button
                            onClick={() => onFocusRole(item.role as AgentRole)}
                            className="mt-2 text-[9px] text-cyan-300 hover:text-cyan-200 transition-colors"
                          >
                            {t("owner.focusAgent")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="rounded-xl border border-[#2A2A4A]/50 bg-[#0F0F23]/45 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-300 uppercase tracking-wider">
                    <Users className="w-3.5 h-3.5 text-cyan-300" />
                    {t("owner.liveOps")}
                  </div>
                  <button
                    onClick={() => void loadOpsStatus()}
                    className="text-[9px] text-cyan-300 hover:text-cyan-200"
                  >
                    {t("dashboard.refresh")}
                  </button>
                </div>
                <div className="space-y-2">
                  <div className="text-[9px] text-gray-500">
                    {t("owner.decisions")}: {opsStatus?.decisions_count ?? 0}
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-400 mb-1">{t("owner.teamRuns")}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {opsStatus && Object.keys(opsStatus.team_runs ?? {}).length > 0 ? (
                        Object.entries(opsStatus.team_runs ?? {}).map(([id, state]) => (
                          <span
                            key={`team-${id}`}
                            className="px-2 py-0.5 rounded-full text-[9px] border border-[#2A2A4A] text-cyan-200 bg-[#111126]"
                          >
                            {id}:{state}
                          </span>
                        ))
                      ) : (
                        <span className="text-[9px] text-gray-500">{t("owner.noTeamRuns")}</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9px] text-gray-400 mb-1">{t("owner.incidents")}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {opsStatus && Object.keys(opsStatus.incidents ?? {}).length > 0 ? (
                        Object.entries(opsStatus.incidents ?? {}).map(([id, state]) => (
                          <span
                            key={`incident-${id}`}
                            className="px-2 py-0.5 rounded-full text-[9px] border border-[#2A2A4A] text-amber-200 bg-[#111126]"
                          >
                            {id}:{state}
                          </span>
                        ))
                      ) : (
                        <span className="text-[9px] text-gray-500">{t("owner.noIncidents")}</span>
                      )}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-[#2A2A4A]/50 bg-[#0F0F23]/45 p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5 text-[10px] text-gray-300 uppercase tracking-wider">
                    <Clock3 className="w-3.5 h-3.5 text-cyan-300" />
                    {t("owner.decisionHistory")}
                  </div>
                  <button
                    onClick={() => void loadDecisionHistory()}
                    className="text-[9px] text-cyan-300 hover:text-cyan-200"
                  >
                    {t("dashboard.refresh")}
                  </button>
                </div>
                <div className="space-y-1.5 max-h-40 overflow-auto pr-1">
                  {historyLoading && (
                    <div className="text-[10px] text-gray-500 px-1 py-2">{t("owner.loading")}</div>
                  )}
                  {!historyLoading && decisionHistory.length === 0 && (
                    <div className="text-[10px] text-gray-500 px-1 py-2">{t("owner.noHistory")}</div>
                  )}
                  {!historyLoading &&
                    decisionHistory
                      .slice()
                      .reverse()
                      .map((item) => (
                        <div key={`${item.item_id}-${item.decided_at}`} className="rounded-md border border-[#2A2A4A]/50 bg-[#111126]/70 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] text-white truncate">{item.title}</div>
                            <span className="text-[9px] text-gray-400">{item.action}</span>
                          </div>
                          <div className="mt-1 text-[9px] text-gray-500">
                            {new Date(item.decided_at).toLocaleString()} by {item.decided_by}
                          </div>
                          {item.applied_effect && (
                            <div className="mt-1 text-[9px] text-cyan-300">{item.applied_effect}</div>
                          )}
                        </div>
                      ))}
                </div>
              </section>

              <section className="rounded-xl border border-[#2A2A4A]/50 bg-[#0F0F23]/45 p-3">
                <div className="flex items-center gap-1.5 mb-2 text-[10px] text-gray-300 uppercase tracking-wider">
                  <BarChart3 className="w-3.5 h-3.5 text-cyan-300" />
                  {t("owner.opsMetrics")}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {metricCard(t("owner.activeAgents"), `${activeCount}/${agents.length}`, "#00F3FF")}
                  {metricCard(t("owner.errors"), `${errorCount}`, errorCount > 0 ? "#FB7185" : "#34D399")}
                  {metricCard(t("owner.completedCommands"), `${completedCommands}`, "#A78BFA")}
                  {metricCard(t("owner.workflowActive"), activePlan ? "1" : "0", "#F59E0B")}
                </div>
                <div className="mt-2.5 space-y-2">
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[9px] text-gray-400">
                      <span>{t("owner.delegationScore")}</span>
                      <span>{delegationScore}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#1A1A2E] overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-[#7C3AED] to-[#00F3FF]" style={{ width: `${delegationScore}%` }} />
                    </div>
                  </div>
                  <div>
                    <div className="mb-1 flex items-center justify-between text-[9px] text-gray-400">
                      <span>{t("owner.opsReliability")}</span>
                      <span>{opsReliability}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-[#1A1A2E] overflow-hidden">
                      <div className="h-full bg-gradient-to-r from-[#10B981] to-[#A3E635]" style={{ width: `${opsReliability}%` }} />
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-[#2A2A4A]/50 bg-[#0F0F23]/45 p-3">
                <div className="flex items-center gap-1.5 mb-2 text-[10px] text-gray-300 uppercase tracking-wider">
                  <GitBranch className="w-3.5 h-3.5 text-violet-300" />
                  {t("owner.executionTrace")}
                </div>
                <div className="space-y-1.5 max-h-56 overflow-auto pr-1">
                  {traces.length === 0 && (
                    <div className="text-[10px] text-gray-500 px-1 py-2">{t("owner.noTrace")}</div>
                  )}
                  {traces.map((trace) => (
                    <div key={trace.id} className="rounded-md border border-[#2A2A4A]/50 bg-[#111126]/70 p-2">
                      <div className="flex items-center justify-between">
                        <div className={`text-[10px] font-medium ${TRACE_STYLE[trace.state]}`}>{trace.actor}</div>
                        <div className="flex items-center gap-1 text-[9px] text-gray-500">
                          <Clock3 className="w-3 h-3" />
                          {formatTime(trace.ts)}
                        </div>
                      </div>
                      <div className="mt-1 text-[10px] text-gray-300">{trace.action}</div>
                      {trace.role && (
                        <button
                          onClick={() => onFocusRole(trace.role as AgentRole)}
                          className="mt-1 text-[9px] text-cyan-300 hover:text-cyan-200 transition-colors"
                        >
                          {t("owner.focus")}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </motion.aside>
        ) : (
          <motion.button
            key="owner-closed"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 16 }}
            onClick={() => setOpen(true)}
            data-testid="owner-ops-toggle"
            className="rounded-xl border border-[#2A2A4A]/70 bg-[#111127]/90 px-3 py-2 shadow-xl backdrop-blur-xl text-left"
          >
            <div className="flex items-center gap-2">
              <Crown className="w-4 h-4 text-[#A78BFA]" />
              <div>
                <div className="font-['Press_Start_2P'] text-[9px] text-cyan-300">OWNER OPS</div>
                <div className="mt-1 flex items-center gap-2 text-[9px] text-gray-400">
                  <span className="inline-flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3 text-amber-300" />
                    {unresolvedDecisions}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Users className="w-3 h-3 text-emerald-300" />
                    {activeCount}
                  </span>
                </div>
              </div>
            </div>
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
