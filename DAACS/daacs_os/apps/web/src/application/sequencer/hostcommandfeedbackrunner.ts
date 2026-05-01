import type { AgentRole } from "../../types/agent";
import {
  isInvalidSequencerCliCommand,
  isSequencerInternalArtifactCommand,
} from "./HostCommandGuards";

export const HOST_COMMAND_FEEDBACK_SYSTEM_PROMPT = `The host has executed a shell command in the workspace. Your user message is a single JSON object with this shape:
{"command":"<shell command string>","result":{"exit_code":number,"stdout":string,"stderr":string}}

Review the result. 

CRITICAL RULES:
- NO META-COMMUNICATION: Do NOT use \`echo\`, \`printf\`, or similar commands to explain errors to the host.
- NO PLACEHOLDERS: Do NOT emit placeholder text like \`first shell command\` or \`...\`. Output EXACT, valid commands.
- VALIDATE INTENT: If the previous command was a message/warning and NOT the solution to the original task, do NOT return OK.
- FAILED VERIFICATION COMMANDS ARE NOT OK: If \`result.exit_code\` is non-zero for a test, build, lint, smoke, verify, preview, run, or other user-facing validation command, do NOT return OK. Return corrective [Commands] or \`ABORT:\` instead.
- PACKAGE AUDIT WARNINGS ARE NOT OK: If a package install/audit command reports moderate, high, or critical vulnerabilities, do NOT return OK. Request a narrow audit check or report \`ABORT: package audit repair required\`.

If the intended outcome was achieved, and no further shell work is needed, respond with exactly one line:
OK

If you cannot determine the correct shell command to fix the issue, respond EXACTLY with:
ABORT: <reason>

If follow-up or corrected shell commands are required, respond ONLY with a block in this exact form (numbered lines, no prose outside the block):
[Commands]
1. first shell command
2. second shell command
[/Commands]

Do not wrap your response in markdown fences.`;

export type HostCommandFeedbackCliLog = {
  stdin: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  provider?: string;
  label: string;
  officeAgentRole: AgentRole;
};

export type HostCommandExecutionRecord = {
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  provider?: string;
  feedback: string;
  feedback_exit_code: number;
  followupCommands: string[];
};

export type RunHostCommandsWithAgentFeedbackResult = {
  ok: boolean;
  runs: HostCommandExecutionRecord[];
};

type CliRunResultLike = {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  provider?: string;
} | null | undefined;

export type RunHostCommandsWithAgentFeedbackParams = {
  commands: string[];
  workspace: string | null | undefined;
  cwdForCli: string | null | undefined;
  cliProvider: string | null;
  feedbackSessionKey?: string | null;
  officeAgentRole: AgentRole;
  logLabelPrefix: string;
  runWorkspaceCommand: (
    InCommand: string,
    InCwd: string | null | undefined,
  ) => Promise<CliRunResultLike>;
  extractCommandsFromAgentText: (InText: string) => Promise<string[]>;
  shouldSkipHostCommand?: (InCommand: string) => boolean;
  runAgentCli: (
    InUserMessage: string,
    InOptions: {
      systemPrompt: string;
      cwd?: string | null;
      provider?: string | null;
      sessionKey?: string | null;
    },
  ) => Promise<unknown>;
  onCliLog: (InEntry: HostCommandFeedbackCliLog) => void;
  maxCommandDepth?: number;
  maxRoundsPerCommand?: number;
  maxTotalWorkspaceRuns?: number;
  maxQualityReadOnlyEvidenceRuns?: number;
};

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_MAX_TOTAL_RUNS = 200;
const MAX_BODY_CHARS = 6000;

export function ParseHostCommandFeedbackOk(InText: string): boolean {
  const raw = (InText ?? "").trim();
  if (raw === "") return false;
  if (/\[commands\]/i.test(raw)) return false;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length !== 1) return false;
  return /^OK$/i.test(lines[0] ?? "");
}

function CombineCliText(InResult: CliRunResultLike): string {
  if (InResult == null) return "";
  const a = (InResult.stdout ?? "").trim();
  const b = (InResult.stderr ?? "").trim();
  if (a !== "" && b !== "") return `${a}\n${b}`.trim();
  return a !== "" ? a : b;
}

function AsCliResult(InRaw: unknown): CliRunResultLike {
  if (InRaw == null || typeof InRaw !== "object") return InRaw as CliRunResultLike;
  const o = InRaw as Record<string, unknown>;
  return {
    stdout: typeof o.stdout === "string" ? o.stdout : undefined,
    stderr: typeof o.stderr === "string" ? o.stderr : undefined,
    exit_code: typeof o.exit_code === "number" ? o.exit_code : -1,
    provider: typeof o.provider === "string" ? o.provider : undefined,
  };
}

function CombineCliStreamsForParsing(InResult: CliRunResultLike): string {
  return CombineCliText(InResult);
}

function HasHostFeedbackFailureSignal(InText: string): boolean {
  return (InText ?? "")
    .split(/\r?\n/)
    .some((line) => /^ABORT:/i.test(line.trim()));
}

function HasBenignZeroExitVerificationStderr(
  InCommand: string,
  InResult: CliRunResultLike,
): boolean {
  const exitCode = Number(InResult?.exit_code ?? -1);
  if (exitCode !== 0) return false;
  if (!LooksLikePackageManagerVerificationCommand(InCommand)) return false;
  const stdout = InResult?.stdout ?? "";
  const stderrLines = (InResult?.stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (stderrLines.length === 0) return false;
  const onlyKnownBenignToolNoise = stderrLines.every((line) =>
    /^(?:✘\s*)?\[ERROR\]\s+The build was canceled$/i.test(line) ||
    /^The build was canceled$/i.test(line),
  );
  if (!onlyKnownBenignToolNoise) return false;
  return /\b(?:PASS|passed|success(?:ful)?|smoke\s+passed|tests?\s+passed|all\s+tests?\s+passed|✓\s*built|built\s+in|통과|성공)\b/i.test(stdout);
}

function IsContextInsufficientAbort(InText: string): boolean {
  const text = (InText ?? "").trim().toLowerCase();
  if (!text.startsWith("abort:")) return false;
  return (
    text.includes("do not have enough context") ||
    text.includes("don't have enough context") ||
    text.includes("not enough context") ||
    text.includes("cannot determine whether any follow-up") ||
    text.includes("can't determine whether any follow-up") ||
    text.includes("cannot determine if any follow-up") ||
    text.includes("can't determine if any follow-up")
  );
}

function IsPlaceholderFollowupCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim().toLowerCase();
  if (cmd === "" || cmd === "...") return true;
  if (cmd.includes("placeholder")) return true;
  return (
    cmd === "first shell command" ||
    cmd === "second shell command" ||
    cmd === "next shell command" ||
    cmd === "another shell command"
  );
}

