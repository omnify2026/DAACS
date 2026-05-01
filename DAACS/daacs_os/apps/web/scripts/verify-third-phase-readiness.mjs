import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, "..");
const repoRoot = resolve(webRoot, "../../..");

const args = process.argv.slice(2);
const wantsCandidate = args.includes("--candidate");
const wantsPreflight = args.includes("--preflight") || !wantsCandidate;

function fail(message) {
  throw new Error(message);
}

function readText(relativePath) {
  const fullPath = join(repoRoot, relativePath);
  if (!existsSync(fullPath)) fail(`Missing required file: ${relativePath}`);
  return readFileSync(fullPath, "utf8");
}

function requireIncludes(file, marker, label = marker) {
  const text = readText(file);
  if (!text.includes(marker)) {
    fail(`${file} is missing release guard marker: ${label}`);
  }
}

function requirePackageScripts() {
  const packageJson = JSON.parse(readText("DAACS_OS/apps/web/package.json"));
  const scripts = packageJson.scripts ?? {};
  for (const name of [
    "test:regression",
    "smoke",
    "lint",
    "build",
    "release:preflight",
    "release:candidate",
  ]) {
    if (typeof scripts[name] !== "string" || scripts[name].trim() === "") {
      fail(`package.json is missing required script: ${name}`);
    }
  }

  const desktopPackageJson = JSON.parse(readText("DAACS_OS/apps/desktop/package.json"));
  const desktopScripts = desktopPackageJson.scripts ?? {};
  if (typeof desktopScripts["smoke:window"] !== "string" || desktopScripts["smoke:window"].trim() === "") {
    fail("apps/desktop/package.json is missing required script: smoke:window");
  }
}

function collectFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath));
      continue;
    }
    if (
      /\.(ts|tsx|mjs|js)$/.test(entry.name) &&
      !/\.test\.(ts|tsx|mjs|js)$/.test(entry.name)
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

function requireNoLegacyPythonRuntimeReference() {
  const srcRoot = join(webRoot, "src");
  const badPatterns = [
    /DAACS_OS[\\/]+services/i,
    /services[\\/]+api[\\/]+daacs/i,
  ];
  for (const file of collectFiles(srcRoot)) {
    const text = readFileSync(file, "utf8");
    for (const pattern of badPatterns) {
      for (const match of text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
        const index = match.index ?? 0;
        const context = text.slice(Math.max(0, index - 160), index + 160).toLowerCase();
        const isPreventiveGuardText =
          /\b(do not|don't|must not|should not|not use|not implement|never|out of scope|without introducing|forbid|forbidden|blocked|guard|exclude)\b/.test(
            context,
          ) || /금지|차단|쓰지\s*마|사용하지\s*마/.test(context);
        if (!isPreventiveGuardText) {
          fail(`Runtime source references legacy Python/services path: ${file}`);
        }
      }
    }
  }
}

function runStaticPreflight() {
  requirePackageScripts();
  requireNoLegacyPythonRuntimeReference();

  requireIncludes(
    "DAACS_OS/docs/adr/ADR-0002-quality-gates-and-release-policy.md",
    "Live provider E2E gate",
  );
  requireIncludes(
    "DAACS_OS/docs/adr/ADR-0002-quality-gates-and-release-policy.md",
    "DAACS_OS/services",
    "Python/services runtime boundary",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/COVERAGE.md",
    "Final live E2E candidate",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/COVERAGE.md",
    "npm run smoke:window",
    "desktop window smoke coverage",
  );
  requireIncludes(
    "DAACS_OS/docs/adr/ADR-0002-quality-gates-and-release-policy.md",
    "npm run smoke:window",
    "desktop window smoke release gate",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/COVERAGE.md",
    "web API collaboration stub must not be treated as live-provider evidence",
    "web stub boundary documentation",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/COVERAGE.md",
    "copy and download live-provider evidence JSON",
    "live evidence export smoke coverage",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/COVERAGE.md",
    "custom-agent factory smoke proves the app flow can create an implementation-heavy builder agent",
    "user-created implementation agent smoke evidence",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    'data-testid="goal-release-readiness"',
    "visible release readiness",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "BuildLiveProviderEvidenceJson(",
    "live provider evidence export",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    'data-testid="goal-live-evidence-copy-button"',
    "live provider evidence copy button",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    'data-testid="goal-live-evidence-download-button"',
    "live provider evidence download button",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "liveProviderEvidenceCandidateReady",
    "visible live evidence candidate readiness",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "IsLiveProviderEvidenceDomainCandidateReady(",
    "visible live evidence readiness must match candidate gate requirements",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "liveProviderEvidenceReadyDomainCount",
    "visible ready-domain count for candidate evidence",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "BuildArtifactQaFeedbackGoalText(",
    "same-artifact QA feedback repair",
  );
  requireIncludes(
    "DAACS_OS/apps/web/src/components/office/GoalMeetingPanel.tsx",
    "LooksLikeProviderDelayArtifact(",
    "provider timeout recovery detection",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/collaboration-round.spec.ts",
    "marks provider timeout artifacts as recoverable instead of silently done",
    "provider timeout smoke title",
  );
  requireIncludes(
    "DAACS_OS/apps/web/smoke/collaboration-round.spec.ts",
    "blocks ready verdict when web artifact verifier has no executable evidence",
  );
  requireIncludes(
    "DAACS_OS/backend/src/routes/stubs.rs",
    "웹 API collaboration stub은 실제 LLM/provider 실행 경로가 아닙니다.",
    "backend collaboration stub must not claim live provider execution",
  );
}

function argumentValue(name) {
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1] != null) return args[index + 1];
  return null;
}

