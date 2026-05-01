import {
  buildProjectCliSessionKey,
  getAgentPrompt,
  getSavedWorkspacePath,
  getSkillPromptForRole,
  resolveProjectWorkspacePath,
  runCliCommand,
} from "../services/tauriCli";
import { useCliLogStore } from "../stores/cliLogStore";
import type { AgentRole } from "../types/agent";
import type { ExecutionIntent, JsonValue } from "../types/runtime";

export interface ExecutionConnectorOutcome {
  status: "completed" | "failed";
  result_summary: string;
  raw_output: string;
}

const CONNECTOR_GUIDANCE: Record<ExecutionIntent["kind"], string[]> = {
  open_pull_request: [
    "Attempt the real pull request flow using available git, GitHub, or project automation tools.",
    "If the environment lacks auth or PR tooling, prepare the exact PR title, summary, changed files, and blocker instead of pretending it succeeded.",
    "Do not merge, deploy, or alter production systems as part of this action.",
  ],
  deploy_release: [
    "Attempt the real deploy flow only through the project's existing deploy scripts or environment tools.",
    "Run the minimum safe prechecks first and report concrete results.",
    "If deployment cannot proceed, stop and report the exact missing prerequisite or failed precheck.",
  ],
  publish_content: [
    "Attempt the real publish flow using any available channel tooling, scripts, or connector credentials in the environment.",
    "If direct publishing is blocked, prepare the exact publish-ready payload and explain the blocker.",
    "Do not fabricate successful publication.",
  ],
  launch_campaign: [
    "Attempt the real campaign launch using any available ads or campaign tooling in the environment.",
    "If launch cannot proceed, prepare the final campaign package and explain the concrete blocker.",
    "Do not fabricate spend or reach results.",
  ],
  publish_asset: [
    "Attempt the real asset export or publish flow using the available design or asset tooling.",
    "If external publishing is unavailable, produce the ready-to-ship asset handoff and explain the blocker.",
    "Do not claim publication unless a real command succeeded.",
  ],
  run_ops_action: [
    "Attempt the approved runtime or operations action using the project's existing scripts or infrastructure tooling.",
    "Capture the concrete command outcome, health check, or blocker.",
    "Do not claim the system changed unless the command actually succeeded.",
  ],
  submit_budget_update: [
    "Attempt the real finance or budget update only if tooling and credentials already exist in the environment.",
    "If not, prepare the exact approved change set and explain the blocker.",
    "Do not fabricate a ledger update.",
  ],
};

function trimText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 3))}...`;
}

function payloadPreview(payload: JsonValue): string {
  try {
    return trimText(JSON.stringify(payload, null, 2), 1600);
  } catch {
    return "{}";
  }
}

export function summarizeConnectorOutput(stdout: string, stderr: string, exitCode: number): string {
  const primary = [stdout.trim(), stderr.trim()].filter(Boolean)[0] ?? `exit ${exitCode}`;
  return trimText(primary.replace(/\s+/g, " "), 240);
}

export function buildExecutionConnectorInstruction(intent: ExecutionIntent): string {
  const guidance = CONNECTOR_GUIDANCE[intent.kind] ?? [];
  const bullets = guidance.map((line) => `- ${line}`).join("\n");
  return [
    "Execute the following approved connector action.",
    "",
    `Connector: ${intent.connector_id}`,
    `Kind: ${intent.kind}`,
    `Title: ${intent.title}`,
    `Description: ${intent.description}`,
    `Target: ${intent.target}`,
    "",
    "Execution rules:",
    bullets,
    "",
    "Payload:",
    payloadPreview(intent.payload),
    "",
    "Return a concise factual outcome describing what really happened, what was changed, and any blockers.",
  ].join("\n");
}

export async function executeApprovedIntent(intent: ExecutionIntent): Promise<ExecutionConnectorOutcome> {
  const workspacePath = intent.project_id
    ? await resolveProjectWorkspacePath(intent.project_id)
    : getSavedWorkspacePath();
  if (intent.project_id && (!workspacePath || workspacePath.trim() === "")) {
    return {
      status: "failed",
      result_summary: "project workspace unavailable",
      raw_output: "",
    };
  }
  const [agentPrompt, skillPrompt] = await Promise.all([
    getAgentPrompt("agent"),
    getSkillPromptForRole(intent.agent_role),
  ]);
  const systemPrompt = [
    agentPrompt,
    skillPrompt,
    "You are executing an already-approved connector action.",
    "Prefer real commands and project automation over descriptions.",
    "If a prerequisite is missing, stop and report the blocker explicitly.",
  ]
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
  const instruction = buildExecutionConnectorInstruction(intent);
  const cliResult = await runCliCommand(instruction, {
    cwd: workspacePath ?? null,
    systemPrompt,
    projectName: intent.project_id ?? null,
    sessionKey: buildProjectCliSessionKey(intent.project_id ?? "local", [
      "intent",
      intent.agent_role,
      intent.agent_id,
      intent.kind,
    ]),
  });

  if (!cliResult) {
    return {
      status: "failed",
      result_summary: "connector execution unavailable",
      raw_output: "",
    };
  }

  useCliLogStore.getState().addEntry({
    stdin: instruction,
    stdout: cliResult.stdout,
    stderr: cliResult.stderr,
    exit_code: cliResult.exit_code,
    provider: cliResult.provider,
    label: `Intent: ${intent.kind}`,
    officeAgentRole: intent.agent_role as AgentRole,
    officeAgentId: intent.agent_id,
  });

  return {
    status: cliResult.exit_code === 0 ? "completed" : "failed",
    result_summary: summarizeConnectorOutput(cliResult.stdout, cliResult.stderr, cliResult.exit_code),
    raw_output: [cliResult.stdout.trim(), cliResult.stderr.trim()].filter(Boolean).join("\n\n"),
  };
}