const EXPLORATORY_FOLLOWUP_PREFIXES = [
  "rg ",
  "grep ",
  "ag ",
  "find ",
  "ls",
  "pwd",
  "cat ",
  "sed ",
  "head ",
  "tail ",
  "less ",
  "more ",
  "wc ",
];

function IsExploratoryFollowupCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim().toLowerCase();
  if (cmd === "") return false;
  const segments = SplitShellCommandSegments(cmd);
  return segments.some((segment) =>
    EXPLORATORY_FOLLOWUP_PREFIXES.some(
      (prefix) => segment === prefix.trim() || segment.startsWith(prefix),
    ),
  );
}

function IsReadOnlyDiagnosticCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim();
  return cmd !== "" && IsExploratoryFollowupCommand(cmd) && !CanWorkspaceCommandChangeState(cmd);
}

function IsGeneratedVerificationArtifactReadCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim();
  if (cmd === "" || !IsReadOnlyDiagnosticCommand(cmd)) return false;
  return /(?:^|[\s"'`])(?:\.\/)?tmp\/verification\/smoke-verification\/[^;&|]+\.json\b/i.test(cmd) ||
    /\/tmp\/verification\/smoke-verification\/[^;&|]+\.json\b/i.test(cmd);
}

function IsFailureDiagnosticReadFollowupAllowed(
  InOriginalCommand: string,
  InFollowupCommand: string,
  InWorkspaceFailed: boolean,
): boolean {
  if (!InWorkspaceFailed) return false;
  const original = (InOriginalCommand ?? "").toLowerCase();
  if (
    !/(?:smoke|playwright|pytest|python3?\s+-m\s+unittest|npm\s+(?:--prefix\s+\S+\s+)?(?:(?:run\s+)?(?:test|verify|lint|build|smoke)(?::[\w-]+)?|test)|pnpm\s+(?:--dir\s+\S+\s+)?(?:run\s+)?(?:test|verify|lint|build|smoke)(?::[\w-]+)?)/.test(
      original,
    )
  ) {
    return false;
  }
  return IsExploratoryFollowupCommand(InFollowupCommand);
}

function IsActionableFollowupCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim();
  if (cmd === "") return false;
  return /[A-Za-z0-9]/.test(cmd);
}

function SplitShellCommandSegments(InCommand: string): string[] {
  const command = InCommand ?? "";
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const segment = current.trim();
    if (segment !== "") segments.push(segment);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index] ?? "";
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote != null) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    const twoChars = command.slice(index, index + 2);
    if (twoChars === "&&" || twoChars === "||") {
      pushCurrent();
      index += 1;
      continue;
    }
    if (ch === ";" || ch === "|") {
      pushCurrent();
      continue;
    }
    current += ch;
  }
  pushCurrent();
  return segments;
}

function IsCdShellSegment(InCommand: string): boolean {
  return /^cd(?:\s+|$)/i.test((InCommand ?? "").trim());
}

function NormalizeRunnableShellSegment(InCommand: string): string {
  return (InCommand ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .replace(/^python\s+-m\s+/, "python3 -m ");
}

function NonCdShellSegments(InCommand: string): string[] {
  return SplitShellCommandSegments(InCommand).filter((segment) => !IsCdShellSegment(segment));
}

function IsCwdCorrectedSameRunnableCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
): boolean {
  const originalSegments = NonCdShellSegments(InOriginalCommand).map(NormalizeRunnableShellSegment);
  const followupSegments = NonCdShellSegments(InFollowupCommand).map(NormalizeRunnableShellSegment);
  if (originalSegments.length === 0 || originalSegments.length !== followupSegments.length) {
    return false;
  }
  return originalSegments.every((segment, index) => segment === followupSegments[index]);
}

function StripLeadingCdChain(InCommand: string): string {
  let text = (InCommand ?? "").trim();
  while (true) {
    const next = text.replace(/^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*/i, "").trim();
    if (next === text) return text;
    text = next;
  }
}

function NormalizeNonInteractiveTestCommand(InCommand: string): string {
  const { prefix, body } = SplitLeadingCdChain(InCommand);
  const trimmedBody = body.trim();
  if (trimmedBody === "") return InCommand;
  const hasNonInteractiveFlag =
    /(?:^|\s)(?:--run|--watch=false|--watch\s+false|--ci)(?:\s|$)/i.test(trimmedBody) ||
    /^(?:npx\s+)?vitest\s+run(?:\s|$)/i.test(trimmedBody) ||
    /\s--\s+.*(?:^|\s)(?:run|--run|--watch=false|--watch\s+false|--ci)(?:\s|$)/i.test(trimmedBody);
  if (hasNonInteractiveFlag) return InCommand.trim();

  const vitestMatch = trimmedBody.match(/^((?:npx\s+)?vitest)(\s+.+)?$/i);
  if (vitestMatch?.[1] != null) {
    const rest = vitestMatch[2]?.trim() ?? "";
    return `${prefix}${vitestMatch[1]} run${rest !== "" ? ` ${rest}` : ""}`.trim();
  }

  const npmTestMatch = trimmedBody.match(/^((?:npm|pnpm|yarn|bun)\s+(?:(?:run\s+)?test))(?:\s+(.+))?$/i);
  if (npmTestMatch?.[1] == null) return InCommand.trim();
  const invocation = npmTestMatch[1].trim();
  const rest = npmTestMatch[2]?.trim() ?? "";
  const normalizedRest = rest.replace(/^--\s*/, "").trim();
  return `${prefix}${invocation} -- --run${normalizedRest !== "" ? ` ${normalizedRest}` : ""}`.trim();
}

function NormalizeShellCommandForContainment(InCommand: string): string {
  return (InCommand ?? "").trim().replace(/\s+/g, " ");
}

function IsSetupWrappedSameRunnableCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
): boolean {
  const original = NormalizeShellCommandForContainment(StripLeadingCdChain(InOriginalCommand));
  if (original.length < 24 && !LooksLikePackageManagerVerificationCommand(InOriginalCommand)) return false;
  const followup = NormalizeShellCommandForContainment(InFollowupCommand);
  return followup.includes(original);
}

function SplitLeadingCdChain(InCommand: string): { prefix: string; body: string } {
  let body = (InCommand ?? "").trim();
  let prefix = "";
  while (true) {
    const match = body.match(/^(cd\s+(?:"[^"]+"|'[^']+'|\S+)\s*&&\s*)/i);
    if (match?.[1] == null) return { prefix, body };
    prefix += match[1];
    body = body.slice(match[1].length).trim();
  }
}

function StripLeadingEnvAssignments(InCommand: string): string {
  return (InCommand ?? "")
    .trim()
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/g, "")
    .trim();
}

function LooksLikePackageManagerVerificationCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return segments.some((cmd) =>
    /^(?:npm|pnpm|yarn|bun)\s+(?:(?:--(?:prefix|dir)\s+\S+\s+)?(?:run\s+)?(?:test|build|lint|verify|smoke)(?::[\w-]+)?|test|build|lint)(?:\s|$)/.test(
      cmd,
    ),
  );
}

function DetectPackageManager(InCommand: string): "npm" | "pnpm" | "yarn" | "bun" | null {
  for (const segment of NonCdShellSegments(InCommand)) {
    const cmd = StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment));
    if (/^pnpm(?:\s|$)/.test(cmd)) return "pnpm";
    if (/^yarn(?:\s|$)/.test(cmd)) return "yarn";
    if (/^bun(?:\s|$)/.test(cmd)) return "bun";
    if (/^npm(?:\s|$)/.test(cmd)) return "npm";
  }
  return null;
}

function IsPackageInstallCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return segments.some((cmd) =>
    /^(?:npm\s+(?:install|i|ci)|pnpm\s+install|yarn\s+(?:install|--immutable)|bun\s+install)(?:\s|$)/.test(cmd),
  );
}

function IsPackageAuditCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return segments.some((cmd) =>
    /^(?:npm\s+audit|pnpm\s+audit|yarn\s+(?:npm\s+)?audit|bun\s+audit)(?:\s|$)/.test(cmd),
  );
}

function HasActionablePackageAuditSignal(InText: string): boolean {
  const text = String(InText ?? "");
  if (text.trim() === "") return false;
  if (/\bfound\s+0\s+vulnerabilities\b/i.test(text)) return false;
  return (
    /\b(?:moderate|high|critical)\s+severity\s+vulnerabilit(?:y|ies)\b/i.test(text) ||
    /\bSeverity:\s*(?:moderate|high|critical)\b/i.test(text) ||
    /\bnpm audit report\b/i.test(text)
  );
}

function BuildPackageAuditCommand(InCommand: string): string {
  const { prefix } = SplitLeadingCdChain(InCommand);
  const packageManager = DetectPackageManager(InCommand);
  switch (packageManager) {
    case "pnpm":
      return `${prefix}pnpm audit --audit-level=moderate`;
    case "yarn":
      return `${prefix}yarn npm audit --severity moderate`;
    case "bun":
      return `${prefix}bun audit`;
    case "npm":
    default:
      return `${prefix}npm audit --audit-level=moderate`;
  }
}

function BuildPackageInstallCommand(InPackageManager: "npm" | "pnpm" | "yarn" | "bun"): string {
  switch (InPackageManager) {
    case "pnpm":
      return "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return "bun install";
    case "npm":
    default:
      return "npm install --no-audit --no-fund";
  }
}

function HasMissingLocalNodeBinarySignal(InResult: CliRunResultLike): boolean {
  const stdout = InResult?.stdout ?? "";
  const stderr = InResult?.stderr ?? "";
  const combined = `${stdout}\n${stderr}`;
  const printedPackageScript = />\s+[^\n]+\n>\s+[^\n]+/.test(stdout);
  const exitCode = Number(InResult?.exit_code ?? 0);
  const missingCommonLocalNodeTool =
    /(?:sh|zsh|bash):\s*(?:\d+:\s*)?(?:tsc|vite|vitest|react-scripts|tsx|eslint|webpack|rollup|next|astro|playwright|jest):\s+command not found/i.test(combined) ||
    /(?:command not found:\s*)(?:tsc|vite|vitest|react-scripts|tsx|eslint|webpack|rollup|next|astro|playwright|jest)\b/i.test(combined) ||
    /\b(?:Cannot find module|Cannot find package|ERR_MODULE_NOT_FOUND)\b[\s\S]{0,220}\b(?:typescript|vite|vitest|react|react-dom|@vitejs\/plugin-react|tsx|eslint|webpack|rollup|next|astro|@playwright\/test|jest)\b/i.test(combined);
  return (
    missingCommonLocalNodeTool ||
    printedPackageScript &&
    (
      exitCode === 127 ||
      /(?:sh|zsh|bash):\s*(?:\d+:\s*)?[\w.-]+:\s+command not found/i.test(combined)
    )
  );
}

function BuildDependencySetupWrappedCommand(
  InOriginalCommand: string,
  InResult: CliRunResultLike,
): string | null {
  if (!LooksLikePackageManagerVerificationCommand(InOriginalCommand)) return null;
  if (!HasMissingLocalNodeBinarySignal(InResult)) return null;
  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|ci)\b/i.test(InOriginalCommand)) return null;
  const packageManager = DetectPackageManager(InOriginalCommand);
  if (packageManager == null) return null;
  const { prefix, body } = SplitLeadingCdChain(InOriginalCommand);
  const installCommand = BuildPackageInstallCommand(packageManager);
  return `${prefix}${installCommand} && ${body}`.trim();
}

