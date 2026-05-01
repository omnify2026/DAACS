import { useState, useEffect, useCallback, useRef } from "react";
import { useOfficeStore } from "../../stores/officeStore";
import { useAgentCommandStore } from "../../stores/agentCommandStore";
import {
  useSequencerDeferredCommandsStore,
  type SequencerDeferredAgentCommand,
} from "../../stores/sequencerDeferredCommandsStore";
import { useCollaborationStore } from "../../stores/collaborationStore";
import { useI18n } from "../../i18n";
import {
  isTauri,
  getCliWhich,
  getSavedCliProvider,
  getExecutionWorkspacePath,
  setSavedWorkspacePath,
  openWorkspaceDialog,
  openPathInFileManager,
  loadPromptingSequencerTodo,
  markPromptingSequencerItemDone,
  getPromptingSequencerChannelId,
  savePromptingSequencerTodo,
  clearPromptingSequencerChannel,
  runCliCommand,
  runWorkspaceCommand,
  extractPromptingSequencerCommands,
  prewarmOmniCli,
  getAgentsMetadataJson,
  buildRosterDelegationSystemPrompt,
  mapTauriCliRoleKeyToAgentPromptRole,
  type CliProvider,
  type SequencerTodoList,
  type SequencerItem,
  type RfiKnownAnswer,
  type RfiQuestion,
  getRfiSystemPrompt,
  buildRfiUserPrompt,
  parseRfiOutcome,
  parsePmTaskLists,
  prepareArtifactWorkspace,
  prepareAgentWorkspaces,
  stopActiveCliCommands,
  type RfiOutcome,
  type CliRunResult,
} from "../../services/tauriCli";
import {
  createCollaborationSession,
  startCollaborationRound,
  stopCollaborationSession,
} from "../../services/agentApi";
import { isAppApiStubEnabled } from "../../services/appApiStub";
import { useCliLogStore } from "../../stores/cliLogStore";
import { useMessengerStore } from "../../stores/messengerStore";
import { AgentRegistry } from "../../application/sequencer/AgentRegistry";
import {
  SequencerCoordinator,
  type AgentExecutionCompletion,
} from "../../application/sequencer/SequencerCoordinator";
import { isInvalidSequencerCliCommand as IsInvalidSequencerCliCommand } from "../../application/sequencer/HostCommandGuards";
import { SequencerParser } from "../../application/sequencer/SequencerParser";
import { TodoChannelRouter } from "../../application/sequencer/TodoChannelRouter";
import type { GoalPhase, RosterAgentMeta } from "../../application/sequencer/types";
import type {
  AgentEvent,
  AgentRole,
  CollaborationArtifact,
  CollaborationContribution,
} from "../../types/agent";

const GOAL_MEETING_LOG = "[GoalMeetingPanel]";
const MAX_AGENT_COMMAND_CASCADE = 48;
const ROUND_PROGRESS_LIMIT = 14;

type RoundProgressStatus = "running" | "completed" | "incomplete" | "failed";

type RoundProgressEntry = {
  id: string;
  label: string;
  status: RoundProgressStatus;
  detail?: string;
  startedAt?: number;
  updatedAt: number;
};

type RoundProgressEntryDraft = Omit<RoundProgressEntry, "updatedAt">;

type RoundOutcomeStatus = "running" | "completed" | "incomplete" | "failed" | "idle";

type RoundOutcomeSummary = {
  status: RoundOutcomeStatus;
  titleKey: string;
  detail: string;
  workspacePath: string | null;
  nextActions: string[];
};

type QualityGateRow = {
  id: string;
  labelKey: string;
  passed: boolean;
  detail: string;
};

type ArtifactQualitySummary = {
  score: number;
  labelKey: string;
  missingLabelKeys: string[];
  providerDelay: boolean;
};

type ReleaseReadinessStatus = "ready" | "needs-work" | "running" | "idle";

type ReleaseReadinessSummary = {
  status: ReleaseReadinessStatus;
  titleKey: string;
  detailKey: string;
  score: number | null;
  workspacePath: string | null;
  missingLabelKeys: string[];
  executionHints: string[];
};

type ArtifactTraceRow = {
  id: string;
  role: string;
  status: string;
  summary: string;
  team: string;
  workspace: string | null;
  files: string[];
  commands: string[];
  evidence: string[];
  timing: string[];
};

type ArtifactCompletionNotification = {
  type: "success" | "warning" | "error";
  message: string;
  action?: "open_goal_recovery";
  actionLabel?: string;
};

type LiveProviderEvidenceDomain = {
  name: string;
  prompt: string;
  artifact_path: string;
  final_status: string;
  quality_score: number;
  modification_request: string;
  commands: string[];
  evidence: string[];
  trace: Array<Record<string, unknown>>;
};

type LiveProviderEvidencePayload = {
  provider: string;
  workspace_path: string;
  domains: LiveProviderEvidenceDomain[];
};

