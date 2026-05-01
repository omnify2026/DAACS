import React from "react";
import type { CollaborationArtifact, CollaborationContribution } from "../../types/agent";
import { useCollaborationStore } from "../../stores/collaborationStore";
import { useI18n } from "../../i18n";
void React;

type DiscoveryChecklistItem = {
  target: string;
  path: string;
  symbol?: string;
  evidence?: string;
};

function normalizeLines(items: string[] | undefined): string[] {
  return (items ?? []).map((item) => String(item).trim()).filter((item) => item.length > 0);
}

function roundStatusLabel(t: (key: string) => string, status: string | undefined): string {
  switch ((status ?? "completed").trim().toLowerCase()) {
    case "completed":
      return t("board.statusCompleted");
    case "incomplete":
      return t("board.statusIncomplete");
    case "failed":
      return t("board.statusFailed");
    default:
      return status?.trim() || t("board.statusCompleted");
  }
}

function artifactTypeLabel(value: string | undefined): string {
  return (value ?? "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function contributionBadge(contribution: CollaborationContribution): string {
  const team = contribution.team?.replace(/_/g, " ") ?? "team";
  const role = contribution.agent_role ?? "agent";
  const status = contribution.status ?? "pending";
  return `${team} · ${role} · ${status}`;
}

function contributionFiles(contribution: CollaborationContribution): string[] {
  const details = contribution.details;
  if (!details || typeof details !== "object") return [];
  const fromFiles = Array.isArray(details.files) ? details.files : [];
  const fromNewFiles = Array.isArray(details.new_files) ? details.new_files : [];
  return [...fromFiles, ...fromNewFiles]
    .map((item) => String(item).trim())
    .filter((item, index, items) => item.length > 0 && items.indexOf(item) === index);
}

function contributionDetailLines(
  contribution: CollaborationContribution,
  key: string,
): string[] {
  const details = contribution.details;
  if (!details || typeof details !== "object") return [];
  const value = details[key];
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter((item) => item.length > 0)
    : [];
}

function contributionDetailText(
  contribution: CollaborationContribution,
  key: string,
): string {
  const details = contribution.details;
  if (!details || typeof details !== "object") return "";
  const value = details[key];
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function contributionDiscoveryChecklist(
  contribution: CollaborationContribution,
): DiscoveryChecklistItem[] {
  const details = contribution.details;
  if (!details || typeof details !== "object") return [];
  const value = details.discovery_checklist;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
    .map((item) => ({
      target: typeof item.target === "string" ? item.target.trim() : "",
      path: typeof item.path === "string" ? item.path.trim() : "",
      symbol: typeof item.symbol === "string" ? item.symbol.trim() : "",
      evidence: typeof item.evidence === "string" ? item.evidence.trim() : "",
    }))
    .filter((item) => item.target.length > 0 && item.path.length > 0);
}

function artifactQualitySummary(artifact: CollaborationArtifact | undefined): {
  verdicts: string[];
  scores: string[];
  checksCount: number;
  evidenceCount: number;
} {
  const contributions = artifact?.contributions ?? [];
  const verdicts = contributions
    .map((contribution) => contributionDetailText(contribution, "verdict"))
    .filter((item, idx, items) => item !== "" && items.indexOf(item) === idx);
  const scores = contributions
    .map((contribution) => contributionDetailText(contribution, "score"))
    .filter((item, idx, items) => item !== "" && items.indexOf(item) === idx);
  const checksCount = contributions.reduce(
    (total, contribution) => total + contributionDetailLines(contribution, "checks").length,
    0,
  );
  const evidenceCount = contributions.reduce(
    (total, contribution) => total + contributionDetailLines(contribution, "evidence").length,
    0,
  );
  return { verdicts, scores, checksCount, evidenceCount };
}

function artifactQualityTextBlob(artifact: CollaborationArtifact | undefined): string {
  if (artifact == null) return "";
  const parts: string[] = [
    artifact.status ?? "",
    artifact.decision ?? "",
    artifact.project_fit_summary ?? "",
    ...normalizeLines(artifact.open_questions),
    ...normalizeLines(artifact.next_actions),
  ];
  for (const contribution of artifact.contributions ?? []) {
    parts.push(contribution.status ?? "");
    parts.push(contribution.summary ?? "");
    parts.push(...normalizeLines(contribution.open_questions));
    parts.push(...normalizeLines(contribution.next_actions));
    if (contribution.details != null) {
      parts.push(JSON.stringify(contribution.details));
    }
  }
  return parts.join("\n").toLowerCase();
}

function scoreIsBelowReady(score: string): boolean {
  const text = score.trim().toLowerCase();
  if (text === "") return false;
  const ratioMatch = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (ratioMatch != null) {
    const earned = Number(ratioMatch[1]);
    const total = Number(ratioMatch[2]);
    return Number.isFinite(earned) && Number.isFinite(total) && total > 0 && earned / total < 0.85;
  }
  const percentMatch = text.match(/(\d+(?:\.\d+)?)\s*%/);
  if (percentMatch != null) {
    const percent = Number(percentMatch[1]);
    return Number.isFinite(percent) && percent < 85;
  }
  const plainNumberMatch = text.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (plainNumberMatch != null) {
    const value = Number(plainNumberMatch[1]);
    return Number.isFinite(value) && value > 20 && value <= 100 && value < 85;
  }
  return false;
}

function artifactHasBlockingQualitySignal(
  artifact: CollaborationArtifact | undefined,
  qualitySummary: ReturnType<typeof artifactQualitySummary>,
): boolean {
  const verdictText = qualitySummary.verdicts.join("\n").toLowerCase();
  const text = artifactQualityTextBlob(artifact);
  const hasBlockingVerdict = /\b(fail(?:ed|ing)?|needs[_\s-]*rework|rework|blocked|incomplete|partial|not\s+ready|insufficient|missing|open\s+risk|risk)\b|실패|재작업|수정\s*필요|차단|미완|부분\s*완료|부족|보류/.test(
    verdictText,
  );
  const delayPattern = /\b(timeout|timed out|quota|rate limit|capacity|exhausted|overloaded|retry)\b/;
  const hasProviderDelay =
    delayPattern.test(text) ||
    /\bprovider\b.{0,48}\b(error|fail(?:ed|ure)?|unavailable|down|timeout|timed out|retry)\b/.test(text) ||
    /\b(error|fail(?:ed|ure)?|unavailable|down|timeout|timed out|retry)\b.{0,48}\bprovider\b/.test(text);
  const hasLowScore = qualitySummary.scores.some(scoreIsBelowReady);
  return hasBlockingVerdict || hasProviderDelay || hasLowScore;
}

function artifactReadinessSummary(
  artifact: CollaborationArtifact | undefined,
  qualitySummary: ReturnType<typeof artifactQualitySummary>,
): {
  ready: boolean;
  labelKey: string;
  detailKey: string;
} {
  const status = (artifact?.status ?? "").trim().toLowerCase();
  const hasEvidence =
    qualitySummary.evidenceCount > 0 ||
    qualitySummary.checksCount > 0 ||
    qualitySummary.scores.length > 0 ||
    qualitySummary.verdicts.length > 0;
  const hasOpenQuestions = normalizeLines(artifact?.open_questions).length > 0;
  const hasBlockingQualitySignal = artifactHasBlockingQualitySignal(artifact, qualitySummary);
  const ready = status === "completed" && hasEvidence && !hasOpenQuestions && !hasBlockingQualitySignal;
  return {
    ready,
    labelKey: ready ? "board.readinessReady" : "board.readinessNeedsWork",
    detailKey: ready ? "board.readinessReadyDetail" : "board.readinessNeedsWorkDetail",
  };
}

function discoveryTargetLabel(
  t: (key: string) => string,
  target: string,
): string {
  const key = `board.discoveryTarget.${target}`;
  const translated = t(key);
  if (translated !== key) return translated;
  return target.replace(/[_-]+/g, " ").trim();
}

export function SharedBoardPanelView({
  artifacts,
  sharedGoal,
}: {
  artifacts: CollaborationArtifact[];
  sharedGoal: string;
}) {
  const { t } = useI18n();
  const latest = artifacts[artifacts.length - 1];
  const qualitySummary = artifactQualitySummary(latest);
  const readinessSummary = artifactReadinessSummary(latest, qualitySummary);
  const hasQualitySummary =
    qualitySummary.verdicts.length > 0 ||
    qualitySummary.scores.length > 0 ||
    qualitySummary.checksCount > 0 ||
    qualitySummary.evidenceCount > 0;

  return (
    <div
      className="bg-[#111827]/88 border border-[#2A2A4A] rounded-xl p-4 text-white shadow-xl backdrop-blur-md"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="text-sm font-semibold text-cyan-300 mb-3">{t("board.title")}</div>
      {!latest && <div className="text-sm text-gray-400">{t("board.noArtifact")}</div>}
      {latest && (
        <div className="space-y-4 text-sm max-h-72 overflow-auto pr-1">
          {sharedGoal.trim() && (
            <div>
              <div className="text-gray-400">{t("board.currentGoal")}</div>
              <div>{sharedGoal}</div>
            </div>
          )}
          {latest.refined_goal?.trim() && (
            <div>
              <div className="text-gray-400">{t("board.refinedGoal")}</div>
              <div>{latest.refined_goal}</div>
            </div>
          )}
          <div>
            <div className="text-gray-400">{t("board.roundStatus")}</div>
            <div className="flex flex-wrap items-center gap-2">
              <span>{roundStatusLabel(t, latest.status)}</span>
              {latest.artifact_type?.trim() && (
                <span className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] uppercase tracking-[0.12em] text-cyan-200">
                  {t("board.artifactType")}: {artifactTypeLabel(latest.artifact_type)}
                </span>
              )}
            </div>
          </div>
          {hasQualitySummary && (
            <div className="rounded-lg border border-amber-400/20 bg-amber-500/8 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span
                  className={`rounded-full border px-2 py-1 text-[11px] font-semibold ${
                    readinessSummary.ready
                      ? "border-emerald-400/40 bg-emerald-500/10 text-emerald-200"
                      : "border-amber-400/40 bg-amber-500/10 text-amber-200"
                  }`}
                >
                  {t(readinessSummary.labelKey)}
                </span>
                <span className="text-[11px] text-slate-400">{t(readinessSummary.detailKey)}</span>
              </div>
              <div className="text-[11px] uppercase tracking-[0.14em] text-amber-200">
                {t("board.qualitySummary")}
              </div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                {qualitySummary.verdicts.map((verdict) => (
                  <span
                    key={`verdict-${verdict}`}
                    className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-cyan-200"
                  >
                    {t("board.verdict")}: {verdict}
                  </span>
                ))}
                {qualitySummary.scores.map((score) => (
                  <span
                    key={`score-${score}`}
                    className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-amber-200"
                  >
                    {t("board.score")}: {score}
                  </span>
                ))}
                {qualitySummary.checksCount > 0 && (
                  <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-2 py-1 text-emerald-200">
                    {t("board.checks")}: {qualitySummary.checksCount}
                  </span>
                )}
                {qualitySummary.evidenceCount > 0 && (
                  <span className="rounded-full border border-violet-400/40 bg-violet-500/10 px-2 py-1 text-violet-200">
                    {t("board.evidence")}: {qualitySummary.evidenceCount}
                  </span>
                )}
              </div>
            </div>
          )}
          {latest.project_fit_summary?.trim() && (
            <div>
              <div className="text-gray-400">{t("board.projectFit")}</div>
              <div>{latest.project_fit_summary}</div>
            </div>
          )}
          {normalizeLines(latest.deliverables).length > 0 && (
            <div>
              <div className="text-gray-400">{t("board.deliverables")}</div>
              <ul className="list-disc pl-5">
                {normalizeLines(latest.deliverables).map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {normalizeLines(latest.acceptance_criteria).length > 0 && (
            <div>
              <div className="text-gray-400">{t("board.acceptanceCriteria")}</div>
              <ul className="list-disc pl-5">
                {normalizeLines(latest.acceptance_criteria).map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <div className="text-gray-400">{t("board.decision")}</div>
            <div>{latest.decision}</div>
          </div>
          <div>
            <div className="text-gray-400">{t("board.openQuestions")}</div>
            {normalizeLines(latest.open_questions).length === 0 ? (
              <div className="text-xs text-gray-500">{t("board.none")}</div>
            ) : (
              <ul className="list-disc pl-5">
                {normalizeLines(latest.open_questions).map((question, idx) => (
                  <li key={idx}>{question}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-gray-400">{t("board.nextActions")}</div>
            {normalizeLines(latest.next_actions).length === 0 ? (
              <div className="text-xs text-gray-500">{t("board.none")}</div>
            ) : (
              <ul className="list-disc pl-5">
                {normalizeLines(latest.next_actions).map((action, idx) => (
                  <li key={idx}>{action}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <div className="text-gray-400 mb-2">{t("board.contributions")}</div>
            {(latest.contributions ?? []).length === 0 ? (
              <div className="text-xs text-gray-500">{t("board.noContributions")}</div>
            ) : (
              <div className="space-y-2">
                {(latest.contributions ?? []).map((contribution, idx) => {
                  const files = contributionFiles(contribution);
                  const openQuestions = normalizeLines(contribution.open_questions);
                  const nextActions = normalizeLines(contribution.next_actions);
                  const verdict = contributionDetailText(contribution, "verdict");
                  const score = contributionDetailText(contribution, "score");
                  const checks = contributionDetailLines(contribution, "checks");
                  const evidence = contributionDetailLines(contribution, "evidence");
                  const deploymentPlan = contributionDetailLines(contribution, "deployment_plan");
                  const healthChecks = contributionDetailLines(contribution, "health_checks");
                  const monitoringSetup = contributionDetailLines(contribution, "monitoring_setup");
                  const acceptanceCriteria = contributionDetailLines(contribution, "acceptance_criteria");
                  const assumptions = contributionDetailLines(contribution, "assumptions");
                  const deliverables = contributionDetailLines(contribution, "deliverables");
                  const roleAssignmentNotes = contributionDetailLines(contribution, "role_assignment_notes");
                  const reviewFocus = contributionDetailLines(contribution, "review_focus");
                  const verificationFocus = contributionDetailLines(contribution, "verification_focus");
                  const opsFocus = contributionDetailLines(contribution, "ops_focus");
                  const refinedGoal = contributionDetailText(contribution, "refined_goal");
                  const discoveryChecklist = contributionDiscoveryChecklist(contribution);
                  return (
                    <div key={`${contribution.task_id ?? contribution.agent_role ?? "contrib"}-${idx}`} className="rounded-lg border border-[#2A2A4A] bg-[#0F172A]/70 p-3">
                      <div className="text-[11px] uppercase tracking-[0.18em] text-cyan-200">
                        {contributionBadge(contribution)}
                      </div>
                      <div className="mt-1 text-sm text-white">{contribution.summary ?? t("board.noSummary")}</div>
                      {discoveryChecklist.length > 0 && (
                        <div className="mt-3 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
                          <div className="text-[11px] uppercase tracking-[0.14em] text-cyan-200">
                            {t("board.discoveryChecklist")}
                          </div>
                          <div className="mt-2 space-y-2">
                            {discoveryChecklist.map((item, itemIdx) => (
                              <div key={`${item.target}-${item.path}-${itemIdx}`} className="rounded-md border border-[#2A2A4A] bg-[#020617]/70 p-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200">
                                    {discoveryTargetLabel(t, item.target)}
                                  </span>
                                  <code className="text-[11px] break-all text-cyan-100">{item.path}</code>
                                </div>
                                {item.symbol && (
                                  <div className="mt-1 text-[11px] text-slate-300">
                                    {t("board.discoverySymbol")}: <code className="break-all text-slate-100">{item.symbol}</code>
                                  </div>
                                )}
                                {item.evidence && (
                                  <div className="mt-1 text-[11px] text-slate-400">
                                    {t("board.discoveryEvidence")}: {item.evidence}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {refinedGoal && (
                        <div className="mt-2 text-xs text-slate-300">
                          {t("board.refinedGoal")}: {refinedGoal}
                        </div>
                      )}
                      {(verdict || score) && (
                        <div className="mt-2 flex flex-wrap gap-2 text-[11px] uppercase tracking-[0.12em]">
                          {verdict && (
                            <span className="rounded-full border border-cyan-400/40 bg-cyan-500/10 px-2 py-1 text-cyan-200">
                              {t("board.verdict")}: {verdict}
                            </span>
                          )}
                          {score && (
                            <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-1 text-amber-200">
                              {t("board.score")}: {score}
                            </span>
                          )}
                        </div>
                      )}
                      {files.length > 0 && (
                        <div className="mt-2 text-xs text-slate-300">
                          {t("board.files")}: {files.join(", ")}
                        </div>
                      )}
                      {checks.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.checks")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {checks.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {evidence.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.evidence")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {evidence.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {acceptanceCriteria.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.acceptanceCriteria")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {acceptanceCriteria.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {assumptions.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.assumptions")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {assumptions.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {roleAssignmentNotes.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.roleAssignmentNotes")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {roleAssignmentNotes.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {deliverables.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.deliverables")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {deliverables.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {reviewFocus.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.reviewFocus")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {reviewFocus.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {verificationFocus.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.verificationFocus")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {verificationFocus.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {opsFocus.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.opsFocus")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {opsFocus.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {deploymentPlan.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.deploymentPlan")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {deploymentPlan.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {healthChecks.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.healthChecks")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {healthChecks.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {monitoringSetup.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.monitoring")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {monitoringSetup.map((item, itemIdx) => (
                              <li key={itemIdx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {openQuestions.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.openQuestions")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {openQuestions.map((question, questionIdx) => (
                              <li key={questionIdx}>{question}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {nextActions.length > 0 && (
                        <div className="mt-2">
                          <div className="text-[11px] text-gray-400">{t("board.nextActions")}</div>
                          <ul className="list-disc pl-5 text-xs text-slate-200">
                            {nextActions.map((action, actionIdx) => (
                              <li key={actionIdx}>{action}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function SharedBoardPanel() {
  const { artifacts, sharedGoal } = useCollaborationStore();
  return <SharedBoardPanelView artifacts={artifacts} sharedGoal={sharedGoal} />;
}