function listValue(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`Live evidence must include non-empty array: ${label}`);
  }
  return value;
}

function stringValue(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Live evidence must include non-empty string: ${label}`);
  }
  return value.trim();
}

function absolutePathValue(value, label) {
  const path = stringValue(value, label);
  if (!isAbsolute(path)) fail(`${label} must be an absolute path: ${path}`);
  if (path.includes("/absolute/path/")) {
    fail(`${label} still contains a template placeholder: ${path}`);
  }
  return path;
}

function roleText(domain) {
  const sources = [
    domain.roles,
    domain.trace,
    domain.rounds,
    domain.contributions,
    domain.agents,
  ].filter(Array.isArray);
  return JSON.stringify(sources).toLowerCase();
}

function hasImplementationRole(text) {
  return /\b(frontend|backend|developer|builder|implementation|engineer|designer|dev)\b/.test(text);
}

function hasExecutableCommand(commands, evidence) {
  const text = [...commands, ...evidence].join("\n").toLowerCase();
  return /\bnpm\s+run\s+(build|smoke|test|test:regression|lint)\b|\bplaywright\b|\bcargo\s+test\b|\bcargo\s+check\b/.test(text);
}

function validateDomain(domain, index) {
  const prefix = `domains[${index}]`;
  stringValue(domain.name, `${prefix}.name`);
  stringValue(domain.prompt, `${prefix}.prompt`);
  absolutePathValue(domain.artifact_path, `${prefix}.artifact_path`);
  stringValue(domain.modification_request, `${prefix}.modification_request`);

  const status = stringValue(domain.final_status, `${prefix}.final_status`).toLowerCase();
  if (!/\b(ready|completed|verified|passed|pass)\b/.test(status)) {
    fail(`${prefix}.final_status must show a ready/completed result`);
  }

  const commands = listValue(domain.commands, `${prefix}.commands`).map((item) => stringValue(item, `${prefix}.commands[]`));
  const evidence = listValue(domain.evidence, `${prefix}.evidence`).map((item) => stringValue(item, `${prefix}.evidence[]`));
  if (!hasExecutableCommand(commands, evidence)) {
    fail(`${prefix} must include executable evidence such as npm run build/smoke/test, Playwright, or cargo test`);
  }

  const roles = roleText(domain);
  for (const role of ["pm", "reviewer", "verifier"]) {
    if (!roles.includes(role)) fail(`${prefix} trace must include role: ${role}`);
  }
  if (!hasImplementationRole(roles)) {
    fail(`${prefix} trace must include at least one implementation agent role`);
  }

  if (typeof domain.quality_score === "number" && domain.quality_score < 80) {
    fail(`${prefix}.quality_score must be 80 or higher for candidate evidence`);
  }
}

function validateLiveEvidence() {
  const evidencePath = argumentValue("--live-evidence") ?? process.env.DAACS_LIVE_E2E_EVIDENCE ?? null;
  if (evidencePath == null || evidencePath.trim() === "") {
    fail(
      "Live provider evidence is required for --candidate. Run a real app round, save evidence JSON, then run: npm run release:candidate -- --live-evidence /absolute/path/evidence.json",
    );
  }
  const resolvedPath = resolve(evidencePath);
  if (!existsSync(resolvedPath) || !statSync(resolvedPath).isFile()) {
    fail(`Live provider evidence file does not exist: ${resolvedPath}`);
  }

  const evidence = JSON.parse(readFileSync(resolvedPath, "utf8"));
  stringValue(evidence.provider, "provider");
  absolutePathValue(evidence.workspace_path, "workspace_path");
  const domains = listValue(evidence.domains, "domains");
  if (domains.length < 2) {
    fail("Candidate evidence must include at least two different live domains");
  }
  domains.forEach(validateDomain);
}

try {
  if (wantsPreflight || wantsCandidate) runStaticPreflight();
  if (wantsCandidate) validateLiveEvidence();
  console.log(
    wantsCandidate
      ? "DAACS third-phase release candidate evidence passed."
      : "DAACS third-phase static preflight passed. Live provider E2E evidence is still required before provider-verified release claims.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
