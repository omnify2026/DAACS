import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(currentDir, "../..");

export async function runThirdPhaseReadinessRegressionTests(): Promise<void> {
  const packageJson = JSON.parse(readFileSync(path.join(webRoot, "package.json"), "utf8"));
  assert(
    packageJson.scripts?.["release:preflight"]?.includes("verify-third-phase-readiness.mjs --preflight") &&
      packageJson.scripts?.["release:candidate"]?.includes("verify-third-phase-readiness.mjs --candidate"),
    "package.json should expose third-phase preflight and candidate release gates",
  );

  const preflightOutput = execFileSync(
    process.execPath,
    ["scripts/verify-third-phase-readiness.mjs", "--preflight"],
    { cwd: webRoot, encoding: "utf8" },
  );
  assert(
    preflightOutput.includes("third-phase static preflight passed"),
    "third-phase preflight should pass static guardrail checks",
  );

  let candidateFailedSafely = false;
  try {
    execFileSync(process.execPath, ["scripts/verify-third-phase-readiness.mjs", "--candidate"], {
      cwd: webRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (error) {
    const output =
      String((error as { stdout?: unknown }).stdout ?? "") +
      String((error as { stderr?: unknown }).stderr ?? "");
    candidateFailedSafely = output.includes("Live provider evidence is required for --candidate");
  }
  assert(
    candidateFailedSafely,
    "candidate gate should fail safe until live provider E2E evidence is supplied",
  );

  const goalMeetingPanelSource = readFileSync(
    path.join(webRoot, "src/components/office/GoalMeetingPanel.tsx"),
    "utf8",
  );
  assert(
    goalMeetingPanelSource.includes("IsLiveProviderEvidenceDomainCandidateReady(") &&
      goalMeetingPanelSource.includes("liveProviderEvidenceReadyDomainCount") &&
      goalMeetingPanelSource.includes('t("goal.liveEvidenceReadyDomains")'),
    "visible live-evidence readiness should use the same per-domain requirements as the release:candidate gate",
  );

  console.log("third-phase release readiness regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runThirdPhaseReadinessRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