function NormalizeDependencySetupFollowups(
  InOriginalCommand: string,
  InResult: CliRunResultLike,
  InWorkspaceFailed: boolean,
  InFollowups: string[],
): string[] {
  if (!InWorkspaceFailed) return InFollowups;
  const setupWrapped = BuildDependencySetupWrappedCommand(InOriginalCommand, InResult);
  if (setupWrapped == null) return InFollowups;
  const hasInstallThenVerification =
    InFollowups.some(IsPackageInstallCommand) &&
    InFollowups.some(
      (followup) =>
        IsSetupWrappedSameRunnableCommand(InOriginalCommand, `${BuildPackageInstallCommand(DetectPackageManager(InOriginalCommand) ?? "npm")} && ${followup}`) ||
        NormalizeShellCommandForContainment(followup).includes(
          NormalizeShellCommandForContainment(StripLeadingCdChain(InOriginalCommand)),
        ),
    );
  if (hasInstallThenVerification) {
    return [
      setupWrapped,
      ...InFollowups.filter(
        (followup) =>
          !IsPackageInstallCommand(followup) &&
          !NormalizeShellCommandForContainment(followup).includes(
            NormalizeShellCommandForContainment(StripLeadingCdChain(InOriginalCommand)),
          ),
      ),
    ];
  }
  const hasSupersedingSetup = InFollowups.some((followup) =>
    IsSetupWrappedSameRunnableCommand(InOriginalCommand, followup),
  );
  if (hasSupersedingSetup) return InFollowups;
  return [setupWrapped, ...InFollowups.filter((followup) => !IsExploratoryFollowupCommand(followup))];
}

function LooksLikeVerificationCommandSegment(InCommand: string): boolean {
  const cmd = NormalizeRunnableShellSegment(InCommand);
  return (
    /^(?:npm|pnpm)\s+(?:--(?:prefix|dir)\s+\S+\s+)?(?:run\s+)?(?:test|verify|lint|smoke)(?::[\w-]+)?(?:\s|$)/.test(cmd) ||
    /^(?:npx\s+)?playwright\s+test(?:\s|$)/.test(cmd) ||
    /^(?:pytest|python3?\s+-m\s+pytest)(?:\s|$)/.test(cmd) ||
    /^python3?\s+-m\s+unittest(?:\s|$)/.test(cmd) ||
    /^cargo\s+test(?:\s|$)/.test(cmd) ||
    /^node\s+--import\s+tsx\s+\S+(?:\s|$)/.test(cmd)
  );
}

function LooksLikeInitialQualityGateVerificationSegment(InCommand: string): boolean {
  const cmd = StripLeadingEnvAssignments(NormalizeRunnableShellSegment(InCommand));
  return (
    /^(?:npm|pnpm|yarn|bun)\s+(?:(?:--(?:prefix|dir)\s+\S+\s+)?(?:run\s+)?(?:test|build|lint|verify|smoke)(?::[\w-]+)?|test|build|lint)(?:\s|$)/.test(
      cmd,
    ) ||
    /^(?:npx\s+)?playwright\s+test(?:\s|$)/.test(cmd) ||
    /^(?:pytest|python3?\s+-m\s+pytest)(?:\s|$)/.test(cmd) ||
    /^python3?\s+-m\s+unittest(?:\s|$)/.test(cmd) ||
    /^cargo\s+test(?:\s|$)/.test(cmd) ||
    /^node\s+--import\s+tsx\s+\S+(?:\s|$)/.test(cmd)
  );
}

function LooksLikeInitialQualityGateSetupSegment(InCommand: string): boolean {
  const cmd = StripLeadingEnvAssignments(NormalizeRunnableShellSegment(InCommand));
  return /^(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+(?:install|add)|bun\s+install)(?:\s|$)/.test(cmd);
}

function LooksLikeInitialQualityGateSetupCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return segments.length > 0 && segments.every(LooksLikeInitialQualityGateSetupSegment);
}

function LooksLikeInitialQualityGateVerificationCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return segments.length > 0 && segments.every(LooksLikeInitialQualityGateVerificationSegment);
}

function LooksLikeInitialQualityGateBatchCommand(InCommand: string): boolean {
  const segments = NonCdShellSegments(InCommand).map((segment) =>
    StripLeadingEnvAssignments(NormalizeRunnableShellSegment(segment)),
  );
  return (
    segments.length > 0 &&
    segments.every((segment) =>
      LooksLikeInitialQualityGateVerificationSegment(segment) ||
      LooksLikeInitialQualityGateSetupSegment(segment),
    ) &&
    segments.some(LooksLikeInitialQualityGateVerificationSegment)
  );
}

function ShouldRunQualityGateVerificationBatch(
  InOfficeAgentRole: AgentRole,
  InCommands: string[],
): boolean {
  const uniqueCommands = new Set(InCommands.map((command) => NormalizeShellCommandForContainment(command)));
  return (
    IsQualityGateRole(InOfficeAgentRole) &&
    InCommands.length > 1 &&
    uniqueCommands.size === InCommands.length &&
    InCommands.every((command) =>
      LooksLikeInitialQualityGateBatchCommand(command) ||
      LooksLikeInitialQualityGateSetupCommand(command),
    ) &&
    InCommands.some(LooksLikeInitialQualityGateVerificationCommand)
  );
}

function StripRelaxableVerificationSelectorArgs(InCommand: string): string {
  let cmd = NormalizeRunnableShellSegment(InCommand);
  const selectorPatterns = [
    /\s+--\s+--grep(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)\s*$/i,
    /\s+--grep(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)\s*$/i,
    /\s+-g(?:=|\s+)(?:"[^"]*"|'[^']*'|\S+)\s*$/i,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of selectorPatterns) {
      const next = cmd.replace(pattern, "").trim();
      if (next !== cmd) {
        cmd = next;
        changed = true;
      }
    }
  }
  return cmd;
}

function IsSelectorRelaxedSameVerificationCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
): boolean {
  const originalSegments = NonCdShellSegments(InOriginalCommand);
  const followupSegments = NonCdShellSegments(InFollowupCommand);
  if (originalSegments.length !== 1 || followupSegments.length !== 1) return false;

  const original = NormalizeRunnableShellSegment(originalSegments[0] ?? "");
  const followup = NormalizeRunnableShellSegment(followupSegments[0] ?? "");
  if (!LooksLikeVerificationCommandSegment(original) || !LooksLikeVerificationCommandSegment(followup)) {
    return false;
  }

  const relaxedOriginal = StripRelaxableVerificationSelectorArgs(original);
  return relaxedOriginal !== original && relaxedOriginal === followup;
}

function IsShellControlNoopSegment(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim().toLowerCase();
  return cmd === "true" || cmd === "false" || cmd === ":";
}

