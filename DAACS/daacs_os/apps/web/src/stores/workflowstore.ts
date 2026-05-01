import { create } from "zustand";

import type { AgentEvent, AgentTeam, Notification } from "../types/agent";
import type {
  CreateExecutionIntentInput,
  ExecutionPlan,
  ExecutionIntent,
  ExecutionStep,
  RuntimeBundleResponse,
  RuntimeEvent,
} from "../types/runtime";
import * as api from "../services/agentApi";
import * as runtimeApi from "../services/runtimeApi";
import { buildStepCliRequest } from "../lib/stepPromptBuilder";
import {
  buildProjectCliSessionKey,
  isTauri,
  resolveProjectWorkspacePath,
  runCliCommand,
} from "../services/tauriCli";
import { useCliLogStore } from "./cliLogStore";
import { buildRuntimePlanView, type RuntimePlanView } from "../lib/runtimePlan";
import { executeApprovedIntent } from "../lib/executionConnectors";
import {
  attachHandoffsToInput,
  handoffToNextAgent,
  type HandoffMessage,
} from "../lib/agentHandoff";

let overnightPollTimer: ReturnType<typeof setInterval> | null = null;
const LOCAL_CLI_MAX_PLAN_ITERATIONS = 32;
const runtimeEndpointUnavailableProjects = new Set<string>();
const planEndpointUnavailableProjects = new Set<string>();
const executionIntentEndpointUnavailableProjects = new Set<string>();

function isApiStatus(error: unknown, status: number): boolean {
  if (typeof error !== "object" || error == null || !("status" in error)) {
    return false;
  }
  return (error as { status?: unknown }).status === status;
}

function stopOvernightPolling() {
  if (overnightPollTimer) {
    clearInterval(overnightPollTimer);
    overnightPollTimer = null;
  }
}

interface OvernightRunState {
  runId: string;
  status: string;
  goal: string;
  spentUsd: number;
  deadlineAt?: string | null;
}

function mergePlanRows(existing: ExecutionPlan[], incoming: ExecutionPlan[]): ExecutionPlan[] {
  const merged = new Map(existing.map((plan) => [plan.plan_id, plan]));
  for (const plan of incoming) {
    merged.set(plan.plan_id, plan);
  }
  return [...merged.values()].sort((left, right) => {
    const rightUpdated = Date.parse(right.updated_at || right.created_at || "");
    const leftUpdated = Date.parse(left.updated_at || left.created_at || "");
    return (Number.isFinite(rightUpdated) ? rightUpdated : 0) - (Number.isFinite(leftUpdated) ? leftUpdated : 0);
  });
}

function mergeIntentRows(existing: ExecutionIntent[], incoming: ExecutionIntent[]): ExecutionIntent[] {
  const merged = new Map(existing.map((intent) => [intent.intent_id, intent]));
  for (const intent of incoming) {
    merged.set(intent.intent_id, intent);
  }
  return [...merged.values()].sort((left, right) => {
    const rightTs = Date.parse(right.created_at || "");
    const leftTs = Date.parse(left.created_at || "");
    return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
  });
}

function buildLocalExecutionIntent(
  projectId: string | null,
  agentId: string,
  agentRole: string,
  input: CreateExecutionIntentInput,
): ExecutionIntent {
  const now = new Date().toISOString();
  return {
    intent_id: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    project_id: projectId ?? "local",
    runtime_id: null,
    created_by: "local_fallback",
    agent_id: agentId,
    agent_role: agentRole,
    kind: input.kind,
    title: input.title,
    description: input.description,
    target: input.target,
    connector_id: input.connector_id,
    payload: input.payload,
    status: "pending_approval",
    requires_approval: true,
    created_at: now,
    updated_at: now,
    approved_at: null,
    resolved_at: null,
    note: null,
    result_summary: null,
    result_payload: null,
  };
}

function derivePlanView(
  runtimeBundle: RuntimeBundleResponse | null,
  plans: ExecutionPlan[],
): RuntimePlanView | null {
  if (!runtimeBundle) return null;
  return buildRuntimePlanView(runtimeBundle, plans);
}

function isReviewStep(step: ExecutionStep): boolean {
  const text = `${step.label} ${step.description}`.toLowerCase();
  return text.includes("review") || text.includes("audit") || text.includes("qa");
}