function EmitLocalAgentEvent(
  type: string,
  agentRole: AgentRole,
  data: Record<string, unknown>,
): void {
  useOfficeStore.getState().handleWsEvent({
    type,
    agent_role: agentRole,
    data,
    timestamp: Date.now(),
  } satisfies AgentEvent);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function CombinedCliOutputText(InResult: { stdout?: string; stderr?: string } | null | undefined): string {
  if (InResult == null) return "";
  const a = (InResult.stdout ?? "").trim();
  const b = (InResult.stderr ?? "").trim();
  if (a !== "" && b !== "") return `${a}\n${b}`.trim();
  return a !== "" ? a : b;
}

function SequencerStatusLabel(t: (key: string) => string, status: string): string {
  switch (status) {
    case "done":
      return t("goal.sequencerStatus.done");
    case "in_progress":
      return t("goal.sequencerStatus.inProgress");
    case "pending":
      return t("goal.sequencerStatus.pending");
    default:
      return status.replace(/[_-]+/g, " ");
  }
}

function IsQuotaExhaustedErrorText(InText: string): boolean {
  const text = (InText ?? "").toLowerCase();
  if (text === "") return false;
  if (text.includes("exhausted your capacity")) return true;
  if (text.includes("quota will reset after")) return true;
  if (text.includes("rate limit")) return true;
  return false;
}

function ParseRetryDelayMs(InText: string): number | null {
  const text = (InText ?? "").toLowerCase();
  if (text === "") return null;
  const secHit = text.match(/reset after\s*(\d+)\s*s/);
  if (secHit?.[1] != null) {
    const sec = Number(secHit[1]);
    if (Number.isFinite(sec) && sec > 0) return sec * 1000 + 1500;
  }
  const msHit = text.match(/retrying after\s*(\d+)\s*ms/);
  if (msHit?.[1] != null) {
    const ms = Number(msHit[1]);
    if (Number.isFinite(ms) && ms > 0) return ms + 1000;
  }
  return null;
}

function DeduplicateNonEmptyLines(InValues: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of InValues) {
    const text = String(value ?? "").trim();
    if (text === "" || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function PrefixTaskLines(InPrefix: string, InItems: string[]): string[] {
  return InItems
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => `${InPrefix}: ${item}`);
}

function UpsertRoundContribution(
  InContributions: CollaborationContribution[],
  InContribution: CollaborationContribution,
): void {
  const targetTeam = String(InContribution.team ?? "").trim();
  const targetRole = String(InContribution.agent_role ?? "").trim();
  const existingIndex = InContributions.findIndex(
    (item) =>
      String(item.team ?? "").trim() === targetTeam &&
      String(item.agent_role ?? "").trim() === targetRole,
  );
  if (existingIndex >= 0) {
    InContributions[existingIndex] = InContribution;
    return;
  }
  InContributions.push(InContribution);
}

function BuildRfiContribution(InOutcome: RfiOutcome): CollaborationContribution {
  return {
    team: "planning_team",
    agent_role: "pm",
    status: "completed",
    summary: InOutcome.summary,
    open_questions: InOutcome.questions.map((q) => `${q.topic}: ${q.question}`),
    next_actions:
      InOutcome.questions.length > 0
        ? InOutcome.questions.map((q) => q.question)
        : ["Proceed to PM planning with the refined goal."],
    details: {
      refined_goal: InOutcome.refined_goal,
      assumptions: InOutcome.assumptions,
    },
  };
}

async function BuildPmPlanningContribution(
  InPlanText: string,
  InRefinedGoal: string,
): Promise<CollaborationContribution> {
  const parsed = await parsePmTaskLists(InPlanText);
  const deliverables = [
    ...PrefixTaskLines("Frontend", parsed.frontend),
    ...PrefixTaskLines("Backend", parsed.backend),
  ];
  const nextActions = DeduplicateNonEmptyLines([
    ...deliverables,
    ...PrefixTaskLines("Review", parsed.reviewer),
    ...PrefixTaskLines("Verify", parsed.verifier),
  ]).slice(0, 12);
  return {
    team: "planning_team",
    agent_role: "pm",
    status: "completed",
    summary:
      parsed.summary ||
      (parsed.unstructured !== "" ? parsed.unstructured.split(/\r?\n/)[0]?.trim() ?? "" : "") ||
      `Execution plan prepared for ${InRefinedGoal}.`,
    open_questions: [],
    next_actions: nextActions,
    details: {
      refined_goal: InRefinedGoal,
      role_assignment_notes: parsed.roleAssignmentNotes,
      deliverables,
      review_focus: parsed.reviewer,
      verification_focus: parsed.verifier,
      unstructured: parsed.unstructured,
    },
  };
}

function MapCascadeRoleToTeam(InRole: string): string {
  switch (String(InRole ?? "").trim().toLowerCase()) {
    case "pm":
      return "planning_team";
    case "reviewer":
    case "verifier":
      return "review_team";
    case "devops":
      return "operations_team";
    default:
      return "development_team";
  }
}

function BuildCascadeContributionSummary(InCompletion: AgentExecutionCompletion): string {
  const summary = String(InCompletion.summary ?? "").trim();
  if (summary !== "") return summary;
  switch (InCompletion.status) {
    case "needs_rework":
      return `${InCompletion.agentName} requested another repair cycle.`;
    case "blocked":
      return `${InCompletion.agentName} reported a blocked verification path.`;
    case "failed":
      return `${InCompletion.agentName} failed to complete the assigned work.`;
    default:
      return `${InCompletion.agentName} completed the assigned work.`;
  }
}

function BuildCascadeExecutionContribution(
  InCompletion: AgentExecutionCompletion,
): CollaborationContribution {
  const summary = BuildCascadeContributionSummary(InCompletion);
  const evidence = DeduplicateNonEmptyLines([
    InCompletion.verification,
    ...InCompletion.evidence,
    ...InCompletion.openRisks,
  ]).slice(0, 12);
  const nextActions = DeduplicateNonEmptyLines([
    ...InCompletion.reviewFindings,
    ...InCompletion.openRisks,
    InCompletion.status === "blocked" ? InCompletion.verification : undefined,
  ]).slice(0, 12);
  const openQuestions = DeduplicateNonEmptyLines([
    InCompletion.status === "failed" ||
    InCompletion.status === "blocked" ||
    InCompletion.status === "needs_rework"
      ? summary
      : "",
    ...InCompletion.openRisks,
  ]).slice(0, 8);
  const details: Record<string, unknown> = {
    files: InCompletion.changedFiles,
    evidence,
    command: InCompletion.command,
    summary,
  };
  if (InCompletion.officeRole === "reviewer") {
    details.review_focus = InCompletion.reviewFindings;
  } else if (InCompletion.officeRole === "verifier") {
    details.verification_focus = evidence;
    details.checks = evidence;
  } else if (InCompletion.officeRole === "devops") {
    details.ops_focus = nextActions;
    details.health_checks = evidence;
  } else {
    details.deliverables = InCompletion.changedFiles;
  }
  return {
    team: MapCascadeRoleToTeam(InCompletion.officeRole),
    agent_role: InCompletion.officeRole,
    status: InCompletion.status,
    summary,
    open_questions: openQuestions,
    next_actions: nextActions,
    details,
  };
}

function SelectPrimaryRoundIssue(
  InContributions: CollaborationContribution[],
): CollaborationContribution | null {
  const priority = ["failed", "blocked", "needs_rework"];
  for (const status of priority) {
    const matched = InContributions.find(
      (item) => String(item.status ?? "").trim().toLowerCase() === status,
    );
    if (matched != null) return matched;
  }
  return null;
}

function BuildCascadeRoundStatus(
  InCascadeOk: boolean,
  InContributions: CollaborationContribution[],
): string {
  const hasIncompleteSignal = InContributions.some((item) =>
    ["failed", "blocked", "needs_rework"].includes(
      String(item.status ?? "").trim().toLowerCase(),
    ),
  );
  if (InCascadeOk && !hasIncompleteSignal) return "completed";
  if (InContributions.length > 0) return "incomplete";
  return InCascadeOk ? "completed" : "failed";
}

function BuildCascadeRoundDecision(
  InCascadeOk: boolean,
  InContributions: CollaborationContribution[],
): string {
  const planningSummary =
    InContributions.find((item) => item.agent_role === "pm")?.summary?.trim() ?? "";
  const primaryIssue = SelectPrimaryRoundIssue(InContributions);
  const primaryIssueSummary = String(primaryIssue?.summary ?? "").trim();
  if (primaryIssueSummary !== "") {
    return planningSummary !== ""
      ? `${planningSummary} Follow-up required: ${primaryIssueSummary}`
      : primaryIssueSummary;
  }
  if (planningSummary !== "") return planningSummary;
  const latestExecutionSummary =
    InContributions
      .filter((item) => String(item.agent_role ?? "").trim().toLowerCase() !== "pm")
      .map((item) => String(item.summary ?? "").trim())
      .find((item) => item !== "") ?? "";
  if (latestExecutionSummary !== "") return latestExecutionSummary;
  return InCascadeOk
    ? "PromptingSequencer cascade completed."
    : "PromptingSequencer cascade requires follow-up before completion.";
}

function IsAbortRequestError(InError: unknown): boolean {
  if (InError instanceof DOMException) {
    return InError.name === "AbortError";
  }
  if (typeof InError !== "object" || InError == null) {
    return false;
  }
  return String((InError as { name?: unknown }).name ?? "") === "AbortError";
}

function BuildGoalTextWithRfiSupplement(
  InBase: string,
  InKnownAnswers: RfiKnownAnswer[],
  InAssumptions: string[] | null | undefined,
): string {
  const base = (InBase ?? "").trim();
  const chunks: string[] = [];
  const answers = (InKnownAnswers ?? []).filter(
    (a) => a != null && String(a.value ?? "").trim() !== "",
  );
  if (answers.length > 0) {
    const block = answers
      .map(
        (a) =>
          `- ${String(a.topic ?? "topic").trim()}: ${String(a.value ?? "").trim()}`,
      )
      .join("\n");
    chunks.push(`## RFI clarifications (user)\n${block}`);
  }
  const assumptions = (InAssumptions ?? [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => s !== "");
  if (assumptions.length > 0) {
    chunks.push(
      `## RFI assumptions\n${assumptions.map((s) => `- ${s}`).join("\n")}`,
    );
  }
  if (chunks.length === 0) return base;
  const extra = chunks.join("\n\n");
  if (base === "") return extra;
  return `${base}\n\n${extra}`;
}

function ReplayDeferredAgentCommands(InItems: SequencerDeferredAgentCommand[]): void {
  for (const item of InItems) {
    void useAgentCommandStore.getState().sendCommand(
      item.projectId,
      item.officeRole,
      item.agentId,
      item.message,
      useOfficeStore.getState().addNotification,
      { promptKey: item.promptKey ?? undefined, forceExecute: true },
    );
  }
}

function MergeChannelTodoList(
  InExisting: SequencerTodoList | null,
  InFreshPendingItems: SequencerItem[],
  InMainTaskName: string,
  InProjectName: string,
  InChannelId: string,
): SequencerTodoList {
  const prevDone = (InExisting?.items ?? []).filter((x) => x.status === "done");
  const maxNum = prevDone.length > 0 ? Math.max(...prevDone.map((x) => x.number)) : 0;
  const numberedNew = InFreshPendingItems.map((item, idx) => ({
    ...item,
    number: maxNum + idx + 1,
    status: "pending" as const,
  }));
  const sortedDone = [...prevDone].sort((a, b) => a.number - b.number);
  return {
    main_task_name: InMainTaskName,
    project_name: InProjectName,
    channel_id: InChannelId,
    items: [...numberedNew, ...sortedDone],
  };
}

function PhaseToI18nKey(InPhase: GoalPhase): string | null {
  const phase = (InPhase ?? "").trim();
  if (phase === "") return null;
  const suffix = phase.charAt(0).toUpperCase() + phase.slice(1);
  return `goal.phase${suffix}`;
}

function UpsertRoundProgressEntry(
  InEntries: RoundProgressEntry[],
  InEntry: RoundProgressEntry,
): RoundProgressEntry[] {
  const existingIndex = InEntries.findIndex((item) => item.id === InEntry.id);
  const existing = existingIndex >= 0 ? InEntries[existingIndex] : undefined;
  const nextEntry = {
    ...InEntry,
    startedAt: existing?.startedAt ?? InEntry.startedAt ?? InEntry.updatedAt,
  };
  const next = [...InEntries];
  if (existingIndex >= 0) {
    next[existingIndex] = nextEntry;
  } else {
    next.push(nextEntry);
  }
  return next.slice(-ROUND_PROGRESS_LIMIT);
}

function MapCompletionToRoundProgressStatus(
  InStatus: AgentExecutionCompletion["status"],
): RoundProgressStatus {
  switch (InStatus) {
    case "completed":
      return "completed";
    case "failed":
    case "blocked":
      return "failed";
    default:
      return "incomplete";
  }
}

function BuildRoundProgressEntryFromCompletion(
  InCompletion: AgentExecutionCompletion,
): RoundProgressEntryDraft {
  const changedCount = InCompletion.changedFiles.length;
  const detail = DeduplicateNonEmptyLines([
    InCompletion.summary,
    changedCount > 0 ? `${changedCount} file change${changedCount === 1 ? "" : "s"}` : undefined,
    InCompletion.verification,
  ])
    .slice(0, 2)
    .join(" · ");
  return {
    id: `agent:${InCompletion.agentId}:${InCompletion.mode}`,
    label: `${InCompletion.agentName} (${InCompletion.officeRole})`,
    status: MapCompletionToRoundProgressStatus(InCompletion.status),
    detail: detail === "" ? undefined : detail,
  };
}

function BuildRoundProgressEntryFromAgentMessage(InMessage: {
  agentId: string;
  agentName: string;
  officeRole: AgentRole;
  text: string;
  type: "start" | "done" | "error";
}): RoundProgressEntryDraft {
  return {
    id: `agent-message:${InMessage.agentId}`,
    label: `${InMessage.agentName} (${InMessage.officeRole})`,
    status:
      InMessage.type === "start"
        ? "running"
        : InMessage.type === "done"
          ? "completed"
          : "failed",
    detail: InMessage.text,
  };
}

function RoundProgressStatusClass(InStatus: RoundProgressStatus): string {
  switch (InStatus) {
    case "completed":
      return "border-emerald-400/40 bg-emerald-500/15 text-emerald-200";
    case "incomplete":
      return "border-amber-400/40 bg-amber-500/15 text-amber-200";
    case "failed":
      return "border-rose-400/40 bg-rose-500/15 text-rose-200";
    default:
      return "border-cyan-400/40 bg-cyan-500/15 text-cyan-200";
  }
}

function RoundProgressStatusLabel(
  t: (key: string) => string,
  InStatus: RoundProgressStatus,
): string {
  return t(`goal.roundProgressStatus.${InStatus}`);
}

function FormatRoundProgressTimestamp(InTimestamp: number): string {
  const date = new Date(InTimestamp);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function FormatRoundProgressElapsed(InStartedAt: number | undefined, InUpdatedAt: number): string {
  const startedAt = InStartedAt ?? InUpdatedAt;
  const elapsedMs = Math.max(0, InUpdatedAt - startedAt);
  if (elapsedMs < 1_000) return "<1s";
  const elapsedSeconds = Math.round(elapsedMs / 1_000);
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function RoundOutcomeStatusClass(InStatus: RoundOutcomeStatus): string {
  switch (InStatus) {
    case "completed":
      return "border-emerald-400/40 bg-emerald-500/10 text-emerald-100";
    case "incomplete":
      return "border-amber-400/40 bg-amber-500/10 text-amber-100";
    case "failed":
      return "border-rose-400/40 bg-rose-500/10 text-rose-100";
    case "running":
      return "border-cyan-400/40 bg-cyan-500/10 text-cyan-100";
    default:
      return "border-slate-500/40 bg-slate-500/10 text-slate-200";
  }
}

function NormalizeArtifactStatus(InStatus: unknown): RoundOutcomeStatus {
  const status = String(InStatus ?? "").trim().toLowerCase();
  if (status === "completed" || status === "success" || status === "passed") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "incomplete" || status === "needs_rework" || status === "blocked" || status === "partial") {
    return "incomplete";
  }
  return "idle";
}

function CleanPotentialAbsolutePath(InValue: string): string {
  return String(InValue ?? "")
    .trim()
    .replace(/[),.;\]}]+$/g, "")
    .replace(/^["'`]+|["'`]+$/g, "");
}

function JoinPathSegments(InRoot: string, InChild: string): string {
  return `${InRoot.replace(/[\\/]+$/g, "")}/${InChild.replace(/^[\\/]+/g, "")}`;
}

function ExtractAbsolutePathFromText(InText: string): string | null {
  const text = String(InText ?? "");
  const preferredLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /(?:workspace|output\s+path|artifact|산출물|워크스페이스|경로)/i.test(line) && /\/[^\s"'`]+/.test(line));
  const source = preferredLine ?? text;
  const match = source.match(/(?:^|[\s"'`:([{])(?<path>\/(?!\/)[^\s"'`<>]+)/);
  return match?.groups?.path != null ? CleanPotentialAbsolutePath(match.groups.path) : null;
}

function ExtractArtifactWorkspaceCandidatesFromText(InText: string): string[] {
  return [...String(InText ?? "").matchAll(/\bdaacs-artifact-[^\s"'`<>),.;\]}]+/g)]
    .map((match) => CleanPotentialAbsolutePath(match[0]))
    .filter((item) => item !== "");
}

function ExtractArtifactFiles(InArtifact: CollaborationArtifact | null | undefined): string[] {
  const files: string[] = [];
  for (const contribution of InArtifact?.contributions ?? []) {
    const details = contribution.details;
    if (details == null || typeof details !== "object") continue;
    const record = details as Record<string, unknown>;
    for (const key of ["files", "new_files"]) {
      const value = record[key];
      if (!Array.isArray(value)) continue;
      files.push(...value.map((item) => String(item ?? "").trim()).filter((item) => item !== ""));
    }
  }
  return [...new Set(files)].slice(0, 16);
}

function ExtractArtifactEvidence(InArtifact: CollaborationArtifact | null | undefined): string[] {
  const evidence: string[] = [];
  for (const contribution of InArtifact?.contributions ?? []) {
    const details = contribution.details;
    if (details == null || typeof details !== "object") continue;
    const record = details as Record<string, unknown>;
    for (const key of [
      "evidence",
      "checks",
      "ui_ux_evidence",
      "ux_evidence",
      "browser_evidence",
      "runtime_evidence",
      "visual_evidence",
      "verification_focus",
      "review_focus",
      "commands",
      "command",
      "host_commands",
      "executed_commands",
      "verification_commands",
    ]) {
      const value = record[key];
      if (Array.isArray(value)) {
        evidence.push(...value.map((item) => String(item ?? "").trim()).filter((item) => item !== ""));
      } else if (typeof value === "string" && value.trim() !== "") {
        evidence.push(value.trim());
      }
    }
  }
  return DeduplicateNonEmptyLines(evidence).slice(0, 12);
}

function ExtractArtifactRequirementCoverage(InArtifact: CollaborationArtifact | null | undefined): string[] {
  const coverage: string[] = [
    ...(InArtifact?.acceptance_criteria ?? []),
    ...(InArtifact?.deliverables ?? []),
  ].map((item) => String(item ?? "").trim());
  for (const contribution of InArtifact?.contributions ?? []) {
    const details = contribution.details;
    if (details == null || typeof details !== "object") continue;
    coverage.push(
      ...ExtractStringListFromDetails(details as Record<string, unknown>, [
        "requirement_coverage",
        "covered_requirements",
        "requirements",
        "user_requirements",
        "acceptance_criteria",
        "deliverables",
      ]),
    );
  }
  return DeduplicateNonEmptyLines(coverage).slice(0, 8);
}

function ExtractStringListFromDetails(
  InDetails: Record<string, unknown>,
  InKeys: string[],
): string[] {
  const values: string[] = [];
  for (const key of InKeys) {
    const value = InDetails[key];
    if (Array.isArray(value)) {
      values.push(...value.map((item) => String(item ?? "").trim()).filter((item) => item !== ""));
    } else if (typeof value === "string" && value.trim() !== "") {
      values.push(value.trim());
    }
  }
  return DeduplicateNonEmptyLines(values);
}

function ExtractFirstDetailValue(
  InDetails: Record<string, unknown>,
  InKeys: string[],
): unknown {
  for (const key of InKeys) {
    if (InDetails[key] != null) return InDetails[key];
  }
  return null;
}

function ExtractDetailNumber(
  InDetails: Record<string, unknown>,
  InKeys: string[],
): number | null {
  const value = ExtractFirstDetailValue(InDetails, InKeys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function FormatTraceDurationMs(InDurationMs: number): string {
  const durationMs = Math.max(0, InDurationMs);
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

function FormatTraceTimestampValue(InValue: unknown): string | null {
  if (typeof InValue === "number" && Number.isFinite(InValue)) {
    return InValue > 1_000_000_000_000 ? FormatRoundProgressTimestamp(InValue) : String(InValue);
  }
  if (typeof InValue === "string" && InValue.trim() !== "") return InValue.trim();
  return null;
}

function BuildContributionTimingEvidence(InDetails: Record<string, unknown>): string[] {
  const started = FormatTraceTimestampValue(
    ExtractFirstDetailValue(InDetails, ["started_at", "startedAt", "start_time", "startTime"]),
  );
  const completed = FormatTraceTimestampValue(
    ExtractFirstDetailValue(InDetails, ["completed_at", "completedAt", "finished_at", "finishedAt", "end_time", "endTime"]),
  );
  const explicitDuration = ExtractFirstDetailValue(InDetails, ["duration", "elapsed"]);
  const durationMs =
    ExtractDetailNumber(InDetails, ["duration_ms", "durationMs", "elapsed_ms", "elapsedMs", "runtime_ms", "runtimeMs"]) ??
    (() => {
      const startedMs = ExtractDetailNumber(InDetails, ["started_at", "startedAt", "start_ms", "startMs"]);
      const completedMs = ExtractDetailNumber(InDetails, ["completed_at", "completedAt", "finished_at", "finishedAt", "end_ms", "endMs"]);
      return startedMs != null && completedMs != null ? completedMs - startedMs : null;
    })();
  return DeduplicateNonEmptyLines([
    started != null ? `Start: ${started}` : null,
    completed != null ? `End: ${completed}` : null,
    durationMs != null
      ? `Duration: ${FormatTraceDurationMs(durationMs)}`
      : typeof explicitDuration === "string" && explicitDuration.trim() !== ""
        ? `Duration: ${explicitDuration.trim()}`
        : null,
  ]).slice(0, 3);
}

function ExtractContributionWorkspace(InContribution: CollaborationContribution): string | null {
  const details = InContribution.details;
  if (details != null && typeof details === "object") {
    const record = details as Record<string, unknown>;
    for (const key of ["workspace", "cwd", "artifact_workspace", "output_path", "path"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
  }
  const candidates = [
    String(InContribution.summary ?? ""),
    ...(InContribution.next_actions ?? []).map((item) => String(item ?? "")),
  ];
  for (const candidate of candidates) {
    const path = ExtractAbsolutePathFromText(candidate);
    if (path != null) return path;
  }
  return null;
}

function BuildArtifactTraceRows(InArtifact: CollaborationArtifact | null | undefined): ArtifactTraceRow[] {
  return (InArtifact?.contributions ?? []).slice(0, 8).map((contribution, index) => {
    const details =
      contribution.details != null && typeof contribution.details === "object"
        ? (contribution.details as Record<string, unknown>)
        : {};
    const role = String(contribution.agent_role ?? "agent").trim() || "agent";
    const status = String(contribution.status ?? "unknown").trim() || "unknown";
    return {
      id: `${role}-${index}`,
      role,
      status,
      summary: String(contribution.summary ?? "").trim(),
      team: String(contribution.team ?? "").trim(),
      workspace: ExtractContributionWorkspace(contribution),
      files: ExtractStringListFromDetails(details, ["files", "new_files"]).slice(0, 4),
      commands: ExtractStringListFromDetails(details, [
        "commands",
        "command",
        "host_commands",
        "executed_commands",
        "verification_commands",
      ]).slice(0, 3),
      evidence: ExtractStringListFromDetails(details, [
        "evidence",
        "checks",
        "review_focus",
        "verification_focus",
      ]).slice(0, 3),
      timing: BuildContributionTimingEvidence(details),
    };
  });
}

function HasContributionRole(
  InArtifact: CollaborationArtifact | null | undefined,
  InRole: string,
): boolean {
  const expected = InRole.trim().toLowerCase();
  return (InArtifact?.contributions ?? []).some(
    (item) => String(item.agent_role ?? "").trim().toLowerCase() === expected,
  );
}

function ExtractArtifactWorkspacePath(InArtifact: CollaborationArtifact | null | undefined): string | null {
  if (InArtifact == null) return null;
  const candidates: string[] = [
    String(InArtifact.artifact_workspace ?? ""),
    String(InArtifact.workspace_path ?? ""),
    String(InArtifact.output_path ?? ""),
    String(InArtifact.decision ?? ""),
    ...(InArtifact.next_actions ?? []).map((item) => String(item ?? "")),
  ];
  for (const contribution of InArtifact.contributions ?? []) {
    candidates.push(String(contribution.summary ?? ""));
    candidates.push(...(contribution.next_actions ?? []).map((item) => String(item ?? "")));
    const details = contribution.details;
    if (details == null || typeof details !== "object") continue;
    const record = details as Record<string, unknown>;
    for (const key of ["workspace", "cwd", "artifact_workspace", "workspace_path", "output_path", "path"]) {
      const value = record[key];
      if (typeof value === "string") candidates.push(value);
    }
  }
  const absolutePaths = candidates
    .map(ExtractAbsolutePathFromText)
    .filter((item): item is string => item != null && item !== "");
  const artifactNames = candidates.flatMap(ExtractArtifactWorkspaceCandidatesFromText);
  const inferredArtifactPaths = absolutePaths.flatMap((path) => {
    if (path.includes("daacs-artifact-")) return [];
    return artifactNames.map((name) => JoinPathSegments(path, name));
  });
  const preferred = [...absolutePaths, ...inferredArtifactPaths].sort(
    (a, b) => Number(b.includes("daacs-artifact-")) - Number(a.includes("daacs-artifact-")),
  );
  return preferred[0] ?? null;
}

function LooksLikeUserFacingWebArtifact(
  InArtifact: CollaborationArtifact | null | undefined,
  InFiles: string[],
): boolean {
  const text = `${ArtifactTextBlob(InArtifact)}\n${InFiles.join("\n")}`.toLowerCase();
  if (text === "") return false;
  return /(?:\bweb\b|\bwebsite\b|\bsite\b|\bfrontend\b|\bui\b|\bux\b|\breact\b|\bvite\b|\bbrowser\b|\bmobile\b|\bresponsive\b|\bdashboard\b|\bform\b|\bbutton\b|웹|화면|프론트|모바일|반응형|버튼|대시보드)/i.test(text);
}

function HasExecutableArtifactEvidence(InEvidence: string[]): boolean {
  return /\b(?:npm\s+run\s+build|npm\s+run\s+smoke|npm\s+test|build|smoke|test|playwright|browser|rendered|user-flow|user\s+flow|typecheck|lint)\b/i.test(
    InEvidence.join("\n"),
  );
}

function BuildAdvancedUxEvidenceSummary(
  InArtifact: CollaborationArtifact | null | undefined,
  InEvidence: string[],
): string[] {
  const text = `${ArtifactTextBlob(InArtifact)}\n${InEvidence.join("\n")}`.toLowerCase();
  const checks: Array<{ label: string; pattern: RegExp }> = [
    { label: "input/search/filter", pattern: /(?:input|form|search|filter|select|입력|검색|필터|선택)/i },
    { label: "search control", pattern: /(?:type=["']search|search\s+(?:input|field|box|query|control)|검색\s*(?:입력|창|필드|박스|제어)|query\s+input|searchterm)/i },
    { label: "favorite persistence", pattern: /(?:localstorage|favorite|favorites|saved\s+(?:items|list)|persist(?:ed|ence)?|즐겨찾기|저장\s*(?:목록|상태|유지))/i },
    { label: "instant recompute", pattern: /(?:instant|immediate|recompute|recalculate|live\s+(?:update|refresh)|on\s+change|usememo|즉시|바로\s*(?:계산|갱신|변경|정렬)|다시\s*계산)/i },
    { label: "empty/loading state", pattern: /(?:empty|no\s+(?:data|result|results|items?)|empty\s+result|loading|skeleton|blank|빈\s*(?:상태|결과)|결과\s*없|검색에\s*맞는|로딩|없을\s*때)/i },
    { label: "mobile/responsive", pattern: /(?:mobile|responsive|breakpoint|touch|모바일|반응형|터치)/i },
    { label: "error/validation", pattern: /(?:error|validation|invalid|required|에러|오류|검증|필수)/i },
    { label: "button interaction", pattern: /(?:button|click|hover|disabled|pressed|action\s+button|버튼|클릭|비활성|호버)/i },
    { label: "viewport/action fit", pattern: /(?:no\s+horizontal\s+(?:viewport\s+)?overflow|no\s+clipp(?:ing|ed)|off-viewport|within\s+viewport|actions?\s+(?:visible|reachable|fit)|primary\s+interactive\s+controls\s+(?:visible|reachable)|가로\s*넘침\s*없|잘림\s*없|화면\s*안|액션\s*(?:보임|도달|맞음))/i },
    { label: "visual polish", pattern: /(?:polish|layout|animation|motion|visual|a11y|accessibility|polished|\bdashboard\s+ui\b|\bui\s+(?:layout|screen|surface|render(?:ed)?|checks?|smoke)\b|레이아웃|애니메이션|시각|접근성|완성도|화면\s*(?:구성|레이아웃|완성도))/i },
  ];
  return checks.filter((check) => check.pattern.test(text)).map((check) => check.label);
}

function HasExplicitUxEvidence(InText: string, InPattern: RegExp): boolean {
  return InPattern.test(String(InText ?? ""));
}

function BuildMissingRequiredUserFacingUxEvidence(
  InArtifact: CollaborationArtifact | null | undefined,
  InEvidence: string[],
  InObservedLabels: string[],
): string[] {
  const text = `${ArtifactTextBlob(InArtifact)}\n${InEvidence.join("\n")}`.toLowerCase();
  const requirementText = ExtractArtifactRequirementCoverage(InArtifact).join("\n").toLowerCase();
  const evidenceText = InEvidence.join("\n").toLowerCase();
  const required = new Set<string>(["mobile/responsive", "visual polish"]);
  const missing = new Set<string>();
  if (/(?:input|form|search|filter|select|recommend|추천|입력|검색|필터|선택)/i.test(text)) {
    required.add("input/search/filter");
    required.add("button interaction");
  }
  if (/(?:search|검색)/i.test(requirementText)) {
    required.add("search control");
    if (
      !HasExplicitUxEvidence(
        evidenceText,
        /(?:type=["']search|search\s+(?:input|field|box|query|control)|검색\s*(?:입력|창|필드|박스|제어)|query\s+input|searchterm)/i,
      )
    ) {
      missing.add("search control");
    }
  }
  if (/(?:favorite|favorites|localstorage|즐겨찾기|저장\s*목록)/i.test(requirementText)) {
    required.add("favorite persistence");
  }
  if (/(?:instant|immediate|recompute|recalculate|live\s+(?:update|refresh)|즉시|바로\s*(?:계산|갱신)|다시\s*계산)/i.test(requirementText)) {
    required.add("instant recompute");
  }
  if (/(?:empty|no\s+(?:data|result|results|items?)|빈\s*(?:상태|결과)|결과\s*없)/i.test(text)) {
    required.add("empty/loading state");
  }
  if (/(?:error|validation|invalid|required|에러|오류|검증|필수|주의)/i.test(text)) {
    required.add("error/validation");
  }
  if (/(?:premium|product-grade|ai\s+template|프리미엄|고급\s*제품|제품급|ai\s*기본)/i.test(text)) {
    required.add("input/search/filter");
    required.add("empty/loading state");
    required.add("error/validation");
    required.add("button interaction");
  }
  const observed = new Set(InObservedLabels);
  for (const label of required) {
    if (!observed.has(label)) missing.add(label);
  }
  return [...missing];
}

function BuildPremiumProductEvidenceRows(
  InArtifact: CollaborationArtifact | null | undefined,
  InFiles: string[],
): QualityGateRow[] {
  if (!LooksLikeUserFacingWebArtifact(InArtifact, InFiles)) return [];
  const text = `${ArtifactTextBlob(InArtifact)}\n${ExtractArtifactEvidence(InArtifact).join("\n")}`.toLowerCase();
  const rows: QualityGateRow[] = [
    {
      id: "premium-task-clarity",
      labelKey: "goal.premiumReadiness.taskClarity",
      passed: /(?:primary\s+(?:task|action)|information|hierarchy|layout|navigation|section|card|dashboard|flow|레이아웃|정보|주요|흐름|카드)/i.test(text),
      detail: "clear primary task, hierarchy, and information grouping",
    },
    {
      id: "premium-interaction",
      labelKey: "goal.premiumReadiness.interaction",
      passed: /(?:button|click|hover|disabled|focus|keyboard|touch|drag|interaction|버튼|클릭|비활성|포커스|키보드|터치|상호작용)/i.test(text),
      detail: "button, keyboard, touch, disabled, or feedback behavior",
    },
    {
      id: "premium-states",
      labelKey: "goal.premiumReadiness.states",
      passed: /(?:empty|loading|error|validation|success|failure|no\s+(?:data|result|results|items?)|fallback|빈|로딩|오류|에러|검증|성공|실패)/i.test(text),
      detail: "empty, loading, error, validation, success, or fallback states",
    },
    {
      id: "premium-correction-path",
      labelKey: "goal.premiumReadiness.correctionPath",
      passed: /(?:correction|recover(?:y|able)?|preserve(?:d)?\s+(?:input|data)|validation\s+(?:near|next)|adjacent\s+error|field\s+error|retry|undo|edit\s+path|recover\s+without\s+restart|수정\s*경로|복구|입력\s*유지|필드\s*오류|다시\s*시도)/i.test(text),
      detail: "invalid input, correction, retry, undo, or preserved data recovery path",
    },
    {
      id: "premium-scanability",
      labelKey: "goal.premiumReadiness.scanability",
      passed: /(?:scan(?:nable|ability)|status\s+chip|aligned\s+values|section\s+label|reason\s+(?:chip|text)|selected\s+state|current\s+state|unavailable\s+state|table\/card|decision\s+data|스캔|상태\s*칩|선택\s*상태|현재\s*상태|불가\s*상태|이유\s*텍스트)/i.test(text),
      detail: "scannable decision data, selected/current state, status chips, or concise reasons",
    },
    {
      id: "premium-responsive",
      labelKey: "goal.premiumReadiness.responsive",
      passed: /(?:mobile|responsive|breakpoint|small\s+screen|touch|모바일|반응형|터치)/i.test(text),
      detail: "mobile, responsive, or touch evidence",
    },
    {
      id: "premium-layout-overflow",
      labelKey: "goal.premiumReadiness.layoutOverflow",
      passed: /(?:no\s+horizontal\s+(?:viewport\s+)?overflow|no\s+clipp(?:ing|ed)|not\s+clipped|within\s+viewport|off-viewport|actions?\s+(?:visible|reachable|fit)|primary\s+interactive\s+controls\s+(?:visible|reachable)|가로\s*넘침\s*없|잘림\s*없|화면\s*안|액션\s*(?:보임|도달|맞음))/i.test(text),
      detail: "no clipped primary actions or horizontal viewport overflow",
    },
    {
      id: "premium-accessibility",
      labelKey: "goal.premiumReadiness.accessibility",
      passed: /(?:accessibility|a11y|aria|keyboard|focus|contrast|label|접근성|명도|라벨)/i.test(text),
      detail: "accessibility, labels, focus, keyboard, or contrast evidence",
    },
    {
      id: "premium-visual-craft",
      labelKey: "goal.premiumReadiness.visualCraft",
      passed: /(?:visual\s+polish|polished|typography|spacing|color|motion|animation|density|brand|시각|완성도|타이포|간격|컬러|브랜드)/i.test(text),
      detail: "typography, spacing, color, motion, density, or brand polish",
    },
    {
      id: "premium-reference-archetype",
      labelKey: "goal.premiumReadiness.referenceArchetype",
      passed: /(?:reference_archetype|reference\s+archetype|archetype|command-center|dashboard|discovery-recommender|editor-creator|booking-commerce|game-hud|reference_quality_bar|quality\s+bar|레퍼런스\s*유형|디자인\s*유형)/i.test(text),
      detail: "one coherent reference archetype and visible quality bar",
    },
    {
      id: "premium-reference-source-level",
      labelKey: "goal.premiumReadiness.referenceSourceLevel",
      passed: /(?:source_level|source\s+level|official\s+(?:product|design-system|design\s+system)|pattern\s+library|polaris|atlassian|carbon|fluent|spectrum|material|apple|mobbin|figma|stripe|linear|raycast|레퍼런스\s*출처|디자인\s*시스템|패턴\s*라이브러리)/i.test(text),
      detail: "reference source level favors product/design-system or pattern-library structure",
    },
    {
      id: "premium-reference-adaptation",
      labelKey: "goal.premiumReadiness.referenceAdaptation",
      passed: /(?:references?|referenceboard|reference\s+board|inspiration|inspired|pattern|adapt(?:ed|ation)|apple|material|mobbin|nielsen|nngroup|nng|awwwards|webby|stripe|figma|raycast|linear|polaris|atlassian|carbon|fluent|spectrum|레퍼런스|참고|패턴|응용|적용)/i.test(text),
      detail: "reference patterns are adapted to the task instead of copied",
    },
  ];
  return rows;
}

function BuildArtifactRepairContextBlocks(InArtifact: CollaborationArtifact): {
  fileBlock: string;
  qualityBlock: string;
  requirementBlock: string;
  evidenceBlock: string;
  nextActionBlock: string;
} {
  const files = ExtractArtifactFiles(InArtifact);
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const qualityRows = BuildQualityGateRows(InArtifact, files, workspace);
  const qualitySummary = BuildArtifactQualitySummary(InArtifact, qualityRows);
  const requirementCoverage = ExtractArtifactRequirementCoverage(InArtifact);
  const evidence = ExtractArtifactEvidence(InArtifact);
  const nextActions = (InArtifact.next_actions ?? []).map((item) => String(item ?? "").trim()).filter((item) => item !== "");
  return {
    fileBlock: files.length > 0 ? files.map((file) => `- ${file}`).join("\n") : "- No files reported yet",
    qualityBlock:
      qualityRows.length > 0
        ? [
            qualitySummary != null ? `Quality score: ${qualitySummary.score}/100` : "",
            ...qualityRows.map((row) => `- ${row.passed ? "PASS" : "MISSING"} ${row.labelKey}: ${row.detail}`),
          ].filter((line) => line !== "").join("\n")
        : "- No quality gate evidence reported yet",
    requirementBlock:
      requirementCoverage.length > 0
        ? requirementCoverage.map((item) => `- ${item}`).join("\n")
        : "- No structured requirement coverage reported yet",
    evidenceBlock:
      evidence.length > 0
        ? evidence.map((item) => `- ${item}`).join("\n")
        : "- No review or verification evidence reported yet",
    nextActionBlock:
      nextActions.length > 0
        ? nextActions.map((item) => `- ${item}`).join("\n")
        : "- Preserve existing behavior while applying the requested change.",
  };
}

function BuildModifyExistingGoalText(
  InUserRequest: string,
  InArtifact: CollaborationArtifact,
): string {
  const decision = String(InArtifact.decision ?? "").trim();
  const status = String(InArtifact.status ?? "").trim();
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const repairContext = BuildArtifactRepairContextBlocks(InArtifact);
  return [
    "## MODIFY EXISTING ARTIFACT",
    "This is a modification request for the latest generated artifact. Do not start a fresh scaffold unless the user explicitly asks for a new artifact.",
    "Preserve the current artifact and change only what the user asks to change.",
    "Use previous missing quality gates, requirement coverage, and verifier evidence as the repair contract.",
    "",
    `Previous round: ${InArtifact.round_id}`,
    status !== "" ? `Previous status: ${status}` : "",
    workspace != null ? `Previous artifact workspace: ${workspace}` : "",
    decision !== "" ? `Previous decision: ${decision}` : "",
    "",
    "Previous artifact files:",
    repairContext.fileBlock,
    "",
    "Previous quality and verification context:",
    repairContext.qualityBlock,
    "",
    "Previous requirement coverage:",
    repairContext.requirementBlock,
    "",
    "Previous verifier/reviewer evidence:",
    repairContext.evidenceBlock,
    "",
    "Previous next actions:",
    repairContext.nextActionBlock,
    "",
    "## User modification request",
    InUserRequest.trim(),
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function BuildRetryLatestGoalText(InArtifact: CollaborationArtifact): string {
  const decision = String(InArtifact.decision ?? "").trim();
  const status = String(InArtifact.status ?? "").trim();
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const repairContext = BuildArtifactRepairContextBlocks(InArtifact);
  return [
    "## CONTINUE LATEST ARTIFACT",
    "The previous run did not reach a confident finished state. Continue or repair the latest artifact; do not start a fresh scaffold unless the existing workspace is unusable.",
    "Keep the scope narrow: use the previous files, missing quality gates, previous evidence, and open next actions as the repair contract.",
    "",
    `Previous round: ${InArtifact.round_id}`,
    status !== "" ? `Previous status: ${status}` : "",
    workspace != null ? `Previous artifact workspace: ${workspace}` : "",
    decision !== "" ? `Previous decision: ${decision}` : "",
    "",
    "Previous artifact files:",
    repairContext.fileBlock,
    "",
    "Previous quality and verification context:",
    repairContext.qualityBlock,
    "",
    "Previous requirement coverage:",
    repairContext.requirementBlock,
    "",
    "Previous verifier/reviewer evidence:",
    repairContext.evidenceBlock,
    "",
    "Previous next actions:",
    repairContext.nextActionBlock,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function BuildQualityRepairGoalText(
  InArtifact: CollaborationArtifact,
  InMissingRows: QualityGateRow[],
): string {
  const decision = String(InArtifact.decision ?? "").trim();
  const status = String(InArtifact.status ?? "").trim();
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const repairContext = BuildArtifactRepairContextBlocks(InArtifact);
  const missingBlock =
    InMissingRows.length > 0
      ? InMissingRows.map((row) => `- ${row.labelKey}: ${row.detail}`).join("\n")
      : "- No missing quality gates were reported, but re-check the artifact carefully.";
  return [
    "## REPAIR LATEST ARTIFACT QUALITY",
    "This is a scoped quality repair for the latest generated artifact. Do not start a fresh scaffold unless the existing workspace is unusable.",
    "Do not edit generated files manually outside this repair flow. Fix the artifact through the project engine and verifier loop.",
    "Repair only the missing quality gates below, then rerun executable verification.",
    "",
    `Previous round: ${InArtifact.round_id}`,
    status !== "" ? `Previous status: ${status}` : "",
    workspace != null ? `Previous artifact workspace: ${workspace}` : "",
    decision !== "" ? `Previous decision: ${decision}` : "",
    "",
    "Missing quality gates:",
    missingBlock,
    "",
    "Previous artifact files:",
    repairContext.fileBlock,
    "",
    "Previous quality and verification context:",
    repairContext.qualityBlock,
    "",
    "Previous requirement coverage:",
    repairContext.requirementBlock,
    "",
    "Previous verifier/reviewer evidence:",
    repairContext.evidenceBlock,
    "",
    "Previous next actions:",
    repairContext.nextActionBlock,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function BuildArtifactQaFeedbackGoalText(
  InFeedback: string,
  InArtifact: CollaborationArtifact,
): string {
  const decision = String(InArtifact.decision ?? "").trim();
  const status = String(InArtifact.status ?? "").trim();
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const repairContext = BuildArtifactRepairContextBlocks(InArtifact);
  return [
    "## REPAIR LATEST ARTIFACT FROM QA FEEDBACK",
    "This is a scoped QA repair for the latest generated artifact. Do not start a fresh scaffold unless the existing workspace is unusable.",
    "Do not edit generated files manually outside this repair flow. Fix the artifact through the project engine and verifier loop.",
    "Repair only the user-reported QA issue below, preserve existing behavior, then rerun executable verification.",
    "",
    `Previous round: ${InArtifact.round_id}`,
    status !== "" ? `Previous status: ${status}` : "",
    workspace != null ? `Previous artifact workspace: ${workspace}` : "",
    decision !== "" ? `Previous decision: ${decision}` : "",
    "",
    "## User QA feedback",
    InFeedback.trim(),
    "",
    "Previous artifact files:",
    repairContext.fileBlock,
    "",
    "Previous quality and verification context:",
    repairContext.qualityBlock,
    "",
    "Previous requirement coverage:",
    repairContext.requirementBlock,
    "",
    "Previous verifier/reviewer evidence:",
    repairContext.evidenceBlock,
    "",
    "Previous next actions:",
    repairContext.nextActionBlock,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function ArtifactTextBlob(InArtifact: CollaborationArtifact | null | undefined): string {
  if (InArtifact == null) return "";
  const parts: string[] = [
    String(InArtifact.status ?? ""),
    String(InArtifact.decision ?? ""),
    String(InArtifact.refined_goal ?? ""),
    String(InArtifact.project_fit_summary ?? ""),
    ...(InArtifact.acceptance_criteria ?? []).map((item) => String(item ?? "")),
    ...(InArtifact.deliverables ?? []).map((item) => String(item ?? "")),
    ...(InArtifact.open_questions ?? []).map((item) => String(item ?? "")),
    ...(InArtifact.next_actions ?? []).map((item) => String(item ?? "")),
  ];
  for (const contribution of InArtifact.contributions ?? []) {
    parts.push(String(contribution.status ?? ""));
    parts.push(String(contribution.summary ?? ""));
    parts.push(...(contribution.open_questions ?? []).map((item) => String(item ?? "")));
    parts.push(...(contribution.next_actions ?? []).map((item) => String(item ?? "")));
    if (contribution.details != null) {
      parts.push(JSON.stringify(contribution.details));
    }
  }
  return parts.join("\n");
}

function LooksLikePremiumArtifactRequest(
  InArtifact: CollaborationArtifact | null | undefined,
  InFiles: string[],
): boolean {
  if (!LooksLikeUserFacingWebArtifact(InArtifact, InFiles)) return false;
  const text = `${ArtifactTextBlob(InArtifact)}\n${ExtractArtifactRequirementCoverage(InArtifact).join("\n")}`.toLowerCase();
  return /(?:premium|product-grade|referenceboard|reference\s+board|designspec|design\s+spec|reference_archetype|reference\s+archetype|reference_quality_bar|quality\s+bar|프리미엄|고급\s*제품|제품급|레퍼런스\s*(?:보드|유형|품질)|디자인\s*스펙)/i.test(text);
}

function LooksLikeProviderDelayArtifact(InArtifact: CollaborationArtifact | null | undefined): boolean {
  const text = ArtifactTextBlob(InArtifact).toLowerCase();
  if (text === "") return false;
  return /\b(timeout|timed out|provider|quota|rate limit|capacity|exhausted|overloaded|network|retry)\b/.test(text);
}

function BuildArtifactQualitySummary(
  InArtifact: CollaborationArtifact | null,
  InRows: QualityGateRow[],
): ArtifactQualitySummary | null {
  if (InArtifact == null || InRows.length === 0) return null;
  const passed = InRows.filter((row) => row.passed).length;
  const evidence = ExtractArtifactEvidence(InArtifact).join("\n").toLowerCase();
  const status = NormalizeArtifactStatus(InArtifact.status);
  const providerDelay = LooksLikeProviderDelayArtifact(InArtifact);
  const hasExecutableEvidence = HasExecutableArtifactEvidence([evidence]);
  const hasArtifactTarget = ExtractArtifactFiles(InArtifact).length > 0 || ExtractArtifactWorkspacePath(InArtifact) != null;
  const hasNextAction = (InArtifact.next_actions ?? []).some((item) => String(item ?? "").trim() !== "");
  const hasMissingGateEvidence = InRows.some((row) => !row.passed);
  const rawScore = Math.max(
    0,
    Math.min(
      100,
      Math.round((passed / InRows.length) * 70) +
        (status === "completed" ? 10 : 0) +
        (hasExecutableEvidence ? 10 : 0) +
        (hasArtifactTarget ? 5 : 0) +
        (hasNextAction ? 5 : 0),
    ),
  );
  const statusScore = status === "completed" ? rawScore : Math.min(rawScore, 64);
  const score = hasMissingGateEvidence ? Math.min(statusScore, 84) : statusScore;
  return {
    score,
    labelKey:
      score >= 85
        ? "goal.qualityScore.high"
        : score >= 65
          ? "goal.qualityScore.medium"
          : "goal.qualityScore.low",
    missingLabelKeys: InRows.filter((row) => !row.passed).map((row) => row.labelKey),
    providerDelay,
  };
}

function BuildArtifactExecutionHints(
  InArtifact: CollaborationArtifact | null,
  InWorkspacePath: string | null,
): string[] {
  if (InArtifact == null || InWorkspacePath == null || InWorkspacePath.trim() === "") return [];
  const workspace = InWorkspacePath.trim();
  const files = ExtractArtifactFiles(InArtifact);
  const text = [
    ArtifactTextBlob(InArtifact),
    ExtractArtifactEvidence(InArtifact).join("\n"),
    files.join("\n"),
  ]
    .join("\n")
    .toLowerCase();
  const hasPackageJson = files.some((file) => /(?:^|\/)package\.json$/i.test(file)) || text.includes("package.json");
  if (!hasPackageJson) return [`${workspace}`];
  const commands: string[] = [];
  if (/\bnpm\s+run\s+smoke\b/.test(text)) commands.push(`cd ${workspace} && npm run smoke`);
  if (/\bnpm\s+run\s+build\b/.test(text)) commands.push(`cd ${workspace} && npm run build`);
  if (/\bnpm\s+test\b|\bnpm\s+run\s+test\b/.test(text)) commands.push(`cd ${workspace} && npm test`);
  if (commands.length === 0) commands.push(`cd ${workspace} && npm install && npm run build`);
  return [...new Set(commands)].slice(0, 2);
}

function BuildReleaseReadinessSummary(
  InRunning: boolean,
  InOutcome: RoundOutcomeSummary,
  InRows: QualityGateRow[],
  InQuality: ArtifactQualitySummary | null,
  InArtifact: CollaborationArtifact | null,
): ReleaseReadinessSummary {
  if (InRunning) {
    return {
      status: "running",
      titleKey: "goal.releaseReadiness.runningTitle",
      detailKey: "goal.releaseReadiness.runningDetail",
      score: null,
      workspacePath: null,
      missingLabelKeys: [],
      executionHints: [],
    };
  }
  if (InArtifact == null) {
    return {
      status: "idle",
      titleKey: "goal.releaseReadiness.idleTitle",
      detailKey: "goal.releaseReadiness.idleDetail",
      score: null,
      workspacePath: null,
      missingLabelKeys: [],
      executionHints: [],
    };
  }
  const missingLabelKeys = InQuality?.missingLabelKeys ?? InRows.filter((row) => !row.passed).map((row) => row.labelKey);
  const score = InQuality?.score ?? null;
  const isReady =
    InOutcome.status === "completed" &&
    missingLabelKeys.length === 0 &&
    score != null &&
    score >= 85;
  return {
    status: isReady ? "ready" : "needs-work",
    titleKey: isReady ? "goal.releaseReadiness.readyTitle" : "goal.releaseReadiness.needsWorkTitle",
    detailKey: isReady ? "goal.releaseReadiness.readyDetail" : "goal.releaseReadiness.needsWorkDetail",
    score,
    workspacePath: InOutcome.workspacePath,
    missingLabelKeys,
    executionHints: BuildArtifactExecutionHints(InArtifact, InOutcome.workspacePath),
  };
}

function ExtractArtifactDomainName(InArtifact: CollaborationArtifact, InIndex: number): string {
  const explicitType = String(InArtifact.artifact_type ?? "").trim();
  if (explicitType !== "") return explicitType;
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const workspaceName = workspace?.split("/").filter(Boolean).at(-1)?.trim();
  if (workspaceName != null && workspaceName !== "") return workspaceName;
  const roundId = String(InArtifact.round_id ?? "").trim();
  return roundId !== "" ? roundId : `artifact-${InIndex + 1}`;
}

function ExtractArtifactModificationRequest(InArtifact: CollaborationArtifact): string {
  const candidates = [
    String(InArtifact.refined_goal ?? ""),
    String(InArtifact.decision ?? ""),
    ...(InArtifact.next_actions ?? []).map((item) => String(item ?? "")),
    ...ExtractArtifactEvidence(InArtifact),
  ];
  const match = candidates.find((item) =>
    /(?:\bmodify\b|\brepair\b|\bfix\b|\bupdate\b|\bchange\b|\bimprove\b|\badd\b|\bremove\b|수정|고쳐|변경|개선|추가|검수|repair|qa\s+feedback)/i.test(
      item,
    ),
  );
  return match?.trim() ?? "";
}

function BuildLiveProviderEvidencePayload(
  InProvider: string | null | undefined,
  InWorkspacePath: string | null,
  InArtifacts: CollaborationArtifact[],
  InSharedGoal: string | null | undefined,
): LiveProviderEvidencePayload {
  const workspacePath = InWorkspacePath?.trim() ?? "";
  const provider = String(InProvider ?? "").trim() || "unknown";
  const domains: LiveProviderEvidenceDomain[] = InArtifacts.map((artifact, index) => {
    const artifactPath = ExtractArtifactWorkspacePath(artifact) ?? workspacePath;
    const files = ExtractArtifactFiles(artifact);
    const rows = BuildQualityGateRows(artifact, files, artifactPath);
    const quality = BuildArtifactQualitySummary(artifact, rows);
    const traceRows = BuildArtifactTraceRows(artifact);
    const commands = DeduplicateNonEmptyLines([
      ...traceRows.flatMap((row) => row.commands),
      ...BuildArtifactExecutionHints(artifact, artifactPath),
    ]);
    const evidence = DeduplicateNonEmptyLines([
      ...ExtractArtifactEvidence(artifact),
      ...traceRows.flatMap((row) => row.evidence),
    ]);
    const planningEvidence = String(InSharedGoal ?? artifact.refined_goal ?? "").trim();
    return {
      name: ExtractArtifactDomainName(artifact, index),
      prompt: String(artifact.refined_goal ?? InSharedGoal ?? artifact.decision ?? "").trim(),
      artifact_path: artifactPath,
      final_status: String(artifact.status ?? "").trim(),
      quality_score: quality?.score ?? 0,
      modification_request: ExtractArtifactModificationRequest(artifact),
      commands,
      evidence,
      trace: [
        {
          role: "pm",
          status: "completed",
          team: "planning",
          workspace: artifactPath,
          files: [],
          commands: [],
          evidence: planningEvidence !== "" ? [planningEvidence] : [],
          timing: [],
        },
        ...traceRows.map((row) => ({
          role: row.role,
          status: row.status,
          team: row.team,
          workspace: row.workspace,
          files: row.files,
          commands: row.commands,
          evidence: row.evidence,
          timing: row.timing,
        })),
      ],
    };
  }).filter((domain) => domain.artifact_path.trim() !== "");

  return {
    provider,
    workspace_path: workspacePath,
    domains,
  };
}

function BuildLiveProviderEvidenceJson(InPayload: LiveProviderEvidencePayload): string {
  return JSON.stringify(InPayload, null, 2);
}

function HasLiveProviderExecutableEvidence(InDomain: LiveProviderEvidenceDomain): boolean {
  const text = [...InDomain.commands, ...InDomain.evidence].join("\n").toLowerCase();
  return /\bnpm\s+run\s+(build|smoke|test|test:regression|lint)\b|\bnpm\s+test\b|\bplaywright\b|\bcargo\s+(?:test|check)\b/.test(text);
}

function HasLiveProviderRoleEvidence(InDomain: LiveProviderEvidenceDomain): boolean {
  const text = JSON.stringify(InDomain.trace ?? []).toLowerCase();
  const hasCoreRoles = ["pm", "reviewer", "verifier"].every((role) => text.includes(role));
  const hasImplementationRole = /\b(frontend|backend|developer|builder|implementation|engineer|designer|dev|ui_builder)\b/.test(text);
  return hasCoreRoles && hasImplementationRole;
}

function IsLiveProviderEvidenceDomainCandidateReady(InDomain: LiveProviderEvidenceDomain): boolean {
  const status = String(InDomain.final_status ?? "").toLowerCase();
  return (
    InDomain.artifact_path.trim().startsWith("/") &&
    /\b(ready|completed|verified|passed|pass)\b/.test(status) &&
    InDomain.quality_score >= 80 &&
    InDomain.modification_request.trim() !== "" &&
    InDomain.commands.length > 0 &&
    InDomain.evidence.length > 0 &&
    HasLiveProviderExecutableEvidence(InDomain) &&
    HasLiveProviderRoleEvidence(InDomain)
  );
}

function BuildArtifactCompletionNotification(
  t: (key: string) => string,
  InArtifact: CollaborationArtifact | null | undefined,
  InRoundStatus: string | null | undefined,
): ArtifactCompletionNotification {
  const roundStatus = NormalizeArtifactStatus(InRoundStatus);
  const artifactStatus = NormalizeArtifactStatus(InArtifact?.status);
  const files = ExtractArtifactFiles(InArtifact);
  const workspace = ExtractArtifactWorkspacePath(InArtifact);
  const rows = BuildQualityGateRows(InArtifact ?? null, files, workspace);
  const quality = BuildArtifactQualitySummary(InArtifact ?? null, rows);
  const missingLabelKeys =
    quality?.missingLabelKeys ?? rows.filter((row) => !row.passed).map((row) => row.labelKey);
  const workspaceSuffix = workspace != null ? ` — ${t("goal.latestOutcomePath")}: ${workspace}` : "";
  const missingSuffix =
    missingLabelKeys.length > 0
      ? `: ${missingLabelKeys
          .slice(0, 3)
          .map((key) => t(key))
          .join(" · ")}`
      : "";

  const hasReadyArtifact =
    artifactStatus === "completed" && missingLabelKeys.length === 0 && quality != null && quality.score >= 85;
  const hasCompletedButNeedsRepair =
    artifactStatus === "completed" || roundStatus === "completed";

  if (hasReadyArtifact) {
    return {
      type: "success",
      message: `${t("goal.completionReadyToast")}${workspaceSuffix}`,
    };
  }

  if (hasCompletedButNeedsRepair) {
    return {
      type: "warning",
      message: `${t("goal.completionNeedsRepairToast")}${missingSuffix}${workspaceSuffix}`,
      action: "open_goal_recovery",
      actionLabel: t("goal.openContinuePanel"),
    };
  }

  if (roundStatus === "failed" || artifactStatus === "failed") {
    return { type: "error", message: `${t("goal.failed")} — ${t("goal.checkSharedBoard")}` };
  }

  return {
    type: "warning",
    message: `${t("goal.completionPartialToast")}${missingLabelKeys.length > 0 ? missingSuffix : `: ${t("goal.qualityGate.needsReview")}`}${workspaceSuffix}`,
    action: "open_goal_recovery",
    actionLabel: t("goal.openContinuePanel"),
  };
}

function BuildRoundOutcomeSummary(
  t: (key: string) => string,
  InRunning: boolean,
  InRoundProgress: RoundProgressEntry[],
  InArtifact: CollaborationArtifact | null,
): RoundOutcomeSummary {
  if (InRunning) {
    const active = [...InRoundProgress].reverse().find((item) => item.status === "running");
    return {
      status: "running",
      titleKey: "goal.outcome.runningTitle",
      detail: active?.label ?? t("goal.roundProgressLive"),
      workspacePath: null,
      nextActions: [],
    };
  }
  const finalProgress = [...InRoundProgress].reverse().find((item) => item.id === "final");
  const artifactStatus = NormalizeArtifactStatus(InArtifact?.status);
  const status = artifactStatus !== "idle" ? artifactStatus : (finalProgress?.status ?? "idle");
  const titleKey =
    status === "completed"
      ? "goal.outcome.completedTitle"
      : status === "incomplete"
        ? "goal.outcome.incompleteTitle"
        : status === "failed"
          ? "goal.outcome.failedTitle"
          : "goal.outcome.idleTitle";
  const decision = String(InArtifact?.decision ?? "").trim();
  return {
    status,
    titleKey,
    detail: decision || finalProgress?.detail || t("goal.outcome.idleDetail"),
    workspacePath: ExtractArtifactWorkspacePath(InArtifact),
    nextActions: (InArtifact?.next_actions ?? []).map((item) => String(item ?? "").trim()).filter((item) => item !== ""),
  };
}

function BuildQualityGateRows(
  InArtifact: CollaborationArtifact | null,
  InFiles: string[],
  InWorkspacePath: string | null,
): QualityGateRow[] {
  if (InArtifact == null) return [];
  const evidence = ExtractArtifactEvidence(InArtifact);
  const nextActions = (InArtifact.next_actions ?? []).map((item) => String(item ?? "").trim()).filter((item) => item !== "");
  const isUserFacingWebArtifact = LooksLikeUserFacingWebArtifact(InArtifact, InFiles);
  const hasVerifierContribution = HasContributionRole(InArtifact, "verifier");
  const hasExecutableEvidence = HasExecutableArtifactEvidence(evidence);
  const requirementCoverage = ExtractArtifactRequirementCoverage(InArtifact);
  const rows: QualityGateRow[] = [
    {
      id: "artifact",
      labelKey: "goal.qualityGate.artifact",
      passed: InFiles.length > 0 || InWorkspacePath != null,
      detail: InFiles.length > 0 ? `${InFiles.length} file${InFiles.length === 1 ? "" : "s"}` : (InWorkspacePath ?? ""),
    },
    {
      id: "requirements",
      labelKey: "goal.qualityGate.requirements",
      passed: requirementCoverage.length > 0,
      detail: requirementCoverage[0] ?? "requirement coverage missing",
    },
    {
      id: "review",
      labelKey: "goal.qualityGate.review",
      passed: HasContributionRole(InArtifact, "reviewer"),
      detail: HasContributionRole(InArtifact, "reviewer") ? "reviewer contribution found" : "reviewer evidence missing",
    },
    {
      id: "verify",
      labelKey: "goal.qualityGate.verify",
      passed: hasVerifierContribution && (!isUserFacingWebArtifact || hasExecutableEvidence),
      detail:
        hasVerifierContribution && !hasExecutableEvidence && isUserFacingWebArtifact
          ? "executable evidence missing"
          : (evidence[0] ?? "execution evidence missing"),
    },
    {
      id: "next",
      labelKey: "goal.qualityGate.next",
      passed: NormalizeArtifactStatus(InArtifact.status) === "completed" || nextActions.length > 0,
      detail: nextActions[0] ?? String(InArtifact.status ?? ""),
    },
  ];
  if (isUserFacingWebArtifact) {
    const uxEvidence = BuildAdvancedUxEvidenceSummary(InArtifact, evidence);
    const missingRequiredUxEvidence = BuildMissingRequiredUserFacingUxEvidence(InArtifact, evidence, uxEvidence);
    rows.splice(3, 0, {
      id: "ux",
      labelKey: "goal.qualityGate.ux",
      passed: missingRequiredUxEvidence.length === 0,
      detail:
        missingRequiredUxEvidence.length === 0
          ? uxEvidence.slice(0, 4).join(" · ")
          : `missing ${missingRequiredUxEvidence.slice(0, 4).join(" · ")}`,
    });
  }
  if (LooksLikePremiumArtifactRequest(InArtifact, InFiles)) {
    const premiumRows = BuildPremiumProductEvidenceRows(InArtifact, InFiles);
    const premiumPassedCount = premiumRows.filter((row) => row.passed).length;
    rows.push({
      id: "premium",
      labelKey: "goal.qualityGate.premium",
      passed: premiumRows.length > 0 && premiumPassedCount === premiumRows.length,
      detail:
        premiumRows.length > 0
          ? `${premiumPassedCount}/${premiumRows.length} premium evidence`
          : "premium evidence missing",
    });
  }
  return rows;
}

function LooksLikeModifyExistingGoal(InGoal: string): boolean {
  const text = String(InGoal ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return false;
  if (/##\s*MODIFY\s+EXISTING\s+ARTIFACT/i.test(text)) return true;
  return /(?:\bmodify\b|\bexisting\b|\brepair\b|\brefactor\b|\bpatch\b|\bfix\b|\bupdate\b|\bchange\b|\bimprove\b|\badd\b|\bremove\b|기존|수정|고쳐|고치|바꿔|변경|개선|추가|넣어|빼줘|삭제|보수|리팩터)/i.test(text);
}

function LooksLikeFreshArtifactGoal(InGoal: string): boolean {
  const text = String(InGoal ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return false;
  if (
    /##\s*MODIFY\s+EXISTING\s+ARTIFACT/i.test(text) ||
    /(?:\bmodify\b|\bexisting\b|\brepair\b|\brefactor\b|\bpatch\b|\bfix\b|기존|수정|고쳐|고치|보수|리팩터)/i.test(text)
  ) {
    return false;
  }
  return /(?:새\s*산출물|새로운\s*산출물|새\s*(?:웹|앱|프로젝트)|만들어줘|만들어\s*주세요|생성|제작|구현|웹사이트|웹\s*MVP|앱\s*MVP|\bcreate\b|\bbuild\b|\bmake\b|\bgenerate\b|\bnew\s+(?:artifact|web|app|site|project)\b|\bVite\b|\bReact\b)/i.test(text);
}

export function GoalMeetingPanel() {
  const { t } = useI18n();
  const { projectId, addNotification, setAgentTaskByRole, setAgentTask } = useOfficeStore();
  const projectName = projectId ?? "local";
  const {
    projectId: collaborationProjectId,
    sessionId: collaborationSessionId,
    sharedGoal: collaborationSharedGoal,
    artifacts: collaborationArtifacts,
    addRoundArtifact,
    setSession: setCollaborationSession,
    reset: resetCollaboration,
  } = useCollaborationStore();
  const [goal, setGoal] = useState("");
  const [artifactQaFeedback, setArtifactQaFeedback] = useState("");
  const [goalInputError, setGoalInputError] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [phase, setPhase] = useState<GoalPhase>(null);
  const [roundProgress, setRoundProgress] = useState<RoundProgressEntry[]>([]);
  const [cliProvider, setCliProvider] = useState<CliProvider | null>(null);
  const [workspacePath, setWorkspacePath] = useState<string | null>(() =>
    getExecutionWorkspacePath(projectId ?? "local"),
  );
  const [workspaceDraft, setWorkspaceDraft] = useState<string>(() =>
    getExecutionWorkspacePath(projectId ?? "local") ?? "",
  );
  const { setIsOpen, addMessage, setRfiContext, clearMessages, setSubmitRfiAnswer } =
    useMessengerStore();
  const [todo, setTodo] = useState<SequencerTodoList | null>(null);
  const [todoLoading, setTodoLoading] = useState(false);
  const sequencerCommandQueueRef = useRef<string[]>([]);
  const sequencerPipelineActiveRef = useRef(false);
  const rosterAgentsRef = useRef<RosterAgentMeta[]>([]);
  const sequencerCoordinatorRef = useRef(new SequencerCoordinator());
  const agentRegistryRef = useRef(new AgentRegistry([]));
  const abortControllerRef = useRef<AbortController | null>(null);
  const goalInputRef = useRef<HTMLTextAreaElement | null>(null);
  const runTokenRef = useRef(0);
  const agentWorkspaceMapRef = useRef<Record<string, string>>({});
  const latestArtifact = collaborationArtifacts[collaborationArtifacts.length - 1] ?? null;
  const latestArtifactFiles = ExtractArtifactFiles(latestArtifact);
  const latestArtifactWorkspacePath = ExtractArtifactWorkspacePath(latestArtifact);
  const latestModifiableArtifact =
    latestArtifact != null && (latestArtifactFiles.length > 0 || latestArtifactWorkspacePath != null)
      ? latestArtifact
      : null;
  const outcomeSummary = BuildRoundOutcomeSummary(t, running, roundProgress, latestArtifact);
  const qualityGateRows = BuildQualityGateRows(
    latestArtifact,
    latestArtifactFiles,
    latestArtifactWorkspacePath,
  );
  const missingQualityGateRows = qualityGateRows.filter((row) => !row.passed);
  const qualitySummary = BuildArtifactQualitySummary(latestArtifact, qualityGateRows);
  const premiumEvidenceRows = BuildPremiumProductEvidenceRows(latestArtifact, latestArtifactFiles);
  const premiumEvidencePassedCount = premiumEvidenceRows.filter((row) => row.passed).length;
  const premiumEvidenceReady =
    premiumEvidenceRows.length > 0 && premiumEvidencePassedCount === premiumEvidenceRows.length;
  const releaseReadiness = BuildReleaseReadinessSummary(
    running,
    outcomeSummary,
    qualityGateRows,
    qualitySummary,
    latestArtifact,
  );
  const liveProviderEvidencePayload =
    latestArtifact != null
      ? BuildLiveProviderEvidencePayload(
          cliProvider ?? getSavedCliProvider() ?? "unknown",
          workspacePath ?? latestArtifactWorkspacePath,
          collaborationArtifacts,
          collaborationSharedGoal ?? goal,
        )
      : null;
  const liveProviderEvidenceJson =
    liveProviderEvidencePayload != null ? BuildLiveProviderEvidenceJson(liveProviderEvidencePayload) : "";
  const liveProviderEvidenceDomains = liveProviderEvidencePayload?.domains ?? [];
  const liveProviderEvidenceDomainCount = liveProviderEvidenceDomains.length;
  const liveProviderEvidenceReadyDomainCount =
    liveProviderEvidenceDomains.filter(IsLiveProviderEvidenceDomainCandidateReady).length;
  const liveProviderEvidenceModificationCount =
    liveProviderEvidenceDomains.filter((domain) => domain.modification_request.trim() !== "").length;
  const liveProviderEvidenceCandidateReady =
    liveProviderEvidenceDomainCount >= 2 &&
    liveProviderEvidenceReadyDomainCount === liveProviderEvidenceDomainCount;
  const artifactTraceRows = BuildArtifactTraceRows(latestArtifact);
  const latestArtifactStatus = NormalizeArtifactStatus(latestArtifact?.status);
  const latestArtifactHasMissingQualityGate = missingQualityGateRows.length > 0;
  const latestArtifactNeedsFollowUp =
    latestArtifact != null &&
    latestArtifactStatus !== "idle" &&
    (latestArtifactStatus !== "completed" || latestArtifactHasMissingQualityGate);
  const isUiOnlyWorkflowRuntime = !isTauri() && isAppApiStubEnabled();

  const focusArtifactRecovery = useCallback(() => {
    if (typeof document === "undefined") return;
    const target =
      document.querySelector('[data-testid="goal-recovery-panel"]') ??
      document.querySelector('[data-testid="goal-quality-gate"]') ??
      document.querySelector('[data-testid="goal-artifact-trace"]') ??
      document.querySelector('[data-testid="goal-release-readiness"]');
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    const retryButton = document.querySelector('[data-testid="goal-retry-latest-button"]');
    if (retryButton instanceof HTMLElement) retryButton.focus();
  }, []);

  useEffect(() => {
    const handler = () => focusArtifactRecovery();
    window.addEventListener("daacs:open-goal-recovery", handler);
    return () => window.removeEventListener("daacs:open-goal-recovery", handler);
  }, [focusArtifactRecovery]);

  const focusArtifactDiagnostics = useCallback(() => {
    if (typeof document === "undefined") return;
    const target =
      document.querySelector('[data-testid="goal-quality-gate"]') ??
      document.querySelector('[data-testid="goal-artifact-trace"]') ??
      document.querySelector('[data-testid="goal-release-readiness"]');
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const openLatestArtifactWorkspace = useCallback(async () => {
    const targetPath = latestArtifactWorkspacePath ?? ExtractArtifactWorkspacePath(latestArtifact);
    if (targetPath == null || targetPath.trim() === "") {
      addNotification({ type: "warning", message: t("goal.openArtifactNoPath") });
      return;
    }
    try {
      await openPathInFileManager(targetPath);
      addNotification({ type: "success", message: t("goal.openArtifactOpened") });
    } catch (error) {
      addNotification({
        type: "warning",
        message:
          error instanceof Error
            ? `${t("goal.openArtifactFailed")}: ${error.message}`
            : t("goal.openArtifactFailed"),
      });
    }
  }, [addNotification, latestArtifact, latestArtifactWorkspacePath, t]);

  const upsertRoundProgress = useCallback((entry: RoundProgressEntryDraft) => {
    const now = Date.now();
    setRoundProgress((current) =>
      UpsertRoundProgressEntry(current, { ...entry, updatedAt: now }),
    );
  }, []);

  const stopWebCollaborationSessionBestEffort = useCallback((sessionId: string | null | undefined) => {
    if (!projectId || !sessionId) {
      return;
    }
    void stopCollaborationSession(projectId, sessionId).catch((error) => {
      console.warn(GOAL_MEETING_LOG, "stop:web_session_failed", {
        projectId,
        sessionId,
        error,
      });
    });
  }, [projectId]);

  const ensureRegistryReady = useCallback(async (): Promise<string> => {
    const agentsMetadataJson = await getAgentsMetadataJson();
    const parsedRosterAgents = sequencerCoordinatorRef.current.ParseRosterAgents(agentsMetadataJson);
    rosterAgentsRef.current = parsedRosterAgents;
    agentRegistryRef.current = new AgentRegistry(parsedRosterAgents);
    sequencerCoordinatorRef.current.SetRegistry(agentRegistryRef.current);
    return agentsMetadataJson;
  }, []);

  const resolveSequencerChannels = () => {
    try {
      return agentRegistryRef.current.BuildSequencerChannelMap((InRoleKey) => getPromptingSequencerChannelId(InRoleKey));
    } catch {
      const pm = getPromptingSequencerChannelId("pm");
      return { pm, byRoleKey: { pm } };
    }
  };
  const resolveTodoChannelRouter = () => new TodoChannelRouter(resolveSequencerChannels(), agentRegistryRef.current);

  const channelIdForStepNumber = (stepNumber: number): string => {
    void stepNumber;
    return resolveSequencerChannels().pm;
  };
  const RunCliCommandWithRetry = useCallback(
    async (
      InInstruction: string,
      InOptions: Record<string, unknown> | undefined,
      InLabel: string,
    ): Promise<CliRunResult | null> => {
      const maxAttempts = 4;
      let attempt = 0;
      while (attempt < maxAttempts) {
        attempt++;
        const result = await runCliCommand(InInstruction, InOptions);
        const exitCode = result?.exit_code ?? -1;
        const combined = CombinedCliOutputText(result);
        const retryable = exitCode !== 0 && IsQuotaExhaustedErrorText(combined);
        if (!retryable) return result;
        if (attempt >= maxAttempts) return result;
        const waitMs = ParseRetryDelayMs(combined) ?? 12000;
        console.warn(GOAL_MEETING_LOG, "run:quota_retry_wait", {
          label: InLabel,
          attempt,
          waitMs,
        });
        await delay(waitMs);
      }
      return null;
    },
    [],
  );

  const resolveChannelForItem = (item: SequencerItem): string => {
    const desc = item.description ?? "";
    const m = desc.match(/^([a-z0-9_]+)\s*->\s*/i);
    if (m?.[1]) {
      const roleKey = agentRegistryRef.current.MapAgentIdToSequencerRoleKey(m[1]);
      return resolveTodoChannelRouter().ResolveBySequencerRoleKey(roleKey);
    }
    return channelIdForStepNumber(item.number);
  };

  const refreshTodo = useCallback(async () => {
    if (!isTauri()) return;
    console.info(GOAL_MEETING_LOG, "refreshTodo:start", { projectName });
    setTodoLoading(true);
    try {
      await ensureRegistryReady();
      const channels = resolveSequencerChannels();
      const orderedChannelIds = Array.from(new Set([channels.pm, ...Object.values(channels.byRoleKey)]));
      const todos = await Promise.all(
        orderedChannelIds.map(async (InChannelId) => ({
          channelId: InChannelId,
          todo: await loadPromptingSequencerTodo(projectName, InChannelId),
        })),
      );
      const todoByChannel = new Map<string, SequencerTodoList | null>(todos.map((x) => [x.channelId, x.todo]));

      const flat: SequencerItem[] = [
        ...orderedChannelIds.flatMap((InChannelId) => todoByChannel.get(InChannelId)?.items ?? []),
      ];
      const active = flat.filter((x) => x.status !== "done");
      const done = flat.filter((x) => x.status === "done");
      active.sort((a, b) => a.number - b.number || (a.title ?? "").localeCompare(b.title ?? ""));
      done.sort((a, b) => a.number - b.number || (a.title ?? "").localeCompare(b.title ?? ""));
      const items = [...active, ...done];

      const mainTaskName = todos.map((x) => x.todo?.main_task_name ?? "").find((x) => x.trim() !== "") ?? "";
      const mergedProjectName =
        todos.map((x) => x.todo?.project_name ?? "").find((x) => x.trim() !== "") ?? projectName;

      setTodo({
        main_task_name: mainTaskName,
        project_name: mergedProjectName,
        channel_id: channels.pm,
        items,
      });
      console.info(GOAL_MEETING_LOG, "refreshTodo:done", { itemCount: items.length });
    } finally {
      setTodoLoading(false);
    }
  }, [projectName, ensureRegistryReady]);

  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      await prewarmOmniCli();
      const saved = getSavedCliProvider();
      if (saved) {
        setCliProvider(saved);
        return;
      }
      getCliWhich().then((w) => {
        const preferred = (w?.preferred ?? "").trim().toLowerCase();
        if (
          preferred === "gemini" ||
          preferred === "codex" ||
          preferred === "claude" ||
          preferred === "local_llm"
        ) {
          setCliProvider(preferred);
        }
        else if (w?.gemini) setCliProvider("gemini");
        else if (w?.codex) setCliProvider("codex");
        else if (w?.claude) setCliProvider("claude");
        else if (w?.local_llm) setCliProvider("local_llm");
        else setCliProvider(null);
      });
    })();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    refreshTodo();
  }, [refreshTodo]);

  useEffect(() => {
    const savedWorkspacePath = getExecutionWorkspacePath(projectName);
    setWorkspacePath(savedWorkspacePath);
    setWorkspaceDraft(savedWorkspacePath ?? "");
  }, [projectName]);

  const handleSelectWorkspace = async () => {
    if (!isTauri()) return;
    const path = await openWorkspaceDialog();
    if (path != null) {
      setSavedWorkspacePath(path, projectName);
      setWorkspacePath(path);
      setWorkspaceDraft(path);
      return;
    }
    addNotification({ type: "warning", message: t("goal.selectWorkspaceFirst") });
  };

  const handleSaveWorkspacePath = useCallback(() => {
    const trimmedWorkspacePath = workspaceDraft.trim();
    setSavedWorkspacePath(trimmedWorkspacePath === "" ? null : trimmedWorkspacePath, projectName);
    setWorkspacePath(trimmedWorkspacePath === "" ? null : trimmedWorkspacePath);
  }, [projectName, workspaceDraft]);

  const requestStop = useCallback(() => {
    setStopping(true);
    upsertRoundProgress({
      id: "stop-requested",
      label: t("goal.roundProgressStopRequested"),
      status: "incomplete",
    });
    runTokenRef.current += 1;
    abortControllerRef.current?.abort();
    sequencerCommandQueueRef.current.length = 0;
    if (isTauri()) {
      void stopActiveCliCommands();
    }
    if (!isTauri()) {
      stopWebCollaborationSessionBestEffort(collaborationSessionId);
      resetCollaboration();
    }
  }, [
    collaborationSessionId,
    resetCollaboration,
    stopWebCollaborationSessionBestEffort,
    t,
    upsertRoundProgress,
  ]);

  const runWithGoal = async (overrideGoal?: string) => {
    console.info(GOAL_MEETING_LOG, "run:click", {
      running,
      isTauri: isTauri(),
      goalLen: (typeof overrideGoal === "string" ? overrideGoal : goal).trim().length,
      cliProvider,
    });
    const rawGoalText = (typeof overrideGoal === "string" ? overrideGoal : goal).trim();
    if (!rawGoalText) {
      console.info(GOAL_MEETING_LOG, "run:abort_empty_goal");
      setGoalInputError(true);
      goalInputRef.current?.focus();
      addNotification({ type: "warning", message: t("goal.enterGoalFirst") });
      return;
    }
    if (isUiOnlyWorkflowRuntime) {
      console.info(GOAL_MEETING_LOG, "run:abort_ui_only_runtime");
      upsertRoundProgress({
        id: "ui-only-runtime",
        label: t("goal.uiOnlyRuntimeTitle"),
        status: "failed",
        detail: t("goal.uiOnlyRuntimeWarning"),
      });
      addNotification({ type: "warning", message: t("goal.uiOnlyRuntimeWarning") });
      return;
    }
    setGoalInputError(false);
    const shouldAutoModifyLatestArtifact =
      overrideGoal == null &&
      latestModifiableArtifact != null &&
      LooksLikeModifyExistingGoal(rawGoalText) &&
      !LooksLikeFreshArtifactGoal(rawGoalText);
    const goalText = shouldAutoModifyLatestArtifact
      ? BuildModifyExistingGoalText(rawGoalText, latestModifiableArtifact)
      : rawGoalText;

    if (isTauri()) {
      if (sequencerPipelineActiveRef.current) {
        sequencerCommandQueueRef.current.push(goalText);
        const depth = sequencerCommandQueueRef.current.length;
        console.info(GOAL_MEETING_LOG, "run:sequencer_enqueue", { depth });
        addNotification({
          type: "info",
          message: t("goal.sequencerQueued", { count: depth }),
        });
        return;
      }
      sequencerPipelineActiveRef.current = true;
      useSequencerDeferredCommandsStore.getState().BeginSequencerPipeline();
      const abortController = new AbortController();
      const runToken = ++runTokenRef.current;
      abortControllerRef.current = abortController;
      setStopping(false);
      setRunning(true);
      try {
        const executeOne = async (g: string): Promise<boolean> => {
          const now = Date.now();
          setRoundProgress([
            {
              id: "preparing",
              label: t("goal.roundProgressPreparing"),
              status: "running",
              detail: g.slice(0, 120),
              startedAt: now,
              updatedAt: now,
            },
          ]);
        if (abortController.signal.aborted || runToken !== runTokenRef.current) {
          return false;
        }
        const activeProvider = getSavedCliProvider() ?? cliProvider ?? null;
        console.info(GOAL_MEETING_LOG, "run:tauri_branch", { projectName });
        const savedWorkspace = getExecutionWorkspacePath(projectName)?.trim() ?? "";
        const draftWorkspace = workspaceDraft.trim();
        const workspace = (workspacePath?.trim() || savedWorkspace || draftWorkspace).trim();
        if (!workspace) {
          console.info(GOAL_MEETING_LOG, "run:abort_no_workspace");
          addNotification({ type: "warning", message: t("goal.selectWorkspaceFirst") });
          setPhase(null);
          return false;
        }
        if (workspace !== workspacePath || workspace !== savedWorkspace) {
          setSavedWorkspacePath(workspace, projectName);
          setWorkspacePath(workspace);
          setWorkspaceDraft(workspace);
        }
        setTodo(null);
        const agentsMetadataJson = await ensureRegistryReady();
        const wantsFreshArtifactWorkspace = LooksLikeFreshArtifactGoal(g);
        const wantsExistingArtifactModification =
          latestModifiableArtifact != null && LooksLikeModifyExistingGoal(g) && !wantsFreshArtifactWorkspace;
        const channels = resolveSequencerChannels();

        console.info(GOAL_MEETING_LOG, "run:clear_previous_todos");
        await Promise.all(
          Object.values(channels.byRoleKey).concat(channels.pm).map(async (chId) => {
            await clearPromptingSequencerChannel(projectName, chId);
          })
        );
        let executionWorkspace = workspace;
        if (wantsFreshArtifactWorkspace) {
          const preparedWorkspace = await prepareArtifactWorkspace(workspace, g);
          if (preparedWorkspace == null) {
            console.info(GOAL_MEETING_LOG, "run:abort_artifact_workspace_failed", { workspace });
            addNotification({ type: "error", message: t("goal.failed") });
            setPhase(null);
            return false;
          }
          executionWorkspace = preparedWorkspace;
        } else if (wantsExistingArtifactModification && latestArtifactWorkspacePath != null) {
          executionWorkspace = latestArtifactWorkspacePath;
        }
        console.info(GOAL_MEETING_LOG, "run:workspace_ok", {
          workspace,
          executionWorkspace,
          wantsFreshArtifactWorkspace,
          wantsExistingArtifactModification,
        });
        upsertRoundProgress({
          id: "preparing",
          label: t("goal.roundProgressPreparing"),
          status: "completed",
          detail: wantsExistingArtifactModification
            ? `${t("goal.modifyLatestTitle")}: ${executionWorkspace}`
            : executionWorkspace,
        });
        setPhase("pm");
        const roundId = `cli-${Date.now()}`;
        const nextActions: string[] = [`${t("goal.workspace")}: ${executionWorkspace}`];

        setAgentTaskByRole("pm", t("goal.phasePm"));
        upsertRoundProgress({
          id: "rfi",
          label: t("goal.roundProgressRfi"),
          status: "running",
        });
        await delay(200);
        const workspaceSlots =
          (await prepareAgentWorkspaces(
            executionWorkspace,
            rosterAgentsRef.current.map((agent) => String(agent.id ?? "").trim().toLowerCase()),
          )) ?? {};
        agentWorkspaceMapRef.current = workspaceSlots;

        // --- RFI Loop Start ---
        const rfiMessenger = useMessengerStore.getState();
        const rfiPending = rfiMessenger.pendingQuestions ?? [];
        const rfiOriginalGoal = (rfiMessenger.originalGoal ?? "").trim();
        const rfiHistorical = [...(rfiMessenger.historicalAnswers ?? [])];

        let finalGoalForPlan = g;
        let bypassRfi = false;
        if (g.trim().toLowerCase() === "ok" || g.trim().toLowerCase() === "ㅇㅇ" || g.trim().toLowerCase() === "ㅇㅋ") {
          finalGoalForPlan = rfiOriginalGoal || g;
          bypassRfi = true;
        }

        let currentAnswers: RfiKnownAnswer[] = [];
        let collectedAnswers = [...rfiHistorical];
        const roundContributions: CollaborationContribution[] = [];

        if (rfiPending.length > 0) {
          if (!bypassRfi) {
            if (rfiPending.length === 1 && rfiPending[0] != null) {
              // 질문 1개: 해당 topic에만 매핑
              currentAnswers = [{ topic: rfiPending[0].topic, value: g }];
            } else {
              // 질문 여러 개: 사용자 입력을 전체 맥락으로 묶어 constraints 토픽으로 전달
              // (AI가 답변 안에서 각 항목을 스스로 추출)
              currentAnswers = [{ topic: "constraints", value: g }];
            }
            collectedAnswers = [...rfiHistorical, ...currentAnswers];
          }
          setRfiContext(rfiPending, collectedAnswers, rfiOriginalGoal || g);
          finalGoalForPlan = rfiOriginalGoal || g;
        } else {
          if (overrideGoal == null) {
            clearMessages();
          }
          setRfiContext([], [], finalGoalForPlan);
        }

        if (!bypassRfi) {
          console.info(GOAL_MEETING_LOG, "run:evaluating_rfi", { goal: finalGoalForPlan });
          setAgentTaskByRole("pm", t("goal.phasePm"));
          const rfiSystem = await getRfiSystemPrompt();
          const rfiUser = await buildRfiUserPrompt(finalGoalForPlan, collectedAnswers);
          const rfiResult = await RunCliCommandWithRetry(rfiUser, {
            systemPrompt: rfiSystem,
            cwd: executionWorkspace ?? null,
            provider: cliProvider,
          }, "rfi_evaluation");
          
          if (rfiResult && rfiResult.exit_code === 0) {
            const rfiStr = CombinedCliOutputText(rfiResult);
            const rfiOutcome = await parseRfiOutcome(finalGoalForPlan, rfiStr);
            if (rfiOutcome && rfiOutcome.status === "needs_clarification") {
              console.info(GOAL_MEETING_LOG, "run:rfi_needs_clarification", { questions: rfiOutcome.questions.length });
              upsertRoundProgress({
                id: "rfi",
                label: t("goal.roundProgressRfi"),
                status: "incomplete",
                detail: `${rfiOutcome.questions.length} question${rfiOutcome.questions.length === 1 ? "" : "s"}`,
              });
              const rfiContribution = BuildRfiContribution(rfiOutcome);
              addRoundArtifact(
                {
                  session_id: "cli",
                  round_id: roundId,
                  decision: rfiOutcome.summary,
                  open_questions: rfiOutcome.questions.map((q: RfiQuestion) => `${q.topic}: ${q.question}`),
                  next_actions: [...rfiOutcome.questions.map((q: RfiQuestion) => q.question), "💡 답변 입력이 귀찮으시면 'ok'를 입력해 AI에게 알아서 하라고 위임하세요!"],
                  contributions: [rfiContribution],
                },
                roundId,
                Date.now()
              );
              setRfiContext(
                rfiOutcome.questions,
                collectedAnswers,
                (rfiOutcome.refined_goal ?? "").trim() || finalGoalForPlan,
              );
              const questionsText = rfiOutcome.questions.map(q => q.question).join("\n");
              addMessage({ senderId: "pm", senderName: "PM", senderRole: "pm", text: `정보가 더 필요합니다!\n\n${questionsText}\n\n💡 답변 입력이 귀찮으시면 'ok'를 입력해 AI에게 알아서 하라고 위임하세요!`, actionType: "rfi" });
              setIsOpen(true);
              setAgentTaskByRole("pm", "");
              setPhase(null);
              setRunning(false);
              setGoal(""); // Clear input
              return false;
            } else if (rfiOutcome && rfiOutcome.status === "ready_to_plan") {
              console.info(GOAL_MEETING_LOG, "run:rfi_proceed");
              upsertRoundProgress({
                id: "rfi",
                label: t("goal.roundProgressRfi"),
                status: "completed",
                detail: rfiOutcome.summary,
              });
              UpsertRoundContribution(roundContributions, BuildRfiContribution(rfiOutcome));
              const baseGoal = (
                (rfiOutcome.refined_goal ?? "").trim() || finalGoalForPlan
              ).trim();
              finalGoalForPlan = BuildGoalTextWithRfiSupplement(
                baseGoal,
                collectedAnswers,
                rfiOutcome.assumptions,
              );
              setRfiContext([], [], "");
              setIsOpen(false);
            } else {
              // RFI outcome parsed but status unrecognized or null — proceed to planning
              console.warn(GOAL_MEETING_LOG, "run:rfi_outcome_unrecognized", { rfiOutcome });
              upsertRoundProgress({
                id: "rfi",
                label: t("goal.roundProgressRfi"),
                status: "incomplete",
                detail: "RFI output was unclear; proceeding",
              });
            }
          } else {
            // RFI CLI call failed — warn user and proceed to planning
            const rfiStderr = rfiResult ? CombinedCliOutputText(rfiResult) : "(no response)";
            console.warn(GOAL_MEETING_LOG, "run:rfi_cli_failed", {
              exit_code: rfiResult?.exit_code ?? -1,
              stderr: rfiStderr.slice(0, 500),
            });
            upsertRoundProgress({
              id: "rfi",
              label: t("goal.roundProgressRfi"),
              status: "incomplete",
              detail: "RFI skipped after CLI failure",
            });
            addNotification({
              type: "warning",
              message: `RFI 분석 실패 (exit ${rfiResult?.exit_code ?? -1}) — 질문 없이 바로 플래닝으로 진행합니다.`,
            });
          }
        } else {
          upsertRoundProgress({
            id: "rfi",
            label: t("goal.roundProgressRfi"),
            status: "completed",
            detail: "Bypassed by user answer",
          });
          finalGoalForPlan = BuildGoalTextWithRfiSupplement(
            finalGoalForPlan,
            collectedAnswers,
            [],
          );
          setRfiContext([], [], "");
        }
        // --- RFI Loop End ---

        const clearAgentTasks = () =>
          sequencerCoordinatorRef.current.ClearAgentTasks(setAgentTaskByRole, agentRegistryRef.current);
        const pmAgentId = agentRegistryRef.current.FindAgentIdByOfficeRole("pm") ?? "pm";
        upsertRoundProgress({
          id: "pm-plan",
          label: t("goal.roundProgressPmPlan"),
          status: "running",
        });
        upsertRoundProgress({
          id: "agent-cascade",
          label: t("goal.roundProgressAgentCascade"),
          status: "running",
        });
        const cascadeOk = await sequencerCoordinatorRef.current.RunAgentCommandCascade({
          projectName,
          workspace: executionWorkspace ?? "",
          cliProvider: activeProvider,
          agentsMetadataJson,
          seed: [{ agentId: pmAgentId, command: finalGoalForPlan }],
          setAgentTaskByRole,
          setAgentTaskById: (agentId, task) => setAgentTask(agentId, task),
          setPhase,
          maxCascade: MAX_AGENT_COMMAND_CASCADE,
          abortSignal: abortController.signal,
          resolveWorkspaceForAgentId: (agentId) =>
            agentWorkspaceMapRef.current[String(agentId ?? "").trim().toLowerCase()] ?? executionWorkspace,
          parseSequencerPlanSteps: (stdout) => SequencerParser.ParsePlanSteps(stdout),
          resolveSequencerChannelIdForAgentId: (id) =>
            getPromptingSequencerChannelId(
              agentRegistryRef.current.MapAgentIdToSequencerRoleKey(id),
            ),
          persistAgentCascadePlanTodo: async (fresh) => {
            const existing = await loadPromptingSequencerTodo(projectName, fresh.channel_id);
            const merged = MergeChannelTodoList(
              existing,
              fresh.items,
              fresh.main_task_name,
              projectName,
              fresh.channel_id,
            );
            return savePromptingSequencerTodo(projectName, merged);
          },
          onAgentPlanGenerated: async (agentId, planText) => {
            if (agentId !== "pm" || !executionWorkspace) return;
            try {
              const pmContribution = await BuildPmPlanningContribution(planText, finalGoalForPlan);
              UpsertRoundContribution(roundContributions, pmContribution);
              upsertRoundProgress({
                id: "pm-plan",
                label: t("goal.roundProgressPmPlan"),
                status: "completed",
                detail: pmContribution.summary,
              });
              // Safely write to DAACS_Plan.md using Node to bypass escaping
              const safeB64 = btoa(unescape(encodeURIComponent(planText)));
              const cmd = `node -e "const fs=require('fs'); fs.writeFileSync('DAACS_Plan.md', Buffer.from('${safeB64}', 'base64'));"`;
              await runWorkspaceCommand(cmd, executionWorkspace);
              console.info(GOAL_MEETING_LOG, "run:saved_plan_md", { agentId });
            } catch (e) {
              console.warn(GOAL_MEETING_LOG, "run:save_plan_md_failed", e);
            }
          },
          runHostWorkspaceCommand: (cmd, cwd) => runWorkspaceCommand(cmd, cwd),
          extractHostCommandsFromStepOutput: (text) => extractPromptingSequencerCommands(text),
          shouldSkipHostCommand: (cmd) => IsInvalidSequencerCliCommand(cmd),
          runCliCommand: (instruction, options) =>
            RunCliCommandWithRetry(instruction, options as Record<string, unknown> | undefined, "agent_command_cascade"),
          buildRosterDelegationSystemPrompt: (InProjectName, InPromptRole, InAgentsMetadataJson, InOptions) =>
            buildRosterDelegationSystemPrompt(InProjectName, InPromptRole, InAgentsMetadataJson, InOptions),
          mapTauriCliRoleKeyToAgentPromptRole,
          onCliLog: (entry) => useCliLogStore.getState().addEntry(entry),
          onAgentMessage: (msg) => {
            upsertRoundProgress(BuildRoundProgressEntryFromAgentMessage(msg));
            EmitLocalAgentEvent("AGENT_MESSAGE_SENT", msg.officeRole, {
              from: msg.officeRole,
              to: "pm",
              from_instance_id: msg.agentId,
              content: msg.text,
            });
            useMessengerStore.getState().addMessage({
              senderId: msg.agentId,
              senderName: msg.agentName,
              senderRole: msg.officeRole,
              text: msg.text,
              actionType: "info",
            });
          },
          onAgentExecutionComplete: (completion) => {
            const taskEventType =
              completion.status === "completed" ? "AGENT_TASK_COMPLETED" : "AGENT_TASK_FAILED";
            EmitLocalAgentEvent(taskEventType, completion.officeRole, {
              task_id: `cascade-${completion.mode}-${completion.agentId}-${Date.now()}`,
              instruction: completion.command,
              result_summary: completion.summary,
              error: completion.status === "completed" ? undefined : completion.summary,
              result: {
                status: completion.status,
                mode: completion.mode,
                changed_files: completion.changedFiles,
                verification: completion.verification,
                review_findings: completion.reviewFindings,
                open_risks: completion.openRisks,
                evidence: completion.evidence,
              },
            });
            for (const filePath of completion.changedFiles) {
              EmitLocalAgentEvent("AGENT_TOOL_CALL", completion.officeRole, {
                tool: "sequencer_file_change",
                action: "edit",
                file_path: filePath,
              });
            }
            EmitLocalAgentEvent("AGENT_STATUS_UPDATED", completion.officeRole, {
              status: completion.status === "completed" ? "completed" : "failed",
              current_task: "",
              message: completion.summary,
            });
            upsertRoundProgress(BuildRoundProgressEntryFromCompletion(completion));
            if (completion.officeRole === "pm") return;
            UpsertRoundContribution(
              roundContributions,
              BuildCascadeExecutionContribution(completion),
            );
          },
        });

        clearAgentTasks();
        nextActions.unshift(
          cascadeOk
            ? "PromptingSequencer cascade completed"
            : "PromptingSequencer cascade requires follow-up",
        );
        const contributionNextActions = DeduplicateNonEmptyLines(
          roundContributions.flatMap((item) => item.next_actions ?? []),
        );
        const contributionOpenQuestions = DeduplicateNonEmptyLines(
          roundContributions.flatMap((item) => item.open_questions ?? []),
        );
        const roundStatus = BuildCascadeRoundStatus(cascadeOk, roundContributions);
        await refreshTodo();
        upsertRoundProgress({
          id: "agent-cascade",
          label: t("goal.roundProgressAgentCascade"),
          status: cascadeOk ? "completed" : roundStatus === "incomplete" ? "incomplete" : "failed",
        });
        upsertRoundProgress({
          id: "final",
          label: t("goal.roundProgressFinal"),
          status: cascadeOk ? "completed" : roundStatus === "incomplete" ? "incomplete" : "failed",
          detail:
            roundStatus === "completed"
              ? t("goal.completed")
              : roundStatus === "incomplete"
                ? t("goal.incomplete")
                : t("goal.failed"),
        });

        const roundArtifact: CollaborationArtifact = {
          session_id: "cli",
          round_id: roundId,
          status: roundStatus,
          artifact_type: "local_cli_artifact",
          artifact_workspace: executionWorkspace,
          workspace_path: executionWorkspace,
          output_path: executionWorkspace,
          decision: BuildCascadeRoundDecision(cascadeOk, roundContributions),
          open_questions: contributionOpenQuestions,
          next_actions: DeduplicateNonEmptyLines([
            ...contributionNextActions,
            ...nextActions,
          ]).slice(0, 24),
          contributions: roundContributions,
        };
        addRoundArtifact(roundArtifact, roundId, Date.now(), roundStatus);
        addNotification(BuildArtifactCompletionNotification(t, roundArtifact, roundStatus));

        console.info(GOAL_MEETING_LOG, "run:tauri_branch_complete", { cascadeOk });
        return cascadeOk;
        };

        let currentJob: string | null = goalText;
        while (currentJob != null && currentJob !== "") {
          const ok = await executeOne(currentJob);
          if (!ok) {
            sequencerCommandQueueRef.current.length = 0;
            break;
          }
          currentJob = sequencerCommandQueueRef.current.shift() ?? null;
          if (currentJob != null) {
            addNotification({
              type: "info",
              message: t("goal.sequencerStartingQueued"),
            });
            console.info(GOAL_MEETING_LOG, "run:sequencer_dequeue_next", {
              remaining: sequencerCommandQueueRef.current.length,
            });
          }
        }
      } catch (err) {
        console.error(GOAL_MEETING_LOG, "run:error", err);
        sequencerCommandQueueRef.current.length = 0;
        upsertRoundProgress({
          id: "final",
          label: t("goal.roundProgressFinal"),
          status: "failed",
          detail: err instanceof Error ? err.message : t("goal.failed"),
        });
        addNotification({ type: "error", message: err instanceof Error ? err.message : t("goal.failed") });
        setPhase(null);
      } finally {
        useSequencerDeferredCommandsStore.getState().EndSequencerPipeline();
        const leftover = useSequencerDeferredCommandsStore.getState().DrainDeferredAgentCommands();
        ReplayDeferredAgentCommands(leftover);
        try {
          sequencerCoordinatorRef.current.ClearAgentTasks(setAgentTaskByRole, agentRegistryRef.current);
        } catch {
          console.warn(GOAL_MEETING_LOG, "cleanup:clear-agent-tasks-failed");
        }
        sequencerPipelineActiveRef.current = false;
        abortControllerRef.current = null;
        agentWorkspaceMapRef.current = {};
        setRunning(false);
        setStopping(false);
        setPhase(null);
        console.info(GOAL_MEETING_LOG, "run:finally");
      }
      return;
    }

    if (running) {
      console.info(GOAL_MEETING_LOG, "run:skip_already_running");
      return;
    }
    setRunning(true);
    setStopping(false);
    const now = Date.now();
    setRoundProgress([
      {
        id: "preparing",
        label: t("goal.roundProgressPreparing"),
        status: "running",
        detail: goalText.slice(0, 120),
        startedAt: now,
        updatedAt: now,
      },
    ]);
    const abortController = new AbortController();
    const runToken = ++runTokenRef.current;
    abortControllerRef.current = abortController;
    let webSessionId: string | null = null;
    let webStopIssued = false;
    const stopWebSessionIfNeeded = () => {
      if (webStopIssued || webSessionId == null) {
        return;
      }
      webStopIssued = true;
      stopWebCollaborationSessionBestEffort(webSessionId);
    };
    try {
      console.info(GOAL_MEETING_LOG, "run:web_api_branch", { projectId: projectId ?? null });
      if (!projectId) {
        const roundId = `local-${Date.now()}`;
        upsertRoundProgress({
          id: "final",
          label: t("goal.roundProgressFinal"),
          status: "failed",
          detail: "Project is not selected",
        });
        addRoundArtifact(
          {
            session_id: "local",
            round_id: roundId,
            decision: `PM analysis: "${goalText.slice(0, 180)}". Select a project to dispatch tasks to Developer and Reviewer, then publish outcomes to the shared board.`,
            open_questions: ["Select a project to start a collaboration round."],
            next_actions: ["PM: Goal analysis complete", "Developer/Reviewer: waiting for project selection", "Select project", "Retry"],
            contributions: [],
          },
          roundId,
          Date.now(),
        );
        addNotification({ type: "warning", message: t("goal.failed") });
        setPhase(null);
        setRunning(false);
        console.info(GOAL_MEETING_LOG, "run:web_abort_no_project");
        return;
      }
      await delay(300);
      console.info(GOAL_MEETING_LOG, "run:web_collaboration_branch", { projectId });
      upsertRoundProgress({
        id: "preparing",
        label: t("goal.roundProgressPreparing"),
        status: "completed",
        detail: projectId,
      });
      setPhase("pm");
      upsertRoundProgress({
        id: "pm-plan",
        label: t("goal.roundProgressPmPlan"),
        status: "running",
      });
      const webArtifactWorkspace =
        latestModifiableArtifact != null && LooksLikeModifyExistingGoal(goalText) && !LooksLikeFreshArtifactGoal(goalText)
          ? ExtractArtifactWorkspacePath(latestModifiableArtifact)
          : null;
      const collaborationWorkspace =
        (webArtifactWorkspace ?? workspacePath ?? getExecutionWorkspacePath(projectId))?.trim() ?? "";
      if (collaborationWorkspace === "") {
        upsertRoundProgress({
          id: "final",
          label: t("goal.roundProgressFinal"),
          status: "failed",
          detail: t("goal.selectWorkspaceFirst"),
        });
        addNotification({ type: "warning", message: t("goal.selectWorkspaceFirst") });
        setPhase(null);
        setRunning(false);
        return;
      }

      let activeSessionId = collaborationSessionId;
      let activeSharedGoal = collaborationSharedGoal;
      if (!collaborationSessionId || collaborationProjectId !== projectId) {
        resetCollaboration();
        const session = await createCollaborationSession(projectId, goalText, [
          "pm",
          "developer",
          "reviewer",
          "verifier",
        ], {
          signal: abortController.signal,
        });
        webSessionId = session.session_id;
        if (abortController.signal.aborted || runToken !== runTokenRef.current) {
          stopWebSessionIfNeeded();
          return;
        }
        activeSessionId = session.session_id;
        activeSharedGoal = session.shared_goal;
        setCollaborationSession(projectId, session.session_id, session.shared_goal);
      } else {
        webSessionId = collaborationSessionId;
      }
      if (!activeSessionId) {
        addNotification({ type: "error", message: t("goal.failed") });
        setPhase(null);
        setRunning(false);
        return;
      }
      upsertRoundProgress({
        id: "pm-plan",
        label: t("goal.roundProgressPmPlan"),
        status: "completed",
        detail: activeSharedGoal,
      });
      upsertRoundProgress({
        id: "agent-cascade",
        label: t("goal.roundProgressAgentCascade"),
        status: "running",
        detail: collaborationWorkspace,
      });
      const completed = await startCollaborationRound(
        projectId,
        activeSessionId,
        goalText,
        ["development_team", "review_team"],
        {
          signal: abortController.signal,
          projectCwd: collaborationWorkspace,
        },
      );
      if (abortController.signal.aborted || runToken !== runTokenRef.current) {
        stopWebSessionIfNeeded();
        return;
      }
      if (collaborationProjectId !== projectId || collaborationSharedGoal !== activeSharedGoal) {
        setCollaborationSession(projectId, activeSessionId, activeSharedGoal);
      }
      const roundStatus = completed.round.status ?? completed.status;
      upsertRoundProgress({
        id: "agent-cascade",
        label: t("goal.roundProgressAgentCascade"),
        status:
          roundStatus === "completed"
            ? "completed"
            : roundStatus === "incomplete"
              ? "incomplete"
              : "failed",
      });
      upsertRoundProgress({
        id: "final",
        label: t("goal.roundProgressFinal"),
        status:
          roundStatus === "completed"
            ? "completed"
            : roundStatus === "incomplete"
              ? "incomplete"
              : "failed",
        detail:
          roundStatus === "completed"
            ? t("goal.completed")
            : roundStatus === "incomplete"
              ? t("goal.incomplete")
              : t("goal.failed"),
      });
      addRoundArtifact(
        completed.artifact,
        completed.round.round_id,
        completed.round.created_at,
        roundStatus,
      );
      addNotification(BuildArtifactCompletionNotification(t, completed.artifact, roundStatus));
      setPhase(null);
      console.info(GOAL_MEETING_LOG, "run:web_collaboration_branch_complete", {
        sessionId: completed.session_id,
        roundId: completed.round.round_id,
        roundStatus,
      });
    } catch (err) {
      if (abortController.signal.aborted || runToken !== runTokenRef.current || IsAbortRequestError(err)) {
        stopWebSessionIfNeeded();
        console.info(GOAL_MEETING_LOG, "run:web_collaboration_branch_aborted", {
          projectId,
          sessionId: webSessionId,
        });
        setPhase(null);
        return;
      }
      console.error(GOAL_MEETING_LOG, "run:error", err);
      upsertRoundProgress({
        id: "final",
        label: t("goal.roundProgressFinal"),
        status: "failed",
        detail: err instanceof Error ? err.message : t("goal.failed"),
      });
      addNotification({ type: "error", message: err instanceof Error ? err.message : t("goal.failed") });
      setPhase(null);
    } finally {
      abortControllerRef.current = null;
      setRunning(false);
      setStopping(false);
      console.info(GOAL_MEETING_LOG, "run:finally");
    }
  }; // End runWithGoal

  const runWithGoalRef = useRef(runWithGoal);
  runWithGoalRef.current = runWithGoal;

  const runModifyLatestArtifact = useCallback(() => {
    const trimmedGoal = goal.trim();
    if (trimmedGoal === "") {
      addNotification({ type: "warning", message: t("goal.enterGoalFirst") });
      return;
    }
    if (latestModifiableArtifact == null) {
      addNotification({ type: "warning", message: t("goal.modifyNoArtifact") });
      return;
    }
    void runWithGoalRef.current(BuildModifyExistingGoalText(trimmedGoal, latestModifiableArtifact));
  }, [addNotification, goal, latestModifiableArtifact, t]);

  const runRetryLatestArtifact = useCallback(() => {
    if (latestArtifact == null) {
      addNotification({ type: "warning", message: t("goal.modifyNoArtifact") });
      return;
    }
    void runWithGoalRef.current(BuildRetryLatestGoalText(latestArtifact));
  }, [addNotification, latestArtifact, t]);

  const runQualityRepairLatestArtifact = useCallback(() => {
    if (latestModifiableArtifact == null || missingQualityGateRows.length === 0) {
      addNotification({ type: "warning", message: t("goal.qualityRepairNoIssue") });
      return;
    }
    void runWithGoalRef.current(BuildQualityRepairGoalText(latestModifiableArtifact, missingQualityGateRows));
  }, [addNotification, latestModifiableArtifact, missingQualityGateRows, t]);

  const runArtifactQaFeedbackRepair = useCallback(() => {
    const trimmedFeedback = artifactQaFeedback.trim();
    if (trimmedFeedback === "") {
      addNotification({ type: "warning", message: t("goal.qaFeedbackEmpty") });
      return;
    }
    if (latestModifiableArtifact == null) {
      addNotification({ type: "warning", message: t("goal.modifyNoArtifact") });
      return;
    }
    void runWithGoalRef.current(BuildArtifactQaFeedbackGoalText(trimmedFeedback, latestModifiableArtifact));
  }, [addNotification, artifactQaFeedback, latestModifiableArtifact, t]);

  const copyLiveProviderEvidence = useCallback(async () => {
    if (liveProviderEvidenceJson.trim() === "") {
      addNotification({ type: "warning", message: t("goal.liveEvidenceEmpty") });
      return;
    }
    try {
      if (typeof navigator === "undefined" || navigator.clipboard == null) {
        throw new Error("clipboard unavailable");
      }
      await navigator.clipboard.writeText(liveProviderEvidenceJson);
      addNotification({ type: "success", message: t("goal.liveEvidenceCopied") });
    } catch {
      addNotification({ type: "warning", message: t("goal.liveEvidenceCopyFailed") });
    }
  }, [addNotification, liveProviderEvidenceJson, t]);

  const downloadLiveProviderEvidence = useCallback(() => {
    if (liveProviderEvidenceJson.trim() === "") {
      addNotification({ type: "warning", message: t("goal.liveEvidenceEmpty") });
      return;
    }
    try {
      const blob = new Blob([liveProviderEvidenceJson], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `daacs-live-provider-evidence-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      addNotification({ type: "success", message: t("goal.liveEvidenceDownloaded") });
    } catch {
      addNotification({ type: "warning", message: t("goal.liveEvidenceDownloadFailed") });
    }
  }, [addNotification, liveProviderEvidenceJson, t]);

  useEffect(() => {
    setSubmitRfiAnswer((text: string) => {
      setGoal(text);
      setTimeout(() => void runWithGoalRef.current(text), 100);
    });
  }, [setSubmitRfiAnswer]);

  const handleMarkDone = async (item: SequencerItem) => {
    if (!isTauri() || !projectName) return;
    if (!todo || item.status === "done") return;
    try {
      const channelId = resolveChannelForItem(item);
      const updated = await markPromptingSequencerItemDone(projectName, channelId, item.number);
      if (updated != null) await refreshTodo();
    } catch {
      addNotification({ type: "error", message: t("goal.failed") });
    }
  };

  const renderRoundActionButtons = (placement: "primary" | "footer") => (
    <div className="flex gap-2" data-testid={`goal-round-actions-${placement}`}>
      <button
        type="button"
        onClick={() => void runWithGoal()}
        className={`flex-1 px-4 py-2 rounded-lg text-sm transition-colors ${
          running || isUiOnlyWorkflowRuntime
            ? "bg-gray-700/50 text-gray-400 cursor-not-allowed"
            : "bg-cyan-600 hover:bg-cyan-500"
        }`}
        disabled={running || isUiOnlyWorkflowRuntime}
      >
        {running ? t("goal.running") : isUiOnlyWorkflowRuntime ? t("goal.uiOnlyRuntimeAction") : t("goal.startRound")}
      </button>
      {running && (
        <button
          type="button"
          onClick={requestStop}
          className="px-4 py-2 bg-red-600/80 hover:bg-red-500 rounded-lg text-sm text-white transition-colors"
        >
          {stopping ? t("goal.stopping") : t("goal.stop")}
        </button>
      )}
    </div>
  );

  return (
    <div
      className="bg-[#111827]/88 border border-[#2A2A4A] rounded-xl p-4 space-y-3 text-white shadow-xl backdrop-blur-md"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-cyan-300">{t("goal.title")}</div>
        {isTauri() && (
          <div className="text-xs text-gray-400">
            {cliProvider == null ? t("goal.cliNotFound") : `${t("goal.cliStatus")}: ${cliProvider}`}
          </div>
        )}
      </div>
      <textarea
        ref={goalInputRef}
        value={goal}
        onChange={(e) => {
          const nextGoal = e.target.value;
          setGoal(nextGoal);
          if (nextGoal.trim() !== "") {
            setGoalInputError(false);
          }
        }}
        aria-invalid={goalInputError}
        aria-describedby="goal-input-hint"
        className={`w-full h-24 bg-[#0b1220] border rounded-lg p-3 text-sm resize-none outline-none transition-colors ${
          goalInputError
            ? "border-rose-400/80 focus:border-rose-300"
            : "border-[#2A2A4A] focus:border-cyan-400/70"
        }`}
        placeholder={t("goal.placeholder")}
      />
      <div
        id="goal-input-hint"
        data-testid="goal-input-error"
        className={`text-[11px] ${goalInputError ? "text-rose-300" : "text-gray-500"}`}
      >
        {t("goal.enterGoalFirst")}
      </div>
      <div className="space-y-2">
        <div className="text-[11px] text-gray-400">{t("goal.workspacePathLabel")}</div>
        <div className="flex gap-2">
          <input
            value={workspaceDraft}
            onChange={(e) => setWorkspaceDraft(e.target.value)}
            className="flex-1 bg-[#0b1220] border border-[#2A2A4A] rounded-lg px-3 py-2 text-xs"
            placeholder={t("goal.workspacePathPlaceholder")}
          />
          {isTauri() && (
            <button
              type="button"
              onClick={() => void handleSelectWorkspace()}
              className="px-3 py-2 rounded-lg text-xs border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20"
            >
              {t("goal.selectWorkspace")}
            </button>
          )}
          <button
            type="button"
            onClick={handleSaveWorkspacePath}
            className="px-3 py-2 rounded-lg text-xs border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20"
          >
            {t("goal.saveWorkspacePath")}
          </button>
        </div>
        <div className="text-[10px] text-gray-500">
          {workspacePath ? workspacePath : t("goal.workspacePathHint")}
        </div>
        {isUiOnlyWorkflowRuntime && (
          <div
            data-testid="goal-ui-only-runtime-warning"
            className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-100"
          >
            <div className="font-semibold">{t("goal.uiOnlyRuntimeTitle")}</div>
            <div>{t("goal.uiOnlyRuntimeWarning")}</div>
          </div>
        )}
      </div>
      {renderRoundActionButtons("primary")}
      {running && phase && (
        <div className="text-xs text-cyan-200/90">
          {(() => {
            const phaseKey = PhaseToI18nKey(phase);
            return phaseKey != null ? t(phaseKey) : "";
          })()}
        </div>
      )}
      {(running || latestArtifact || roundProgress.length > 0) && (
        <div
          data-testid="goal-outcome-banner"
          className={`rounded-xl border p-3 ${RoundOutcomeStatusClass(outcomeSummary.status)}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold">{t(outcomeSummary.titleKey)}</div>
              <div className="mt-1 line-clamp-2 text-[11px] opacity-85">{outcomeSummary.detail}</div>
              {outcomeSummary.workspacePath && (
                <div className="mt-1 truncate text-[10px] opacity-80">
                  {t("goal.latestOutcomePath")}: {outcomeSummary.workspacePath}
                </div>
              )}
              {outcomeSummary.nextActions.length > 0 && (
                <div className="mt-1 text-[10px] opacity-80">
                  {t("goal.latestOutcomeNext")}: {outcomeSummary.nextActions.slice(0, 2).join(" · ")}
                </div>
              )}
            </div>
            <span className="shrink-0 rounded-full border border-current/30 px-2 py-0.5 text-[10px]">
              {outcomeSummary.status === "idle"
                ? t("goal.outcomeStatus.idle")
                : t(`goal.roundProgressStatus.${outcomeSummary.status}`)}
            </span>
          </div>
        </div>
      )}
      {(running || roundProgress.length > 0) && (
        <div className="rounded-lg border border-cyan-500/20 bg-[#06111f]/80 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-cyan-200">{t("goal.roundProgressTitle")}</div>
            <div className="text-[10px] text-gray-500">
              {running ? t("goal.roundProgressLive") : t("goal.roundProgressLastRun")}
            </div>
          </div>
          {roundProgress.length > 0 ? (
            <div data-testid="goal-round-progress" className="space-y-1.5">
              {roundProgress.map((item) => (
                <div
                  key={item.id}
                  className="flex items-start justify-between gap-2 rounded-md border border-white/5 bg-[#020617]/60 px-2 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-[11px] font-medium text-gray-100">{item.label}</div>
                      <div className="shrink-0 text-[9px] text-gray-500">
                        {FormatRoundProgressTimestamp(item.updatedAt)}
                        {" · "}
                        {FormatRoundProgressElapsed(item.startedAt, item.updatedAt)}
                      </div>
                    </div>
                    {item.detail && (
                      <div className="mt-0.5 line-clamp-2 text-[10px] text-gray-400">{item.detail}</div>
                    )}
                  </div>
                  <span
                    className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${RoundProgressStatusClass(
                      item.status,
                    )}`}
                  >
                    {RoundProgressStatusLabel(t, item.status)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">{t("goal.roundProgressEmpty")}</div>
          )}
        </div>
      )}
      {qualityGateRows.length > 0 && (
        <div data-testid="goal-quality-gate" className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold text-violet-200">{t("goal.qualityGate.title")}</div>
            <div className="text-[10px] text-violet-100/70">
              {qualityGateRows.every((row) => row.passed)
                ? t("goal.qualityGate.ready")
                : t("goal.qualityGate.needsReview")}
            </div>
          </div>
          {qualitySummary != null && (
            <div
              data-testid="goal-quality-score"
              className="mb-2 rounded-md border border-white/5 bg-[#020617]/70 px-2 py-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-violet-100">
                  {t("goal.qualityScore.title")}
                </span>
                <span className="rounded-full border border-violet-300/30 bg-violet-400/10 px-2 py-0.5 text-[10px] text-violet-100">
                  {qualitySummary.score}/100 · {t(qualitySummary.labelKey)}
                </span>
              </div>
              <div className="mt-1 text-[10px] text-violet-100/70">
                {qualitySummary.missingLabelKeys.length > 0
                  ? `${t("goal.qualityScore.missing")}: ${qualitySummary.missingLabelKeys
                      .slice(0, 3)
                      .map((key) => t(key))
                      .join(" · ")}`
                  : t("goal.qualityScore.complete")}
              </div>
            </div>
          )}
          <div className="grid gap-1.5 sm:grid-cols-2">
            {qualityGateRows.map((row) => (
              <div
                key={row.id}
                className="rounded-md border border-white/5 bg-[#020617]/60 px-2 py-1.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-gray-100">{t(row.labelKey)}</span>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[9px] ${
                      row.passed
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-amber-400/40 bg-amber-500/15 text-amber-200"
                    }`}
                  >
                    {row.passed ? t("goal.qualityGate.pass") : t("goal.qualityGate.check")}
                  </span>
                </div>
                {row.detail !== "" && (
                  <div className="mt-0.5 line-clamp-2 text-[10px] text-gray-400">{row.detail}</div>
                )}
              </div>
            ))}
          </div>
          {missingQualityGateRows.length > 0 && latestModifiableArtifact != null && (
            <div className="mt-3 rounded-md border border-amber-400/20 bg-amber-500/10 p-2">
              <div className="text-[10px] text-amber-100/80">{t("goal.qualityRepairHint")}</div>
              <button
                type="button"
                data-testid="goal-quality-repair-button"
                onClick={runQualityRepairLatestArtifact}
                disabled={running}
                className="mt-2 rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.qualityRepairRun")}
              </button>
            </div>
          )}
        </div>
      )}
      {premiumEvidenceRows.length > 0 && (
        <div data-testid="goal-premium-readiness" className="rounded-lg border border-slate-500/20 bg-slate-500/5 p-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-100">{t("goal.premiumReadiness.title")}</div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                {premiumEvidenceReady
                  ? t("goal.premiumReadiness.candidate")
                  : t("goal.premiumReadiness.needsEvidence")}
              </div>
            </div>
            <span className="shrink-0 rounded-full border border-slate-300/20 bg-slate-400/10 px-2 py-0.5 text-[10px] text-slate-200">
              {premiumEvidencePassedCount}/{premiumEvidenceRows.length}
            </span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {premiumEvidenceRows.map((row) => (
              <div key={row.id} className="rounded-md border border-white/5 bg-[#020617]/50 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-gray-100">{t(row.labelKey)}</span>
                  <span
                    className={`rounded-full border px-1.5 py-0.5 text-[9px] ${
                      row.passed
                        ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-200"
                        : "border-slate-400/30 bg-slate-500/10 text-slate-300"
                    }`}
                  >
                    {row.passed ? t("goal.qualityGate.pass") : t("goal.qualityGate.check")}
                  </span>
                </div>
                <div className="mt-0.5 line-clamp-2 text-[10px] text-gray-400">{row.detail}</div>
              </div>
            ))}
          </div>
        </div>
      )}
      {(running || latestArtifact) && (
        <div
          data-testid="goal-release-readiness"
          className={`rounded-lg border p-3 ${
            releaseReadiness.status === "ready"
              ? "border-emerald-500/25 bg-emerald-500/8"
              : releaseReadiness.status === "running"
                ? "border-cyan-500/25 bg-cyan-500/8"
                : "border-amber-500/25 bg-amber-500/8"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold">{t(releaseReadiness.titleKey)}</div>
              <div className="mt-1 text-[10px] text-gray-300/80">{t(releaseReadiness.detailKey)}</div>
              {releaseReadiness.workspacePath && (
                <div className="mt-1 truncate text-[10px] text-gray-400">
                  {t("goal.latestOutcomePath")}: {releaseReadiness.workspacePath}
                </div>
              )}
              {releaseReadiness.executionHints.length > 0 && (
                <div data-testid="goal-release-run-hints" className="mt-2 space-y-1">
                  <div className="text-[10px] font-semibold text-gray-300">
                    {t("goal.releaseReadiness.runLabel")}
                  </div>
                  {releaseReadiness.executionHints.map((hint) => (
                    <code
                      key={hint}
                      className="block truncate rounded border border-white/10 bg-black/25 px-2 py-1 text-[10px] text-cyan-100"
                    >
                      {hint}
                    </code>
                  ))}
                </div>
              )}
              {releaseReadiness.missingLabelKeys.length > 0 && (
                <div className="mt-1 text-[10px] text-amber-100/80">
                  {t("goal.qualityScore.missing")}:{" "}
                  {releaseReadiness.missingLabelKeys
                    .slice(0, 3)
                    .map((key) => t(key))
                    .join(" · ")}
                </div>
              )}
            </div>
            {releaseReadiness.score != null && (
              <span className="shrink-0 rounded-full border border-current/25 px-2 py-0.5 text-[10px]">
                {releaseReadiness.score}/100
              </span>
            )}
          </div>
        </div>
      )}
      {latestArtifact && (
        <div
          data-testid="goal-live-evidence-panel"
          className="rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-cyan-100">{t("goal.liveEvidenceTitle")}</div>
              <div className="mt-1 text-[10px] text-gray-300/80">{t("goal.liveEvidenceHint")}</div>
              <div
                data-testid="goal-live-evidence-candidate-status"
                className={`mt-2 rounded-md border px-2 py-1 text-[10px] ${
                  liveProviderEvidenceCandidateReady
                    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-100"
                }`}
              >
                {liveProviderEvidenceCandidateReady
                  ? t("goal.liveEvidenceCandidateReady")
                  : t("goal.liveEvidenceCandidateNeedsMore")}
                {" · "}
                {t("goal.liveEvidenceDomains")}: {liveProviderEvidenceDomainCount}/2
                {" · "}
                {t("goal.liveEvidenceReadyDomains")}: {liveProviderEvidenceReadyDomainCount}/{Math.max(1, liveProviderEvidenceDomainCount)}
                {" · "}
                {t("goal.liveEvidenceModifications")}: {liveProviderEvidenceModificationCount}/{Math.max(1, liveProviderEvidenceDomainCount)}
              </div>
              <code className="mt-2 block truncate rounded border border-white/10 bg-black/25 px-2 py-1 text-[10px] text-cyan-100">
                npm run release:candidate -- --live-evidence /absolute/path/evidence.json
              </code>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              <button
                type="button"
                data-testid="goal-live-evidence-copy-button"
                onClick={copyLiveProviderEvidence}
                disabled={running || liveProviderEvidenceJson.trim() === ""}
                className="rounded-lg border border-cyan-300/40 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.liveEvidenceCopy")}
              </button>
              <button
                type="button"
                data-testid="goal-live-evidence-download-button"
                onClick={downloadLiveProviderEvidence}
                disabled={running || liveProviderEvidenceJson.trim() === ""}
                className="rounded-lg border border-cyan-300/25 bg-[#020617]/70 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.liveEvidenceDownload")}
              </button>
            </div>
          </div>
        </div>
      )}
      {latestArtifactNeedsFollowUp && (
        <div
          data-testid="goal-recovery-panel"
          className="rounded-lg border border-amber-500/25 bg-amber-500/8 p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-amber-200">{t("goal.recoveryTitle")}</div>
              <div className="mt-1 text-[10px] text-amber-100/75">
                {qualitySummary?.providerDelay ? t("goal.providerDelayHint") : t("goal.recoveryHint")}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <button
                type="button"
                data-testid="goal-retry-latest-button"
                onClick={runRetryLatestArtifact}
                disabled={running}
                className="rounded-lg border border-amber-400/40 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.retryLatestRun")}
              </button>
              <button
                type="button"
                data-testid="goal-open-artifact-button"
                onClick={() => void openLatestArtifactWorkspace()}
                disabled={running || latestArtifactWorkspacePath == null}
                className="rounded-lg border border-cyan-300/35 bg-cyan-400/10 px-3 py-2 text-xs font-medium text-cyan-100 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.openArtifact")}
              </button>
              <button
                type="button"
                data-testid="goal-show-diagnostics-button"
                onClick={focusArtifactDiagnostics}
                className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-white/10"
              >
                {t("goal.showFailureReason")}
              </button>
            </div>
          </div>
        </div>
      )}
      {latestModifiableArtifact && (
        <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold text-emerald-200">{t("goal.modifyLatestTitle")}</div>
              <div className="mt-1 text-[10px] text-gray-400">
                {t("goal.modifyLatestHint")}
              </div>
            </div>
            <button
              type="button"
              onClick={runModifyLatestArtifact}
              disabled={running || goal.trim() === ""}
              className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("goal.modifyLatestRun")}
            </button>
          </div>
          <div className="mt-3 rounded-md border border-emerald-400/10 bg-[#020617]/50 p-2">
            <label className="block text-[10px] font-semibold text-emerald-100" htmlFor="goal-artifact-qa-feedback">
              {t("goal.qaFeedbackTitle")}
            </label>
            <textarea
              id="goal-artifact-qa-feedback"
              data-testid="goal-artifact-qa-feedback"
              value={artifactQaFeedback}
              onChange={(event) => setArtifactQaFeedback(event.target.value)}
              placeholder={t("goal.qaFeedbackPlaceholder")}
              rows={2}
              className="mt-1 w-full resize-y rounded-lg border border-white/10 bg-[#020617]/80 px-2 py-1.5 text-xs text-gray-100 outline-none transition placeholder:text-gray-500 focus:border-emerald-300/60"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="text-[10px] text-gray-400">{t("goal.qaFeedbackHint")}</div>
              <button
                type="button"
                data-testid="goal-artifact-qa-repair-button"
                onClick={runArtifactQaFeedbackRepair}
                disabled={running || artifactQaFeedback.trim() === ""}
                className="shrink-0 rounded-lg border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-100 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {t("goal.qaFeedbackRun")}
              </button>
            </div>
          </div>
        </div>
      )}
      {artifactTraceRows.length > 0 && (
        <div data-testid="goal-artifact-trace" className="rounded-lg border border-slate-500/20 bg-slate-500/5 p-3">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-100">{t("goal.artifactTraceTitle")}</div>
              <div className="mt-0.5 text-[10px] text-gray-400">{t("goal.artifactTraceHint")}</div>
            </div>
            <span className="shrink-0 rounded-full border border-slate-300/20 px-2 py-0.5 text-[10px] text-slate-200">
              {artifactTraceRows.length}
            </span>
          </div>
          <div className="space-y-1.5">
            {artifactTraceRows.map((row) => (
              <div key={row.id} className="rounded-md border border-white/5 bg-[#020617]/60 px-2 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[11px] font-semibold text-gray-100">{row.role}</span>
                      {row.team !== "" && <span className="text-[9px] text-gray-500">{row.team}</span>}
                    </div>
                    {row.summary !== "" && (
                      <div className="mt-0.5 line-clamp-2 text-[10px] text-gray-400">{row.summary}</div>
                    )}
                  </div>
                  <span className="shrink-0 rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-[9px] text-gray-300">
                    {row.status}
                  </span>
                </div>
                <div className="mt-1 grid gap-1 sm:grid-cols-2">
                  {row.files.length > 0 && (
                    <div className="truncate text-[10px] text-slate-300">
                      {t("goal.artifactTraceFiles")}: {row.files.join(" · ")}
                    </div>
                  )}
                  {row.commands.length > 0 && (
                    <div className="truncate text-[10px] text-cyan-200">
                      {t("goal.artifactTraceCommands")}: {row.commands.join(" · ")}
                    </div>
                  )}
                  {row.evidence.length > 0 && (
                    <div className="truncate text-[10px] text-emerald-200">
                      {t("goal.artifactTraceEvidence")}: {row.evidence.join(" · ")}
                    </div>
                  )}
                  {row.timing.length > 0 && (
                    <div className="truncate text-[10px] text-amber-200">
                      {t("goal.artifactTraceTiming")}: {row.timing.join(" · ")}
                    </div>
                  )}
                  {row.workspace != null && (
                    <div className="truncate text-[10px] text-sky-200">
                      {t("goal.artifactTraceWorkspace")}: {row.workspace}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {latestArtifact && (
        <div className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold text-sky-200">{t("goal.latestOutcomeTitle")}</div>
              <div className="mt-1 line-clamp-2 text-[10px] text-gray-300">
                {String(latestArtifact.decision ?? "").trim() || t("goal.latestOutcomeNoSummary")}
              </div>
              {latestArtifactWorkspacePath && (
                <div className="mt-1 truncate text-[10px] text-sky-200/80">
                  {t("goal.latestOutcomePath")}: {latestArtifactWorkspacePath}
                </div>
              )}
              {(latestArtifact.next_actions ?? []).length > 0 && (
                <div className="mt-1 text-[10px] text-gray-400">
                  {t("goal.latestOutcomeNext")}: {(latestArtifact.next_actions ?? []).slice(0, 3).join(" · ")}
                </div>
              )}
            </div>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${RoundProgressStatusClass(
                String(latestArtifact.status ?? "").trim() === "completed"
                  ? "completed"
                  : String(latestArtifact.status ?? "").trim() === "failed"
                    ? "failed"
                    : "incomplete",
              )}`}
            >
              {String(latestArtifact.status ?? "").trim() || t("goal.roundProgressStatus.incomplete")}
            </span>
          </div>
        </div>
      )}
      {isTauri() && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-cyan-300">{t("goal.sequencerTitle")}</div>
            <button
              type="button"
              className="text-[10px] px-2 py-0.5 rounded border border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10"
              onClick={() => void refreshTodo()}
              disabled={todoLoading}
            >
              {todoLoading ? t("goal.loading") : t("goal.refresh")}
            </button>
          </div>
          {todo && todo.items && todo.items.length > 0 ? (
            <div className="max-h-40 overflow-auto space-y-1 text-xs">
              <div className="text-[11px] text-gray-400">
                {todo.main_task_name} · {todo.project_name}
              </div>
              {todo.items.map((item) => (
                <div
                  key={item.number}
                  className="flex items-start justify-between gap-2 border border-[#1f2937] rounded-md px-2 py-1 bg-[#020617]/60"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-gray-400">#{item.number}</span>
                      <span className="font-semibold">{item.title}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          item.status === "done"
                            ? "bg-emerald-500/20 text-emerald-300"
                            : item.status === "in_progress"
                              ? "bg-amber-500/20 text-amber-300"
                              : "bg-slate-500/20 text-slate-200"
                        }`}
                      >
                        {SequencerStatusLabel(t, item.status)}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-300 mt-0.5 whitespace-pre-line">
                      {item.description}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleMarkDone(item)}
                    disabled={item.status === "done" || running}
                    className="text-[10px] px-2 py-0.5 rounded bg-emerald-600/80 hover:bg-emerald-500 disabled:bg-gray-700 disabled:text-gray-400"
                  >
                    {item.status === "done" ? t("goal.sequencerDone") : t("goal.sequencerMarkDone")}
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[11px] text-gray-500">
              {todoLoading ? t("goal.loading") : t("goal.sequencerEmpty")}
            </div>
          )}
        </div>
      )}
      {renderRoundActionButtons("footer")}
    </div>
  );
}