function CanShellSegmentChangeState(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim().toLowerCase();
  if (cmd === "") return false;
  if (IsShellControlNoopSegment(cmd)) return false;
  const hasShellWrite =
    /(?:^|[^<])>{1,2}\s*\S/.test(cmd) ||
    /(?:^|\s)tee\s+(?:-[a-z]+\s+)*\S/.test(cmd);
  if (hasShellWrite) return true;
  const hasMutatingTestFlag =
    /(?:^|\s)(?:-u|--update|--update-snapshot|--updatesnapshot|--snapshot-update|--write|--write-snapshot|--write-snapshots|--fix|--fix-type|--coverage|--cov|--coveragedirectory|--coverage-directory|--cache|--cache-directory|--cachedirectory|--clear-cache|--clearcache|--cache-clear)(?:=|\s|$)/.test(
      cmd,
    );
  const testRunnerReadOnlyPatterns = [
    /^node\s+--import\s+tsx\s+\S+(?:\s|$)/,
    /^npm\s+exec\s+tsx\s+\S+(?:\s|$)/,
    /^npm\s+--prefix\s+\S+\s+exec\s+tsx\s+\S+(?:\s|$)/,
    /^pnpm\s+exec\s+tsx\s+\S+(?:\s|$)/,
    /^pnpm\s+--dir\s+\S+\s+exec\s+tsx\s+\S+(?:\s|$)/,
  ];
  if (testRunnerReadOnlyPatterns.some((pattern) => pattern.test(cmd))) return hasMutatingTestFlag;

  const packageManagerTestPatterns = [
    /^npm\s+(?:test|lint)(?:\s|$)/,
    /^npm\s+run\s+(?:test|verify|lint|smoke)(?::[\w-]+)?(?:\s|$)/,
    /^npm\s+--prefix\s+\S+\s+(?:run\s+)?(?:test|verify|lint|smoke)(?::[\w-]+)?(?:\s|$)/,
    /^pnpm\s+(?:test|verify|lint|smoke)(?::[\w-]+)?(?:\s|$)/,
    /^pnpm\s+--dir\s+\S+\s+(?:run\s+)?(?:test|verify|lint|smoke)(?::[\w-]+)?(?:\s|$)/,
  ];
  if (packageManagerTestPatterns.some((pattern) => pattern.test(cmd))) return hasMutatingTestFlag;

  const readOnlyPrefixes = [
    "cargo test",
    "cd ",
    "pytest",
    "python -m pytest",
    "python3 -m pytest",
    "python -m unittest",
    "python3 -m unittest",
    "rg ",
    "grep ",
    "sed ",
    "cat ",
    "head ",
    "tail ",
    "less ",
    "more ",
    "wc ",
    "ls",
    "git diff",
    "git status",
  ];
  if (
    hasMutatingTestFlag &&
    readOnlyPrefixes.some((prefix) => cmd === prefix.trim() || cmd.startsWith(prefix))
  ) {
    return true;
  }
  return !readOnlyPrefixes.some((prefix) => cmd === prefix.trim() || cmd.startsWith(prefix));
}

function CanWorkspaceCommandChangeState(InCommand: string): boolean {
  const segments = SplitShellCommandSegments(InCommand);
  if (segments.length === 0) return false;
  return segments.some(CanShellSegmentChangeState);
}

function IsAllowedHostFeedbackFollowupCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
  InWorkspaceFailed: boolean,
): boolean {
  if (
    InWorkspaceFailed &&
    IsSelectorRelaxedSameVerificationCommand(InOriginalCommand, InFollowupCommand)
  ) {
    return true;
  }
  if (!CanWorkspaceCommandChangeState(InFollowupCommand)) return true;
  if (!InWorkspaceFailed) return false;
  if (
    LooksLikePackageManagerVerificationCommand(InOriginalCommand) &&
    IsPackageInstallCommand(InFollowupCommand)
  ) {
    return true;
  }
  if (
    LooksLikePackageManagerVerificationCommand(InOriginalCommand) &&
    LooksLikePackageManagerVerificationCommand(InFollowupCommand)
  ) {
    return true;
  }
  return (
    IsCwdCorrectedSameRunnableCommand(InOriginalCommand, InFollowupCommand) ||
    IsSetupWrappedSameRunnableCommand(InOriginalCommand, InFollowupCommand)
  );
}

function IsVerificationFollowupCommand(InCommand: string): boolean {
  const cmd = (InCommand ?? "").trim();
  return cmd !== "" && !CanWorkspaceCommandChangeState(cmd);
}

function IsQualityGateRole(InRole: AgentRole): boolean {
  return InRole === "reviewer" || InRole === "verifier";
}

function IsQualityGateDiagnosticToVerificationFollowupAllowed(
  InOriginalCommand: string,
  InFollowupCommand: string,
  InOfficeAgentRole: AgentRole,
): boolean {
  return (
    IsQualityGateRole(InOfficeAgentRole) &&
    IsReadOnlyDiagnosticCommand(InOriginalCommand) &&
    LooksLikePackageManagerVerificationCommand(InFollowupCommand)
  );
}

function IsQualityGateReadOnlyDiagnosticChainAllowed(
  InOriginalCommand: string,
  InFollowupCommand: string,
  InOfficeAgentRole: AgentRole,
): boolean {
  return (
    IsQualityGateRole(InOfficeAgentRole) &&
    IsReadOnlyDiagnosticCommand(InOriginalCommand) &&
    IsReadOnlyDiagnosticCommand(InFollowupCommand)
  );
}

function BuildHostCommandFeedbackSystemPrompt(InOfficeAgentRole: AgentRole): string {
  if (!IsQualityGateRole(InOfficeAgentRole)) return HOST_COMMAND_FEEDBACK_SYSTEM_PROMPT;
  return (
    `${HOST_COMMAND_FEEDBACK_SYSTEM_PROMPT}\n` +
    "\n" +
    "QUALITY GATE EXTRA RULES:\n" +
    "- REVIEWER/VERIFIER HOST FEEDBACK IS READ-ONLY: never propose file writes, source edits, heredoc file creation, or Python/Node one-liners that modify workspace files.\n" +
    "- Keep evidence gathering small: after a few successful read-only follow-ups, stop asking for more broad file reads and return OK if enough evidence exists, or `ABORT: evidence limit reached` if not.\n" +
    "- If a successful read-only command shows that more read-only evidence is needed, emit only the next narrow read-only [Commands] block; do not request full repository trees or full large source files.\n" +
    "- Do not request `cat tmp/verification/smoke-verification/*.json`; those generated artifacts are already summarized in the host evidence.\n" +
    "- Do not turn read-only evidence gaps into a repair unless implementation must change.\n" +
    "- If verification failed because implementation must change, do NOT emit mutating [Commands]. Respond with `ABORT: repair required` or only read-only verification commands."
  );
}

function IsAllowedQualityGateFollowupCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
  InWorkspaceFailed: boolean,
): boolean {
  if (!CanWorkspaceCommandChangeState(InFollowupCommand)) return true;
  if (!InWorkspaceFailed) return false;
  return (
    IsCwdCorrectedSameRunnableCommand(InOriginalCommand, InFollowupCommand) ||
    IsSetupWrappedSameRunnableCommand(InOriginalCommand, InFollowupCommand) ||
    IsExplicitSupersedingVerificationCommand(InOriginalCommand, InFollowupCommand)
  );
}

function CommandIntentTokens(InCommand: string): Set<string> {
  const stop = new Set([
    "apps",
    "bin",
    "dir",
    "build",
    "cargo",
    "lint",
    "node",
    "npm",
    "prefix",
    "pnpm",
    "pytest",
    "python",
    "python3",
    "run",
    "src",
    "test",
    "tests",
    "unittest",
    "verify",
    "web",
  ]);
  return new Set(
    (InCommand ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_-]+/g)
      .map((token) => token.trim().replace(/^-+/, ""))
      .filter((token) => token.length >= 3 && !stop.has(token)),
  );
}

function IsExplicitSupersedingVerificationCommand(
  InOriginalCommand: string,
  InFollowupCommand: string,
): boolean {
  if (!IsVerificationFollowupCommand(InOriginalCommand) || !IsVerificationFollowupCommand(InFollowupCommand)) {
    return false;
  }
  const originalTokens = CommandIntentTokens(InOriginalCommand);
  const followupTokens = CommandIntentTokens(InFollowupCommand);
  if (originalTokens.size === 0) return false;
  for (const token of originalTokens) {
    if (!followupTokens.has(token)) return false;
  }
  return true;
}

