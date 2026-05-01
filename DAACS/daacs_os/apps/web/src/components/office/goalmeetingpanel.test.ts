import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runGoalMeetingPanelRegressionTests(): Promise<void> {
  const source = readFileSync(path.join(currentDir, "GoalMeetingPanel.tsx"), "utf8");

  assert(
    source.includes("createCollaborationSession,") &&
      source.includes("startCollaborationRound,"),
    "GoalMeetingPanel should import collaboration session helpers for web Start Round execution",
  );

  assert(
    source.includes("parsePmTaskLists,") &&
      source.includes("BuildPmPlanningContribution(") &&
      source.includes("roundContributions") &&
      source.includes("BuildCascadeExecutionContribution(") &&
      source.includes("EmitLocalAgentEvent(\"AGENT_MESSAGE_SENT\"") &&
      source.includes("EmitLocalAgentEvent(taskEventType") &&
      source.includes("EmitLocalAgentEvent(\"AGENT_TOOL_CALL\"") &&
      source.includes("EmitLocalAgentEvent(\"AGENT_STATUS_UPDATED\"") &&
      source.includes("onAgentExecutionComplete: (completion) =>") &&
      source.includes("const roundStatus = BuildCascadeRoundStatus(cascadeOk, roundContributions);") &&
      source.includes("status: roundStatus") &&
      source.includes("BuildCascadeRoundDecision(cascadeOk, roundContributions)") &&
      source.includes('roundStatus === "incomplete"') &&
      source.includes('t("goal.incomplete")'),
    "GoalMeetingPanel Tauri path should preserve PM planning output, map cascade completions into contributions, persist local trace events, and mark incomplete desktop rounds explicitly",
  );

  assert(
    source.includes("let activeSessionId = collaborationSessionId;") &&
      source.includes("if (!collaborationSessionId || collaborationProjectId !== projectId) {") &&
      source.includes("const session = await createCollaborationSession(projectId, goalText, [") &&
      source.includes("const completed = await startCollaborationRound(") &&
      source.includes("activeSessionId,") &&
      source.includes("[\"development_team\", \"review_team\"]") &&
      source.includes("projectCwd: collaborationWorkspace") &&
      source.includes("setCollaborationSession(projectId, session.session_id, session.shared_goal);") &&
      source.includes("const roundStatus = completed.round.status ?? completed.status;"),
    "GoalMeetingPanel web Start Round should reuse the current collaboration session when available and execute rounds across development and review teams",
  );

  assert(
    source.includes("stopCollaborationSession,") &&
      source.includes("signal: abortController.signal") &&
      source.includes("stopWebSessionIfNeeded();"),
    "GoalMeetingPanel web Stop should propagate AbortSignal to collaboration requests and best-effort stop any created session",
  );

  assert(
    source.includes("completed.artifact") &&
      source.includes("completed.round.round_id") &&
      source.includes('t("goal.checkSharedBoard")') &&
      !source.includes("const created = await createExecutionPlan(projectId, goalText, addNotification);"),
    "GoalMeetingPanel should publish collaboration round artifacts to the shared board and distinguish incomplete rounds from successful ones",
  );

  assert(
    source.includes("const [roundProgress, setRoundProgress] = useState<RoundProgressEntry[]>([])") &&
      source.includes("UpsertRoundProgressEntry(") &&
      source.includes("BuildRoundOutcomeSummary(t, running, roundProgress, latestArtifact)") &&
      source.includes('data-testid="goal-outcome-banner"') &&
      source.includes("BuildRoundProgressEntryFromCompletion(completion)") &&
      source.includes('t("goal.roundProgressTitle")') &&
      source.includes('t("goal.roundProgressFinal")') &&
      source.includes("RoundProgressStatusLabel(t, item.status)") &&
      source.includes("FormatRoundProgressTimestamp(item.updatedAt)") &&
      source.includes("BuildRoundProgressEntryFromAgentMessage(msg)") &&
      source.includes('data-testid="goal-round-progress"') &&
      source.includes("upsertRoundProgress({") &&
      source.includes("id: \"agent-cascade\""),
    "GoalMeetingPanel should expose a visible round-progress timeline with agent start/end traces without changing sequencer execution decisions",
  );

  assert(
      source.includes("BuildQualityGateRows(") &&
      source.includes("BuildArtifactQualitySummary(") &&
      source.includes("BuildReleaseReadinessSummary(") &&
      source.includes("BuildPremiumProductEvidenceRows(") &&
      source.includes("LooksLikePremiumArtifactRequest(") &&
      source.includes("LooksLikeUserFacingWebArtifact(") &&
      source.includes("HasExecutableArtifactEvidence(") &&
      source.includes("ExtractArtifactRequirementCoverage(") &&
      source.includes("BuildAdvancedUxEvidenceSummary(") &&
      source.includes('labelKey: "goal.qualityGate.requirements"') &&
      source.includes('labelKey: "goal.qualityGate.ux"') &&
      source.includes('labelKey: "goal.qualityGate.premium"') &&
      source.includes("const hasMissingGateEvidence = InRows.some((row) => !row.passed);") &&
      source.includes("const score = hasMissingGateEvidence ? Math.min(statusScore, 84) : statusScore;") &&
      source.includes("hasVerifierContribution && (!isUserFacingWebArtifact || hasExecutableEvidence)") &&
      source.includes("data-testid=\"goal-quality-score\"") &&
      source.includes('t("goal.qualityScore.title")') &&
      source.includes("ExtractArtifactEvidence(") &&
      source.includes('"ui_ux_evidence"') &&
      source.includes('"browser_evidence"') &&
      source.includes("BuildMissingRequiredUserFacingUxEvidence(") &&
      source.includes("missingRequiredUxEvidence.length === 0") &&
      source.includes("search control") &&
      source.includes("favorite persistence") &&
      source.includes("instant recompute") &&
      source.includes("ExtractArtifactRequirementCoverage(InArtifact)") &&
      source.includes("command: InCompletion.command") &&
      source.includes("\\bdashboard\\s+ui\\b") &&
      source.includes("HasContributionRole(InArtifact, \"reviewer\")") &&
      source.includes("HasContributionRole(InArtifact, \"verifier\")") &&
      source.includes('data-testid="goal-quality-gate"') &&
      source.includes('data-testid="goal-premium-readiness"') &&
      source.includes('data-testid="goal-release-readiness"') &&
      source.includes('"goal.premiumReadiness.title"') &&
      source.includes('"goal.premiumReadiness.accessibility"') &&
      source.includes('"goal.premiumReadiness.correctionPath"') &&
      source.includes('"goal.premiumReadiness.scanability"') &&
      source.includes('"goal.premiumReadiness.layoutOverflow"') &&
      source.includes("viewport/action fit") &&
      source.includes("no clipped primary actions") &&
      source.includes('"goal.premiumReadiness.referenceArchetype"') &&
      source.includes('"goal.premiumReadiness.referenceSourceLevel"') &&
      source.includes("source_level") &&
      source.includes("reference_quality_bar") &&
      source.includes('"goal.premiumReadiness.referenceAdaptation"') &&
      source.includes('"goal.releaseReadiness.readyTitle"') &&
      source.includes('t("goal.qualityGate.title")') &&
      source.includes('t("goal.qualityGate.needsReview")'),
    "GoalMeetingPanel should pin a visible artifact quality gate so users can see files, review evidence, verification evidence, and next actions",
  );

  assert(
    source.includes("BuildArtifactCompletionNotification(") &&
      source.includes("const roundStatus = NormalizeArtifactStatus(InRoundStatus)") &&
      source.includes("const artifactStatus = NormalizeArtifactStatus(InArtifact?.status)") &&
      source.includes("const hasReadyArtifact =") &&
      source.includes("const hasCompletedButNeedsRepair =") &&
      source.includes('t("goal.completionReadyToast")') &&
      source.includes('t("goal.completionNeedsRepairToast")') &&
      source.includes('action: "open_goal_recovery"') &&
      source.includes('actionLabel: t("goal.openContinuePanel")') &&
      source.includes('t("goal.qualityGate.needsReview")') &&
      source.includes("const roundArtifact: CollaborationArtifact =") &&
      source.includes("addNotification(BuildArtifactCompletionNotification(t, roundArtifact, roundStatus))") &&
      source.includes("addNotification(BuildArtifactCompletionNotification(t, completed.artifact, roundStatus))"),
    "GoalMeetingPanel should notify whether a finished artifact is ready to use or still needs scoped repair instead of using a generic completed toast",
  );

  assert(
      source.includes("BuildArtifactTraceRows(") &&
      source.includes("BuildContributionTimingEvidence(") &&
      source.includes("FormatTraceDurationMs(") &&
      source.includes("ExtractStringListFromDetails(") &&
      source.includes('data-testid="goal-artifact-trace"') &&
      source.includes('t("goal.artifactTraceTitle")') &&
      source.includes('t("goal.artifactTraceCommands")') &&
      source.includes('t("goal.artifactTraceEvidence")') &&
      source.includes('t("goal.artifactTraceTiming")'),
    "GoalMeetingPanel should expose per-agent artifact trace details with files, commands, evidence, and timing",
  );

  assert(
    source.includes("BuildRetryLatestGoalText(") &&
      source.includes("BuildArtifactRepairContextBlocks(") &&
      source.includes("Keep the scope narrow: use the previous files, missing quality gates, previous evidence, and open next actions as the repair contract.") &&
      source.includes("Previous quality and verification context:") &&
      source.includes("Previous requirement coverage:") &&
      source.includes("Previous verifier/reviewer evidence:") &&
      source.includes("LooksLikeProviderDelayArtifact(") &&
      source.includes('data-testid="goal-recovery-panel"') &&
      source.includes("latestArtifactHasMissingQualityGate") &&
      source.includes("latestArtifactStatus !== \"completed\" || latestArtifactHasMissingQualityGate") &&
      source.includes('t("goal.providerDelayHint")') &&
      source.includes('window.addEventListener("daacs:open-goal-recovery", handler)') &&
      source.includes('data-testid="goal-retry-latest-button"') &&
      source.includes('data-testid="goal-open-artifact-button"') &&
      source.includes('data-testid="goal-show-diagnostics-button"') &&
      source.includes("openPathInFileManager(") &&
      source.includes("runRetryLatestArtifact") &&
      source.includes('t("goal.retryLatestRun")'),
    "GoalMeetingPanel should surface provider-timeout/partial artifacts as recoverable latest-artifact repairs with visible continue, open, and diagnostics actions instead of silent completion",
  );

  assert(
    source.includes("const isUiOnlyWorkflowRuntime =") &&
      source.includes("isAppApiStubEnabled") &&
      source.includes("run:abort_ui_only_runtime") &&
      source.includes('data-testid="goal-ui-only-runtime-warning"') &&
      source.includes('t("goal.uiOnlyRuntimeWarning")') &&
      source.includes('t("goal.uiOnlyRuntimeAction")') &&
      source.includes("disabled={running || isUiOnlyWorkflowRuntime}"),
    "GoalMeetingPanel should make web-only preview mode visibly non-executable before users start a real artifact round",
  );

  assert(
    source.includes("BuildQualityRepairGoalText(") &&
      source.includes("## REPAIR LATEST ARTIFACT QUALITY") &&
      source.includes("Repair only the missing quality gates below, then rerun executable verification.") &&
      source.includes("Do not edit generated files manually outside this repair flow.") &&
      source.includes("Missing quality gates:") &&
      source.includes("const missingQualityGateRows = qualityGateRows.filter((row) => !row.passed);") &&
      source.includes("runQualityRepairLatestArtifact") &&
      source.includes('data-testid="goal-quality-repair-button"') &&
      source.includes('t("goal.qualityRepairRun")') &&
      source.includes('t("goal.qualityRepairHint")'),
    "GoalMeetingPanel should route missing quality-gate evidence back into a scoped same-artifact repair instead of requiring manual edits",
  );

  assert(
      source.includes("BuildModifyExistingGoalText(") &&
      source.includes("LooksLikeModifyExistingGoal(") &&
      source.includes("ExtractArtifactWorkspacePath(") &&
      source.includes("artifact_workspace: executionWorkspace") &&
      source.includes("workspace_path: executionWorkspace") &&
      source.includes("output_path: executionWorkspace") &&
      source.includes("ExtractArtifactWorkspaceCandidatesFromText(") &&
      source.includes("JoinPathSegments(path, name)") &&
      source.includes("## MODIFY EXISTING ARTIFACT") &&
      source.includes("Do not start a fresh scaffold") &&
      source.includes("Preserve the current artifact and change only what the user asks to change.") &&
      source.includes("Use previous missing quality gates, requirement coverage, and verifier evidence as the repair contract.") &&
      source.includes("Previous quality and verification context:") &&
      source.includes("Previous requirement coverage:") &&
      source.includes("Previous verifier/reviewer evidence:") &&
      source.includes("BuildQualityGateRows(InArtifact, files, workspace)") &&
      source.includes("BuildArtifactQualitySummary(InArtifact, qualityRows)") &&
      source.includes("ExtractArtifactRequirementCoverage(InArtifact)") &&
      source.includes("ExtractArtifactEvidence(InArtifact)") &&
      source.includes("const latestArtifact = collaborationArtifacts[collaborationArtifacts.length - 1] ?? null;") &&
      source.includes("latestArtifactFiles.length > 0 || latestArtifactWorkspacePath != null") &&
      source.includes("shouldAutoModifyLatestArtifact") &&
      source.includes("wantsExistingArtifactModification") &&
      source.includes("executionWorkspace = latestArtifactWorkspacePath;") &&
      source.includes("runModifyLatestArtifact") &&
      source.includes('t("goal.modifyLatestTitle")') &&
      source.includes('t("goal.modifyLatestRun")') &&
      source.includes('t("goal.latestOutcomeTitle")') &&
      source.includes('t("goal.latestOutcomePath")'),
    "GoalMeetingPanel should provide explicit and automatic latest-artifact modification paths with visible latest-result context",
  );

  assert(
    source.includes("BuildArtifactQaFeedbackGoalText(") &&
      source.includes("## REPAIR LATEST ARTIFACT FROM QA FEEDBACK") &&
      source.includes("Repair only the user-reported QA issue below, preserve existing behavior, then rerun executable verification.") &&
      source.includes("## User QA feedback") &&
      source.includes("const [artifactQaFeedback, setArtifactQaFeedback] = useState(\"\");") &&
      source.includes("runArtifactQaFeedbackRepair") &&
      source.includes('data-testid="goal-artifact-qa-feedback"') &&
      source.includes('data-testid="goal-artifact-qa-repair-button"') &&
      source.includes('t("goal.qaFeedbackRun")') &&
      source.includes('t("goal.qaFeedbackHint")'),
    "GoalMeetingPanel should let user-found artifact QA issues flow back into same-artifact repair with prior evidence",
  );

  assert(
    source.includes("BuildLiveProviderEvidenceJson(") &&
      source.includes("copyLiveProviderEvidence") &&
      source.includes("downloadLiveProviderEvidence") &&
      source.includes("navigator.clipboard.writeText(liveProviderEvidenceJson)") &&
      source.includes("URL.createObjectURL(blob)") &&
      source.includes('data-testid="goal-live-evidence-panel"') &&
      source.includes('data-testid="goal-live-evidence-copy-button"') &&
      source.includes('data-testid="goal-live-evidence-download-button"') &&
      source.includes('data-testid="goal-live-evidence-candidate-status"') &&
      source.includes('t("goal.liveEvidenceCopy")') &&
      source.includes('t("goal.liveEvidenceDownload")') &&
      source.includes("liveProviderEvidenceCandidateReady") &&
      source.includes("IsLiveProviderEvidenceDomainCandidateReady(") &&
      source.includes("liveProviderEvidenceReadyDomainCount") &&
      source.includes('t("goal.liveEvidenceReadyDomains")') &&
      source.includes("HasLiveProviderExecutableEvidence(") &&
      source.includes("HasLiveProviderRoleEvidence(") &&
      source.includes("quality_score") &&
      source.includes('role: "pm"') &&
      source.includes("...traceRows.map"),
    "GoalMeetingPanel should expose completed artifact trace as live-provider release evidence JSON without changing execution flow",
  );

  assert(
    source.includes("prepareArtifactWorkspace,") &&
      source.includes("function LooksLikeFreshArtifactGoal(") &&
      source.includes("setTodo(null);") &&
      source.includes("const wantsFreshArtifactWorkspace = LooksLikeFreshArtifactGoal(g);") &&
      source.includes("const preparedWorkspace = await prepareArtifactWorkspace(workspace, g);") &&
      source.includes("executionWorkspace") &&
      source.includes("BuildModifyExistingGoalText("),
    "GoalMeetingPanel should isolate fresh artifact runs in a new child workspace while preserving explicit modification runs",
  );

  assert(
    source.includes('const [workspaceDraft, setWorkspaceDraft] = useState<string>(() =>') &&
      source.includes('setSavedWorkspacePath(trimmedWorkspacePath === "" ? null : trimmedWorkspacePath, projectName);') &&
      source.includes('placeholder={t("goal.workspacePathPlaceholder")}') &&
      source.includes('t("goal.saveWorkspacePath")'),
    "GoalMeetingPanel should expose a web workspace-path save flow so browser users can bind collaboration rounds to a real project directory",
  );

  assert(
    source.includes('const renderRoundActionButtons = (placement: "primary" | "footer") =>') &&
      source.includes('data-testid={`goal-round-actions-${placement}`}') &&
      source.includes('{renderRoundActionButtons("primary")}') &&
      source.includes('{renderRoundActionButtons("footer")}'),
    "GoalMeetingPanel should keep a start/stop action near the goal form so completed run history cannot bury the next round control",
  );

  assert(
    source.includes("const [goalInputError, setGoalInputError] = useState(false);") &&
      source.includes("const goalInputRef = useRef<HTMLTextAreaElement | null>(null);") &&
      source.includes("setGoalInputError(true);") &&
      source.includes("goalInputRef.current?.focus();") &&
      source.includes('aria-invalid={goalInputError}') &&
      source.includes('data-testid="goal-input-error"'),
    "GoalMeetingPanel should make an empty-goal start attempt visible and focus the goal input instead of looking like PM did nothing",
  );

  assert(
    source.includes('if (collaborationWorkspace === "") {') &&
      source.includes('message: t("goal.selectWorkspaceFirst")') &&
      source.includes("projectCwd: collaborationWorkspace"),
    "GoalMeetingPanel should block web collaboration rounds without a saved workspace path instead of dispatching low-context runs",
  );

  console.log("GoalMeetingPanel web collaboration routing regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runGoalMeetingPanelRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
