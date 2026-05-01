import {
  WORKSPACE_MODE_BUILDER,
  WORKSPACE_MODE_CAMPAIGN,
  WORKSPACE_MODE_DESIGN,
  WORKSPACE_MODE_FINANCE,
  WORKSPACE_MODE_OPERATIONS,
  WORKSPACE_MODE_ORCHESTRATION,
  WORKSPACE_MODE_RESEARCH,
} from "../constants";
import type { Agent } from "../types/agent";
import type { AgentProgramId, AgentProgramSignals, AgentProgramSpec } from "../types/program";
import { buildAgentProgramSignals } from "./programSignals";

const PROGRAM_DEFINITIONS: Record<AgentProgramId, AgentProgramSpec> = {
  task_brief: {
    id: "task_brief",
    title_key: "workspace.program.taskBrief.title",
    description_key: "workspace.program.taskBrief.description",
    size: "full",
    accent_class: "border-cyan-400/30 bg-cyan-500/10",
  },
  plan_progress: {
    id: "plan_progress",
    title_key: "workspace.program.planProgress.title",
    description_key: "workspace.program.planProgress.description",
    size: "full",
    accent_class: "border-violet-400/30 bg-violet-500/10",
  },
  approval_queue: {
    id: "approval_queue",
    title_key: "workspace.program.approvalQueue.title",
    description_key: "workspace.program.approvalQueue.description",
    size: "half",
    accent_class: "border-amber-400/30 bg-amber-500/10",
  },
  handoff_feed: {
    id: "handoff_feed",
    title_key: "workspace.program.handoffFeed.title",
    description_key: "workspace.program.handoffFeed.description",
    size: "half",
    accent_class: "border-sky-400/30 bg-sky-500/10",
  },
  code_output: {
    id: "code_output",
    title_key: "workspace.program.codeOutput.title",
    description_key: "workspace.program.codeOutput.description",
    size: "full",
    accent_class: "border-blue-400/30 bg-blue-500/10",
  },
  file_changes: {
    id: "file_changes",
    title_key: "workspace.program.fileChanges.title",
    description_key: "workspace.program.fileChanges.description",
    size: "half",
    accent_class: "border-emerald-400/30 bg-emerald-500/10",
  },
  research_actions: {
    id: "research_actions",
    title_key: "workspace.program.researchActions.title",
    description_key: "workspace.program.researchActions.description",
    size: "half",
    accent_class: "border-teal-400/30 bg-teal-500/10",
  },
  content_pipeline: {
    id: "content_pipeline",
    title_key: "workspace.program.contentPipeline.title",
    description_key: "workspace.program.contentPipeline.description",
    size: "full",
    accent_class: "border-pink-400/30 bg-pink-500/10",
  },
  asset_refs: {
    id: "asset_refs",
    title_key: "workspace.program.assetRefs.title",
    description_key: "workspace.program.assetRefs.description",
    size: "half",
    accent_class: "border-orange-400/30 bg-orange-500/10",
  },
  ops_status: {
    id: "ops_status",
    title_key: "workspace.program.opsStatus.title",
    description_key: "workspace.program.opsStatus.description",
    size: "full",
    accent_class: "border-lime-400/30 bg-lime-500/10",
  },
  budget_watch: {
    id: "budget_watch",
    title_key: "workspace.program.budgetWatch.title",
    description_key: "workspace.program.budgetWatch.description",
    size: "half",
    accent_class: "border-yellow-400/30 bg-yellow-500/10",
  },
  activity_feed: {
    id: "activity_feed",
    title_key: "workspace.program.activityFeed.title",
    description_key: "workspace.program.activityFeed.description",
    size: "half",
    accent_class: "border-slate-400/30 bg-slate-500/10",
  },
};

const WORKSPACE_PROGRAMS: Record<string, AgentProgramId[]> = {
  [WORKSPACE_MODE_ORCHESTRATION]: [
    "task_brief",
    "plan_progress",
    "approval_queue",
    "handoff_feed",
    "activity_feed",
  ],
  [WORKSPACE_MODE_BUILDER]: [
    "task_brief",
    "code_output",
    "file_changes",
    "handoff_feed",
    "activity_feed",
  ],
  [WORKSPACE_MODE_RESEARCH]: [
    "task_brief",
    "research_actions",
    "handoff_feed",
    "activity_feed",
  ],
  [WORKSPACE_MODE_CAMPAIGN]: [
    "task_brief",
    "content_pipeline",
    "handoff_feed",
    "activity_feed",
  ],
  [WORKSPACE_MODE_DESIGN]: [
    "task_brief",
    "asset_refs",
    "file_changes",
    "handoff_feed",
  ],
  [WORKSPACE_MODE_OPERATIONS]: [
    "task_brief",
    "ops_status",
    "handoff_feed",
    "activity_feed",
  ],
  [WORKSPACE_MODE_FINANCE]: [
    "task_brief",
    "budget_watch",
    "handoff_feed",
    "activity_feed",
  ],
};

const WIDGET_PROGRAM_MAP: Record<string, AgentProgramId> = {
  approval_queue: "approval_queue",
  execution_graph: "plan_progress",
  timeline: "task_brief",
  code: "code_output",
  git: "file_changes",
  content: "content_pipeline",
  preview: "asset_refs",
  assets: "asset_refs",
  deploy_log: "ops_status",
  cost_breakdown: "budget_watch",
  alerts: "approval_queue",
  logs: "activity_feed",
};

function hasAny(signals: AgentProgramSignals, values: string[]): boolean {
  return values.some((value) => signals.role_tokens.includes(value));
}

function fallbackPrograms(signals: AgentProgramSignals): AgentProgramId[] {
  if (hasAny(signals, ["pm", "planner", "approval"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_ORCHESTRATION];
  }
  if (hasAny(signals, ["developer", "frontend", "backend", "code"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_BUILDER];
  }
  if (hasAny(signals, ["marketing", "marketer", "campaign", "content"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_CAMPAIGN];
  }
  if (hasAny(signals, ["research", "analysis", "search"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_RESEARCH];
  }
  if (hasAny(signals, ["design", "designer", "creative"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_DESIGN];
  }
  if (hasAny(signals, ["devops", "ops", "operations", "deploy"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_OPERATIONS];
  }
  if (hasAny(signals, ["finance", "cfo", "budget"])) {
    return WORKSPACE_PROGRAMS[WORKSPACE_MODE_FINANCE];
  }
  return ["task_brief", "handoff_feed", "activity_feed"];
}

export function buildAgentProgramSpecs(agent: Agent): AgentProgramSpec[] {
  const signals = buildAgentProgramSignals(agent);
  const defaults =
    WORKSPACE_PROGRAMS[signals.workspace_mode] ?? fallbackPrograms(signals);
  const widgetPrograms = signals.widget_ids
    .map((widgetId) => WIDGET_PROGRAM_MAP[widgetId])
    .filter((programId): programId is AgentProgramId => Boolean(programId));
  const ids = [...new Set([...defaults, ...widgetPrograms])];
  return ids.map((id) => PROGRAM_DEFINITIONS[id]);
}