export async function RunHostCommandsWithAgentFeedback(
  InParams: RunHostCommandsWithAgentFeedbackParams,
): Promise<RunHostCommandsWithAgentFeedbackResult> {
  const maxDepth = InParams.maxCommandDepth ?? DEFAULT_MAX_DEPTH;
  const maxRounds = InParams.maxRoundsPerCommand ?? DEFAULT_MAX_ROUNDS;
  const maxTotalRuns = InParams.maxTotalWorkspaceRuns ?? DEFAULT_MAX_TOTAL_RUNS;
  const maxQualityReadOnlyEvidenceRuns = InParams.maxQualityReadOnlyEvidenceRuns ?? 2;
  let totalWorkspaceRuns = 0;
  let qualityReadOnlyEvidenceRuns = 0;
  const skip = InParams.shouldSkipHostCommand ?? (() => false);
  const ws = (InParams.workspace ?? "").trim();
  const runs: HostCommandExecutionRecord[] = [];
  if (ws === "") return { ok: false, runs };

  const initialCommands = InParams.commands
    .map((command) => NormalizeNonInteractiveTestCommand((command ?? "").trim()))
    .filter((command) => command !== "" && !isSequencerInternalArtifactCommand(command) && !skip(command));
  if (ShouldRunQualityGateVerificationBatch(InParams.officeAgentRole, initialCommands)) {
    for (const cmd of initialCommands) {
      if (isInvalidSequencerCliCommand(cmd)) {
        const stderr = `Rejected invalid host command before execution: ${cmd}`;
        InParams.onCliLog({
          stdin: cmd,
          stdout: "",
          stderr,
          exit_code: -1,
          label: `${InParams.logLabelPrefix}:workspace`,
          officeAgentRole: InParams.officeAgentRole,
        });
        runs.push({
          command: cmd,
          stdout: "",
          stderr,
          exit_code: -1,
          feedback: "ABORT: invalid host command rejected before execution",
          feedback_exit_code: 0,
          followupCommands: [],
        });
        return { ok: false, runs };
      }
      if (IsGeneratedVerificationArtifactReadCommand(cmd)) {
        const stderr = `Rejected generated verification artifact read before execution: ${cmd}`;
        InParams.onCliLog({
          stdin: cmd,
          stdout: "",
          stderr,
          exit_code: -1,
          label: `${InParams.logLabelPrefix}:workspace`,
          officeAgentRole: InParams.officeAgentRole,
        });
        runs.push({
          command: cmd,
          stdout: "",
          stderr,
          exit_code: -1,
          feedback: "ABORT: generated verification artifact files are already summarized; do not read them wholesale",
          feedback_exit_code: 0,
          followupCommands: [],
        });
        return { ok: false, runs };
      }
      if (totalWorkspaceRuns >= maxTotalRuns) return { ok: false, runs };
      totalWorkspaceRuns += 1;
      const wr = await InParams.runWorkspaceCommand(cmd, InParams.workspace ?? null);
      const exitCode = wr?.exit_code ?? -1;
      InParams.onCliLog({
        stdin: cmd,
        stdout: wr?.stdout ?? "",
        stderr: wr?.stderr ?? "",
        exit_code: exitCode,
        provider: wr?.provider,
        label: `${InParams.logLabelPrefix}:workspace`,
        officeAgentRole: InParams.officeAgentRole,
      });
      const combined = `${wr?.stdout ?? ""}\n${wr?.stderr ?? ""}`;
      const ok = exitCode === 0 && !HasHostFeedbackFailureSignal(combined);
      runs.push({
        command: cmd,
        stdout: wr?.stdout ?? "",
        stderr: wr?.stderr ?? "",
        exit_code: exitCode,
        provider: wr?.provider,
        feedback: ok
          ? "OK: verification command exited 0"
          : "ABORT: verification command failed",
        feedback_exit_code: 0,
        followupCommands: [],
      });
      if (!ok) return { ok: false, runs };
    }
    return { ok: true, runs };
  }

  const seenWorkspaceCommands = new Map<string, number>();
  const lastWorkspaceCommandExitCodes = new Map<string, number>();
  const successfulWorkspaceCommands = new Map<string, number>();
  let workspaceStateGeneration = 0;

  async function RunOne(InCommand: string, InDepth: number): Promise<boolean> {
    const cmd = NormalizeNonInteractiveTestCommand(InCommand);
    if (cmd === "") return true;
    if (isInvalidSequencerCliCommand(cmd)) {
      const stderr = `Rejected invalid host command before execution: ${cmd}`;
      InParams.onCliLog({
        stdin: cmd,
        stdout: "",
        stderr,
        exit_code: -1,
        label: `${InParams.logLabelPrefix}:workspace`,
        officeAgentRole: InParams.officeAgentRole,
      });
      runs.push({
        command: cmd,
        stdout: "",
        stderr,
        exit_code: -1,
        feedback: "ABORT: invalid host command rejected before execution",
        feedback_exit_code: 0,
        followupCommands: [],
      });
      return false;
    }
    if (
      IsQualityGateRole(InParams.officeAgentRole) &&
      IsGeneratedVerificationArtifactReadCommand(cmd)
    ) {
      const stderr = `Rejected generated verification artifact read before execution: ${cmd}`;
      InParams.onCliLog({
        stdin: cmd,
        stdout: "",
        stderr,
        exit_code: -1,
        label: `${InParams.logLabelPrefix}:workspace`,
        officeAgentRole: InParams.officeAgentRole,
      });
      runs.push({
        command: cmd,
        stdout: "",
        stderr,
        exit_code: -1,
        feedback: "ABORT: generated verification artifact files are already summarized; do not read them wholesale",
        feedback_exit_code: 0,
        followupCommands: [],
      });
      return false;
    }
      if (skip(cmd)) return true;
      if (InDepth > maxDepth) return false;
      if (
        IsQualityGateRole(InParams.officeAgentRole) &&
        IsReadOnlyDiagnosticCommand(cmd) &&
        qualityReadOnlyEvidenceRuns >= maxQualityReadOnlyEvidenceRuns
      ) {
        return false;
      }

      let rounds = 0;
    while (rounds < maxRounds) {
      rounds++;

      // Deduplication guard: Prevent re-running identical failing commands in loops
      if (seenWorkspaceCommands.get(cmd) === workspaceStateGeneration) {
        if (successfulWorkspaceCommands.get(cmd) === workspaceStateGeneration) return true;
        if (
          IsQualityGateRole(InParams.officeAgentRole) &&
          IsReadOnlyDiagnosticCommand(cmd) &&
          lastWorkspaceCommandExitCodes.get(cmd) === 0
        ) {
          successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
          return true;
        }
        console.warn("Circuit Breaker Tripped: Command already executed in this cascade loop", cmd);
        return false;
      }
      seenWorkspaceCommands.set(cmd, workspaceStateGeneration);

      if (totalWorkspaceRuns >= maxTotalRuns) return false;
      totalWorkspaceRuns += 1;

      const wr = await InParams.runWorkspaceCommand(cmd, InParams.workspace ?? null);
      const commandChangedWorkspaceState = CanWorkspaceCommandChangeState(cmd);
      if (commandChangedWorkspaceState) {
        workspaceStateGeneration += 1;
        seenWorkspaceCommands.set(cmd, workspaceStateGeneration);
      }
      const exitCode = wr?.exit_code ?? -1;
      lastWorkspaceCommandExitCodes.set(cmd, exitCode);
      if (
        IsQualityGateRole(InParams.officeAgentRole) &&
        IsReadOnlyDiagnosticCommand(cmd) &&
        exitCode === 0
      ) {
        qualityReadOnlyEvidenceRuns += 1;
      }
      InParams.onCliLog({
        stdin: cmd,
        stdout: wr?.stdout ?? "",
        stderr: wr?.stderr ?? "",
        exit_code: exitCode,
        provider: wr?.provider,
        label: `${InParams.logLabelPrefix}:workspace`,
        officeAgentRole: InParams.officeAgentRole,
      });
      const combinedWorkspaceOutput = `${wr?.stdout ?? ""}\n${wr?.stderr ?? ""}`;

      if (IsPackageAuditCommand(cmd) && HasActionablePackageAuditSignal(combinedWorkspaceOutput)) {
        runs.push({
          command: cmd,
          stdout: wr?.stdout ?? "",
          stderr: wr?.stderr ?? "",
          exit_code: exitCode,
          provider: wr?.provider,
          feedback: "ABORT: package audit repair required",
          feedback_exit_code: 0,
          followupCommands: [],
        });
        return false;
      }

      if (
        exitCode === 0 &&
        IsPackageInstallCommand(cmd) &&
        HasActionablePackageAuditSignal(combinedWorkspaceOutput)
      ) {
        const auditCommand = BuildPackageAuditCommand(cmd);
        runs.push({
          command: cmd,
          stdout: wr?.stdout ?? "",
          stderr: wr?.stderr ?? "",
          exit_code: exitCode,
          provider: wr?.provider,
          feedback: `[Commands]\n1. ${auditCommand}\n[/Commands]`,
          feedback_exit_code: 0,
          followupCommands: [auditCommand],
        });
        return await RunOne(auditCommand, InDepth + 1);
      }

      if (HasBenignZeroExitVerificationStderr(cmd, wr)) {
        runs.push({
          command: cmd,
          stdout: wr?.stdout ?? "",
          stderr: wr?.stderr ?? "",
          exit_code: exitCode,
          provider: wr?.provider,
          feedback: "OK: verification command exited 0 with explicit pass output; ignored known benign tool stderr",
          feedback_exit_code: 0,
          followupCommands: [],
        });
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }

      if (
        exitCode === 0 &&
        IsPackageInstallCommand(cmd) &&
        !HasHostFeedbackFailureSignal(combinedWorkspaceOutput)
      ) {
        runs.push({
          command: cmd,
          stdout: wr?.stdout ?? "",
          stderr: wr?.stderr ?? "",
          exit_code: exitCode,
          provider: wr?.provider,
          feedback: "OK: package install completed without actionable failure",
          feedback_exit_code: 0,
          followupCommands: [],
        });
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }

      const payload = {
        command: cmd,
        result: {
          exit_code: exitCode,
          stdout: (wr?.stdout ?? "").slice(0, MAX_BODY_CHARS),
          stderr: (wr?.stderr ?? "").slice(0, MAX_BODY_CHARS),
        },
      };
      const userMessage = JSON.stringify(payload);
      const feedbackSystemPrompt = BuildHostCommandFeedbackSystemPrompt(InParams.officeAgentRole);
      const agentRaw = await InParams.runAgentCli(userMessage, {
        systemPrompt: feedbackSystemPrompt,
        cwd: InParams.cwdForCli ?? InParams.workspace ?? null,
        provider: InParams.cliProvider,
        sessionKey: InParams.feedbackSessionKey ?? null,
      });
      const agentRes = AsCliResult(agentRaw);
      const agentText = CombineCliText(agentRes);
      const agentParsingText = CombineCliStreamsForParsing(agentRes);
      const agentStdoutText = (agentRes?.stdout ?? "").trim();
      const agentStderrText = (agentRes?.stderr ?? "").trim();
      const agentDecisionText = agentStdoutText !== "" ? agentStdoutText : agentParsingText;
      const feedbackFailureSignalText =
        agentStdoutText !== "" && /^\s*ABORT:/im.test(agentStderrText)
          ? `${agentDecisionText}\n${agentStderrText}`
          : agentDecisionText;
      const agentExit = agentRes?.exit_code ?? -1;
      InParams.onCliLog({
        stdin: userMessage,
        stdout: agentRes?.stdout ?? "",
        stderr: agentRes?.stderr ?? "",
        exit_code: agentExit,
        provider: agentRes?.provider,
        label: `${InParams.logLabelPrefix}:feedback`,
        officeAgentRole: InParams.officeAgentRole,
      });

      const extractedFollowups = await InParams.extractCommandsFromAgentText(agentDecisionText);
      const workspaceFailed = exitCode !== 0;
      const followups = NormalizeDependencySetupFollowups(
        cmd,
        wr,
        workspaceFailed,
        extractedFollowups,
      ).filter((followup) => !isSequencerInternalArtifactCommand(followup));
      runs.push({
        command: cmd,
        stdout: wr?.stdout ?? "",
        stderr: wr?.stderr ?? "",
        exit_code: exitCode,
        provider: wr?.provider,
        feedback: agentDecisionText || agentText,
        feedback_exit_code: agentExit,
        followupCommands: followups,
      });

      const feedbackOk = ParseHostCommandFeedbackOk(agentDecisionText);
      const requiresFollowup = followups.length > 0;
      const contextInsufficientAbort =
        !workspaceFailed &&
        !requiresFollowup &&
        agentExit === 0 &&
        IsContextInsufficientAbort(agentDecisionText || agentText);
      const packageSetupSucceededWithoutActionableFeedback =
        !workspaceFailed &&
        !requiresFollowup &&
        agentExit === 0 &&
        IsPackageInstallCommand(cmd) &&
        !HasHostFeedbackFailureSignal(feedbackFailureSignalText);
      const feedbackFailed =
        agentExit !== 0 || (HasHostFeedbackFailureSignal(feedbackFailureSignalText) && !contextInsufficientAbort);
      if (feedbackFailed) {
        return false;
      }
      if (requiresFollowup) {
        const hasInvalidFollowup = followups.some(
          (followup) => {
            const diagnosticVerificationAllowed = IsQualityGateDiagnosticToVerificationFollowupAllowed(
              cmd,
              followup,
              InParams.officeAgentRole,
            );
            const readOnlyQualityChainAllowed = IsQualityGateReadOnlyDiagnosticChainAllowed(
              cmd,
              followup,
              InParams.officeAgentRole,
            );
            return (
              skip(followup) ||
              IsPlaceholderFollowupCommand(followup) ||
              (
                IsQualityGateRole(InParams.officeAgentRole) &&
                !diagnosticVerificationAllowed &&
                !readOnlyQualityChainAllowed &&
                !IsAllowedQualityGateFollowupCommand(cmd, followup, workspaceFailed)
              ) ||
              (
                IsExploratoryFollowupCommand(followup) &&
                !readOnlyQualityChainAllowed &&
                !IsFailureDiagnosticReadFollowupAllowed(cmd, followup, workspaceFailed)
              ) ||
              (
                IsQualityGateRole(InParams.officeAgentRole) &&
                IsGeneratedVerificationArtifactReadCommand(followup)
              ) ||
              (
                !diagnosticVerificationAllowed &&
                !IsAllowedHostFeedbackFollowupCommand(cmd, followup, workspaceFailed)
              ) ||
              !IsActionableFollowupCommand(followup) ||
              isInvalidSequencerCliCommand(followup)
            );
          },
        );
        if (hasInvalidFollowup) {
          return false;
        }
        for (const followup of followups) {
          const ok = await RunOne(followup, InDepth + 1);
          if (!ok) return false;
        }
        const hasSupersedingFollowup = followups.some(
          (followup) =>
            IsExplicitSupersedingVerificationCommand(cmd, followup) ||
            IsCwdCorrectedSameRunnableCommand(cmd, followup) ||
            IsSetupWrappedSameRunnableCommand(cmd, followup),
        );
        const hasNonSupersedingDiagnosticFollowup = followups.some(
          (followup) =>
            IsSelectorRelaxedSameVerificationCommand(cmd, followup) ||
            IsFailureDiagnosticReadFollowupAllowed(cmd, followup, workspaceFailed),
        );
        if (
          workspaceFailed &&
          !hasSupersedingFollowup
        ) {
          if (hasNonSupersedingDiagnosticFollowup) return false;
          continue;
        }
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }
      if (workspaceFailed) return false;
      if (feedbackOk) {
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }
      if (packageSetupSucceededWithoutActionableFeedback) {
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }
      if (contextInsufficientAbort) {
        successfulWorkspaceCommands.set(cmd, workspaceStateGeneration);
        return true;
      }
      return false;
    }
    return false;
  }

  for (const c of InParams.commands.filter((command) => !isSequencerInternalArtifactCommand(command))) {
    const ok = await RunOne((c ?? "").trim(), 0);
    if (!ok) return { ok: false, runs };
  }
  return { ok: true, runs };
}
