import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentPromptRole } from "../../services/tauriCli";
import { isInvalidSequencerCliCommand } from "./HostCommandGuards";
import {
  HOST_COMMAND_FEEDBACK_SYSTEM_PROMPT,
  RunHostCommandsWithAgentFeedback,
} from "./HostCommandFeedbackRunner";
import { AgentRegistry } from "./AgentRegistry";
import { SequencerCoordinator } from "./SequencerCoordinator";
import { SequencerParser } from "./SequencerParser";

const FIXED_SEQUENCER_TEST_WORKSPACES = [
  "/tmp/daacs-sequencer-pm-support-slice-web-shape-regression",
  "/tmp/daacs-sequencer-reviewer-host-feedback-blocked-reroute",
  "/tmp/daacs-sequencer-direct-host-feedback-blocked",
  "/tmp/daacs-sequencer-bundle-host-feedback-blocked",
  "/tmp/daacs-sequencer-direct-pm-host-feedback-failure",
  "/tmp/daacs-sequencer-bundle-pm-host-feedback-failure",
];

async function cleanupFixedSequencerTestWorkspaces(): Promise<void> {
  await Promise.all(
    FIXED_SEQUENCER_TEST_WORKSPACES.map((workspace) =>
      rm(workspace, { recursive: true, force: true }),
    ),
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function taggedReviewerStepOutput(stepNumber = 1, summary = "Reviewer accepted the assigned work."): string {
  return [
    `[STEP_${stepNumber}_RESULT]`,
    summary,
    "[ReviewVerdict]ready[/ReviewVerdict]",
    "[ReviewFindings]",
    "[/ReviewFindings]",
    "[OpenRisks]",
    "[/OpenRisks]",
    `[/STEP_${stepNumber}_RESULT]`,
    `{END_TASK_${stepNumber}}`,
  ].join("\n");
}

function taggedVerifierStepOutput(stepNumber = 1, summary = "Verifier passed the assigned work."): string {
  return [
    `[STEP_${stepNumber}_RESULT]`,
    summary,
    "[VerificationStatus]pass[/VerificationStatus]",
    "[Verification]",
    "- User-flow smoke passed: happy path rendered input/search/filter interaction, empty state, button interaction, mobile responsive layout, and negative/adversarial decision-flow excluded unavailable, already-used, or conflicting choices with true conditional explanations.",
    "[/Verification]",
    "[OpenRisks]",
    "[/OpenRisks]",
    `[/STEP_${stepNumber}_RESULT]`,
    `{END_TASK_${stepNumber}}`,
  ].join("\n");
}

type CapturedCascadeCall = {
  role: string;
  instruction: string;
};

type CapturedCliLog = {
  label: string;
  stdout: string;
  stderr: string;
  officeAgentRole?: string;
  exit_code?: number;
  skillRequestParsed?: string[] | null;
};

type CapturedExecutionCompletion = {
  agentId: string;
  officeRole: string;
  status: string;
  mode: string;
  summary: string;
  changedFiles?: string[];
};

type ParsedPlanStep = {
  stepNumber: number;
  task: string;
  routedAgentId: string | null;
};

function parseHostCommandBlocks(text: string): string[] {
  const matches = (text ?? "").matchAll(/\[(?:Command|Commands)\]([\s\S]*?)\[\/(?:Command|Commands)\]/gi);
  const commands: string[] = [];
  for (const match of matches) {
    const body = match[1] ?? "";
    const lines = body.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx] ?? "";
      const parsed = line.match(/^\s*\d+[.)]\s+(.+?)\s*$/);
      const fallback = line.trim();
      if (
        parsed?.[1] != null ||
        (
          fallback !== "" &&
          !fallback.startsWith("#") &&
          !fallback.startsWith("```") &&
          !fallback.startsWith("~~~")
        )
      ) {
        let command = (parsed?.[1] ?? fallback).trim();
        if (command.startsWith("```") || command.startsWith("~~~")) continue;
        const delimiter = extractHeredocDelimiter(command);
        if (delimiter != null) {
          let foundTerminator = false;
          while (idx + 1 < lines.length) {
            idx += 1;
            const heredocLine = lines[idx] ?? "";
            command += `\n${heredocLine}`;
            if (heredocLine.trim() === delimiter) {
              foundTerminator = true;
              break;
            }
          }
          if (!foundTerminator) continue;
        }
        commands.push(command);
      }
    }
  }
  return commands;
}

function extractHeredocDelimiter(command: string): string | null {
  const markerIndex = command.indexOf("<<");
  if (markerIndex < 0 || command.slice(markerIndex + 2).startsWith("<")) return null;
  const afterMarker = command
    .slice(markerIndex + 2)
    .replace(/^-/, "")
    .trimStart();
  const token = afterMarker.split(/[\s;&|]/, 1)[0]?.trim() ?? "";
  const delimiter = token.replace(/^['"`]|['"`]$/g, "").trim();
  return delimiter === "" ? null : delimiter;
}

function filterTimeoutMarkerHostCommands(commands: string[]): string[] {
  return commands.filter((command) => !command.includes(".daacs_timeout_marker_"));
}

const AGENTS_METADATA_JSON = JSON.stringify({
  schema_version: 1,
  agents: [
    { id: "pm", prompt_key: "agent_pm", office_role: "pm" },
    { id: "frontend", prompt_key: "agent_frontend", office_role: "frontend" },
    { id: "backend", prompt_key: "agent_backend", office_role: "backend" },
    { id: "reviewer", prompt_key: "agent_reviewer", office_role: "reviewer" },
    { id: "verifier", prompt_key: "agent_verifier", office_role: "verifier" },
  ],
});

const CORE_ONLY_AGENTS_METADATA_JSON = JSON.stringify({
  schema_version: 1,
  agents: [
    { id: "pm", prompt_key: "agent_pm", office_role: "pm" },
    { id: "reviewer", prompt_key: "agent_reviewer", office_role: "reviewer" },
    { id: "verifier", prompt_key: "agent_verifier", office_role: "verifier" },
  ],
});

const USER_CREATED_BUILDER_AGENTS_METADATA_JSON = JSON.stringify({
  schema_version: 1,
  agents: [
    { id: "pm", prompt_key: "agent_pm", office_role: "pm" },
    { id: "ui_builder", prompt_key: "agent_frontend", office_role: "frontend" },
    { id: "reviewer", prompt_key: "agent_reviewer", office_role: "reviewer" },
    { id: "verifier", prompt_key: "agent_verifier", office_role: "verifier" },
  ],
});

const DESKTOP_AGENTS_METADATA_JSON = JSON.stringify({
  schema_version: 1,
  agents: [
    { id: "pm", prompt_key: "agent_pm", office_role: "pm" },
    { id: "developer", prompt_key: "agent_developer", office_role: "developer" },
    { id: "designer", prompt_key: "agent_designer", office_role: "designer" },
    { id: "devops", prompt_key: "agent_devops", office_role: "devops" },
    { id: "reviewer", prompt_key: "agent_reviewer", office_role: "reviewer" },
    { id: "verifier", prompt_key: "agent_verifier", office_role: "verifier" },
  ],
});

function parsePlanSteps(text: string): ParsedPlanStep[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(\d+)\.\s+(.+?)\s*$/))
    .filter((match): match is RegExpMatchArray => match != null)
    .map((match) => ({
      stepNumber: Number(match[1]),
      task: match[2] ?? "",
      routedAgentId: null,
    }));
}

function runPlanParserIgnoresUntaggedImplementationSummaryRegression(): void {
  const untaggedImplementationSummary = [
    "I have completed the implementation of the recommendation app.",
    "",
    "[FilesCreated]",
    "- package.json",
    "- index.html",
    "- src/App.tsx",
    "- src/services/recommendationEngine.ts",
    "[/FilesCreated]",
    "",
    "### 요약 및 특징:",
    "1. 데이터 기반 추천",
    "2. 상황별 필터링",
    "3. 실시간 업데이트",
  ].join("\n");
  const parsed = SequencerParser.ParsePlanSteps(untaggedImplementationSummary);
  assert(
    parsed.length === 0,
    `Untagged completed implementation summaries should not be parsed as PM plan steps, got ${JSON.stringify(parsed)}`,
  );

  const untaggedPlainPlan = [
    "1. Define the data model",
    "2. Build the recommendation UI",
  ].join("\n");
  const plan = SequencerParser.ParsePlanSteps(untaggedPlainPlan);
  assert(
    plan.length === 2 &&
      plan[0]?.task === "Define the data model" &&
      plan[1]?.task === "Build the recommendation UI",
    `Plain untagged plans should still parse for backward compatibility, got ${JSON.stringify(plan)}`,
  );

  const koreanCardPlan = [
    "[SEQUENCER_PLAN]",
    "카드 1) 웹앱 뼈대",
    "카드 2) 데이터/교체 가능한 구조",
    "[/SEQUENCER_PLAN]",
  ].join("\n");
  const koreanCards = SequencerParser.ParsePlanSteps(koreanCardPlan);
  assert(
    koreanCards.length === 2 &&
      koreanCards[0]?.task === "웹앱 뼈대" &&
      koreanCards[1]?.task === "데이터/교체 가능한 구조",
    `Korean PM card headers should parse as concrete plan steps, got ${JSON.stringify(koreanCards)}`,
  );
}

function runPlanParserIgnoresNestedCardBulletsRegression(): void {
  const planWithNestedBulletsAndOpenTag = [
    "[SEQUENCER_PLAN]",
    "- 카드 1) 목표",
    "  - 사용자가 조건을 바꾸면 추천이 즉시 바뀐다.",
    "  - 로그인 없이 동작한다.",
    "",
    "- 카드 2) 입력",
    "  - 현재 시간",
    "  - 콘센트 필요 여부",
    "",
    "[AGENT_COMMANDS]",
    "- to=builder: implement the app shell",
  ].join("\n");
  const parsed = SequencerParser.ParsePlanSteps(planWithNestedBulletsAndOpenTag);
  assert(
    parsed.length === 2 &&
      parsed[0]?.task === "카드 1) 목표" &&
      parsed[1]?.task === "카드 2) 입력",
    `Open SEQUENCER_PLAN should stop before AGENT_COMMANDS and ignore nested bullets, got ${JSON.stringify(parsed)}`,
  );
}

async function runPmPlanCascade(
  planStdout: string,
  planStderr: string,
  seedCommand = "deepaudit mixed backend and frontend follow-up",
): Promise<CapturedCascadeCall[]> {
  return runPmPlanCascadeForMetadata(AGENTS_METADATA_JSON, planStdout, planStderr, seedCommand);
}

async function runPmPlanCascadeForMetadata(
  agentsMetadataJson: string,
  planStdout: string,
  planStderr: string,
  seedCommand = "deepaudit mixed backend and frontend follow-up",
): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-plan-regression",
    cliProvider: null,
    agentsMetadataJson,
    seed: [{ agentId: "pm", command: seedCommand }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] != null) {
          const stepNumber = sequencerMatch[1];
          return {
            stdout: `[STEP_${stepNumber}_RESULT]\nExecuted by pm step ${stepNumber}\n[/STEP_${stepNumber}_RESULT]\n{END_TASK_${stepNumber}}`,
            stderr: "",
            exit_code: 0,
          };
        }
        return { stdout: planStdout, stderr: planStderr, exit_code: 0 };
      }
      if (sequencerMatch?.[1] != null) {
        if (role === "reviewer") {
          return {
            stdout: [
              `[STEP_${sequencerMatch[1]}_RESULT]`,
              `[ReviewVerdict]ready[/ReviewVerdict]`,
              "[ReviewFindings]",
              "[/ReviewFindings]",
              "[OpenRisks]",
              "[/OpenRisks]",
              `[/STEP_${sequencerMatch[1]}_RESULT]`,
              `{END_TASK_${sequencerMatch[1]}}`,
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "verifier") {
          return {
            stdout: [
              `[STEP_${sequencerMatch[1]}_RESULT]`,
              `[VerificationStatus]pass[/VerificationStatus]`,
              "[Verification]",
              "- Regression helper verified the assigned step and an adversarial unavailable/already-used decision-flow case stayed excluded.",
              "[/Verification]",
              "[OpenRisks]",
              "[/OpenRisks]",
              `[/STEP_${sequencerMatch[1]}_RESULT]`,
              `{END_TASK_${sequencerMatch[1]}}`,
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "frontend" && /(?:website|web\s*app|browser|웹사이트|웹앱|브라우저)/i.test(instruction)) {
          return {
            stdout: [
              `[STEP_${sequencerMatch[1]}_RESULT]`,
              `Executed by ${role} step ${sequencerMatch[1]}`,
              "[FilesCreated]",
              "index.html",
              "src/app.js",
              "styles.css",
              "[/FilesCreated]",
              `[/STEP_${sequencerMatch[1]}_RESULT]`,
              `{END_TASK_${sequencerMatch[1]}}`,
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "backend" && /Bounded repair slice for this cycle/i.test(instruction)) {
          return {
            stdout: [
              `[STEP_${sequencerMatch[1]}_RESULT]`,
              `Executed by ${role} step ${sequencerMatch[1]}`,
              "[FilesCreated]",
              "src/cli.ts",
              "[/FilesCreated]",
              `[/STEP_${sequencerMatch[1]}_RESULT]`,
              `{END_TASK_${sequencerMatch[1]}}`,
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM plan cascade to complete");
  return calls;
}

async function runPmPlanningDesignRowsStayPmRegression(): Promise<CapturedCascadeCall[]> {
  return runPmPlanCascadeForMetadata(
    AGENTS_METADATA_JSON,
    [
      "[SEQUENCER_PLAN]",
      "1. Define the recipe/ingredient data model and scoring constraints.",
      "2. Design the UI/UX flow for ingredient selection and live filter binding.",
      "3. Produce the final execution plan for the builder agent.",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "냉장고 재료 기반 식단 추천 웹사이트를 만들어줘.",
  );
}

async function runPmPlanCascadeWithLogs(
  planStdout: string,
  planStderr: string,
): Promise<{ calls: CapturedCascadeCall[]; logs: CapturedCliLog[] }> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-plan-skill-request-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "deepaudit mixed backend and frontend follow-up" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] != null) {
          const stepNumber = sequencerMatch[1];
          return {
            stdout: `[STEP_${stepNumber}_RESULT]\nExecuted by pm step ${stepNumber}\n[/STEP_${stepNumber}_RESULT]\n{END_TASK_${stepNumber}}`,
            stderr: "",
            exit_code: 0,
          };
        }
        return { stdout: planStdout, stderr: planStderr, exit_code: 0 };
      }
      if (sequencerMatch?.[1] != null) {
        if (role === "backend" && /Bounded repair slice for this cycle/i.test(instruction)) {
          return {
            stdout: [
              `[STEP_${sequencerMatch[1]}_RESULT]`,
              `Executed by ${role} step ${sequencerMatch[1]}`,
              "[FilesCreated]",
              "src/cli.ts",
              "[/FilesCreated]",
              `[/STEP_${sequencerMatch[1]}_RESULT]`,
              `{END_TASK_${sequencerMatch[1]}}`,
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected PM plan cascade with logs to complete");
  return { calls, logs };
}

async function runPmStepSkillRequestCascadeWithLogs(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let frontendStepRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-step-skill-request-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "deepaudit mixed backend and frontend follow-up" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] != null) {
          const stepNumber = sequencerMatch[1];
          return {
            stdout: `[STEP_${stepNumber}_RESULT]\nExecuted by pm step ${stepNumber}\n[/STEP_${stepNumber}_RESULT]\n{END_TASK_${stepNumber}}`,
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout:
            "[SEQUENCER_PLAN]\n1. Restore apps/web/src/components/office/LlmSettingsModal.tsx reachability\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && sequencerMatch?.[1] === "1") {
        frontendStepRuns += 1;
        if (frontendStepRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Need UI skill details before finishing the reachability fix",
              "[/STEP_1_RESULT]",
              "[SKILL_REQUEST]typescript-pro[/SKILL_REQUEST]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "[SKILL_REQUEST]clean-code[/SKILL_REQUEST]",
            exit_code: 0,
          };
        }
        return {
          stdout:
            "[STEP_1_RESULT]\nExecuted by frontend step 1 after skill injection\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (sequencerMatch?.[1] != null) {
        const stepNumber = Number(sequencerMatch[1]);
        if (role === "reviewer") {
          return {
            stdout: taggedReviewerStepOutput(stepNumber, `Executed by reviewer step ${sequencerMatch[1]}`),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "verifier") {
          return {
            stdout: taggedVerifierStepOutput(stepNumber, `Executed by verifier step ${sequencerMatch[1]}`),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected PM step skill-request cascade to complete");
  return { calls, logs };
}

async function runPmQualityOnlyDelegationCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-quality-only-regression",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Review and verify an existing generated artifact. Do not implement." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] != null) {
        return {
          stdout: [
            `[STEP_${sequencerMatch[1]}_RESULT]`,
            "Reviewer and verifier only; implementation is explicitly out of scope.",
            `[/STEP_${sequencerMatch[1]}_RESULT]`,
            `{END_TASK_${sequencerMatch[1]}}`,
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "reviewer",
                Commands: "Review the existing generated artifact only.",
                CommandSender: "pm",
              },
              {
                AgentName: "verifier",
                Commands: "Verify the existing generated artifact only.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm") {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final quality-only handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Existing generated artifact verification passed, including an adversarial unavailable decision-flow case stayed excluded.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed quality-only work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM quality-only delegation cascade to complete");
  return calls;
}

async function runAgentDependencyWaitsForAllSameAgentCommandsRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let secondFrontendInProgress = false;
  let secondFrontendCompleted = false;
  let verifierStartedTooEarly = false;

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-agent-dependency-waits-all",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Coordinate multi-slice generated website delivery." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      calls.push({ role, instruction });
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Delegate the multi-slice follow-up graph\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated two frontend slices, one backend prerequisite, and final verification.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Create the visible draft board shell.",
                CommandSender: "pm",
              },
              {
                AgentName: "backend",
                Commands: "Prepare the recommendation data contract.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands: "Wire the dynamic recommendation states after backend data is ready.",
                CommandSender: "pm",
                DependsOn: ["backend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify only after all frontend work is complete.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && instruction.includes("Wire the dynamic recommendation states")) {
        secondFrontendInProgress = true;
        await delay(20);
        secondFrontendCompleted = true;
        secondFrontendInProgress = false;
      }
      if (role === "verifier" && (!secondFrontendCompleted || secondFrontendInProgress)) {
        verifierStartedTooEarly = true;
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[HostFeedbackStatus]pass[/HostFeedbackStatus]",
            "[Verification]",
            "- Verifier waited for every pending same-agent frontend command before passing.",
            "- User-flow smoke passed for the generated website handoff.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed assigned dependency slice.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected same-agent dependency cascade to complete");
  assert(
    secondFrontendCompleted,
    `Expected the dependent frontend slice to run, got calls=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  assert(
    !verifierStartedTooEarly,
    `Verifier must wait for every pending frontend command, got calls=${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runQualityGateWaitsForPriorImplementationWithoutExplicitDependsRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let secondFrontendCompleted = false;
  let reviewerStartedTooEarly = false;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-quality-waits-prior-implementation",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Coordinate generated website delivery without explicit quality dependencies." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      calls.push({ role, instruction });
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Delegate implementation slices and quality gates\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated two implementation slices and quality gates without explicit DependsOn.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Create scaffold and seed data.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands: "Wire live inputs, recompute, search, and localStorage.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review only after implementation slices are done.",
                CommandSender: "pm",
              },
              {
                AgentName: "verifier",
                Commands: "Verify only after review.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && instruction.includes("Wire live inputs")) {
        secondFrontendCompleted = true;
      }
      if (role === "reviewer" && !secondFrontendCompleted) {
        reviewerStartedTooEarly = true;
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer waited for all prior implementation slices."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier waited for reviewer after all implementation slices."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed assigned implementation slice.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected quality gates to wait for prior implementation commands even without explicit DependsOn");
  assert(
    !reviewerStartedTooEarly,
    `Reviewer should not run before prior implementation slices complete, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "frontend", "frontend", "reviewer", "verifier"]),
    `Quality gates should run after implementation slices, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runPmRawVerifierWaitsForReviewerRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const callOrder: string[] = [];
  let reviewerInProgress = false;
  let reviewerCompleted = false;
  let verifierStartedBeforeReviewer = false;
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-raw-verifier-reviewer-order",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a generated web recommendation artifact with PM raw commands." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      callOrder.push(role);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Delegate raw implementation and quality gates\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM emitted raw AGENT_COMMANDS with verifier depending only on builder.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the generated recommendation UI.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the generated recommendation UI.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the generated recommendation UI.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInProgress = true;
        await delay(20);
        reviewerCompleted = true;
        reviewerInProgress = false;
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        if (!reviewerCompleted || reviewerInProgress) {
          verifierStartedBeforeReviewer = true;
        }
        return {
          stdout: taggedVerifierStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed implementation.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM raw reviewer/verifier ordering cascade to complete");
  assert(
    !verifierStartedBeforeReviewer,
    `Verifier should be automatically sequenced after reviewer for PM raw commands, got ${JSON.stringify(callOrder)}`,
  );
}

async function runSameAgentSlicesSerializeByCommandRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const callOrder: string[] = [];
  let foundationInProgress = false;
  let foundationCompleted = false;
  let interactionInProgress = false;
  let interactionCompleted = false;
  let qualityCompleted = false;
  let interactionStartedTooEarly = false;
  let qualityStartedTooEarly = false;
  let verifierStartedTooEarly = false;

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-same-agent-command-serialization",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Split one complex frontend delivery into bounded developer slices." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final bounded frontend handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated three frontend slices that must stay ordered on the same agent.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the foundation/data model slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands: "Implement the interaction/recommendation slice after the foundation.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands: "Finish the quality/preview hardening slice after the interaction.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify after every frontend slice is finished.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && instruction.includes("foundation/data model")) {
        callOrder.push("frontend:foundation");
        foundationInProgress = true;
        await delay(20);
        foundationCompleted = true;
        foundationInProgress = false;
      }
      if (role === "frontend" && instruction.includes("interaction/recommendation")) {
        callOrder.push("frontend:interaction");
        if (!foundationCompleted || foundationInProgress) interactionStartedTooEarly = true;
        interactionInProgress = true;
        await delay(20);
        interactionCompleted = true;
        interactionInProgress = false;
      }
      if (role === "frontend" && instruction.includes("quality/preview hardening")) {
        callOrder.push("frontend:quality");
        if (!interactionCompleted || interactionInProgress) qualityStartedTooEarly = true;
        await delay(20);
        qualityCompleted = true;
      }
      if (role === "verifier") {
        callOrder.push("verifier");
        if (!qualityCompleted) verifierStartedTooEarly = true;
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Verifier waited for the final ordered same-agent slice before passing.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed ordered slice.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected same-agent bounded slices to complete");
  assert(!interactionStartedTooEarly, `Second same-agent slice must wait for the first slice, got ${JSON.stringify(callOrder)}`);
  assert(!qualityStartedTooEarly, `Third same-agent slice must wait for the second slice, got ${JSON.stringify(callOrder)}`);
  assert(!verifierStartedTooEarly, `Verifier must wait for the final same-agent slice, got ${JSON.stringify(callOrder)}`);
}

async function runInterleavedSameAgentReviewerDependencyRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const callOrder: string[] = [];
  let foundationCompleted = false;
  let reviewerCompleted = false;
  let foundationInProgress = false;
  let reviewerInProgress = false;
  let secondFrontendStartedTooEarly = false;
  let reviewerStartedTooEarly = false;
  let verifierStartedTooEarly = false;

  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-interleaved-same-agent-reviewer-dependency",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Coordinate interleaved frontend-reviewer-frontend verification slices." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final interleaved bounded handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated frontend foundation, review, then frontend finish-up before verification.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the foundation/data model slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the first frontend slice before the finish-up slice starts.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands: "Finish the results/persistence slice after the review.",
                CommandSender: "pm",
                DependsOn: ["frontend", "reviewer"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify after the reviewed final frontend slice is complete.",
                CommandSender: "pm",
                DependsOn: ["frontend", "reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && instruction.includes("foundation/data model")) {
        callOrder.push("frontend:foundation");
        foundationInProgress = true;
        await delay(20);
        foundationCompleted = true;
        foundationInProgress = false;
      }
      if (role === "reviewer") {
        callOrder.push("reviewer");
        if (!foundationCompleted || foundationInProgress) reviewerStartedTooEarly = true;
        reviewerInProgress = true;
        await delay(20);
        reviewerCompleted = true;
        reviewerInProgress = false;
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && instruction.includes("results/persistence")) {
        callOrder.push("frontend:finish");
        if (!reviewerCompleted || reviewerInProgress) secondFrontendStartedTooEarly = true;
        await delay(20);
      }
      if (role === "verifier") {
        callOrder.push("verifier");
        if (!reviewerCompleted || reviewerInProgress || callOrder[callOrder.length - 2] !== "frontend:finish") {
          verifierStartedTooEarly = true;
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Verifier waited for the reviewed final frontend slice before passing.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed interleaved dependency slice.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected interleaved same-agent reviewer dependency cascade to complete");
  assert(
    JSON.stringify(callOrder) === JSON.stringify(["frontend:foundation", "reviewer", "frontend:finish", "verifier"]),
    `Interleaved same-agent dependency order should be preserved, got ${JSON.stringify(callOrder)}`,
  );
  assert(!reviewerStartedTooEarly, `Reviewer must wait for the first frontend slice, got ${JSON.stringify(callOrder)}`);
  assert(
    !secondFrontendStartedTooEarly,
    `Second frontend slice must wait for the reviewer that depends on the first slice, got ${JSON.stringify(callOrder)}`,
  );
  assert(!verifierStartedTooEarly, `Verifier must wait for the reviewed final frontend slice, got ${JSON.stringify(callOrder)}`);
}

async function runPmConditionalReviewRepairCardIsDroppedRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const callOrder: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-conditional-review-repair-drop",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Queue a frontend slice, review it, then verify it without pre-queuing a conditional repair." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM queued a conditional post-review repair card that should be sanitized away.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the only frontend slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the finished frontend slice and say ready if it is clean.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands: "Reviewer latest findings를 반영하라. blocking issue만 최소 수정하고 리뷰가 ready-only면 코드 변경 없이 그 사실만 적어라.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify after review finishes.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        callOrder.push("frontend");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend slice completed.",
            "[FilesCreated]",
            "index.html",
            "src/app.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        callOrder.push("reviewer");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 없음.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        callOrder.push("verifier");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Verified after the PM-owned review gate only.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM conditional review repair card to be dropped");
  assert(
    JSON.stringify(callOrder) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Conditional post-review repair card should be removed from the PM queue, got ${JSON.stringify(callOrder)}`,
  );
}

async function runParentQueuedWorkflowSuppressesChildDelegationRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const callOrder: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-parent-queued-suppresses-child-delegation",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Keep the PM-owned workflow order intact." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM workflow handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM queued the full implementation-review-verification workflow.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "backend",
                Commands: "Build the first backend slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "backend",
                Commands: "Build the second backend slice after the first.",
                CommandSender: "pm",
                DependsOn: ["backend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review the completed backend slices.",
                CommandSender: "pm",
                DependsOn: ["backend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify only after review.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend" && instruction.includes("first backend slice")) {
        callOrder.push("backend:first");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the first backend slice, but incorrectly suggested an early verifier handoff.",
            "[FilesCreated]",
            "src/backend/first.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "verifier",
                Commands: "Prematurely verify after only the first backend slice.",
                CommandSender: "backend",
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend" && instruction.includes("second backend slice")) {
        callOrder.push("backend:second");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the second backend slice.",
            "[FilesCreated]",
            "src/backend/second.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        callOrder.push("reviewer");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        callOrder.push("verifier");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Verified after the PM-owned workflow completed.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed parent-owned workflow.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM-owned workflow to complete even if a child tries to delegate early");
  const firstSecondIndex = callOrder.indexOf("backend:second");
  const firstReviewerIndex = callOrder.indexOf("reviewer");
  const firstVerifierIndex = callOrder.indexOf("verifier");
  assert(
    firstSecondIndex > 0 &&
      firstReviewerIndex > firstSecondIndex &&
      firstVerifierIndex > firstReviewerIndex &&
      !callOrder.slice(0, firstReviewerIndex).includes("verifier"),
    `Parent queued workflow should keep verifier behind the parent-owned backend/reviewer queue, got ${JSON.stringify(callOrder)}`,
  );
}

async function runPmTaskSectionFallbackPreservesSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const implementationInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-task-section-fallback",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a complex input-driven frontend artifact with bounded slices." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the frontend in bounded slices.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend is needed.",
            "- backend is (none).",
            "- reviewer is needed.",
            "- verifier is needed.",
            "",
            "FRONTEND_TASKS:",
            "- Build the shell and local sample data.",
            "- Add search, favorites, and live recommendation refresh.",
            "",
            "BACKEND_TASKS:",
            "- (none)",
            "",
            "REVIEWER_TASKS:",
            "- Review the exclusion rules and refresh behavior.",
            "",
            "VERIFIER_TASKS:",
            "- Verify the user flow and one negative case.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Implement the whole frontend in one broad pass.",
                CommandSender: "pm",
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "ui_builder") implementationInstructions.push(instruction);
      if (role === "reviewer") reviewerInstructions.push(instruction);
      if (role === "verifier") verifierInstructions.push(instruction);
      if (role === "ui_builder") {
        const files = instruction.includes("Build the shell and local sample data")
          ? ["index.html", "src/data/sample.js"]
          : ["src/app.js", "src/favorites.js"];
        return {
          stdout: [
            "[STEP_1_RESULT]",
            `${role} completed fallback delegated work.`,
            "[FilesCreated]",
            ...files,
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Verified the user-flow smoke: add/create item, search flow, favorite persistence, live recommendation refresh, and one negative/adversarial unavailable candidate stayed excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed fallback delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM task-section fallback delegation to complete");
  assert(
    implementationInstructions.length === 2,
    `Fallback should preserve two frontend slices instead of collapsing to one command, got ${JSON.stringify(implementationInstructions)}`,
  );
  assert(
    implementationInstructions[0]?.includes("Build the shell and local sample data") &&
      implementationInstructions[1]?.includes("Add search, favorites, and live recommendation refresh"),
    `Fallback should map FRONTEND_TASKS one-to-one into the user-created implementation agent, got ${JSON.stringify(implementationInstructions)}`,
  );
  assert(
    implementationInstructions.every((instruction) =>
      instruction.includes("for the assignment: Create a complex input-driven frontend artifact with bounded slices."),
    ) &&
      implementationInstructions.every((instruction) => !instruction.includes("for the assignment: Final PM handoff")),
    `Fallback should preserve the original user assignment instead of the PM step label, got ${JSON.stringify(implementationInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && reviewerInstructions[0]?.includes("Review the exclusion rules and refresh behavior"),
    `Fallback should preserve reviewer task sections, got ${JSON.stringify(reviewerInstructions)}`,
  );
  assert(
    verifierInstructions.length === 1 && verifierInstructions[0]?.includes("Verify the user flow and one negative case"),
    `Fallback should preserve verifier task sections, got ${JSON.stringify(verifierInstructions)}`,
  );
}

async function runIncompletePmTaskSectionPlanRetriesCompactRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let planAttempts = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-incomplete-pm-task-section-retry",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a fresh input-driven meeting room recommendation website." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    maxCliCalls: 12,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      calls.push({ role, instruction });
      if (role === "pm" && sequencerMatch?.[1] == null) {
        planAttempts += 1;
        if (planAttempts === 1) {
          return {
            stdout: [
              "[SEQUENCER_PLAN]",
              "PM_SUMMARY:",
              "- Build a client-side meeting-room recommender.",
              "",
              "FRONTEND_TASKS:",
              "- Scaffold app: create build-ready package.json, tsconfig, vite config, index.html, src/main, src/App, and seed data only.",
              "- Build scoring engine: implement capacity, equipment, distance, quietness, preferred floor, conflict scoring, and exclusion reasons only.",
              "- Wire interactions: add date/time/people/equipment/search/favorites inputs and instant recompute except integrat",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Final compact PM handoff",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Complete the generated web artifact through bounded frontend slices.",
            "",
            "FRONTEND_TASKS:",
            "- Scaffold/base data: create package.json, tsconfig, vite config, index.html, src/main, src/App, and static room/booking data only.",
            "- Scoring/rule engine: implement capacity, equipment, distance, quietness, preferred floor, conflict scoring, and exclusion reasons only.",
            "- Input-state/live recompute: wire date, time range, people, equipment, preferred floor, quiet toggle, search, filters, and immediate recompute.",
            "- Favorites/localStorage/polish: add no-login favorites persistence, final result cards, true-only recommendation reasons, and excluded-room reasons.",
            "",
            "BACKEND_TASKS:",
            "- (none)",
            "",
            "REVIEWER_TASKS:",
            "- Review only after all four frontend slices are complete.",
            "",
            "VERIFIER_TASKS:",
            "- Verify build/smoke and one negative conflict case after review.",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "ui_builder") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented one bounded slice.",
            "[FilesCreated]",
            `src/slice-${calls.filter((call) => call.role === "ui_builder").length}.ts`,
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      }
      if (role === "verifier") {
        return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected incomplete PM task-section plan to retry compactly and then complete");
  const roles = calls.map((call) => call.role);
  assert(planAttempts === 2, `Expected one compact PM planning retry, got ${planAttempts}`);
  assert(
    JSON.stringify(roles.filter((role) => role === "ui_builder")) === JSON.stringify([
      "ui_builder",
      "ui_builder",
      "ui_builder",
      "ui_builder",
    ]),
    `Incomplete PM task-section should not execute truncated slices; got ${JSON.stringify(roles)}`,
  );
  const firstImplementationCall = calls.find((call) => call.role === "ui_builder");
  assert(
    firstImplementationCall?.instruction.includes("Scaffold/base data") === true &&
      !firstImplementationCall.instruction.includes("except integrat"),
    `Implementation should use the complete PM handoff, not truncated planning text: ${firstImplementationCall?.instruction}`,
  );
  assert(
    JSON.stringify(roles.slice(-2)) === JSON.stringify(["reviewer", "verifier"]),
    `Quality gates should run after recovered implementation slices, got ${JSON.stringify(roles)}`,
  );
}

async function runFreshWebPmFallbackSkipsDirtyAuditRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-fresh-web-fallback",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command:
          "Create a fresh Vite React TypeScript mini game web app with package.json, tsconfig.json, vite.config.ts, index.html, src/main.tsx, src/App.tsx, keyboard controls, score, restart, and localStorage high score.",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    maxCliCalls: 12,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch == null) {
        return {
          stdout: "PM_SUMMARY:\n- Build the fresh client-side game artifact.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed one fresh web fallback slice.",
            "[FilesCreated]",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src/main.tsx",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      if (role === "verifier") return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected fresh web PM fallback to complete through implementation and quality gates");
  const pmStepCalls = calls.filter((call) => call.role === "pm" && call.instruction.includes("Prompting_Sequencer_"));
  assert(
    pmStepCalls.length === 0,
    `Fresh-create PM fallback should not spend a PM step auditing dirty diffs, got ${JSON.stringify(pmStepCalls.map((call) => call.instruction))}`,
  );
  const frontendCalls = calls.filter((call) => call.role === "frontend");
  assert(
    frontendCalls.length >= 5 &&
      frontendCalls[0]?.instruction.includes("Create the fresh client-side web scaffold/foundation") &&
      frontendCalls[1]?.instruction.includes("Implement the domain data, rules, and scoring engine") &&
      frontendCalls[2]?.instruction.includes("Wire input state, search/filter, and immediate recompute") &&
      frontendCalls[3]?.instruction.includes("Add local persistence and modification-safe user state") &&
      frontendCalls[4]?.instruction.includes("Finish results UI, empty/error states, premium polish, and smoke/build support"),
    `Fresh-create PM fallback should split scaffold, rules, state, persistence, and polish into implementation slices, got ${JSON.stringify(frontendCalls.map((call) => call.instruction))}`,
  );
  assert(
    frontendCalls.every((call) => !call.instruction.includes("Intent: explicit_backend_python")),
    `Fresh web fallback must not become backend/Python scope, got ${JSON.stringify(frontendCalls.map((call) => call.instruction))}`,
  );
}

async function runDirectIncompletePmTaskSectionRetriesCompactRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let pmCalls = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-incomplete-pm-task-section-retry",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command: "Create a fresh meeting-room recommendation web app.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    maxCliCalls: 12,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm") {
        pmCalls += 1;
        if (pmCalls === 1) {
          return {
            stdout: [
              "[SEQUENCER_PLAN]",
              "PM_SUMMARY:",
              "- Build a client-side meeting-room recommender.",
              "",
              "FRONTEND_TASKS:",
              "- Scaffold: create package.json, tsconfig, vite config, index.html, src/main, src/App, and room data only.",
              "- Scoring: implement conflict/capacity/equipment ranking and exclusion reasons only.",
              "- Input/state: wire date, time, people, equipment, search, favorite filters, and instant recompute except integrat",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Complete the generated web artifact through bounded frontend slices.",
            "",
            "FRONTEND_TASKS:",
            "- Scaffold/base data: create package.json, tsconfig, vite config, index.html, src/main, src/App, and static room/booking data only.",
            "- Scoring/rule engine: implement capacity, equipment, distance, quietness, preferred floor, conflict scoring, and exclusion reasons only.",
            "- Input-state/live recompute: wire date, time range, people, equipment, preferred floor, quiet toggle, search, filters, and immediate recompute.",
            "- Favorites/localStorage/polish: add no-login favorites persistence, final result cards, true-only recommendation reasons, and excluded-room reasons.",
            "",
            "REVIEWER_TASKS:",
            "- Review only after all four frontend slices are complete.",
            "",
            "VERIFIER_TASKS:",
            "- Verify build/smoke and one negative conflict case after review.",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "ui_builder") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented one recovered bounded slice.",
            "[FilesCreated]",
            `src/recovered-${calls.filter((call) => call.role === "ui_builder").length}.ts`,
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      if (role === "verifier") return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected direct incomplete PM task-section handoff to retry compactly and then complete");
  const roles = calls.map((call) => call.role);
  assert(pmCalls === 2, `Expected one direct PM compact retry, got ${pmCalls}`);
  assert(
    JSON.stringify(roles.filter((role) => role === "ui_builder")) === JSON.stringify([
      "ui_builder",
      "ui_builder",
      "ui_builder",
      "ui_builder",
    ]),
    `Direct incomplete PM output should not execute truncated slices, got ${JSON.stringify(roles)}`,
  );
  const firstImplementationCall = calls.find((call) => call.role === "ui_builder");
  assert(
    firstImplementationCall?.instruction.includes("Scaffold/base data") === true &&
      !firstImplementationCall.instruction.includes("except integrat"),
    `Direct retry should use the complete PM handoff, not truncated direct output: ${firstImplementationCall?.instruction}`,
  );
  assert(
    JSON.stringify(roles.slice(-2)) === JSON.stringify(["reviewer", "verifier"]),
    `Quality gates should run after the recovered direct implementation slices, got ${JSON.stringify(roles)}`,
  );
}

async function runMultiDomainGeneratedArtifactE2ESetRegression(): Promise<void> {
  const domains = [
    {
      name: "restaurant",
      prompt: "Create a restaurant recommendation web app with party size, cuisine, distance, open-now, favorites, and unavailable tables excluded.",
      blocked: "fully booked restaurants stay excluded",
    },
    {
      name: "meeting-room",
      prompt: "Create a meeting-room reservation recommender with time, capacity, equipment, quiet preference, localStorage favorites, and conflict exclusions.",
      blocked: "already booked rooms stay excluded",
    },
    {
      name: "workout",
      prompt: "Create a workout routine recommender with equipment, injury limits, time, intensity preference, favorites, and unsafe exercises excluded.",
      blocked: "unsafe exercises stay excluded",
    },
    {
      name: "travel",
      prompt: "Create a travel itinerary recommender with budget, weather preference, walking distance, favorites, and closed attractions excluded.",
      blocked: "closed attractions stay excluded",
    },
    {
      name: "inventory",
      prompt: "Create an inventory picking recommender with order lines, stock state, travel path, fragile priority, favorites, and unavailable SKUs excluded.",
      blocked: "out-of-stock SKUs stay excluded",
    },
  ];

  for (const domain of domains) {
    const coordinator = new SequencerCoordinator();
    const calls: CapturedCascadeCall[] = [];
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: `local-${domain.name}`,
      workspace: `/tmp/daacs-sequencer-multi-domain-${domain.name}`,
      cliProvider: null,
      agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
      seed: [{ agentId: "pm", command: `${domain.prompt}\n\nPrompting_Sequencer_1` }],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 8,
      maxCliCalls: 12,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (instruction, options) => {
        const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
        calls.push({ role, instruction });
        if (role === "pm") {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "PM_SUMMARY:",
              `- Build the ${domain.name} generated web artifact as a client-side app with bounded slices.`,
              "",
              "FRONTEND_TASKS:",
              `- Scaffold/base data: create package.json, tsconfig, vite config, index.html, src/main, src/App, and realistic static ${domain.name} data only.`,
              "- Scoring/rule engine: implement hard exclusions, soft preference ranking, top-10 output, and true-only reasons only.",
              "- Input-state/live recompute: wire six or more live controls, search/filter, and immediate recompute.",
              "- Favorites/localStorage/polish: add no-login favorites persistence, final cards, empty states, and excluded-item explanations.",
              "",
              "BACKEND_TASKS:",
              "- (none)",
              "",
              "REVIEWER_TASKS:",
              `- Review ${domain.name} requirements only after all frontend slices are complete.`,
              "",
              "VERIFIER_TASKS:",
              `- Verify build/smoke and negative case: ${domain.blocked}.`,
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "ui_builder") {
          const sliceRun = calls.filter((call) => call.role === "ui_builder").length;
          const filesCreated = sliceRun === 1
            ? [
              "package.json",
              "tsconfig.json",
              "vite.config.ts",
              "index.html",
              "src/main.tsx",
              "src/App.tsx",
              `src/${domain.name}-data.ts`,
            ]
            : [
              `src/${domain.name}-slice-${sliceRun}.tsx`,
            ];
          return {
            stdout: [
              "[STEP_1_RESULT]",
              `Implemented one bounded ${domain.name} slice without DAACS_OS/services or Python server runtime.`,
              "[FilesCreated]",
              ...filesCreated,
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "reviewer") {
          return {
            stdout: taggedReviewerStepOutput(1, `Reviewer checked ${domain.name} requirements after implementation slices.`),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "verifier") {
          return {
            stdout: taggedVerifierStepOutput(
              1,
              `Build/user-flow smoke passed: add/create item flow, input/search/filter controls, empty state, button interaction, mobile responsive dashboard UI, favorite persistence, localStorage favorites, live recommendation refresh, and negative/adversarial case passed: ${domain.blocked}.`,
            ),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: () => {},
    });

    assert(ok, `Expected ${domain.name} generated artifact E2E flow to complete`);
    const roles = calls.map((call) => call.role);
    assert(
      JSON.stringify(roles.filter((role) => role === "ui_builder")) === JSON.stringify([
        "ui_builder",
        "ui_builder",
        "ui_builder",
        "ui_builder",
      ]),
      `Expected four user-created implementation slices for ${domain.name}, got ${JSON.stringify(roles)}`,
    );
    assert(
      JSON.stringify(roles.slice(-2)) === JSON.stringify(["reviewer", "verifier"]),
      `Expected reviewer then verifier after implementation for ${domain.name}, got ${JSON.stringify(roles)}`,
    );
    assert(
      calls.every((call) => !/DAACS_OS\/services|python server/i.test(call.instruction)) &&
        calls.some((call) => call.role === "ui_builder"),
      `Generated artifact flow should stay client-side/user-created for ${domain.name}`,
    );
  }
}

async function runDirectPmLargeOutputRecoversAllTaskSectionSlicesRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const implementationInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-pm-large-output",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command: [
          "Create a fresh input-driven meeting room recommendation website.",
          "It must split scaffold, scoring, live recompute, and favorites/localStorage before review.",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    maxCliCalls: 12,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      if (role === "pm") {
        const partialAgentCommands = [
          {
            AgentName: "ui_builder",
            Commands: "Create package.json, tsconfig, vite config, index.html, src/main, src/App, and seed data only.",
            CommandSender: "pm",
            DependsOn: [],
          },
          {
            AgentName: "ui_builder",
            Commands: "Add pure scoring and exclusion engine only.",
            CommandSender: "pm",
            DependsOn: ["ui_builder"],
          },
          {
            AgentName: "reviewer",
            Commands: "Review after the implementation is complete.",
            CommandSender: "pm",
            DependsOn: ["ui_builder"],
          },
          {
            AgentName: "verifier",
            Commands: "Verify after review.",
            CommandSender: "pm",
            DependsOn: ["reviewer"],
          },
        ];
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "PM_SUMMARY:",
            "- Build a client-side recommendation web app in bounded slices.",
            "",
            "FRONTEND_TASKS:",
            "- Scaffold/base data: create package.json, tsconfig, vite config, index.html, src/main, src/App, and static room/booking data only.",
            "- Scoring/rule engine: implement capacity, equipment, distance, quiet, preferred floor, conflict scoring, and exclusion reasons only.",
            "- Input-state/live recompute: wire date, time range, people, equipment, preferred floor, quiet toggle, search, filters, and immediate recompute.",
            "- Favorites/localStorage/polish: add no-login favorites persistence, final result cards, true-only recommendation reasons, and excluded-room reasons.",
            "",
            "BACKEND_TASKS:",
            "- (none)",
            "",
            "REVIEWER_TASKS:",
            "- Review only after all four frontend slices are complete.",
            "",
            "VERIFIER_TASKS:",
            "- Verify build/smoke and one negative conflict case after review.",
            "[/SEQUENCER_PLAN]",
            "[AGENT_COMMANDS]",
            JSON.stringify(partialAgentCommands),
            "[/AGENT_COMMANDS]",
            "x".repeat(30_000),
          ].join("\n"),
          stderr: [
            "OpenAI Codex v0.124.0",
            "user",
            "Template text from the CLI transcript must not become real work.",
            "FRONTEND_TASKS:",
            '- <one task per line, or "(none)">',
            "REVIEWER_TASKS:",
            '- <one task per line, or "(none)">',
          ].join("\n"),
          exit_code: 0,
        };
      }
      if (role === "ui_builder") {
        implementationInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            `${role} completed one bounded slice.`,
            "[FilesCreated]",
            `src/slice-${implementationInstructions.length}.ts`,
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: taggedVerifierStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected direct PM large-output workflow to complete");
  assert(
    implementationInstructions.length === 4,
    `Direct PM parsing should recover all four task-section implementation slices before review without transcript placeholders, got ${JSON.stringify(implementationInstructions)}`,
  );
  assert(
    implementationInstructions[2]?.includes("Input-state/live recompute") &&
      implementationInstructions[3]?.includes("Favorites/localStorage/polish"),
    `Recovered slices should include the late recompute and localStorage cards, got ${JSON.stringify(implementationInstructions)}`,
  );
  assert(
    implementationInstructions[0]?.includes("Runnable Vite/React scaffold contract:") &&
      implementationInstructions[0]?.includes("@types/react") &&
      implementationInstructions[0]?.includes("build/type tooling") &&
      implementationInstructions[0]?.includes('type: "module"') &&
      implementationInstructions[0]?.includes("Vite <=6.4.1") &&
      implementationInstructions[0]?.includes("npm audit warnings") &&
      implementationInstructions[0]?.includes("moduleResolution: \"bundler\""),
    `Scaffold implementation slice should receive runnable Vite/React config guardrails, got ${JSON.stringify(implementationInstructions[0] ?? "")}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Quality gates should still run once after recovered implementation slices, got reviewer=${reviewerInstructions.length}, verifier=${verifierInstructions.length}`,
  );
}

async function runCoreOnlyRosterBlocksImplementationQualityRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const pmInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-core-only-roster-blocker",
    cliProvider: null,
    agentsMetadataJson: CORE_ONLY_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a no-login recommendation website that needs implementation." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") pmInstructions.push(instruction);
      if (role === "reviewer") reviewerInstructions.push(instruction);
      if (role === "verifier") verifierInstructions.push(instruction);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Build the requested product.",
            "",
            "FRONTEND_TASKS:",
            "- Build the app shell, search, favorites, and live recompute.",
            "",
            "REVIEWER_TASKS:",
            "- Review the implementation against the request.",
            "",
            "VERIFIER_TASKS:",
            "- Verify the user-visible flow.",
            "",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} handled the assigned blocker.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected core-only roster blocker cascade to complete without fake quality gates");
  assert(
    reviewerInstructions.length === 0 && verifierInstructions.length === 0,
    `Core-only roster must not send reviewer/verifier to approve missing implementation, got reviewer=${reviewerInstructions.length}, verifier=${verifierInstructions.length}`,
  );
  assert(
    pmInstructions.some((instruction) =>
      instruction.includes("no user-created implementation agent") &&
      instruction.includes("Blocked implementation slices:") &&
      instruction.includes("frontend: Build the app shell"),
    ),
    `Core-only roster should route a visible implementation blocker back to PM, got ${JSON.stringify(pmInstructions)}`,
  );
}

async function runTransientPmProviderFailureDoesNotRetryPlanRegression(): Promise<void> {
  const runCase = async (provider: string, stderr: string): Promise<void> => {
    const coordinator = new SequencerCoordinator();
    let pmPlanCalls = 0;
    const logLabels: string[] = [];
    const agentMessages: string[] = [];

    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace: `/tmp/daacs-sequencer-provider-failure-no-plan-retry-${provider}`,
      cliProvider: provider,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [{ agentId: "pm", command: "Create a complex recommendation website." }],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 3,
      maxCliCalls: 5,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (_instruction, options) => {
        const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
        if (role === "pm") pmPlanCalls += 1;
        return {
          stdout: "",
          stderr,
          exit_code: 1,
          provider,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logLabels.push(String(entry.label ?? ""));
      },
      onAgentMessage: (message) => {
        agentMessages.push(String(message.text ?? ""));
      },
    });

    assert(!ok, "Transient provider failure should fail the cascade instead of pretending success");
    assert(
      pmPlanCalls === 1,
      `PM planning should not be retried by the sequencer after transient provider failure; provider runner already retried, got ${pmPlanCalls}`,
    );
    assert(
      !logLabels.some((label) => label.includes("AgentCascadePlanRetry")),
      `Transient provider failure should not create a plan-retry call, got ${JSON.stringify(logLabels)}`,
    );
    assert(
      agentMessages.some((text) => text.includes("provider temporary failure")),
      `Agent message should expose provider failure clearly, got ${JSON.stringify(agentMessages)}`,
    );
  };

  await runCase(
    "codex",
    "failed to refresh available models: We're currently experiencing high demand\nstream disconnected - retrying sampling request (5/5)",
  );
  await runCase(
    "gemini",
    "TerminalQuotaError: You have exhausted your capacity on this model. Your quota will reset after 16h33m56s. reason: QUOTA_EXHAUSTED",
  );
}

async function runLooseReviewerVerdictRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const messages: string[] = [];
  const logLabels: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-loose-reviewer-verdict-routes-implementation",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "reviewer",
      command: "Review the generated web recommendation artifact.\n\nPrompting_Sequencer_1",
      originAssignmentContext: "Build a frontend web recommendation artifact with live inputs and result cards.",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    maxCliCalls: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer" && calls.filter((call) => call.role === "reviewer").length === 1) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "",
            "[ReviewFindings]",
            "- Missing UI and live recommendation cards.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "- User-facing flow is not complete.",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented the missing UI and live recommendation cards.",
            "[FilesCreated]",
            "src/App.tsx",
            "src/recommend/recommendSeats.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer accepted the repaired artifact."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier passed the repaired artifact."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logLabels.push(String(entry.label ?? ""));
    },
    onAgentMessage: (message) => {
      messages.push(`${String(message.officeRole ?? "")}:${String(message.text ?? "")}`);
    },
  });

  assert(
    ok,
    `Expected loose reviewer verdict rework to route to implementation and finish, got roles=${JSON.stringify(calls.map((call) => call.role))} messages=${JSON.stringify(messages)} logs=${JSON.stringify(logLabels)}`,
  );
  return calls;
}

async function runImplementationEmptyStdoutChangedFilesBecomeEvidenceRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-empty-stdout-observed-files",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "frontend",
      command: "Build the generated web artifact shell.\n\nPrompting_Sequencer_1",
      originAssignmentContext: "Build a no-login generated web recommendation artifact.",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    maxCliCalls: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    runHostWorkspaceCommand: async (command) => {
      if (/^find\s+\./.test(command)) {
        return { stdout: "src/App.tsx\nsrc/recommendSeats.ts\n", stderr: "", exit_code: 0 };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    },
    onCliLog: () => {},
    onAgentExecutionComplete: (value) => {
      completions.push(value);
    },
  });

  assert(ok, "Empty implementation stdout with observed changed files should not be treated as no-artifact failure");
  const changedFiles = completions[0]?.changedFiles ?? [];
  assert(
    changedFiles.includes("src/App.tsx"),
    `Observed changed files should be promoted to FilesCreated evidence, got ${JSON.stringify(changedFiles)}`,
  );
}

async function runWebScaffoldEmptyProviderOutputRoutesExactRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-empty-provider-web-scaffold",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "frontend",
      command: [
        "Complete this PM-assigned scaffold/foundation slice for the assignment: 자연어 요청으로 플레이 가능한 2D 미니게임 웹앱을 만들어줘.",
        "",
        "Assigned slice:",
        "Scaffold only the runnable Vite/React app shell and first playable screen.",
        "",
        "Prompting_Sequencer_1",
      ].join("\n"),
      originAssignmentContext: "자연어 요청으로 플레이 가능한 2D 미니게임 웹앱을 만들어줘.",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    maxCliCalls: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "Reading additional input from stdin...",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the runnable scaffold after the empty provider output.",
            "[FilesCreated]",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src/main.tsx",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      if (role === "verifier") return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      return {
        stdout: `[STEP_1_RESULT]\nUnexpected role ${role}\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected empty provider output on web scaffold to route exact scaffold repair, got roles=${JSON.stringify(calls.map((call) => call.role))} second=${JSON.stringify(calls[1]?.instruction ?? "")}`,
  );
  return calls;
}

async function runRepeatedImplementationNoArtifactReworkStopsRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-repeated-no-artifact-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "frontend",
      command: [
        "Quality gate feedback requires another repair cycle for this assignment: Build a no-login generated web recommendation artifact.",
        "",
        "Bounded repair slice for this cycle:",
        "frontend: Generated artifact has no reported files.",
        "",
        "Prompting_Sequencer_1",
      ].join("\n"),
      originAssignmentContext: "Build a no-login generated web recommendation artifact.",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    maxCliCalls: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return { stdout: "", stderr: "", exit_code: 0 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(!ok, "Repeated no-artifact implementation repair should fail closed instead of pretending success");
  assert(
    calls.length === 1 && calls[0]?.role === "frontend",
    `Repeated no-artifact implementation repair should not recurse into the same repair loop, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runPartialViteScaffoldRequiresFullScaffoldRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-partial-vite-scaffold-contract",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [{
      agentId: "ui_builder",
      command: [
        "Complete this PM-assigned frontend slice for the assignment: create a fresh client-side Vite/React recommendation web app.",
        "",
        "Assigned slice:",
        "Scaffold/base data: create package.json, tsconfig, vite config, index.html, src/main, src/App, and static data only.",
        "",
        "Prompting_Sequencer_1",
      ].join("\n"),
      originAssignmentContext: "Create a fresh client-side Vite/React recommendation web app with live input and result cards.",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    maxCliCalls: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "ui_builder" && calls.filter((call) => call.role === "ui_builder").length === 1) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created a Vite/React scaffold and verified npm run build.",
            "[FilesCreated]",
            "package.json",
            "index.html",
            "src/main.jsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "ui_builder") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Completed only the missing runnable scaffold files.",
            "[FilesCreated]",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src/main.tsx",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      }
      if (role === "verifier") {
        return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} done.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    runHostWorkspaceCommand: async () => ({ stdout: "", stderr: "", exit_code: 0 }),
    onCliLog: () => {},
  });

  assert(ok, "Partial Vite/React scaffold should be repaired into the full runnable scaffold contract");
  const builderCalls = calls.filter((call) => call.role === "ui_builder");
  assert(builderCalls.length === 2, `Expected one scaffold repair, got ${JSON.stringify(calls.map((call) => call.role))}`);
  const repairInstruction = builderCalls[1]?.instruction ?? "";
  assert(
    repairInstruction.includes("missing runnable scaffold files: tsconfig.json | vite.config | src/App") &&
      repairInstruction.includes("Create only these missing scaffold files"),
    `Scaffold repair should name exact missing files, got ${JSON.stringify(repairInstruction)}`,
  );
}

async function runPmSpecificationDelegationStepStaysPmRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Requirement analysis and domain constraint modeling",
      "2. Final specification and role assignment handoff",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "창고 피킹 추천 웹사이트를 만들어줘. 주문/SKU 검색, 즐겨찾기, 추천 10개, 1-5 주문 변경마다 재계산.",
  );
  const requirementAnalysisCall = calls.find((call) =>
    call.instruction.includes("Requirement analysis and domain constraint modeling"),
  );
  const finalSpecCall = calls.find((call) =>
    call.instruction.includes("Final specification and role assignment handoff"),
  );
  assert(requirementAnalysisCall != null, "Expected requirement analysis PM step call");
  assert(
    requirementAnalysisCall.role === "pm",
    `PM requirement/domain analysis step should stay with PM, got ${requirementAnalysisCall.role}`,
  );
  assert(finalSpecCall != null, "Expected final specification PM step call");
  assert(
    finalSpecCall.role === "pm",
    `PM specification/delegation step should stay with PM, got ${finalSpecCall.role}`,
  );
}

async function runPmGeneratedArtifactFeatureSlicesRouteToImplementationRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 프로젝트 스캐폴딩(웹앱)",
      "2. 데이터/도메인 구조(나중에 API로 교체 가능)",
      "3. 추천 엔진(필터 → 점수 → 이유)",
      "4. 창고 이동거리(막힌 통로 우회)",
      "5. UI(입력 바뀔 때마다 즉시 갱신)",
      "6. 즐겨찾기(로그인 없이)",
      "7. 검증",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "도서관 좌석을 상황별로 추천해주는 웹사이트를 만들어줘. 입력이 바뀔 때마다 추천과 이유가 즉시 바뀌고 로그인은 필요 없어.",
  );
  const executionRoles = calls.slice(1).map((call) => call.role);
  const executionDetails = calls.slice(1).map((call) => ({
    role: call.role,
    instruction:
      call.instruction.match(/## Current Step[\s\S]*?(?:\n\nPrompting_Sequencer_\d+|$)/)?.[0]?.slice(0, 260) ??
      call.instruction.slice(0, 220),
  }));
  assert(
    !executionRoles.includes("pm"),
    `Generated artifact feature slices should not bounce back into PM execution, got ${JSON.stringify(executionDetails)}`,
  );
  assert(
    executionRoles.filter((role) => role === "frontend").length >= 5,
    `Generated artifact feature slices should route to implementation ownership, got ${JSON.stringify(executionDetails)}`,
  );
}

async function runPmAgentCommandsOverrideNarrativePlanRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "- 목표(한 줄): 추천 웹페이지",
      "- 구현 방식: 순수 프론트",
      "- 화면 흐름: 입력과 카드",
      "- 핵심 규칙: 제외와 가산점 분리",
      "- 추천 생성: 10개 만들기",
      "- 산출물: index.html app.js",
      "",
      "[AGENT_COMMANDS]",
      "- frontend(id=frontend, prompt_key=agent_frontend)",
      "  1) Build the complete browser web recommendation artifact from the narrative plan.",
      "  2) 생성 파일: index.html, app.js, styles.css",
      "",
      "- reviewer:",
      "- 작업: Review the completed artifact after implementation.",
      "",
      "- verifier:",
      "- 작업: Verify the completed artifact after review.",
      "[/AGENT_COMMANDS]",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "창고 추천 웹사이트를 만들어줘. 입력이 바뀌면 추천 10개와 이유가 즉시 바뀌어야 해.",
  );
  const executionRoles = calls.slice(1).map((call) => call.role);
  assert(
    JSON.stringify(executionRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `PM AGENT_COMMANDS should override narrative SEQUENCER_PLAN bullets, got ${JSON.stringify(executionRoles)}`,
  );
}

async function runPmMergedCardReferenceSplitsIntoPlanCardsRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "- Evidence: workspace is empty.",
      "1. 웹앱 뼈대",
      "- Deliverable: Vite + React + TypeScript shell.",
      "2. 데이터/교체 가능한 구조",
      "- Deliverable: DataProvider and in-memory data.",
      "3. 추천 엔진",
      "- Deliverable: hard filters, constraints, reasons.",
      "",
      "[AGENT_COMMANDS]",
      "- frontend:",
      "  - 위 카드 1~3을 순서대로 구현하세요.",
      "- reviewer:",
      "  - Review after implementation.",
      "- verifier:",
      "  - Verify after review.",
      "[/AGENT_COMMANDS]",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "입력이 바뀌면 추천이 즉시 바뀌는 창고 추천 웹사이트를 만들어줘.",
  );
  const executionRoles = calls.slice(1).map((call) => call.role);
  assert(
    JSON.stringify(executionRoles) === JSON.stringify(["frontend", "frontend", "frontend", "reviewer", "verifier"]),
    `Merged PM card reference should split back into plan cards, got ${JSON.stringify(executionRoles)}`,
  );
}

async function runPmScaffoldCommandStaysImplementationOwnedRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "[AGENT_COMMANDS]",
      "- frontend:",
      "  - Create Vite React TS app in this workspace root.",
      "- reviewer:",
      "  - Review scaffold output.",
      "- verifier:",
      "  - Verify scaffold output.",
      "[/AGENT_COMMANDS]",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "새 추천 웹앱을 만들어줘.",
  );
  const executionRoles = calls.slice(1).map((call) => call.role);
  assert(
    JSON.stringify(executionRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Scaffold creation commands should stay implementation-owned, got ${JSON.stringify(executionRoles)}`,
  );
}

async function runPmNoLoginFrontendOnlySupportDataRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const backendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-no-login-frontend-only",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Build a no-login single-page restaurant recommendation website with local favorites and honest fallback explanations." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 9,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the no-login recommendation website.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend is needed.",
            "- backend is not needed because support data can stay in the frontend layer.",
            "- reviewer is needed.",
            "- verifier is needed.",
            "",
            "FRONTEND_TASKS:",
            "- Build the app shell and live query state.",
            "",
            "BACKEND_TASKS:",
            "- Connect the restaurant reference data and recommendation scoring support layer so unavailable items stay excluded and honest fallback reasons are returned.",
            "",
            "REVIEWER_TASKS:",
            "- Review exclusion and fallback honesty.",
            "",
            "VERIFIER_TASKS:",
            "- Verify no-login flow and one blocked-item case.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "backend",
                Commands:
                  "Connect the restaurant reference data and recommendation scoring support layer so unavailable items stay excluded and honest fallback reasons are returned.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands: "Build the app shell and live query state.",
                CommandSender: "pm",
                DependsOn: ["backend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review exclusion and fallback honesty.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify no-login flow and one blocked-item case.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        backendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend completed the delegated slice.",
            "[FilesCreated]",
            "backend/app.py",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        if (instruction.includes("Re-run verification for this assignment")) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]pass[/HostFeedbackStatus]",
              "[VerificationStatus]pass[/VerificationStatus]",
              "[Verification]",
              "- User-flow smoke passed after changing search query plus budget, distance, allergy, parking, open-hours, cuisine, spice, and party-size filters.",
              "- Verified local favorites persistence after refresh restore.",
              "- Negative/adversarial evidence: excluded candidates stayed out of the visible recommendations for the current input.",
              "[/Verification]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Verified the no-login happy path renders recommendations without auth.",
            "- Verified local favorites persistence after refresh restore.",
            "- Verified a blocked-item negative case stays excluded and is not described as a good match.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected no-login frontend-only support-data regression to complete");
  assert(
    backendInstructions.length === 0,
    `Frontend-only no-login website should not delegate support/data slices to backend, got ${JSON.stringify(backendInstructions)}`,
  );
  assert(
    frontendInstructions.length === 2 &&
      frontendInstructions[0]?.includes("Frontend support/data slice:") &&
      frontendInstructions[1]?.includes("Build the app shell and live query state."),
    `Frontend-only no-login website should keep support/data and UI slices on frontend, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Frontend-only no-login website should preserve one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmDenseFoundationEngineCommandAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-dense-foundation-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a no-login restaurant recommendation website with real slot data and honest fallback reasons." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 7,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the restaurant recommendation artifact.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend is needed.",
            "- backend is (none).",
            "- reviewer is needed.",
            "- verifier is needed.",
            "",
            "FRONTEND_TASKS:",
            "- Build the recommendation domain in `apps/web`: add real restaurant/slot source-of-truth data, filtering/scoring logic for date/time/party size/seat preference/allergies/budget/distance, hard-exclude sold-out slots, cap results at 10, and return honest no-match reasons plus fallback alternatives with unit tests.",
            "- Build the no-login single-page UI in `apps/web`: bind all inputs to live recompute, show top recommendations with reasons, show empty-state explanation plus fallback alternatives, and keep sold-out slots absent from cards and explanations.",
            "",
            "REVIEWER_TASKS:",
            "- Review exclusion and fallback honesty.",
            "",
            "VERIFIER_TASKS:",
            "- Verify the live flow and a blocked-slot negative case.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands:
                  "Build the recommendation domain in `apps/web`: add real restaurant/slot source-of-truth data, filtering/scoring logic for date/time/party size/seat preference/allergies/budget/distance, hard-exclude sold-out slots, cap results at 10, and return honest no-match reasons plus fallback alternatives with unit tests.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands:
                  "Build the no-login single-page UI in `apps/web`: bind all inputs to live recompute, show top recommendations with reasons, show empty-state explanation plus fallback alternatives, and keep sold-out slots absent from cards and explanations.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review exclusion and fallback honesty.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the live flow and a blocked-slot negative case.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Verified the live happy path.",
            "- Verified a blocked-slot negative case stays excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected dense foundation/engine PM command auto-split to complete");
  assert(
    frontendInstructions.length === 3,
    `Dense foundation/engine PM command should be auto-split into three frontend slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[0]?.includes("Split dense recommendation foundation/frontend support slice part 1/2") &&
      frontendInstructions[1]?.includes("Split dense recommendation engine slice part 2/2") &&
      frontendInstructions[2]?.includes("Build the no-login single-page UI in `apps/web`"),
    `Dense foundation/engine PM command should split into support/data then engine/testing before UI, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Dense foundation/engine split should keep one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmDenseInteractiveCommandAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-dense-interactive-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a dense input-driven reservation recommendation frontend artifact." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 6,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the reservation recommendation artifact with bounded slices.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend is needed.",
            "- reviewer is needed.",
            "- verifier is needed.",
            "",
            "FRONTEND_TASKS:",
            "- Build the app shell and recommendation core.",
            "- Wire party/time/highchair/wheelchair/window/quiet/zone inputs, search, card click selection, and localStorage favorites into one live state flow.",
            "- Finish the result cards and honest empty state.",
            "",
            "REVIEWER_TASKS:",
            "- Review exclusion rules and empty-state honesty.",
            "",
            "VERIFIER_TASKS:",
            "- Verify live recompute, favorites restore, and a negative case.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the app shell and recommendation core.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands:
                  "Wire party/time/highchair/wheelchair/window/quiet/zone inputs, search, card click current selection, and localStorage favorites into one live state flow with immediate recompute.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands: "Finish the result cards and honest empty state.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review exclusion rules and empty-state honesty.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify live recompute, favorites restore, and a negative case.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Verified live recompute, favorites restore, and the negative case.[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected dense PM interactive command auto-split to complete");
  assert(
    frontendInstructions.length === 4,
    `Dense interactive PM command should be auto-split into four frontend slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[1]?.includes("Split dense interactive frontend slice part 1/2") &&
      frontendInstructions[1]?.includes("Do not implement search, card-click current selection, or localStorage favorites in this part") &&
      frontendInstructions[2]?.includes("Split dense interactive frontend slice part 2/2") &&
      frontendInstructions[2]?.includes("search, card-click current selection, and localStorage favorites/persistence"),
    `Dense interactive PM command should be split into state/recompute then search-selection-persistence slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Dense interactive split should keep one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmDenseStateRecomputeCommandAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-dense-state-recompute-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a dense recommendation frontend with a large state model and instant recompute." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 7,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM prepared a dense state/recompute frontend command.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands:
                  "Build the recommendation domain primitives and eligibility rules in `apps/web/src/features/restaurant-recommender`.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands:
                  "Implement the input state model and immediate recompute store/hook in the same feature. Inputs are `date/time/partySize/seatPreference/allergies/budget/maxDistance/searchQuery/favorites`, and any input change must immediately recalculate eligible/excluded/empty-state results without reload.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands:
                  "Render the card UI and localStorage favorites on top of the existing restaurant recommendation feature.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review the restaurant recommendation flow for negative-case honesty.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify live recompute and a negative case.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "src/features/restaurant-recommender/index.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[HostFeedbackStatus]pass[/HostFeedbackStatus]",
            "[Verification]",
            "- User-flow smoke passed: searchQuery input, localStorage favorites, card UI, live recompute, and negative/adversarial unavailable restaurant stayed excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected dense state/recompute PM command auto-split to complete");
  assert(
    frontendInstructions.length === 4,
    `Dense state/recompute PM command should be auto-split into four frontend slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[1]?.includes("Split dense state/recompute frontend slice part 1/2") &&
      frontendInstructions[1]?.includes("input state model, defaults, persistence-ready shape, and update actions") &&
      frontendInstructions[2]?.includes("Split dense state/recompute frontend slice part 2/2") &&
      frontendInstructions[2]?.includes("derived recompute hook/store path"),
    `Dense state/recompute PM command should split state surface from derived recompute wiring, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Dense state/recompute split should keep one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmCompactFoundationEngineCommandAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-compact-foundation-engine-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a compact restaurant recommendation foundation slice." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 7,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the compact restaurant recommendation frontend.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend owns implementation.",
            "- reviewer and verifier close quality gates.",
            "",
            "FRONTEND_TASKS:",
            "- apps/web 범위만 사용해 로컬 식당 데이터, 타입, 추천/제외 순수 계산기를 추가하세요. 입력 축은 date,time,partySize,seatPreference,allergies,budget,distance,favorites 전부 반영하고, 조건 위반 후보는 추천 배열에 들어오지 않게 하세요.",
            "- 같은 화면에 모든 입력을 제출 버튼 없이 즉시 재계산으로 묶고 favorites만 restaurant id 기준 localStorage에 저장·복원하세요.",
            "- 추천 결과 UI를 마무리하고 제외 이유를 보여주세요.",
            "",
            "REVIEWER_TASKS:",
            "- Review constraint fidelity.",
            "",
            "VERIFIER_TASKS:",
            "- Verify the core flow.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands:
                  "apps/web 범위만 사용해 로컬 식당 데이터, 타입, 추천/제외 순수 계산기를 추가하세요. 입력 축은 date,time,partySize,seatPreference,allergies,budget,distance,favorites 전부 반영하고, 조건 위반 후보는 추천 배열에 들어오지 않게 하세요.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands:
                  "같은 화면에 모든 입력을 제출 버튼 없이 즉시 재계산으로 묶고 favorites만 restaurant id 기준 localStorage에 저장·복원하세요.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands: "추천 결과 UI를 마무리하고 제외 이유를 보여주세요.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review constraint fidelity.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the core flow.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "pm" && role !== "reviewer" && role !== "verifier") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "src/features/restaurant-recommender/index.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Verified the core flow.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected compact foundation/engine PM command auto-split to complete");
  assert(
    frontendInstructions.length === 4,
    `Compact foundation/engine PM command should become split foundation + remaining slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[0]?.includes("Split dense recommendation foundation/frontend support slice part 1/2") &&
      frontendInstructions[0]?.includes("Do not implement full ranking, recommendation/scoring engine files") &&
      frontendInstructions[1]?.includes("Split dense recommendation engine slice part 2/2") &&
      frontendInstructions[1]?.includes("Own the recommendation/scoring engine and focused tests here"),
    `Compact foundation/engine command should split support primitives from scoring/filter engine, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Compact foundation/engine split should keep one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmInteractionPersistenceImmediateRecomputeAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-interaction-persistence-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a no-login recommendation web app with search, favorites, and instant recompute." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 9,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the no-login recommender with a smaller interaction/recompute handoff.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend owns the slices.",
            "- reviewer checks hard-rule integrity.",
            "- verifier checks instant recompute and favorites persistence.",
            "",
            "FRONTEND_TASKS:",
            "- Expand apps/web/src/features/restaurant-recommender/{types.ts,seed.ts,engine.ts,store.ts} so the frontend-only support model covers date/time/party/seat/allergy/budget/distance, reservable time slots, and plain-language exclusion reasons.",
            "- Bind restaurant filters for budget, distance, allergies, parking, open hours, cuisine, spice, and party size into one live state flow so every change recomputes instantly; persist favorites plus recent selections with localStorage.",
            "- Finish the result surface so recommended cards show reservable time slots, excluded cards show readable reasons, and empty states are clear.",
            "",
            "REVIEWER_TASKS:",
            "- Review the completed recommender for hard-rule integrity and negative cases.",
            "",
            "VERIFIER_TASKS:",
            "- Verify instant recompute, local favorites persistence, and excluded reasons.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands:
                  "Expand apps/web/src/features/restaurant-recommender/{types.ts,seed.ts,engine.ts,store.ts} so the frontend-only support model covers date/time/party/seat/allergy/budget/distance, reservable time slots, and plain-language exclusion reasons.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands:
                  "Bind restaurant filters for budget, distance, allergies, parking, open hours, cuisine, spice, and party size into one live state flow so every change recomputes instantly; persist favorites plus recent selections with localStorage.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands:
                  "Finish the result surface so recommended cards show reservable time slots, excluded cards show readable reasons, and empty states are clear.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review the completed recommender for hard-rule integrity and negative cases.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify instant recompute, local favorites persistence, and excluded reasons.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "pm" && role !== "reviewer" && role !== "verifier") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "src/features/restaurant-recommender/index.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        if (instruction.includes("Re-run verification for this assignment")) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]pass[/VerificationStatus]",
              "[Verification]",
              "- Verified instant recompute after changing live inputs.",
              "- Verified local favorites persistence after refresh restore.",
              "- Negative/adversarial evidence: excluded candidates stayed out of the visible recommendations for the current input.",
              "[/Verification]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]pass[/HostFeedbackStatus]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke passed for search flow, restaurant filters, instant recompute, local favorites persistence, and excluded reasons.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM interaction/persistence command auto-split to complete");
  assert(
    frontendInstructions.length === 4,
    `PM interaction/persistence command should become foundation + split state/recompute + results slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[1]?.includes("Split dense interaction/persistence frontend slice part 1/2") &&
      frontendInstructions[1]?.includes("Do not implement favorites, recent-selection restore, or localStorage persistence in this part") &&
      frontendInstructions[2]?.includes("Split dense interaction/persistence frontend slice part 2/2") &&
      frontendInstructions[2]?.includes("add favorites, recent selections, and localStorage persistence/restore"),
    `PM interaction/persistence command should split live recompute from persistence/restore wiring, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 &&
      verifierInstructions.length === 1 &&
      verifierInstructions[0]?.includes("Verify instant recompute, local favorites persistence, and excluded reasons"),
    `PM interaction/persistence split should keep one reviewer plus verifier follow-up coverage, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runPmDenseResultPolishCommandAutoSplitRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const frontendInstructions: string[] = [];
  const reviewerInstructions: string[] = [];
  const verifierInstructions: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-dense-results-autosplit",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a recommendation artifact with dense result-card and fallback UX." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 6,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Final PM handoff\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM_SUMMARY:",
            "- Deliver the recommendation artifact with bounded slices.",
            "",
            "ROLE_ASSIGNMENT_NOTES:",
            "- frontend is needed.",
            "- reviewer is needed.",
            "- verifier is needed.",
            "",
            "FRONTEND_TASKS:",
            "- Build the app shell and recommendation core.",
            "- Wire live inputs into one state flow with immediate recompute.",
            "- Finish results UX: show top 10 recommendation cards, per-card reasons, fallback/alternative explanation, empty state, and honest wording so unavailable or blocked items never look like good choices.",
            "",
            "REVIEWER_TASKS:",
            "- Review result honesty and fallback explanation coverage.",
            "",
            "VERIFIER_TASKS:",
            "- Verify top-10 rendering, empty-state explanation, and blocked-item exclusion.",
            "",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build the app shell and recommendation core.",
                CommandSender: "pm",
              },
              {
                AgentName: "frontend",
                Commands: "Wire live inputs into one state flow with immediate recompute.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "frontend",
                Commands:
                  "Finish results UX: show top 10 recommendation cards, per-card reasons, fallback/alternative explanation, empty state, and honest wording so unavailable or blocked items never look like good choices.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "reviewer",
                Commands: "Review result honesty and fallback explanation coverage.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify top-10 rendering, empty-state explanation, and blocked-item exclusion.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed the delegated slice.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        verifierInstructions.push(instruction);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Verified top-10 rendering, fallback explanation, and blocked-item exclusion.[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} completed delegated work.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected dense PM result-polish command auto-split to complete");
  assert(
    frontendInstructions.length === 4,
    `Dense results/polish PM command should be auto-split into four frontend slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    frontendInstructions[2]?.includes("Split dense results/polish frontend slice part 1/2") &&
      frontendInstructions[2]?.includes("visible top-10 result cards and per-item reason rendering") &&
      frontendInstructions[3]?.includes("Split dense results/polish frontend slice part 2/2") &&
      frontendInstructions[3]?.includes("fallback summaries, impossible/empty-state explanation, alternative suggestions, and wording honesty"),
    `Dense result-polish PM command should be split into card rendering then fallback/honesty slices, got ${JSON.stringify(frontendInstructions)}`,
  );
  assert(
    reviewerInstructions.length === 1 && verifierInstructions.length === 1,
    `Dense result-polish split should keep one reviewer and one verifier gate, got reviewer=${JSON.stringify(reviewerInstructions)} verifier=${JSON.stringify(verifierInstructions)}`,
  );
}

async function runCascadeDependencyDeadlockFailsClosedRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const messages: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-dependency-deadlock",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Delegate a malformed cyclic quality graph." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      calls.push({ role, instruction });
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: "[SEQUENCER_PLAN]\n1. Emit the malformed cyclic follow-up graph\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM accidentally emitted a cyclic quality graph.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "reviewer",
                Commands: "Review after verifier.",
                CommandSender: "pm",
                DependsOn: ["verifier"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify after reviewer.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: `[STEP_1_RESULT]\n${role} should not run when dependencies are cyclic.\n[/STEP_1_RESULT]\n{END_TASK_1}`,
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentMessage: (message) => {
      messages.push(message.text);
    },
  });

  assert(ok === false, "Malformed cyclic dependency graphs must fail closed");
  assert(
    calls.every((call) => call.role === "pm"),
    `Deadlocked dependencies should not run arbitrary fallback agents, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  assert(
    messages.some((message) => message.includes("의존성 그래프가 막혀")),
    `Deadlocked dependencies should be surfaced in agent messages, got ${JSON.stringify(messages)}`,
  );
}

async function runDirectCommandSkillRequestCascadeWithLogs(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let directRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-skill-request-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          "Restore apps/web/src/components/office/LlmSettingsModal.tsx reachability\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role !== "frontend") {
        return {
          stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      directRuns += 1;
      if (directRuns === 1) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Need UI skill details before finishing the direct command",
            "[/STEP_1_RESULT]",
            "[SKILL_REQUEST]typescript-pro[/SKILL_REQUEST]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "[SKILL_REQUEST]clean-code[/SKILL_REQUEST]",
          exit_code: 0,
        };
      }
      return {
        stdout:
          "[STEP_1_RESULT]\nExecuted direct frontend command after skill injection\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected direct-command skill-request cascade to complete");
  return { calls, logs };
}

async function runDirectCommandMixedOutputCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-mixed-output-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          "Restore apps/web/src/application/sequencer/SequencerCoordinator.ts mixed stream handling\n\nPrompting_Sequencer_3",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "frontend" && sequencerMatch?.[1] === "3") {
        return {
          stdout:
            "[STEP_3_RESULT]\nFrontend restored the execution result payload.\n[/STEP_3_RESULT]\n{END_TASK_3}",
          stderr:
            '[AGENT_COMMANDS]\n[{"AgentName":"backend","Commands":"Confirm downstream mixed-output handoff was preserved.","CommandSender":"frontend"}]\n[/AGENT_COMMANDS]',
          exit_code: 0,
        };
      }
      if (role === "backend" && sequencerMatch?.[1] === "1") {
        return {
          stdout:
            "[STEP_1_RESULT]\nBackend received the mixed-output delegation.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: sequencerMatch?.[1]
          ? `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`
          : "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected direct-command mixed-output cascade to complete");
  return { calls, logs };
}

async function runDirectCommandMixedOutputSenderPayloadCascade(): Promise<{
  calls: CapturedCascadeCall[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-mixed-sender-payload",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          "Restore apps/web/src/application/sequencer/SequencerCoordinator.ts mixed stream sender payload handling\n\nPrompting_Sequencer_3",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "frontend" && sequencerMatch?.[1] === "3") {
        return {
          stdout:
            "[STEP_3_RESULT]\nFrontend restored the execution result payload.\n[/STEP_3_RESULT]\n{END_TASK_3}",
          stderr:
            '[AGENT_COMMANDS]\n[{"AgentName":"backend","Commands":"Confirm downstream mixed-output handoff was preserved.","CommandSender":"frontend"}]\n[/AGENT_COMMANDS]',
          exit_code: 0,
        };
      }
      if (role === "backend" && sequencerMatch?.[1] === "1") {
        return {
          stdout:
            "[STEP_1_RESULT]\nBackend received the mixed-output delegation.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm") {
        return {
          stdout:
            "[STEP_1_RESULT]\nPM consumed the direct sender payload.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: sequencerMatch?.[1]
          ? `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`
          : "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected mixed-output sender payload cascade to complete");
  return { calls };
}

async function runReviewerStaleFailureFollowupSuppressionCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-stale-reviewer-failure-followup",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the completed apps/web frontend LoL draft implementation and route repair if needed\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });

      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Add champion search before shipping.",
              "- Ignore stale backend/champion_recommendations.py and tests/test_champion_recommendations.py from prior runs; this client-side web repair must stay on active web files.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- No blocking findings.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired the champion search blocker.",
            "[FilesCreated]",
            "index.html",
            "src/app.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Existing smoke test command passed: `npm --prefix apps/web run test:regression`.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer rework suppression cascade to complete");
  return calls;
}

async function runExistingPythonRepairKeepsBackendScopeCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-existing-python-repair-scope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the requested fix to existing backend/champion_recommendations.py and route repair if needed\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });

      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- backend/champion_recommendations.py still fails to exclude banned champions before scoring.",
              "- tests/test_champion_recommendations.py needs the existing regression assertion preserved.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Existing backend repair is now scoped.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "backend" || role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Repaired the existing Python recommendation path.",
            "[FilesCreated]",
            "backend/champion_recommendations.py",
            "tests/test_champion_recommendations.py",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Existing pytest command passed: `pytest tests/test_champion_recommendations.py`.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected existing Python repair scope cascade to complete");
  return calls;
}

async function runReviewOnlyNeedsReworkDoesNotAutoRepairCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-review-only-no-auto-repair",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "검수만 수행하세요. 대상 산출물을 확인만 하고 수정하지 마세요. developer repair는 하지 마세요.\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[ReviewVerdict]needs_rework[/ReviewVerdict]",
          "[ReviewFindings]",
          "- The artifact violates the read-only quality gate and should be reported only.",
          "[/ReviewFindings]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected read-only review cascade to complete without auto-repair");
  return calls;
}

async function runProductNoModifyRequirementStillAutoRepairsCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-product-no-modify-still-repairs",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the completed web artifact for this assignment: 예약 웹사이트를 만들어줘. 사용자는 이미 예약된 시간을 수정하지 못해야 해.\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- The reservation edit lock is missing.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- The repair keeps reserved times locked.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "reviewer" && role !== "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired the reservation edit-lock behavior.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Browser smoke check loaded the reservation page and the reserved-time negative flow passed.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected product no-modify requirement to route repair instead of suppressing auto-repair");
  return calls;
}

async function runLargeQualityReworkUsesBoundedRepairSliceCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bounded-quality-repair",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the completed apps/web recommendation selection implementation\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });

      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- first bounded blocker",
              "- second bounded blocker",
              "- third deferred blocker",
              "- fourth deferred blocker",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Bounded repair accepted.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role !== "reviewer" && role !== "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend completed only the bounded repair slice.",
            "[FilesCreated]",
            "apps/web/src/generated/recommendation.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]bounded repair smoke and negative unavailable-selection check passed[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected large quality rework cascade to complete through the bounded repair slice");
  return calls;
}

async function runMixedReviewerFindingsPrioritizeActualDefectRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-mixed-review-findings-priority",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "완성된 코드와 UI를 리뷰하라. 추천/정렬이 실제 카드 순서와 설명을 어기지 않는지 확인하라.\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- 하드 제외가 soft 점수보다 먼저 먹는 흐름은 맞습니다.",
              "- 검색 필터와 top 10 자르기도 기본 흐름은 맞습니다.",
              "- 이유 문구와 음수 케이스도 누락되지 않았습니다.",
              "- 그런데 Top Pick 은 점수 순 그대로 뽑아서, 실제 첫 카드/상위 10개와 서로 달라질 수 있습니다.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 문제 없음.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" || role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implementation repaired the top-pick ordering mismatch.",
            "[FilesCreated]",
            "index.html",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Browser smoke check confirmed the top pick matches the first recommendation card, and the negative unavailable-selection scenario kept blocked items out of the top card list.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected mixed reviewer findings repair cascade to complete");
  return calls;
}

async function runReviewerReadyNegatedDefectPhraseDoesNotAutoRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-ready-negated-defect",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "완성된 추천 웹앱을 리뷰하라. 현재 입력과 맞지 않는 추천이 남는지, 설명 문구가 잘못 붙는 회귀가 있는지 확인하라.\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 현재 입력과 맞지 않거나 이미 예약된 자리가 1순위 추천으로 남지 않게 막고 있습니다.",
            "- 창가/조용함 설명이 고정 예시처럼 잘못 붙는 회귀는 보이지 않았습니다.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer ready with negated defect phrases to complete without auto-repair");
  return calls;
}

async function runQualityReworkPreservesFullRequirementContextCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-full-context-quality-repair",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          [
            "Review the implementation completed for this assignment: 예약 추천 웹사이트를 만들어줘.",
            "",
            "지역과 날짜와 인원을 입력받아야 해.",
            "이미 예약된 시간은 추천하면 안 돼.",
            "이유는 현재 입력과 맞을 때만 보여줘.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });

      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- 이미 예약된 시간 제외 로직이 없습니다.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]- Full requirement context preserved.[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired the reservation exclusion logic.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Browser smoke check loaded the reservation page and the reserved-time negative flow passed.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected full-context quality rework cascade to complete");
  return calls;
}

async function runQualityRepairUsesOriginAssignmentContextRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;
  const originalAssignmentContext = [
    "예약 추천 웹사이트를 만들어줘.",
    "지역과 날짜와 인원을 입력받아야 해.",
    "이미 예약된 시간은 추천하면 안 돼.",
    "이유는 현재 입력과 맞을 때만 보여줘.",
  ].join("\n");

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-origin-assignment-quality-repair",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          [
            "REVIEWER_TASK 수행: 개발 결과를 리뷰하라. 이미 예약된 시간 제외와 이유 표기가 맞는지 확인하고 발견사항만 파일 근거와 함께 보고하라.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
        senderId: "pm",
        originAssignmentContext: originalAssignmentContext,
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });

      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- 이미 예약된 시간 제외 로직이 없습니다.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]- Origin assignment context preserved.[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role !== "reviewer" && role !== "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implementation repaired the reserved-time exclusion logic.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Browser smoke check loaded the reservation page and the reserved-time negative flow passed.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }

      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected origin-assignment quality repair cascade to complete");
  return calls;
}

async function runBlockedVerifierArtifactCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
  workspace: string;
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "daacs-sequencer-verifier-artifact-"));
  let verifierRuns = 0;

  try {
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "verifier",
          command:
            "Verify apps/web/src/application/sequencer/SequencerCoordinator.ts persistent verification evidence\n\nPrompting_Sequencer_1",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 4,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (instruction, options) => {
        const prompt = String(options?.systemPrompt ?? "");
        if (prompt.includes("The host has executed a shell command")) {
          return {
            stdout: "ABORT: verifier host command could not be completed in this environment",
            stderr: "",
            exit_code: 0,
          };
        }
        const role = prompt.replace(/^role:/, "");
        calls.push({ role, instruction });
        const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
        if (role === "verifier") verifierRuns += 1;
        if (role === "verifier" && verifierRuns === 1 && sequencerMatch?.[1] === "1") {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[Verification]",
              "Verifier attempted the required checks.",
              "[/Verification]",
              "[Command]",
              "1. npm run verify:sequencer",
              "[/Command]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "frontend") {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Frontend repair owner received blocked verification evidence.",
              "[FilesCreated]",
              "apps/web/src/application/sequencer/SequencerCoordinator.ts",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (role === "reviewer") {
          return {
            stdout: taggedReviewerStepOutput(1, "Reviewer confirmed the repair path was scheduled."),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier reran after the repair workflow was scheduled."),
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logs.push({
          label: entry.label,
          stdout: entry.stdout,
          stderr: entry.stderr,
          skillRequestParsed: entry.skillRequestParsed ?? null,
        });
      },
      runHostWorkspaceCommand: async (command) => {
        if (command === "npm run verify:sequencer") {
          return {
            stdout: "running verifier command",
            stderr: "npm ERR! Missing script: verify:sequencer",
            exit_code: 1,
          };
        }
        return { stdout: "", stderr: `unexpected host command: ${command}`, exit_code: 2 };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    assert(ok, "Expected blocked-verifier cascade to stay alive and schedule repair routing");
    return { calls, logs, workspace };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function runMixedStreamArtifactRetentionCascade(): Promise<{
  logs: CapturedCliLog[];
  workspace: string;
}> {
  const coordinator = new SequencerCoordinator();
  const logs: CapturedCliLog[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "daacs-sequencer-mixed-artifact-"));

  try {
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "verifier",
          command:
            "Verify apps/web/src/application/sequencer/SequencerCoordinator.ts mixed-stream artifact retention\n\nPrompting_Sequencer_2",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 1,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (instruction, options) => {
        const prompt = String(options?.systemPrompt ?? "");
        if (prompt.includes("The host has executed a shell command")) {
          return {
            stdout: "OK",
            stderr: "",
            exit_code: 0,
          };
        }
        const role = prompt.replace(/^role:/, "");
        if (role === "verifier" && instruction.includes("Prompting_Sequencer_2")) {
          return {
            stdout: [
              "[STEP_2_RESULT]",
              "Verifier preserved the original deliverable context.",
              "[FilesCreated]",
              "apps/web/src/application/sequencer/SequencerCoordinator.ts",
              "[/FilesCreated]",
              "[Command]",
              "1. npm run verify:sequencer -- --reporter json",
              "[/Command]",
              "{END_TASK_2}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logs.push({
          label: entry.label,
          stdout: entry.stdout,
          stderr: entry.stderr,
          skillRequestParsed: entry.skillRequestParsed ?? null,
        });
      },
      runHostWorkspaceCommand: async (command) => {
        if (command === "npm run verify:sequencer -- --reporter json") {
          return {
            stdout: '{"suite":"sequencer","passed":12}',
            stderr: "warning: using cached fixtures",
            exit_code: 0,
          };
        }
        return { stdout: "", stderr: `unexpected host command: ${command}`, exit_code: 2 };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    assert(ok, "Expected mixed-stream artifact retention cascade to complete");
    return { logs, workspace };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

async function runBrowserLikeVerifierArtifactCascade(): Promise<{
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const logs: CapturedCliLog[] = [];
  const originalProcessDescriptor = Object.getOwnPropertyDescriptor(globalThis, "process");

  Object.defineProperty(globalThis, "process", {
    configurable: true,
    value: undefined,
  });

  try {
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace: "/browser-like/daacs-sequencer-browser-artifact",
      cliProvider: null,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "verifier",
          command:
            "Verify apps/web/src/application/sequencer/SequencerCoordinator.ts browser-safe verification handling\n\nPrompting_Sequencer_2",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 1,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (instruction, options) => {
        const prompt = String(options?.systemPrompt ?? "");
        if (prompt.includes("The host has executed a shell command")) {
          return {
            stdout: "OK",
            stderr: "",
            exit_code: 0,
          };
        }
        const role = prompt.replace(/^role:/, "");
        if (role === "verifier" && instruction.includes("Prompting_Sequencer_2")) {
          return {
            stdout: [
              "[STEP_2_RESULT]",
              "Verifier preserved browser-safe verification output.",
              "[FilesCreated]",
              "apps/web/src/application/sequencer/SequencerCoordinator.ts",
              "[/FilesCreated]",
              "[Command]",
              "1. npm run verify:sequencer -- --reporter json",
              "[/Command]",
              "[/STEP_2_RESULT]",
              "{END_TASK_2}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logs.push({
          label: entry.label,
          stdout: entry.stdout,
          stderr: entry.stderr,
          skillRequestParsed: entry.skillRequestParsed ?? null,
        });
      },
      runHostWorkspaceCommand: async (command) => {
        if (command === "npm run verify:sequencer -- --reporter json") {
          return {
            stdout: '{"suite":"sequencer","passed":12}',
            stderr: "warning: browser-mode skipped artifact persistence",
            exit_code: 0,
          };
        }
        return { stdout: "", stderr: `unexpected host command: ${command}`, exit_code: 2 };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    assert(ok, "Expected browser-like verifier cascade to complete");
    return { logs };
  } finally {
    if (originalProcessDescriptor != null) {
      Object.defineProperty(globalThis, "process", originalProcessDescriptor);
    } else {
      delete (globalThis as { process?: unknown }).process;
    }
  }
}

async function runBackendAlignedReviewerReworkCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-backend-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review auth endpoint compatibility without changing the contract surface\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Preserve BYOK/auth contract compatibility on the backend-aligned surface.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed the backend repair closed the contract-risk gap."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repair owner addressed the backend-aligned auth compatibility issue.",
            "[FilesCreated]",
            "backend/auth_contract.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier reran the backend-aligned checks after reviewer-driven rework."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected reviewer-driven backend-aligned rework cascade to complete");
  return { calls, logs };
}

async function runBackendAlignedVerifierReworkCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-backend-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify auth endpoint compatibility without changing the contract surface\n\nPrompting_Sequencer_2",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "verifier" && sequencerMatch?.[1] === "2") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_2_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[Verification]",
              "Auth endpoint compatibility is still blocked because the backend contract surface is inconsistent with the BYOK expectation.",
              "[/Verification]",
              "{END_TASK_2}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedVerifierStepOutput(2, "Verifier confirmed the backend-aligned contract checks are unblocked after repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repair owner restored the auth contract behavior expected by verification.",
            "[FilesCreated]",
            "backend/auth_contract.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer checked the backend-aligned repair before verification reran."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier confirmed the backend-aligned contract checks are unblocked after repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(
    ok,
    `Expected verifier-driven backend-aligned rework cascade to complete, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return { calls, logs };
}

async function runMixedContextReviewerReworkCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-mixed-context-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the combined BYOK/backend auth repair and apps/web/src/components/office/LlmSettingsModal.tsx settings reachability change\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Preserve BYOK/auth contract compatibility on the backend-aligned surface.",
              "- Restore apps/web/src/components/office/LlmSettingsModal.tsx reachability for the settings flow.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed the mixed backend/frontend repair closed both regressions."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repair owner restored the BYOK/auth contract behavior.",
            "[FilesCreated]",
            "backend/byok_contract.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repair owner restored LlmSettingsModal settings reachability.",
            "[FilesCreated]",
            "apps/web/src/components/office/LlmSettingsModal.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier reran the combined backend/frontend checks after review."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected reviewer-driven mixed-context rework cascade to complete");
  return { calls, logs };
}

async function runMixedContextVerifierReworkCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-mixed-context-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the combined BYOK/backend auth repair and apps/web/src/components/office/LlmSettingsModal.tsx settings reachability change\n\nPrompting_Sequencer_2",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "verifier" && sequencerMatch?.[1] === "2") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_2_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[Verification]",
              "Auth endpoint compatibility is still blocked because the backend contract surface is inconsistent with the BYOK expectation and the settings modal path is unreachable.",
              "[/Verification]",
              "{END_TASK_2}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedVerifierStepOutput(2, "Verifier confirmed the mixed backend/frontend checks are unblocked after repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repair owner restored the auth contract behavior expected by verification.",
            "[FilesCreated]",
            "backend/auth_contract.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repair owner restored the settings modal reachability expected by verification.",
            "[FilesCreated]",
            "apps/web/src/components/office/LlmSettingsModal.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer checked the mixed backend/frontend repair before verification reran."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier confirmed the mixed backend/frontend checks are unblocked after repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected verifier-driven mixed-context rework cascade to complete");
  return { calls, logs };
}

async function runKoreanMixedContextReworkCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-korean-mixed-context-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "리뷰해줘: 백엔드 회원가입/로그인 API와 프론트 설정 화면 Dev 로그인 버튼 수정이 같이 들어간 작업\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- 백엔드 회원가입/로그인 API 계약이 깨졌습니다.",
              "- 프론트 설정 화면에서 Dev 로그인 버튼이 막혀 있습니다.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed Korean mixed-context repair closed both sides."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repaired Korean login/signup API contract issue.",
            "[FilesCreated]",
            "backend/auth_korean.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired Korean settings-screen Dev login button issue.",
            "[FilesCreated]",
            "apps/web/src/components/settings/DevLoginButton.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier reran Korean mixed-context checks."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected Korean mixed-context role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected Korean mixed-context rework cascade to complete");
  return calls;
}

async function runKoreanFrontendLoginButtonReworkCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-korean-frontend-login-rework",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "리뷰해줘: 프론트 설정 화면의 Dev 로그인 버튼 표시 문제만 수정한 작업\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- 프론트 설정 화면에서 Dev 로그인 버튼 표시가 깨졌습니다.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed Korean frontend-only login button repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired Korean Dev login button display issue.",
            "[FilesCreated]",
            "apps/web/src/components/settings/DevLoginButton.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier reran Korean frontend-only login button checks."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected Korean frontend-only role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected Korean frontend-only login button cascade to complete");
  return calls;
}

async function runDesktopDeveloperVerifierReworkCascade(): Promise<{
  calls: CapturedCascadeCall[];
  logs: CapturedCliLog[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-desktop-developer-rework",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the SequencerCoordinator AGENT_COMMANDS handoff and cli.rs Codex session reuse contract for the current hotspot\n\nPrompting_Sequencer_2",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "verifier" && sequencerMatch?.[1] === "2") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_2_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[Verification]",
              "The web sequencer final-step handoff and the desktop Codex session reuse rule still disagree for the current hotspot.",
              "[/Verification]",
              "{END_TASK_2}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedVerifierStepOutput(2, "Verifier confirmed the desktop-aligned repair closed the hotspot mismatch."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Developer repaired the shared web/desktop hotspot with the current roster contract.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerCoordinator.ts",
            "apps/desktop/src-tauri/src/cli.rs",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer checked the desktop-aligned repair before verification reran."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier confirmed the desktop-aligned repair closed the hotspot mismatch."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: entry.label,
        stdout: entry.stdout,
        stderr: entry.stderr,
        skillRequestParsed: entry.skillRequestParsed ?? null,
      });
    },
  });

  assert(ok, "Expected desktop-roster verifier rework cascade to complete");
  return { calls, logs };
}

async function runExecutionCompletionCallbackCascade(): Promise<CapturedExecutionCompletion[]> {
  const coordinator = new SequencerCoordinator();
  const completions: CapturedExecutionCompletion[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-execution-completion-callback",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review auth endpoint compatibility without changing the contract surface\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Preserve BYOK/auth contract compatibility on the backend-aligned surface.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed the backend repair closed the contract-risk gap."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Backend repair owner addressed the backend-aligned auth compatibility issue.",
            "[FilesCreated]",
            "backend/auth_contract.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier checked the execution-completion callback repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentExecutionComplete: (event) => {
      completions.push({
        agentId: event.agentId,
        officeRole: event.officeRole,
        status: event.status,
        mode: event.mode,
        summary: event.summary,
      });
    },
  });

  assert(ok, "Expected execution-completion callback cascade to complete");
  return completions;
}

async function runPmFallbackCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-fallback-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "deepaudit mixed backend and frontend follow-up" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: "[SEQUENCER_PLAN]\n1. Fix backend/src/auth.rs BYOK endpoint compatibility\n2. Restore apps/web/src/components/office/LlmSettingsModal.tsx reachability\n3. Final handoff\n[/SEQUENCER_PLAN]",
            stderr: "",
            exit_code: 0,
          };
        }
        if (sequencerMatch[1] === "3") {
          return {
            stdout:
              "[STEP_3_RESULT]\nFinal handoff: backend and frontend should implement their owned fixes first, then reviewer, then verifier. Not ready until the implementation closes the current issues.\n[/STEP_3_RESULT]\n{END_TASK_3}",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by pm step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer accepted the synthesized fallback handoff."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier accepted the synthesized fallback handoff."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (sequencerMatch?.[1] != null) {
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nExecuted by ${role} step ${sequencerMatch[1]}\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[SEQUENCER_PLAN]\n1. Execute assigned work\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, `Expected PM fallback cascade to complete, got roles=${JSON.stringify(calls.map((call) => call.role))}`);
  return calls;
}

async function runPmFallbackPreservesQualityGuidanceCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-fallback-quality-guidance",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command:
          [
            "예약 추천 웹사이트를 만들어줘.",
            "",
            "지역과 날짜와 인원을 입력받아야 해.",
            "이미 예약된 시간은 추천하면 안 돼.",
            "이유는 현재 입력과 맞을 때만 보여줘.",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: [
              "[SEQUENCER_PLAN]",
              "1. Confirm reservation constraints",
              "2. Final handoff",
              "[/SEQUENCER_PLAN]",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        if (sequencerMatch[1] === "2") {
          return {
            stdout:
              "[STEP_2_RESULT]\n최종 인계: 프론트엔드가 예약 추천 웹 산출물을 구현하고, 리뷰어와 검증자가 이미 예약된 시간 추천 금지와 현재 입력 기준 이유 표시를 확인해야 합니다. 통과 전까지 준비 완료가 아닙니다.\n[/STEP_2_RESULT]\n{END_TASK_2}",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: `[STEP_${sequencerMatch[1]}_RESULT]\nPM confirmed constraints.\n[/STEP_${sequencerMatch[1]}_RESULT]\n{END_TASK_${sequencerMatch[1]}}`,
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: "[SEQUENCER_PLAN]\n1. Implement reservation artifact\n[/SEQUENCER_PLAN]",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented reservation recommendation artifact.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: "[SEQUENCER_PLAN]\n1. Review reservation artifact\n[/SEQUENCER_PLAN]",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]- Constraint coverage accepted.[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: "[SEQUENCER_PLAN]\n1. Verify reservation artifact\n[/SEQUENCER_PLAN]",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Existing smoke test command passed: `npm run verify:reservation-smoke`. Negative reservation scenario passed.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected PM fallback quality-guidance cascade to complete, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runPmFinalImplementationSummaryDoesNotOverFallbackCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-korean-summary-no-fallback",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command: "구현 상태를 요약해줘. 새 작업을 인계하지 말고 현재 완료 여부만 정리해.",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm") {
        if (sequencerMatch?.[1] == null) {
          return {
            stdout: "[SEQUENCER_PLAN]\n1. Summarize current implementation state\n[/SEQUENCER_PLAN]",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout:
            "[STEP_1_RESULT]\n구현 완료 상태 요약: 현재 추가 인계 없이 완료 여부만 정리했습니다.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected Korean PM implementation summary to complete without fallback handoff");
  return calls;
}

async function runReviewerQualityOnlyNestedSuppressionCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-quality-only-nested-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review apps/web/src/application/sequencer/SequencerCoordinator.ts repair routing\n\nPrompting_Sequencer_2",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer" && instruction.includes("Prompting_Sequencer_2")) {
        return {
          stdout: [
            "[STEP_2_RESULT]",
            "Reviewer found a repair-routing regression.",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Repair routing currently regresses when quality-only nested loops are emitted.",
            "[/ReviewFindings]",
            "[AGENT_COMMANDS]",
            '[{"AgentName":"reviewer","Commands":"Re-review after the repair.","CommandSender":"reviewer"},{"AgentName":"verifier","Commands":"Re-verify after the review.","CommandSender":"reviewer","DependsOn":["reviewer"]}]',
            "[/AGENT_COMMANDS]",
            "{END_TASK_2}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired the sequencer routing.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerCoordinator.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Reviewer confirmed the repair.",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Verifier reran the targeted checks.",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed after the bounded build repair; the generated site loaded and a negative unavailable recommendation stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer quality-only nested suppression cascade to complete");
  return calls;
}

async function runDirectNoChangeFailureStopsCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-no-change-failure",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "developer",
        command: "Implement a generated user-facing website from the natural-language request\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return {
        stdout: "",
        stderr: "Codex CLI timed out after 300 seconds with no changed files.",
        exit_code: 1,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(!ok, "Expected no-change direct CLI failure to fail closed");
  return calls;
}

async function runBoundedRepairTimeoutRoutesPmRescopeCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let developerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bounded-repair-timeout-pm-rescope",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "developer",
        command: "Implement a generated user-facing website from the natural-language request\n\nPrompting_Sequencer_1",
        senderId: "pm",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 7,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "developer") {
        developerRuns += 1;
        if (developerRuns <= 2) {
          return {
            stdout: "",
            stderr: "Codex CLI timed out after 300 seconds with no changed files.",
            exit_code: 1,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the smaller PM-rescoped repair slice.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM split the timed-out bounded repair into a smaller execution card.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "developer",
                Commands: "Create only index.html and src/app.js as the smallest runnable website repair slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the smaller website repair slice.",
                CommandSender: "pm",
                DependsOn: ["developer"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the smaller website repair slice with a smoke check.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      }
      if (role === "verifier") {
        return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected bounded repair timeout to recover through PM re-scope");
  return calls;
}

async function runDirectBlockedImplementationDropsNestedVerifierCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let developerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-blocked-implementation-drops-nested",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "developer",
        command:
          "Implement the generated recommendation website and prove it builds\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "developer") {
        developerRuns += 1;
        if (developerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Developer attempted the implementation, but the build is still blocked.",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence: npm run build | exit_code=2 | stderr=TS6133: MainApp is declared but never read.",
              "[/Verification]",
              "[AGENT_COMMANDS]",
              '[{"AgentName":"verifier","Commands":"Verify the generated site now.","CommandSender":"developer"}]',
              "[/AGENT_COMMANDS]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Developer repaired the bounded build blocker.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed after the bounded build repair; the generated site loaded and a negative unavailable recommendation stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected direct blocked implementation to route repair before verification");
  return calls;
}

async function runBundleBlockedImplementationDropsNestedVerifierCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let developerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bundle-blocked-implementation-drops-nested",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Build a generated recommendation website from natural language" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. developer: Implement the generated recommendation website and prove it builds",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "developer") {
        developerRuns += 1;
        if (developerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Developer attempted the implementation, but the build is still blocked.",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence: npm run build | exit_code=2 | stderr=TS6133: MainApp is declared but never read.",
              "[/Verification]",
              "[AGENT_COMMANDS]",
              '[{"AgentName":"verifier","Commands":"Verify the generated site now.","CommandSender":"developer"}]',
              "[/AGENT_COMMANDS]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Developer repaired the bounded build blocker.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed after the bounded build repair; the generated site loaded and a negative unavailable recommendation stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected bundle blocked implementation to route repair before verification");
  return calls;
}

async function runBundleCircularDependencyFailsClosedCascade(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bundle-circular-dependency-fallback",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Repair a generated artifact with a malformed nested handoff DAG" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Prepare the malformed nested handoff DAG for execution",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM received a malformed circular nested handoff DAG from the model.",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "reviewer",
                Commands: "Review after verifier confirms the repair.",
                CommandSender: "pm",
                DependsOn: ["verifier"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify after reviewer confirms the repair.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
              {
                AgentName: "developer",
                Commands: "Resolve the circular handoff by applying the bounded implementation repair first.",
                CommandSender: "pm",
                DependsOn: ["verifier"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Developer resolved the malformed handoff with a bounded repair.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerCoordinator.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout:
            "[STEP_1_RESULT]\nReviewer checked the repaired handoff.\n[ReviewVerdict]\nready\n[/ReviewVerdict]\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout:
            "[STEP_1_RESULT]\nVerifier checked the repaired handoff.\n[VerificationStatus]\npass\n[/VerificationStatus]\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok === false,
    `Expected circular bundle handoff to fail closed, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runReviewerReadyWithOpenRisksTriggersReworkRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-open-risks-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review apps/web/src/application/sequencer/SequencerParser.ts compatibility handling\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer" && instruction.includes("Prompting_Sequencer_1")) {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "ready",
              "[/ReviewVerdict]",
              "[OpenRisks]",
              "- Legacy NEXT_WORKFLOW producers would still be dropped at runtime.",
              "[/OpenRisks]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend restored the parser compatibility expectation.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerParser.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Generated browser app smoke path rendered successfully.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer ready+open-risks regression to trigger repair routing");
  return calls;
}

async function runReviewerReadyWithConcreteFindingsTriggersReworkRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-ready-concrete-findings-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          [
            "Review the implementation completed for this assignment: Create a reservation recommendation website.",
            "Already reserved slots must not be recommended.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer" && instruction.includes("Prompting_Sequencer_1")) {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "ready",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- The app can still recommend already reserved slots.",
              "[/ReviewFindings]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend repaired reserved-slot filtering.",
            "[FilesCreated]",
            "index.html",
            "src/app.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Existing smoke test command passed: `npm --prefix apps/web run smoke`; already reserved slots stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer ready+concrete-findings regression to trigger implementation repair");
  return calls;
}

async function runVerifierPassWithFailureEvidenceTriggersReworkRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-pass-conflict-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify apps/web recommendation artifact quality with happy path and negative path evidence\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "- 실패: Happy path has only tiny fixture coverage, so the requested full draft scenario is not proven.",
              "- 실패: Preferred role only boosts score and can still allow off-role recommendations.",
              "- Happy path cannot be proven from the current implementation because the requested UI is missing.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Browser smoke check loaded the recommendation page, the happy path completed, and the off-role negative path stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "reviewer" && role !== "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend expanded fixture coverage and made preferred role filtering strict.",
            "[FilesCreated]",
            "index.html",
            "src/app.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected verifier pass with failure evidence to trigger repair routing");
  return calls;
}

async function runVerifierPassWithEvidenceGapReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-evidence-gap-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated web recommendation artifact with a user-facing smoke check.",
            "",
            "사용자가 지역과 날짜를 입력해야 합니다.",
            "이미 예약된 시간은 추천하면 안 됩니다.",
            "이유는 현재 입력과 맞을 때만 보여줘야 합니다.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- Public recommendation API checks passed.",
              "[/Verification]",
              "[OpenRisks]",
              "- UI card rendering was not executed in this verification scope.",
              "[/OpenRisks]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- UI smoke check executed, card rendering evidence is present, and already reserved times stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected non-verifier role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected verifier evidence gap to be closed by a verifier-only follow-up");
  return calls;
}

async function runVerifierConcreteRequirementMismatchRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-concrete-mismatch-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated meeting-room recommendation website with a user-facing smoke check.",
            "필터 8종, 추천 10개 제한, 부족 사유, 즐겨찾기 지속성, negative case를 확인해야 합니다.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "- 읽기 점검: `src/App.tsx`의 요청 제어는 총 9개라서 `필터 8종` 합격 기준이 아직 맞지 않는다.",
              "- 읽기 점검: `npm run build`는 통과했지만 이 단계에서는 실제 실행 증거를 만들지 못했다.",
              "[/Verification]",
              "[OpenRisks]",
              "- 실제 실행 증거가 아직 없다.",
              "[/OpenRisks]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the meeting-room website, exercised all 8 filters, and kept the recommendation list capped at 10.",
            "- Favorite persistence stayed saved after reload.",
            "- Reserved-room negative case stayed excluded and could not be recommended or selected, and 부족 사유는 현재 입력에서만 보였다.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "reviewer") {
        return {
          stdout:
            "[STEP_1_RESULT]\nImplementation owner removed the extra filter control and kept the rest of the recommendation behavior intact.\n[FilesCreated]\nsrc/App.tsx\n[/FilesCreated]\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 없음.",
            "[/ReviewFindings]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected non-verifier role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected concrete verifier requirement mismatches to route implementation repair");
  return calls;
}

async function runVerifierGenericPassForArtifactReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-generic-pass-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated reservation recommendation website with a user-facing smoke check.",
            "Already reserved slots must stay excluded.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "작업 완료",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed at http://127.0.0.1:5173 and the negative reserved-slot case stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected generic verifier pass to require verifier-only evidence follow-up");
  return calls;
}

async function runDeveloperBlockedPreviewHostCommandReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-developer-preview-host-reroute",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          [
            "Implement the generated web artifact and prove a local preview smoke check.",
            "사용자는 주문 1~5를 바꾸면 추천 결과가 즉시 다시 계산되어야 합니다.",
            "잠긴 구역과 위험물 무자격 작업자는 추천되면 안 됩니다.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]blocked[/HostFeedbackStatus]",
            "[Verification]Host feedback status: blocked. Host command evidence: 1. python3 -m http.server 4173 --bind 127.0.0.1 | exit_code=-1 | stderr=Rejected invalid host command before execution: python3 -m http.server 4173 --bind 127.0.0.1[/Verification]",
            "[FilesCreated]",
            "index.html",
            "app.js",
            "styles.css",
            "[/FilesCreated]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]Setup-wrapped local preview smoke check executed at http://127.0.0.1:4173 and the locked-zone plus hazmat-negative cases stayed excluded.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected blocked standalone preview host command to reroute to verifier-only follow-up");
  return calls;
}

async function runVerifierBlockedPreviewHostCommandReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-preview-host-reroute",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify the generated web artifact with a user-facing smoke check.",
            "예약 슬롯과 금지 슬롯은 추천되면 안 됩니다.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]blocked[/HostFeedbackStatus]",
              "[Verification]Host feedback status: blocked. Host command evidence: 1. python3 -m http.server 4173 -d frontend | exit_code=-1 | stderr=Rejected invalid host command before execution: python3 -m http.server 4173 -d frontend[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]User-flow smoke check passed with an existing project preview script at http://127.0.0.1:4173, the browser preview loaded successfully, and the blocked-slot negative case remained excluded and not selectable without using a standalone preview server.[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected blocked verifier preview host command to reroute to verifier-only follow-up");
  return calls;
}

async function runVerifierApiOnlyPassForWebArtifactReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-api-only-web-pass",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated booking website with a user-facing smoke check.",
            "Unavailable slots must stay excluded from recommendations.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- Public API checks passed with exit_code=0.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the website preview, submitted the form, and confirmed unavailable slots stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected API-only web verifier pass to require interactive evidence follow-up");
  return calls;
}

async function runVerifierInteractiveNeedWithoutEvidenceReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-interactive-need-without-evidence",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated portfolio website with a user-facing smoke check.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- Browser smoke check still needs to be run before final confidence.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the landing page and verified the hero and contact form rendered.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing interactive evidence wording to require verifier-only follow-up");
  return calls;
}

async function runKoreanVerifierInteractiveNeedWithoutEvidenceReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-korean-verifier-interactive-need",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "생성된 포트폴리오 웹사이트를 사용자 관점에서 검증하세요.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- 브라우저 스모크 검증이 아직 필요합니다.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- 브라우저 스모크에서 랜딩 페이지 로드와 문의 폼 렌더링을 확인했습니다.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected Korean missing interactive evidence wording to require verifier-only follow-up");
  return calls;
}

async function runVerifierBrowserOnlyDecisionFlowReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-browser-only-decision-pass",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated restaurant booking recommendation website with a user-facing smoke check.",
            "Already reserved times must stay excluded from recommendations.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- Browser smoke check loaded the recommendation page and submitted the form.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the page, submitted the form, and the negative reserved-time scenario stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected browser-only decision-flow verifier pass to require negative evidence follow-up");
  return calls;
}

async function runVerifierNegativeNeedWithoutEvidenceReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-negative-need-without-evidence",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated booking recommendation website with a user-facing smoke check.",
            "Already reserved times must stay excluded from recommendations.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- Browser smoke check loaded the recommendation page.",
              "- A negative reserved-time scenario is still needed before final confidence.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the page and confirmed the negative reserved-time scenario stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing negative-evidence wording to require verifier-only evidence follow-up");
  return calls;
}

async function runKoreanVerifierNegativeNeedWithoutEvidenceReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-korean-verifier-negative-need",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "생성된 예약 추천 웹사이트를 사용자 관점에서 검증하세요.",
            "이미 예약된 시간은 추천에서 제외되어야 합니다.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "- 브라우저 스모크로 추천 페이지 로드는 확인했습니다.",
              "- 예약된 시간 부정 케이스 검증이 아직 필요합니다.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- 브라우저 스모크에서 예약된 시간 부정 케이스가 추천되지 않음을 확인했습니다.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected Korean missing negative-evidence wording to require verifier-only follow-up");
  return calls;
}

async function runRepeatedVerifierEvidenceGapFailsClosedRegression(): Promise<{
  ok: boolean;
  calls: CapturedCascadeCall[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-repeated-verifier-evidence-gap",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated reservation recommendation website with a user-facing smoke check.",
            "Already reserved slots must stay excluded.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]",
          "pass",
          "[/VerificationStatus]",
          "[Verification]",
          "작업 완료",
          "[/Verification]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: role === "verifier" ? "" : `unexpected role: ${role}`,
        exit_code: role === "verifier" ? 0 : 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  return { ok, calls };
}

async function runRepeatedSameQualityFailureFailsClosedRegression(): Promise<{
  ok: boolean;
  calls: CapturedCascadeCall[];
  messages: string[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const messages: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-repeated-quality-failure",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command: [
          "Review the bounded repair slice for this assignment: reservation recommendation website.",
          "",
          "Bounded repair slice under review:",
          "1. reviewer: already reserved slots can still be recommended.",
          "",
          "Quality gate failures outside this bounded slice are intentionally deferred until a later review/verifier pass.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- already reserved slots can still be recommended.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected repeated quality repair role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentMessage: (message) => {
      messages.push(message.text);
    },
  });

  return { ok, calls, messages };
}

async function runChangedHostFailureDoesNotTripRepeatedQualityRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-changed-host-failure-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Quality gate feedback requires another repair cycle for this assignment: meeting-room recommendation website.",
          "",
          "Bounded repair slice for this cycle:",
          "1. backend: Host command failed. failing_command=npm install && npm run build ; failure=src/App.tsx(1,35): error TS7016: Could not find a declaration file for module 'react'.",
          "",
          "Own only the bounded repair slice above.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend" || role === "frontend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm install && npm run build | exit_code=1 | stdout=src/App.tsx(195,21): error TS7053: Element implicitly has an 'any' type because expression of type 'RoomExclusionReason' can't be used to index type 'Record<ExclusionFilter, string>'. Property 'invalid-time-window' does not exist on type 'Record<ExclusionFilter, string>'.",
              "[/Verification]",
              "[FilesCreated]",
              "package.json",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Fixed the new exclusion filter key mismatch.",
            "[FilesCreated]",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Changed host failure was repaired.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Host build passed after the key mismatch repair.",
            "- User-flow smoke passed: changing the reservation input refreshed visible recommendations.",
            "- Negative/adversarial decision-flow passed: a booked conflicting room stayed excluded from top recommendations.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected changed host failure role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, `Expected changed host failure to receive a new repair attempt, got roles=${JSON.stringify(calls.map((call) => call.role))}`);
  return calls;
}

async function runVerifierFileOnlyPassForUserFacingArtifactReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-file-only-pass-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated reservation recommendation website with a user-facing smoke check.",
            "Already reserved slots must stay excluded.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[Verification]",
              "작업 완료",
              "[/Verification]",
              "[FilesCreated]",
              "index.html",
              "src/app.js",
              "[/FilesCreated]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed at http://127.0.0.1:5173 and the negative reserved-slot case stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected file-only verifier pass to require verifier-only user-flow evidence");
  return calls;
}

async function runVerifierFileExistenceHostPassForUserFacingArtifactReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-file-host-pass-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated reservation recommendation website with a user-facing smoke check.",
            "Already reserved slots must stay excluded.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. ls index.html src/app.js | exit_code=0 | stdout=index.html src/app.js",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed at http://127.0.0.1:5173 and the negative reserved-slot case stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected file-existence host pass to require verifier-only user-flow evidence");
  return calls;
}

async function runVerifierBuildOnlyHostPassForUserFacingArtifactReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-build-only-host-pass-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated reservation recommendation website with a user-facing smoke check.",
            "Already reserved slots must stay excluded.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run build | exit_code=0 | stdout=vite built in 1.2s",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke check executed at http://127.0.0.1:5173 and the negative reserved-slot case stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected build-only host pass to require verifier-only user-flow evidence");
  return calls;
}

async function runVerifierInsufficientSmokeHostPassRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-insufficient-smoke-host-pass-regression",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated meeting-room reservation recommendation web app with a rendered DOM/localStorage user-flow smoke check.",
            "Already reserved rooms must stay excluded and favorite clicks must persist.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run smoke | exit_code=0 | stdout=smoke passed: recommendations, exclusions, quiet-only, and negative search wording are consistent.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Rendered DOM user-flow smoke passed: changed inputs, clicked favorite, localStorage persisted, and reserved-room negative case stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Added artifact-local rendered DOM/localStorage smoke coverage.",
            "[FilesCreated]",
            "scripts/smoke.mjs",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Rendered smoke coverage is now present for DOM interaction and localStorage.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected insufficient smoke host pass to route implementation smoke-support repair");
  return calls;
}

async function runVerifierPassMissingExplicitFeatureEvidenceRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-missing-explicit-feature-evidence",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated todo web app with add, edit, delete, filters, and localStorage.",
            "The verifier must not pass unless every named visible interaction is covered by executable evidence.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run smoke | exit_code=0 | stdout=Smoke passed: add/edit/delete and localStorage parsing are safe.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Host command evidence:",
            "1. npm run smoke | exit_code=0 | stdout=Smoke passed: add, edit, delete, all/active/completed filters, and localStorage persistence.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Added the missing filter interaction and covered it in the artifact-local smoke path.",
            "[FilesCreated]",
            "src/App.tsx",
            "scripts/smoke.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Filter interaction is now covered with the same artifact-local smoke path as add/edit/delete/localStorage.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected missing explicit feature evidence to route implementation repair, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runVerifierPassMissingViewportActionEvidenceRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-missing-viewport-action-evidence",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify the repaired frontend web artifact for a cafe dashboard.",
          "The QA request says the right-side table/actions area was clipped outside the viewport.",
          "Do not pass unless desktop and mobile evidence proves no horizontal viewport overflow and action buttons are visible/reachable.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "pass",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "pass",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run build && npm run smoke | exit_code=0 | stdout=Source smoke passed and table code exists.",
              "[/Verification]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Playwright browser screenshot at desktop and mobile viewport confirmed no horizontal viewport overflow; action buttons are visible/reachable.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Fixed the clipped table action layout.",
            "- Playwright browser screenshot at desktop and mobile viewport confirmed no horizontal viewport overflow; action buttons are visible/reachable.",
            "[FilesCreated]",
            "src/styles.css",
            "scripts/smoke.mjs",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Viewport overflow/action visibility evidence is now covered by the artifact-local browser smoke path.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(!ok || calls.length >= 2, "Expected viewport evidence gap to prevent immediate verifier-only pass");
  return calls;
}

async function runVerifierBlockedMissingScriptReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-missing-script-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify repaired Python recommendation artifact after a missing verification script command\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. python3 verify_champion_recommendations.py | exit_code=2 | stderr=can't open file 'verify_champion_recommendations.py': No such file or directory",
              "[/Verification]",
              "[OpenRisks]",
              "- Core acceptance criterion is still not executable-evidence verified until an existing dependency-free test command is run.",
              "[/OpenRisks]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Existing test command passed: `python3 -m unittest tests/test_champion_recommendations.py`; banned or already-selected recommendations stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing-script verifier block to be closed by a verifier-only follow-up");
  return calls;
}

async function runVerifierMissingWebSmokeSupportRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-missing-web-smoke-support",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify generated meeting-room booking recommendation web app.",
          "User flow must prove input changes, localStorage favorites, and booked rooms staying excluded.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[Verification]",
              "- `npm run build` exit 0 and recommendation logic negative cases pass.",
              "- No Playwright/Puppeteer/jsdom dependency, no smoke/test script, and no browser user-flow test file exists.",
              "- DOM input changes and localStorage favorite persistence cannot be proven from file inspection alone.",
              "[/Verification]",
              "[OpenRisks]",
              "- Browser-level user flow remains unverified because the generated web artifact has no existing smoke script or test file.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- `npm run smoke` passed: user-flow smoke changed inputs, persisted a favorite in localStorage, and kept booked rooms excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Added the smallest artifact-local smoke support without changing recommendation logic.",
            "[FilesCreated]",
            "package.json",
            "src/App.smoke.test.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Smoke support is artifact-local and does not use Python or DAACS_OS/services.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected missing generated web smoke support to route to implementation repair, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runImplementationEnvironmentHostBlockReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-implementation-env-host-block-regression",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "developer",
        command:
          "Implement recommendation artifact and verify the banned champion invariant\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implementation is unchanged; host verification tried pytest first.",
            "[HostFeedbackStatus]",
            "blocked",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Host command evidence:",
            "1. python -m pytest tests/test_champion_recommendations.py | exit_code=127 | stderr=sh: python: command not found",
            "2. python3 -m pytest tests/test_champion_recommendations.py | exit_code=1 | stderr=/opt/homebrew/bin/python3: No module named pytest",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Dependency-free fallback passed: `python3 -m unittest tests/test_champion_recommendations.py`; the banned champion invariant stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair loop\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected environment-only host command blocks to be closed by verifier evidence");
  return calls;
}

async function runNodeDependencyHostBlockReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-node-dependency-host-block-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          [
            "Repair generated web app smoke support and verify the booking recommendation invariant.",
            "Already booked rooms must stay excluded from recommendations.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Added the smallest smoke script for the generated app.",
            "[HostFeedbackStatus]",
            "blocked",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Host feedback status: blocked",
            "Host command evidence:",
            "1. npm run build && npm run smoke | exit_code=2 | stdout=> build > tsc && vite build",
            "src/App.tsx(1,46): error TS2307: Cannot find module 'react' or its corresponding type declarations.",
            "src/main.tsx(7,3): error TS2875: This JSX tag requires the module path 'react/jsx-runtime' to exist, but none could be found.",
            "[/Verification]",
            "[FilesCreated]",
            "scripts/smoke.mjs",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Host rerun passed after one install step: `npm install && npm run build && npm run smoke` exit code 0.",
            "- Negative path passed: already booked rooms stayed excluded from recommendations.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair loop\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing node dependency host block to be closed by verifier install/build/smoke evidence");
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["frontend", "verifier"]),
    `Missing node dependencies before install should reroute to verifier, not another implementation repair, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runTsConfigModuleResolutionHostBlockRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-tsconfig-module-resolution-host-block-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated meeting-room recommendation web app build and smoke.",
            "The artifact must be runnable as a Vite/React app.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier" && calls.filter((call) => call.role === "verifier").length === 1) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "blocked",
            "[/VerificationStatus]",
            "[HostFeedbackStatus]",
            "blocked",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Host command evidence:",
            "1. npm run build | exit_code=2 | stdout=> build > tsc && vite build",
            "tsconfig.json(13,25): error TS5107: Option 'moduleResolution=node10' is deprecated and will stop functioning in TypeScript 7.0.",
            "[/Verification]",
            "[OpenRisks]",
            "- Build is blocked until tsconfig.json is compatible with the current TypeScript version.",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Updated tsconfig.json moduleResolution to bundler for the current TypeScript version.",
            "[FilesCreated]",
            "tsconfig.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- tsconfig.json repair is narrow and build-focused.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm run build passed after tsconfig.json moduleResolution repair.",
            "- Rendered user-flow smoke check passed in the browser preview.",
            "- Negative/adversarial decision-flow evidence passed: already reserved rooms stayed excluded from recommendations.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected TS5107 tsconfig host block to route a narrow implementation repair, got ${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 300) })))}`,
  );
  return calls;
}

async function runReactTypeHostBlockRoutesPackageRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-react-type-host-block-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated meeting-room recommendation web app build and smoke.",
            "The artifact must be runnable as a Vite/React TypeScript app.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run build | exit_code=2 | stdout=> build > tsc && vite build",
              "src/App.tsx(1,46): error TS7016: Could not find a declaration file for module 'react'.",
              "src/main.tsx(2,22): error TS7016: Could not find a declaration file for module 'react-dom/client'.",
              "src/App.tsx(184,5): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.",
              "[/Verification]",
              "[OpenRisks]",
              "- Build is blocked until React type declarations are added to the scaffold dependency manifest.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm run build passed after package.json gained React type devDependencies.",
            "- User-flow smoke passed and booked rooms stayed excluded.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Added @types/react and @types/react-dom to package.json only.",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- package.json repair is narrow and dependency-only.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected React type declaration host block to route a narrow package.json repair, got ${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 300) })))}`,
  );
  return calls;
}

async function runViteAuditHostBlockRoutesPackageRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-vite-audit-host-block-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated travel recommendation web app install/build/audit.",
            "The artifact must be runnable as a Vite/React TypeScript app with clean package audit output.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm audit --audit-level=moderate | exit_code=1 | stdout=# npm audit report",
              "esbuild  <=0.24.2",
              "Severity: moderate",
              "  vite  <=6.4.1",
              "  Depends on vulnerable versions of esbuild",
              "2 moderate severity vulnerabilities",
              "[/Verification]",
              "[OpenRisks]",
              "- Package audit is not clean for a brand-new generated web artifact.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm install, npm audit --audit-level=moderate, and npm run build passed after package.json dependency refresh.",
            "- User-flow smoke passed and excluded items stayed excluded.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Updated package.json only to use non-vulnerable current Vite/plugin-react tooling.",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- package.json repair is narrow and dependency-only.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected Vite/esbuild audit host block to route a narrow package.json repair, got ${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 300) })))}`,
  );
  return calls;
}

async function runPackagePeerConflictRoutesPackageRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-package-peer-conflict-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated workout recommendation web app install/build/audit.",
            "The artifact must be runnable as a Vite/React TypeScript app with compatible package peers.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm install | exit_code=1 | stdout=npm error code ERESOLVE",
              "npm error ERESOLVE unable to resolve dependency tree",
              "npm error Found: vite@7.3.2",
              "npm error Could not resolve dependency:",
              "npm error peer vite=\"^8.0.0\" from @vitejs/plugin-react@6.0.1",
              "[/Verification]",
              "[OpenRisks]",
              "- package.json dependency peers are incompatible.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm install, npm audit --audit-level=moderate, and npm run build passed after package.json peer alignment.",
            "- User-flow smoke passed and excluded items stayed excluded.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Updated package.json only to align vite and @vitejs/plugin-react peer ranges.",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- package.json peer repair is narrow and dependency-only.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected package peer conflict to route a narrow package.json repair, got ${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 300) })))}`,
  );
  return calls;
}

async function runMissingGeneratedWebTestRunnerRoutesPackageRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-missing-test-runner-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          [
            "Verify generated todo web app build and smoke.",
            "The artifact must be runnable as a Vite/React TypeScript app.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "fail",
              "[/VerificationStatus]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run smoke | exit_code=1 | stderr=Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@playwright/test' imported from /tmp/artifact/playwright.config.ts",
              "[/Verification]",
              "[OpenRisks]",
              "- Smoke imports @playwright/test but package.json does not install the runner.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm install, npm run build, and npm run smoke passed after smoke dependency repair.",
            "- User-flow smoke passed for add/delete/filter/localStorage.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Added the missing smoke runner dependency in package.json only.",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- package.json smoke dependency repair is narrow and dependency-only.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected missing generated smoke/test runner to route a narrow package/smoke repair, got ${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 300) })))}`,
  );
  return calls;
}

async function runVerifierMissingPackageRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-missing-package-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify generated warehouse picking recommendation web app after implementation.",
          "The artifact should be runnable and user-facing.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") {
        verifierRuns += 1;
        if (verifierRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[VerificationStatus]",
              "blocked",
              "[/VerificationStatus]",
              "[Verification]",
              "- `package.json` is missing from the workspace root, so `npm run build` cannot verify the generated web app.",
              "[/Verification]",
              "[OpenRisks]",
              "- The web artifact is structurally incomplete until package.json is restored.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-facing web app build and smoke evidence now pass after package.json repair.",
            "- Negative/adversarial decision-flow passed: invalid warehouse picks stayed excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Restored the missing runnable web package manifest.",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected verifier missing package.json blocker to route implementation repair, got calls=${JSON.stringify(calls.map((call) => ({ role: call.role, instruction: call.instruction.slice(0, 240) })))}`,
  );
  return calls;
}

async function runGeneratedWebsiteRejectsBackendOnlyArtifactRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-generated-web-shape-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command:
          "미용실 예약 웹사이트를 만들어줘. 이미 예약된 시간은 다시 추천하면 안 되고, 사용자가 원하는 디자이너와 시간대를 기준으로 빈 시간을 추천해야 해.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented reservation recommendation rules only.",
            "[FilesCreated]",
            "backend/reservation_recommendations.py",
            "tests/test_reservation_recommendations.py",
            "[/FilesCreated]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the missing runnable web artifact.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "src/styles.css",
            "[/FilesCreated]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Smoke checked the reservation flow with an already-reserved slot excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected backend-only web artifact shape failure to route to frontend repair, got roles=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runGeneratedWebsiteAcceptsLooseReportedFilesRegression(): Promise<{
  calls: CapturedCascadeCall[];
  completions: CapturedExecutionCompletion[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-loose-web-files-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: "사용자 자연어 요청으로 회의실 예약 웹사이트를 만들어줘\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built a runnable meeting-room reservation web artifact.",
            "Files changed:",
            "- index.html",
            "- src/app.js",
            "- src/styles.css",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected repair from loose file report\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentExecutionComplete: (event) => {
      completions.push({
        agentId: event.agentId,
        officeRole: event.officeRole,
        status: event.status,
        mode: event.mode,
        summary: event.summary,
        changedFiles: event.changedFiles,
      });
    },
  });

  assert(ok, "Expected loose reported file list to satisfy generated web artifact shape");
  return { calls, completions };
}

async function runGeneratedArtifactWorkspaceInventoryRecoversFileEvidenceRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const hostCommands: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-artifact-inventory-recovers-file-evidence",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: "프리미엄 운동 루틴 추천 웹앱을 만들어줘. 검색/필터, 즐겨찾기, 모바일, 빈 상태, 에러 상태가 있어야 해.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the requested web app but the provider dropped the file report footer.",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      if (role === "verifier") return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected repair from workspace inventory evidence\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      hostCommands.push(command);
      if (command.includes("-newer")) {
        return { stdout: "", stderr: "", exit_code: 0 };
      }
      if (command.startsWith("find .")) {
        return {
          stdout: [
            "./package.json",
            "./tsconfig.json",
            "./vite.config.ts",
            "./index.html",
            "./src/main.tsx",
            "./src/App.tsx",
            "./src/recommend.ts",
            "./src/styles.css",
            "./scripts/smoke.ts",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    },
  });

  assert(
    ok,
    `Expected generated artifact workspace inventory to recover real file evidence, got roles=${JSON.stringify(calls.map((call) => call.role))} host=${JSON.stringify(hostCommands)}`,
  );
  assert(
    calls.every((call) => !call.instruction.includes("Generated artifact has no reported files")),
    `Recovered artifact inventory should not trigger no-files repair, got ${JSON.stringify(calls.map((call) => call.instruction))}`,
  );
  return calls;
}

async function runPmAssignedSupportSliceSkipsGeneratedWebShapeRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const workspace = "/tmp/daacs-sequencer-pm-support-slice-web-shape-regression";

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace,
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: [
          "Complete this PM-assigned frontend slice for the assignment: 회의실 예약 조건과 팀 선호에 맞는 추천 웹사이트를 만들어줘",
          "",
          "Assigned slice:",
          "2/3 입력 연결 구현: 검색, 인원 수, 화상회의 장비, 집중실, 층, 시간대, 팀 선호, 예약 상태 변경을 화면 상태에 묶고 새로고침 없이 추천과 이유가 즉시 다시 계산되게 만든다.",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        await mkdir(join(workspace, "src/meetingRooms"), { recursive: true });
        await writeFile(join(workspace, "src/meetingRooms/recommendationScreenStore.ts"), "export const screenStore = {};\n");
        await writeFile(join(workspace, "src/meetingRooms/recommendationEngine.ts"), "export const recommendationEngine = {};\n");
        await writeFile(join(workspace, "src/meetingRooms/sampleData.ts"), "export const sampleData = [];\n");
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Connected the input state store and recomputation flow for the recommendation screen state.",
            "[FilesCreated]",
            "src/meetingRooms/recommendationScreenStore.ts",
            "src/meetingRooms/recommendationEngine.ts",
            "src/meetingRooms/sampleData.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected repair for a bounded support slice\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok || calls.length === 1,
    `Expected PM-assigned support slice to avoid generated-web shape repair fan-out, got ok=${String(ok)} calls=${JSON.stringify(calls.map((call) => call.role))}`,
  );
  assert(
    calls.every((call) => !call.instruction.includes("Generated web artifact is incomplete")),
    `Support slice should not receive generated-web shape repair instructions, got ${JSON.stringify(calls.map((call) => call.instruction))}`,
  );
  return calls;
}

async function runMissingRunnableWebScaffoldRoutesNarrowRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-runnable-scaffold-missing-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: [
          "창고 피킹 작업자가 주문마다 구역/장비 추천 웹사이트를 만들어줘.",
          "React/Vite로 실행 가능한 화면이어야 하고 추천은 입력이 바뀔 때 즉시 다시 계산되어야 합니다.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ArtifactFileStatus]",
              "missing=package.json | tsconfig.json | vite.config.ts | index.html | src/main.tsx | src/App.tsx",
              "[/ArtifactFileStatus]",
              "I scaffolded the React/Vite project and prepared the recommendation UI.",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the missing runnable React/Vite scaffold before handing off to review.",
            "[FilesCreated]",
            "package.json",
            "tsconfig.json",
            "vite.config.ts",
            "index.html",
            "src/main.tsx",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing runnable web scaffold files to route a narrow implementation repair");
  return calls;
}

async function runMissingExplicitRequestedArtifactFileRoutesNarrowRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-explicit-file-missing-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: [
          "Build a Vite React TypeScript todo web app.",
          "Create package.json tsconfig.json vite.config.ts index.html src/main.tsx src/App.tsx src/styles.css.",
          "Add complete delete filter all active done and localStorage only.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Built the todo Vite React TypeScript app.",
              "[FilesCreated]",
              "package.json",
              "tsconfig.json",
              "vite.config.ts",
              "index.html",
              "src/main.tsx",
              "src/App.tsx",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the explicitly requested missing stylesheet and imported it from the app entry.",
            "[FilesCreated]",
            "src/styles.css",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected missing explicitly requested artifact file to route a narrow implementation repair");
  return calls;
}

async function runBuildMissingScaffoldFileRoutesTargetedRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-build-missing-scaffold-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: [
          "Complete this PM-assigned frontend slice for the assignment: 회의실 추천 웹사이트를 만들어줘.",
          "",
          "Assigned slice:",
          "Fix the generated web app build after reviewer found structural issues.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. npm run build | exit_code=2 | stdout=> app@0.1.0 build > tsc && vite build",
              "tsconfig.json(20,18): error TS6053: File '/tmp/generated/tsconfig.node.json' not found.",
              "[/Verification]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the missing Vite node tsconfig file before rerunning build.",
            "[FilesCreated]",
            "tsconfig.node.json",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      }
      if (role === "verifier") {
        return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected build missing scaffold file to route targeted implementation repair");
  return calls;
}

function runPriorStepsLooseFileMemoryRegression(): void {
  const block = SequencerParser.BuildPriorStepsBlock(
    [
      {
        row: {
          agentId: "frontend",
          command: "Build a user-facing web artifact from natural language",
          stepNumber: 1,
          cliRole: "frontend",
          officeRole: "frontend",
        },
        stepResult: {
          stdout: [
            "[STEP_1_RESULT]",
            "Built a runnable web artifact.",
            "Files changed:",
            "- index.html",
            "- src/app.js",
            "- src/styles.css",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
          provider: "regression",
        },
      },
    ],
    1000,
  );
  assert(
    block.includes("Files: index.html, src/app.js, src/styles.css"),
    `Prior-step memory should retain loose file evidence, got ${JSON.stringify(block)}`,
  );
}

async function runConcreteArtifactWithoutFilesRoutesRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-generic-artifact-files-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: "사용자 자연어 요청으로 영수증 분류 CLI 도구를 만들어줘\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "I described the CLI flow but did not create files.",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the receipt classifier CLI artifact.",
            "[FilesCreated]",
            "receipt_classifier.py",
            "README.md",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- File evidence exists for the generated CLI artifact.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected concrete artifact without file evidence to route a bounded repair");
  return calls;
}

async function runImplementationPlanOnlyRepairRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-plan-only-repair-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Quality gate feedback requires another repair cycle for this assignment: 창고 피킹 작업자가 주문마다 구역/장비 추천 웹사이트를 만들어줘.",
          "",
          "Bounded repair slice for this cycle:",
          "- Add locked SKU and maintenance zone exclusion to the recommendation engine.",
          "",
          "Own only the bounded repair slice above.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "I will begin by inspecting the existing recommendation engine and data structures.",
              "[SEQUENCER_PLAN]",
              "1. Inspect engine logic",
              "2. Implement exclusion logic",
              "[/SEQUENCER_PLAN]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented the bounded exclusion repair.",
            "[FilesCreated]",
            "src/engine.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke passed: the recommendation UI rendered, accepted an order input, and refreshed recommendations.",
            "- Negative/adversarial decision-flow passed: locked SKUs and maintenance zones stayed excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected implementation plan-only repair output to reroute implementation before quality gates");
  return calls;
}

async function runMalformedFilesCreatedWithPlanNoiseCountsAsImplementationRegression(): Promise<{
  calls: CapturedCascadeCall[];
  completions: CapturedExecutionCompletion[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-malformed-files-created-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Quality gate feedback requires another repair cycle for this assignment: 식단 추천 웹사이트를 만들어줘.",
          "",
          "Bounded repair slice for this cycle:",
          "- Wire live ingredient search and allergen recompute.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        return {
          stdout: [
            "I will inspect the current UI first.",
            "[SEQUENCER_PLAN]",
            "1. Inspect current files",
            "2. Apply the bounded UI/recompute repair",
            "[/SEQUENCER_PLAN]",
            "[STEP_2_RESULT]",
            "Implemented ingredient search and allergen-driven recompute wiring.",
            "[FilesCreated]",
            "src/App.tsx",
            "src/engine/scoring.ts",
            "[/STEP_2_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentExecutionComplete: (event) => completions.push(event),
  });

  assert(ok, "Expected malformed FilesCreated body with concrete files to count as implementation progress");
  return { calls, completions };
}

async function runImplementationPlanWithSelfDelegatedSlicePreservesNestedExecutionRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-self-delegated-implementation-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Complete this PM-assigned frontend slice for the assignment: 식단 추천 웹사이트를 만들어줘.",
          "",
          "Assigned slice:",
          "Scaffold the runnable app and local recipe provider.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend" && calls.length === 1) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Break scaffold into a concrete execution card.",
            "[/SEQUENCER_PLAN]",
            "[AGENT_COMMANDS]",
            "[{\"AgentName\":\"backend\",\"Commands\":\"Implement the runnable scaffold files now.\",\"CommandSender\":\"backend\"}]",
            "[/AGENT_COMMANDS]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented the runnable scaffold.",
            "[FilesCreated]",
            "package.json",
            "index.html",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected implementation self-delegated execution card to run instead of generic repair");
  return calls;
}

async function runImplementationAnalysisOnlyEmptyFilesRoutesImplementationRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-analysis-only-empty-files-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Build the recommendation results UI with dynamic reason and exclusion justifications.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "I analyzed the current project structure and planned the Top 10 ranking UI, but did not change files.",
              "[FilesCreated]",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented the recommendation results UI.",
            "[FilesCreated]",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected analysis-only empty FilesCreated implementation output to reroute implementation before quality gates");
  return calls;
}

async function runIncrementalNoChangeVerifierHandoffRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-no-change-verifier-handoff-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: [
          "Complete this PM-assigned frontend slice for the assignment: 회의실 예약 중 실시간 추천 웹앱을 만들어줘.",
          "",
          "Assigned slice:",
          "Input/live recompute: wire date, time, people, equipment, floor, quiet, search, and floor filter controls so recommendations refresh immediately on change.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "확인 결과, 현재 `src/App.tsx` 입력들이 request 상태에 직접 연결되어 있습니다.",
            "`useMemo(() => recommendRooms(request), [request])`라서 인원, 장비, 검색, 필터가 바뀌면 추천/제외 목록이 즉시 다시 계산됩니다.",
            "예약 충돌, 인원 부족, 장비 없음은 추천에서 제외되고 이유가 표시됩니다.",
            "이 slice 범위에서는 이미 구현이 요구사항을 만족해서 소스 파일을 더 고치지 않았습니다.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            '[{"AgentName":"verifier","Commands":"Verify the existing input/live recompute slice with a host UI smoke check. Confirm top-10 refresh, conflict exclusion, and localStorage favorites still work.","CommandSender":"backend","DependsOn":[]}]',
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Host smoke passed: changing inputs refreshed the top-10 recommendations.",
            "- Negative/adversarial case passed: conflicting booked rooms stayed excluded.",
            "- Favorite persistence passed through localStorage.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(
    ok,
    `Expected already-satisfied incremental slices to hand off to verifier instead of looping through file-evidence repair, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  return calls;
}

async function runPlaceholderFilesCreatedRoutesRepairRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-placeholder-files-created-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: "사용자 자연어 요청으로 영수증 분류 CLI 도구를 만들어줘\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "No files were created.",
              "[FilesCreated]",
              "none",
              "N/A",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the receipt classifier CLI artifact.",
            "[FilesCreated]",
            "receipt_classifier.py",
            "README.md",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- File evidence exists for the generated CLI artifact.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected placeholder FilesCreated entries to route a bounded repair");
  return calls;
}

async function runReportedMissingArtifactFilesRoutesRepairRegression(): Promise<{
  calls: CapturedCascadeCall[];
  hostCommands: string[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const hostCommands: string[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-missing-reported-files-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: "Build a receipt classifier CLI artifact from a natural-language request\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "backend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Reported a CLI artifact path without actually creating it.",
              "[FilesCreated]",
              "receipt_classifier.py",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the missing CLI artifact path.",
            "[FilesCreated]",
            "receipt_classifier.py",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Reported artifact file exists after repair.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      hostCommands.push(command);
      if (implementationRuns === 1 && command.includes("receipt_classifier.py")) {
        return {
          stdout: "receipt_classifier.py\n",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exit_code: 0,
      };
    },
  });

  assert(
    ok,
    `Expected missing reported artifact file to route a bounded repair, calls=${JSON.stringify(calls.map((call) => call.role))}, host=${JSON.stringify(hostCommands)}`,
  );
  return { calls, hostCommands };
}

async function runBoundedSliceMissingReportedFilesRoutesRepairRegression(): Promise<{
  calls: CapturedCascadeCall[];
  hostCommands: string[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const hostCommands: string[] = [];
  let implementationRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bounded-slice-missing-files-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: "1/3 입력·기초 데이터층 구현\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        implementationRuns += 1;
        if (implementationRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "Completed the bounded foundation slice and reported three files.",
              "[FilesCreated]",
              "index.html",
              "styles.css",
              "app.js",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Recreated the missing bounded-slice file and kept the rest aligned.",
            "[FilesCreated]",
            "index.html",
            "styles.css",
            "app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Bounded slice files now all exist in the workspace.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      hostCommands.push(command);
      if (
        implementationRuns === 1 &&
        command.includes("index.html") &&
        command.includes("styles.css") &&
        command.includes("app.js")
      ) {
        return {
          stdout: "app.js\n",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: "",
        exit_code: 0,
      };
    },
  });

  assert(
    ok,
    `Expected bounded slice missing file evidence to route a bounded repair, calls=${JSON.stringify(calls.map((call) => call.role))}, host=${JSON.stringify(hostCommands)}`,
  );
  return { calls, hostCommands };
}

async function runNoChangeConfirmationWithoutFilesCompletesRegression(): Promise<{
  calls: CapturedCascadeCall[];
  completions: CapturedExecutionCompletion[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-no-change-confirmation-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "backend",
        command: "Inspect existing auth endpoint and confirm no change is needed\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "No file changes are needed; the existing endpoint already satisfies the assigned contract.",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentExecutionComplete: (event) => {
      completions.push({
        agentId: event.agentId,
        officeRole: event.officeRole,
        status: event.status,
        mode: event.mode,
        summary: event.summary,
        changedFiles: event.changedFiles,
      });
    },
  });

  assert(ok, "Expected no-change confirmation without file evidence to complete");
  return { calls, completions };
}

async function runFreshArtifactDirtyWorkspaceIntentRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const command =
    "새로운 식당 예약 추천 웹사이트를 만들어줘. 사용자가 이미 예약된 시간은 추천하면 안 돼. 추천 이유는 현재 입력과 맞을 때만 보여줘.";

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-fresh-artifact-dirty-workspace",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm" && !instruction.includes("Prompting_Sequencer_")) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. frontend -> Create the fresh reservation recommendation web artifact",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the fresh reservation recommendation web artifact.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Fresh artifact scope is isolated from unrelated dirty files.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]",
            "- Happy path and reserved-time negative path passed.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (hostCommand) => {
      if (hostCommand.startsWith("git status --short")) {
        return {
          stdout: " M old-output/index.html\n?? tmp/e2e_lol_old/\n?? .daacs_timeout_marker_pm-step-1\n",
          stderr: "",
          exit_code: 0,
        };
      }
      if (hostCommand.startsWith("git diff --stat")) {
        return {
          stdout: " old-output/index.html | 2 +-\n",
          stderr: "",
          exit_code: 0,
        };
      }
      if (hostCommand.startsWith("git diff --unified=0")) {
        return {
          stdout: "diff --git a/old-output/index.html b/old-output/index.html\n",
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    },
  });

  assert(ok, "Expected fresh artifact dirty-workspace intent cascade to complete");
  return calls;
}

async function runDuplicateNestedQualityFollowupsAreDedupedRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-duplicate-nested-followups",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "developer",
        command: "Implement a small generated browser app and then verify it once\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Generated the browser app.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "{END_TASK_1}",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "verifier",
                Commands: "Verify the generated browser app smoke path.",
                CommandSender: "developer",
              },
              {
                AgentName: "verifier",
                Commands: "Verify the generated browser app smoke path.",
                CommandSender: "developer",
              },
            ]),
            "[/AGENT_COMMANDS]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check loaded the generated browser app.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected duplicate follow-up role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected duplicate nested follow-ups to complete after one verifier run");
  return calls;
}

async function runReviewerEvidenceGapReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-evidence-gap-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review repaired champion recommendation logic after pytest was unavailable\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- `backend/champion_recommendations.py` applies banned/already-selected exclusion before scoring, so the code path itself looks correct.",
            "- The repair still lacks fresh host-run evidence that `python3 -m unittest tests/test_champion_recommendations.py` actually passes.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "- Need one dependency-free host verification run to close the loop: `python3 -m unittest tests/test_champion_recommendations.py`.",
            "[/OpenRisks]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- `python3 -m unittest tests/test_champion_recommendations.py` executed and passed: Ran 1 test, OK; banned/already-selected recommendations stayed excluded.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer evidence gap to be closed by a verifier-only follow-up");
  return calls;
}

async function runReviewerNonGitEvidenceGapReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-nongit-evidence-gap-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "리뷰하세요. fresh temp workspace에서 생성된 회의실 추천 웹 산출물의 규칙 위반 여부를 확인하세요.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 현재 세션 루트는 git 저장소가 아니어서 이번 변경분 diff 자체를 확인할 근거가 없습니다.",
            "- 현재 자료로는 예약된 방/장비 없음/층 불일치가 실제로 계속 제외되는지 검토할 수 없습니다.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "- 브라우저 또는 host-run 검증 증거가 더 필요합니다.",
            "[/OpenRisks]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Existing host-run smoke evidence confirmed reserved rooms and hard-filter violations stay excluded in the current artifact.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer non-git evidence gap to reroute verifier-only");
  return calls;
}

async function runReviewerBrowserEvidenceGapReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-browser-evidence-gap-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "리뷰하세요. 추천 결과 UI repair slice가 실제 브라우저에서 증명되었는지 확인하세요.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- [src/app.js](/tmp/fake/src/app.js#L131) and [src/app.js](/tmp/fake/src/app.js#L235) now make `아쉬운 점` non-empty and renderable in code, but this repair slice still has no actual UI run, capture, or test artifact proving the top 10 cards show it in the browser, so checklist item 1 remains unclosed.",
            "- [src/app.js](/tmp/fake/src/app.js#L265) and [src/recommendationEngine.js](/tmp/fake/src/recommendationEngine.js#L129) hide blocked room names in code, but there is no executed negative-scenario evidence showing the blocked room names stay absent from the current result list and shortage reasons.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke evidence confirmed the top 10 cards render recommendation reasons and tradeoffs, and the blocked-room negative scenario kept room names absent from both result cards and shortage reasons.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer browser-evidence gap to reroute verifier-only");
  return calls;
}

async function runReviewerHostBuildSmokeEvidenceGapReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-host-build-smoke-evidence-gap-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the bounded repair slice for a generated meeting-room recommendation web app.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "needs_rework",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Build/first-screen browser smoke evidence is still missing: workspace has app files, but no provided run log or smoke result proving the Vite/React first screen actually opens.",
            "- Negative/adversarial verification is still unsupported: `src/recommendationSafetyCheck.ts` exists, but no evidence shows it was run or that reserved/conflicting rooms stay out after input changes.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "- A separate verifier can close this by running the build, opening the first screen, and executing one conflict-room scenario after changing inputs.",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Host build passed and first-screen smoke confirmed the recommendation app opens.",
            "- Negative/adversarial conflict scenario confirmed reserved rooms remain excluded with booking-conflict reasons.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected reviewer host-build/smoke evidence gap to reroute verifier-only");
  return calls;
}

async function runReviewerHostFeedbackBlockedReroutesVerifierRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-host-feedback-blocked-reroute",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review generated warehouse recommendation artifact quality with host-command evidence\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "ABORT: quality evidence is still inconclusive; request verifier evidence instead of implementation repair.",
          stderr: "",
          exit_code: 0,
        };
      }
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Reviewer checked the generated artifact and asked for one read-only evidence command.",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[Command]",
            "1. cat package.json",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke evidence passed: the warehouse recommendation page rendered the order input, updated top-10 cards, and a negative/adversarial blocked-SKU scenario stayed excluded with true conditional reasons.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected implementation repair\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => ({
      stdout: `read-only output for ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  assert(ok, "Expected reviewer host-feedback evidence block to reroute verifier-only");
  return calls;
}

async function runReviewerMissingVerdictRerunsReviewerRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-reviewer-missing-verdict-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the generated meeting-room recommendation web artifact.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const reviewerCalls = calls.filter((call) => call.role === "reviewer").length;
      if (role === "reviewer" && reviewerCalls === 1) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Inspect created files and scoring logic",
            "2. Final review verdict",
            "[/SEQUENCER_PLAN]",
            "Loaded cached credentials.",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        assert(
          instruction.includes("Review gate format issues to close") &&
            instruction.includes("Do not emit [SEQUENCER_PLAN]"),
          `Reviewer rerun should receive strict format repair guidance, got ${JSON.stringify(instruction)}`,
        );
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected non-reviewer follow-up\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected malformed reviewer output to be fixed by a reviewer-only rerun");
  return calls;
}

async function runPmPlanRetryRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let pmPlanRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-plan-retry-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "deepaudit parser compatibility and execution routing" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        pmPlanRuns += 1;
        if (pmPlanRuns === 1) {
          return {
            stdout: "WAITING_FOR_STEP_SIGNAL",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Audit the changed parser hotspot and confirm whether legacy producers still need compatibility",
            "2. Restore apps/web/src/application/sequencer/SequencerParser.ts compatibility without dropping old handoffs",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout:
            "[STEP_1_RESULT]\nPM confirmed the hotspot is legacy parser compatibility, not generic workflow cleanup.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && sequencerMatch?.[1] === "2") {
        return {
          stdout:
            "[STEP_2_RESULT]\nFrontend restored the parser compatibility path.\n[/STEP_2_RESULT]\n{END_TASK_2}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected PM plan retry regression to recover with a concrete plan");
  return calls;
}

async function runPmPlanFailureFailsClosedRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-pm-plan-failure-fails-closed",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "deepaudit real LLM provider failure during planning" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm" && !instruction.includes("Prompting_Sequencer_")) {
        return {
          stdout: "",
          stderr: "ERROR planner process exited before producing a plan",
          exit_code: 1,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected follow-up after failed PM plan\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok === false, "PM plan failure should fail closed after one retry");
  return calls;
}

async function runNonGitWorkspaceSkipsDirtyDiffRegression(): Promise<{
  calls: CapturedCascadeCall[];
  hostCommands: string[];
}> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const hostCommands: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-non-git-workspace",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a fresh frontend artifact in a non-git temp workspace" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: ["[SEQUENCER_PLAN]", "1. Scope the fresh artifact request", "[/SEQUENCER_PLAN]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout:
            "[STEP_1_RESULT]\nPM scoped the fresh artifact request without relying on dirty git diff context.\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: "[STEP_1_RESULT]\n[ReviewVerdict]ready[/ReviewVerdict]\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout:
            "[STEP_1_RESULT]\n[VerificationStatus]pass[/VerificationStatus]\n[/STEP_1_RESULT]\n{END_TASK_1}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      hostCommands.push(command);
      if (command.startsWith("git status --short")) {
        return {
          stdout: "",
          stderr: "fatal: not a git repository (or any of the parent directories): .git",
          exit_code: 128,
        };
      }
      return { stdout: "", stderr: "", exit_code: 0 };
    },
  });

  assert(ok, "Non-git workspaces should still complete without dirty-diff follow-up commands");
  return { calls, hostCommands };
}

async function runPmKoreanFinalHandoffStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 요구사항과 금지조건을 정리해 추천 규칙과 입력 상태를 확정한다",
      "2. 필요한 역할만 골라 웹 전달물 기준의 구현·리뷰·검증 작업으로 최종 핸드오프를 만든다",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "창고 추천 웹사이트 긴 handoff 계획",
  );
}

async function runPmHandoffWritingVariantStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 요구사항·제약·추천규칙 정리",
      "2. 역할별 구현·검토·검증 handoff 작성",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "창고 추천 웹사이트 handoff writing variant",
  );
}

async function runPmImplementationVerificationHandoffWritingStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 요구사항·제약·성공조건 정리",
      "2. 역할별 구현·검증 핸드오프 작성",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "창고 추천 웹사이트 implementation verification handoff writing variant",
  );
}

async function runPmExplicitRoleExecutionHandoffWritingStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 요구사항·금지조건·추천규칙을 압축해 입력/상태/제약 모델로 정리",
      "2. 구현 범위를 확정하고 developer·reviewer·verifier용 최종 실행 핸드오프 작성",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "레스토랑 추천 웹사이트 explicit role execution handoff writing variant",
  );
}

async function runPmRoleCriteriaDelegationCardWritingStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 요구사항과 제외 조건을 테이블 추천 규칙, 상태, 음수 케이스 기준으로 압축하기",
      "2. 프론트엔드 중심 구현·리뷰·검증 역할에 맞춰 산출물, 완료 기준, 위임 카드로 정리하기",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "restaurant role criteria delegation card writing variant",
  );
}

async function runPmReadOnlyScopeAndHandoffPlanningStaysOnPmRegression(): Promise<CapturedCascadeCall[]> {
  return await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 현재 변경 파일과 직접 연관 코드만 읽고 예약 추천 웹사이트 요구사항, 제약, 위험, 기존 구현 영향 범위를 압축 정리한다",
      "2. 구현·리뷰·실검증까지 이어지는 최소 역할 분담과 완료 기준을 최종 handoff 형식으로 작성한다",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "restaurant read-only scope and handoff planning variant",
  );
}

async function runVerifierReworkUsesRecentImplementationOwnerRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const developerCompletion = [
    "[TaskComplete]",
    JSON.stringify({
      Sender: "frontend",
      Command: "Repair the sequencer verifier hotspot",
      Status: "success",
      Summary: "Frontend repaired the verifier hotspot.",
      ChangedFiles: ["apps/web/src/application/sequencer/SequencerParser.ts"],
      Verification: "targeted sequencer repair completed",
    }),
    "[/TaskComplete]",
  ].join("\n");
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-direct-owner-regression",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: developerCompletion,
      },
      {
        agentId: "verifier",
        command:
          "Verify the repaired work for recent-owner routing\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") verifierRuns += 1;
      if (role === "verifier" && verifierRuns === 1 && instruction.includes("Prompting_Sequencer_1")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "blocked",
            "[/VerificationStatus]",
            "[Verification]",
            "The repaired work still needs another targeted implementation pass.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Frontend received the recent-owner rework handoff.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerParser.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer checked the recent-owner repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: taggedVerifierStepOutput(1, "Verifier checked the recent-owner repair."),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected verifier direct rework to complete with the recent implementation owner");
  return calls;
}

async function runVerifierWrappedAssignmentKeepsPrimaryOwnerRegression(): Promise<CapturedCascadeCall[]> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  let verifierRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-verifier-primary-owner-regression",
    cliProvider: null,
    agentsMetadataJson: DESKTOP_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the completed work for this assignment: " +
          "Restore apps/web/src/application/sequencer/SequencerParser.ts NEXT_WORKFLOW compatibility.\n\n" +
          "PM final handoff summary:\n" +
          "Frontend should own the parser repair first, then reviewer and verifier should re-run their gates. " +
          "If visual polish is needed later the designer can check it, and devops can confirm rollout readiness after the code path is stable.\n\n" +
          "Prompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "verifier") verifierRuns += 1;
      if (role === "verifier" && verifierRuns === 1 && instruction.includes("Prompting_Sequencer_1")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "blocked",
            "[/VerificationStatus]",
            "[Verification]",
            "The parser repair still needs another focused implementation pass.",
            "[/Verification]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "developer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Developer received the primary-owner parser repair handoff.",
            "[FilesCreated]",
            "apps/web/src/application/sequencer/SequencerParser.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected wrapped verifier assignment rework to stay on the primary implementation owner");
  return calls;
}

async function runDirectHostFeedbackBlockedCascade(): Promise<CapturedExecutionCompletion[]> {
  const coordinator = new SequencerCoordinator();
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-host-feedback-blocked",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review host-feedback blocked propagation in the direct execution path\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "ABORT: the command output still does not prove the review is ready to pass.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Reviewer ran the targeted review.",
            "[/STEP_1_RESULT]",
            "[Command]",
            "1. npm run verify:sequencer",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => ({
      stdout: `completed ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    onAgentExecutionComplete: (event) => {
      completions.push({
        agentId: event.agentId,
        officeRole: event.officeRole,
        status: event.status,
        mode: event.mode,
        summary: event.summary,
      });
    },
  });

  assert(ok === false, "Expected direct host-feedback blocked cascade to fail closed");
  assert(
    completions.some(
      (completion) =>
        completion.agentId === "reviewer" &&
        completion.mode === "direct" &&
        completion.status === "needs_rework" &&
        completion.summary.includes("did not complete cleanly"),
    ),
    `Expected direct host-feedback blocked completion to surface as reviewer needs_rework, got ${JSON.stringify(completions)}`,
  );
  return completions;
}

async function runBundleHostFeedbackBlockedCascade(): Promise<CapturedExecutionCompletion[]> {
  const coordinator = new SequencerCoordinator();
  const completions: CapturedExecutionCompletion[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bundle-host-feedback-blocked",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "reviewer", command: "Review host-feedback blocked propagation in the bundle path" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "ABORT: the host check is still inconclusive, so the review cannot be marked ready.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer" && sequencerMatch?.[1] == null) {
        return {
          stdout:
            "[SEQUENCER_PLAN]\n1. Run the targeted reviewer check with host-command evidence\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Reviewer executed the bundle-scoped check.",
            "[/STEP_1_RESULT]",
            "[Command]",
            "1. npm run verify:sequencer",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => ({
      stdout: `completed ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    onAgentExecutionComplete: (event) => {
      completions.push({
        agentId: event.agentId,
        officeRole: event.officeRole,
        status: event.status,
        mode: event.mode,
        summary: event.summary,
      });
    },
  });

  assert(ok === false, "Expected bundle host-feedback blocked cascade to fail closed");
  assert(
    completions.some(
      (completion) =>
        completion.agentId === "reviewer" &&
        completion.mode === "bundle" &&
        completion.status === "needs_rework" &&
        completion.summary.includes("did not complete cleanly"),
    ),
    `Expected bundle host-feedback blocked completion to surface as reviewer needs_rework, got ${JSON.stringify(completions)}`,
  );
  return completions;
}

async function runDirectPmHostFeedbackFailurePropagationRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-direct-pm-host-feedback-failure",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "pm",
        command: "Audit host-feedback failure propagation in the direct path\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "ABORT: host verification could not confirm this PM-directed check.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM captured the implementation handoff notes.",
            "[/STEP_1_RESULT]",
            "[Command]",
            "1. npm run verify:sequencer",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => ({
      stdout: `completed ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  assert(ok === false, "PM direct path must fail closed when host feedback cannot confirm completion");
}

async function runBundlePmHostFeedbackFailurePropagationRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-bundle-pm-host-feedback-failure",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Audit host-feedback failure propagation in the bundle path" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "ABORT: host verification could not confirm the PM bundle step.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout:
            "[SEQUENCER_PLAN]\n1. Run the PM-owned verification handoff step with host-command evidence\n[/SEQUENCER_PLAN]",
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM executed the bundle-scoped handoff audit.",
            "[/STEP_1_RESULT]",
            "[Command]",
            "1. npm run verify:sequencer",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "[STEP_1_RESULT]\nUnexpected role\n[/STEP_1_RESULT]\n{END_TASK_1}",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => ({
      stdout: `completed ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  assert(ok === false, "PM bundle path must fail closed when host feedback cannot confirm completion");
}

async function runHostFeedbackStdoutIsolationRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const feedbackInputs: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["cargo test -p daacs_desktop cli::tests::rejects_unsafe_shell_workspace_commands"],
    workspace: "/tmp/daacs-host-feedback-stdout-isolation",
    cwdForCli: "/tmp/daacs-host-feedback-stdout-isolation",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,2)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "cargo test -p daacs_desktop cli::tests::rejects_unsafe_shell_workspace_commands") {
        return {
          stdout: "test cli::tests::rejects_unsafe_shell_workspace_commands ... ok",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      feedbackInputs.push(String(userMessage));
      return {
        stdout: "OK",
        stderr: [
          "internal trace line",
          "[Commands]",
          "1. first shell command",
          "2. second shell command",
          "[/Commands]",
        ].join("\n"),
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Host feedback runner should accept stdout-only OK responses");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify(["cargo test -p daacs_desktop cli::tests::rejects_unsafe_shell_workspace_commands"]),
    `Host feedback runner should ignore stderr placeholder commands, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.followupCommands.length === 0 &&
      result.runs[0]?.feedback === "OK",
    `Host feedback runner should record only the stdout control text, got ${JSON.stringify(result.runs[0] ?? null)}`,
  );
  assert(feedbackInputs.length === 1, `Expected exactly one feedback round, got ${feedbackInputs.length}`);
}

async function runHostFeedbackMixedSignalRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web run lint"],
    workspace: "/tmp/daacs-host-feedback-mixed-signal",
    cwdForCli: "/tmp/daacs-host-feedback-mixed-signal",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,3)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `workspace command failed: ${command}`,
        exit_code: 1,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "ABORT: lint still failing after host execution",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok === false, "Mixed OK/ABORT feedback must fail closed");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["npm --prefix apps/web run lint"]),
    `Mixed OK/ABORT regression should stop after the original command, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runVerifierHostFeedbackRejectsMutatingFollowupRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  let feedbackSystemPrompt = "";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["node -e 'process.exit(1)'"],
    workspace: "/tmp/daacs-host-feedback-quality-no-mutate",
    cwdForCli: "/tmp/daacs-host-feedback-quality-no-mutate",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,no-mutate)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "node -e 'process.exit(1)'") {
        return {
          stdout: "",
          stderr: "module load failed",
          exit_code: 1,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (_message, options) => {
      feedbackSystemPrompt = String(options.systemPrompt ?? "");
      return {
        stdout: [
          "[Commands]",
          "1. python -c \"from pathlib import Path; Path('src/app.js').write_text('bad')\"",
          "2. node --input-type=module -e \"console.log('retry')\"",
          "[/Commands]",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(!result.ok, "Verifier host feedback must reject mutating follow-up commands");
  assert(
    feedbackSystemPrompt.includes("REVIEWER/VERIFIER HOST FEEDBACK IS READ-ONLY") &&
      feedbackSystemPrompt.includes("never propose file writes"),
    `Verifier host feedback prompt should explicitly forbid mutating repair commands, got ${JSON.stringify(feedbackSystemPrompt)}`,
  );
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["node -e 'process.exit(1)'"]),
    `Verifier host feedback should not execute mutating follow-ups, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.followupCommands.some((command) => command.includes("write_text('bad')")),
    `Verifier host feedback regression should record the rejected mutating follow-up, got ${JSON.stringify(result.runs[0] ?? null)}`,
  );
}

async function runHostFeedbackFollowupHappyPathRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web run verify:sequencer"],
    workspace: "/tmp/daacs-host-feedback-followup-happy-path",
    cwdForCli: "/tmp/daacs-host-feedback-followup-happy-path",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,followup)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm --prefix apps/web run verify:sequencer") {
        return {
          stdout: "",
          stderr: "Missing script: verify:sequencer",
          exit_code: 1,
        };
      }
      if (command === "pnpm --dir apps/web test -- sequencer") {
        return {
          stdout: "sequencer suite passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "npm --prefix apps/web run verify:sequencer") {
        return {
          stdout: ["[Commands]", "1. pnpm --dir apps/web test -- sequencer", "[/Commands]"].join(
            "\n",
          ),
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === "pnpm --dir apps/web test -- sequencer") {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "ABORT: unexpected command",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Host follow-up commands should execute through to a successful OK state");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "npm --prefix apps/web run verify:sequencer",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Host follow-up happy path should execute the corrective command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 2 &&
      result.runs[0]?.followupCommands[0] === "pnpm --dir apps/web test -- sequencer" &&
      result.runs[1]?.feedback === "OK",
    `Host follow-up happy path should preserve the follow-up chain, got ${JSON.stringify(result.runs)}`,
  );
}

async function runHostFeedbackStdoutCommandsIgnoreCliWarningStderrRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build"],
    workspace: "/tmp/daacs-host-feedback-cli-warning-stderr",
    cwdForCli: "/tmp/daacs-host-feedback-cli-warning-stderr",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,cli-warning-stderr)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm run build" && workspaceCommands.length === 1) {
        return {
          stdout: "TS7016: Could not find a declaration file for module 'react'",
          stderr: "",
          exit_code: 1,
        };
      }
      if (command === "npm install -D @types/react @types/react-dom") {
        return {
          stdout: "added type packages",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "npm run build") {
        return {
          stdout: "vite build complete",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string; result?: { exit_code?: number } };
      if (payload.command === "npm run build" && payload.result?.exit_code !== 0) {
        return {
          stdout: [
            "[Commands]",
            "1. npm install -D @types/react @types/react-dom",
            "2. npm run build",
            "[/Commands]",
          ].join("\n"),
          stderr: "WARN plugin cache failed to warm; non-actionable CLI warning",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "WARN plugin cache failed to warm; non-actionable CLI warning",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Host feedback should execute stdout [Commands] despite unrelated CLI warning stderr");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "npm run build",
        "npm install -D @types/react @types/react-dom",
        "npm run build",
      ]),
    `CLI warning stderr should not block corrective follow-ups, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackZeroExitSmokeIgnoresBenignBuildCanceledStderrRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  let feedbackCalls = 0;

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run smoke"],
    workspace: "/tmp/daacs-host-feedback-zero-exit-smoke-benign-stderr",
    cwdForCli: "/tmp/daacs-host-feedback-zero-exit-smoke-benign-stderr",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,zero-exit-smoke-benign-stderr)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "smoke passed: board shell and recommendation safety rules are valid",
        stderr: "✘ [ERROR] The build was canceled\n",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => {
      feedbackCalls += 1;
      return {
        stdout: "ABORT: zero-exit smoke with explicit pass output should not need model feedback for known benign tool stderr",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Zero-exit smoke with explicit pass output should ignore known benign build-canceled stderr");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["npm run smoke"]),
    `Benign stderr regression should not add extra follow-ups, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(feedbackCalls === 0, `Benign zero-exit smoke should not call feedback model, got ${feedbackCalls}`);
}

async function runHostFeedbackQualityGateRunsAllVerificationCommandsRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  let feedbackCalls = 0;

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm install", "npm run build", "npm run smoke", "npm run smoke:dom"],
    workspace: "/tmp/daacs-host-feedback-quality-gate-batch",
    cwdForCli: "/tmp/daacs-host-feedback-quality-gate-batch",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,quality-gate-batch)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: `${command} ok`,
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => {
      feedbackCalls += 1;
      return {
        stdout: "ABORT: quality gate batch should not need per-command feedback for passing commands",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Verifier quality gate should pass only after running every requested verification command");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["npm install", "npm run build", "npm run smoke", "npm run smoke:dom"]),
    `Verifier quality gate should execute all requested commands, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(feedbackCalls === 0, `Passing verification batches should not depend on model feedback, got ${feedbackCalls}`);
  assert(
    result.runs.length === 4 &&
      result.runs.every((run) => run.exit_code === 0 && run.feedback === "OK: verification command exited 0"),
    `Verifier quality gate should keep one passing evidence record per command, got ${JSON.stringify(result.runs)}`,
  );
}

async function runHostFeedbackQualityGateRunsCdPrefixedVerificationCommandsRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  let feedbackCalls = 0;

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "cd /tmp/daacs-artifact && npm install",
      "cd /tmp/daacs-artifact && npm run build",
      "cd /tmp/daacs-artifact && npm run smoke",
    ],
    workspace: "/tmp/daacs-artifact",
    cwdForCli: "/tmp/daacs-artifact",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,quality-gate-cd-batch)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: `${command} ok`,
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => {
      feedbackCalls += 1;
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Verifier quality gate should execute every cd-prefixed setup/build/smoke command");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify([
      "cd /tmp/daacs-artifact && npm install",
      "cd /tmp/daacs-artifact && npm run build",
      "cd /tmp/daacs-artifact && npm run smoke",
    ]),
    `Verifier quality gate should not stop before smoke, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(feedbackCalls === 0, `cd-prefixed quality gate batches should not need feedback, got ${feedbackCalls}`);
}

async function runHostFeedbackDependencyInstallThenBuildRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build"],
    workspace: "/tmp/daacs-host-feedback-dependency-install-build",
    cwdForCli: "/tmp/daacs-host-feedback-dependency-install-build",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,dependency-install-build)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm run build" && workspaceCommands.length === 1) {
        return {
          stdout: "error TS7016: Could not find a declaration file for module 'react'. Try `npm i --save-dev @types/react`",
          stderr: "",
          exit_code: 1,
        };
      }
      if (command === "npm i -D @types/react @types/react-dom") {
        return {
          stdout: "added 2 packages",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "npm run build") {
        return {
          stdout: "vite build complete",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string; result?: { exit_code?: number } };
      if (payload.command === "npm run build" && payload.result?.exit_code !== 0) {
        return {
          stdout: [
            "[Commands]",
            "1. npm i -D @types/react @types/react-dom",
            "2. npm run build",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Frontend host feedback should allow dependency install follow-up before retrying build");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "npm run build",
        "npm i -D @types/react @types/react-dom",
        "npm run build",
      ]),
    `Dependency install/build follow-up chain should execute the setup and successful build, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackRuntimeAndTypeInstallThenBuildRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build"],
    workspace: "/tmp/daacs-host-feedback-runtime-type-install-build",
    cwdForCli: "/tmp/daacs-host-feedback-runtime-type-install-build",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,runtime-type-install-build)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm run build" && workspaceCommands.length === 1) {
        return {
          stdout:
            "error TS2875: This JSX tag requires the module path 'react/jsx-runtime' to exist. Make sure you have types for the appropriate package installed.",
          stderr: "",
          exit_code: 2,
        };
      }
      if (command === "npm install react react-dom") {
        return {
          stdout: "added runtime packages",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "npm install -D @types/react @types/react-dom") {
        return {
          stdout: "added type packages",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "npm run build") {
        return {
          stdout: "vite build complete",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string; result?: { exit_code?: number } };
      if (payload.command === "npm run build" && payload.result?.exit_code !== 0) {
        return {
          stdout: [
            "[Commands]",
            "1. npm install react react-dom",
            "2. npm install -D @types/react @types/react-dom",
            "3. npm run build",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Frontend host feedback should allow runtime/type dependency installs before retrying build");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "npm run build",
        "npm install react react-dom",
        "npm install -D @types/react @types/react-dom",
        "npm run build",
      ]),
    `Runtime/type install/build follow-up chain should execute fully, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackIgnoresCompactionMarkerCommandRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build", "[OutputCompacted]"],
    workspace: "/tmp/daacs-host-feedback-compaction-marker",
    cwdForCli: "/tmp/daacs-host-feedback-compaction-marker",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,compaction-marker)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "vite build complete",
        stderr: "",
        exit_code: command === "npm run build" ? 0 : 127,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Compaction marker commands should not make host feedback fail");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["npm run build"]),
    `Compaction marker should be ignored before workspace execution, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackRejectsMetaFollowupRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web run smoke:chromium"],
    workspace: "/tmp/daacs-host-feedback-meta-followup",
    cwdForCli: "/tmp/daacs-host-feedback-meta-followup",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,meta-followup)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm --prefix apps/web run smoke:chromium") {
        return {
          stdout: "2 passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: ["[Commands]", "1. echo smoke passed", "[/Commands]"].join("\n"),
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok === false, "Host feedback runner should reject meta follow-up commands");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["npm --prefix apps/web run smoke:chromium"]),
    `Meta follow-up should not execute, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackRejectsInitialMetaCommandRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const feedbackMessages: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["echo smoke passed"],
    workspace: "/tmp/daacs-host-feedback-initial-meta-command",
    cwdForCli: "/tmp/daacs-host-feedback-initial-meta-command",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,initial-meta-command)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    shouldSkipHostCommand: (command) => isInvalidSequencerCliCommand(command),
    runAgentCli: async (userMessage) => {
      feedbackMessages.push(String(userMessage));
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok === false, "Host feedback runner should reject invalid initial commands");
  assert(
    workspaceCommands.length === 0,
    `Invalid initial command should not execute in the workspace, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    feedbackMessages.length === 0,
    `Invalid initial command should not ask the feedback agent for approval, got ${JSON.stringify(feedbackMessages)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.command === "echo smoke passed" &&
      result.runs[0]?.exit_code === -1 &&
      result.runs[0]?.stderr.includes("Rejected invalid host command"),
    `Invalid initial command should be recorded as blocked evidence, got ${JSON.stringify(result.runs)}`,
  );
}

async function runHostFeedbackRejectsStandalonePreviewServerRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const feedbackMessages: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["python3 -m http.server 4173 -d frontend"],
    workspace: "/tmp/daacs-host-feedback-standalone-preview-server",
    cwdForCli: "/tmp/daacs-host-feedback-standalone-preview-server",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,standalone-preview-server)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    shouldSkipHostCommand: (command) => isInvalidSequencerCliCommand(command),
    runAgentCli: async (userMessage) => {
      feedbackMessages.push(String(userMessage));
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok === false, "Standalone foreground preview-server commands should be rejected before execution");
  assert(
    workspaceCommands.length === 0,
    `Standalone preview-server launch must not execute in the workspace, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    feedbackMessages.length === 0,
    `Rejected preview-server launch should not ask the feedback agent for approval, got ${JSON.stringify(feedbackMessages)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.command === "python3 -m http.server 4173 -d frontend" &&
      result.runs[0]?.exit_code === -1 &&
      result.runs[0]?.stderr.includes("Rejected invalid host command"),
    `Rejected preview-server launch should be preserved as blocked evidence, got ${JSON.stringify(result.runs)}`,
  );
}

async function runHostFeedbackSetupWrappedVerificationSupersedesOriginalRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const original =
    "cd apps/web && node --input-type=module -e \"import { chromium } from 'playwright'; await page.goto('http://127.0.0.1:3001/cross-pick-advisor');\"";
  const wrapped =
    "cd apps/web && (npm run dev -- --host 127.0.0.1 --port 3001 >/tmp/daacs-web-vite.log 2>&1 & server_pid=$!; trap 'kill $server_pid 2>/dev/null' EXIT; node --input-type=module -e \"import { chromium } from 'playwright'; await page.goto('http://127.0.0.1:3001/cross-pick-advisor');\")";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [original],
    workspace: "/tmp/daacs-host-feedback-setup-wrapped-browser-verification",
    cwdForCli: "/tmp/daacs-host-feedback-setup-wrapped-browser-verification",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,setup-wrapped-browser)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === original) {
        return {
          stdout: "",
          stderr: "page.goto: net::ERR_CONNECTION_REFUSED at http://127.0.0.1:3001/cross-pick-advisor",
          exit_code: 1,
        };
      }
      if (command === wrapped) {
        return {
          stdout: JSON.stringify({
            recommendations: ["Ahri", "Orianna", "Lissandra"],
            excludedSyndra: true,
            mismatchTextVisible: true,
          }),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === original) {
        return {
          stdout: ["[Commands]", `1. ${wrapped}`, "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === wrapped) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "ABORT: unexpected command",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    result.ok,
    "A setup-wrapped run of the same browser verification should supersede the failed no-server command",
  );
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify([original, wrapped]),
    `Setup-wrapped browser verification should not re-run the failed no-server command, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackNpmMissingBinarySetupWrapRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const original = "CI=true npm test src/engine/recommendation.test.ts";
  const wrapped = "npm install --no-audit --no-fund && CI=true npm test src/engine/recommendation.test.ts";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [original],
    workspace: "/tmp/daacs-host-feedback-npm-missing-binary",
    cwdForCli: "/tmp/daacs-host-feedback-npm-missing-binary",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,npm-missing-binary)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === original) {
        return {
          stdout: [
            "> movie-recommendation-app@0.1.0 test",
            "> react-scripts test src/engine/recommendation.test.ts",
          ].join("\n"),
          stderr: "sh: react-scripts: command not found",
          exit_code: 127,
        };
      }
      if (command === wrapped) {
        return {
          stdout: "recommendation tests passed after dependency setup",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === original) {
        return {
          stdout: ["[Commands]", "1. npm install", `2. ${original}`, "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === wrapped) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "ABORT: unexpected command",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Npm script missing local binary should be setup-wrapped and rechecked");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify([original, wrapped]),
    `Npm missing-binary setup wrapper should run once, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs[0]?.followupCommands[0] === wrapped,
    `Separate npm install plus test feedback should normalize to one setup-wrapped command, got ${JSON.stringify(result.runs[0]?.followupCommands ?? [])}`,
  );
}

async function runHostFeedbackNpmExit127WithoutStderrSetupWrapRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const original = "cd /tmp/daacs-live-artifact && npm run build";
  const wrapped = "cd /tmp/daacs-live-artifact && npm install --no-audit --no-fund && npm run build";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [original],
    workspace: "/tmp/daacs-live-artifact",
    cwdForCli: "/tmp/daacs-live-artifact",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,npm-127-no-stderr)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === original) {
        return {
          stdout: ["> build", "> tsc && vite build"].join("\n"),
          stderr: "",
          exit_code: 127,
        };
      }
      if (command === wrapped) {
        return {
          stdout: "vite build passed after install",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Npm build exit 127 with only package-script stdout should be setup-wrapped and rechecked");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify([original, wrapped]),
    `Exit-127 package build should run setup-wrapped retry once, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs[0]?.followupCommands[0] === wrapped,
    `Exit-127 package build follow-up should preserve cd prefix and install before rerun, got ${JSON.stringify(result.runs[0]?.followupCommands ?? [])}`,
  );
}

async function runHostFeedbackNpmMissingTscWithoutScriptHeaderRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const original = "cd /tmp/daacs-live-artifact && npm run build";
  const wrapped = "cd /tmp/daacs-live-artifact && npm install --no-audit --no-fund && npm run build";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [original],
    workspace: "/tmp/daacs-live-artifact",
    cwdForCli: "/tmp/daacs-live-artifact",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,npm-missing-tsc-no-header)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === original) {
        return {
          stdout: "",
          stderr: "sh: tsc: command not found",
          exit_code: 1,
        };
      }
      if (command === wrapped) {
        return {
          stdout: "vite build passed after dependency setup",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(
    result.ok,
    "Npm build missing tsc without package-script stdout should still setup-wrap and recheck",
  );
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify([original, wrapped]),
    `Missing tsc without stdout header should run setup-wrapped retry once, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackQualityReadThenPackageBuildRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  const readPackage = "cat package.json";
  const build = "npm run build";
  const wrappedBuild = "npm install --no-audit --no-fund && npm run build";

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [readPackage],
    workspace: "/tmp/daacs-host-feedback-read-then-build",
    cwdForCli: "/tmp/daacs-host-feedback-read-then-build",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,read-then-build)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === readPackage) {
        return {
          stdout: JSON.stringify({
            scripts: { build: "tsc && vite build" },
            devDependencies: { vite: "^5.1.4", typescript: "^5.2.2" },
          }),
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === build) {
        return {
          stdout: ["> movie-recommendation-app@0.1.0 build", "> tsc && vite build"].join("\n"),
          stderr: "sh: vite: command not found",
          exit_code: 127,
        };
      }
      if (command === wrappedBuild) {
        return {
          stdout: "vite build passed after dependency setup",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === readPackage) {
        return {
          stdout: ["[Commands]", `1. ${build}`, "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === build) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === wrappedBuild) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "ABORT: unexpected command",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    result.ok,
    `Verifier package.json inspection may lead to an existing package build check, got commands=${JSON.stringify(workspaceCommands)} runs=${JSON.stringify(result.runs)}`,
  );
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify([readPackage, build, wrappedBuild]),
    `Read-to-build flow should run build and setup-wrapped retry, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackPackageInstallSuccessIgnoresMalformedOkRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm install"],
    workspace: "/tmp/daacs-host-feedback-install-success-malformed-ok",
    cwdForCli: "/tmp/daacs-host-feedback-install-success-malformed-ok",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,install-success-malformed-ok)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "added 66 packages, and audited 67 packages in 4s",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "I will inspect the project next.",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Successful package setup should not fail only because feedback missed literal OK");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["npm install"]),
    `Successful package install should run once, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackRejectsMutatingRepairFollowupRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["cd apps/web && npm run build"],
    workspace: "/tmp/daacs-host-feedback-mutating-repair-followup",
    cwdForCli: "/tmp/daacs-host-feedback-mutating-repair-followup",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,mutating-repair-followup)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "cd apps/web && npm run build") {
        return {
          stdout: "src/App.tsx(693,10): error TS6133: 'MainApp' is declared but its value is never read.",
          stderr: "",
          exit_code: 2,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace mutation: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "cd apps/web && npm run build") {
        return {
          stdout: [
            "[Commands]",
            "1. perl -0pi -e 's/return <GeneratedApp \\/>/return <MainApp \\/>/' apps/web/src/App.tsx",
            "2. cd apps/web && npm run build",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok === false, "Host feedback must not execute source-mutating repair commands");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["cd apps/web && npm run build"]),
    `Mutating repair follow-up should be rejected before execution, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackUnrelatedVerificationCannotBypassFailedCommandRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web run build"],
    workspace: "/tmp/daacs-host-feedback-unrelated-verification-bypass",
    cwdForCli: "/tmp/daacs-host-feedback-unrelated-verification-bypass",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,unrelated-verification-bypass)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm --prefix apps/web run build") {
        return {
          stdout: "",
          stderr: "build failed",
          exit_code: 1,
        };
      }
      if (command === "pnpm --dir apps/web test:regression") {
        return {
          stdout: "regression tests passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "npm --prefix apps/web run build") {
        return {
          stdout: ["[Commands]", "1. pnpm --dir apps/web test:regression", "[/Commands]"].join(
            "\n",
          ),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    result.ok === false,
    "A failed build must not be accepted just because an unrelated verification command passed",
  );
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify(["npm --prefix apps/web run build", "pnpm --dir apps/web test:regression"]),
    `Unrelated verification bypass should stop after the failed original cannot be rechecked, got ${JSON.stringify(workspaceCommands)}`,
  );

  const unrelatedTestCommands: string[] = [];
  const unrelatedTestResult = await RunHostCommandsWithAgentFeedback({
    commands: ["pnpm --dir apps/web test -- SequencerCoordinator"],
    workspace: "/tmp/daacs-host-feedback-unrelated-test-bypass",
    cwdForCli: "/tmp/daacs-host-feedback-unrelated-test-bypass",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,unrelated-test-bypass)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      unrelatedTestCommands.push(command);
      if (command === "pnpm --dir apps/web test -- SequencerCoordinator") {
        return {
          stdout: "",
          stderr: "SequencerCoordinator failed",
          exit_code: 1,
        };
      }
      if (command === "pnpm --dir apps/web test -- unrelated") {
        return {
          stdout: "unrelated suite passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "pnpm --dir apps/web test -- SequencerCoordinator") {
        return {
          stdout: ["[Commands]", "1. pnpm --dir apps/web test -- unrelated", "[/Commands]"].join(
            "\n",
          ),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    unrelatedTestResult.ok === false,
    "A failed targeted test must not be accepted just because a different test command passed",
  );
  assert(
    JSON.stringify(unrelatedTestCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- SequencerCoordinator",
        "pnpm --dir apps/web test -- unrelated",
      ]),
    `Unrelated test bypass should stop after the failed targeted command cannot be rechecked, got ${JSON.stringify(unrelatedTestCommands)}`,
  );

  const cwdCorrectionCommands: string[] = [];
  const cwdCorrectionResult = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web exec tsx src/application/sequencer/HostCommandGuards.test.ts"],
    workspace: "/tmp/daacs-host-feedback-cwd-corrected-test",
    cwdForCli: "/tmp/daacs-host-feedback-cwd-corrected-test",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,cwd-corrected-test)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      cwdCorrectionCommands.push(command);
      if (command === "npm --prefix apps/web exec tsx src/application/sequencer/HostCommandGuards.test.ts") {
        return {
          stdout: "",
          stderr: "Cannot find module src/application/sequencer/HostCommandGuards.test.ts",
          exit_code: 1,
        };
      }
      if (command === "cd apps/web && npm exec tsx src/application/sequencer/HostCommandGuards.test.ts") {
        return {
          stdout: "HostCommandGuards command safety regression passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "npm --prefix apps/web exec tsx src/application/sequencer/HostCommandGuards.test.ts") {
        return {
          stdout: [
            "[Commands]",
            "1. cd apps/web && npm exec tsx src/application/sequencer/HostCommandGuards.test.ts",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    cwdCorrectionResult.ok,
    "A cwd-corrected run of the same tsx test file should supersede the failed host command",
  );
  assert(
    JSON.stringify(cwdCorrectionCommands) ===
      JSON.stringify([
        "npm --prefix apps/web exec tsx src/application/sequencer/HostCommandGuards.test.ts",
        "cd apps/web && npm exec tsx src/application/sequencer/HostCommandGuards.test.ts",
      ]),
    `Cwd-corrected test should run once and pass, got ${JSON.stringify(cwdCorrectionCommands)}`,
  );

  const cwdCorrectionBuildCommands: string[] = [];
  const cwdCorrectionBuildResult = await RunHostCommandsWithAgentFeedback({
    commands: ["npm run build"],
    workspace: "/tmp/daacs-host-feedback-cwd-corrected-build",
    cwdForCli: "/tmp/daacs-host-feedback-cwd-corrected-build",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,cwd-corrected-build)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      cwdCorrectionBuildCommands.push(command);
      if (command === "npm run build") {
        return {
          stdout: "",
          stderr: "npm error Missing script: \"build\"",
          exit_code: 1,
        };
      }
      if (command === "cd apps/web && npm run build") {
        return {
          stdout: "built web app",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "npm run build") {
        return {
          stdout: ["[Commands]", "1. cd apps/web && npm run build", "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    cwdCorrectionBuildResult.ok,
    "A cwd-corrected run of the same npm build command should supersede the failed host command",
  );
  assert(
    JSON.stringify(cwdCorrectionBuildCommands) ===
      JSON.stringify(["npm run build", "cd apps/web && npm run build"]),
    `Cwd-corrected build should not re-run the original root command, got ${JSON.stringify(cwdCorrectionBuildCommands)}`,
  );

  const pythonAliasCommands: string[] = [];
  const pythonAliasResult = await RunHostCommandsWithAgentFeedback({
    commands: ["python -m py_compile tools/check_collaboration_orchestrator.py"],
    workspace: "/tmp/daacs-host-feedback-python-alias",
    cwdForCli: "/tmp/daacs-host-feedback-python-alias",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,python-alias)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      pythonAliasCommands.push(command);
      if (command === "python -m py_compile tools/check_collaboration_orchestrator.py") {
        return {
          stdout: "",
          stderr: "zsh:1: command not found: python",
          exit_code: 127,
        };
      }
      if (command === "python3 -m py_compile tools/check_collaboration_orchestrator.py") {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "python -m py_compile tools/check_collaboration_orchestrator.py") {
        return {
          stdout: [
            "[Commands]",
            "1. python3 -m py_compile tools/check_collaboration_orchestrator.py",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    pythonAliasResult.ok,
    "A python3 retry of the same python -m verification should supersede the unavailable python command",
  );
  assert(
    JSON.stringify(pythonAliasCommands) ===
      JSON.stringify([
        "python -m py_compile tools/check_collaboration_orchestrator.py",
        "python3 -m py_compile tools/check_collaboration_orchestrator.py",
      ]),
    `Python alias verification should not re-run the unavailable python command, got ${JSON.stringify(pythonAliasCommands)}`,
  );

  const unittestFallbackCommands: string[] = [];
  const unittestFallbackResult = await RunHostCommandsWithAgentFeedback({
    commands: ["python3 -m pytest tests/test_champion_recommendations.py"],
    workspace: "/tmp/daacs-host-feedback-unittest-fallback",
    cwdForCli: "/tmp/daacs-host-feedback-unittest-fallback",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,unittest-fallback)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      unittestFallbackCommands.push(command);
      if (command === "python3 -m pytest tests/test_champion_recommendations.py") {
        return {
          stdout: "",
          stderr: "/opt/homebrew/bin/python3: No module named pytest",
          exit_code: 1,
        };
      }
      if (command === "python3 -m unittest tests/test_champion_recommendations.py") {
        return {
          stdout: "Ran 1 test in 0.001s\n\nOK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "python3 -m pytest tests/test_champion_recommendations.py") {
        return {
          stdout: [
            "[Commands]",
            "1. python3 -m unittest tests/test_champion_recommendations.py",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(
    unittestFallbackResult.ok,
    "A dependency-free unittest retry should supersede a pytest-module-missing verification failure",
  );
  assert(
    JSON.stringify(unittestFallbackCommands) ===
      JSON.stringify([
        "python3 -m pytest tests/test_champion_recommendations.py",
        "python3 -m unittest tests/test_champion_recommendations.py",
      ]),
    `Unittest fallback should not loop on the unavailable pytest command, got ${JSON.stringify(unittestFallbackCommands)}`,
  );
}

async function runHostFeedbackSuccessfulDuplicateRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["pnpm --dir apps/web test -- sequencer", "pnpm --dir apps/web test -- sequencer"],
    workspace: "/tmp/daacs-host-feedback-successful-duplicate",
    cwdForCli: "/tmp/daacs-host-feedback-successful-duplicate",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,duplicate-ok)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "A duplicate already-successful host command should not trigger rework");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["pnpm --dir apps/web test -- sequencer"]),
    `Successful duplicate host command should be reused, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackSuccessfulDuplicateIgnoresRunCapRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["pnpm --dir apps/web test -- sequencer", "pnpm --dir apps/web test -- sequencer"],
    workspace: "/tmp/daacs-host-feedback-successful-duplicate-run-cap",
    cwdForCli: "/tmp/daacs-host-feedback-successful-duplicate-run-cap",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,duplicate-ok-run-cap)",
    maxTotalWorkspaceRuns: 1,
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Successful duplicate reuse should happen before maxTotalWorkspaceRuns accounting");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["pnpm --dir apps/web test -- sequencer"]),
    `Successful duplicate run-cap regression should not re-run or fail the duplicate, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackDuplicateAfterMutationRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "node scripts/update-generated-artifact.js",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-duplicate-after-mutation",
    cwdForCli: "/tmp/daacs-host-feedback-duplicate-after-mutation",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,duplicate-after-mutation)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: command.includes("test") ? "sequencer suite passed" : "artifact updated",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Host feedback should allow a duplicate verification command after workspace mutation");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "node scripts/update-generated-artifact.js",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Duplicate verification after mutation must re-run, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackPackageManagerBuildMutationRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "pnpm --dir apps/web build",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-pnpm-build-mutation",
    cwdForCli: "/tmp/daacs-host-feedback-pnpm-build-mutation",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,pnpm-build-mutation)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: command.includes("build") ? "dist updated" : "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Package-manager build commands should advance workspace state");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "pnpm --dir apps/web build",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Package-manager build mutation should permit re-verification, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackReadOnlyPrefixWriteRedirectionRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "rg TODO > tmp/verification/todo-report.txt",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-readonly-prefix-redirection",
    cwdForCli: "/tmp/daacs-host-feedback-readonly-prefix-redirection",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,readonly-prefix-redirection)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: command.includes(">") ? "report written" : "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Read-only-prefixed commands that write files should still complete");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "rg TODO > tmp/verification/todo-report.txt",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Read-only-prefixed write redirection should advance workspace state and force recheck, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackSuccessfulCommandWithFollowupCachesOriginalRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-success-followup-cache",
    cwdForCli: "/tmp/daacs-host-feedback-success-followup-cache",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,success-followup-cache)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "pnpm --dir apps/web test -- sequencer") {
        return {
          stdout: "sequencer suite passed",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "pnpm --dir apps/web test -- HostCommandGuards") {
        return {
          stdout: "guard suite passed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "pnpm --dir apps/web test -- sequencer") {
        return {
          stdout: ["[Commands]", "1. pnpm --dir apps/web test -- HostCommandGuards", "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok, "Successful commands with successful follow-ups should cache the original command");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "pnpm --dir apps/web test -- HostCommandGuards",
      ]),
    `Successful command with follow-up should not trip duplicate guard later, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackReadOnlyControlNoopDoesNotMutateRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "rg TODO || true",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-readonly-control-noop",
    cwdForCli: "/tmp/daacs-host-feedback-readonly-control-noop",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,readonly-control-noop)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: command.includes("rg ") ? "" : "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Read-only control no-op commands should complete");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify(["pnpm --dir apps/web test -- sequencer", "rg TODO || true"]),
    `Read-only command with control no-op should not advance workspace state and re-run duplicate verification, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackMutatingVerificationFlagRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "pnpm --dir apps/web test -- --updateSnapshot",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-mutating-verification-flag",
    cwdForCli: "/tmp/daacs-host-feedback-mutating-verification-flag",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,mutating-verification-flag)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: command.includes("updateSnapshot") ? "snapshot updated" : "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Verification commands with snapshot update flags should still complete");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "pnpm --dir apps/web test -- --updateSnapshot",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Snapshot-updating verification should advance workspace generation and force recheck, got ${JSON.stringify(workspaceCommands)}`,
  );

  const lintWorkspaceCommands: string[] = [];
  const lintResult = await RunHostCommandsWithAgentFeedback({
    commands: ["pnpm lint", "pnpm lint --fix", "pnpm lint"],
    workspace: "/tmp/daacs-host-feedback-mutating-lint-flag",
    cwdForCli: "/tmp/daacs-host-feedback-mutating-lint-flag",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,mutating-lint-flag)",
    runWorkspaceCommand: async (command) => {
      lintWorkspaceCommands.push(command);
      return {
        stdout: command.includes("--fix") ? "lint fixes applied" : "lint passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(lintResult.ok, "Lint commands with --fix should still complete");
  assert(
    JSON.stringify(lintWorkspaceCommands) ===
      JSON.stringify(["pnpm lint", "pnpm lint --fix", "pnpm lint"]),
    `Fixing lint command should advance workspace generation and force lint recheck, got ${JSON.stringify(lintWorkspaceCommands)}`,
  );

  const compoundWorkspaceCommands: string[] = [];
  const compoundResult = await RunHostCommandsWithAgentFeedback({
    commands: [
      "pnpm --dir apps/web test -- sequencer",
      "git diff && pnpm --dir apps/web test -- --updateSnapshot",
      "pnpm --dir apps/web test -- sequencer",
    ],
    workspace: "/tmp/daacs-host-feedback-compound-mutating-verification",
    cwdForCli: "/tmp/daacs-host-feedback-compound-mutating-verification",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,compound-mutating-verification)",
    runWorkspaceCommand: async (command) => {
      compoundWorkspaceCommands.push(command);
      return {
        stdout: command.includes("updateSnapshot") ? "snapshot updated" : "sequencer suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(compoundResult.ok, "Compound verification commands with mutating segments should complete");
  assert(
    JSON.stringify(compoundWorkspaceCommands) ===
      JSON.stringify([
        "pnpm --dir apps/web test -- sequencer",
        "git diff && pnpm --dir apps/web test -- --updateSnapshot",
        "pnpm --dir apps/web test -- sequencer",
      ]),
    `Compound mutating verification should advance workspace generation and force recheck, got ${JSON.stringify(compoundWorkspaceCommands)}`,
  );
}

async function runHostFeedbackMutationFollowupRechecksOriginalRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["pnpm --dir apps/web test -- SequencerCoordinator SharedBoardPanel"],
    workspace: "/tmp/daacs-host-feedback-mutation-recheck",
    cwdForCli: "/tmp/daacs-host-feedback-mutation-recheck",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,mutation-recheck)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "pnpm --dir apps/web test -- SequencerCoordinator SharedBoardPanel") {
        const firstAttempt = workspaceCommands.filter((c) => c === command).length === 1;
        return firstAttempt
          ? {
              stdout: "",
              stderr: 'Command "vitest" not found',
              exit_code: 254,
            }
          : {
              stdout: "SequencerCoordinator and SharedBoardPanel passed",
              stderr: "",
              exit_code: 0,
            };
      }
      if (command === "pnpm --dir apps/web add -D vitest") {
        return {
          stdout: "devDependency vitest installed",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string; result?: { exit_code?: number } };
      if (
        payload.command === "pnpm --dir apps/web test -- SequencerCoordinator SharedBoardPanel" &&
        payload.result?.exit_code === 254
      ) {
        return {
          stdout: ["[Commands]", "1. pnpm --dir apps/web add -D vitest", "[/Commands]"].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (payload.command === "pnpm --dir apps/web add -D vitest") {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok === false, "Mutating dependency-install follow-up should be rejected for repair routing");
  assert(
    JSON.stringify(workspaceCommands) ===
      JSON.stringify(["pnpm --dir apps/web test -- SequencerCoordinator SharedBoardPanel"]),
    `Mutating dependency-install follow-up should be rejected before execution, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runReviewerVerifierSequencerPromptEnvelopeRegression(): Promise<void> {
  const pmPrompt = await readFile(
    new URL("../../../../desktop/Resources/prompts/agent_pm.json", import.meta.url),
    "utf8",
  );
  const reviewerPrompt = await readFile(
    new URL("../../../../desktop/Resources/prompts/agent_reviewer.json", import.meta.url),
    "utf8",
  );
  const verifierPrompt = await readFile(
    new URL("../../../../desktop/Resources/prompts/agent_verifier.json", import.meta.url),
    "utf8",
  );
  const frontendPrompt = await readFile(
    new URL("../../../../desktop/Resources/prompts/agent_frontend.json", import.meta.url),
    "utf8",
  );
  const developerPrompt = await readFile(
    new URL("../../../../desktop/Resources/prompts/agent_developer.json", import.meta.url),
    "utf8",
  );

  assert(
    pmPrompt.includes("fresh user-facing frontend artifacts") &&
      pmPrompt.includes("complex input-driven decision products") &&
      pmPrompt.includes("3 to 5 bounded FRONTEND_TASKS") &&
      pmPrompt.includes("foundation/data model") &&
      pmPrompt.includes("interaction/recommendation behavior") &&
      pmPrompt.includes("quality/preview hardening") &&
      pmPrompt.includes("package.json, tsconfig.json, vite.config, index.html, src/main, and src/App") &&
      pmPrompt.includes("@types/react") &&
      pmPrompt.includes("@types/react-dom") &&
      pmPrompt.includes("build/type tooling") &&
      pmPrompt.includes('type \\"module\\"') &&
      pmPrompt.includes("Vite <=6.4.1") &&
      pmPrompt.includes("npm audit warnings") &&
      pmPrompt.includes('moduleResolution \\"bundler\\"') &&
      pmPrompt.includes("Separate hard constraints from preferences") &&
      pmPrompt.includes("preference-mismatch examples") &&
      pmPrompt.includes("runnable smoke/test path") &&
      pmPrompt.includes("recommendation/decision engine and a live interactive screen with input/state wiring") &&
      pmPrompt.includes("workspace is effectively empty and the frontend app must be created from scratch") &&
      pmPrompt.includes("empty-workspace frontend build that includes both live filters/state and local persistence or result-card UX") &&
      pmPrompt.includes("every file the user explicitly names") &&
      pmPrompt.includes("if that smoke/test imports Playwright") &&
      pmPrompt.includes("make that the first verifier command") &&
      pmPrompt.includes("scaffold/data-engine, input-state/live-refresh wiring, then results/persistence/polish") &&
      pmPrompt.includes("6 or more live controls or filters") &&
      pmPrompt.includes("use up to 4 FRONTEND_TASKS") &&
      pmPrompt.includes("use up to 5 FRONTEND_TASKS") &&
      pmPrompt.includes("scoring/rule engine") &&
      pmPrompt.includes("favorites/localStorage persistence") &&
      pmPrompt.includes("Do not let one bounded frontend slice still mix core engine/rules, input-state wiring, and result presentation") &&
      pmPrompt.includes("Do not let one bounded frontend slice still mix recompute core with every control binding") &&
      pmPrompt.includes("If you use 4 or 5 slices") &&
      pmPrompt.includes("the final [AGENT_COMMANDS] must preserve that split") &&
      pmPrompt.includes("set later slices DependsOn to that same agent id") &&
      pmPrompt.includes("emit the same number of [AGENT_COMMANDS] entries to a real roster implementation agent") &&
      pmPrompt.includes("PM, frontend, backend, reviewer, and verifier are the shipped default agents") &&
      pmPrompt.includes("`DAACS_OS/services` is out of scope for new runtime work") &&
      pmPrompt.includes("Do not split for one specific domain only") &&
      pmPrompt.includes("do not add backend just because the user mentions DB/reference data/no-login") &&
      !pmPrompt.includes("For LoL") &&
      !pmPrompt.includes("champion recommendation"),
    "PM prompt should split complex input-driven frontend artifacts into bounded domain-neutral slices",
  );
  assert(
      reviewerPrompt.includes("keep the required [STEP_n_RESULT]...[/STEP_n_RESULT] envelope") &&
      reviewerPrompt.includes("[ReviewVerdict]") &&
      reviewerPrompt.includes("inside that envelope") &&
      reviewerPrompt.includes("unrelated dirty files") &&
      reviewerPrompt.includes("scope-isolation violation") &&
      reviewerPrompt.includes("user-visible requirement coverage") &&
      reviewerPrompt.includes("domain-neutral rule map") &&
      reviewerPrompt.includes("DesignSpec or ReferenceBoard") &&
      reviewerPrompt.includes("reference_archetype fit") &&
      reviewerPrompt.includes("reference_quality_bar evidence") &&
      reviewerPrompt.includes("reference pattern adaptation") &&
      reviewerPrompt.includes("Separate hard constraints from preferences") &&
      reviewerPrompt.includes("unavailable or already-used items") &&
      reviewerPrompt.includes("transient/generated sample artifacts") &&
      reviewerPrompt.includes("explicitly named file paths in the assignment") &&
      reviewerPrompt.includes("[ArtifactFileStatus]") &&
      !reviewerPrompt.includes("emit the verdict and findings only"),
    "Reviewer prompt should require review tags inside the sequencer step-result envelope",
  );
  assert(
    verifierPrompt.includes("keep the required [STEP_n_RESULT]...[/STEP_n_RESULT] envelope") &&
      verifierPrompt.includes("[VerificationStatus]") &&
      verifierPrompt.includes("inside that envelope") &&
      verifierPrompt.includes("user-perspective flow") &&
      verifierPrompt.includes("Build/lint alone is not enough") &&
      verifierPrompt.includes("File reads, code inspection, or checklist commentary alone are not sufficient") &&
      verifierPrompt.includes("first prove the runnable scaffold exists") &&
      verifierPrompt.includes("negative/adversarial path") &&
      verifierPrompt.includes("reference-informed UI claims") &&
      verifierPrompt.includes("reference pattern adaptation") &&
      verifierPrompt.includes("unavailable/already-used items stay excluded") &&
      verifierPrompt.includes("Treat preference words as soft ranking signals") &&
      verifierPrompt.includes("If the original request explicitly names a verifier command") &&
      verifierPrompt.includes("missing test runner such as @playwright/test") &&
      !verifierPrompt.includes("emit the status and verification evidence only"),
    "Verifier prompt should require verification tags inside the sequencer step-result envelope",
  );
  assert(
    frontendPrompt.includes("Keep trace output small") &&
      frontendPrompt.includes("node_modules, dist, build, coverage") &&
      frontendPrompt.includes("do not run git status just to prove fresh temp artifact files") &&
      frontendPrompt.includes("explicitly names file paths") &&
      frontendPrompt.includes("matching devDependency") &&
      frontendPrompt.includes("[FilesCreated]") &&
      developerPrompt.includes("Keep trace output small") &&
      developerPrompt.includes("node_modules, dist, build, coverage") &&
      developerPrompt.includes("do not run git status just to prove fresh temp artifact files") &&
      developerPrompt.includes("[FilesCreated]"),
    "Implementation prompts should prevent generated-artifact trace bloat from node_modules/dist listings and temp git status probes",
  );
}

async function runQualityGateRequirementChecklistRegression(): Promise<void> {
  const userPrompt = [
    "롤 픽창에서 챔피언 서로 고를때 추천해주는 웹사이트만들어줘",
    "상대팀 조합과 우리팀 조합을 감안해서 내가좋아하는최적의 챔피언을찾아주는 웹사이트",
    "고려해야할것.",
    "사거리",
    "Ap ad 밸런스",
    "하드 cc유무",
    "원딜, 누커, 탱커등의 유무",
    "포킹조합, 받아치는조합, 돌진조합등.",
  ].join("\n");
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the champion recommendation website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    userPrompt,
  );
  const reviewerCall = calls.find((call) => call.role === "reviewer");
  const verifierCall = calls.find((call) => call.role === "verifier");
  assert(reviewerCall != null, "Expected reviewer quality gate call");
  assert(verifierCall != null, "Expected verifier quality gate call");
  assert(
      reviewerCall.instruction.includes("Original user requirement checklist to preserve:") &&
      reviewerCall.instruction.includes("Domain-neutral quality invariants to prove:") &&
      reviewerCall.instruction.includes("사거리") &&
      reviewerCall.instruction.includes("Ap ad 밸런스") &&
      reviewerCall.instruction.includes("포킹조합") &&
      reviewerCall.instruction.includes("domain-neutral invariants") &&
      reviewerCall.instruction.includes("unavailable/already-used items") &&
      reviewerCall.instruction.includes("already-used, reserved, banned, excluded, or conflicting entities") &&
      !reviewerCall.instruction.includes("밴: 아리 + 요청: 아리 추천해줘") &&
      !reviewerCall.instruction.includes("For LoL champion recommendation flows") &&
      reviewerCall.instruction.includes("This is not domain-specific") &&
      reviewerCall.instruction.includes("transient/generated sample artifacts") &&
      reviewerCall.instruction.includes("[ReviewVerdict] must be needs_rework"),
    `Reviewer quality gate should receive original requirement coverage guidance, got ${reviewerCall.instruction}`,
  );
  assert(
    verifierCall.instruction.includes("Original user requirement checklist to preserve:") &&
      verifierCall.instruction.includes("Domain-neutral quality invariants to prove:") &&
      verifierCall.instruction.includes("하드 cc유무") &&
      verifierCall.instruction.includes("원딜, 누커, 탱커등의 유무") &&
      verifierCall.instruction.includes("user-flow, local preview, or smoke check") &&
      verifierCall.instruction.includes("negative/adversarial scenario") &&
      !verifierCall.instruction.includes("밴: 아리 + 요청: 아리 추천해줘") &&
      !verifierCall.instruction.includes("For LoL champion recommendation flows") &&
      verifierCall.instruction.includes("conditional explanations appear when false") &&
      verifierCall.instruction.includes("current user input") &&
      verifierCall.instruction.includes("[VerificationStatus] must be fail or blocked"),
    `Verifier quality gate should require user-flow evidence for artifact quality, got ${verifierCall.instruction}`,
  );

  const noisyReferenceCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the recommendation website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    [
      "맛집 추천 웹사이트를 만들어줘",
      "Riot Games",
      "Riot Games",
      "+1",
      "주요 단계 및 규칙",
      "이미 닫은 가게는 추천하면 안 돼",
    ].join("\n"),
  );
  const noisyReviewerCall = noisyReferenceCalls.find((call) => call.role === "reviewer");
  assert(noisyReviewerCall != null, "Expected reviewer quality gate call for copied-reference prompt");
  const noisyChecklistBlocks = [...noisyReviewerCall.instruction.matchAll(
    /Original user requirement checklist to preserve:\n([\s\S]*?)\n\nDomain-neutral quality invariants to prove:/g,
  )].map((match) => match[1] ?? "");
  assert(
    noisyChecklistBlocks.length > 0 &&
      noisyChecklistBlocks.every((block) =>
        block.includes("맛집 추천 웹사이트를 만들어줘") &&
        block.includes("이미 닫은 가게는 추천하면 안 돼") &&
        !block.includes("Riot Games") &&
        !block.includes("+1") &&
        !block.includes("주요 단계 및 규칙"),
      ),
    `Copied source/reference noise should not become preserved checklist requirements, got ${noisyReviewerCall.instruction}`,
  );

  const singleCompanyRequirementCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the game store comparison website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    [
      "게임 스토어 비교 웹사이트를 만들어줘",
      "Epic Games",
      "할인 중인 게임만 추천해줘",
    ].join("\n"),
  );
  const singleCompanyReviewerCall = singleCompanyRequirementCalls.find((call) => call.role === "reviewer");
  assert(singleCompanyReviewerCall != null, "Expected reviewer quality gate call for single company requirement");
  const singleCompanyChecklistBlocks = [...singleCompanyReviewerCall.instruction.matchAll(
    /Original user requirement checklist to preserve:\n([\s\S]*?)\n\nDomain-neutral quality invariants to prove:/g,
  )].map((match) => match[1] ?? "");
  assert(
    singleCompanyChecklistBlocks.length > 0 &&
      singleCompanyChecklistBlocks.every((block) =>
        block.includes("Epic Games") &&
        block.includes("할인 중인 게임만 추천해줘"),
      ),
    `Single non-duplicated company lines should remain available as requirements, got ${singleCompanyReviewerCall.instruction}`,
  );

  const bookingCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the reservation finder in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    "미용실 예약 웹사이트를 만들어줘. 이미 예약된 시간은 다시 추천하면 안 되고, 사용자가 원하는 디자이너와 시간대를 기준으로 빈 시간을 추천해야 해.",
  );
  const bookingVerifierCall = bookingCalls.find((call) => call.role === "verifier");
  assert(bookingVerifierCall != null, "Expected verifier quality gate call for non-LoL selection flow");
  assert(
    bookingVerifierCall.instruction.includes("Domain-neutral quality invariants to prove:") &&
      bookingVerifierCall.instruction.includes("already-used, reserved, banned, excluded, or conflicting entities") &&
      bookingVerifierCall.instruction.includes("negative/adversarial scenario") &&
      !bookingVerifierCall.instruction.toLowerCase().includes("lol"),
    `Selection-flow invariant guidance should be domain-neutral, got ${bookingVerifierCall.instruction}`,
  );

  const longSingleLinePrompt = [
    "식당 예약 추천 웹사이트를 만들어줘 사용자가 지역과 인원과 날짜와 분위기와 예산과 선호 음식과 이동 거리와 주차 가능 여부와 아이 동반 여부와 조용한 자리 여부를 한 번에 길게 적어도 읽어야 해.",
    "이미 예약된 시간은 다시 추천하면 안 돼.",
    "폐점한 가게는 추천하면 안 되고, 이유는 현재 입력과 맞을 때만 보여줘.",
  ].join(" ");
  const longPromptCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the restaurant reservation recommendation website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    longSingleLinePrompt,
  );
  const longPromptReviewerCall = longPromptCalls.find((call) => call.role === "reviewer");
  assert(longPromptReviewerCall != null, "Expected reviewer quality gate call for long single-line prompt");
  assert(
    longPromptReviewerCall.instruction.includes("이미 예약된 시간은 다시 추천하면 안 돼") &&
      longPromptReviewerCall.instruction.includes("폐점한 가게는 추천하면 안 되고") &&
      longPromptReviewerCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘"),
    `Long single-line prompts should preserve late checklist requirements, got ${longPromptReviewerCall.instruction}`,
  );

  const crowdedPrompt = [
    "여행 일정 추천 웹사이트를 만들어줘",
    "지역 입력을 받기",
    "인원 입력을 받기",
    "예산 입력을 받기",
    "날씨 입력을 받기",
    "교통수단 입력을 받기",
    "숙소 스타일 입력을 받기",
    "식사 취향 입력을 받기",
    "활동 강도 입력을 받기",
    "출발 시간 입력을 받기",
    "이미 문을 닫은 장소는 추천하면 안 돼",
    "현재 입력과 맞지 않는 이유는 보여주면 안 돼",
  ].join("\n");
  const crowdedPromptCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the travel itinerary recommendation website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    crowdedPrompt,
  );
  const crowdedPromptReviewerCall = crowdedPromptCalls.find((call) => call.role === "reviewer");
  assert(crowdedPromptReviewerCall != null, "Expected reviewer quality gate call for crowded prompt");
  assert(
    crowdedPromptReviewerCall.instruction.includes("여행 일정 추천 웹사이트를 만들어줘") &&
      crowdedPromptReviewerCall.instruction.includes("이미 문을 닫은 장소는 추천하면 안 돼") &&
      crowdedPromptReviewerCall.instruction.includes("현재 입력과 맞지 않는 이유는 보여주면 안 돼"),
    `Crowded prompts should preserve late high-signal requirements, got ${crowdedPromptReviewerCall.instruction}`,
  );

  const noPunctuationPrompt = [
    "쇼핑 추천 웹사이트를 만들어줘 사용자가 브랜드와 가격대와 색상과 사이즈와 배송 시간을 한 문장으로 길게 적을 수 있어야 해",
    "그리고 선호 브랜드를 우선 반영해야 해",
    "그리고 이미 품절된 상품은 추천하면 안 돼",
    "그리고 할인 조건은 현재 입력과 맞을 때만 보여줘",
  ].join(" ");
  const noPunctuationPromptCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Implement the shopping recommendation website in apps/web",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
    noPunctuationPrompt,
  );
  const noPunctuationPromptReviewerCall = noPunctuationPromptCalls.find((call) => call.role === "reviewer");
  assert(noPunctuationPromptReviewerCall != null, "Expected reviewer quality gate call for conjunction prompt");
  assert(
    noPunctuationPromptReviewerCall.instruction.includes("이미 품절된 상품은 추천하면 안 돼") &&
      noPunctuationPromptReviewerCall.instruction.includes("할인 조건은 현재 입력과 맞을 때만 보여줘"),
    `Long prompts without punctuation should split on conjunctions and preserve constraints, got ${noPunctuationPromptReviewerCall.instruction}`,
  );
}

async function runComplexCrossDomainPromptQualityGuidanceRegression(): Promise<void> {
  const scenarios = [
    {
      name: "travel itinerary",
      implementation: "Implement the travel itinerary recommendation website in apps/web",
      prompt: [
        "도시 여행 일정 추천 웹사이트를 만들어줘",
        "사용자가 방문지와 이동수단을 카드/검색으로 입력하고, 좋아하는 장소는 즐겨찾기 목록으로 저장하지만 로그인은 없어야 해.",
        "추천 10개와 이유를 보여주고 1일차부터 5일차까지 일정이 바뀔 때마다 추천이 새로 바뀌어야 해.",
        "고려해야 할 것: 이동거리, 예산, 날씨, 운영시간, 아이 동반, 휠체어 접근성, 음식 취향, 휴무/폐점 장소 제외.",
        "장소 DB는 알아서 할것.",
      ].join("\n"),
      required: ["도시 여행 일정 추천 웹사이트를 만들어줘", "휴무/폐점 장소 제외", "장소 DB는 알아서 할것"],
    },
    {
      name: "warehouse picking",
      implementation: "Implement the warehouse picking recommendation website in apps/web",
      prompt: [
        "창고 출고 작업자가 주문을 고를 때 피킹 순서를 추천해주는 웹사이트를 만들어줘",
        "주문과 SKU는 검색해서 선택하고, 자주 쓰는 구역은 즐겨찾기 목록으로 두되 로그인은 필요 없어.",
        "추천 10개, 이유 표시, 주문 1번부터 5번까지 추가될 때마다 경로와 우선순위가 새로 계산되어야 해.",
        "고려해야 할 것: 동선 거리, 무게, 냉장/상온, 파손 위험, 출고 마감, 재고 부족, 이미 잠긴 구역 제외.",
        "SKU/로케이션 DB는 알아서 할것.",
      ].join("\n"),
      required: ["피킹 순서를 추천해주는 웹사이트", "이미 잠긴 구역 제외", "SKU/로케이션 DB는 알아서 할것"],
    },
    {
      name: "renovation materials",
      implementation: "Implement the renovation material recommendation website in apps/web",
      prompt: [
        "셀프 인테리어 자재 조합 추천 웹사이트를 만들어줘",
        "사용자는 방 크기와 예산과 원하는 분위기를 입력하고, 좋아하는 자재는 즐겨찾기 목록에 넣을 수 있어야 해. 로그인은 없어야 해.",
        "추천 10개와 이유를 보여주고 바닥/벽/조명/가구/마감재가 하나씩 바뀔 때마다 다시 추천해야 해.",
        "고려해야 할 것: 습기, 방염, 내구성, 색상 조합, 시공 순서, 예산 초과, 품절/비호환 자재 제외.",
        "자재 DB는 알아서 할것.",
      ].join("\n"),
      required: ["셀프 인테리어 자재 조합 추천 웹사이트", "품절/비호환 자재 제외", "자재 DB는 알아서 할것"],
    },
    {
      name: "event staffing",
      implementation: "Implement the event staffing recommendation website in apps/web",
      prompt: [
        "행사 부스 운영 상황별 스태프 배치 추천 웹사이트를 만들어줘",
        "부스와 스태프는 검색해서 선택하고, 자주 쓰는 배치 템플릿은 즐겨찾기 목록으로 관리하되 로그인은 없어야 해.",
        "추천 10개와 이유를 보여주고 부스 1번부터 5번까지 배정이 추가될 때마다 추천이 새로고침되어야 해.",
        "고려해야 할 것: 혼잡도, 휴식 시간, 언어 가능 여부, 안전 역할, 이동 거리, 이미 배정된 사람/휴무자 제외.",
        "스태프 DB는 알아서 할것.",
      ].join("\n"),
      required: ["스태프 배치 추천 웹사이트", "이미 배정된 사람/휴무자 제외", "스태프 DB는 알아서 할것"],
    },
  ];

  for (const scenario of scenarios) {
    const calls = await runPmPlanCascade(
      ["[SEQUENCER_PLAN]", `1. frontend -> ${scenario.implementation}`, "[/SEQUENCER_PLAN]"].join("\n"),
      "",
      scenario.prompt,
    );
    const frontendCall = calls.find((call) => call.role === "frontend");
    const reviewerCall = calls.find((call) => call.role === "reviewer");
    const verifierCall = calls.find((call) => call.role === "verifier");
    assert(frontendCall != null, `Expected frontend call for ${scenario.name}`);
    assert(reviewerCall != null, `Expected reviewer call for ${scenario.name}`);
    assert(verifierCall != null, `Expected verifier call for ${scenario.name}`);

    for (const required of scenario.required) {
      assert(
        frontendCall.instruction.includes(required) &&
          reviewerCall.instruction.includes(required) &&
          verifierCall.instruction.includes(required),
        `Cross-domain ${scenario.name} handoffs should preserve '${required}', got ${JSON.stringify({
          frontend: frontendCall.instruction,
          reviewer: reviewerCall.instruction,
          verifier: verifierCall.instruction,
        })}`,
      );
    }

    assert(
      reviewerCall.instruction.includes("Domain-neutral quality invariants to prove:") &&
        reviewerCall.instruction.includes("already-used, reserved, banned, excluded, or conflicting entities") &&
        reviewerCall.instruction.includes("This is not domain-specific") &&
        verifierCall.instruction.includes("negative/adversarial scenario") &&
        verifierCall.instruction.includes("current user input") &&
        !reviewerCall.instruction.includes("For LoL champion recommendation flows") &&
        !verifierCall.instruction.includes("For LoL champion recommendation flows") &&
        !reviewerCall.instruction.toLowerCase().includes("champion") &&
        !verifierCall.instruction.toLowerCase().includes("champion"),
      `Cross-domain ${scenario.name} quality guidance should stay domain-neutral, got ${JSON.stringify({
        reviewer: reviewerCall.instruction,
        verifier: verifierCall.instruction,
      })}`,
    );
  }
}

async function runLargeStepOutputCompactsDownstreamMemoryRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const largeTraceLine = "raw-trace-line ".repeat(5000);

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-sequencer-large-output-compact",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "frontend", command: "Implement trace-preserving sequencer follow-up" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "frontend" && sequencerMatch?.[1] === "1") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "trace-preserved-marker",
            largeTraceLine,
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend" && sequencerMatch?.[1] === "2") {
        return {
          stdout:
            "[STEP_2_RESULT]\nFrontend consumed compact prior-step memory.\n[/STEP_2_RESULT]\n{END_TASK_2}",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout:
          "[SEQUENCER_PLAN]\n1. Preserve raw trace in the first step\n2. Consume compact handoff in the second step\n[/SEQUENCER_PLAN]",
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Expected large-output compact-memory cascade to complete");
  const secondStepCall = calls.find(
    (call) => call.role === "frontend" && call.instruction.includes("Prompting_Sequencer_2"),
  );
  assert(secondStepCall != null, "Expected frontend step 2 to receive prior-step context");
  assert(
    secondStepCall.instruction.includes("[OutputCompacted]") &&
      secondStepCall.instruction.includes("trace-preserved-marker") &&
      !secondStepCall.instruction.includes(largeTraceLine),
    "Large step output should be compacted for downstream memory while preserving tagged evidence",
  );
}

async function runHostFeedbackNoExplorationLoopRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["`SequencerCoordinator` 결합부에서 보장해야 할 점"],
    workspace: "/tmp/daacs-host-feedback-no-exploration",
    cwdForCli: "/tmp/daacs-host-feedback-no-exploration",
    cliProvider: null,
    officeAgentRole: "frontend",
    logLabelPrefix: "HostFeedbackRegression(frontend,4)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `zsh: command not found: ${command}`,
        exit_code: 127,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: ['[Commands]', '1. rg -n "SequencerCoordinator" .', "2. sed -n '1,260p' apps/web/src/application/sequencer/SequencerCoordinator.ts", '[/Commands]'].join("\n"),
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok === false, "Exploratory follow-up commands must not keep the feedback loop alive");
  assert(
    workspaceCommands.length === 0,
    `Invalid prose-like initial command should not execute before feedback, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.command === "`SequencerCoordinator` 결합부에서 보장해야 할 점" &&
      result.runs[0]?.exit_code === -1,
    `Invalid prose-like initial command should be recorded as blocked evidence, got ${JSON.stringify(result.runs)}`,
  );

  const chainedWorkspaceCommands: string[] = [];
  const chainedResult = await RunHostCommandsWithAgentFeedback({
    commands: ["node --import tsx src/application/sequencer/HostCommandGuards.test.ts"],
    workspace: "/tmp/daacs-host-feedback-no-chained-exploration",
    cwdForCli: "/tmp/daacs-host-feedback-no-chained-exploration",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,chained-exploration)",
    runWorkspaceCommand: async (command) => {
      chainedWorkspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `failed: ${command}`,
        exit_code: 1,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: [
        "[Commands]",
        "1. cd apps/web && sed -n '1,220p' src/application/sequencer/HostCommandGuards.ts",
        "[/Commands]",
      ].join("\n"),
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(chainedResult.ok === false, "Chained exploratory follow-up commands must fail closed");
  assert(
    JSON.stringify(chainedWorkspaceCommands) ===
      JSON.stringify(["node --import tsx src/application/sequencer/HostCommandGuards.test.ts"]),
    `Chained exploratory feedback should not execute cd+sed read commands, got ${JSON.stringify(chainedWorkspaceCommands)}`,
  );

  const smokeDiagnosticCommands: string[] = [];
  const smokeDiagnosticResult = await RunHostCommandsWithAgentFeedback({
    commands: ["cd apps/web && npm run smoke:chromium"],
    workspace: "/tmp/daacs-host-feedback-smoke-diagnostic",
    cwdForCli: "/tmp/daacs-host-feedback-smoke-diagnostic",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,smoke-diagnostic)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      smokeDiagnosticCommands.push(command);
      if (command === "cd apps/web && npm run smoke:chromium") {
        return {
          stdout: "1 failed; see test-results/byok/error-context.md",
          stderr: "",
          exit_code: 1,
        };
      }
      if (command === "cd apps/web && sed -n '1,220p' test-results/byok/error-context.md") {
        return {
          stdout: "locator timeout in unrelated BYOK path",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "cd apps/web && npm run smoke:chromium") {
        return {
          stdout: [
            "[Commands]",
            "1. cd apps/web && sed -n '1,220p' test-results/byok/error-context.md",
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(smokeDiagnosticResult.ok === false, "Smoke diagnostic reads should not turn a failed smoke run into a pass");
  assert(
    JSON.stringify(smokeDiagnosticCommands) ===
      JSON.stringify([
        "cd apps/web && npm run smoke:chromium",
        "cd apps/web && sed -n '1,220p' test-results/byok/error-context.md",
      ]),
    `Smoke diagnostic feedback should allow failure artifact reads without re-running forever, got ${JSON.stringify(smokeDiagnosticCommands)}`,
  );

  const pytestDiagnosticCommands: string[] = [];
  const pytestDiagnosticResult = await RunHostCommandsWithAgentFeedback({
    commands: ["pytest tests/test_collaboration.py"],
    workspace: "/tmp/daacs-host-feedback-pytest-diagnostic",
    cwdForCli: "/tmp/daacs-host-feedback-pytest-diagnostic",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,pytest-diagnostic)",
    maxRoundsPerCommand: 2,
    runWorkspaceCommand: async (command) => {
      pytestDiagnosticCommands.push(command);
      if (command === "pytest tests/test_collaboration.py") {
        return {
          stdout: "1 failed: assertion text mismatch",
          stderr: "",
          exit_code: 1,
        };
      }
      if (command === 'rg -n "assertion text mismatch" tests') {
        return {
          stdout: "tests/test_collaboration.py:42:assertion text mismatch",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async (userMessage) => {
      const payload = JSON.parse(String(userMessage)) as { command?: string };
      if (payload.command === "pytest tests/test_collaboration.py") {
        return {
          stdout: [
            "[Commands]",
            '1. rg -n "assertion text mismatch" tests',
            "[/Commands]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(pytestDiagnosticResult.ok === false, "Pytest diagnostic reads should not turn a failed pytest run into a pass");
  assert(
    JSON.stringify(pytestDiagnosticCommands) ===
      JSON.stringify([
        "pytest tests/test_collaboration.py",
        'rg -n "assertion text mismatch" tests',
      ]),
    `Pytest diagnostic feedback should allow narrow read commands, got ${JSON.stringify(pytestDiagnosticCommands)}`,
  );
}

async function runHostFeedbackContextInsensitiveAbortRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["chmod +x backend/scripts/run-local-auth.sh"],
    workspace: "/tmp/daacs-host-feedback-context-abort",
    cwdForCli: "/tmp/daacs-host-feedback-context-abort",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,context-abort)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: "",
        exit_code: 0,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout:
        "ABORT: chmod succeeded, but I do not have enough context about the original task to determine whether any follow-up shell command is needed.",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok, "Context-insufficient ABORT on a successful host fix-up command should not fail closed");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["chmod +x backend/scripts/run-local-auth.sh"]),
    `Context-insufficient ABORT regression should preserve the successful command execution, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.command === "chmod +x backend/scripts/run-local-auth.sh" &&
      result.runs[0]?.exit_code === 0,
    `Context-insufficient ABORT regression should record the successful command, got ${JSON.stringify(result.runs)}`,
  );
}

async function runHostFeedbackMalformedFollowupRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm --prefix apps/web run verify:sequencer"],
    workspace: "/tmp/daacs-host-feedback-malformed-followup",
    cwdForCli: "/tmp/daacs-host-feedback-malformed-followup",
    cliProvider: null,
    officeAgentRole: "verifier",
    logLabelPrefix: "HostFeedbackRegression(verifier,malformed-followup)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `workspace command failed: ${command}`,
        exit_code: 1,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: ["[Commands]", "1. printf '%s", "[/Commands]"].join("\n"),
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(result.ok === false, "Malformed shell follow-up commands must fail closed");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["npm --prefix apps/web run verify:sequencer"]),
    `Malformed follow-up regression should not execute broken follow-up shell, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runHostFeedbackFailedVerificationCannotReplyOkRegression(): Promise<void> {
  const workspaceCommands: string[] = [];

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["node --test"],
    workspace: "/tmp/daacs-host-feedback-failed-verification-ok",
    cwdForCli: "/tmp/daacs-host-feedback-failed-verification-ok",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,failed-verification-ok)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "✖ 1 failing test",
        stderr: "",
        exit_code: 1,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => ({
      stdout: "OK",
      stderr: "",
      exit_code: 0,
    }),
    onCliLog: () => {},
  });

  assert(
    HOST_COMMAND_FEEDBACK_SYSTEM_PROMPT.includes("FAILED VERIFICATION COMMANDS ARE NOT OK"),
    "Host feedback prompt must explicitly forbid OK on failed verification-style commands",
  );
  assert(result.ok === false, "A failed verification command must not be accepted when feedback replies with plain OK");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["node --test"]),
    `Failed verification OK regression should execute only the original test command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    result.runs.length === 1 &&
      result.runs[0]?.command === "node --test" &&
      result.runs[0]?.exit_code === 1 &&
      result.runs[0]?.feedback === "OK",
    `Failed verification OK regression should preserve the misleading raw feedback while still failing closed, got ${JSON.stringify(result.runs)}`,
  );
}

async function runImplementationReadOnlyHostInspectionIgnoredRegression(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "daacs-readonly-host-ignore-"));
  const workspaceCommands: string[] = [];
  const logs: Array<CapturedCliLog & { exit_code: number }> = [];

  try {
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, "src", "index.ts"), "export const ready = true;\n", "utf8");
    await writeFile(
      join(workspace, "src", "meetingRoomRecommendationEngine.ts"),
      "export function recommend() { return []; }\n",
      "utf8",
    );

    const coordinator = new SequencerCoordinator();
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [{ agentId: "frontend", command: "Implement a bounded frontend slice.\n\nPrompting_Sequencer_1" }],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 1,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (_instruction, options) => {
        const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
        if (role !== "frontend") {
          return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Implemented the bounded slice and created the initial files.",
            "[FilesCreated]",
            "src/index.ts",
            "src/meetingRoomRecommendationEngine.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "[Command]",
            '1. find . -maxdepth 3 \\( -name "*.ts" -o -name "*.json" \\) | sort | head -20',
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
      onCliLog: (entry) => {
        logs.push({
          ...entry,
          stdout: String(entry.stdout ?? ""),
          stderr: String(entry.stderr ?? ""),
          label: String(entry.label ?? ""),
          officeAgentRole: String(entry.officeAgentRole ?? ""),
          exit_code: Number(entry.exit_code ?? -1),
        });
      },
      runHostWorkspaceCommand: async (command) => {
        workspaceCommands.push(command);
        if (command.includes("for p in")) {
          return {
            stdout: "",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "./src/index.ts\n./src/meetingRoomRecommendationEngine.ts\n",
          stderr: "",
          exit_code: 0,
        };
      },
    });

    assert(ok, "Read-only inspection-only host commands from implementation should be ignored instead of triggering repair");
    assert(
      !workspaceCommands.some((command) => command.includes("find . -maxdepth 3")),
      `Ignored read-only host inspection regression should not execute the exploratory command, got ${JSON.stringify(workspaceCommands)}`,
    );
    const frontendLog = logs.find((entry) => entry.label === "AgentCommand(frontend)");
    assert(frontendLog != null, "Expected frontend direct-command log entry");
    assert(
      !frontendLog?.stdout.includes("[HostFeedbackStatus]") &&
        !frontendLog?.stdout.includes("[Command]"),
      `Ignored read-only host inspection regression should drop exploratory host-command scaffolding from the final output, got ${JSON.stringify(frontendLog?.stdout ?? "")}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runPromptingSequencerRuleReadOnlyInspectionAlignmentRegression(): Promise<void> {
  const rule = await readFile(
    "/Users/david/Desktop/python/github/omnify/OmniAICore/src/Prompting_Sequencer_Rule.md",
    "utf8",
  );
  assert(
    rule.includes("Read-only CLI inspection is allowed when the current step prompt explicitly allows it"),
    "Prompting Sequencer rule must explicitly allow read-only inspection when the step prompt says so",
  );
  assert(
    !rule.includes("- Do NOT execute shell/CLI commands directly."),
    "Prompting Sequencer rule must not blanket-ban all shell/CLI commands because that conflicts with read-only inspection guidance",
  );
}

async function runHostFeedbackSessionIsolationRegression(): Promise<void> {
  const directSessionKeys: Array<string | null> = [];
  const feedbackSessionKeyPresence: boolean[] = [];
  const feedbackSessionKeys: unknown[] = [];
  const workspace = await mkdtemp(join(tmpdir(), "daacs-host-feedback-session-isolation-"));

  try {
    const coordinator = new SequencerCoordinator();
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "verifier",
          command:
            "Verify host-feedback session isolation for post-command checks\n\nPrompting_Sequencer_1",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 1,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (_instruction, options) => {
        const prompt = String(options?.systemPrompt ?? "");
        const sessionKeyValue = (options as { sessionKey?: unknown } | undefined)?.sessionKey;
        if (prompt.includes("The host has executed a shell command in the workspace.")) {
          feedbackSessionKeyPresence.push(
            Object.prototype.hasOwnProperty.call(options ?? {}, "sessionKey"),
          );
          feedbackSessionKeys.push(sessionKeyValue);
          return {
            stdout: "OK",
            stderr: "",
            exit_code: 0,
          };
        }
        directSessionKeys.push(typeof sessionKeyValue === "string" ? sessionKeyValue : null);
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[Verification]",
            "Verifier executed the required checks.",
            "[/Verification]",
            "[Command]",
            "1. npm run verify:sequencer",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: () => {},
      runHostWorkspaceCommand: async (command) => {
        if (command === "npm run verify:sequencer") {
          return {
            stdout: "sequencer verification passed",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "",
          stderr: `unexpected host command: ${command}`,
          exit_code: 2,
        };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    assert(ok, "Expected host-feedback session-isolation cascade to complete");
    assert(
      directSessionKeys.some((value) => typeof value === "string" && value.length > 0),
      `Primary verifier execution should still use a stable session key, got ${JSON.stringify(directSessionKeys)}`,
    );
    const primarySessionKey = directSessionKeys.find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    assert(
      feedbackSessionKeyPresence.length === 1 &&
        feedbackSessionKeyPresence[0] === true &&
        typeof feedbackSessionKeys[0] === "string" &&
        feedbackSessionKeys[0] !== primarySessionKey &&
        String(feedbackSessionKeys[0]).startsWith(`${String(primarySessionKey)}:host-feedback`),
      `Host feedback calls must use a distinct derived session key, got presence=${JSON.stringify(feedbackSessionKeyPresence)} values=${JSON.stringify(feedbackSessionKeys)} primary=${JSON.stringify(primarySessionKey)}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runVerifierHostFeedbackPassClearsStaleRisksRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const workspaceCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-host-feedback-pass-clears-stale-risks",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify repaired sequencer work and request host checks\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[Verification]",
          "- Host checks are needed before final approval.",
          "[/Verification]",
          "[OpenRisks]",
          "- I did not execute build/test commands directly in this sequencer step.",
          "[/OpenRisks]",
          "[Command]",
          "1. npm --prefix apps/web run test:regression",
          "[/Command]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "web regression suite passed",
        stderr: "",
        exit_code: 0,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const verifierLog = logs.find((log) => log.label === "AgentCommand(verifier)");
  assert(ok, "Verifier host-feedback pass should complete without repair routing");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["npm --prefix apps/web run test:regression"]),
    `Expected exactly one host verification command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(verifierLog != null, "Expected final verifier cli log");
  assert(
    verifierLog.stdout.includes("[VerificationStatus]\npass\n[/VerificationStatus]") &&
      verifierLog.stdout.includes("[HostFeedbackStatus]\npass\n[/HostFeedbackStatus]"),
    `Final verifier log should include pass statuses, got ${verifierLog.stdout}`,
  );
  assert(
    !verifierLog.stdout.includes("[OpenRisks]") && !verifierLog.stdout.includes("[Command]"),
    `Final verifier log should clear stale OpenRisks/Command blocks after host pass, got ${verifierLog.stdout}`,
  );
}

async function runImplementationHostFeedbackAllSuccessClearsBlockedEvidenceRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const workspaceCommands: string[] = [];
  const workspace = "/tmp/daacs-implementation-host-feedback-success-clears-blocked";
  const coordinator = new SequencerCoordinator();

  try {
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "ui_builder",
          command: "Repair generated web app dependency setup\n\nPrompting_Sequencer_1",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 2,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (_instruction, options) => {
        const prompt = String(options?.systemPrompt ?? "");
        if (prompt.includes("The host has executed a shell command in the workspace.")) {
          return {
            stdout: "OK",
            stderr: "OpenAI Codex transcript should not turn OK feedback into blocked status.",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "blocked",
            "[/HostFeedbackStatus]",
            "[Verification]",
            "Host feedback status: blocked",
            "Host command evidence:",
            "1. npm run build | exit_code=2 | stdout=old missing React type evidence",
            "[/Verification]",
            "[FilesCreated]",
            "package.json",
            "[/FilesCreated]",
            "- Added runtime and type dependencies required by the generated Vite/React app.",
            "[Command]",
            "1. npm install",
            "2. npm run build",
            "3. npm run smoke",
            "[/Command]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logs.push({
          label: String(entry.label ?? ""),
          stdout: String(entry.stdout ?? ""),
          stderr: String(entry.stderr ?? ""),
        });
      },
      runHostWorkspaceCommand: async (command) => {
        workspaceCommands.push(command);
        if (command === "npm install") {
          return {
            stdout: "added 67 packages, and audited 67 packages in 4s\nfound 0 vulnerabilities",
            stderr: "",
            exit_code: 0,
          };
        }
        if (command === "npm run build") {
          return {
            stdout: "vite build complete",
            stderr: "The CJS build of Vite's Node API is deprecated.",
            exit_code: 0,
          };
        }
        if (command === "npm run smoke") {
          return {
            stdout: "rendered DOM user-flow smoke complete",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "",
          stderr: `unexpected host command: ${command}`,
          exit_code: 2,
        };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    const implementationLog = logs.find((log) => log.label === "AgentCommand(ui_builder)");
    const meaningfulWorkspaceCommands = filterTimeoutMarkerHostCommands(workspaceCommands).filter(
      (command) => !command.startsWith("for p in "),
    );
    assert(ok, "Successful implementation host feedback must not re-open the same repair loop");
    assert(
      JSON.stringify(meaningfulWorkspaceCommands) === JSON.stringify(["npm install", "npm run build", "npm run smoke"]),
      `Expected dependency setup, build, and smoke commands, got ${JSON.stringify(workspaceCommands)}`,
    );
    assert(implementationLog != null, "Expected implementation command log");
    assert(
      implementationLog.stdout.includes("[HostFeedbackStatus]\npass\n[/HostFeedbackStatus]") &&
        !implementationLog.stdout.includes("[HostFeedbackStatus]\nblocked\n[/HostFeedbackStatus]") &&
        !implementationLog.stdout.includes("old missing React type evidence"),
      `Successful host evidence should replace stale blocked evidence, got ${implementationLog.stdout}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runHostFeedbackPackageInstallAuditWarningBlocksRegression(): Promise<void> {
  const workspaceCommands: string[] = [];
  let feedbackCalls = 0;

  const result = await RunHostCommandsWithAgentFeedback({
    commands: ["npm install"],
    workspace: "/tmp/daacs-host-feedback-package-audit-warning",
    cwdForCli: "/tmp/daacs-host-feedback-package-audit-warning",
    cliProvider: null,
    officeAgentRole: "developer",
    logLabelPrefix: "HostFeedbackRegression(developer,package-audit-warning)",
    runWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm install") {
        return {
          stdout:
            "added 67 packages, and audited 68 packages in 4s\n2 moderate severity vulnerabilities\nRun `npm audit` for details.",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command === "npm audit --audit-level=moderate") {
        return {
          stdout: [
            "# npm audit report",
            "",
            "esbuild  <=0.24.2",
            "Severity: moderate",
            "esbuild enables any website to send any requests to the development server and read the response",
            "  vite  <=6.4.1",
            "  Depends on vulnerable versions of esbuild",
            "",
            "2 moderate severity vulnerabilities",
          ].join("\n"),
          stderr: "",
          exit_code: 1,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected workspace command: ${command}`,
        exit_code: 2,
      };
    },
    extractCommandsFromAgentText: async (text) => parseHostCommandBlocks(text),
    runAgentCli: async () => {
      feedbackCalls += 1;
      return {
        stdout: "OK",
        stderr: "",
        exit_code: 0,
      };
    },
    onCliLog: () => {},
  });

  assert(result.ok === false, "Package install audit warnings should block instead of passing as successful setup");
  assert(
    JSON.stringify(workspaceCommands) === JSON.stringify(["npm install", "npm audit --audit-level=moderate"]),
    `Package audit warning should trigger a narrow audit command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(feedbackCalls === 0, `Deterministic package audit handling should not ask model feedback, got ${feedbackCalls}`);
  assert(
    result.runs[0]?.followupCommands[0] === "npm audit --audit-level=moderate" &&
      result.runs[1]?.feedback.includes("package audit repair required"),
    `Package audit warning should preserve actionable audit evidence, got ${JSON.stringify(result.runs)}`,
  );
}

async function runImplementationHostFeedbackMissingRequestedCommandBlocksRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const workspaceCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-implementation-host-feedback-missing-requested-command",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "ui_builder",
        command: "Verify generated artifact with build and smoke host commands\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 1,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return { stdout: "OK", stderr: "", exit_code: 0 };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "Need host verification before handoff.",
          "[Command]",
          "1. npm install",
          "2. npm run build",
          "3. npm run smoke",
          "[/Command]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return { stdout: `${command} ok`, stderr: "", exit_code: 0 };
    },
    shouldSkipHostCommand: (command) => command === "npm run smoke",
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const implementationLog = logs.find((log) => log.label === "AgentCommand(ui_builder)");
  const meaningfulWorkspaceCommands = filterTimeoutMarkerHostCommands(workspaceCommands).filter(
    (command) => !command.startsWith("for p in "),
  );
  assert(!ok, "Missing requested host command evidence must not be promoted to a completed pass");
  assert(
    JSON.stringify(meaningfulWorkspaceCommands) === JSON.stringify(["npm install", "npm run build"]),
    `Skipped smoke should be absent from executed commands, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    implementationLog?.stdout.includes("[HostFeedbackStatus]\nblocked\n[/HostFeedbackStatus]") === true &&
      implementationLog.stdout.includes("Missing requested host command evidence: npm run smoke"),
    `Missing requested smoke command should be visible in blocked evidence, got ${implementationLog?.stdout ?? ""}`,
  );
}

async function runVerifierFreshHostPassClearsStaleOpenRisksRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const workspaceCommands: string[] = [];
  const workspace = "/tmp/daacs-verifier-fresh-host-pass-clears-stale-risks";
  const coordinator = new SequencerCoordinator();

  try {
    const ok = await coordinator.RunAgentCommandCascade({
      projectName: "local",
      workspace,
      cliProvider: null,
      agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
      seed: [
        {
          agentId: "verifier",
          command:
            "Verify the bounded repair slice for this assignment: meeting room recommendation web app with rendered DOM user-flow smoke evidence.\n\nPrompting_Sequencer_1",
        },
      ],
      setAgentTaskByRole: () => {},
      setPhase: () => {},
      maxCascade: 2,
      parseSequencerPlanSteps: parsePlanSteps,
      runCliCommand: async (instruction, options) => {
        const role = String(options?.promptRole ?? options?.modelRole ?? "");
        calls.push({ role, instruction });
        const prompt = String(options?.systemPrompt ?? "");
        if (prompt.includes("The host has executed a shell command in the workspace.")) {
          return { stdout: "OK", stderr: "", exit_code: 0 };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[Command]",
            "1. npm run smoke",
            "[/Command]",
            "[VerificationStatus]blocked[/VerificationStatus]",
            "[Verification]",
            "- Existing latest host evidence is not enough to approve: newest npm run smoke record exited 1 at .favorite.",
            "- Need fresh rendered DOM/user-flow evidence for live recompute and localStorage favorite persistence.",
            "- Smoke script exists, but host has not returned `npm run smoke` evidence yet.",
            "[/Verification]",
            "[OpenRisks]",
            "- Need fresh host result for npm run smoke; without it, the fixed build/smoke/runtime path is not proven.",
            "- If the fresh smoke still fails at .favorite, localStorage favorite persistence remains unverified.",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      },
      buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
      mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
      onCliLog: (entry) => {
        logs.push({
          label: String(entry.label ?? ""),
          stdout: String(entry.stdout ?? ""),
          stderr: String(entry.stderr ?? ""),
        });
      },
      runHostWorkspaceCommand: async (command) => {
        workspaceCommands.push(command);
        if (command === "npm run smoke") {
          return {
            stdout:
              "smoke passed: rendered DOM user flow, live recompute, top-10 results, exclusion reasons, conflict blocking, and localStorage favorites",
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: "",
          stderr: `unexpected host command: ${command}`,
          exit_code: 2,
        };
      },
      extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
    });

    const verifierLog = logs.find((log) => log.label === "AgentCommand(verifier)");
    const meaningfulWorkspaceCommands = filterTimeoutMarkerHostCommands(workspaceCommands).filter(
      (command) => !command.startsWith("for p in "),
    );
    assert(
      ok,
      `Fresh passing verifier host evidence should close stale evidence-gap risks, calls=${JSON.stringify(calls.map((call) => call.role))}, logs=${JSON.stringify(logs.map((log) => ({ label: log.label, stdout: log.stdout.slice(0, 600) })))}`,
    );
    assert(
      JSON.stringify(meaningfulWorkspaceCommands) === JSON.stringify(["npm run smoke"]),
      `Expected one fresh smoke command, got ${JSON.stringify(workspaceCommands)}`,
    );
    assert(verifierLog != null, "Expected verifier command log");
    const agentCommandLabels = logs
      .map((log) => log.label)
      .filter((label) => label.startsWith("AgentCommand("));
    assert(
      JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
      `Fresh host pass should not create another repair/review loop, got ${JSON.stringify(agentCommandLabels)}`,
    );
    assert(
      verifierLog.stdout.includes("[VerificationStatus]\npass\n[/VerificationStatus]") &&
        verifierLog.stdout.includes("[HostFeedbackStatus]\npass\n[/HostFeedbackStatus]") &&
        !verifierLog.stdout.includes("[VerificationStatus]blocked[/VerificationStatus]") &&
        !verifierLog.stdout.includes("[OpenRisks]") &&
        !verifierLog.stdout.includes("newest npm run smoke record exited 1") &&
        !verifierLog.stdout.includes("host has not returned"),
      `Fresh host pass should replace stale verifier blocked/open-risk evidence, got ${verifierLog.stdout}`,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function runBoundedVerifierHostPassDoesNotDemandFinalSmokeRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const workspaceCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-bounded-verifier-build-pass-no-final-smoke",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify the bounded repair slice for this assignment: warehouse picking recommendation web app.",
          "The full assignment later includes localStorage favorites, rendered DOM user-flow smoke, and final top-10 recommendation cards.",
          "This bounded repair only fixed React JSX type dependencies after `npm run build` failed.",
          "\nPrompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.promptRole ?? options?.modelRole ?? "");
      calls.push({ role, instruction });
      const prompt = String(options?.systemPrompt ?? "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return { stdout: "OK", stderr: "", exit_code: 0 };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[Command]",
          "npm run build",
          "[/Command]",
          "[VerificationStatus]blocked[/VerificationStatus]",
          "[Verification]",
          "- Need fresh host evidence that the bounded dependency repair closes the TypeScript build failure.",
          "[/Verification]",
          "[OpenRisks]",
          "- `npm run build` has not been rerun after adding React JSX types.",
          "[/OpenRisks]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "vite build complete",
        stderr: "",
        exit_code: 0,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const verifierLog = logs.find((log) => log.label === "AgentCommand(verifier)");
  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  const meaningfulWorkspaceCommands = filterTimeoutMarkerHostCommands(workspaceCommands).filter(
    (command) => !command.startsWith("for p in "),
  );
  assert(
    ok,
    `Bounded repair verification should close after fresh build pass, calls=${JSON.stringify(calls.map((call) => call.role))}, logs=${JSON.stringify(logs.map((log) => ({ label: log.label, stdout: log.stdout.slice(0, 600) })))}`,
  );
  assert(
    JSON.stringify(meaningfulWorkspaceCommands) === JSON.stringify(["npm run build"]),
    `Expected only the bounded build check, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
    `Bounded build repair must not reopen implementation for final smoke coverage, got ${JSON.stringify(agentCommandLabels)}`,
  );
  assert(
    verifierLog?.stdout.includes("[VerificationStatus]\npass\n[/VerificationStatus]") === true &&
      verifierLog.stdout.includes("[HostFeedbackStatus]\npass\n[/HostFeedbackStatus]") &&
      !verifierLog.stdout.includes("[OpenRisks]"),
    `Fresh host pass should replace stale risks without demanding final smoke, got ${verifierLog?.stdout ?? ""}`,
  );
}

async function runBoundedVerifierClosedTargetDoesNotReopenFutureWorkRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-bounded-verifier-closed-target-future-work",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify the bounded repair slice for this assignment: warehouse picking recommendation web app.",
          "Bounded repair slice under verification:",
          "1. Fix the prior JSX/react type failure after the scaffold build failed.",
          "Quality gate failures outside this bounded slice are intentionally deferred until a later review/verifier pass.",
          "\nPrompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.promptRole ?? options?.modelRole ?? "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]fail[/VerificationStatus]",
          "[Verification]",
          "- Host ran `npm run build`, exit_code `0`; the prior JSX/react type failure is gone.",
          "- Files checked: `package.json` now includes `@types/react` and `@types/react-dom`.",
          "- Full user-flow/smoke/localStorage coverage is still not proven, but that belongs to a later final quality gate.",
          "[/Verification]",
          "[OpenRisks]",
          "- Future full-app smoke still needs to prove 1-5 order recompute and localStorage favorites.",
          "[/OpenRisks]",
          "[/STEP_1_RESULT]",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => ({
      stdout: `completed ${command}`,
      stderr: "",
      exit_code: 0,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  assert(
    ok,
    `Closed bounded repair target should not reopen implementation for future work, calls=${JSON.stringify(calls.map((call) => call.role))}, logs=${JSON.stringify(logs.map((log) => ({ label: log.label, stdout: log.stdout.slice(0, 500) })))}`,
  );
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
    `Closed bounded target should stop after verifier, got ${JSON.stringify(agentCommandLabels)}`,
  );
}

async function runReviewerReadyAcceptableFindingsDoNotReopenRepairRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-reviewer-ready-acceptable-findings",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command:
          "Review the bounded slice: confirm inventory recommendation exclusions and favorite ranking behavior.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.promptRole ?? options?.modelRole ?? "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[ReviewVerdict]ready[/ReviewVerdict]",
          "[ReviewFindings]",
          "- Acceptable: `src/recommendationEngine.ts` excludes unavailable candidates before scoring, so 재고 부족/잠긴 구역/장비 불일치는 추천 카드로 못 올라옵니다.",
          "- Acceptable: favorite zones only add `favoriteBoost` and a conditional reason when true, so 좋아함을 필터처럼 막지 않고 순서 점수로만 씁니다.",
          "- 없음: checked files are warehouse-picking domain only; no champion hardcoding found.",
          "[/ReviewFindings]",
          "[OpenRisks]",
          "[/OpenRisks]",
          "[/STEP_1_RESULT]",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => ({
      stdout: "",
      stderr: `unexpected host command: ${command}`,
      exit_code: 2,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  assert(ok, `Reviewer ready with acceptable/no-issue findings should close, calls=${JSON.stringify(calls.map((call) => call.role))}`);
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(reviewer)"]),
    `Positive review findings must not route repair, got ${JSON.stringify(agentCommandLabels)}`,
  );
}

async function runVerifierPassWithExplicitNoOpenRisksRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-explicit-no-open-risks",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the bounded repair slice for this assignment: meeting room recommendation web app with rendered DOM user-flow smoke evidence.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.promptRole ?? options?.modelRole ?? "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]pass[/VerificationStatus]",
          "[Verification]",
          "- Host evidence: npm run smoke exit_code=0; smoke passed rendered DOM shell, real input recompute, conflict blocking, truthful reasons, and localStorage favorite persistence.",
          "[/Verification]",
          "[OpenRisks]",
          "- 없음",
          "[/OpenRisks]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => ({
      stdout: "",
      stderr: `unexpected host command: ${command}`,
      exit_code: 2,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  assert(ok, "Verifier pass with explicit Korean no-risk text should complete");
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
    `Explicit no-risk OpenRisks text must not open a repair loop, got ${JSON.stringify(agentCommandLabels)}`,
  );
  assert(
    calls.length === 1,
    `Expected one verifier CLI call only, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runVerifierShortSmokeHostPassPreservesCoverageRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const workspaceCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-short-smoke-host-pass",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the bounded repair slice for this assignment: generated meeting room recommendation web app with smoke and DOM smoke.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return { stdout: "OK", stderr: "", exit_code: 0 };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[Command]",
          "npm run smoke",
          "[/Command]",
          "[VerificationStatus]blocked[/VerificationStatus]",
          "[Verification]",
          "- package.json has smoke: npm run build && node scripts/smoke.mjs && node scripts/dom-smoke.mjs.",
          "- Existing smoke scripts cover happy path top-10, booked-room exclusion, live recompute, search/filter, localStorage favorites, and adversarial invalid-time path.",
          "- I did not run npm run smoke myself because host execution evidence is required.",
          "[/Verification]",
          "[OpenRisks]",
          "- Host must run npm run smoke before final approval.",
          "[/OpenRisks]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm run smoke") {
        return {
          stdout:
            "smoke ok\ndom smoke ok",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected host command: ${command}`,
        exit_code: 2,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  const verifierLog = logs.find((log) => log.label === "AgentCommand(verifier)");
  assert(ok, "Short smoke host pass should complete when pre-host verifier coverage proves the smoke scope");
  assert(
    JSON.stringify(filterTimeoutMarkerHostCommands(workspaceCommands)) === JSON.stringify(["npm run smoke"]),
    `Expected only npm run smoke host command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
    `Short smoke host pass must not open repair loop, got ${JSON.stringify(agentCommandLabels)}`,
  );
  assert(
    verifierLog?.stdout.includes("localStorage favorites") === true &&
      verifierLog.stdout.includes("smoke ok") &&
      !verifierLog.stdout.includes("I did not run"),
    `Passing host evidence should keep useful smoke coverage and drop stale caveats, got ${verifierLog?.stdout ?? ""}`,
  );
}

async function runVerifierUserFlowSmokePassClosesInventoryDecisionEvidenceRegression(): Promise<void> {
  const logs: CapturedCliLog[] = [];
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-inventory-user-flow-pass",
    cliProvider: null,
    agentsMetadataJson: USER_CREATED_BUILDER_AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify the bounded repair slice for this assignment: inventory picking recommendation web app with rendered DOM user-flow smoke, localStorage favorite, and negative/adversarial decision-flow evidence.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.promptRole ?? options?.modelRole ?? "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]",
          "pass",
          "[/VerificationStatus]",
          "",
          "[HostFeedbackStatus]",
          "pass",
          "[/HostFeedbackStatus]",
          "",
          "[Verification]",
          "- 확인한 검증 장치: `package.json`에 `smoke:user-flow`가 있고 `npm run build && node scripts/user-flow-smoke.mjs`를 실행하도록 연결됨.",
          "- 확인한 사용자 흐름 증거 범위: React 서버 렌더링으로 첫 화면 DOM, 검색/선택 컨트롤, 추천/제외 패널, localStorage 즐겨찾기 반영을 검사함.",
          "- 확인한 happy path: `SKU-1001` + `A1` + `conveyor` + 즐겨찾기 `A1`에서 추천이 생성되고 즐겨찾기 이유가 현재 입력일 때만 표시되는지 검사함.",
          "- 확인한 negative/adversarial path: 잠긴 `D4`, 품절 `SKU-1005`, `preferred favorite` 같은 말이 있어도 추천에 끼지 않고 제외 사유에 locked/stock이 나오는지 검사함.",
          "Host feedback status: pass",
          "Host command evidence:",
          "1. npm run smoke:user-flow | exit_code=0 | stdout=> live-e2e-inventory@0.1.0 smoke:user-flow",
          "> npm run build && node scripts/user-flow-smoke.mjs",
          "user-flow smoke ok: rendered DOM, localStorage favorite, adversarial exclusions, soft preference",
          "Artifact: tmp/verification/smoke-verification/verifier-verifier-20260425143137820.json",
          "[/Verification]",
          "",
          "[FilesCreated]",
          "tmp/verification/smoke-verification/verifier-verifier-20260425143137820.json",
          "[/FilesCreated]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
    runHostWorkspaceCommand: async (command) => ({
      stdout: "",
      stderr: `unexpected host command: ${command}`,
      exit_code: 2,
    }),
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const agentCommandLabels = logs
    .map((log) => log.label)
    .filter((label) => label.startsWith("AgentCommand("));
  assert(
    ok,
    `Inventory user-flow smoke verifier pass should close instead of repeating the same repair, calls=${JSON.stringify(calls.map((call) => call.role))}, logs=${JSON.stringify(logs.map((log) => ({ label: log.label, stdout: log.stdout.slice(0, 600) })))}`,
  );
  assert(
    JSON.stringify(agentCommandLabels) === JSON.stringify(["AgentCommand(verifier)"]),
    `Inventory user-flow pass must not open another repair loop, got ${JSON.stringify(agentCommandLabels)}`,
  );
  assert(
    calls.length === 1,
    `Expected one verifier call only after concrete rendered DOM/localStorage/adversarial evidence, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runReviewerTopNDataShortageRoutesImplementationRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-reviewer-topn-data-shortage",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "reviewer",
        command: "Review a generated top-10 meeting-room recommendation web app\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]needs_rework[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Static room data has only 3 rooms, so the app cannot show 10 recommendations as requested.",
              "[/ReviewFindings]",
              "[OpenRisks]",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: taggedReviewerStepOutput(1, "Reviewer confirmed the top-10 data shortage was repaired."),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "- Expanded the static candidate dataset so top-10 recommendation cards can be rendered.",
            "[FilesCreated]",
            "src/data/rooms.ts",
            "[/FilesCreated]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: taggedVerifierStepOutput(1, "Verifier confirmed the repaired top-10 candidate set can support ten visible recommendations."),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const roles = calls.map((call) => call.role);
  assert(ok, "Top-N data shortage repair cascade should complete");
  assert(
    roles.includes("frontend"),
    `Reviewer top-N data shortage should route to implementation, got ${JSON.stringify(roles)}`,
  );
  assert(
    roles.indexOf("frontend") > roles.indexOf("reviewer"),
    `Implementation repair should run after the reviewer finding, got ${JSON.stringify(roles)}`,
  );
}

async function runVerifierPassIgnoresEmbeddedReviewerBlocksRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: CapturedCliLog[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-pass-ignores-embedded-reviewer-blocks",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: "Verify repaired sequencer routing state for host-feedback merge regression\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]",
          "pass",
          "[/VerificationStatus]",
          "[HostFeedbackStatus]",
          "pass",
          "[/HostFeedbackStatus]",
          "[Verification]",
          "- Existing host-backed verification for the repaired sequencer route passed cleanly.",
          "Host feedback status: pass",
          "Host command evidence:",
          "1. npm run verify:sequencer | exit_code=0",
          "[/Verification]",
          "[ReviewVerdict]",
          "needs_rework",
          "[/ReviewVerdict]",
          "[ReviewFindings]",
          "- Embedded reviewer-style notes should not override verifier pass parsing.",
          "[/ReviewFindings]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
      });
    },
  });

  assert(ok, "Verifier pass should ignore embedded reviewer-only blocks");
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["verifier"]),
    `Embedded reviewer tags inside verifier output must not trigger repair routing, got ${JSON.stringify(calls)}`,
  );
  const verifierLog = logs.find((log) => log.label === "AgentCommand(verifier)");
  assert(verifierLog != null, "Expected verifier cli log for embedded-reviewer-block regression");
  assert(
    verifierLog?.stdout.includes("[VerificationStatus]") &&
      verifierLog?.stdout.includes("[HostFeedbackStatus]") &&
      verifierLog?.stdout.includes("[ReviewVerdict]"),
    `Regression payload should retain the mixed verifier/reviewer blocks, got ${JSON.stringify(verifierLog?.stdout ?? "")}`,
  );
}

async function runImplementationPromptForbidsSourceWritingHostCommandsRegression(): Promise<void> {
  const calls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Build a receipt classifier CLI tool from natural-language input",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const backendRepairCall = calls
    .filter((call) => call.role === "backend")
    .find((call) => call.instruction.includes("Bounded repair slice for this cycle"));
  assert(backendRepairCall != null, "Expected backend bounded-repair instruction capture");
  assert(
    backendRepairCall?.instruction.includes("Do not use [Command] to write or overwrite source files") &&
      backendRepairCall?.instruction.includes("run large inline Python/Node/heredoc scripts that author files"),
    `Implementation repair instructions should forbid source-authoring host commands, got ${JSON.stringify(backendRepairCall?.instruction ?? "")}`,
  );
}

async function runImplementationSenderFollowupSuppressionRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-implementation-sender-followup-suppression",
    cliProvider: null,
    agentsMetadataJson: JSON.stringify({
      schema_version: 1,
      agents: [
        { id: "developer", prompt_key: "agent_developer", office_role: "developer" },
        { id: "frontend", prompt_key: "agent_frontend", office_role: "frontend" },
      ],
    }),
    seed: [
      {
        agentId: "frontend",
        senderId: "developer",
        command:
          "Create the user-facing static web artifact requested by the developer handoff\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "src/styles.css",
            "[/FilesCreated]",
            "Implemented the assigned frontend artifact.",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected implementation sender follow-up role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Implementation child completion should not require a second implementation sender run");
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["frontend"]),
    `Implementation-to-implementation TaskComplete follow-up should be suppressed, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runQualityGateImplementationSenderFollowupSuppressionRegression(
  qualityRole: "reviewer" | "verifier",
): Promise<CapturedCascadeCall[]> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: `/tmp/daacs-${qualityRole}-sender-followup-suppression`,
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: qualityRole,
        senderId: "frontend",
        command:
          qualityRole === "reviewer"
            ? "Review the generated web artifact after frontend delivery\n\nPrompting_Sequencer_1"
            : "Verify the generated web artifact with a user-facing smoke check\n이미 예약된 슬롯은 추천되면 안 됩니다.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- User-facing artifact files are present and the reserved-slot exclusion rule is implemented.",
            "[/ReviewFindings]",
            "[OpenRisks][/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]pass[/VerificationStatus]",
            "[Verification]User-flow smoke check passed in the browser preview, and the reserved-slot negative case stayed excluded from the recommendation list.[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected quality-gate sender follow-up role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, `${qualityRole} completion should not bounce back to the implementation sender`);
  return calls;
}

async function runPartialArtifactTimeoutQualityHandoffRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const logs: Array<CapturedCliLog & { exit_code: number }> = [];
  const messages: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-partial-artifact-timeout-handoff",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          [
            "Create a web artifact for a reservation recommendation advisor.",
            "",
            "지역과 날짜와 인원을 입력받아야 해.",
            "이미 예약된 시간은 추천하면 안 돼.",
            "이유는 현재 입력과 맞을 때만 보여줘.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: "",
          stderr: [
            "Codex CLI timed out after 300 seconds.",
            "[DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
            "status=files_changed_before_timeout",
            "Files changed before timeout:",
            "- index.html",
            "- src/app.js",
            "[/DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
          ].join("\n"),
          exit_code: 1,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Candidate artifact has a coherent entry point and source file list.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Local preview smoke check rendered the candidate artifact and the reserved-time negative case stayed excluded.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
        exit_code: Number(entry.exit_code ?? -1),
      });
    },
    onAgentMessage: (msg) => {
      messages.push(msg.text);
    },
  });

  const roles = calls.map((call) => call.role);
  const frontendLog = logs.find((entry) => entry.label === "AgentCommand(frontend)");
  assert(ok, "Partial artifact timeout should continue into quality handoff instead of failing closed");
  assert(
    JSON.stringify(roles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Partial artifact timeout should route reviewer then verifier, got ${JSON.stringify(roles)}`,
  );
  const reviewerCall = calls.find((call) => call.role === "reviewer");
  const verifierCall = calls.find((call) => call.role === "verifier");
  assert(
    reviewerCall?.instruction.includes("Original user requirement checklist to preserve:") &&
      reviewerCall.instruction.includes("지역과 날짜와 인원을 입력받아야 해") &&
      reviewerCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼") &&
      reviewerCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘"),
    `Partial artifact reviewer handoff should preserve full requirements, got ${JSON.stringify(reviewerCall?.instruction ?? "")}`,
  );
  assert(
    verifierCall?.instruction.includes("Domain-neutral quality invariants to prove:") &&
      verifierCall.instruction.includes("negative/adversarial scenario") &&
      verifierCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼"),
    `Partial artifact verifier handoff should preserve full requirements, got ${JSON.stringify(verifierCall?.instruction ?? "")}`,
  );
  assert(
    messages.some((message) => message.includes("부분 산출물 생성됨")) &&
      messages.every((message) => !message.includes("작업 실패")),
    `Partial artifact timeout should not show a hard failure bubble, got ${JSON.stringify(messages)}`,
  );
  assert(frontendLog != null, "Expected frontend partial timeout log");
  assert(
    frontendLog.exit_code === 0 &&
      frontendLog.stdout.includes("[PartialArtifactTimeout]") &&
      frontendLog.stdout.includes("[FilesCreated]") &&
      frontendLog.stdout.includes("index.html") &&
      frontendLog.stderr === "",
    `Frontend partial timeout log should become candidate artifact evidence, got ${JSON.stringify(frontendLog)}`,
  );
}

async function runWorkspaceMarkerPartialArtifactTimeoutRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const logs: Array<CapturedCliLog & { exit_code: number }> = [];
  const messages: string[] = [];
  const hostCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-partial-artifact-timeout-marker-handoff",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          [
            "Create a web artifact for a logistics recommendation advisor.",
            "",
            "작업자 자격과 잠긴 구역과 재고 부족을 함께 고려해야 해.",
            "주문 변화가 생기면 추천과 제외 사유가 즉시 바뀌어야 해.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: "",
          stderr: "Codex CLI timed out after 300 seconds.",
          exit_code: 1,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Candidate logistics artifact has coherent entry files and visible exclusion evidence.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Candidate artifact rendered and the locked-zone negative case stayed excluded while recommendation reasons updated after input changes.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
        exit_code: Number(entry.exit_code ?? -1),
      });
    },
    onAgentMessage: (msg) => {
      messages.push(msg.text);
    },
    runHostWorkspaceCommand: async (command) => {
      hostCommands.push(command);
      if (command.includes(": > '.daacs_timeout_marker_")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.includes("find .") && command.includes(".daacs_timeout_marker_")) {
        return {
          stdout: "./index.html\n./src/app.js\n./src/styles.css\n",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.startsWith("rm -f '.daacs_timeout_marker_")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.startsWith("for p in ")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected host command: ${command}`,
        exit_code: 2,
      };
    },
  });

  const roles = calls.map((call) => call.role);
  const frontendLog = logs.find((entry) => entry.label === "AgentCommand(frontend)");
  assert(ok, "Workspace marker timeout should continue into quality handoff");
  assert(
    JSON.stringify(roles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Workspace marker timeout should route reviewer then verifier, got ${JSON.stringify(roles)}`,
  );
  assert(
    messages.some((message) => message.includes("부분 산출물 생성됨")) &&
      messages.every((message) => !message.includes("작업 실패")),
    `Workspace marker timeout should not show a hard failure bubble, got ${JSON.stringify(messages)}`,
  );
  assert(frontendLog != null, "Expected frontend partial timeout log from workspace marker");
  assert(
    frontendLog.exit_code === 0 &&
      frontendLog.stdout.includes("[PartialArtifactTimeout]") &&
      frontendLog.stdout.includes("[FilesCreated]") &&
      frontendLog.stdout.includes("index.html") &&
      frontendLog.stdout.includes("src/app.js"),
    `Workspace marker timeout should promote changed files into partial artifact evidence, got ${JSON.stringify(frontendLog)}`,
  );
  assert(
    hostCommands.some((command) => command.includes(": > '.daacs_timeout_marker_")) &&
      hostCommands.some((command) => command.includes("find .") && command.includes(".daacs_timeout_marker_")),
    `Workspace marker timeout regression should create and inspect a timeout marker, got ${JSON.stringify(hostCommands)}`,
  );
}

async function runWorkspaceMarkerPartialArtifactTimeoutScopeFilterRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const logs: Array<CapturedCliLog & { exit_code: number }> = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-partial-artifact-timeout-marker-scope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          [
            "Build a no-login warehouse slot recommendation web artifact.",
            "",
            "창고 구역, 점유 상태, 상품 조건이 바뀌면 적치 추천과 제외 이유가 바로 다시 계산되어야 해.",
            "warehouse slot search and occupancy changes must update the visible recommendation path immediately.",
            "",
            "Prompting_Sequencer_1",
          ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        return {
          stdout: "",
          stderr: "Codex CLI timed out after 300000ms.",
          exit_code: 1,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Candidate warehouse artifact stayed within the expected warehouse surface files.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Happy path: the candidate warehouse artifact kept the no-login local flow and did not require server state.",
            "- Negative path: blocked or occupied warehouse slots stayed out of the visible recommendations after local state changes.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => {
      logs.push({
        label: String(entry.label ?? ""),
        stdout: String(entry.stdout ?? ""),
        stderr: String(entry.stderr ?? ""),
        exit_code: Number(entry.exit_code ?? -1),
      });
    },
    runHostWorkspaceCommand: async (command) => {
      if (command.includes(": > '.daacs_timeout_marker_")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.includes("find .") && command.includes(".daacs_timeout_marker_")) {
        return {
          stdout: [
            "./apps/web/src/types/warehouse.ts",
            "./apps/web/src/lib/warehouseRecommendation.ts",
            "./apps/web/src/application/sequencer/parallelScopeProbe.ts",
            "",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.startsWith("rm -f '.daacs_timeout_marker_")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      if (command.startsWith("for p in ")) {
        return {
          stdout: "",
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected host command: ${command}`,
        exit_code: 2,
      };
    },
  });

  const roles = calls.map((call) => call.role);
  const frontendLog = logs.find((entry) => entry.label === "AgentCommand(frontend)");
  assert(ok, "Workspace marker scope filter timeout should continue into quality handoff");
  assert(
    JSON.stringify(roles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Workspace marker scope filter should still route reviewer then verifier, got ${JSON.stringify(roles)}`,
  );
  assert(frontendLog != null, "Expected frontend partial timeout log from workspace marker scope filter");
  assert(
    frontendLog.stdout.includes("apps/web/src/types/warehouse.ts") &&
      frontendLog.stdout.includes("apps/web/src/lib/warehouseRecommendation.ts") &&
      !frontendLog.stdout.includes("apps/web/src/application/sequencer/parallelScopeProbe.ts"),
    `Workspace marker scope filter should drop unrelated sequencer files from partial artifact evidence, got ${JSON.stringify(frontendLog)}`,
  );
}

async function runPartialArtifactRepairUsesOriginalAssignmentRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-partial-artifact-repair-origin",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Build a user-facing static web artifact from natural language" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 6,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm" && instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM re-scoped the timed-out artifact into a smaller slice.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            '[{"AgentName":"frontend","Commands":"Create only the runnable HTML entry and app script after timeout.","CommandSender":"pm"},{"AgentName":"reviewer","Commands":"Review the smaller timeout recovery slice.","CommandSender":"pm","DependsOn":["frontend"]},{"AgentName":"verifier","Commands":"Verify the smaller timeout recovery slice.","CommandSender":"pm","DependsOn":["reviewer"]}]',
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm") {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. frontend -> Create a web artifact for a reservation recommendation advisor.",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "",
            stderr: [
              "Codex CLI timed out after 300 seconds.",
              "[DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
              "status=files_changed_before_timeout",
              "Files changed before timeout:",
              "- index.html",
              "- app.js",
              "[/DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
            ].join("\n"),
            exit_code: 1,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Completed the bounded repair slice after review findings.",
            "[FilesCreated]",
            "index.html",
            "app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- Need stronger evidence that the repaired candidate artifact follows the original reservation constraints.",
              "[/ReviewFindings]",
              "[OpenRisks]",
              "- Reserved slots and conditional reasons are not yet proven against the original assignment.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Repair slice now lines up with the original reservation request.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check confirmed the repaired artifact excludes reserved slots and keeps current-input reasons truthful.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const frontendRepairCall = calls.filter((call) => call.role === "frontend")[1];
  assert(ok, "Partial artifact review repair should complete");
  assert(frontendRepairCall != null, "Expected a frontend repair call after partial artifact review");
  assert(
    frontendRepairCall.instruction.includes(
      "Quality gate feedback requires another repair cycle for this assignment: Build a user-facing static web artifact from natural language",
    ) &&
      !frontendRepairCall.instruction.includes("Review the candidate artifact created before an implementation timeout") &&
      !frontendRepairCall.instruction.includes("Complete this PM-assigned frontend slice for the assignment:"),
    `Partial artifact repair should recover the original assignment context, got ${JSON.stringify(frontendRepairCall?.instruction ?? "")}`,
  );
}

async function runImplementationTimeoutWithoutArtifactRoutesRepairRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const messages: string[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-implementation-timeout-repair",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Build a user-facing static web artifact from natural language" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 5,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm") {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. frontend -> Create the static web artifact with a runnable entry point",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "",
            stderr: "DAACS_TEST_TIMEOUT after 180s",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the smaller runnable web artifact slice after timeout.",
            "[FilesCreated]",
            "index.html",
            "src/app.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Timeout repair slice produced concrete files.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke preview loaded the timeout repair slice and confirmed the runnable entry point rendered.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentMessage: (msg) => {
      messages.push(msg.text);
    },
  });

  const roles = calls.map((call) => call.role);
  const repairCall = calls.filter((call) => call.role === "frontend")[1];
  assert(ok, "Implementation timeout without artifact progress should route a bounded repair");
  assert(
    JSON.stringify(roles) === JSON.stringify(["pm", "frontend", "frontend", "reviewer", "verifier"]),
    `Implementation timeout should retry a smaller implementation slice before quality gates, got ${JSON.stringify(roles)}`,
  );
  assert(
    repairCall?.instruction.includes("Implementation timed out before producing verifiable artifact progress") &&
      repairCall.instruction.includes("provider_timeout_before_artifact_progress") &&
      repairCall.instruction.includes("Bounded repair slice for this cycle") &&
      repairCall.instruction.includes("Timeout-safe repair budget:") &&
      repairCall.instruction.includes("at most 3 created/changed source files") &&
      repairCall.instruction.includes("[FilesCreated]"),
    `Timeout repair should preserve timeout evidence and bounded-slice guidance, got ${JSON.stringify(repairCall?.instruction ?? "")}`,
  );
  assert(
    messages.every((message) => !message.includes("작업 실패")),
    `Recoverable implementation timeout should not be surfaced as a hard failed task, got ${JSON.stringify(messages)}`,
  );
  assert(
    messages.some((message) => message.includes("구현 timeout으로 더 작은 재계획 루프로 전환")),
    `Recoverable implementation timeout should surface a timeout-specific re-scope message, got ${JSON.stringify(messages)}`,
  );
}

async function runReviewerReadyNonBlockingFindingDoesNotRepairRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-reviewer-ready-non-blocking",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "reviewer",
      command: "Review the repaired generated artifact for final readiness.\n\nPrompting_Sequencer_1",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 차단 이슈 없음: 예약 겹침은 `recommendRooms`의 초기 필터와 `isRoomAvailable()`에서 먼저 잘려서, 예약된 즐겨찾기 방도 점수 계산 전에 빠집니다.",
            "- 차단 이슈 없음: 인원 부족은 `room.capacity >= request.attendees`로 바로 제외되어, 작은 방이 추천 목록에 섞일 길이 없습니다.",
            "- final UI slice 진행 가능: 이번 리뷰 범위의 예약 배제 하드 규칙, 팀 선호/즐겨찾기 가중치, 인원 부족·검색어 불일치·즐겨찾기지만 예약됨 부정 케이스에서 막을 이슈를 찾지 못했습니다.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  assert(ok, "Reviewer ready + non-blocking findings should not trigger repair");
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["reviewer"]),
    `Reviewer ready regression should stop without auto-repair, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
}

async function runReviewerReadyIgnoresHistoricalTranscriptVerdictRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const calls: CapturedCascadeCall[] = [];
  const logs: Array<{ label: string; stdout: string }> = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-reviewer-ready-historical-transcript",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{
      agentId: "reviewer",
      command: "Review the bounded repair slice.\n\nPrompting_Sequencer_1",
    }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]ready[/ReviewVerdict]",
            "[ReviewFindings]",
            "- 이전 문제였던 “상위 10개 밖의 예약 가능한 방이 필터로 숨겨져도 이유가 안 보임”은 해결됨: allEligible 기준으로 숨김 이유를 계산함.",
            "- 예약 충돌/정비/수용 인원/장비 부족 방은 제외 목록으로 빠져서, 이미 예약된 방이 추천되는 회귀는 보이지 않음.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
            "x".repeat(30000),
            "",
            "OpenAI Codex v0.124.0",
            "user",
            "[ReviewVerdict]needs_rework[/ReviewVerdict]",
            "[ReviewFindings]",
            "- stale historical finding from a prior reviewer turn",
            "[/ReviewFindings]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: (entry) => logs.push({ label: entry.label, stdout: entry.stdout }),
  });

  assert(ok, "Reviewer ready verdict should ignore stale historical transcript verdicts after END_TASK");
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["reviewer"]),
    `Historical transcript verdict should not trigger repair, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  const reviewerLog = logs.find((entry) => entry.label === "AgentCommand(reviewer)");
  assert(
    reviewerLog != null && !reviewerLog.stdout.includes("stale historical finding"),
    `Compacted reviewer log should strip stale CLI transcript tags, got ${JSON.stringify(reviewerLog?.stdout ?? "")}`,
  );
}

async function runBoundedSliceTimeoutRoutesPmRescopeRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-bounded-timeout-pm-rescope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a user-facing generated web app from natural language with bounded implementation slices." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 6,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Final PM handoff",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (
        role === "pm" &&
        sequencerMatch?.[1] === "1" &&
        !instruction.includes("Timeout-triggered PM re-scope")
      ) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated the second unfinished interactive slice.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Implement the live interactive state wiring and refresh slice after the foundation.",
                CommandSender: "pm",
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "",
            stderr: "Codex CLI timed out after 300000ms.",
            exit_code: 1,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the smaller unfinished interaction slice after PM re-scope.",
            "[FilesCreated]",
            "src/draft/state.js",
            "src/draft/refresh.js",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM re-scoped the unfinished slice into a smaller execution card.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build only the draft-state store and live refresh loop for the unfinished interactive slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the smaller interaction slice after implementation.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the smaller interaction slice after review.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Verified the smaller interaction slice refreshed live without restarting the whole artifact.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const roles = calls.map((call) => call.role);
  const pmRescopeCall = calls.find(
    (call, index) => call.role === "pm" && index > 1 && call.instruction.includes("Timeout-triggered PM re-scope"),
  );
  const rescopeFrontendCall = calls.find(
    (call, index) => call.role === "frontend" && index > 2 && call.instruction.includes("Build only the draft-state store"),
  );
  assert(ok, "Bounded slice timeout should recover through PM re-scope");
  assert(
    JSON.stringify(roles) === JSON.stringify(["pm", "pm", "frontend", "pm", "frontend", "reviewer", "verifier"]),
    `Bounded slice timeout should route back through PM before retrying implementation, got ${JSON.stringify(roles)}`,
  );
  assert(
    pmRescopeCall?.instruction.includes("Create a user-facing generated web app from natural language with bounded implementation slices.") &&
      pmRescopeCall.instruction.includes("Implement the live interactive state wiring and refresh slice after the foundation.") &&
      pmRescopeCall.instruction.includes("Do not send the same large slice back unchanged."),
    `PM re-scope should preserve the root assignment and the timed-out slice, got ${JSON.stringify(pmRescopeCall?.instruction ?? "")}`,
  );
  assert(
    rescopeFrontendCall?.instruction.includes("Build only the draft-state store and live refresh loop for the unfinished interactive slice.") &&
      !rescopeFrontendCall.instruction.includes("Quality gate feedback requires another repair cycle"),
    `Bounded timeout follow-up should come from PM re-scope, not the old same-owner repair loop, got ${JSON.stringify(rescopeFrontendCall?.instruction ?? "")}`,
  );
}

async function runTopLevelImplementationTimeoutRoutesPmRescopeRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-top-level-timeout-pm-rescope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a fresh input-driven recommendation web app." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 6,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "pm" && !instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. frontend -> Create Vite React TS app in this workspace root.",
            "2. reviewer -> Review after implementation.",
            "3. verifier -> Verify after review.",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return { stdout: "", stderr: "DAACS_TEST_TIMEOUT after 180s", exit_code: 0 };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created smaller scaffold slice.",
            "[FilesCreated]",
            "package.json",
            "src/App.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM split the timed-out scaffold into a smaller card.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            '[{"AgentName":"frontend","Commands":"Create only package.json and src/App.tsx for the scaffold.","CommandSender":"pm"},{"AgentName":"reviewer","Commands":"Review the smaller scaffold.","CommandSender":"pm","DependsOn":["frontend"]},{"AgentName":"verifier","Commands":"Verify the smaller scaffold.","CommandSender":"pm","DependsOn":["reviewer"]}]',
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") return { stdout: taggedReviewerStepOutput(), stderr: "", exit_code: 0 };
      if (role === "verifier") return { stdout: taggedVerifierStepOutput(), stderr: "", exit_code: 0 };
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const roles = calls.map((call) => call.role);
  assert(ok, "Top-level implementation timeout should recover through PM re-scope");
  assert(
    JSON.stringify(roles) === JSON.stringify(["pm", "frontend", "pm", "frontend", "reviewer", "verifier"]),
    `Top-level timeout should route PM re-scope before retrying implementation, got ${JSON.stringify(roles)}`,
  );
}

async function runPmAssignedSliceTimeoutRoutesPmRescopeRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-pm-assigned-timeout-pm-rescope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Build a no-login warehouse slot recommendation web app from natural language." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 7,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Final PM handoff",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (
        role === "pm" &&
        sequencerMatch?.[1] === "1" &&
        !instruction.includes("Timeout-triggered PM re-scope")
      ) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM produced section-based handoff only.",
            "[/STEP_1_RESULT]",
            "FRONTEND_TASKS:",
            "- Add bundled warehouse slot data and occupancy state plus the slot recommendation engine. Done when impossible slots never enter the visible top 10.",
            "- Wire filter/search inputs and live recompute on a single page. Done when changing constraints updates rankings immediately without reload.",
            "BACKEND_TASKS:",
            "- (none)",
            "REVIEWER_TASKS:",
            "- Review the repaired warehouse recommendation slice after implementation.",
            "VERIFIER_TASKS:",
            "- Verify the repaired warehouse recommendation slice after review.",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "",
            stderr: "Codex CLI timed out after 300000ms.",
            exit_code: 1,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Built the smaller repaired warehouse slice after PM re-scope.",
            "[FilesCreated]",
            "src/features/warehouse/recommend.ts",
            "src/features/warehouse/filters.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && instruction.includes("Timeout-triggered PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM re-scoped the timed-out assigned slice into a smaller warehouse card.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands:
                  "Build the smallest end-to-end warehouse slot recommendation slice for the unfinished retry: include bundled occupancy data, card/search selection, immediate top-10 recompute, and impossible-slot exclusion before deferring favorites persistence.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the smaller warehouse slot recommendation slice after implementation.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the smaller warehouse slot recommendation slice after review.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[HostFeedbackStatus]",
            "pass",
            "[/HostFeedbackStatus]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- User-flow smoke passed: card/filter/search selection, top-10 live recompute, and visible valid warehouse slots rendered.",
            "- Favorites persistence was intentionally deferred outside this smaller timeout recovery slice.",
            "- Negative path: impossible or blocked warehouse slots stayed out of the visible recommendations.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const roles = calls.map((call) => call.role);
  const firstFrontendCall = calls.find((call) => call.role === "frontend");
  const pmRescopeCall = calls.find(
    (call, index) => call.role === "pm" && index > 2 && call.instruction.includes("Timeout-triggered PM re-scope"),
  );
  const directRepairCall = calls.find(
    (call) => call.role === "frontend" && call.instruction.includes("Quality gate feedback requires another repair cycle"),
  );
  const rescopeFrontendCall = calls.find(
    (call, index) => call.role === "frontend" && index > 3,
  );
  assert(ok, "PM-assigned slice timeout should recover through PM re-scope");
  assert(
    JSON.stringify(roles) === JSON.stringify(["pm", "pm", "frontend", "pm", "frontend", "reviewer", "verifier"]),
    `PM-assigned slice timeout should route back through PM before retrying implementation, got ${JSON.stringify(roles)}`,
  );
  assert(
    firstFrontendCall?.instruction.includes("Add bundled warehouse slot data and occupancy state plus the slot recommendation engine.") ||
      firstFrontendCall?.instruction.includes("Split dense recommendation foundation/frontend support slice part 1/2"),
    `PM-assigned foundation slice should stay in foundation/engine lane instead of drifting into result polish, got ${JSON.stringify(firstFrontendCall?.instruction ?? "")}`,
  );
  assert(
    !firstFrontendCall?.instruction.includes("Split dense results/polish frontend slice part 1/2"),
    `PM-assigned foundation slice should not be misclassified as result-polish, got ${JSON.stringify(firstFrontendCall?.instruction ?? "")}`,
  );
  assert(
    pmRescopeCall?.instruction.includes("Build a no-login warehouse slot recommendation web app from natural language.") &&
      pmRescopeCall.instruction.includes("Add bundled warehouse slot data and occupancy state plus the slot recommendation engine.") &&
      pmRescopeCall.instruction.includes("Wire filter/search inputs and live recompute on a single page.") &&
      pmRescopeCall.instruction.includes("Do not send the same large slice back unchanged."),
    `PM re-scope should preserve the timed-out assigned slice instead of collapsing back to the root assignment, got ${JSON.stringify(pmRescopeCall?.instruction ?? "")}`,
  );
  assert(
    directRepairCall == null &&
      rescopeFrontendCall?.instruction.includes("warehouse slot recommendation"),
    `PM-assigned timeout follow-up should come from PM re-scope, not direct repair, got frontend calls=${JSON.stringify(calls.filter((call) => call.role === "frontend").map((call) => call.instruction))}`,
  );
}

async function runBoundedPartialArtifactTimeoutReviewReworkRoutesPmRescopeRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const coordinator = new SequencerCoordinator();
  let frontendRuns = 0;
  let reviewerRuns = 0;

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-bounded-partial-artifact-timeout-pm-rescope",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "pm", command: "Create a user-facing generated web app from natural language with bounded implementation slices." }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 8,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "pm" && sequencerMatch?.[1] == null) {
        return {
          stdout: [
            "[SEQUENCER_PLAN]",
            "1. Final PM handoff",
            "[/SEQUENCER_PLAN]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (
        role === "pm" &&
        sequencerMatch?.[1] === "1" &&
        !instruction.includes("Partial-artifact timeout quality review requires PM re-scope")
      ) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM delegated the unfinished live interactive slice.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Slice 2: Implement the live interactive state wiring, control bindings, and refresh behavior after the foundation slice.",
                CommandSender: "pm",
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: "",
            stderr: [
              "Codex CLI timed out after 300 seconds.",
              "[DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
              "status=files_changed_before_timeout",
              "Files changed before timeout:",
              "- src/types.ts",
              "- src/lib/recommendRooms.ts",
              "- src/data/seed.ts",
              "[/DAACS_PARTIAL_ARTIFACT_TIMEOUT]",
            ].join("\n"),
            exit_code: 1,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Created the smaller interaction slices after PM re-scope.",
            "[FilesCreated]",
            "src/App.tsx",
            "src/state/store.ts",
            "src/components/FilterPanel.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        reviewerRuns += 1;
        if (reviewerRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[ReviewVerdict]",
              "needs_rework",
              "[/ReviewVerdict]",
              "[ReviewFindings]",
              "- `src/main.tsx` imports `./App`, but there is no `src/App.*` file yet, so this bounded interactive slice is still incomplete.",
              "- The slice asked for live interactive state wiring and control bindings, but the current partial artifact only contains engine/data files.",
              "[/ReviewFindings]",
              "[OpenRisks]",
              "- Re-splitting the unfinished slice is safer than sending the same large interactive slice back unchanged.",
              "[/OpenRisks]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- The smaller interaction slices now expose concrete app-state and control wiring.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "pm" && instruction.includes("Partial-artifact timeout quality review requires PM re-scope")) {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "PM re-scoped the unfinished interactive slice after partial-artifact review findings.",
            "[/STEP_1_RESULT]",
            "[AGENT_COMMANDS]",
            JSON.stringify([
              {
                AgentName: "frontend",
                Commands: "Build only the app-state container and filter panel wiring for the unfinished interactive slice.",
                CommandSender: "pm",
              },
              {
                AgentName: "reviewer",
                Commands: "Review the smaller interaction wiring slice after implementation.",
                CommandSender: "pm",
                DependsOn: ["frontend"],
              },
              {
                AgentName: "verifier",
                Commands: "Verify the smaller interaction wiring slice after review.",
                CommandSender: "pm",
                DependsOn: ["reviewer"],
              },
            ]),
            "[/AGENT_COMMANDS]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- Browser smoke check confirmed the smaller interaction wiring slice now updates live controls without reusing the incomplete timeout candidate.",
            "[/Verification]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return { stdout: "", stderr: `unexpected role: ${role}`, exit_code: 2 };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const roles = calls.map((call) => call.role);
  const pmRescopeCall = calls.find(
    (call, index) => call.role === "pm" && index > 2 && call.instruction.includes("Partial-artifact timeout quality review requires PM re-scope"),
  );
  const rescopeFrontendCall = calls.find(
    (call, index) => call.role === "frontend" && index > 3 && call.instruction.includes("Build only the app-state container"),
  );
  const directRepairCall = calls.find(
    (call) => call.role === "frontend" && call.instruction.includes("Quality gate feedback requires another repair cycle"),
  );
  assert(ok, "Bounded partial artifact timeout should recover through PM re-scope");
  assert(
    JSON.stringify(roles) === JSON.stringify(["pm", "pm", "frontend", "reviewer", "pm", "frontend", "reviewer", "verifier"]),
    `Bounded partial artifact timeout should rescope through PM instead of direct same-owner repair, got ${JSON.stringify(roles)}`,
  );
  assert(
    pmRescopeCall?.instruction.includes("Create a user-facing generated web app from natural language with bounded implementation slices.") &&
      pmRescopeCall.instruction.includes("Slice 2: Implement the live interactive state wiring, control bindings, and refresh behavior after the foundation slice.") &&
      pmRescopeCall.instruction.includes("Partial files already changed before timeout:") &&
      pmRescopeCall.instruction.includes("src/types.ts") &&
      pmRescopeCall.instruction.includes("Preserve useful partial files") &&
      pmRescopeCall.instruction.includes("Do not send the same large slice or the same incomplete candidate-review loop back unchanged."),
    `Partial artifact PM re-scope should preserve the root assignment and unfinished slice, got ${JSON.stringify(pmRescopeCall?.instruction ?? "")}`,
  );
  assert(
    rescopeFrontendCall?.instruction.includes("Build only the app-state container and filter panel wiring for the unfinished interactive slice.") &&
      directRepairCall == null,
    `Partial artifact follow-up should come from PM re-scope, not a direct quality-repair loop, got frontend calls=${JSON.stringify(calls.filter((call) => call.role === "frontend").map((call) => call.instruction))}`,
  );
}

async function runHostFailureRepairPreservesRootErrorRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const workspaceCommands: string[] = [];
  let verifierCommandIssued = false;
  const coordinator = new SequencerCoordinator();
  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-host-failure-root-error",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command:
          "Verify generated web artifact from a user perspective\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const prompt = String(options?.systemPrompt ?? "");
      const role = prompt.replace(/^role:/, "");
      if (prompt.includes("The host has executed a shell command in the workspace.")) {
        return {
          stdout: "OK",
          stderr: "",
          exit_code: 0,
        };
      }
      calls.push({ role, instruction });
      if (prompt === "role:verifier" && !verifierCommandIssued) {
        verifierCommandIssued = true;
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[Verification]",
            "- Need host regression evidence.",
            "[/Verification]",
            "[Command]",
            "1. npm --prefix apps/web run test:regression",
            "[/Command]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- The bounded repair now targets the failing generated widget runtime path directly.",
            "[/ReviewFindings]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role !== "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Repaired the generated widget runtime path after the host regression failure.",
            "[FilesCreated]",
            "apps/web/src/components/generated/Widget.tsx",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]",
          "pass",
          "[/VerificationStatus]",
          "[Verification]",
          "- Browser smoke check loaded the repaired artifact and confirmed the React runtime error no longer occurs.",
          "[/Verification]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      if (command === "npm --prefix apps/web run test:regression") {
        return {
          stdout: [
            "Running App pre-office BYOK access regression",
            "ReferenceError: React is not defined",
            "    at ChampionRecommender (/workspace/apps/web/src/components/generated/Widget.tsx:236:3)",
          ].join("\n"),
          stderr: "",
          exit_code: 1,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected command: ${command}`,
        exit_code: 2,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  const implementationRepairCall = calls.find(
    (call) =>
      call.role !== "reviewer" &&
      call.role !== "verifier" &&
      call.instruction.includes("Quality gate feedback requires another repair cycle"),
  );
  const relevantWorkspaceCommands = workspaceCommands.filter(
    (command) => !command.includes(".daacs_timeout_marker_") && !command.startsWith("for p in "),
  );
  assert(
    JSON.stringify(relevantWorkspaceCommands) === JSON.stringify(["npm --prefix apps/web run test:regression"]),
    `Expected one failing host command before repair routing, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(ok, "Expected verifier host failure regression to complete after routing repair");
  assert(implementationRepairCall != null, "Expected verifier host failure to route an implementation repair");
  assert(
    implementationRepairCall.instruction.includes("npm --prefix apps/web run test:regression") &&
      implementationRepairCall.instruction.includes("ReferenceError: React is not defined") &&
      implementationRepairCall.instruction.includes("Key failing command") &&
      implementationRepairCall.instruction.includes("that exact host command/error is the current target") &&
      implementationRepairCall.instruction.includes("make it pass before fixing adjacent symptoms"),
    `Repair instruction should preserve the failing command and root runtime error, got ${JSON.stringify(implementationRepairCall.instruction)}`,
  );
}

async function runHostFailureRepairPreservesSmokeAssertionRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  let frontendRuns = 0;
  const coordinator = new SequencerCoordinator();
  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-host-failure-smoke-assertion",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command:
          "Create a warehouse picking recommendation website. Locked zones must never appear in valid recommendations.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 4,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (role === "frontend") {
        frontendRuns += 1;
        if (frontendRuns === 1) {
          return {
            stdout: [
              "[STEP_1_RESULT]",
              "[HostFeedbackStatus]",
              "blocked",
              "[/HostFeedbackStatus]",
              "[Verification]",
              "Host command evidence:",
              "1. cd /tmp/live-workspace && npm install && npm run build && npm run smoke | exit_code=1 | stdout=✓ built in 432ms | stderr=The current testing environment is not configured to support act(...)",
              "/private/tmp/live-workspace/smoke-ui.tsx:72",
              "if (text().includes(\"COLD-LOCK\") || text().includes(\"SEC-LOCK\")) throw new Error(\"locked zones must not appear as valid recommendations\");",
              "                                                                       ^",
              "",
              "Error: locked zones must not appear as valid recommendations",
              "    at <anonymous> (/private/tmp/live-workspace/smoke-ui.tsx:72:72)",
              "[/Verification]",
              "[FilesCreated]",
              "package.json",
              "smoke-ui.tsx",
              "[/FilesCreated]",
              "[/STEP_1_RESULT]",
              "{END_TASK_1}",
            ].join("\n"),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "Fixed locked-zone filtering in the recommendation display path.",
            "[FilesCreated]",
            "src/recommendations.ts",
            "[/FilesCreated]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "reviewer") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[ReviewVerdict]",
            "ready",
            "[/ReviewVerdict]",
            "[ReviewFindings]",
            "- Locked-zone smoke assertion is now addressed by the bounded repair.",
            "[/ReviewFindings]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      if (role === "verifier") {
        return {
          stdout: [
            "[STEP_1_RESULT]",
            "[VerificationStatus]",
            "pass",
            "[/VerificationStatus]",
            "[Verification]",
            "- npm run smoke passed and proved locked zones stay excluded from valid recommendations.",
            "- User-flow smoke passed: search/input changes refresh the recommendation list.",
            "[/Verification]",
            "[OpenRisks]",
            "[/OpenRisks]",
            "[/STEP_1_RESULT]",
            "{END_TASK_1}",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role: ${role}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
  });

  const repairCall = calls.filter((call) => call.role === "frontend")[1];
  assert(ok, `Expected smoke assertion repair to complete, got roles=${JSON.stringify(calls.map((call) => call.role))}`);
  assert(
    repairCall?.instruction.includes("locked zones must not appear as valid recommendations") &&
      repairCall.instruction.includes("failing_command=cd /tmp/live-workspace && npm install && npm run build && npm run smoke") &&
      repairCall.instruction.includes("that exact host command/error is the current target"),
    `Repair instruction should preserve the exact smoke assertion, got ${JSON.stringify(repairCall?.instruction ?? "")}`,
  );
}

async function runStepHostCommandStderrPromptIsolationRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const workspaceCommands: string[] = [];

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-step-host-command-stderr-prompt-isolation",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "frontend", command: "Build the assigned artifact\n\nPrompting_Sequencer_1" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "frontend" && sequencerMatch?.[1] != null) {
        const stepNumber = sequencerMatch[1];
        return {
          stdout: [
            `[STEP_${stepNumber}_RESULT]`,
            "Created the bounded artifact slice.",
            "[FilesCreated]",
            "index.html",
            "[/FilesCreated]",
            `[/STEP_${stepNumber}_RESULT]`,
            `{END_TASK_${stepNumber}}`,
          ].join("\n"),
          stderr: [
            "Prompting Sequencer Protocol reminder",
            "- Host must run shell commands: include `[Command]...[/Command]` before `{END_TASK_1}`.",
            "Example when needed:",
            "[Command]",
            "1. npm run build",
            "[/Command]",
          ].join("\n"),
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role/instruction: ${role} :: ${instruction}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "",
        stderr: `unexpected host command: ${command}`,
        exit_code: 2,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  assert(ok, "stderr prompt examples must not trigger host execution when stdout already contains the real step result");
  const nonInternalWorkspaceCommands = workspaceCommands.filter(
    (command) => !command.includes(".daacs_timeout_marker_") && !command.startsWith("for p in "),
  );
  assert(
    nonInternalWorkspaceCommands.length === 0,
    `stderr prompt examples should not be parsed as real host commands, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runStepHostCommandPrimaryResultIsolationRegression(): Promise<void> {
  const coordinator = new SequencerCoordinator();
  const workspaceCommands: string[] = [];

  const looseParseHostCommands = async (text: string): Promise<string[]> => {
    const commands: string[] = [];
    const matches = String(text ?? "").matchAll(/\[(?:Command|Commands)\]([\s\S]*?)\[\/(?:Command|Commands)\]/gi);
    for (const match of matches) {
      const body = match[1] ?? "";
      for (const line of body.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        const numbered = trimmed.match(/^\d+[.)]\s+(.+?)\s*$/);
        commands.push((numbered?.[1] ?? trimmed).trim());
      }
    }
    return commands;
  };

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-step-host-command-primary-result-isolation",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [{ agentId: "frontend", command: "Build the assigned artifact\n\nPrompting_Sequencer_1" }],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const systemPrompt = String(options?.systemPrompt ?? "");
      if (systemPrompt.includes("The host has executed a shell command in the workspace.")) {
        return { stdout: "OK", stderr: "", exit_code: 0 };
      }
      const role = systemPrompt.replace(/^role:/, "");
      const sequencerMatch = instruction.match(/Prompting_Sequencer_(\d+)/);
      if (role === "frontend" && sequencerMatch?.[1] != null) {
        const stepNumber = sequencerMatch[1];
        return {
          stdout: [
            `[STEP_${stepNumber}_RESULT]`,
            "Created the bounded artifact slice.",
            "[FilesCreated]",
            "index.html",
            "[/FilesCreated]",
            "[Command]",
            "npm run build",
            "[/Command]",
            `[/STEP_${stepNumber}_RESULT]`,
            `{END_TASK_${stepNumber}}`,
            "",
            "OpenAI Codex v0.124.0 (research preview)",
            "--------",
            "[Command]",
            "[OutputCompacted]",
            "original_chars=90824",
            "reason=large agent output; original is retained in trace logs when tracing is enabled",
            "[/OutputCompacted]",
            "[/Command]",
          ].join("\n"),
          stderr: "",
          exit_code: 0,
        };
      }
      return {
        stdout: "",
        stderr: `unexpected role/instruction: ${role} :: ${instruction}`,
        exit_code: 2,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return command === "npm run build"
        ? { stdout: "build passed", stderr: "", exit_code: 0 }
        : { stdout: "", stderr: `unexpected host command: ${command}`, exit_code: 2 };
    },
    extractHostCommandsFromStepOutput: looseParseHostCommands,
  });

  assert(ok, "host command extraction should ignore appended Codex transcript command blocks");
  const nonInternalWorkspaceCommands = workspaceCommands.filter(
    (command) => !command.includes(".daacs_timeout_marker_") && !command.startsWith("for p in "),
  );
  assert(
    JSON.stringify(nonInternalWorkspaceCommands) === JSON.stringify(["npm run build"]),
    `Only the primary step-result host command should run, got ${JSON.stringify(workspaceCommands)}`,
  );
}

async function runVerifierExitCodeZeroSmokeEvidencePassesRegression(): Promise<void> {
  const calls: CapturedCascadeCall[] = [];
  const messages: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-verifier-exit-code-zero-smoke-pass",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "verifier",
        command: [
          "Verify a generated meeting-room recommendation web app.",
          "The app must recompute visible recommendations from user input, keep already booked rooms excluded, and keep conditional reasons truthful.",
          "",
          "Prompting_Sequencer_1",
        ].join("\n"),
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 3,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (instruction, options) => {
      const role = String(options?.systemPrompt ?? "").replace(/^role:/, "");
      calls.push({ role, instruction });
      if (calls.length > 1) {
        return {
          stdout: "",
          stderr: `unexpected rework call after verifier pass: ${role}`,
          exit_code: 2,
        };
      }
      assert(role === "verifier", `Expected only verifier call, got ${role}`);
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "[VerificationStatus]pass[/VerificationStatus]",
          "[Verification]",
          "- `npm run build`: exit code 0; Vite build completed and produced `dist/index.html`.",
          "- `npm run smoke`: exit code 0; smoke script reported DOM structure, input recalculation wiring, localStorage, excluded rooms, and conflict guard present.",
          "- Negative path checked by smoke/source guard: already booked rooms stay excluded and are not recommended.",
          "- Conditional reasons checked: equipment and preferred-floor reasons appear only when the current input makes them true.",
          "[/Verification]",
          "[OpenRisks]",
          "[/OpenRisks]",
          "[FilesCreated]",
          "dist/index.html",
          "dist/assets/index.js",
          "[/FilesCreated]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentMessage: (message) => {
      messages.push(message.text);
    },
  });

  assert(
    ok,
    `Verifier pass with \`exit code 0\` smoke/build evidence should not trigger rework; calls=${JSON.stringify(calls.map((call) => call.role))} messages=${JSON.stringify(messages)}`,
  );
  assert(
    JSON.stringify(calls.map((call) => call.role)) === JSON.stringify(["verifier"]),
    `Verifier concrete pass evidence should finish without another repair/verifier loop, got ${JSON.stringify(calls.map((call) => call.role))}`,
  );
  assert(
    messages.some((message) => message === "작업 완료") &&
      messages.every((message) => !message.includes("재작업")),
    `Verifier pass should surface completion, got ${JSON.stringify(messages)}`,
  );
}

async function runHostFeedbackEffectivePassDoesNotSurfaceErrorRegression(): Promise<void> {
  const messages: string[] = [];
  const workspaceCommands: string[] = [];
  const coordinator = new SequencerCoordinator();

  const ok = await coordinator.RunAgentCommandCascade({
    projectName: "local",
    workspace: "/tmp/daacs-host-feedback-effective-pass-message",
    cliProvider: null,
    agentsMetadataJson: AGENTS_METADATA_JSON,
    seed: [
      {
        agentId: "frontend",
        command: "Create the smallest web smoke artifact and request host smoke verification.\n\nPrompting_Sequencer_1",
      },
    ],
    setAgentTaskByRole: () => {},
    setPhase: () => {},
    maxCascade: 2,
    parseSequencerPlanSteps: parsePlanSteps,
    runCliCommand: async (_instruction, options) => {
      const systemPrompt = String(options?.systemPrompt ?? "");
      if (systemPrompt.includes("The host has executed a shell command in the workspace.")) {
        return { stdout: "", stderr: "", exit_code: 0 };
      }
      return {
        stdout: [
          "[STEP_1_RESULT]",
          "Created a smoke-ready artifact.",
          "[FilesCreated]",
          "package.json",
          "src/App.tsx",
          "[/FilesCreated]",
          "[Command]",
          "1. npm run smoke",
          "[/Command]",
          "[/STEP_1_RESULT]",
          "{END_TASK_1}",
        ].join("\n"),
        stderr: "",
        exit_code: 0,
      };
    },
    buildRosterDelegationSystemPrompt: async (_projectName, promptRole) => `role:${promptRole}`,
    mapTauriCliRoleKeyToAgentPromptRole: (key) => key as AgentPromptRole,
    onCliLog: () => {},
    onAgentMessage: (message) => {
      messages.push(message.text);
    },
    runHostWorkspaceCommand: async (command) => {
      workspaceCommands.push(command);
      return {
        stdout: "smoke passed: DOM and negative case stayed excluded",
        stderr: "",
        exit_code: 0,
      };
    },
    extractHostCommandsFromStepOutput: async (text) => parseHostCommandBlocks(text),
  });

  assert(ok, "Effective host feedback pass should complete the cascade");
  assert(
    JSON.stringify(workspaceCommands.filter((command) => !command.includes(".daacs_timeout_marker_") && !command.startsWith("for p in "))) ===
      JSON.stringify(["npm run smoke"]),
    `Expected one smoke host command, got ${JSON.stringify(workspaceCommands)}`,
  );
  assert(
    messages.some((message) => message === "작업 완료") &&
      messages.every((message) => !message.includes("호스트 검증 피드백이 작업 완료를 확인하지 못함")),
    `Effective host pass should not surface a host-feedback error, got ${JSON.stringify(messages)}`,
  );
}

export async function runSequencerCoordinatorRegressionTests(): Promise<void> {
  try {
  const coordinatorSource = await readFile(new URL("./SequencerCoordinator.ts", import.meta.url), "utf8");
  assert(
    coordinatorSource.includes("BuildFrontendUxEvidenceChecklistBlock") &&
      coordinatorSource.includes("Frontend/web UI evidence to report when applicable:") &&
      coordinatorSource.includes("For frontend/web deliverables, include concrete UI/UX evidence categories") &&
      coordinatorSource.includes("For frontend/web deliverables, [Verification] must name") &&
      coordinatorSource.includes("For premium product quality, report these higher-level evidence categories only when proven") &&
      coordinatorSource.includes("correction/recovery path") &&
      coordinatorSource.includes("scanability") &&
      coordinatorSource.includes("viewport overflow/action visibility") &&
      coordinatorSource.includes("source-string-only smoke is insufficient for layout quality") &&
      coordinatorSource.includes("no horizontal viewport overflow or clipped primary actions") &&
      coordinatorSource.includes("primary interactive controls/action buttons are visible/reachable") &&
      coordinatorSource.includes("viewport overflow/action visibility flow") &&
      coordinatorSource.includes("one coherent reference_archetype") &&
      coordinatorSource.includes("honest source_level") &&
      coordinatorSource.includes("reference_quality_bar coverage") &&
      coordinatorSource.includes("accessibility basics, visual craft") &&
      coordinatorSource.includes("reference pattern adaptation") &&
      coordinatorSource.includes("For premium/reference-informed deliverables, also check whether one coherent reference_archetype was chosen") &&
      coordinatorSource.includes("source_level is honest") &&
      coordinatorSource.includes("source names or inspiration claims are not enough") &&
      coordinatorSource.includes("empty state flow") &&
      coordinatorSource.includes("mobile/responsive flow") &&
      coordinatorSource.includes("button interaction flow"),
    "SequencerCoordinator should require concrete frontend/web UI/UX evidence categories instead of vague completion claims",
  );
  assert(
    /ResolveAgentExecutionCompletionStatus\(\s*officeRole,\s*outputText,\s*command,\s*exitCode,\s*payload\.ChangedFiles \?\? \[\],\s*assignmentContext,\s*\)/m.test(
      coordinatorSource,
    ),
    "Execution completion status should include the original assignment context so artifact quality gates can judge against the real user request",
  );

  runPlanParserIgnoresUntaggedImplementationSummaryRegression();
  runPlanParserIgnoresNestedCardBulletsRegression();
  await runVerifierExitCodeZeroSmokeEvidencePassesRegression();
  await runHostFeedbackEffectivePassDoesNotSurfaceErrorRegression();

  const stderrIsolationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Audit the current workspace boundary",
      "2. Summarize concrete risks",
      "3. Define downstream routing",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    [
      "1. bogus stderr line that must not become a plan step",
      "2. bogus stderr line that must not become a quality gate",
    ].join("\n"),
  );

  assert(
    stderrIsolationCalls.length >= 3,
    `Expected PM planning and execution steps, got ${stderrIsolationCalls.length}`,
  );
  assert(
    stderrIsolationCalls.every((call) => call.role === "pm"),
    "PM-only planning output should not inject reviewer/verifier from stderr noise",
  );

  const overloadedPlanningCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Define UI/API test plan and success criteria for the artifact quality check",
      "2. Outline component contract risks before developer handoff",
      "3. Summarize frontend/backend verification scope without starting implementation",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );

  assert(
    overloadedPlanningCalls.length === 3 &&
      overloadedPlanningCalls.every((call) => call.role === "pm"),
    `PM-only planning rows with overloaded words should stay collapsed on PM, got ${JSON.stringify(overloadedPlanningCalls.map((call) => call.role))}`,
  );

  const mixedRoutingCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Fix backend/src/auth.rs BYOK endpoint compatibility",
      "2. Restore apps/web/src/components/office/LlmSettingsModal.tsx reachability",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );

  assert(mixedRoutingCalls[0]?.role === "pm", "PM planning should execute first");
  const nonPmRoles = mixedRoutingCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    nonPmRoles.includes("backend"),
    "Backend-flavored implementation row should route to backend",
  );
  assert(
    nonPmRoles.includes("frontend"),
    "Frontend-flavored implementation row should route to frontend",
  );

  const webServiceRoutingCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. frontend -> Fix apps/web/src/services/workflowApi.ts UI-only guardrails",
      "2. frontend -> Repair apps/web/src/services/httpClient.ts auth propagation",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const webServiceNonPmRoles = webServiceRoutingCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    webServiceNonPmRoles.filter((role) => role === "frontend").length >= 2 &&
      webServiceNonPmRoles.includes("reviewer") &&
      webServiceNonPmRoles.includes("verifier") &&
      !webServiceNonPmRoles.includes("backend"),
    `apps/web service implementation rows should stay on frontend ownership and retain quality gates, got ${JSON.stringify(webServiceNonPmRoles)}`,
  );

  const ambiguousWebImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Fix apps/web/src/services/workflowApi.ts UI-only guardrails",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const ambiguousWebRoles = ambiguousWebImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(ambiguousWebRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Ambiguous apps/web implementation rows should route to frontend ownership with quality gates, got ${JSON.stringify(ambiguousWebRoles)}`,
  );

  const koreanWebsiteImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. 롤 픽창에서 챔피언 추천 웹사이트 화면을 구현한다",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const koreanWebsiteRoles = koreanWebsiteImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(koreanWebsiteRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Korean website implementation requests should route to frontend ownership with quality gates, got ${JSON.stringify(koreanWebsiteRoles)}`,
  );

  const webToolImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Build a browser web tool for receipt classification from natural-language input",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const webToolRoles = webToolImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(webToolRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Browser web tool requests should route to frontend ownership despite generic tool wording, got ${JSON.stringify(webToolRoles)}`,
  );

  const cliToolImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Build a receipt classifier CLI tool from natural-language input",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const cliToolRoles = cliToolImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(cliToolRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `CLI tool requests should route missing-file repair to backend ownership when no frontend context exists, got ${JSON.stringify(cliToolRoles)}`,
  );

  const modalReachabilityImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Restore the settings modal path so account-level BYOK settings are reachable again",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const modalReachabilityRoles = modalReachabilityImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(modalReachabilityRoles) === JSON.stringify(["frontend", "reviewer", "verifier"]),
    `Frontend modal reachability rework should stay frontend-owned with quality gates, got ${JSON.stringify(modalReachabilityRoles)}`,
  );

  const ambiguousBackendImplementationCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Repair auth endpoint compatibility without changing the contract surface",
      "2. Summarize the unresolved routing risk",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const ambiguousBackendRoles = ambiguousBackendImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(ambiguousBackendRoles) === JSON.stringify(["backend", "reviewer", "verifier"]),
    `Ambiguous backend implementation rows should route to backend ownership with quality gates, got ${JSON.stringify(ambiguousBackendRoles)}`,
  );

  const legacyRegistry = new AgentRegistry(
    new SequencerCoordinator().ParseRosterAgents(AGENTS_METADATA_JSON),
  );
  const legacyWorkflowCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[NEXT_WORKFLOW]",
      '[{"AgentName":"backend","Commands":"Fix the auth endpoint contract."}]',
      "[/NEXT_WORKFLOW]",
    ].join("\n"),
    legacyRegistry,
    "pm",
  );
  assert(
    legacyWorkflowCommands.length === 0,
    "Legacy NEXT_WORKFLOW output should no longer be accepted by the sequencer parser",
  );

  const agentCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMANDS]",
      '[{"AgentName":"backend","Commands":"Fix the auth endpoint contract.","CommandSender":"pm"}]',
      "[/AGENT_COMMANDS]",
    ].join("\n"),
    legacyRegistry,
    "reviewer",
  );
  assert(
    agentCommands.length === 1 &&
      agentCommands[0]?.agentId === "backend" &&
      agentCommands[0]?.command === "Fix the auth endpoint contract." &&
      agentCommands[0]?.senderId === "pm",
    "AGENT_COMMANDS output should parse into a backend delegation with the declared sender",
  );
  const markdownAgentCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMANDS]",
      "1) (to: frontend | id: frontend)",
      "- 작업: Build the web artifact.",
      "- 생성 파일: index.html, app.js",
      "",
      "2) (to: reviewer | id: reviewer)",
      "- 작업: Review after implementation.",
      "[/AGENT_COMMANDS]",
    ].join("\n"),
    legacyRegistry,
    "pm",
  );
  assert(
    markdownAgentCommands.length === 2 &&
      markdownAgentCommands[0]?.agentId === "frontend" &&
      markdownAgentCommands[0]?.command.includes("Build the web artifact.") &&
      markdownAgentCommands[1]?.agentId === "reviewer",
    `Markdown AGENT_COMMANDS should parse to concrete roster commands, got ${JSON.stringify(markdownAgentCommands)}`,
  );
  const namedMarkdownAgentCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMANDS]",
      "- frontend(id=frontend, prompt_key=agent_frontend)",
      "  1) Build the browser artifact.",
      "  2) Wire immediate recompute.",
      "",
      "- reviewer:",
      "  - Review after frontend.",
      "",
      "- verifier:",
      "  - Verify after review.",
      "[/AGENT_COMMANDS]",
    ].join("\n"),
    legacyRegistry,
    "pm",
  );
  assert(
    namedMarkdownAgentCommands.length === 4 &&
      namedMarkdownAgentCommands[0]?.agentId === "frontend" &&
      namedMarkdownAgentCommands[0]?.command.includes("Build the browser artifact.") &&
      namedMarkdownAgentCommands[1]?.agentId === "frontend" &&
      namedMarkdownAgentCommands[1]?.command.includes("Wire immediate recompute.") &&
      namedMarkdownAgentCommands[2]?.agentId === "reviewer" &&
      namedMarkdownAgentCommands[3]?.agentId === "verifier",
    `Named markdown AGENT_COMMANDS should parse observed roster syntax, got ${JSON.stringify(namedMarkdownAgentCommands)}`,
  );
  const dashHeaderAgentCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMANDS]",
      "1) frontend — Card 3A (engine slice)",
      "- 해야 할 일",
      "  - Implement only the filter pipeline.",
      "",
      "2) reviewer — Review 3",
      "- 확인할 것",
      "  - Check hard constraints.",
      "[/AGENT_COMMANDS]",
    ].join("\n"),
    legacyRegistry,
    "pm",
  );
  assert(
    dashHeaderAgentCommands.length === 2 &&
      dashHeaderAgentCommands[0]?.agentId === "frontend" &&
      dashHeaderAgentCommands[0]?.command.includes("Card 3A") &&
      dashHeaderAgentCommands[1]?.agentId === "reviewer",
    `Dash-header AGENT_COMMANDS should parse PM re-scope card headers, got ${JSON.stringify(dashHeaderAgentCommands)}`,
  );
  const koreanAgentCommands = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMANDS]",
      '[{"AgentName":"백엔드","Commands":"로그인 API 계약을 복구하세요.","CommandSender":"리뷰어","DependsOn":["프론트"]}]',
      "[/AGENT_COMMANDS]",
    ].join("\n"),
    legacyRegistry,
    "pm",
  );
  assert(
    koreanAgentCommands.length === 1 &&
      koreanAgentCommands[0]?.agentId === "backend" &&
      koreanAgentCommands[0]?.senderId === "reviewer" &&
      JSON.stringify(koreanAgentCommands[0]?.dependsOn) === JSON.stringify(["frontend"]),
    `Korean AGENT_COMMANDS aliases should parse into canonical agent ids, got ${JSON.stringify(koreanAgentCommands)}`,
  );

  const legacyAgentCommand = SequencerParser.ParseWorkflowCommands(
    [
      "[AGENT_COMMAND]",
      '[{"AgentName":"backend","Commands":"Fix the auth endpoint contract.","CommandSender":"pm"}]',
      "[/AGENT_COMMAND]",
    ].join("\n"),
    legacyRegistry,
    "reviewer",
  );
  assert(
    legacyAgentCommand.length === 0,
    "Legacy AGENT_COMMAND output should no longer be accepted by the sequencer parser",
  );

  const desktopDefaultRoutingCalls = await runPmPlanCascadeForMetadata(
    DESKTOP_AGENTS_METADATA_JSON,
    [
      "[SEQUENCER_PLAN]",
      "1. Repair auth endpoint compatibility without changing the contract surface",
      "2. Polish the settings modal visual hierarchy and interaction copy",
      "3. Prepare the deployment rollback checklist and health checks for the desktop release",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const desktopDefaultRoles = desktopDefaultRoutingCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(desktopDefaultRoles) ===
      JSON.stringify(["developer", "designer", "devops", "reviewer", "verifier"]),
    `Desktop default roster should route backend-like work to developer, design work to designer, and rollout work to devops before quality gates, got ${JSON.stringify(desktopDefaultRoles)}`,
  );

  const desktopHotspotRoutingCalls = await runPmPlanCascadeForMetadata(
    DESKTOP_AGENTS_METADATA_JSON,
    [
      "[SEQUENCER_PLAN]",
      "1. Align apps/web/src/application/sequencer/SequencerCoordinator.ts final-step AGENT_COMMANDS handling with apps/desktop/src-tauri/src/cli.rs Codex session reuse",
      "2. Leave a short change summary for reviewer handoff",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const desktopHotspotRoles = desktopHotspotRoutingCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(desktopHotspotRoles) === JSON.stringify(["developer", "reviewer", "verifier"]),
    `Desktop hotspot routing should stay developer-owned with quality gates, got ${JSON.stringify(desktopHotspotRoles)}`,
  );

  const reviewerOnlyQualityGateCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Fix backend/src/auth.rs BYOK endpoint compatibility",
      "2. reviewer: Review the completed implementation for regressions",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const reviewerOnlyNonPmRoles = reviewerOnlyQualityGateCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(reviewerOnlyNonPmRoles) === JSON.stringify(["backend", "reviewer", "verifier"]),
    `Reviewer-only quality plans should append the missing verifier, got ${JSON.stringify(reviewerOnlyNonPmRoles)}`,
  );

  const verifierOnlyQualityGateCalls = await runPmPlanCascade(
    [
      "[SEQUENCER_PLAN]",
      "1. Fix backend/src/auth.rs BYOK endpoint compatibility",
      "2. verifier: Verify the completed implementation with targeted checks",
      "[/SEQUENCER_PLAN]",
    ].join("\n"),
    "",
  );
  const verifierOnlyNonPmRoles = verifierOnlyQualityGateCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(verifierOnlyNonPmRoles) === JSON.stringify(["backend", "reviewer", "verifier"]),
    `Verifier-only quality plans should insert the missing reviewer before verification, got ${JSON.stringify(verifierOnlyNonPmRoles)}`,
  );

  const pmQualityOnlyDelegationCalls = await runPmQualityOnlyDelegationCascade();
  const pmQualityOnlyRoles = pmQualityOnlyDelegationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(pmQualityOnlyRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Explicit PM quality-only AGENT_COMMANDS should not synthesize developer fallback, got ${JSON.stringify(pmQualityOnlyRoles)}`,
  );
  const pmPlanningDesignCalls = await runPmPlanningDesignRowsStayPmRegression();
  assert(
    pmPlanningDesignCalls.every((call) => call.role === "pm"),
    `PM planning rows that define/design/produce execution plans should stay PM-owned, got ${JSON.stringify(pmPlanningDesignCalls.map((call) => call.role))}`,
  );
  await runAgentDependencyWaitsForAllSameAgentCommandsRegression();
  await runQualityGateWaitsForPriorImplementationWithoutExplicitDependsRegression();
  await runPmRawVerifierWaitsForReviewerRegression();
  await runSameAgentSlicesSerializeByCommandRegression();
  await runInterleavedSameAgentReviewerDependencyRegression();
  await runPmConditionalReviewRepairCardIsDroppedRegression();
  await runParentQueuedWorkflowSuppressesChildDelegationRegression();
  await runPmTaskSectionFallbackPreservesSplitRegression();
  await runIncompletePmTaskSectionPlanRetriesCompactRegression();
  await runFreshWebPmFallbackSkipsDirtyAuditRegression();
  await runGeneratedArtifactWorkspaceInventoryRecoversFileEvidenceRegression();
  await runDirectIncompletePmTaskSectionRetriesCompactRegression();
  await runMultiDomainGeneratedArtifactE2ESetRegression();
  await runDirectPmLargeOutputRecoversAllTaskSectionSlicesRegression();
  await runCoreOnlyRosterBlocksImplementationQualityRegression();
  await runPmSpecificationDelegationStepStaysPmRegression();
  await runPmGeneratedArtifactFeatureSlicesRouteToImplementationRegression();
  await runPmAgentCommandsOverrideNarrativePlanRegression();
  await runPmMergedCardReferenceSplitsIntoPlanCardsRegression();
  await runPmScaffoldCommandStaysImplementationOwnedRegression();
  await runTransientPmProviderFailureDoesNotRetryPlanRegression();
  const looseReviewerVerdictCalls = await runLooseReviewerVerdictRoutesImplementationRegression();
  const looseReviewerVerdictRoles = looseReviewerVerdictCalls.map((call) => call.role);
  const looseReviewerFirstFrontendIndex = looseReviewerVerdictRoles.indexOf("frontend");
  const looseReviewerSecondReviewerIndex = looseReviewerVerdictRoles.indexOf("reviewer", 1);
  assert(
    looseReviewerFirstFrontendIndex > 0 &&
      looseReviewerSecondReviewerIndex > looseReviewerFirstFrontendIndex,
    `Loose reviewer verdict should route needs_rework to implementation before reviewer rerun, got ${JSON.stringify(looseReviewerVerdictRoles)}`,
  );
  await runImplementationEmptyStdoutChangedFilesBecomeEvidenceRegression();
  await runRepeatedImplementationNoArtifactReworkStopsRegression();
  await runPartialViteScaffoldRequiresFullScaffoldRegression();
  await runPmNoLoginFrontendOnlySupportDataRegression();
  await runPmDenseFoundationEngineCommandAutoSplitRegression();
  await runPmDenseStateRecomputeCommandAutoSplitRegression();
  await runPmCompactFoundationEngineCommandAutoSplitRegression();
  await runPmInteractionPersistenceImmediateRecomputeAutoSplitRegression();
  await runPmDenseInteractiveCommandAutoSplitRegression();
  await runPmDenseResultPolishCommandAutoSplitRegression();
  await runCascadeDependencyDeadlockFailsClosedRegression();

  const pmFallbackCalls = await runPmFallbackCascade();
  const pmFallbackRoles = pmFallbackCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(pmFallbackRoles) === JSON.stringify(["backend", "frontend", "reviewer", "verifier"]),
    `PM fallback should synthesize an implementation-owner-first DAG, got ${JSON.stringify(pmFallbackRoles)}`,
  );
  const pmFallbackQualityGuidanceCalls = await runPmFallbackPreservesQualityGuidanceCascade();
  const pmFallbackImplementationCall = pmFallbackQualityGuidanceCalls.find((call) => call.role === "frontend");
  const pmFallbackReviewerCall = pmFallbackQualityGuidanceCalls.find((call) => call.role === "reviewer");
  const pmFallbackVerifierCall = pmFallbackQualityGuidanceCalls.find((call) => call.role === "verifier");
  assert(
    pmFallbackImplementationCall?.instruction.includes("Implementation requirement guardrails") &&
      pmFallbackImplementationCall.instruction.includes("지역과 날짜와 인원을 입력받아야 해") &&
      pmFallbackImplementationCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼") &&
      pmFallbackImplementationCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘"),
    `PM fallback implementation handoff should preserve full requirements, got ${JSON.stringify(pmFallbackImplementationCall?.instruction ?? "")}`,
  );
  assert(
    pmFallbackReviewerCall?.instruction.includes("Original user requirement checklist to preserve:") &&
      pmFallbackReviewerCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼") &&
      pmFallbackReviewerCall.instruction.includes("지역과 날짜와 인원을 입력받아야 해") &&
      pmFallbackReviewerCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘") &&
      pmFallbackReviewerCall.instruction.includes("[ReviewVerdict] must be needs_rework"),
    `PM fallback reviewer should preserve quality guidance, got ${JSON.stringify(pmFallbackReviewerCall?.instruction ?? "")}`,
  );
  assert(
    pmFallbackVerifierCall?.instruction.includes("Domain-neutral quality invariants to prove:") &&
      pmFallbackVerifierCall.instruction.includes("negative/adversarial scenario") &&
      pmFallbackVerifierCall.instruction.includes("[VerificationStatus] must be fail or blocked"),
    `PM fallback verifier should preserve quality guidance, got ${JSON.stringify(pmFallbackVerifierCall?.instruction ?? "")}`,
  );
  const pmSummaryNoFallbackCalls = await runPmFinalImplementationSummaryDoesNotOverFallbackCascade();
  assert(
    JSON.stringify(pmSummaryNoFallbackCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm"]),
    `Korean implementation summaries should not synthesize fallback handoffs, got ${JSON.stringify(pmSummaryNoFallbackCalls.map((call) => call.role))}`,
  );

  await runHostFeedbackStdoutIsolationRegression();
  await runHostFeedbackMixedSignalRegression();
  await runVerifierHostFeedbackRejectsMutatingFollowupRegression();
  await runHostFeedbackFollowupHappyPathRegression();
  await runHostFeedbackStdoutCommandsIgnoreCliWarningStderrRegression();
  await runHostFeedbackZeroExitSmokeIgnoresBenignBuildCanceledStderrRegression();
  await runHostFeedbackQualityGateRunsAllVerificationCommandsRegression();
  await runHostFeedbackQualityGateRunsCdPrefixedVerificationCommandsRegression();
  await runHostFeedbackDependencyInstallThenBuildRegression();
  await runHostFeedbackRuntimeAndTypeInstallThenBuildRegression();
  await runHostFeedbackIgnoresCompactionMarkerCommandRegression();
  await runHostFeedbackRejectsMetaFollowupRegression();
  await runHostFeedbackRejectsInitialMetaCommandRegression();
  await runHostFeedbackRejectsStandalonePreviewServerRegression();
  await runHostFeedbackSetupWrappedVerificationSupersedesOriginalRegression();
  await runHostFeedbackNpmMissingBinarySetupWrapRegression();
  await runHostFeedbackNpmExit127WithoutStderrSetupWrapRegression();
  await runHostFeedbackNpmMissingTscWithoutScriptHeaderRegression();
  await runHostFeedbackQualityReadThenPackageBuildRegression();
  await runHostFeedbackPackageInstallSuccessIgnoresMalformedOkRegression();
  await runHostFeedbackPackageInstallAuditWarningBlocksRegression();
  await runHostFeedbackRejectsMutatingRepairFollowupRegression();
  await runHostFeedbackUnrelatedVerificationCannotBypassFailedCommandRegression();
  await runHostFeedbackSuccessfulDuplicateRegression();
  await runHostFeedbackSuccessfulDuplicateIgnoresRunCapRegression();
  await runHostFeedbackDuplicateAfterMutationRegression();
  await runHostFeedbackPackageManagerBuildMutationRegression();
  await runHostFeedbackReadOnlyPrefixWriteRedirectionRegression();
  await runHostFeedbackSuccessfulCommandWithFollowupCachesOriginalRegression();
  await runHostFeedbackReadOnlyControlNoopDoesNotMutateRegression();
  await runHostFeedbackMutatingVerificationFlagRegression();
  await runHostFeedbackMutationFollowupRechecksOriginalRegression();
  await runReviewerVerifierSequencerPromptEnvelopeRegression();
  await runQualityGateRequirementChecklistRegression();
  await runComplexCrossDomainPromptQualityGuidanceRegression();
  await runLargeStepOutputCompactsDownstreamMemoryRegression();
  await runHostFeedbackNoExplorationLoopRegression();
  await runDirectHostFeedbackBlockedCascade();
  await runBundleHostFeedbackBlockedCascade();
  await runDirectPmHostFeedbackFailurePropagationRegression();
  await runBundlePmHostFeedbackFailurePropagationRegression();
  await runHostFeedbackContextInsensitiveAbortRegression();
  await runHostFeedbackMalformedFollowupRegression();
  await runHostFeedbackFailedVerificationCannotReplyOkRegression();
  await runImplementationReadOnlyHostInspectionIgnoredRegression();
  await runPromptingSequencerRuleReadOnlyInspectionAlignmentRegression();
  await runHostFeedbackSessionIsolationRegression();
  await runVerifierHostFeedbackPassClearsStaleRisksRegression();
  await runImplementationHostFeedbackAllSuccessClearsBlockedEvidenceRegression();
  await runImplementationHostFeedbackMissingRequestedCommandBlocksRegression();
  await runBoundedVerifierHostPassDoesNotDemandFinalSmokeRegression();
  await runBoundedVerifierClosedTargetDoesNotReopenFutureWorkRegression();
  await runReviewerTopNDataShortageRoutesImplementationRegression();
  await runVerifierPassIgnoresEmbeddedReviewerBlocksRegression();
  await runImplementationPromptForbidsSourceWritingHostCommandsRegression();
  await runImplementationSenderFollowupSuppressionRegression();
  const reviewerSenderSuppressionCalls =
    await runQualityGateImplementationSenderFollowupSuppressionRegression("reviewer");
  assert(
    JSON.stringify(reviewerSenderSuppressionCalls.map((call) => call.role)) === JSON.stringify(["reviewer"]),
    `Reviewer ready completion should not bounce back to frontend, got ${JSON.stringify(reviewerSenderSuppressionCalls.map((call) => call.role))}`,
  );
  const verifierSenderSuppressionCalls =
    await runQualityGateImplementationSenderFollowupSuppressionRegression("verifier");
  assert(
    JSON.stringify(verifierSenderSuppressionCalls.map((call) => call.role)) === JSON.stringify(["verifier"]),
    `Verifier pass completion should not bounce back to frontend, got ${JSON.stringify(verifierSenderSuppressionCalls.map((call) => call.role))}`,
  );
  await runPartialArtifactTimeoutQualityHandoffRegression();
  await runWorkspaceMarkerPartialArtifactTimeoutRegression();
  await runWorkspaceMarkerPartialArtifactTimeoutScopeFilterRegression();
  await runPartialArtifactRepairUsesOriginalAssignmentRegression();
  await runImplementationTimeoutWithoutArtifactRoutesRepairRegression();
  const emptyProviderWebScaffoldCalls =
    await runWebScaffoldEmptyProviderOutputRoutesExactRepairRegression();
  assert(
    JSON.stringify(emptyProviderWebScaffoldCalls.map((call) => call.role)) ===
      JSON.stringify(["frontend", "frontend", "reviewer", "verifier"]),
    `Empty provider output on web scaffold should repair with same implementation owner before quality gates, got ${JSON.stringify(emptyProviderWebScaffoldCalls.map((call) => call.role))}`,
  );
  assert(
    emptyProviderWebScaffoldCalls[1]?.instruction.includes("missing runnable scaffold files: package.json | tsconfig.json | vite.config | index.html | src/main | src/App") &&
      emptyProviderWebScaffoldCalls[1]?.instruction.includes("provider_output=empty_or_non_substantive"),
    `Empty provider scaffold repair should name the exact scaffold contract and provider-output issue, got ${JSON.stringify(emptyProviderWebScaffoldCalls[1]?.instruction ?? "")}`,
  );
  await runReviewerReadyNonBlockingFindingDoesNotRepairRegression();
  await runReviewerReadyIgnoresHistoricalTranscriptVerdictRegression();
  await runBoundedSliceTimeoutRoutesPmRescopeRegression();
  await runTopLevelImplementationTimeoutRoutesPmRescopeRegression();
  await runPmAssignedSliceTimeoutRoutesPmRescopeRegression();
  await runBoundedPartialArtifactTimeoutReviewReworkRoutesPmRescopeRegression();
  await runHostFailureRepairPreservesRootErrorRegression();
  await runHostFailureRepairPreservesSmokeAssertionRegression();
  await runStepHostCommandStderrPromptIsolationRegression();
  await runStepHostCommandPrimaryResultIsolationRegression();
  const qualityOnlyNestedCalls = await runReviewerQualityOnlyNestedSuppressionCascade();
  const qualityOnlyNestedRoles = qualityOnlyNestedCalls.map((call) => call.role);
  assert(
    JSON.stringify(qualityOnlyNestedRoles) ===
      JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Quality-only nested loops should be suppressed in favor of repair routing, got ${JSON.stringify(qualityOnlyNestedRoles)}`,
  );
  const directBlockedImplementationCalls = await runDirectBlockedImplementationDropsNestedVerifierCascade();
  const directBlockedImplementationRoles = directBlockedImplementationCalls.map((call) => call.role);
  assert(
    JSON.stringify(directBlockedImplementationRoles) ===
      JSON.stringify(["developer", "developer", "reviewer", "verifier"]),
    `Blocked direct implementation must discard stale nested verifier handoff until after repair, got ${JSON.stringify(directBlockedImplementationRoles)}`,
  );
  assert(
    directBlockedImplementationCalls[1]?.instruction.includes("Bounded repair slice for this cycle"),
    `Blocked direct implementation repair should use a bounded repair slice, got ${JSON.stringify(directBlockedImplementationCalls[1]?.instruction ?? "")}`,
  );
  const bundleBlockedImplementationCalls = await runBundleBlockedImplementationDropsNestedVerifierCascade();
  const bundleBlockedImplementationRoles = bundleBlockedImplementationCalls
    .map((call) => call.role)
    .filter((role) => role !== "pm");
  assert(
    JSON.stringify(bundleBlockedImplementationRoles) ===
      JSON.stringify(["developer", "developer", "reviewer", "verifier"]),
    `Blocked bundle implementation must discard stale nested verifier handoff until after repair, got ${JSON.stringify(bundleBlockedImplementationRoles)}`,
  );
  const bundleRepairCall = bundleBlockedImplementationCalls.filter((call) => call.role === "developer")[1];
  assert(
    bundleRepairCall?.instruction.includes("Bounded repair slice for this cycle"),
    `Blocked bundle implementation repair should use a bounded repair slice, got ${JSON.stringify(bundleRepairCall?.instruction ?? "")}`,
  );
  const circularFallbackCalls = await runBundleCircularDependencyFailsClosedCascade();
  const circularFallbackRoles = circularFallbackCalls.map((call) => call.role);
  assert(
    JSON.stringify(circularFallbackRoles) === JSON.stringify(["pm", "pm"]),
    `Circular bundle DAG should fail closed instead of running arbitrary fallback agents, got ${JSON.stringify(circularFallbackRoles)}`,
  );
  const reviewOnlyNoRepairCalls = await runReviewOnlyNeedsReworkDoesNotAutoRepairCascade();
  const reviewOnlyNoRepairRoles = reviewOnlyNoRepairCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewOnlyNoRepairRoles) === JSON.stringify(["reviewer"]),
    `Review-only quality gates should report needs_rework without auto-repair, got ${JSON.stringify(reviewOnlyNoRepairRoles)}`,
  );
  const productNoModifyCalls = await runProductNoModifyRequirementStillAutoRepairsCascade();
  const productNoModifyRoles = productNoModifyCalls.map((call) => call.role);
  assert(
    JSON.stringify(productNoModifyRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Product no-modify requirements should not suppress auto-repair, got ${JSON.stringify(productNoModifyRoles)}`,
  );
  assert(
    productNoModifyCalls[1]?.instruction.includes("Bounded repair slice for this cycle") &&
      productNoModifyCalls[1]?.instruction.includes("reservation edit lock is missing"),
    `Product no-modify repair should carry the concrete review finding, got ${JSON.stringify(productNoModifyCalls[1]?.instruction ?? "")}`,
  );
  const boundedRepairCalls = await runLargeQualityReworkUsesBoundedRepairSliceCascade();
  const boundedRepairImplementationCall = boundedRepairCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  assert(
    boundedRepairImplementationCall?.instruction.includes("Bounded repair slice for this cycle") &&
      boundedRepairImplementationCall.instruction.includes("first bounded blocker") &&
      boundedRepairImplementationCall.instruction.includes("second bounded blocker") &&
      boundedRepairImplementationCall.instruction.includes("Deferred quality failures not in this repair slice: 2") &&
      !boundedRepairImplementationCall.instruction.includes("third deferred blocker") &&
      !boundedRepairImplementationCall.instruction.includes("fourth deferred blocker"),
    `Large quality failures should be sliced before implementation, roles=${JSON.stringify(boundedRepairCalls.map((call) => call.role))}, got ${JSON.stringify(boundedRepairImplementationCall?.instruction ?? "")}`,
  );
  const boundedRepairReviewerCalls = boundedRepairCalls.filter((call) => call.role === "reviewer");
  const boundedRepairVerifierCalls = boundedRepairCalls.filter((call) => call.role === "verifier");
  const boundedRepairReviewerCall = boundedRepairReviewerCalls[boundedRepairReviewerCalls.length - 1];
  const boundedRepairVerifierCall = boundedRepairVerifierCalls[boundedRepairVerifierCalls.length - 1];
  assert(
    boundedRepairReviewerCall?.instruction.includes("Review the bounded repair slice") &&
      boundedRepairReviewerCall.instruction.includes("Bounded repair slice under review") &&
      boundedRepairReviewerCall.instruction.includes("first bounded blocker") &&
      !boundedRepairReviewerCall.instruction.includes("third deferred blocker"),
    `Reviewer follow-up should surface the bounded slice, got ${JSON.stringify(boundedRepairReviewerCall?.instruction ?? "")}`,
  );
  assert(
    boundedRepairVerifierCall?.instruction.includes("Verify the bounded repair slice") &&
      boundedRepairVerifierCall.instruction.includes("Bounded repair slice under verification") &&
      boundedRepairVerifierCall.instruction.includes("second bounded blocker") &&
      !boundedRepairVerifierCall.instruction.includes("fourth deferred blocker"),
    `Verifier follow-up should surface the bounded slice, got ${JSON.stringify(boundedRepairVerifierCall?.instruction ?? "")}`,
  );
  const mixedReviewerRepairCalls = await runMixedReviewerFindingsPrioritizeActualDefectRegression();
  const mixedReviewerImplementationCall = mixedReviewerRepairCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  assert(
    mixedReviewerImplementationCall?.instruction.includes("Bounded repair slice for this cycle") &&
      mixedReviewerImplementationCall.instruction.includes("Top Pick") &&
      mixedReviewerImplementationCall.instruction.includes("서로 달라질 수 있습니다") &&
      !mixedReviewerImplementationCall.instruction.includes("하드 제외가 soft 점수보다 먼저 먹는 흐름은 맞습니다") &&
      !mixedReviewerImplementationCall.instruction.includes("검색 필터와 top 10 자르기도 기본 흐름은 맞습니다"),
    `Mixed reviewer findings should prioritize the actual defect instead of affirmative checks, got ${JSON.stringify(mixedReviewerImplementationCall?.instruction ?? "")}`,
  );
  const readyNegatedDefectCalls = await runReviewerReadyNegatedDefectPhraseDoesNotAutoRepairRegression();
  assert(
    JSON.stringify(readyNegatedDefectCalls.map((call) => call.role)) === JSON.stringify(["reviewer"]),
    `Reviewer ready lines that mention blocked or non-visible regressions should not auto-repair, got ${JSON.stringify(readyNegatedDefectCalls)}`,
  );
  const fullContextRepairCalls = await runQualityReworkPreservesFullRequirementContextCascade();
  const fullContextRoles = fullContextRepairCalls.map((call) => call.role);
  const fullContextImplementationCall = fullContextRepairCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  const fullContextReviewerCalls = fullContextRepairCalls.filter((call) => call.role === "reviewer");
  const fullContextReviewerCall = fullContextReviewerCalls[fullContextReviewerCalls.length - 1];
  const fullContextVerifierCall = fullContextRepairCalls.find((call) => call.role === "verifier");
  assert(
    JSON.stringify(fullContextRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Full-context repair should route implementation before quality follow-up, got ${JSON.stringify(fullContextRoles)}`,
  );
  assert(
    fullContextImplementationCall?.instruction.includes("Implementation requirement guardrails") &&
      fullContextImplementationCall.instruction.includes("지역과 날짜와 인원을 입력받아야 해") &&
      fullContextImplementationCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼") &&
      fullContextImplementationCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘"),
    `Quality repair implementation should preserve full original requirements, got ${JSON.stringify(fullContextImplementationCall?.instruction ?? "")}`,
  );
  assert(
    fullContextReviewerCall?.instruction.includes("Original user requirement checklist to preserve:") &&
      fullContextReviewerCall.instruction.includes("지역과 날짜와 인원을 입력받아야 해") &&
      fullContextReviewerCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼") &&
      fullContextReviewerCall.instruction.includes("이유는 현재 입력과 맞을 때만 보여줘"),
    `Quality repair reviewer should preserve full original requirements, got ${JSON.stringify(fullContextReviewerCall?.instruction ?? "")}`,
  );
  assert(
    fullContextVerifierCall?.instruction.includes("Domain-neutral quality invariants to prove:") &&
      fullContextVerifierCall.instruction.includes("negative/adversarial scenario") &&
      fullContextVerifierCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼"),
    `Quality repair verifier should preserve full original requirements, got ${JSON.stringify(fullContextVerifierCall?.instruction ?? "")}`,
  );
  const originAssignmentRepairCalls = await runQualityRepairUsesOriginAssignmentContextRegression();
  const originAssignmentImplementationCall = originAssignmentRepairCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  assert(
    originAssignmentImplementationCall?.instruction.includes("Quality gate feedback requires another repair cycle for this assignment: 예약 추천 웹사이트를 만들어줘.") &&
      originAssignmentImplementationCall.instruction.includes("이미 예약된 시간은 추천하면 안 돼.") &&
      !originAssignmentImplementationCall.instruction.includes("REVIEWER_TASK 수행:"),
    `Quality repair should prefer the original assignment context over wrapper review-task text, got ${JSON.stringify(originAssignmentImplementationCall?.instruction ?? "")}`,
  );
  const reviewerMissingVerdictCalls = await runReviewerMissingVerdictRerunsReviewerRegression();
  const reviewerMissingVerdictRoles = reviewerMissingVerdictCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerMissingVerdictRoles) === JSON.stringify(["reviewer", "reviewer"]),
    `Reviewer output without ReviewVerdict should rerun reviewer only, got ${JSON.stringify(reviewerMissingVerdictRoles)}`,
  );
  const reviewerOpenRiskCalls = await runReviewerReadyWithOpenRisksTriggersReworkRegression();
  const reviewerOpenRiskRoles = reviewerOpenRiskCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerOpenRiskRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Reviewer ready+open-risks output should be downgraded into repair routing, got ${JSON.stringify(reviewerOpenRiskRoles)}`,
  );
  const reviewerConcreteFindingCalls = await runReviewerReadyWithConcreteFindingsTriggersReworkRegression();
  const reviewerConcreteFindingRoles = reviewerConcreteFindingCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerConcreteFindingRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Reviewer ready+concrete-findings output should be downgraded into repair routing, got ${JSON.stringify(reviewerConcreteFindingRoles)}`,
  );
  assert(
    reviewerConcreteFindingCalls[1]?.instruction.includes("can still recommend already reserved slots"),
    `Reviewer concrete finding should be preserved in the implementation repair command, got ${JSON.stringify(reviewerConcreteFindingCalls[1]?.instruction ?? "")}`,
  );
  const verifierPassConflictCalls = await runVerifierPassWithFailureEvidenceTriggersReworkRegression();
  const verifierPassConflictRoles = verifierPassConflictCalls.map((call) => call.role);
  assert(
    verifierPassConflictRoles[0] === "verifier" &&
      verifierPassConflictRoles.includes("reviewer") &&
      verifierPassConflictRoles.filter((role) => role === "verifier").length === 2 &&
      verifierPassConflictRoles.some((role) => role !== "verifier" && role !== "reviewer"),
    `Verifier pass with failure evidence should be downgraded into repair routing, got ${JSON.stringify(verifierPassConflictRoles)}`,
  );
  const verifierPassConflictRepairCall = verifierPassConflictCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  assert(
    verifierPassConflictRepairCall?.instruction.includes("Contradictory pass evidence") &&
      verifierPassConflictRepairCall.instruction.includes("Happy path has only tiny fixture coverage"),
    `Verifier pass conflict repair should carry the contradictory evidence, got ${JSON.stringify(verifierPassConflictRepairCall?.instruction ?? "")}`,
  );
  const verifierConcreteMismatchCalls =
    await runVerifierConcreteRequirementMismatchRoutesImplementationRegression();
  const verifierConcreteMismatchRoles = verifierConcreteMismatchCalls.map((call) => call.role);
  assert(
    verifierConcreteMismatchRoles[0] === "verifier" &&
      verifierConcreteMismatchRoles.includes("reviewer") &&
      verifierConcreteMismatchRoles.filter((role) => role === "verifier").length === 2 &&
      verifierConcreteMismatchRoles.some((role) => role !== "reviewer" && role !== "verifier"),
    `Concrete verifier requirement mismatches should route implementation repair before re-verification, got ${JSON.stringify(verifierConcreteMismatchRoles)}`,
  );
  const verifierConcreteMismatchRepairCall = verifierConcreteMismatchCalls.find(
    (call) => call.role !== "reviewer" && call.role !== "verifier",
  );
  assert(
    verifierConcreteMismatchRepairCall?.instruction.includes("필터 8종") &&
      verifierConcreteMismatchRepairCall.instruction.includes("실제 실행 증거가 아직 없다"),
    `Concrete verifier mismatch repair should preserve the failed requirement and evidence, got ${JSON.stringify(verifierConcreteMismatchRepairCall?.instruction ?? "")}`,
  );
  const verifierEvidenceGapCalls = await runVerifierPassWithEvidenceGapReroutesVerifierRegression();
  const verifierEvidenceGapRoles = verifierEvidenceGapCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierEvidenceGapRoles) === JSON.stringify(["verifier", "verifier"]),
    `Verifier evidence gaps should reroute to verifier-only follow-up instead of artifact repair, got ${JSON.stringify(verifierEvidenceGapRoles)}`,
  );
  assert(
    verifierEvidenceGapCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Verifier evidence-gap follow-up should forbid artifact edits, got ${JSON.stringify(verifierEvidenceGapCalls[1]?.instruction ?? "")}`,
  );
  assert(
    verifierEvidenceGapCalls[1]?.instruction.includes("Original user requirement checklist to preserve:") &&
      verifierEvidenceGapCalls[1].instruction.includes("사용자가 지역과 날짜를 입력해야 합니다") &&
      verifierEvidenceGapCalls[1].instruction.includes("이미 예약된 시간은 추천하면 안 됩니다") &&
      verifierEvidenceGapCalls[1].instruction.includes("이유는 현재 입력과 맞을 때만 보여줘야 합니다"),
    `Verifier evidence-gap follow-up should preserve full original requirements, got ${JSON.stringify(verifierEvidenceGapCalls[1]?.instruction ?? "")}`,
  );
  const verifierGenericPassCalls = await runVerifierGenericPassForArtifactReroutesVerifierRegression();
  const verifierGenericPassRoles = verifierGenericPassCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierGenericPassRoles) === JSON.stringify(["verifier", "verifier"]),
    `Generic verifier pass should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierGenericPassRoles)}`,
  );
  assert(
    verifierGenericPassCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierGenericPassCalls[1]?.instruction.includes("Do not modify generated artifacts or source files") &&
      !verifierGenericPassCalls[1]?.instruction.includes("작업 완료"),
    `Generic verifier pass follow-up should require evidence only without echoing empty pass text, got ${JSON.stringify(verifierGenericPassCalls[1]?.instruction ?? "")}`,
  );
  const developerBlockedPreviewCalls = await runDeveloperBlockedPreviewHostCommandReroutesVerifierRegression();
  const developerBlockedPreviewRoles = developerBlockedPreviewCalls.map((call) => call.role);
  assert(
    JSON.stringify(developerBlockedPreviewRoles) === JSON.stringify(["frontend", "verifier"]),
    `Blocked standalone preview host commands should reroute to verifier-only follow-up, got ${JSON.stringify(developerBlockedPreviewRoles)}`,
  );
  const verifierBlockedPreviewCalls = await runVerifierBlockedPreviewHostCommandReroutesVerifierRegression();
  const verifierBlockedPreviewRoles = verifierBlockedPreviewCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierBlockedPreviewRoles) === JSON.stringify(["verifier", "verifier"]),
    `Blocked verifier preview host commands should reroute to verifier-only follow-up, got ${JSON.stringify(verifierBlockedPreviewRoles)}`,
  );
  assert(
    verifierBlockedPreviewCalls[1]?.instruction.includes("Do not modify generated artifacts or source files") &&
      verifierBlockedPreviewCalls[1]?.instruction.includes("existing scripts, package commands, or existing test files only"),
    `Blocked verifier preview follow-up should stay in verifier-only evidence mode, got ${JSON.stringify(verifierBlockedPreviewCalls[1]?.instruction ?? "")}`,
  );
  const verifierApiOnlyPassCalls = await runVerifierApiOnlyPassForWebArtifactReroutesVerifierRegression();
  const verifierApiOnlyPassRoles = verifierApiOnlyPassCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierApiOnlyPassRoles) === JSON.stringify(["verifier", "verifier"]),
    `API-only web verifier pass should reroute to verifier-only interactive evidence follow-up, got ${JSON.stringify(verifierApiOnlyPassRoles)}`,
  );
  assert(
    verifierApiOnlyPassCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierApiOnlyPassCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `API-only web verifier follow-up should require decision-flow evidence, got ${JSON.stringify(verifierApiOnlyPassCalls[1]?.instruction ?? "")}`,
  );
  const verifierInteractiveNeedCalls =
    await runVerifierInteractiveNeedWithoutEvidenceReroutesVerifierRegression();
  const verifierInteractiveNeedRoles = verifierInteractiveNeedCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierInteractiveNeedRoles) === JSON.stringify(["verifier", "verifier"]),
    `Interactive-evidence-needed wording should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierInteractiveNeedRoles)}`,
  );
  assert(
    verifierInteractiveNeedCalls[1]?.instruction.includes("missing concrete user-facing evidence") &&
      verifierInteractiveNeedCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Interactive-evidence-needed follow-up should require real user-facing evidence, got ${JSON.stringify(verifierInteractiveNeedCalls[1]?.instruction ?? "")}`,
  );
  const koreanVerifierInteractiveNeedCalls =
    await runKoreanVerifierInteractiveNeedWithoutEvidenceReroutesVerifierRegression();
  const koreanVerifierInteractiveNeedRoles = koreanVerifierInteractiveNeedCalls.map((call) => call.role);
  assert(
    JSON.stringify(koreanVerifierInteractiveNeedRoles) === JSON.stringify(["verifier", "verifier"]),
    `Korean interactive-evidence-needed wording should reroute to verifier-only evidence follow-up, got ${JSON.stringify(koreanVerifierInteractiveNeedRoles)}`,
  );
  assert(
    koreanVerifierInteractiveNeedCalls[1]?.instruction.includes("missing concrete user-facing evidence") &&
      koreanVerifierInteractiveNeedCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Korean interactive-evidence-needed follow-up should require real user-facing evidence, got ${JSON.stringify(koreanVerifierInteractiveNeedCalls[1]?.instruction ?? "")}`,
  );
  const verifierBrowserOnlyDecisionCalls =
    await runVerifierBrowserOnlyDecisionFlowReroutesVerifierRegression();
  const verifierBrowserOnlyDecisionRoles = verifierBrowserOnlyDecisionCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierBrowserOnlyDecisionRoles) === JSON.stringify(["verifier", "verifier"]),
    `Browser-only decision-flow verifier pass should reroute to verifier-only negative evidence follow-up, got ${JSON.stringify(verifierBrowserOnlyDecisionRoles)}`,
  );
  assert(
    verifierBrowserOnlyDecisionCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierBrowserOnlyDecisionCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Browser-only decision-flow verifier follow-up should require negative/adversarial evidence, got ${JSON.stringify(verifierBrowserOnlyDecisionCalls[1]?.instruction ?? "")}`,
  );
  const verifierNegativeNeedCalls =
    await runVerifierNegativeNeedWithoutEvidenceReroutesVerifierRegression();
  const verifierNegativeNeedRoles = verifierNegativeNeedCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierNegativeNeedRoles) === JSON.stringify(["verifier", "verifier"]),
    `Negative-evidence-needed wording should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierNegativeNeedRoles)}`,
  );
  assert(
    verifierNegativeNeedCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierNegativeNeedCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Negative-evidence-needed follow-up should require real decision-flow evidence, got ${JSON.stringify(verifierNegativeNeedCalls[1]?.instruction ?? "")}`,
  );
  const koreanVerifierNegativeNeedCalls =
    await runKoreanVerifierNegativeNeedWithoutEvidenceReroutesVerifierRegression();
  const koreanVerifierNegativeNeedRoles = koreanVerifierNegativeNeedCalls.map((call) => call.role);
  assert(
    JSON.stringify(koreanVerifierNegativeNeedRoles) === JSON.stringify(["verifier", "verifier"]),
    `Korean negative-evidence-needed wording should reroute to verifier-only evidence follow-up, got ${JSON.stringify(koreanVerifierNegativeNeedRoles)}`,
  );
  assert(
    koreanVerifierNegativeNeedCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      koreanVerifierNegativeNeedCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Korean negative-evidence-needed follow-up should require real decision-flow evidence, got ${JSON.stringify(koreanVerifierNegativeNeedCalls[1]?.instruction ?? "")}`,
  );
  const repeatedVerifierEvidenceGapRun = await runRepeatedVerifierEvidenceGapFailsClosedRegression();
  const repeatedVerifierEvidenceGapRoles = repeatedVerifierEvidenceGapRun.calls.map((call) => call.role);
  assert(
    repeatedVerifierEvidenceGapRun.ok === false &&
      JSON.stringify(repeatedVerifierEvidenceGapRoles) === JSON.stringify(["verifier", "verifier"]),
    `Repeated verifier evidence gaps should fail closed after one evidence-only retry, got ok=${String(repeatedVerifierEvidenceGapRun.ok)} roles=${JSON.stringify(repeatedVerifierEvidenceGapRoles)}`,
  );
  const repeatedSameQualityFailureRun = await runRepeatedSameQualityFailureFailsClosedRegression();
  const repeatedSameQualityFailureRoles = repeatedSameQualityFailureRun.calls.map((call) => call.role);
  assert(
    repeatedSameQualityFailureRun.ok === false &&
      JSON.stringify(repeatedSameQualityFailureRoles) === JSON.stringify(["reviewer"]) &&
      repeatedSameQualityFailureRun.messages.some((message) => message.includes("같은 품질 실패가 반복")),
    `Repeated same quality failure should fail closed instead of issuing the same repair card again, got ok=${String(repeatedSameQualityFailureRun.ok)} roles=${JSON.stringify(repeatedSameQualityFailureRoles)} messages=${JSON.stringify(repeatedSameQualityFailureRun.messages)}`,
  );
  const changedHostFailureCalls = await runChangedHostFailureDoesNotTripRepeatedQualityRegression();
  assert(
    JSON.stringify(changedHostFailureCalls.map((call) => call.role)) === JSON.stringify(["backend", "frontend", "reviewer", "verifier"]),
    `Changed host failure should route one more bounded implementation repair, got ${JSON.stringify(changedHostFailureCalls.map((call) => call.role))}`,
  );
  await runVerifierFreshHostPassClearsStaleOpenRisksRegression();
  await runReviewerReadyAcceptableFindingsDoNotReopenRepairRegression();
  await runVerifierPassWithExplicitNoOpenRisksRegression();
  await runVerifierShortSmokeHostPassPreservesCoverageRegression();
  await runVerifierUserFlowSmokePassClosesInventoryDecisionEvidenceRegression();
  const verifierFileOnlyPassCalls = await runVerifierFileOnlyPassForUserFacingArtifactReroutesVerifierRegression();
  const verifierFileOnlyPassRoles = verifierFileOnlyPassCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierFileOnlyPassRoles) === JSON.stringify(["verifier", "verifier"]),
    `File-only verifier pass should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierFileOnlyPassRoles)}`,
  );
  assert(
    verifierFileOnlyPassCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierFileOnlyPassCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `File-only verifier pass follow-up should require user-flow evidence only, got ${JSON.stringify(verifierFileOnlyPassCalls[1]?.instruction ?? "")}`,
  );
  const verifierFileHostPassCalls =
    await runVerifierFileExistenceHostPassForUserFacingArtifactReroutesVerifierRegression();
  const verifierFileHostPassRoles = verifierFileHostPassCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierFileHostPassRoles) === JSON.stringify(["verifier", "verifier"]),
    `File-existence host pass should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierFileHostPassRoles)}`,
  );
  assert(
    verifierFileHostPassCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierFileHostPassCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `File-existence host pass follow-up should require user-flow evidence only, got ${JSON.stringify(verifierFileHostPassCalls[1]?.instruction ?? "")}`,
  );
  const verifierBuildOnlyPassCalls =
    await runVerifierBuildOnlyHostPassForUserFacingArtifactReroutesVerifierRegression();
  const verifierBuildOnlyPassRoles = verifierBuildOnlyPassCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierBuildOnlyPassRoles) === JSON.stringify(["verifier", "verifier"]),
    `Build-only host pass should reroute to verifier-only evidence follow-up, got ${JSON.stringify(verifierBuildOnlyPassRoles)}`,
  );
  assert(
    verifierBuildOnlyPassCalls[1]?.instruction.includes("missing negative/adversarial decision-flow evidence") &&
      verifierBuildOnlyPassCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Build-only host pass follow-up should require user-flow evidence only, got ${JSON.stringify(verifierBuildOnlyPassCalls[1]?.instruction ?? "")}`,
  );
  const verifierInsufficientSmokeCalls =
    await runVerifierInsufficientSmokeHostPassRoutesImplementationRegression();
  const verifierInsufficientSmokeRoles = verifierInsufficientSmokeCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierInsufficientSmokeRoles) === JSON.stringify(["verifier", "ui_builder", "reviewer", "verifier"]),
    `Insufficient generated smoke pass should route implementation smoke-support repair, got ${JSON.stringify(verifierInsufficientSmokeRoles)}`,
  );
  assert(
    verifierInsufficientSmokeCalls[1]?.instruction.includes("existing generated web smoke lacks rendered DOM/user-flow/localStorage evidence") &&
      verifierInsufficientSmokeCalls[1]?.instruction.includes("Add only the smallest artifact-local smoke/test support"),
    `Insufficient smoke repair should be narrow and artifact-local, got ${JSON.stringify(verifierInsufficientSmokeCalls[1]?.instruction ?? "")}`,
  );
  const verifierMissingFeatureEvidenceCalls =
    await runVerifierPassMissingExplicitFeatureEvidenceRoutesImplementationRegression();
  const verifierMissingFeatureEvidenceRoles = verifierMissingFeatureEvidenceCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierMissingFeatureEvidenceRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Missing explicit feature evidence should route one implementation repair, got ${JSON.stringify(verifierMissingFeatureEvidenceRoles)}`,
  );
  assert(
    verifierMissingFeatureEvidenceCalls[1]?.instruction.includes("missing requested feature evidence") &&
      verifierMissingFeatureEvidenceCalls[1]?.instruction.includes("filter flow"),
    `Missing explicit feature repair should name the uncovered feature, got ${JSON.stringify(verifierMissingFeatureEvidenceCalls[1]?.instruction ?? "")}`,
  );
  const verifierMissingViewportEvidenceCalls =
    await runVerifierPassMissingViewportActionEvidenceRoutesImplementationRegression();
  const verifierMissingViewportEvidenceRoles = verifierMissingViewportEvidenceCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierMissingViewportEvidenceRoles.slice(0, 2)) === JSON.stringify(["verifier", "frontend"]),
    `Missing viewport/action evidence should route an implementation repair before pass, got ${JSON.stringify(verifierMissingViewportEvidenceRoles)}`,
  );
  assert(
    verifierMissingViewportEvidenceCalls[1]?.instruction.includes("missing requested feature evidence") &&
      verifierMissingViewportEvidenceCalls[1]?.instruction.includes("viewport overflow/action visibility flow"),
    `Missing viewport/action repair should name the uncovered layout evidence, got ${JSON.stringify(verifierMissingViewportEvidenceCalls[1]?.instruction ?? "")}`,
  );
  const verifierMissingScriptCalls = await runVerifierBlockedMissingScriptReroutesVerifierRegression();
  const verifierMissingScriptRoles = verifierMissingScriptCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierMissingScriptRoles) === JSON.stringify(["verifier", "verifier"]),
    `Verifier missing-script blocks should reroute to verifier-only follow-up instead of artifact repair, got ${JSON.stringify(verifierMissingScriptRoles)}`,
  );
  const verifierMissingWebSmokeCalls =
    await runVerifierMissingWebSmokeSupportRoutesImplementationRegression();
  const verifierMissingWebSmokeRoles = verifierMissingWebSmokeCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierMissingWebSmokeRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Missing generated web smoke support should route one narrow implementation repair, got ${JSON.stringify(verifierMissingWebSmokeRoles)}`,
  );
  assert(
    verifierMissingWebSmokeCalls[1]?.instruction.includes("missing generated web user-flow smoke script or test file") &&
      verifierMissingWebSmokeCalls[1]?.instruction.includes("Add only the smallest artifact-local smoke/test support") &&
      verifierMissingWebSmokeCalls[1]?.instruction.includes("do not rewrite domain logic"),
    `Web smoke-support repair should be narrow and artifact-local, got ${JSON.stringify(verifierMissingWebSmokeCalls[1]?.instruction ?? "")}`,
  );
  const implementationEnvironmentHostBlockCalls =
    await runImplementationEnvironmentHostBlockReroutesVerifierRegression();
  const implementationEnvironmentHostBlockRoles =
    implementationEnvironmentHostBlockCalls.map((call) => call.role);
  assert(
    JSON.stringify(implementationEnvironmentHostBlockRoles) === JSON.stringify(["developer", "verifier"]),
    `Implementation host blocks caused only by missing local tools should reroute to verifier-only evidence, got ${JSON.stringify(implementationEnvironmentHostBlockRoles)}`,
  );
  const nodeDependencyHostBlockCalls = await runNodeDependencyHostBlockReroutesVerifierRegression();
  const nodeDependencyHostBlockRoles = nodeDependencyHostBlockCalls.map((call) => call.role);
  assert(
    JSON.stringify(nodeDependencyHostBlockRoles) === JSON.stringify(["frontend", "verifier"]),
    `Missing node_modules/package install blockers should reroute verifier-only install/build/smoke evidence, got ${JSON.stringify(nodeDependencyHostBlockRoles)}`,
  );
  const tsConfigModuleResolutionCalls =
    await runTsConfigModuleResolutionHostBlockRoutesImplementationRegression();
  const tsConfigModuleResolutionRoles = tsConfigModuleResolutionCalls.map((call) => call.role);
  assert(
    JSON.stringify(tsConfigModuleResolutionRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `TS5107 tsconfig build blocks should route a narrow implementation repair, got ${JSON.stringify(tsConfigModuleResolutionRoles)}`,
  );
  assert(
    tsConfigModuleResolutionCalls[1]?.instruction.includes("tsconfig.json") &&
      tsConfigModuleResolutionCalls[1]?.instruction.includes("moduleResolution"),
    `TS5107 repair should name tsconfig.json/moduleResolution, got ${JSON.stringify(tsConfigModuleResolutionCalls[1]?.instruction ?? "")}`,
  );
  const reactTypeHostBlockCalls = await runReactTypeHostBlockRoutesPackageRepairRegression();
  const reactTypeHostBlockRoles = reactTypeHostBlockCalls.map((call) => call.role);
  assert(
    JSON.stringify(reactTypeHostBlockRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `React type declaration build blocks should route a narrow implementation repair, got ${JSON.stringify(reactTypeHostBlockRoles)}`,
  );
  assert(
    reactTypeHostBlockCalls[1]?.instruction.includes("package.json only") &&
      reactTypeHostBlockCalls[1]?.instruction.includes("@types/react") &&
      reactTypeHostBlockCalls[1]?.instruction.includes("@types/react-dom") &&
      reactTypeHostBlockCalls[1]?.instruction.includes("do not rewrite app UI"),
    `React type repair should name package.json and type devDependencies without broad rewrite, got ${JSON.stringify(reactTypeHostBlockCalls[1]?.instruction ?? "")}`,
  );
  const viteAuditHostBlockCalls = await runViteAuditHostBlockRoutesPackageRepairRegression();
  const viteAuditHostBlockRoles = viteAuditHostBlockCalls.map((call) => call.role);
  assert(
    JSON.stringify(viteAuditHostBlockRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Vite/esbuild audit blocks should route a narrow implementation repair, got ${JSON.stringify(viteAuditHostBlockRoles)}`,
  );
  assert(
    viteAuditHostBlockCalls[1]?.instruction.includes("package.json only") &&
      viteAuditHostBlockCalls[1]?.instruction.includes("Vite 8+") &&
      viteAuditHostBlockCalls[1]?.instruction.includes("npm audit --audit-level=moderate") &&
      viteAuditHostBlockCalls[1]?.instruction.includes("do not rewrite app UI"),
    `Vite audit repair should name package.json and audit/build checks without broad rewrite, got ${JSON.stringify(viteAuditHostBlockCalls[1]?.instruction ?? "")}`,
  );
  const packagePeerConflictCalls = await runPackagePeerConflictRoutesPackageRepairRegression();
  const packagePeerConflictRoles = packagePeerConflictCalls.map((call) => call.role);
  assert(
    JSON.stringify(packagePeerConflictRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Package peer conflicts should route a narrow implementation repair, got ${JSON.stringify(packagePeerConflictRoles)}`,
  );
  assert(
    packagePeerConflictCalls[1]?.instruction.includes("package.json only") &&
      packagePeerConflictCalls[1]?.instruction.includes("compatible dependency peer ranges") &&
      packagePeerConflictCalls[1]?.instruction.includes("do not use --force/--legacy-peer-deps") &&
      packagePeerConflictCalls[1]?.instruction.includes("do not rewrite app UI"),
    `Package peer repair should name package.json and forbid broad/forced fixes, got ${JSON.stringify(packagePeerConflictCalls[1]?.instruction ?? "")}`,
  );
  const missingTestRunnerCalls = await runMissingGeneratedWebTestRunnerRoutesPackageRepairRegression();
  const missingTestRunnerRoles = missingTestRunnerCalls.map((call) => call.role);
  assert(
    JSON.stringify(missingTestRunnerRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Missing generated smoke/test runner should route a narrow implementation repair, got ${JSON.stringify(missingTestRunnerRoles)}`,
  );
  assert(
    missingTestRunnerCalls[1]?.instruction.includes("generated smoke/test harness imports a test runner that is not installed") &&
      missingTestRunnerCalls[1]?.instruction.includes("@playwright/test") &&
      missingTestRunnerCalls[1]?.instruction.includes("package.json") &&
      missingTestRunnerCalls[1]?.instruction.includes("do not rewrite app UI"),
    `Missing test runner repair should name package/smoke scope without broad rewrite, got ${JSON.stringify(missingTestRunnerCalls[1]?.instruction ?? "")}`,
  );
  const verifierMissingPackageCalls = await runVerifierMissingPackageRoutesImplementationRegression();
  const verifierMissingPackageRoles = verifierMissingPackageCalls.map((call) => call.role);
  assert(
    JSON.stringify(verifierMissingPackageRoles) === JSON.stringify(["verifier", "frontend", "reviewer", "verifier"]),
    `Verifier package.json structural blockers should route implementation repair, got ${JSON.stringify(verifierMissingPackageRoles)}`,
  );
  assert(
    verifierMissingPackageCalls[1]?.instruction.includes("package.json") &&
      verifierMissingPackageCalls[1]?.instruction.includes("web artifact is structurally incomplete"),
    `Missing package repair should preserve concrete verifier evidence, got ${JSON.stringify(verifierMissingPackageCalls[1]?.instruction ?? "")}`,
  );
  const generatedWebShapeCalls = await runGeneratedWebsiteRejectsBackendOnlyArtifactRegression();
  const generatedWebShapeRoles = generatedWebShapeCalls.map((call) => call.role);
  assert(
    JSON.stringify(generatedWebShapeRoles) === JSON.stringify(["backend", "frontend", "reviewer", "verifier"]),
    `Generated website requests should reject backend-only artifacts and route frontend repair, got ${JSON.stringify(generatedWebShapeRoles)}`,
  );
  assert(
    generatedWebShapeCalls[1]?.instruction.includes("Generated web artifact is incomplete") &&
      generatedWebShapeCalls[1]?.instruction.includes("backend/reservation_recommendations.py"),
    `Frontend repair should carry the artifact-shape failure evidence, got ${JSON.stringify(generatedWebShapeCalls[1]?.instruction ?? "")}`,
  );
  const pmAssignedSupportSliceCalls = await runPmAssignedSupportSliceSkipsGeneratedWebShapeRegression();
  const pmAssignedSupportSliceRoles = pmAssignedSupportSliceCalls.map((call) => call.role);
  assert(
    JSON.stringify(pmAssignedSupportSliceRoles) === JSON.stringify(["frontend"]),
    `PM-assigned support slices should not be forced through full web-artifact shape repair, got ${JSON.stringify(pmAssignedSupportSliceRoles)}`,
  );
  const runnableScaffoldCalls = await runMissingRunnableWebScaffoldRoutesNarrowRepairRegression();
  const runnableScaffoldRoles = runnableScaffoldCalls.map((call) => call.role);
  assert(
    JSON.stringify(runnableScaffoldRoles) === JSON.stringify(["frontend", "frontend", "reviewer", "verifier"]),
    `Missing runnable web scaffold files should route one narrow implementation repair before quality gates, got ${JSON.stringify(runnableScaffoldRoles)}`,
  );
  assert(
    runnableScaffoldCalls[1]?.instruction.includes("Generated web scaffold is not runnable yet") &&
      runnableScaffoldCalls[1]?.instruction.includes("missing runnable scaffold files: package.json") &&
      runnableScaffoldCalls[1]?.instruction.includes("src/App.tsx") &&
      runnableScaffoldCalls[1]?.instruction.includes("Create only these missing scaffold files"),
    `Runnable scaffold repair should preserve the missing manifest/entry evidence, got ${JSON.stringify(runnableScaffoldCalls[1]?.instruction ?? "")}`,
  );
  const explicitFileCalls = await runMissingExplicitRequestedArtifactFileRoutesNarrowRepairRegression();
  const explicitFileRoles = explicitFileCalls.map((call) => call.role);
  assert(
    JSON.stringify(explicitFileRoles) === JSON.stringify(["frontend", "frontend", "reviewer", "verifier"]),
    `Missing explicitly requested artifact file should route one narrow implementation repair before quality gates, got ${JSON.stringify(explicitFileRoles)}`,
  );
  assert(
    explicitFileCalls[1]?.instruction.includes("Generated artifact missed explicitly requested file paths") &&
      explicitFileCalls[1]?.instruction.includes("missing explicitly requested artifact files: src/styles.css") &&
      explicitFileCalls[1]?.instruction.includes("Create or report only these user-named paths first"),
    `Explicit file repair should preserve the missing user-named file evidence, got ${JSON.stringify(explicitFileCalls[1]?.instruction ?? "")}`,
  );
  const buildMissingScaffoldCalls = await runBuildMissingScaffoldFileRoutesTargetedRepairRegression();
  const buildMissingScaffoldRoles = buildMissingScaffoldCalls.map((call) => call.role);
  assert(
    JSON.stringify(buildMissingScaffoldRoles) === JSON.stringify(["frontend", "frontend", "reviewer", "verifier"]),
    `Build errors caused by missing scaffold files should route one targeted implementation repair, got ${JSON.stringify(buildMissingScaffoldRoles)}`,
  );
  assert(
    buildMissingScaffoldCalls[1]?.instruction.includes("Missing runnable scaffold file: tsconfig.node.json") &&
      buildMissingScaffoldCalls[1]?.instruction.includes("do not only rerun the command"),
    `Build missing scaffold repair should tell implementation to create the missing file first, got ${JSON.stringify(buildMissingScaffoldCalls[1]?.instruction ?? "")}`,
  );
  const looseReportedFilesRun = await runGeneratedWebsiteAcceptsLooseReportedFilesRegression();
  const looseReportedFileRoles = looseReportedFilesRun.calls.map((call) => call.role);
  assert(
    JSON.stringify(looseReportedFileRoles) === JSON.stringify(["frontend"]),
    `Loose reported file lists should satisfy generated web artifact shape without repair, got ${JSON.stringify(looseReportedFileRoles)}`,
  );
  assert(
    looseReportedFilesRun.completions[0]?.status === "completed" &&
      looseReportedFilesRun.completions[0]?.changedFiles?.includes("index.html") === true &&
      looseReportedFilesRun.completions[0]?.changedFiles?.includes("src/app.js") === true,
    `Loose reported file lists should propagate into completion evidence, got ${JSON.stringify(looseReportedFilesRun.completions)}`,
  );
  runPriorStepsLooseFileMemoryRegression();
  const genericArtifactNoFilesCalls = await runConcreteArtifactWithoutFilesRoutesRepairRegression();
  const genericArtifactNoFilesRoles = genericArtifactNoFilesCalls.map((call) => call.role);
  assert(
    JSON.stringify(genericArtifactNoFilesRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `Concrete artifact requests with no reported files should route implementation repair before quality gates, got ${JSON.stringify(genericArtifactNoFilesRoles)}`,
  );
  assert(
    genericArtifactNoFilesCalls[1]?.instruction.includes("Generated artifact has no reported files") &&
      genericArtifactNoFilesCalls[1]?.instruction.includes("reported artifact files: none reported"),
    `Concrete artifact repair should preserve missing-file evidence, got ${JSON.stringify(genericArtifactNoFilesCalls[1]?.instruction ?? "")}`,
  );
  const implementationPlanOnlyCalls = await runImplementationPlanOnlyRepairRoutesImplementationRegression();
  const implementationPlanOnlyRoles = implementationPlanOnlyCalls.map((call) => call.role);
  assert(
    JSON.stringify(implementationPlanOnlyRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `Implementation plan-only output should reroute implementation before quality gates, got ${JSON.stringify(implementationPlanOnlyRoles)}`,
  );
  assert(
    implementationPlanOnlyCalls[1]?.instruction.includes("Prefer delegating the repair to: backend") &&
      implementationPlanOnlyCalls[1]?.instruction.includes("Implementation output only described a plan or inspection") &&
      implementationPlanOnlyCalls[1]?.instruction.includes("implementation format issue: unexpected SEQUENCER_PLAN") &&
      implementationPlanOnlyCalls[1]?.instruction.includes("make the smallest concrete file change") &&
      implementationPlanOnlyCalls[1]?.instruction.includes("do not emit [SEQUENCER_PLAN]"),
    `Plan-only repair should preserve implementation-format evidence, got ${JSON.stringify(implementationPlanOnlyCalls[1]?.instruction ?? "")}`,
  );
  const malformedFilesCreatedRun =
    await runMalformedFilesCreatedWithPlanNoiseCountsAsImplementationRegression();
  const malformedFilesCreatedRoles = malformedFilesCreatedRun.calls.map((call) => call.role);
  assert(
    JSON.stringify(malformedFilesCreatedRoles) === JSON.stringify(["backend"]),
    `Malformed FilesCreated body with concrete files should not loop through repair, got ${JSON.stringify(malformedFilesCreatedRoles)}`,
  );
  assert(
    malformedFilesCreatedRun.completions[0]?.status === "completed" &&
      malformedFilesCreatedRun.completions[0]?.changedFiles?.includes("src/App.tsx") === true &&
      malformedFilesCreatedRun.completions[0]?.changedFiles?.includes("src/engine/scoring.ts") === true,
    `Malformed FilesCreated body should still propagate changed files, got ${JSON.stringify(malformedFilesCreatedRun.completions)}`,
  );
  const selfDelegatedImplementationCalls =
    await runImplementationPlanWithSelfDelegatedSlicePreservesNestedExecutionRegression();
  assert(
    JSON.stringify(selfDelegatedImplementationCalls.map((call) => call.role)) === JSON.stringify(["backend", "backend"]),
    `Implementation plan+self-delegation should run the nested implementation card, got ${JSON.stringify(selfDelegatedImplementationCalls.map((call) => call.role))}`,
  );
  assert(
    selfDelegatedImplementationCalls[1]?.instruction.includes("Implement the runnable scaffold files now.") &&
      !selfDelegatedImplementationCalls[1]?.instruction.includes("Quality gate feedback requires another repair cycle"),
    `Nested implementation card should be preserved instead of replaced by generic repair, got ${JSON.stringify(selfDelegatedImplementationCalls[1]?.instruction ?? "")}`,
  );
  const implementationAnalysisOnlyCalls = await runImplementationAnalysisOnlyEmptyFilesRoutesImplementationRegression();
  const implementationAnalysisOnlyRoles = implementationAnalysisOnlyCalls.map((call) => call.role);
  assert(
    JSON.stringify(implementationAnalysisOnlyRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `Analysis-only implementation output with empty FilesCreated should reroute implementation before quality gates, got ${JSON.stringify(implementationAnalysisOnlyRoles)}`,
  );
  assert(
    implementationAnalysisOnlyCalls[1]?.instruction.includes("Prefer delegating the repair to: backend") &&
      implementationAnalysisOnlyCalls[1]?.instruction.includes("Implementation output only described a plan or inspection"),
    `Analysis-only repair should keep the same implementation owner and explain the defect, got ${JSON.stringify(implementationAnalysisOnlyCalls[1]?.instruction ?? "")}`,
  );
  const noChangeVerifierHandoffCalls = await runIncrementalNoChangeVerifierHandoffRegression();
  assert(
    JSON.stringify(noChangeVerifierHandoffCalls.map((call) => call.role)) === JSON.stringify(["backend", "verifier"]),
    `Already-satisfied incremental implementation slices should go to verifier, got ${JSON.stringify(noChangeVerifierHandoffCalls.map((call) => call.role))}`,
  );
  const placeholderFilesCreatedCalls = await runPlaceholderFilesCreatedRoutesRepairRegression();
  const placeholderFilesCreatedRoles = placeholderFilesCreatedCalls.map((call) => call.role);
  assert(
    JSON.stringify(placeholderFilesCreatedRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `Placeholder FilesCreated entries should route implementation repair before quality gates, got ${JSON.stringify(placeholderFilesCreatedRoles)}`,
  );
  assert(
    placeholderFilesCreatedCalls[1]?.instruction.includes("Generated artifact has no reported files") &&
      placeholderFilesCreatedCalls[1]?.instruction.includes("reported artifact files: none reported") &&
      !placeholderFilesCreatedCalls[1]?.instruction.includes("N/A"),
    `Placeholder FilesCreated repair should ignore placeholder file entries, got ${JSON.stringify(placeholderFilesCreatedCalls[1]?.instruction ?? "")}`,
  );
  const missingReportedFilesRun = await runReportedMissingArtifactFilesRoutesRepairRegression();
  const missingReportedFileRoles = missingReportedFilesRun.calls.map((call) => call.role);
  assert(
    JSON.stringify(missingReportedFileRoles) === JSON.stringify(["backend", "backend", "reviewer", "verifier"]),
    `Reported artifact files that are absent from the workspace should route implementation repair before quality gates, got ${JSON.stringify(missingReportedFileRoles)}`,
  );
  assert(
    missingReportedFilesRun.calls[1]?.instruction.includes("Generated artifact reported files that are missing") &&
      missingReportedFilesRun.calls[1]?.instruction.includes("receipt_classifier.py") &&
      missingReportedFilesRun.calls[1]?.instruction.includes("Create or correct only these reported paths first"),
    `Missing reported file repair should preserve exact file evidence, got ${JSON.stringify(missingReportedFilesRun.calls[1]?.instruction ?? "")}`,
  );
  assert(
    missingReportedFilesRun.hostCommands.some((command) => command.includes("receipt_classifier.py")),
    `Missing reported file regression should verify reported paths through the host, got ${JSON.stringify(missingReportedFilesRun.hostCommands)}`,
  );
  const boundedSliceMissingFilesRun = await runBoundedSliceMissingReportedFilesRoutesRepairRegression();
  const boundedSliceMissingFileRoles = boundedSliceMissingFilesRun.calls.map((call) => call.role);
  assert(
    JSON.stringify(boundedSliceMissingFileRoles) === JSON.stringify(["frontend", "frontend", "reviewer", "verifier"]),
    `Bounded slice missing reported files should route implementation repair before quality gates, got ${JSON.stringify(boundedSliceMissingFileRoles)}`,
  );
  assert(
    boundedSliceMissingFilesRun.calls[1]?.instruction.includes("Generated artifact reported files that are missing") &&
      boundedSliceMissingFilesRun.calls[1]?.instruction.includes("app.js") &&
      boundedSliceMissingFilesRun.calls[1]?.instruction.includes("leave unrelated files alone"),
    `Bounded slice missing-file repair should preserve exact file evidence, got ${JSON.stringify(boundedSliceMissingFilesRun.calls[1]?.instruction ?? "")}`,
  );
  assert(
    boundedSliceMissingFilesRun.hostCommands.some((command) => command.includes("index.html")) &&
      boundedSliceMissingFilesRun.hostCommands.some((command) => command.includes("app.js")),
    `Bounded slice missing-file regression should still verify reported paths through the host, got ${JSON.stringify(boundedSliceMissingFilesRun.hostCommands)}`,
  );
  const noChangeConfirmationRun = await runNoChangeConfirmationWithoutFilesCompletesRegression();
  assert(
    JSON.stringify(noChangeConfirmationRun.calls.map((call) => call.role)) === JSON.stringify(["backend"]) &&
      noChangeConfirmationRun.completions[0]?.status === "completed",
    `No-change confirmation should not be forced into artifact-file repair, got calls=${JSON.stringify(noChangeConfirmationRun.calls.map((call) => call.role))} completions=${JSON.stringify(noChangeConfirmationRun.completions)}`,
  );
  const freshArtifactDirtyWorkspaceCalls = await runFreshArtifactDirtyWorkspaceIntentRegression();
  const freshArtifactPlanCall = freshArtifactDirtyWorkspaceCalls.find(
    (call) => call.role === "pm" && !call.instruction.includes("Prompting_Sequencer_"),
  );
  const freshArtifactFrontendCall = freshArtifactDirtyWorkspaceCalls.find(
    (call) => call.role === "frontend",
  );
  assert(
    freshArtifactPlanCall?.instruction.includes("## Artifact delivery intent") &&
      freshArtifactPlanCall.instruction.includes("fresh requested deliverable") &&
      freshArtifactPlanCall.instruction.includes("not automatic scope") &&
      !freshArtifactPlanCall.instruction.includes(".daacs_timeout_marker_"),
    `Fresh artifact planning should separate dirty workspace context from repair scope, got ${JSON.stringify(freshArtifactPlanCall?.instruction ?? "")}`,
  );
  assert(
    freshArtifactFrontendCall?.instruction.includes("## Artifact delivery intent") &&
      freshArtifactFrontendCall.instruction.toLowerCase().includes("prior generated output to repair") &&
      !freshArtifactFrontendCall.instruction.includes(".daacs_timeout_marker_"),
    `Fresh artifact implementation should preserve the new-deliverable intent, got ${JSON.stringify(freshArtifactFrontendCall?.instruction ?? "")}`,
  );
  const duplicateNestedCalls = await runDuplicateNestedQualityFollowupsAreDedupedRegression();
  const duplicateNestedRoles = duplicateNestedCalls.map((call) => call.role);
  assert(
    JSON.stringify(duplicateNestedRoles) === JSON.stringify(["developer", "verifier"]),
    `Duplicate nested verifier follow-ups should run once, got ${JSON.stringify(duplicateNestedRoles)}`,
  );
  const reviewerEvidenceGapCalls = await runReviewerEvidenceGapReroutesVerifierRegression();
  const reviewerEvidenceGapRoles = reviewerEvidenceGapCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerEvidenceGapRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Reviewer evidence gaps should reroute to verifier-only follow-up instead of artifact repair, got ${JSON.stringify(reviewerEvidenceGapRoles)}`,
  );
  assert(
    reviewerEvidenceGapCalls[1]?.instruction.includes("Do not modify generated artifacts or source files"),
    `Reviewer evidence-gap follow-up should forbid artifact edits, got ${JSON.stringify(reviewerEvidenceGapCalls[1]?.instruction ?? "")}`,
  );
  const reviewerNonGitEvidenceGapCalls = await runReviewerNonGitEvidenceGapReroutesVerifierRegression();
  const reviewerNonGitEvidenceGapRoles = reviewerNonGitEvidenceGapCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerNonGitEvidenceGapRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Reviewer non-git evidence gaps should reroute to verifier-only follow-up instead of implementation repair, got ${JSON.stringify(reviewerNonGitEvidenceGapRoles)}`,
  );
  const reviewerBrowserEvidenceGapCalls = await runReviewerBrowserEvidenceGapReroutesVerifierRegression();
  const reviewerBrowserEvidenceGapRoles = reviewerBrowserEvidenceGapCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerBrowserEvidenceGapRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Reviewer browser-evidence gaps should reroute to verifier-only follow-up instead of implementation repair, got ${JSON.stringify(reviewerBrowserEvidenceGapRoles)}`,
  );
  const reviewerHostBuildSmokeEvidenceGapCalls =
    await runReviewerHostBuildSmokeEvidenceGapReroutesVerifierRegression();
  const reviewerHostBuildSmokeEvidenceGapRoles =
    reviewerHostBuildSmokeEvidenceGapCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerHostBuildSmokeEvidenceGapRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Reviewer host-build/smoke evidence gaps should reroute to verifier-only follow-up instead of implementation repair, got ${JSON.stringify(reviewerHostBuildSmokeEvidenceGapRoles)}`,
  );
  assert(
    reviewerHostBuildSmokeEvidenceGapCalls[1]?.instruction.includes(
      "Do not modify generated artifacts or source files",
    ),
    `Reviewer host-build/smoke evidence follow-up should forbid artifact edits, got ${JSON.stringify(reviewerHostBuildSmokeEvidenceGapCalls[1]?.instruction ?? "")}`,
  );
  const reviewerHostBlockedCalls = await runReviewerHostFeedbackBlockedReroutesVerifierRegression();
  const reviewerHostBlockedRoles = reviewerHostBlockedCalls.map((call) => call.role);
  assert(
    JSON.stringify(reviewerHostBlockedRoles) === JSON.stringify(["reviewer", "verifier"]),
    `Reviewer host-feedback blocks should reroute to verifier-only evidence follow-up instead of implementation repair, got ${JSON.stringify(reviewerHostBlockedRoles)}`,
  );
  const pmPlanRetryCalls = await runPmPlanRetryRegression();
  const pmPlanRetryPlanningCalls = pmPlanRetryCalls.filter(
    (call) => call.role === "pm" && !call.instruction.includes("Prompting_Sequencer_"),
  );
  const pmPlanRetryHasPmStep = pmPlanRetryCalls.some(
    (call) => call.role === "pm" && call.instruction.includes("Prompting_Sequencer_1"),
  );
  assert(
    pmPlanRetryPlanningCalls.length === 2 && pmPlanRetryHasPmStep,
    `PM plan retry should rerun planning once and then execute a concrete PM triage step, got ${JSON.stringify(pmPlanRetryCalls)}`,
  );
  const pmPlanFailureCalls = await runPmPlanFailureFailsClosedRegression();
  assert(
    JSON.stringify(pmPlanFailureCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm"]),
    `PM plan failure should fail closed after one retry instead of routing stderr into other agents, got ${JSON.stringify(pmPlanFailureCalls)}`,
  );
  const nonGitWorkspaceRun = await runNonGitWorkspaceSkipsDirtyDiffRegression();
  assert(
    nonGitWorkspaceRun.hostCommands.filter((command) => command.startsWith("git status --short")).length >= 1 &&
      !nonGitWorkspaceRun.hostCommands.some((command) => command.startsWith("git diff --stat")) &&
      !nonGitWorkspaceRun.hostCommands.some((command) => command.startsWith("git diff --unified=0")),
    `Non-git workspaces should not fabricate dirty-diff follow-ups from git errors, got ${JSON.stringify(nonGitWorkspaceRun.hostCommands)}`,
  );
  const pmKoreanFinalHandoffCalls = await runPmKoreanFinalHandoffStaysOnPmRegression();
  assert(
    JSON.stringify(pmKoreanFinalHandoffCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `Korean PM final handoff steps should stay on PM before quality gates, got ${JSON.stringify(pmKoreanFinalHandoffCalls)}`,
  );
  const pmHandoffWritingVariantCalls = await runPmHandoffWritingVariantStaysOnPmRegression();
  assert(
    JSON.stringify(pmHandoffWritingVariantCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `PM handoff-writing wording variants should stay on PM before downstream delegation, got ${JSON.stringify(pmHandoffWritingVariantCalls)}`,
  );
  const pmImplementationVerificationHandoffCalls =
    await runPmImplementationVerificationHandoffWritingStaysOnPmRegression();
  assert(
    JSON.stringify(pmImplementationVerificationHandoffCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `PM implementation-verification handoff-writing variants should stay on PM before downstream delegation, got ${JSON.stringify(pmImplementationVerificationHandoffCalls)}`,
  );
  const pmExplicitRoleExecutionHandoffCalls =
    await runPmExplicitRoleExecutionHandoffWritingStaysOnPmRegression();
  assert(
    JSON.stringify(pmExplicitRoleExecutionHandoffCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `PM explicit-role execution handoff-writing variants should stay on PM before downstream delegation, got ${JSON.stringify(pmExplicitRoleExecutionHandoffCalls)}`,
  );
  const pmRoleCriteriaDelegationCardCalls =
    await runPmRoleCriteriaDelegationCardWritingStaysOnPmRegression();
  assert(
    JSON.stringify(pmRoleCriteriaDelegationCardCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `PM role/criteria/delegation-card wording variants should stay on PM before downstream delegation, got ${JSON.stringify(pmRoleCriteriaDelegationCardCalls)}`,
  );
  const pmReadOnlyScopeAndHandoffPlanningCalls =
    await runPmReadOnlyScopeAndHandoffPlanningStaysOnPmRegression();
  assert(
    JSON.stringify(pmReadOnlyScopeAndHandoffPlanningCalls.map((call) => call.role)) === JSON.stringify(["pm", "pm", "pm"]),
    `Read-only scope plus handoff planning wording should stay on PM before downstream delegation, got ${JSON.stringify(pmReadOnlyScopeAndHandoffPlanningCalls)}`,
  );
  const recentOwnerReworkCalls = await runVerifierReworkUsesRecentImplementationOwnerRegression();
  const recentOwnerNonVerifierRoles = recentOwnerReworkCalls
    .map((call) => call.role)
    .filter((role) => role !== "verifier");
  assert(
    JSON.stringify(recentOwnerNonVerifierRoles) === JSON.stringify(["frontend", "reviewer"]),
    `Verifier direct rework should reuse the recent implementation owner before review/verifier follow-up, got ${JSON.stringify(recentOwnerNonVerifierRoles)}`,
  );
  const wrappedAssignmentReworkCalls = await runVerifierWrappedAssignmentKeepsPrimaryOwnerRegression();
  const wrappedAssignmentNonVerifierRoles = wrappedAssignmentReworkCalls
    .map((call) => call.role)
    .filter((role) => role !== "verifier");
  assert(
    JSON.stringify(wrappedAssignmentNonVerifierRoles) === JSON.stringify(["developer", "reviewer"]),
    `Wrapped verifier commands should keep rework on the primary implementation owner instead of fan-out, got ${JSON.stringify(wrappedAssignmentNonVerifierRoles)}`,
  );
  const skillRequestPlan = await runPmPlanCascadeWithLogs(
    [
      "[SEQUENCER_PLAN]",
      "1. Audit the current workspace boundary",
      "2. Summarize concrete risks",
      "3. Define downstream routing",
      "[/SEQUENCER_PLAN]",
      "[SKILL_REQUEST]typescript-pro[/SKILL_REQUEST]",
    ].join("\n"),
    "[SKILL_REQUEST]clean-code[/SKILL_REQUEST]",
  );
  const skillRequestLog = skillRequestPlan.logs.find((entry) => entry.label === "AgentCascadePlanSkill(pm)");
  assert(skillRequestLog != null, "Expected plan skill-request log entry for PM planning");
  assert(
    JSON.stringify(skillRequestLog?.skillRequestParsed ?? []) === JSON.stringify(["typescript-pro"]),
    `Only stdout SKILL_REQUEST blocks should be parsed, got ${JSON.stringify(skillRequestLog?.skillRequestParsed ?? [])}`,
  );

  const stepSkillRequestRun = await runPmStepSkillRequestCascadeWithLogs();
  const stepSkillRequestLog = stepSkillRequestRun.logs.find(
    (entry) => entry.label === "AgentCascadeStepSkill(frontend,1)",
  );
  assert(stepSkillRequestLog != null, "Expected step skill-request log entry for frontend step 1");
  assert(
    JSON.stringify(stepSkillRequestLog?.skillRequestParsed ?? []) === JSON.stringify(["typescript-pro"]),
    `Step execution should parse stdout-only SKILL_REQUEST blocks, got ${JSON.stringify(stepSkillRequestLog?.skillRequestParsed ?? [])}`,
  );

  const directCommandSkillRequestRun = await runDirectCommandSkillRequestCascadeWithLogs();
  const directCommandSkillRequestLog = directCommandSkillRequestRun.logs.find(
    (entry) => entry.label === "AgentCommandSkill(frontend)",
  );
  assert(
    directCommandSkillRequestLog != null,
    "Expected direct-command skill-request log entry for frontend",
  );
  assert(
    JSON.stringify(directCommandSkillRequestLog?.skillRequestParsed ?? []) ===
      JSON.stringify(["typescript-pro"]),
    `Direct-command execution should parse stdout-only SKILL_REQUEST blocks, got ${JSON.stringify(directCommandSkillRequestLog?.skillRequestParsed ?? [])}`,
  );

  const mixedOutputRun = await runDirectCommandMixedOutputCascade();
  const mixedOutputRoles = mixedOutputRun.calls.map((call) => call.role);
  const mixedOutputLog = mixedOutputRun.logs.find(
    (entry) => entry.label === "AgentCommand(frontend)",
  );
  assert(mixedOutputRoles[0] === "frontend", "Mixed-output regression should start on the seeded frontend command");
  assert(
    mixedOutputRoles.includes("backend"),
    `Mixed stdout+stderr execution output should preserve AGENT_COMMANDS delegation, got ${JSON.stringify(mixedOutputRoles)}`,
  );
  const mixedOutputBackendCall = mixedOutputRun.calls.find((call) => call.role === "backend");
  assert(
    mixedOutputBackendCall?.instruction.includes("Prompting_Sequencer_1"),
    `Direct AGENT_COMMANDS handoff should include an executable sequencer step signal, got ${JSON.stringify(mixedOutputBackendCall?.instruction ?? "")}`,
  );
  assert(mixedOutputLog != null, "Expected mixed-output direct-command log entry for frontend");
  assert(
    mixedOutputLog?.stdout.includes("[STEP_3_RESULT]") &&
      mixedOutputLog?.stdout.includes("Frontend restored the execution result payload.") &&
      mixedOutputLog?.stdout.includes("{END_TASK_3}"),
    `Mixed stdout+stderr execution output should preserve the full step result payload, got ${JSON.stringify(mixedOutputLog?.stdout ?? "")}`,
  );
  assert(
    mixedOutputLog?.stdout.includes("[AGENT_COMMANDS]") &&
      mixedOutputLog?.stdout.includes('"AgentName":"backend"') &&
      mixedOutputLog?.stdout.includes('"CommandSender":"frontend"'),
    `Mixed stdout+stderr execution output should merge AGENT_COMMANDS into the preserved payload, got ${JSON.stringify(mixedOutputLog?.stdout ?? "")}`,
  );
  assert(
    mixedOutputLog?.stderr === "",
    `Mixed stdout+stderr execution output should collapse into combined stdout before logging, got stderr=${JSON.stringify(mixedOutputLog?.stderr ?? "")}`,
  );

  const mixedOutputSenderPayloadRun = await runDirectCommandMixedOutputSenderPayloadCascade();
  const mixedOutputSenderPayloadPmCall = mixedOutputSenderPayloadRun.calls.find(
    (call) => call.role === "pm",
  );
  assert(
    mixedOutputSenderPayloadPmCall == null,
    `Direct sender payload should not re-plan already executed nested AGENT_COMMANDS, got PM instruction=${JSON.stringify(mixedOutputSenderPayloadPmCall?.instruction ?? "")}`,
  );

  const staleReviewerFollowupCalls = await runReviewerStaleFailureFollowupSuppressionCascade();
  const staleReviewerFollowupRoles = staleReviewerFollowupCalls.map((call) => call.role);
  assert(
    JSON.stringify(staleReviewerFollowupRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Reviewer needs_rework should not leave a stale failed TaskComplete for PM after repair branches run, got ${JSON.stringify(staleReviewerFollowupRoles)}`,
  );
  const staleReviewerFrontendRepairCall = staleReviewerFollowupCalls.find((call) => call.role === "frontend");
  assert(
    staleReviewerFrontendRepairCall?.instruction.includes("Quality gate feedback requires another repair cycle") &&
      staleReviewerFrontendRepairCall.instruction.includes("Surface: client-side web artifact") &&
      staleReviewerFrontendRepairCall.instruction.includes("do not create or edit Python files") &&
      staleReviewerFrontendRepairCall.instruction.includes("backend/**") &&
      staleReviewerFrontendRepairCall.instruction.includes("prior-run noise") &&
      staleReviewerFrontendRepairCall.instruction.includes("repair only the active web files") &&
      !staleReviewerFrontendRepairCall.instruction.includes("Intent: explicit_backend_python") &&
      (staleReviewerFrontendRepairCall.instruction.match(/## Request intent classification/g) ?? []).length === 1,
    `Client-side web repair should fence stale Python/backend artifacts, got ${JSON.stringify(staleReviewerFrontendRepairCall?.instruction ?? "")}`,
  );

  const existingPythonRepairCalls = await runExistingPythonRepairKeepsBackendScopeCascade();
  const existingPythonImplementationCall = existingPythonRepairCalls.find(
    (call) => call.role === "backend" || call.role === "developer",
  );
  assert(
    existingPythonImplementationCall?.instruction.includes("Intent: explicit_backend_python") &&
      existingPythonImplementationCall.instruction.includes("backend/Python work") &&
      existingPythonImplementationCall.instruction.includes("do not discard backend/Python files as stale noise") &&
      !existingPythonImplementationCall.instruction.includes("do not create or edit Python files"),
    `Existing backend/Python repair should preserve named Python scope, got ${JSON.stringify(existingPythonImplementationCall?.instruction ?? "")}`,
  );

  const noChangeFailureCalls = await runDirectNoChangeFailureStopsCascade();
  assert(
    JSON.stringify(noChangeFailureCalls.map((call) => call.role)) === JSON.stringify(["developer", "developer", "pm"]) &&
      noChangeFailureCalls[1]?.instruction.includes("Bounded repair slice for this cycle") &&
      noChangeFailureCalls[2]?.instruction.includes("Timeout-triggered PM re-scope") &&
      noChangeFailureCalls[2]?.instruction.includes("Do not send the same large slice back unchanged."),
    `No-change timeout should get one bounded same-owner retry, then PM re-scope before failing closed without loops, got ${JSON.stringify(noChangeFailureCalls)}`,
  );
  const boundedRepairTimeoutRescopeCalls = await runBoundedRepairTimeoutRoutesPmRescopeCascade();
  assert(
    JSON.stringify(boundedRepairTimeoutRescopeCalls.map((call) => call.role)) ===
      JSON.stringify(["developer", "developer", "pm", "developer", "reviewer", "verifier"]) &&
      boundedRepairTimeoutRescopeCalls[2]?.instruction.includes("Timeout-triggered PM re-scope") &&
      boundedRepairTimeoutRescopeCalls[3]?.instruction.includes("Create only index.html and src/app.js"),
    `Bounded repair timeout should route through PM into a smaller recovery card, got ${JSON.stringify(boundedRepairTimeoutRescopeCalls)}`,
  );

  const blockedVerifierRun = await runBlockedVerifierArtifactCascade();
  try {
    const blockedVerifierRoles = blockedVerifierRun.calls.map((call) => call.role);
    const blockedVerifierLog = blockedVerifierRun.logs.find(
      (entry) => entry.label === "AgentCommand(verifier)",
    );
    assert(blockedVerifierLog != null, "Expected blocked-verifier direct-command log entry");
    assert(
      blockedVerifierRoles.includes("frontend"),
      `Blocked verifier should route repair work to a concrete implementation owner, got ${JSON.stringify(blockedVerifierRoles)}`,
    );
    assert(
      blockedVerifierRoles.includes("reviewer") && blockedVerifierRoles.filter((role) => role === "verifier").length >= 2,
      `Blocked verifier should preserve reviewer/verifier follow-up after repair routing, got ${JSON.stringify(blockedVerifierRoles)}`,
    );
    assert(
      blockedVerifierLog?.stdout.includes("[VerificationStatus]") &&
        blockedVerifierLog?.stdout.includes("blocked") &&
        blockedVerifierLog?.stdout.includes("Host command evidence:") &&
        blockedVerifierLog?.stdout.includes("npm run verify:sequencer") &&
        blockedVerifierLog?.stdout.includes("Missing script: verify:sequencer"),
      `Blocked verifier output should retain verification evidence in the combined payload, got ${JSON.stringify(blockedVerifierLog?.stdout ?? "")}`,
    );
    assert(
      blockedVerifierLog?.stderr === "",
      `Blocked verifier output should collapse stderr into combined stdout before logging, got stderr=${JSON.stringify(blockedVerifierLog?.stderr ?? "")}`,
    );
    const blockedArtifacts = await readdir(
      join(blockedVerifierRun.workspace, "tmp", "verification", "smoke-verification"),
    );
    assert(
      blockedArtifacts.length === 1,
      `Blocked verifier should write exactly one verification artifact, got ${JSON.stringify(blockedArtifacts)}`,
    );
    const blockedArtifactRelativePath = `tmp/verification/smoke-verification/${blockedArtifacts[0]}`;
    assert(
      blockedVerifierLog?.stdout.includes(blockedArtifactRelativePath),
      `Blocked verifier output should reference the persisted artifact path, got ${JSON.stringify(blockedVerifierLog?.stdout ?? "")}`,
    );
    const blockedArtifact = JSON.parse(
      await readFile(join(blockedVerifierRun.workspace, blockedArtifactRelativePath), "utf8"),
    ) as {
      ok: boolean;
      sourceCommands: string[];
      runs: Array<{ command: string; exit_code: number; stdout: string; stderr: string }>;
    };
    assert(blockedArtifact.ok === false, "Blocked verifier artifact should capture the failed host feedback result");
    assert(
      JSON.stringify(blockedArtifact.sourceCommands) === JSON.stringify(["npm run verify:sequencer"]),
      `Blocked verifier artifact should persist the source host commands, got ${JSON.stringify(blockedArtifact.sourceCommands)}`,
    );
    assert(
      blockedArtifact.runs[0]?.command === "npm run verify:sequencer" &&
        blockedArtifact.runs[0]?.exit_code === 1 &&
        blockedArtifact.runs[0]?.stdout.includes("running verifier command") &&
        blockedArtifact.runs[0]?.stderr.includes("Missing script: verify:sequencer"),
      `Blocked verifier artifact should preserve stdout/stderr and exit code, got ${JSON.stringify(blockedArtifact.runs[0] ?? null)}`,
    );
  } finally {
    await rm(blockedVerifierRun.workspace, { recursive: true, force: true });
  }

  const backendAlignedReviewerReworkRun = await runBackendAlignedReviewerReworkCascade();
  const backendAlignedReviewerRoles = backendAlignedReviewerReworkRun.calls.map((call) => call.role);
  const backendReviewerCall = backendAlignedReviewerReworkRun.calls.find((call) => call.role === "backend");
  assert(
    JSON.stringify(backendAlignedReviewerRoles) ===
      JSON.stringify(["reviewer", "backend", "reviewer", "verifier"]),
    `Reviewer-driven backend-aligned rework should escalate to backend before quality follow-up, got ${JSON.stringify(backendAlignedReviewerRoles)}`,
  );
  assert(
    backendReviewerCall?.instruction.includes("Quality gate feedback requires another repair cycle") &&
      backendReviewerCall.instruction.includes("Preserve BYOK/auth contract compatibility on the backend-aligned surface"),
    `Reviewer-driven backend-aligned rework should pass concrete findings into the backend repair command, got ${JSON.stringify(backendReviewerCall?.instruction ?? "")}`,
  );

  const backendAlignedVerifierReworkRun = await runBackendAlignedVerifierReworkCascade();
  const backendAlignedVerifierRoles = backendAlignedVerifierReworkRun.calls.map((call) => call.role);
  const backendVerifierCall = backendAlignedVerifierReworkRun.calls.find((call) => call.role === "backend");
  assert(
    JSON.stringify(backendAlignedVerifierRoles) ===
      JSON.stringify(["verifier", "backend", "reviewer", "verifier"]),
    `Verifier-driven backend-aligned rework should escalate to backend before quality follow-up, got ${JSON.stringify(backendAlignedVerifierRoles)}`,
  );
  assert(
    backendVerifierCall?.instruction.includes("Quality gate feedback requires another repair cycle") &&
      backendVerifierCall.instruction.includes("backend contract surface is inconsistent with the BYOK expectation"),
    `Verifier-driven backend-aligned rework should pass backend-aligned verification evidence into the repair command, got ${JSON.stringify(backendVerifierCall?.instruction ?? "")}`,
  );

  const mixedContextReviewerReworkRun = await runMixedContextReviewerReworkCascade();
  const mixedContextReviewerRoles = mixedContextReviewerReworkRun.calls.map((call) => call.role);
  const mixedContextReviewerBackendCall = mixedContextReviewerReworkRun.calls.find(
    (call) => call.role === "backend",
  );
  const mixedContextReviewerFrontendCall = mixedContextReviewerReworkRun.calls.find(
    (call) => call.role === "frontend",
  );
  assert(
    JSON.stringify(mixedContextReviewerRoles) ===
      JSON.stringify(["reviewer", "backend", "frontend", "reviewer", "verifier"]),
    `Reviewer-driven mixed-context rework should keep both backend BYOK and frontend settings owners before quality follow-up, got ${JSON.stringify(mixedContextReviewerRoles)}`,
  );
  assert(
    mixedContextReviewerBackendCall?.instruction.includes("Preserve BYOK/auth contract compatibility") &&
      mixedContextReviewerBackendCall.instruction.includes("LlmSettingsModal.tsx reachability") &&
      mixedContextReviewerFrontendCall?.instruction.includes("Preserve BYOK/auth contract compatibility") &&
      mixedContextReviewerFrontendCall.instruction.includes("LlmSettingsModal.tsx reachability"),
    `Reviewer-driven mixed-context rework should preserve both BYOK and settings clues in each repair command, got backend=${JSON.stringify(mixedContextReviewerBackendCall?.instruction ?? "")} frontend=${JSON.stringify(mixedContextReviewerFrontendCall?.instruction ?? "")}`,
  );

  const mixedContextVerifierReworkRun = await runMixedContextVerifierReworkCascade();
  const mixedContextVerifierRoles = mixedContextVerifierReworkRun.calls.map((call) => call.role);
  const mixedContextVerifierBackendCall = mixedContextVerifierReworkRun.calls.find(
    (call) => call.role === "backend",
  );
  const mixedContextVerifierFrontendCall = mixedContextVerifierReworkRun.calls.find(
    (call) => call.role === "frontend",
  );
  assert(
    JSON.stringify(mixedContextVerifierRoles) ===
      JSON.stringify(["verifier", "backend", "frontend", "reviewer", "verifier"]),
    `Verifier-driven mixed-context rework should keep both backend BYOK and frontend settings owners before quality follow-up, got ${JSON.stringify(mixedContextVerifierRoles)}`,
  );
  assert(
    mixedContextVerifierBackendCall?.instruction.includes("backend contract surface is inconsistent with the BYOK expectation") &&
      mixedContextVerifierBackendCall.instruction.includes("settings modal path is unreachable") &&
      mixedContextVerifierFrontendCall?.instruction.includes("backend contract surface is inconsistent with the BYOK expectation") &&
      mixedContextVerifierFrontendCall.instruction.includes("settings modal path is unreachable"),
    `Verifier-driven mixed-context rework should preserve both BYOK and settings verification evidence in each repair command, got backend=${JSON.stringify(mixedContextVerifierBackendCall?.instruction ?? "")} frontend=${JSON.stringify(mixedContextVerifierFrontendCall?.instruction ?? "")}`,
  );

  const koreanMixedContextCalls = await runKoreanMixedContextReworkCascade();
  const koreanMixedContextRoles = koreanMixedContextCalls.map((call) => call.role);
  const koreanMixedContextBackendCall = koreanMixedContextCalls.find((call) => call.role === "backend");
  const koreanMixedContextFrontendCall = koreanMixedContextCalls.find((call) => call.role === "frontend");
  assert(
    JSON.stringify(koreanMixedContextRoles) ===
      JSON.stringify(["reviewer", "backend", "frontend", "reviewer", "verifier"]),
    `Korean mixed-context rework should keep backend and frontend owners before quality follow-up, got ${JSON.stringify(koreanMixedContextRoles)}`,
  );
  assert(
    koreanMixedContextBackendCall?.instruction.includes("백엔드 회원가입/로그인 API 계약이 깨졌습니다") &&
      koreanMixedContextBackendCall.instruction.includes("프론트 설정 화면에서 Dev 로그인 버튼이 막혀 있습니다") &&
      koreanMixedContextFrontendCall?.instruction.includes("백엔드 회원가입/로그인 API 계약이 깨졌습니다") &&
      koreanMixedContextFrontendCall.instruction.includes("프론트 설정 화면에서 Dev 로그인 버튼이 막혀 있습니다"),
    `Korean mixed-context repair should preserve both Korean findings in each repair command, got backend=${JSON.stringify(koreanMixedContextBackendCall?.instruction ?? "")} frontend=${JSON.stringify(koreanMixedContextFrontendCall?.instruction ?? "")}`,
  );
  const koreanFrontendOnlyCalls = await runKoreanFrontendLoginButtonReworkCascade();
  const koreanFrontendOnlyRoles = koreanFrontendOnlyCalls.map((call) => call.role);
  assert(
    JSON.stringify(koreanFrontendOnlyRoles) === JSON.stringify(["reviewer", "frontend", "reviewer", "verifier"]),
    `Korean frontend-only login button rework should not over-route to backend, got ${JSON.stringify(koreanFrontendOnlyRoles)}`,
  );

  const desktopDeveloperVerifierReworkRun = await runDesktopDeveloperVerifierReworkCascade();
  const desktopDeveloperVerifierRoles = desktopDeveloperVerifierReworkRun.calls.map((call) => call.role);
  const desktopDeveloperVerifierCall = desktopDeveloperVerifierReworkRun.calls.find(
    (call) => call.role === "developer",
  );
  assert(
    JSON.stringify(desktopDeveloperVerifierRoles) ===
      JSON.stringify(["verifier", "developer", "reviewer", "verifier"]),
    `Desktop roster verifier rework should route through developer, then reviewer, then verifier, got ${JSON.stringify(desktopDeveloperVerifierRoles)}`,
  );
  assert(
    desktopDeveloperVerifierCall?.instruction.includes("Quality gate feedback requires another repair cycle") &&
      desktopDeveloperVerifierCall.instruction.includes("SequencerCoordinator") &&
      desktopDeveloperVerifierCall.instruction.includes("cli.rs"),
    `Desktop verifier rework should preserve the shared hotspot evidence for developer ownership, got ${JSON.stringify(desktopDeveloperVerifierCall?.instruction ?? "")}`,
  );

  const executionCompletionEvents = await runExecutionCompletionCallbackCascade();
  assert(
    JSON.stringify(executionCompletionEvents.map((event) => `${event.officeRole}:${event.status}`)) ===
      JSON.stringify([
        "reviewer:needs_rework",
        "backend:completed",
        "reviewer:completed",
        "verifier:completed",
      ]),
    `Execution-completion callback should surface direct rework, repair, and verification statuses in order, got ${JSON.stringify(executionCompletionEvents)}`,
  );
  assert(
    executionCompletionEvents[0]?.summary.includes("Reviewer requested rework") &&
      executionCompletionEvents[1]?.summary.includes("backend-aligned auth compatibility issue"),
    `Execution-completion callback should preserve actionable summaries, got ${JSON.stringify(executionCompletionEvents)}`,
  );

  const mixedArtifactRun = await runMixedStreamArtifactRetentionCascade();
  try {
    const mixedArtifactLog = mixedArtifactRun.logs.find((entry) => entry.label === "AgentCommand(verifier)");
    assert(mixedArtifactLog != null, "Expected mixed-stream artifact direct-command log entry");
    assert(
      mixedArtifactLog?.stdout.includes("apps/web/src/application/sequencer/SequencerCoordinator.ts"),
      `Mixed-stream artifact output should retain existing FilesCreated entries, got ${JSON.stringify(mixedArtifactLog?.stdout ?? "")}`,
    );
    assert(
      mixedArtifactLog?.stdout.includes("Host command evidence:") &&
        mixedArtifactLog?.stdout.includes('{"suite":"sequencer","passed":12}') &&
        mixedArtifactLog?.stdout.includes("warning: using cached fixtures"),
      `Mixed-stream artifact output should merge host stdout/stderr into verification evidence, got ${JSON.stringify(mixedArtifactLog?.stdout ?? "")}`,
    );
    assert(
      mixedArtifactLog?.stderr === "",
      `Mixed-stream artifact output should collapse stderr into combined stdout before logging, got stderr=${JSON.stringify(mixedArtifactLog?.stderr ?? "")}`,
    );
    const mixedArtifacts = await readdir(
      join(mixedArtifactRun.workspace, "tmp", "verification", "smoke-verification"),
    );
    assert(
      mixedArtifacts.length === 1,
      `Mixed-stream artifact retention should write exactly one verification artifact, got ${JSON.stringify(mixedArtifacts)}`,
    );
    const mixedArtifactRelativePath = `tmp/verification/smoke-verification/${mixedArtifacts[0]}`;
    assert(
      mixedArtifactLog?.stdout.includes(mixedArtifactRelativePath),
      `Mixed-stream artifact output should include the artifact path alongside existing files, got ${JSON.stringify(mixedArtifactLog?.stdout ?? "")}`,
    );
    const mixedStepResultBody =
      mixedArtifactLog?.stdout.match(/\[STEP_\d+_RESULT\]([\s\S]*?)\[\/STEP_\d+_RESULT\]/i)?.[1] ?? "";
    assert(
      mixedStepResultBody.includes(mixedArtifactRelativePath) &&
        mixedStepResultBody.includes("[Verification]") &&
        mixedStepResultBody.includes("[FilesCreated]"),
      `Mixed-stream artifact evidence should stay inside the step-result body for downstream parsing, got ${JSON.stringify(mixedStepResultBody)}`,
    );
    const mixedArtifact = JSON.parse(
      await readFile(join(mixedArtifactRun.workspace, mixedArtifactRelativePath), "utf8"),
    ) as {
      ok: boolean;
      sourceCommands: string[];
      runs: Array<{ command: string; exit_code: number; stdout: string; stderr: string }>;
    };
    assert(mixedArtifact.ok === true, "Mixed-stream artifact should capture successful host feedback status");
    assert(
      JSON.stringify(mixedArtifact.sourceCommands) ===
        JSON.stringify(["npm run verify:sequencer -- --reporter json"]),
      `Mixed-stream artifact should persist the source host commands, got ${JSON.stringify(mixedArtifact.sourceCommands)}`,
    );
    assert(
      mixedArtifact.runs[0]?.command === "npm run verify:sequencer -- --reporter json" &&
        mixedArtifact.runs[0]?.exit_code === 0 &&
        mixedArtifact.runs[0]?.stdout.includes('{"suite":"sequencer","passed":12}') &&
        mixedArtifact.runs[0]?.stderr.includes("warning: using cached fixtures"),
      `Mixed-stream artifact should preserve mixed stdout/stderr host evidence, got ${JSON.stringify(mixedArtifact.runs[0] ?? null)}`,
    );
  } finally {
    await rm(mixedArtifactRun.workspace, { recursive: true, force: true });
  }

  const browserLikeArtifactRun = await runBrowserLikeVerifierArtifactCascade();
  const browserLikeArtifactLog = browserLikeArtifactRun.logs.find(
    (entry) => entry.label === "AgentCommand(verifier)",
  );
  assert(browserLikeArtifactLog != null, "Expected browser-like artifact direct-command log entry");
  assert(
    browserLikeArtifactLog?.stdout.includes("apps/web/src/application/sequencer/SequencerCoordinator.ts"),
    `Browser-like verifier output should retain existing FilesCreated entries, got ${JSON.stringify(browserLikeArtifactLog?.stdout ?? "")}`,
  );
  assert(
    browserLikeArtifactLog?.stdout.includes("Host command evidence:") &&
      browserLikeArtifactLog?.stdout.includes('{"suite":"sequencer","passed":12}') &&
      browserLikeArtifactLog?.stdout.includes("warning: browser-mode skipped artifact persistence"),
    `Browser-like verifier output should preserve mixed host verification evidence, got ${JSON.stringify(browserLikeArtifactLog?.stdout ?? "")}`,
  );
  assert(
    !browserLikeArtifactLog?.stdout.includes("tmp/verification/smoke-verification/"),
    `Browser-like verifier output should skip Node-only artifact paths, got ${JSON.stringify(browserLikeArtifactLog?.stdout ?? "")}`,
  );
  assert(
    !browserLikeArtifactLog?.stdout.includes("Artifact: "),
    `Browser-like verifier output should omit artifact labels when persistence is skipped, got ${JSON.stringify(browserLikeArtifactLog?.stdout ?? "")}`,
  );
  const browserLikeStepResultBody =
    browserLikeArtifactLog?.stdout.match(/\[STEP_\d+_RESULT\]([\s\S]*?)\[\/STEP_\d+_RESULT\]/i)?.[1] ?? "";
  assert(
    browserLikeStepResultBody.includes("[Verification]") &&
      browserLikeStepResultBody.includes("[FilesCreated]") &&
      !browserLikeStepResultBody.includes("Artifact: "),
    `Browser-like verification evidence should stay inside the step-result body without artifact labels, got ${JSON.stringify(browserLikeStepResultBody)}`,
  );
  assert(
    browserLikeArtifactLog?.stderr === "",
    `Browser-like verifier output should collapse stderr into combined stdout before logging, got stderr=${JSON.stringify(browserLikeArtifactLog?.stderr ?? "")}`,
  );

  console.log("SequencerCoordinator regression tests passed");
  } finally {
    await cleanupFixedSequencerTestWorkspaces();
  }
}

function isDirectRun(): boolean {
  const entry = globalThis.process?.argv?.[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runSequencerCoordinatorRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