function resolveRoleLabel(
  runtimeBundle: RuntimeBundleResponse,
  assignedTo: string | null,
  fallback: string,
): string {
  if (!assignedTo) return fallback;
  const instance = runtimeBundle.instances.find((candidate) => candidate.instance_id === assignedTo);
  if (!instance) return fallback;
  const blueprint = runtimeBundle.blueprints.find((candidate) => candidate.id === instance.blueprint_id);
  return blueprint?.role_label ?? fallback;
}

function summarizeStepResult(stdout: string, stderr: string): string {
  const primary = stdout.trim() || stderr.trim() || "(no result content)";
  return primary.length > 480 ? `${primary.slice(0, 477)}...` : primary;
}

async function emitOfficeAgentEvent(event: AgentEvent): Promise<void> {
  if (!isTauri()) return;
  try {
    const officeStore = await import("./officeStore");
    officeStore.useOfficeStore.getState().handleWsEvent(event);
  } catch {
    // best-effort local activity bridge
  }
}

interface WorkflowState {
  runtimeBundle: RuntimeBundleResponse | null;
  plans: ExecutionPlan[];
  activePlan: ExecutionPlan | null;
  planView: RuntimePlanView | null;
  executionIntents: ExecutionIntent[];
  stepHandoffs: Record<string, HandoffMessage[]>;
  overnightRun: OvernightRunState | null;
  overnightProjectId: string | null;
  realtimeConnected: boolean;
  teamExecutionRunning: boolean;
  reset: () => void;
  syncRuntimeBundle: (bundle: RuntimeBundleResponse | null) => void;
  refreshRuntimeContext: (projectId: string) => Promise<void>;
  refreshPlans: (projectId: string) => Promise<void>;
  refreshExecutionIntents: (projectId: string, agentId?: string) => Promise<void>;
  createExecutionPlan: (
    projectId: string,
    goal: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<ExecutionPlan | null>;
  executeExecutionPlan: (
    projectId: string,
    planId: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<ExecutionPlan | null>;
  approveExecutionStep: (
    projectId: string,
    planId: string,
    stepId: string,
    note?: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<ExecutionPlan | null>;
  createExecutionIntent: (
    projectId: string | null,
    agentId: string,
    agentRole: string,
    input: CreateExecutionIntentInput,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<ExecutionIntent>;
  decideExecutionIntent: (
    intentId: string,
    action: "approved" | "hold" | "rejected",
    note?: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<ExecutionIntent | null>;
  runTeamTask: (
    projectId: string,
    team: AgentTeam,
    instruction: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<void>;
  runTeamSwarm: (
    projectId: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<void>;
  startOvernight: (
    projectId: string,
    goal: string,
    notify?: (n: Omit<Notification, "id" | "timestamp">) => void,
  ) => Promise<void>;
  refreshOvernight: (
    projectId: string,
    runId: string,
  ) => Promise<void>;
  handleRuntimeEvent: (event: RuntimeEvent) => void;
  setRealtimeConnected: (connected: boolean, projectId?: string | null) => void;
}

export const useWorkflowStore = create<WorkflowState>((set, get) => ({
  runtimeBundle: null,
  plans: [],
  activePlan: null,
  planView: null,
  executionIntents: [],
  stepHandoffs: {},
  overnightRun: null,
  overnightProjectId: null,
  realtimeConnected: false,
  teamExecutionRunning: false,

  reset: () => {
    stopOvernightPolling();
    set({
      runtimeBundle: null,
      plans: [],
      activePlan: null,
      planView: null,
      executionIntents: [],
      stepHandoffs: {},
      overnightRun: null,
      overnightProjectId: null,
      realtimeConnected: false,
      teamExecutionRunning: false,
    });
  },

  syncRuntimeBundle: (bundle) =>
    set((state) => {
      const planView = derivePlanView(bundle, state.plans);
      return {
        runtimeBundle: bundle,
        activePlan: planView?.activePlan ?? null,
        planView,
      };
    }),

  refreshRuntimeContext: async (projectId) => {
    try {
      const runtimePromise = runtimeEndpointUnavailableProjects.has(projectId)
        ? Promise.resolve<RuntimeBundleResponse | null>(null)
        : runtimeApi.getProjectRuntimeBestEffort(projectId).catch((error) => {
            if (isApiStatus(error, 404)) {
              runtimeEndpointUnavailableProjects.add(projectId);
              return null;
            }
            throw error;
          });
      const intentsPromise = executionIntentEndpointUnavailableProjects.has(projectId)
        ? Promise.resolve<ExecutionIntent[]>([])
        : runtimeApi.listProjectExecutionIntents(projectId).catch((error) => {
            if (isApiStatus(error, 404)) {
              executionIntentEndpointUnavailableProjects.add(projectId);
              return [];
            }
            throw error;
          });

      const [bundle, intents] = await Promise.all([
        runtimePromise,
        intentsPromise,
      ]);
      set((state) => {
        const planView = derivePlanView(bundle, state.plans);
        return {
          runtimeBundle: bundle ?? state.runtimeBundle,
          activePlan: planView?.activePlan ?? null,
          planView,
          executionIntents: mergeIntentRows([], intents),
        };
      });
    } catch {
      // keep the last known runtime bundle
    }
  },

  refreshPlans: async (projectId) => {
    if (planEndpointUnavailableProjects.has(projectId)) {
      return;
    }
    try {
      const plans = await runtimeApi.listProjectPlans(projectId);
      set((state) => {
        const mergedPlans = mergePlanRows([], plans);
        const planView = derivePlanView(state.runtimeBundle, mergedPlans);
        return {
          plans: mergedPlans,
          activePlan: planView?.activePlan ?? null,
          planView,
        };
      });
    } catch (error) {
      if (isApiStatus(error, 404)) {
        planEndpointUnavailableProjects.add(projectId);
        return;
      }
      // keep the last known plans
    }
  },

  refreshExecutionIntents: async (projectId, agentId) => {
    if (executionIntentEndpointUnavailableProjects.has(projectId)) {
      return;
    }
    try {
      const intents = await runtimeApi.listProjectExecutionIntents(projectId, agentId);
      set(() => ({
        executionIntents: mergeIntentRows([], intents),
      }));
    } catch (error) {
      if (isApiStatus(error, 404)) {
        executionIntentEndpointUnavailableProjects.add(projectId);
        return;
      }
      // keep the last known execution intents
    }
  },

  createExecutionPlan: async (projectId, goal, notify) => {
    const trimmedGoal = goal.trim();
    if (!trimmedGoal) {
      notify?.({ type: "warning", message: "Goal is required." });
      return null;
    }

    try {
      const plan = await runtimeApi.createPlan(projectId, { goal: trimmedGoal });
      set((state) => {
        const plans = mergePlanRows(state.plans, [plan]);
        const planView = derivePlanView(state.runtimeBundle, plans);
        return {
          plans,
          activePlan: planView?.activePlan ?? null,
          planView,
        };
      });
      notify?.({ type: "success", message: `Plan created: ${plan.goal}` });
      return plan;
    } catch (error) {
      notify?.({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to create plan.",
      });
      return null;
    }
  },

  executeExecutionPlan: async (projectId, planId, notify) => {
    try {
      if (!isTauri()) {
        const plan = await runtimeApi.executePlan(projectId, planId, {
          execution_track: "server",
        });
        set((state) => {
          const plans = mergePlanRows(state.plans, [plan]);
          const planView = derivePlanView(state.runtimeBundle, plans);
          return {
            plans,
            activePlan: planView?.activePlan ?? null,
            planView,
          };
        });
        notify?.({ type: "success", message: `Execution started: ${plan.goal}` });
        return plan;
      }

      await get().refreshRuntimeContext(projectId);
      const workspace = await resolveProjectWorkspacePath(projectId);
      if (!workspace || workspace.trim() === "") {
        notify?.({ type: "warning", message: "Select a CLI workspace before executing the plan." });
        return null;
      }

      let runtimeBundle = get().runtimeBundle;
      if (!runtimeBundle) {
        runtimeBundle = await runtimeApi.getProjectRuntimeBestEffort(projectId);
        set((state) => {
          const planView = derivePlanView(runtimeBundle, state.plans);
          return {
            runtimeBundle,
            activePlan: planView?.activePlan ?? null,
            planView,
          };
        });
      }
      if (!runtimeBundle) {
        notify?.({ type: "error", message: "Runtime context is unavailable." });
        return null;
      }

      let plan = await runtimeApi.executePlan(projectId, planId, {
        execution_track: "local_cli",
      });
      set((state) => {
        const plans = mergePlanRows(state.plans, [plan]);
        const planView = derivePlanView(state.runtimeBundle, plans);
        return {
          plans,
          activePlan: planView?.activePlan ?? null,
          planView,
        };
      });
      notify?.({ type: "success", message: `Execution started: ${plan.goal}` });

      for (let iteration = 0; iteration < LOCAL_CLI_MAX_PLAN_ITERATIONS; iteration += 1) {
        const latestPlan = await runtimeApi.getProjectPlan(projectId, planId);
        set((state) => {
          const plans = mergePlanRows(state.plans, [latestPlan]);
          const planView = derivePlanView(state.runtimeBundle, plans);
          return {
            plans,
            activePlan: planView?.activePlan ?? null,
            planView,
          };
        });
        plan = latestPlan;

        if (plan.status === "completed") {
          notify?.({ type: "success", message: `Execution completed: ${plan.goal}` });
          return plan;
        }
        if (plan.status === "failed") {
          notify?.({ type: "error", message: `Execution failed: ${plan.goal}` });
          return plan;
        }

        const awaitingApproval = plan.steps.find((step) => step.status === "awaiting_approval");
        if (awaitingApproval) {
          notify?.({
            type: "warning",
            message: `Approval required: ${awaitingApproval.label}`,
          });
          return plan;
        }

        const readySteps = await runtimeApi.getReadySteps(projectId, planId);
        if (readySteps.length === 0) {
          return plan;
        }

        runtimeBundle = get().runtimeBundle ?? runtimeBundle;
        if (!runtimeBundle) {
          notify?.({ type: "error", message: "Runtime context is unavailable." });
          return plan;
        }
        const activeRuntimeBundle = runtimeBundle;

        for (const step of readySteps) {
          const pendingHandoffs = get().stepHandoffs[step.step_id] ?? [];
          const stepInput = attachHandoffsToInput(step.input, pendingHandoffs);
          const stepRequest: ExecutionStep = {
            ...step,
            input: stepInput,
          };
          const cliRequest = await buildStepCliRequest(activeRuntimeBundle, plan, stepRequest);
          await emitOfficeAgentEvent({
            type: "AGENT_STATUS_UPDATED",
            agent_role: cliRequest.officeAgentRole,
            timestamp: Date.now(),
            data: {
              status: isReviewStep(step) ? "reviewing" : "working",
              current_task: step.label,
              message: step.description || step.label,
              instance_id: step.assigned_to,
              task_id: step.step_id,
            },
          });
          const result = await runCliCommand(cliRequest.instruction, {
            systemPrompt: cliRequest.systemPrompt,
            cwd: workspace,
          });
          useCliLogStore.getState().addEntry({
            stdin: cliRequest.instruction,
            stdout: result?.stdout ?? "",
            stderr: result?.stderr ?? "",
            exit_code: result?.exit_code ?? -1,
            provider: result?.provider,
            label: `ExecutionPlan(${step.label})`,
            officeAgentRole: cliRequest.officeAgentRole,
          });

          const resultSummary = summarizeStepResult(
            result?.stdout ?? "",
            result?.stderr ?? "",
          );
          const output = {
            summary: step.label,
            stdout: result?.stdout ?? "",
            stderr: result?.stderr ?? "",
            exit_code: result?.exit_code ?? -1,
            provider: result?.provider ?? "unknown",
            cli_role: cliRequest.cliRole,
            handoff_count: pendingHandoffs.length,
          };
          const completionStatus =
            result != null && result.exit_code === 0 ? "completed" : "failed";
          if (completionStatus === "completed") {
            await emitOfficeAgentEvent({
              type: "AGENT_TASK_COMPLETED",
              agent_role: cliRequest.officeAgentRole,
              timestamp: Date.now(),
              data: {
                task_id: step.step_id,
                instruction: step.label,
                instance_id: step.assigned_to,
                result_summary: resultSummary,
                result: output,
              },
            });
          } else {
            await emitOfficeAgentEvent({
              type: "AGENT_STATUS_UPDATED",
              agent_role: cliRequest.officeAgentRole,
              timestamp: Date.now(),
              data: {
                status: "failed",
                current_task: step.label,
                message: resultSummary,
                instance_id: step.assigned_to,
                task_id: step.step_id,
              },
            });
            await emitOfficeAgentEvent({
              type: "AGENT_TASK_FAILED",
              agent_role: cliRequest.officeAgentRole,
              timestamp: Date.now(),
              data: {
                task_id: step.step_id,
                instruction: step.label,
                instance_id: step.assigned_to,
                error: resultSummary,
              },
            });
          }
          const updatedPlan = await runtimeApi.completeStep(projectId, planId, step.step_id, {
            input: stepInput,
            output,
            status: completionStatus,
          });
          set((state) => {
            const stepHandoffs = { ...state.stepHandoffs };
            delete stepHandoffs[step.step_id];
            const plans = mergePlanRows(state.plans, [updatedPlan]);
            const planView = derivePlanView(state.runtimeBundle, plans);
            return {
              plans,
              activePlan: planView?.activePlan ?? null,
              planView,
              stepHandoffs,
            };
          });
          plan = updatedPlan;

          if (completionStatus === "failed") {
            notify?.({
              type: "error",
              message: `Step failed: ${step.label}`,
            });
            return plan;
          }
          if (plan.status === "completed") {
            notify?.({ type: "success", message: `Execution completed: ${plan.goal}` });
            return plan;
          }
          if (plan.status === "failed") {
            notify?.({ type: "error", message: `Execution failed: ${plan.goal}` });
            return plan;
          }

          const nextReadySteps = await runtimeApi.getReadySteps(projectId, planId);
          if (nextReadySteps.length > 0) {
            const nextHandoffs: Record<string, HandoffMessage[]> = {};
            const outgoingHandoffs = nextReadySteps
              .filter((nextStep) => nextStep.step_id !== step.step_id)
              .map((nextStep) => {
                const handoff = handoffToNextAgent(
                  activeRuntimeBundle,
                  stepRequest,
                  nextStep,
                  resultSummary,
                );
                nextHandoffs[nextStep.step_id] = [
                  ...(get().stepHandoffs[nextStep.step_id] ?? []),
                  handoff,
                ];
                return { nextStep, handoff };
              });

            if (outgoingHandoffs.length > 0) {
              set((state) => ({
                stepHandoffs: {
                  ...state.stepHandoffs,
                  ...nextHandoffs,
                },
              }));
            }

            for (const { nextStep, handoff } of outgoingHandoffs) {
              const toRole = resolveRoleLabel(
                activeRuntimeBundle,
                nextStep.assigned_to,
                cliRequest.officeAgentRole,
              );
              const handoffSummary = `${step.label} -> ${nextStep.label}`;
              await emitOfficeAgentEvent({
                type: "AGENT_MESSAGE_SENT",
                agent_role: cliRequest.officeAgentRole,
                timestamp: Date.now(),
                data: {
                  from: cliRequest.officeAgentRole,
                  to: toRole,
                  content: handoffSummary,
                  instance_id: step.assigned_to,
                  to_instance_id: nextStep.assigned_to,
                  handoff_type: handoff.type,
                },
              });
              await emitOfficeAgentEvent({
                type: "AGENT_MESSAGE_RECEIVED",
                agent_role: toRole,
                timestamp: Date.now(),
                data: {
                  from: cliRequest.officeAgentRole,
                  to: toRole,
                  content: handoffSummary,
                  instance_id: nextStep.assigned_to,
                  from_instance_id: step.assigned_to,
                  handoff_type: handoff.type,
                },
              });
            }
          }
        }
      }

      notify?.({
        type: "warning",
        message: "Execution loop stopped after reaching the iteration safety limit.",
      });
      return plan;
    } catch (error) {
      notify?.({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to execute plan.",
      });
      return null;
    }
  },

  approveExecutionStep: async (projectId, planId, stepId, note, notify) => {
    try {
      const plan = await runtimeApi.approvePlanStep(projectId, planId, stepId, {
        ...(note ? { note } : {}),
        execution_track: isTauri() ? "local_cli" : "server",
      });
      set((state) => {
        const plans = mergePlanRows(state.plans, [plan]);
        const planView = derivePlanView(state.runtimeBundle, plans);
        return {
          plans,
          activePlan: planView?.activePlan ?? null,
          planView,
        };
      });
      notify?.({ type: "success", message: "Approval applied." });
      if (isTauri() && plan.status === "active") {
        return get().executeExecutionPlan(projectId, planId);
      }
      return plan;
    } catch (error) {
      notify?.({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to approve step.",
      });
      return null;
    }
  },

  createExecutionIntent: async (projectId, agentId, agentRole, input, notify) => {
    if (!projectId) {
      const intent = buildLocalExecutionIntent(projectId, agentId, agentRole, input);
      set((state) => ({
        executionIntents: mergeIntentRows(state.executionIntents, [intent]),
      }));
      return intent;
    }

    try {
      const intent = await runtimeApi.createProjectExecutionIntent(projectId, {
        agent_id: agentId,
        agent_role: agentRole,
        ...input,
        requires_approval: true,
      });
      set((state) => ({
        executionIntents: mergeIntentRows(state.executionIntents, [intent]),
      }));
      return intent;
    } catch (error) {
      notify?.({
        type: "error",
        message: error instanceof Error ? error.message : "Failed to create execution intent.",
      });
      const intent = buildLocalExecutionIntent(projectId, agentId, agentRole, input);
      set((state) => ({
        executionIntents: mergeIntentRows(state.executionIntents, [intent]),
      }));
      return intent;
    }
  },

  decideExecutionIntent: async (intentId, action, note, notify) => {
    const current = get().executionIntents.find((intent) => intent.intent_id === intentId);
    if (!current) {
      notify?.({ type: "error", message: "Execution intent not found." });
      return null;
    }

    const projectId = current.project_id;
    let next = current;

    if (projectId && projectId !== "local" && current.runtime_id != null) {
      try {
        next = await runtimeApi.decideProjectExecutionIntent(projectId, intentId, {
          action,
          ...(note ? { note } : {}),
          execution_track: isTauri() ? "local_cli" : "server",
        });
      } catch (error) {
        notify?.({
          type: "error",
          message: error instanceof Error ? error.message : "Failed to update execution intent.",
        });
        return null;
      }
    } else {
      const now = new Date().toISOString();
      next = {
        ...current,
        status:
          action === "approved"
            ? "approved"
            : action === "rejected"
              ? "rejected"
              : current.status,
        approved_at: action === "approved" ? now : current.approved_at ?? null,
        resolved_at: action === "rejected" ? now : null,
        note: note?.trim() || current.note || null,
        updated_at: now,
      };
    }

    set((state) => ({
      executionIntents: mergeIntentRows(state.executionIntents, [next]),
    }));

    if (action !== "approved") {
      return next;
    }

    if (!isTauri() || next.status !== "approved") {
      return next;
    }

    const executing: ExecutionIntent = {
      ...next,
      status: "executing",
    };
    set((state) => ({
      executionIntents: mergeIntentRows(state.executionIntents, [executing]),
    }));

    await emitOfficeAgentEvent({
      type: "AGENT_TASK_QUEUED",
      agent_role: current.agent_role,
      data: {
        task_id: current.intent_id,
        instruction: current.title,
      },
      timestamp: Date.now(),
    });
    await emitOfficeAgentEvent({
      type: "AGENT_STATUS_UPDATED",
      agent_role: current.agent_role,
      data: {
        status: "running",
        current_task: current.title,
        message: current.description,
      },
      timestamp: Date.now(),
    });

    try {
      const outcome = await executeApprovedIntent(executing);
      const localResolved: ExecutionIntent = {
        ...executing,
        status: outcome.status,
        resolved_at: new Date().toISOString(),
        result_summary: outcome.result_summary,
        result_payload: outcome.raw_output,
      };
      const resolved =
        projectId && projectId !== "local" && current.runtime_id != null
          ? await runtimeApi.completeProjectExecutionIntent(projectId, intentId, {
              status: outcome.status,
              result_summary: outcome.result_summary,
              result_payload: outcome.raw_output,
            })
          : localResolved;

      set((state) => ({
        executionIntents: mergeIntentRows(state.executionIntents, [resolved]),
      }));

      if (resolved.status === "completed") {
        await emitOfficeAgentEvent({
          type: "AGENT_TASK_COMPLETED",
          agent_role: current.agent_role,
          data: {
            task_id: current.intent_id,
            instruction: current.title,
            result_summary: resolved.result_summary ?? outcome.result_summary,
            result: {
              connector_id: current.connector_id,
              kind: current.kind,
              output: outcome.raw_output,
            },
          },
          timestamp: Date.now(),
        });
        await emitOfficeAgentEvent({
          type: "AGENT_STATUS_UPDATED",
          agent_role: current.agent_role,
          data: {
            status: "idle",
            current_task: current.title,
            message: resolved.result_summary ?? outcome.result_summary,
          },
          timestamp: Date.now(),
        });
      } else {
        const failureSummary = resolved.result_summary ?? outcome.result_summary;
        await emitOfficeAgentEvent({
          type: "AGENT_ERROR",
          agent_role: current.agent_role,
          data: {
            message: failureSummary,
            current_task: current.title,
          },
          timestamp: Date.now(),
        });
        await emitOfficeAgentEvent({
          type: "AGENT_STATUS_UPDATED",
          agent_role: current.agent_role,
          data: {
            status: "error",
            current_task: current.title,
            message: failureSummary,
          },
          timestamp: Date.now(),
        });
      }
      return resolved;
    } catch (error) {
      const failureSummary =
        error instanceof Error ? error.message : "connector execution failed";
      const localFailed: ExecutionIntent = {
        ...executing,
        status: "failed",
        resolved_at: new Date().toISOString(),
        result_summary: failureSummary,
      };
      const failed =
        projectId && projectId !== "local" && current.runtime_id != null
          ? await runtimeApi.completeProjectExecutionIntent(projectId, intentId, {
              status: "failed",
              result_summary: failureSummary,
            }).catch(() => localFailed)
          : localFailed;
      set((state) => ({
        executionIntents: mergeIntentRows(state.executionIntents, [failed]),
      }));
      await emitOfficeAgentEvent({
        type: "AGENT_ERROR",
        agent_role: current.agent_role,
        data: {
          message: failureSummary,
          current_task: current.title,
        },
        timestamp: Date.now(),
      });
      await emitOfficeAgentEvent({
        type: "AGENT_STATUS_UPDATED",
        agent_role: current.agent_role,
        data: {
          status: "error",
          current_task: current.title,
          message: failureSummary,
        },
        timestamp: Date.now(),
      });
      return failed;
    }
  },

  runTeamTask: async (projectId, team, instruction, notify) => {
    set({ teamExecutionRunning: true });
    if (isTauri()) {
      const teamLine = `[TEAM ${team}] ${instruction}`;
      const workspace = await resolveProjectWorkspacePath(projectId);
      const result = await runCliCommand(teamLine, {
        projectName: projectId,
        cwd: workspace,
        sessionKey: buildProjectCliSessionKey(projectId, ["team", team]),
      });
      if (result != null) {
        useCliLogStore.getState().addEntry({
          stdin: teamLine,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exit_code,
          provider: result.provider,
          label: `Team: ${team}`,
          officeAgentRole: "pm",
        });
      }
      set({ teamExecutionRunning: false });
      notify?.(
        result != null
          ? { type: "info", message: `Team task completed (exit ${result.exit_code})` }
          : { type: "error", message: "CLI execution failed" },
      );
      return;
    }
    try {
      await api.submitTeamTask(projectId, team, instruction);
      notify?.({ type: "info", message: `Team task started: ${team}` });
    } finally {
      set({ teamExecutionRunning: false });
    }
  },

  runTeamSwarm: async (projectId, notify) => {
    set({ teamExecutionRunning: true });
    if (isTauri()) {
      const workspace = await resolveProjectWorkspacePath(projectId);
      const result = await runCliCommand(
        "Parallel team run: execute implementation, review the result, and prepare launch copy",
        {
          projectName: projectId,
          cwd: workspace,
          sessionKey: buildProjectCliSessionKey(projectId, ["team-swarm", "pm"]),
        },
      );
      if (result != null) {
        useCliLogStore.getState().addEntry({
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exit_code,
          provider: result.provider,
          label: "Team swarm",
        });
      }
      set({ teamExecutionRunning: false });
      notify?.(
        result != null
          ? { type: "success", message: `Parallel run finished (exit ${result.exit_code})` }
          : { type: "error", message: "CLI execution failed" },
      );
      return;
    }
    try {
      await api.submitParallelTeamTasks(projectId, [
        { team: "development_team", instruction: "Execute the active implementation lane" },
        { team: "review_team", instruction: "Review the active runtime plan output" },
        { team: "marketing_team", instruction: "Prepare release summary for the current plan" },
      ]);
      notify?.({ type: "success", message: "Parallel team run started" });
    } finally {
      set({ teamExecutionRunning: false });
    }
  },

  startOvernight: async (projectId, goal, notify) => {
    if (isTauri()) {
      const runId = `overnight-${Date.now()}`;
      set({
        overnightRun: { runId, status: "running", goal, spentUsd: 0, deadlineAt: null },
        overnightProjectId: projectId,
      });
      const overnightIn = `Overnight run: ${goal}`;
      const workspace = await resolveProjectWorkspacePath(projectId);
      const result = await runCliCommand(overnightIn, {
        projectName: projectId,
        cwd: workspace,
        sessionKey: buildProjectCliSessionKey(projectId, ["overnight", "pm"]),
      });
      if (result != null) {
        useCliLogStore.getState().addEntry({
          stdin: overnightIn,
          stdout: result.stdout,
          stderr: result.stderr,
          exit_code: result.exit_code,
          provider: result.provider,
          label: "Overnight",
          officeAgentRole: "pm",
        });
      }
      set((state) => ({
        overnightRun:
          state.overnightRun?.runId === runId
            ? {
                ...state.overnightRun,
                status: result?.exit_code === 0 ? "completed" : "stopped_with_report",
                spentUsd: 0,
              }
            : state.overnightRun,
      }));
      notify?.({
        type: "success",
        message: result != null ? `Overnight run finished (exit ${result.exit_code})` : "Overnight run failed",
      });
      return;
    }
    try {
      const started = await api.startOvernightWorkflow(projectId, {
        goal,
        workflow_name: "feature_development",
        verification_profile: "default",
      });
      const status = await api.getOvernightWorkflowStatus(projectId, started.run_id);
      set({
        overnightRun: {
          runId: started.run_id,
          status: status.status,
          goal: status.goal,
          spentUsd: status.spent_usd,
          deadlineAt: status.deadline_at,
        },
        overnightProjectId: projectId,
      });
      const current = get();
      stopOvernightPolling();
      if (!current.realtimeConnected) {
        overnightPollTimer = setInterval(() => {
          void get().refreshOvernight(projectId, started.run_id);
        }, 10000);
      }
      notify?.({ type: "success", message: "Overnight run started" });
    } catch {
      notify?.({ type: "error", message: "Failed to start overnight run" });
    }
  },

  refreshOvernight: async (projectId, runId) => {
    try {
      const status = await api.getOvernightWorkflowStatus(projectId, runId);
      set({
        overnightRun: {
          runId,
          status: status.status,
          goal: status.goal,
          spentUsd: status.spent_usd,
          deadlineAt: status.deadline_at,
        },
      });
      if (["completed", "needs_human", "stopped_with_report", "error", "cancelled"].includes(status.status)) {
        stopOvernightPolling();
      }
    } catch {
      // best-effort polling path
    }
  },

  handleRuntimeEvent: (event) => {
    const runtimeProjectId = get().runtimeBundle?.runtime.project_id;
    if (runtimeProjectId && event.project_id !== runtimeProjectId) return;

    if (
      event.event_type === "plan_created" ||
      event.event_type === "step_status_changed" ||
      event.event_type === "approval_requested" ||
      event.event_type === "approval_granted" ||
      event.event_type === "plan_started" ||
      event.event_type === "plan_completed" ||
      event.event_type === "plan_failed"
    ) {
      void get().refreshPlans(event.project_id);
      return;
    }

    if (
      event.event_type === "execution_intent_created" ||
      event.event_type === "execution_intent_status_changed" ||
      event.event_type === "connector_execution_started" ||
      event.event_type === "connector_execution_completed" ||
      event.event_type === "connector_execution_failed"
    ) {
      void get().refreshExecutionIntents(event.project_id);
      return;
    }

    if (event.event_type === "runtime_updated") {
      void get().refreshRuntimeContext(event.project_id);
    }
  },

  setRealtimeConnected: (connected, projectId) => {
    set((state) => {
      const effectiveProjectId = projectId ?? state.overnightProjectId;
      if (connected) {
        stopOvernightPolling();
      } else if (
        effectiveProjectId &&
        state.overnightRun &&
        !["completed", "needs_human", "stopped_with_report", "error", "cancelled"].includes(state.overnightRun.status)
      ) {
        stopOvernightPolling();
        const runId = state.overnightRun.runId;
        overnightPollTimer = setInterval(() => {
          void get().refreshOvernight(effectiveProjectId, runId);
        }, 10000);
      }
      return {
        realtimeConnected: connected,
        overnightProjectId: effectiveProjectId ?? null,
      };
    });
  },
}));
