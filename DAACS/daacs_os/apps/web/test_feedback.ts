import { pathToFileURL } from "node:url";

import { RunHostCommandsWithAgentFeedback } from "./src/application/sequencer/HostCommandFeedbackRunner.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runHostCommandFeedbackRegressionTests(): Promise<void> {
  let workspaceRunCount = 0;
  const cliLogs: Array<{ label: string; exit_code: number; stdin: string; stdout: string; stderr: string }> = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["missing_command_123"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "developer",
    logLabelPrefix: "test-feedback",
    onCliLog: (log) => {
      cliLogs.push({
        label: log.label,
        exit_code: log.exit_code,
        stdin: log.stdin,
        stdout: log.stdout,
        stderr: log.stderr,
      });
    },
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      workspaceRunCount += 1;
      if (command === "missing_command_123") {
        return { exit_code: 127, stdout: "", stderr: "sh: missing_command_123: command not found" };
      }
      if (command.startsWith("echo")) {
        return { exit_code: 0, stdout: command.slice(4).trim(), stderr: "" };
      }
      return { exit_code: 1, stdout: "", stderr: "unknown" };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { result: { exit_code: number } };
      if (payload.result.exit_code !== 0) {
        return {
          exit_code: 0,
          stdout: '[Commands]\n1. echo "Command failed. Please replace placeholder."\n[/Commands]',
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(result.ok === false, "Meta-communication follow-up commands should fail the host feedback runner");
  assert(workspaceRunCount === 1, `Expected a single workspace execution before circuit-break, got ${workspaceRunCount}`);
  assert(result.runs.length === 1, `Expected one execution record, got ${result.runs.length}`);

  const [run] = result.runs;
  assert(run.command === "missing_command_123", `Expected the original command to be recorded, got ${run.command}`);
  assert(run.exit_code === 127, `Expected exit_code=127, got ${run.exit_code}`);
  assert(run.stderr.includes("command not found"), `Expected failing stderr to be captured, got ${run.stderr}`);
  assert(run.feedback_exit_code === 0, `Expected the feedback CLI exit code to be recorded, got ${run.feedback_exit_code}`);
  assert(
    run.feedback.includes("[Commands]") && run.feedback.includes('echo "Command failed. Please replace placeholder."'),
    `Expected the raw feedback text to be preserved, got ${run.feedback}`,
  );
  assert(
    run.followupCommands.length === 1 &&
      run.followupCommands[0] === 'echo "Command failed. Please replace placeholder."',
    `Expected parsed follow-up commands to be preserved, got ${JSON.stringify(run.followupCommands)}`,
  );

  const workspaceLog = cliLogs.find((entry) => entry.label === "test-feedback:workspace");
  const feedbackLog = cliLogs.find((entry) => entry.label === "test-feedback:feedback");
  assert(workspaceLog?.exit_code === 127, `Expected workspace CLI log to capture the failing exit code, got ${workspaceLog?.exit_code}`);
  assert(
    feedbackLog?.stdout.includes("[Commands]") === true,
    `Expected feedback CLI log to preserve the numbered Commands block, got ${feedbackLog?.stdout}`,
  );

  const selectorRelaxedCommands: string[] = [];
  const selectorRelaxedResult = await RunHostCommandsWithAgentFeedback({
    commands: ['cd apps/web && npm run smoke:chromium -- --grep "champion"'],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-selector-relax",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      selectorRelaxedCommands.push(command);
      if (command === 'cd apps/web && npm run smoke:chromium -- --grep "champion"') {
        return {
          exit_code: 1,
          stdout: "Error: No tests found. Make sure that arguments are regular expressions matching test files.",
          stderr: "",
        };
      }
      if (command === "cd apps/web && npm run smoke:chromium") {
        return {
          exit_code: 0,
          stdout: "smoke suite passed",
          stderr: "",
        };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string; result: { exit_code: number } };
      if (payload.command.includes("--grep") && payload.result.exit_code !== 0) {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cd apps/web && npm run smoke:chromium\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(
    selectorRelaxedResult.ok === false,
    "Dropping an over-narrow grep selector may run as extra evidence, but must not supersede missing targeted verification",
  );
  assert(
    JSON.stringify(selectorRelaxedCommands) ===
      JSON.stringify([
        'cd apps/web && npm run smoke:chromium -- --grep "champion"',
        "cd apps/web && npm run smoke:chromium",
      ]),
    `Expected grep-relaxed smoke verification to run once then broaden, got ${JSON.stringify(selectorRelaxedCommands)}`,
  );

  const quotedPipeDiagnosticCommands: string[] = [];
  const quotedPipeDiagnostic = await RunHostCommandsWithAgentFeedback({
    commands: ["cd apps/web && npm run smoke:chromium -- smoke/champion-recommender.spec.ts"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "developer",
    logLabelPrefix: "test-feedback-quoted-pipe-diagnostic",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      quotedPipeDiagnosticCommands.push(command);
      if (command === "cd apps/web && npm run smoke:chromium -- smoke/champion-recommender.spec.ts") {
        return {
          exit_code: 1,
          stdout: "locator expected 3 cards, found 0",
          stderr: "",
        };
      }
      if (
        command ===
        'cd apps/web && sed -n \'1,220p\' smoke/champion-recommender.spec.ts && rg -n "애니|오리아나|갈리오" src smoke'
      ) {
        return {
          exit_code: 0,
          stdout: "smoke/champion-recommender.spec.ts:12:오리아나",
          stderr: "",
        };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string; result: { exit_code: number } };
      if (payload.command.includes("smoke:chromium") && payload.result.exit_code !== 0) {
        return {
          exit_code: 0,
          stdout:
            "[Commands]\n1. cd apps/web && sed -n '1,220p' smoke/champion-recommender.spec.ts && rg -n \"애니|오리아나|갈리오\" src smoke\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(
    quotedPipeDiagnostic.ok === false,
    "Read-only diagnostics after a failed smoke run should preserve failure status instead of converting it to pass",
  );
  assert(
    JSON.stringify(quotedPipeDiagnosticCommands) ===
      JSON.stringify([
        "cd apps/web && npm run smoke:chromium -- smoke/champion-recommender.spec.ts",
        'cd apps/web && sed -n \'1,220p\' smoke/champion-recommender.spec.ts && rg -n "애니|오리아나|갈리오" src smoke',
      ]),
    `Quoted pipe inside rg pattern should not be split as shell control, got ${JSON.stringify(quotedPipeDiagnosticCommands)}`,
  );

  const npmTestDiagnosticCommands: string[] = [];
  const npmTestDiagnostic = await RunHostCommandsWithAgentFeedback({
    commands: ["cd apps/web && npm test"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "developer",
    logLabelPrefix: "test-feedback-npm-test-diagnostic",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      npmTestDiagnosticCommands.push(command);
      if (command === "cd apps/web && npm test -- --run") {
        return {
          exit_code: 1,
          stdout: "runWebVerification failed in generated recommendation regression",
          stderr: "",
        };
      }
      if (command === "sed -n '1,220p' apps/web/src/features/lolChampionAdvisor/recommendation.test.ts") {
        return {
          exit_code: 0,
          stdout: "assert.deepEqual(recommendations, ['렐', '애쉬', '룰루'])",
          stderr: "",
        };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string; result: { exit_code: number } };
      if (payload.command === "cd apps/web && npm test -- --run" && payload.result.exit_code !== 0) {
        return {
          exit_code: 0,
          stdout:
            "[Commands]\n1. sed -n '1,220p' apps/web/src/features/lolChampionAdvisor/recommendation.test.ts\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(
    npmTestDiagnostic.ok === false,
    "Read-only diagnostics after npm test should preserve the failed test status",
  );
  assert(
    JSON.stringify(npmTestDiagnosticCommands) ===
      JSON.stringify([
        "cd apps/web && npm test -- --run",
        "sed -n '1,220p' apps/web/src/features/lolChampionAdvisor/recommendation.test.ts",
      ]),
    `npm test failures should allow targeted read-only diagnostics, got ${JSON.stringify(npmTestDiagnosticCommands)}`,
  );

  const qualityReadChainCommands: string[] = [];
  const qualityReadChain = await RunHostCommandsWithAgentFeedback({
    commands: ["ls -R src/"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-quality-read-chain",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      qualityReadChainCommands.push(command);
      if (command === "ls -R src/") {
        return { exit_code: 0, stdout: "App.tsx\nengine.ts\nmockData.ts\n", stderr: "" };
      }
      if (command === "cat src/engine.ts") {
        return { exit_code: 0, stdout: "export function recommend() { return []; }\n", stderr: "" };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string; result: { exit_code: number } };
      if (payload.command === "ls -R src/") {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cat src/engine.ts\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(qualityReadChain.ok === true, "Quality gates should allow bounded read-only evidence chaining after successful reads");
  assert(
    JSON.stringify(qualityReadChainCommands) ===
      JSON.stringify(["ls -R src/", "cat src/engine.ts"]),
    `Quality read-only chain should continue instead of failing blocked, got ${JSON.stringify(qualityReadChainCommands)}`,
  );

  const cappedQualityReadCommands: string[] = [];
  const cappedQualityRead = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-quality-read-cap",
    maxQualityReadOnlyEvidenceRuns: 2,
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      cappedQualityReadCommands.push(command);
      if (command === "npm run build") {
        return { exit_code: 2, stdout: "tsconfig.json error TS6053", stderr: "" };
      }
      if (command === "cat tsconfig.json") {
        return { exit_code: 0, stdout: "{\"references\":[{\"path\":\"./tsconfig.node.json\"}]}", stderr: "" };
      }
      if (command === "cat package.json") {
        return { exit_code: 0, stdout: "{\"scripts\":{\"build\":\"tsc && vite build\"}}", stderr: "" };
      }
      if (command === "cat src/App.tsx") {
        return { exit_code: 0, stdout: "should not run after the read-only evidence cap", stderr: "" };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string; result: { exit_code: number } };
      if (payload.command === "npm run build") {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cat tsconfig.json\n[/Commands]",
          stderr: "",
        };
      }
      if (payload.command === "cat tsconfig.json") {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cat package.json\n[/Commands]",
          stderr: "",
        };
      }
      if (payload.command === "cat package.json") {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cat src/App.tsx\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(
    cappedQualityRead.ok === false,
    "Quality gates should stop long read-only evidence chains and preserve the original failed verification",
  );
  assert(
    JSON.stringify(cappedQualityReadCommands) ===
      JSON.stringify(["npm run build", "cat tsconfig.json", "cat package.json"]),
    `Quality read-only cap should stop before broad extra file reads, got ${JSON.stringify(cappedQualityReadCommands)}`,
  );

  const duplicateQualityReadCommands: string[] = [];
  const duplicateQualityRead = await RunHostCommandsWithAgentFeedback({
    commands: ["cat app.js"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-duplicate-quality-read",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      duplicateQualityReadCommands.push(command);
      if (command === "cat app.js") {
        return { exit_code: 0, stdout: "const ok = true;\n", stderr: "" };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(userMessage) as { command: string };
      if (payload.command === "cat app.js") {
        return {
          exit_code: 0,
          stdout: "[Commands]\n1. cat app.js\n[/Commands]",
          stderr: "",
        };
      }
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(
    duplicateQualityRead.ok === true,
    "Duplicate successful read-only quality evidence should close the chain instead of routing fake rework",
  );
  assert(
    JSON.stringify(duplicateQualityReadCommands) === JSON.stringify(["cat app.js"]),
    `Duplicate read-only command should not re-run, got ${JSON.stringify(duplicateQualityReadCommands)}`,
  );

  let packageInstallFeedbackCalls = 0;
  const packageInstallFastPass = await RunHostCommandsWithAgentFeedback({
    commands: ["npm install"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "developer",
    logLabelPrefix: "test-feedback-package-install-fast-pass",
    onCliLog: () => {},
    extractCommandsFromAgentText: async () => [],
    runWorkspaceCommand: async (command) => {
      if (command === "npm install") {
        return { exit_code: 0, stdout: "added 42 packages, and audited 42 packages in 1s", stderr: "" };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async () => {
      packageInstallFeedbackCalls += 1;
      return { exit_code: 0, stdout: "OK", stderr: "" };
    },
  });

  assert(packageInstallFastPass.ok === true, "Successful package installs should pass without provider feedback");
  assert(
    packageInstallFeedbackCalls === 0,
    `Successful package installs should not call the feedback provider, got ${packageInstallFeedbackCalls}`,
  );

  const generatedArtifactReadCommands: string[] = [];
  const generatedArtifactReadBlocked = await RunHostCommandsWithAgentFeedback({
    commands: ["cat src/engine.ts"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-generated-artifact-read-block",
    onCliLog: () => {},
    extractCommandsFromAgentText: async (text) => {
      const match = text.match(/\[Commands\]([\s\S]*?)\[\/Commands\]/i);
      if (!match) return [];
      return match[1]
        .split("\n")
        .filter((line) => /^\d+\./.test(line))
        .map((line) => line.replace(/^\d+\.\s*/, "").trim());
    },
    runWorkspaceCommand: async (command) => {
      generatedArtifactReadCommands.push(command);
      if (command === "cat src/engine.ts") {
        return { exit_code: 0, stdout: "export function recommend() { return []; }\n", stderr: "" };
      }
      return { exit_code: 2, stdout: "", stderr: `unexpected command: ${command}` };
    },
    runAgentCli: async () => ({
      exit_code: 0,
      stdout:
        "[Commands]\n1. cat tmp/verification/smoke-verification/developer-builder-20260424104842946.json\n[/Commands]",
      stderr: "",
    }),
  });

  assert(
    generatedArtifactReadBlocked.ok === false,
    "Quality gates should block wholesale reads of generated verification artifact JSON files",
  );
  assert(
    JSON.stringify(generatedArtifactReadCommands) === JSON.stringify(["cat src/engine.ts"]),
    `Generated verification artifact reads should be rejected before workspace execution, got ${JSON.stringify(generatedArtifactReadCommands)}`,
  );

  const nonInteractiveTestCommands: string[] = [];
  const nonInteractiveTestRun = await RunHostCommandsWithAgentFeedback({
    commands: ["npm test src/engine/recommender.test.ts", "npx vitest src/engine/recommender.test.ts"],
    workspace: "/tmp",
    cwdForCli: "/tmp",
    cliProvider: "codex",
    officeAgentRole: "verifier",
    logLabelPrefix: "test-feedback-non-interactive-tests",
    onCliLog: () => {},
    extractCommandsFromAgentText: async () => [],
    runWorkspaceCommand: async (command) => {
      nonInteractiveTestCommands.push(command);
      return { exit_code: 0, stdout: "tests passed in run mode", stderr: "" };
    },
    runAgentCli: async () => ({ exit_code: 0, stdout: "OK", stderr: "" }),
  });

  assert(nonInteractiveTestRun.ok === true, "Non-interactive test normalization should still pass");
  assert(
    JSON.stringify(nonInteractiveTestCommands) === JSON.stringify([
      "npm test -- --run src/engine/recommender.test.ts",
      "npx vitest run src/engine/recommender.test.ts",
    ]),
    `Vitest/npm test commands should be normalized away from watch mode, got ${JSON.stringify(nonInteractiveTestCommands)}`,
  );

  console.log("Host command feedback runner regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runHostCommandFeedbackRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
