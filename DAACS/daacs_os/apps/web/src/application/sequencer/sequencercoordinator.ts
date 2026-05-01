import type { AgentRole } from "../../types/agent";
import type { AgentPromptRole, SequencerItem, SequencerTodoList } from "../../services/tauriCli";
import { parseSkillRequest, PartitionSkillRequestByBundle } from "../../services/tauriCli";
import { useOfficeStore } from "../../stores/officeStore";
import { useSequencerDeferredCommandsStore } from "../../stores/sequencerDeferredCommandsStore";
import { AgentExecutorFactory } from "./AgentExecutor";
import { AgentRegistry } from "./AgentRegistry";
import {
  RunHostCommandsWithAgentFeedback,
  ParseHostCommandFeedbackOk,
  type HostCommandExecutionRecord,
} from "./HostCommandFeedbackRunner";
import { SequencerParser } from "./SequencerParser";
import { SequencerStateMachine } from "./SequencerStateMachine";
import type { DispatchRow, GoalPhase, RosterAgentMeta, SequencerStepRunRecord } from "./types";

type RunCascadeParams = {
  projectName: string;
  workspace: string;
  resolveWorkspaceForAgentId?: (agentId: string) => string | null | undefined;
  cliProvider: string | null;
  agentsMetadataJson: string;
  seed: Array<{
    agentId: string;
    command: string;
    senderId?: string | null;
    originAssignmentContext?: string | null;
  }>;
  setAgentTaskByRole: (role: AgentRole, task: string) => void;
  setAgentTaskById?: (agentId: string, task: string) => void;
  setPhase: (p: GoalPhase) => void;
  maxCascade: number;
  maxCliCalls?: number;
  abortSignal?: AbortSignal;
  parseSequencerPlanSteps: (
    stdout: string,
  ) => Array<{ stepNumber: number; task: string; routedAgentId: string | null }>;
  runCliCommand: (instruction: string, options?: Record<string, unknown>) => Promise<unknown>;
  buildRosterDelegationSystemPrompt: (
    projectName: string,
    promptRole: AgentPromptRole,
    agentsMetadataJson: string,
    options: {
      promptKey: string | null;
      sequencerStepSuffix: string;
      skillBundleRole?: string | null;
      skillBundleRefs?: string[] | null;
      injectRequestedSkillRefs?: string[] | null;
      omitRoster?: boolean;
    },
  ) => Promise<string | null>;
  mapTauriCliRoleKeyToAgentPromptRole: (key: string) => AgentPromptRole;
  onCliLog: (entry: {
    stdin: string;
    systemPrompt?: string;
    stdout: string;
    stderr: string;
    exit_code: number;
    provider?: string;
    label: string;
    officeAgentRole: AgentRole;
    skillRequestParsed?: string[] | null;
    skillInjectedRefs?: string[] | null;
    skillRequestDroppedRefs?: string[] | null;
  }) => void;
  onAgentMessage?: (msg: {
    agentId: string;
    agentName: string;
    officeRole: AgentRole;
    text: string;
    type: "start" | "done" | "error";
  }) => void;
  onAgentExecutionComplete?: (event: AgentExecutionCompletion) => void;
  runHostWorkspaceCommand?: (
    command: string,
    cwd: string,
  ) => Promise<CliRunResult | null | undefined>;
  extractHostCommandsFromStepOutput?: (text: string) => Promise<string[]>;
  shouldSkipHostCommand?: (command: string) => boolean;
  resolveSequencerChannelIdForAgentId?: (agentId: string) => string;
  persistAgentCascadePlanTodo?: (todo: SequencerTodoList) => Promise<boolean>;
  onAgentPlanGenerated?: (agentId: string, planText: string) => Promise<void>;
  injectedSkillSetByAgentId?: Map<string, Set<string>>;
  suppressNestedModelDelegation?: boolean;
};

type CliRunResult = {
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  provider?: string;
} | null;

const PARTIAL_ARTIFACT_TIMEOUT_TAG = "DAACS_PARTIAL_ARTIFACT_TIMEOUT";
const ARTIFACT_FILE_STATUS_TAG = "ArtifactFileStatus";
const IMPLEMENTATION_TIMEOUT_TAG = "ImplementationTimeout";

function CombineCascadeCliOutput(dispatched: CliRunResult | undefined | null): string {
  if (dispatched == null) return "";
  const a = (dispatched.stdout ?? "").trim();
  const b = (dispatched.stderr ?? "").trim();
  if (a !== "" && b !== "") return `${a}\n\n${b}`;
  return a !== "" ? a : b;
}

function StripHostCommandBlocks(text: string): string {
  return ["Command", "Commands"].reduce(
    (current, tag) => StripTaggedBlock(current, tag),
    String(text ?? ""),
  );
}

function SplitShellCommandSegments(command: string): string[] {
  const value = String(command ?? "");
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | null = null;
  let escaped = false;

  const pushCurrent = () => {
    const segment = current.trim();
    if (segment !== "") segments.push(segment);
    current = "";
  };

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index] ?? "";
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
    const twoChars = value.slice(index, index + 2);
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

const READ_ONLY_INSPECTION_SEGMENT_PREFIXES = [
  "rg ",
  "grep ",
  "ag ",
  "find ",
  "ls",
  "pwd",
  "cat ",
  "sed ",
  "head",
  "tail",
  "less ",
  "more ",
  "wc ",
  "sort",
  "git diff",
  "git status",
  "git show",
];

function IsReadOnlyInspectionHostCommand(command: string): boolean {
  const value = String(command ?? "").trim().toLowerCase();
  if (value === "") return false;
  if (/[><]/.test(value) || /\b(?:tee|xargs|chmod|chown|mv|cp|rm|mkdir|touch|npm|pnpm|yarn|node|python|cargo|git\s+(?:apply|checkout|switch|reset|restore|clean|commit|merge|rebase|pull|push))\b/.test(value)) {
    return false;
  }
  const segments = SplitShellCommandSegments(value);
  return (
    segments.length > 0 &&
    segments.every((segment) =>
      READ_ONLY_INSPECTION_SEGMENT_PREFIXES.some(
        (prefix) => segment === prefix.trim() || segment.startsWith(prefix),
      ))
  );
}

function ExtractImportantTaggedBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re =
    /\[((?:STEP_\d+_RESULT)|(?:SEQUENCER_PLAN)|(?:AGENT_COMMANDS)|(?:NEXT_WORKFLOW)|(?:Command)|(?:Commands)|(?:SKILL_REQUEST)|(?:TaskComplete)|(?:ReviewVerdict)|(?:ReviewFindings)|(?:OpenRisks)|(?:VerificationStatus)|(?:Verification)|(?:FilesCreated)|(?:HostFeedbackStatus)|(?:ArtifactFileStatus)|(?:ImplementationTimeout)|(?:DAACS_PARTIAL_ARTIFACT_TIMEOUT)|(?:PartialArtifactTimeout))\]([\s\S]*?)\[\/\1\]/gi;
  for (const match of text.matchAll(re)) {
    const tag = match[1] ?? "";
    const body = match[2] ?? "";
    const full = match[0] ?? "";
    if (full.trim() === "") continue;
    if (full.length <= 4000) {
      blocks.push(full.trim());
      continue;
    }

    const bodyHead = CompactLargeModelOutputForMemory(body, 1600).trim();
    blocks.push(
      `[${tag}]\n${bodyHead}\n[/${tag}]`,
    );
  }
  return [...new Set(blocks)];
}

function CompactLargeModelOutputForMemory(text: string, maxChars: number = 24000): string {
  const raw = StripCliTranscriptFromOutput(text ?? "").trim();
  if (raw.length <= maxChars) return raw;
  const taggedBlocks = ExtractImportantTaggedBlocks(raw);
  const taggedText = taggedBlocks.join("\n\n").trim();
  const headBudget = Math.max(2000, Math.floor(maxChars * 0.3));
  const tailBudget = Math.max(2000, Math.floor(maxChars * 0.3));
  const head = raw.slice(0, headBudget).trim();
  const tail = raw.slice(Math.max(0, raw.length - tailBudget)).trim();
  const compactParts = [
    `[OutputCompacted]\noriginal_chars=${raw.length}\nreason=large agent output; original is retained in trace logs when tracing is enabled\n[/OutputCompacted]`,
    taggedText !== "" ? `## Preserved tagged blocks\n${taggedText}` : "",
    `## Output head\n${head}`,
    `## Output tail\n${tail}`,
  ].filter((part) => part !== "");
  const compact = compactParts.join("\n\n").trim();
  if (compact.length <= maxChars) return compact;
  const keepHead = Math.max(1000, Math.floor(maxChars * 0.45));
  const keepTail = Math.max(1000, Math.floor(maxChars * 0.45));
  return `${compact.slice(0, keepHead).trim()}\n\n[...compacted ${compact.length - keepHead - keepTail} chars...]\n\n${compact.slice(Math.max(0, compact.length - keepTail)).trim()}`;
}

function CompactCliRunResultForDownstream(
  result: CliRunResult | undefined | null,
): CliRunResult | undefined | null {
  if (result == null) return result;
  const raw = CombineCascadeCliOutput(result);
  const compact = CompactLargeModelOutputForMemory(raw);
  if (compact === raw) return result;
  return {
    ...result,
    stdout: compact,
    stderr: "",
  };
}

function ReadCascadeCliOutputForPlanParsing(dispatched: CliRunResult | undefined | null): string {
  if (dispatched == null) return "";
  const stdout = (dispatched.stdout ?? "").trim();
  const stderr = (dispatched.stderr ?? "").trim();
  const preferred = stdout !== "" ? stdout : stderr;
  const sequencerPlan = ExtractTaggedBlockText(preferred, "SEQUENCER_PLAN");
  return sequencerPlan !== "" ? sequencerPlan : preferred;
}

function IsTransientProviderFailure(dispatched: CliRunResult | undefined | null): boolean {
  if (dispatched == null || (dispatched.exit_code ?? -1) === 0) return false;
  const combined = `${dispatched.stdout ?? ""}\n${dispatched.stderr ?? ""}`.toLowerCase();
  return (
    combined.includes("failed to refresh available models") ||
    combined.includes("high demand") ||
    combined.includes("stream disconnected - retrying sampling request") ||
    combined.includes("temporarily unavailable") ||
    combined.includes("rate limit") ||
    combined.includes("terminalquotaerror") ||
    combined.includes("quota_exhausted") ||
    combined.includes("exhausted your capacity") ||
    combined.includes("quota will reset after")
  );
}

function ReadCascadeCliOutputForHostCommandParsing(
  dispatched: CliRunResult | undefined | null,
): string {
  if (dispatched == null) return "";
  const stdout = (dispatched.stdout ?? "").trim();
  const stderr = (dispatched.stderr ?? "").trim();
  const stderrLooksLikePromptScaffolding =
    stderr !== "" &&
    /(?:Prompting Sequencer Protocol|Host must run shell commands:\s*include\s*`\[Command]\.\.\.\[\/Command]`|Example when needed:|Do NOT output placeholder\/no-op commands|Your response is INVALID\.)/i.test(
      stderr,
    );
  if (stdout !== "" && stderrLooksLikePromptScaffolding) return stdout;
  return CombineCascadeCliOutput(dispatched);
}

function SplitSequencerInstruction(
  text: string,
): { taskBody: string; sequencerSuffix: string } {
  const t = (text ?? "").trimEnd();
  const re = /\n\n(Prompting_Sequencer_\d+)\s*$/i;
  const m = re.exec(t);
  if (m != null && m[1] != null && m.index != null) {
    return { taskBody: t.slice(0, m.index).trim(), sequencerSuffix: m[1].trim() };
  }
  return { taskBody: (text ?? "").trim(), sequencerSuffix: "" };
}

const HOST_SHELL_LINE_PREFIXES = [
  "npm ",
  "pnpm ",
  "yarn ",
  "npx ",
  "bun ",
  "deno ",
  "cargo ",
  "rustup ",
  "git ",
  "node ",
  "python ",
  "pip ",
  "pip3 ",
  "dotnet ",
  "cmake ",
  "make ",
  "gcc ",
  "clang ",
  "curl ",
  "wget ",
];

function LooksLikeHostShellTaskBody(body: string): boolean {
  const lines = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return false;
  // Issue #3 Fix: Multi-line text is a goal description, not a shell command.
  // Only truly single-line inputs should be treated as direct shell commands.
  if (lines.length !== 1) return false;
  const first = lines[0].toLowerCase();
  return HOST_SHELL_LINE_PREFIXES.some((p) => first.startsWith(p));
}

function ExtractSequencerLineFromText(text: string): string {
  const m = (text ?? "").match(/Prompting_Sequencer_\d+/i);
  return m != null && m[0] != null ? m[0].trim() : "";
}

function EnsureSequencerStepSignal(text: string, fallback: string = "Prompting_Sequencer_1"): string {
  const raw = (text ?? "").trimEnd();
  if (ExtractSequencerLineFromText(raw) !== "") return raw;
  return `${raw}\n\n${fallback}`;
}

function TruncateCascadeLabel(s: string, maxLen: number): string {
  const v = (s ?? "").trim();
  if (v.length <= maxLen) return v;
  return `${v.slice(0, maxLen).trim()}...`;
}

function TruncateLogTail(s: string, maxLen: number = 14000): string {
  if (!s) return "";
  if (s.length <= maxLen) return s;
  const headLen = Math.floor(maxLen * 0.2); // 20% head
  const tailLen = maxLen - headLen; // 80% tail
  const head = s.slice(0, headLen);
  const tail = s.slice(s.length - tailLen);
  return `${head}\n... [TRUNCATED ${
    s.length - maxLen
  } BYTES] ...\n${tail}`;
}

function TruncateLineList(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more)`];
}

function BuildSequencerSessionNamespace(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `seq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function NormalizeSessionKeySegment(value: string): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function QuoteShellArg(v: string): string {
  return `'${String(v ?? "").replace(/'/g, `'"'"'`)}'`;
}

function ExtractDiffDigest(diffText: string, maxFiles: number, maxHunks: number): string[] {
  const lines = (diffText ?? "").split(/\r?\n/);
  const out: string[] = [];
  let currentFile = "";
  let filesSeen = 0;
  let hunksSeen = 0;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("diff --git ")) {
      if (filesSeen >= maxFiles) break;
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match?.[2] ?? match?.[1] ?? "";
      if (currentFile !== "") {
        filesSeen += 1;
        out.push(`- file=${currentFile}`);
      }
      continue;
    }
    if (currentFile === "") continue;
    if (line.startsWith("@@")) {
      if (hunksSeen >= maxHunks) break;
      hunksSeen += 1;
      out.push(`  hunk=${line}`);
      continue;
    }
    if (
      line.startsWith("+") &&
      !line.startsWith("+++") &&
      out.length > 0 &&
      !out[out.length - 1]!.startsWith("    +")
    ) {
      out.push(`    ${line.slice(0, 160)}`);
      continue;
    }
    if (
      line.startsWith("-") &&
      !line.startsWith("---") &&
      out.length > 0 &&
      !out[out.length - 1]!.startsWith("    -")
    ) {
      out.push(`    ${line.slice(0, 160)}`);
    }
  }
  return out;
}

function RenumberCascadeSteps(rows: DispatchRow[]): DispatchRow[] {
  if (rows.length === 0) return [];
  return rows.map((row, idx) => ({ ...row, stepNumber: idx + 1 }));
}

function ForceDispatchRowsToAgent(
  rows: DispatchRow[],
  executingAgentId: string,
  registry: AgentRegistry,
): DispatchRow[] {
  const id = registry.NormalizeAgentId(executingAgentId);
  return rows.map((row) => ({
    ...row,
    agentId: id,
    cliRole: registry.MapTauriCliRoleKeyToCliRole(id),
    officeRole: registry.MapAgentIdToOfficeRole(id),
  }));
}

function CollapseQualityGateRowsForOwner(rows: DispatchRow[], officeRole: AgentRole): DispatchRow[] {
  if ((officeRole !== "reviewer" && officeRole !== "verifier") || rows.length <= 1) return rows;
  const first = rows[0]!;
  const mergedCommands = rows
    .map((row) => String(row.command ?? "").trim())
    .filter((command) => command !== "");
  const command =
    mergedCommands.length > 0
      ? `Run one compact ${officeRole} quality gate covering these checks: ${mergedCommands.join(" / ")}`
      : first.command;
  return [{ ...first, command }];
}

function LooksLikeImplementationWork(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".rs",
    ".py",
    ".go",
    ".java",
    ".kt",
    ".swift",
    "implement",
    "fix",
    "restore",
    "repair",
    "refactor",
    "code",
    "component",
    "endpoint",
    "api",
    "create",
    "make",
    "generate",
    "build",
    "test",
    "ui",
    "vite",
    "react",
    "backend",
    "frontend",
    "bug",
    "feature",
    "deploy",
    "deployment",
    "rollout",
    "release",
    "scaffold",
    "skeleton",
    "app shell",
    "infra",
    "infrastructure",
    "docker",
    "k8s",
    "kubernetes",
    "ci",
    "cd",
    "pipeline",
    "figma",
    "wireframe",
    "mockup",
    "prototype",
    "polish",
    "visual",
    "interaction",
    "hierarchy",
    "typography",
    "spacing",
    "copy",
    "구현",
    "만들",
    "제작",
    "생성",
    "추가",
    "수정",
    "고치",
    "복구",
    "배포",
    "스캐폴딩",
    "골격",
    "뼈대",
  ].some((needle) => text.includes(needle));
}

function LooksLikePmPlanningWork(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  const directImplementationSignals = [
    "build ",
    "create ",
    "implement ",
    "install ",
    "run ",
    "scaffold",
    "code ",
    "patch ",
    "fix ",
    "구현",
    "만들",
    "생성",
    "스캐폴딩",
  ];
  const pmPlanningNouns = [
    "brief",
    "handoff",
    "delegation",
    "specification",
    "requirements",
    "criteria",
    "execution plan",
    "role",
    "pm ",
    "핸드오프",
    "위임",
    "명세",
    "요구사항",
    "기준",
    "역할",
    "계획",
  ];
  if (
    directImplementationSignals.some((needle) => text.includes(needle)) &&
    !pmPlanningNouns.some((needle) => text.includes(needle))
  ) {
    return false;
  }
  const readOnlyScopingSignals = [
    "current changed files",
    "directly related code",
    "domain constraint",
    "domain constraints",
    "implementation impact",
    "impact scope",
    "read only",
    "requirement analysis",
    "요구사항",
    "제약",
    "도메인 제약",
    "위험",
    "영향 범위",
    "압축 정리",
    "현재 변경 파일",
    "직접 연관 코드",
  ];
  const handoffStructuringSignals = [
    "completion criteria",
    "delegate",
    "delegation",
    "final handoff",
    "final specification",
    "handoff format",
    "role split",
    "specification",
    "success criteria",
    "task specification",
    "완료 기준",
    "위임",
    "역할 분담",
    "역할 배분",
    "최종 handoff",
    "최종 핸드오프",
    "최종 명세",
    "핸드오프 형식",
  ];
  const planningActionSignals = [
    "define",
    "design",
    "produce",
    "read",
    "inspect",
    "outline",
    "summarize",
    "write",
    "읽고",
    "작성",
    "정리",
  ];
  if (
    planningActionSignals.some((needle) => text.includes(needle)) &&
    (readOnlyScopingSignals.some((needle) => text.includes(needle)) ||
      handoffStructuringSignals.some((needle) => text.includes(needle)))
  ) {
    return true;
  }
  const roleStructuredPlanningSignals = [
    "delegation card",
    "delegation cards",
    "delegation note",
    "delegation notes",
    "delegate",
    "delegation",
    "final specification",
    "implementation/review agents",
    "implementation/review",
    "task card",
    "task cards",
    "task brief",
    "task specification",
    "specification",
    "acceptance criteria",
    "done criteria",
    "completion criteria",
    "완료 기준",
    "명세",
    "위임",
    "위임 카드",
    "위임 메모",
    "역할별 정리",
    "역할에 맞춰",
  ];
  if (
    (text.includes("role") ||
      text.includes("역할") ||
      text.includes("developer") ||
      text.includes("frontend") ||
      text.includes("backend") ||
      text.includes("reviewer") ||
      text.includes("verifier")) &&
    (text.includes("handoff") ||
      text.includes("핸드오프") ||
      text.includes("정리") ||
      text.includes("작성") ||
      text.includes("write") ||
      text.includes("card") ||
      text.includes("criteria") ||
      text.includes("기준")) &&
    roleStructuredPlanningSignals.some((needle) => text.includes(needle))
  ) {
    return true;
  }
  const implementationHandoffSignals = [
    "implementation handoff",
    "pm-directed implementation handoff",
    "execute the implementation work",
    "구현 작업",
  ];
  const strongPmHandoffSignals = [
    "delegate to implementation/review",
    "delegate to implementation",
    "delegation plan",
    "final role handoff",
    "final execution handoff",
    "final execution plan",
    "final specification",
    "role handoff",
    "execution handoff",
    "pm_summary",
    "role_assignment_notes",
    "frontend_tasks",
    "backend_tasks",
    "reviewer_tasks",
    "verifier_tasks",
    "최종 핸드오프",
    "최종 명세",
    "최종 실행 핸드오프",
    "실행 핸드오프",
    "역할 핸드오프",
    "역할별 핸드오프",
    "최종 역할",
    "역할 메모",
  ];
  if (strongPmHandoffSignals.some((needle) => text.includes(needle))) return true;
  if (
    text.includes("handoff") &&
    !implementationHandoffSignals.some((needle) => text.includes(needle)) &&
    (text.includes("role") ||
      text.includes("역할") ||
      text.includes("developer") ||
      text.includes("frontend") ||
      text.includes("backend") ||
      text.includes("reviewer") ||
      text.includes("verifier") ||
      text.includes("review") ||
      text.includes("검토") ||
      text.includes("verify") ||
      text.includes("검증") ||
      text.includes("작성") ||
      text.includes("write"))
  ) {
    return true;
  }
  if (
    (text.includes("핸드오프") || text.includes("handoff")) &&
    (text.includes("역할") || text.includes("role")) &&
    (text.includes("작성") || text.includes("write")) &&
    (
      text.includes("구현") ||
      text.includes("implement") ||
      text.includes("developer") ||
      text.includes("reviewer") ||
      text.includes("verifier") ||
      text.includes("검토") ||
      text.includes("review") ||
      text.includes("검증") ||
      text.includes("verify")
    )
  ) {
    return true;
  }
  const planningSignals = [
    "acceptance criteria",
    "contract",
    "criteria",
    "define",
    "design",
    "delegate",
    "delegation",
    "execution plan",
    "flow",
    "handoff",
    "핸드오프",
    "input/output",
    "outline",
    "plan",
    "requirement",
    "requirements analysis",
    "requirements",
    "risk",
    "scope",
    "constraint",
    "constraints",
    "modeling",
    "specification",
    "success criteria",
    "task specification",
    "summarize",
    "test plan",
    "명세",
    "위임",
    "요구사항",
    "정리",
    "범위",
    "성공 기준",
  ];
  if (!planningSignals.some((needle) => text.includes(needle))) return false;
  return ![
    "add ",
    "build ",
    "change ",
    "code ",
    "create file",
    "deploy ",
    "fix ",
    "implement ",
    "install ",
    "patch ",
    "refactor ",
    "repair ",
    "restore ",
    "run ",
    "ship ",
    "update ",
    "write ",
    "구현",
    "만들",
    "제작",
    "생성",
    "추가",
    "수정",
    "고치",
    "복구",
    "배포",
  ].some((needle) => text.includes(needle));
}

function LooksLikeFrontendWork(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  const substringSignals = [
    ".tsx",
    ".jsx",
    ".css",
    ".scss",
    ".html",
    ".vue",
    ".svelte",
    "frontend",
    "website",
    "web tool",
    "web app",
    "webapp",
    "browser tool",
    "component",
    "page",
    "layout",
    "tailwind",
    "react",
    "vite",
    "preview",
    "design",
    "웹사이트",
    "웹 도구",
    "웹 툴",
    "웹앱",
    "프론트",
    "프론트엔드",
    "화면",
    "페이지",
    "브라우저",
    "모달",
    "카드",
    "버튼",
  ];
  return substringSignals.some((needle) => text.includes(needle)) || /\b(?:ui|ux)\b/i.test(text);
}

function LooksLikeGeneratedWebArtifactRequest(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  const hasWebArtifact =
    /\b(?:website|web\s*app|webapp|landing\s*page|single-page|single\s+page|dashboard|browser\s+app)\b/i.test(text) ||
    /(?:웹사이트|웹\s*앱|웹앱|랜딩\s*페이지|브라우저|대시보드|화면|페이지)/i.test(text);
  if (!hasWebArtifact) return false;

  const hasCreationIntent =
    /\b(?:build|create|make|generate|scaffold|implement|prototype|ship|produce)\b/i.test(text) ||
    /(?:만들|구현|제작|생성|짜줘|만들어줘|구축)/i.test(text);
  if (!hasCreationIntent) return false;

  const hasGeneratedArtifactContext =
    /\b(?:generated|artifact|deliverable|natural-language|user-facing|from\s+the\s+user|from\s+natural\s+language|mvp)\b/i.test(text) ||
    /(?:산출물|자연어|사용자|실사용|요청)/i.test(text);
  const looksLikeRepoMaintenance =
    /(?:sequencercoordinator|hostcommand|workflowapi|agentapi|regression|src-tauri|cargo|rust|migration|\.test\.[tj]sx?|\.spec\.[tj]sx?|apps\/web\/src\/)/i.test(
      text,
    ) ||
    /\b(?:fix|repair|refactor|debug|lint|test)\b/i.test(text);

  return hasGeneratedArtifactContext || !looksLikeRepoMaintenance;
}

function LooksLikeGeneratedArtifactFeatureSlice(command: string, goalText: string): boolean {
  const goal = StripSequencerSignals(goalText).replace(/\s+/g, " ").trim();
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim().toLowerCase();
  if (goal === "" || text === "") return false;
  const hasArtifactGoal =
    LooksLikeGeneratedWebArtifactRequest(goal) ||
    LooksLikeInputDrivenDecisionArtifactQualityContext(goal);
  if (!hasArtifactGoal) return false;
  if (
    /^(?:review|verify|verification|test\s+plan|검토|리뷰|검수|검증)\b/i.test(text) ||
    /^(?:reviewer|verifier)\s*[:：]/i.test(text)
  ) {
    return false;
  }
  if (
    /^(?:define|design|produce|outline|summarize|draft|write)\b/i.test(text) &&
    LooksLikePmPlanningWork(text)
  ) {
    return false;
  }
  if (
    /(?:요구사항|금지조건|역할|핸드오프|명세|기준)/i.test(text) &&
    /(?:정리|확정|골라|고르|작성|핸드오프)/i.test(text)
  ) {
    return false;
  }
  if (
    /\b(?:requirement|requirements|domain\s+constraint|constraint\s+modeling|analysis|modeling|success\s+criteria|handoff)\b/i.test(text) &&
    /\b(?:analysis|modeling|define|design|produce|outline|summarize|draft|write|handoff)\b/i.test(text)
  ) {
    return false;
  }
  return /(?:\b(?:scaffold|skeleton|app\s+shell|engine|recommend|recommender|recommendation|ranking|rank|score|filter|dataset|data\s+model|repository|localstorage|storage|persistence|favorite|favorites|search|input|form|state|recompute|refresh|card|result|api|ui|distance|route|path|reroute|constraint|availability|exclusion)\b|스캐폴딩|골격|뼈대|앱\s*셸|추천|엔진|필터|점수|정렬|데이터|도메인\s*구조|모델|저장소|로컬\s*스토리지|저장|로드|즐겨찾기|검색|입력|폼|상태|재계산|즉시\s*갱신|즉시\s*반영|카드|결과|화면|거리|경로|동선|우회|통로|제약|조건|제외|하드\s*제외|소프트\s*점수|완화\s*규칙)/i.test(text);
}

function LooksLikeConcreteArtifactCreationRequest(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  const hasCreationIntent =
    /\b(?:build|create|make|generate|scaffold|implement|prototype|ship|produce|write)\b/i.test(text) ||
    /(?:만들|구현|제작|생성|짜줘|만들어줘|구축|작성)/i.test(text);
  if (!hasCreationIntent) return false;
  const hasConcreteDeliverable =
    /\b(?:artifact|deliverable|app|website|web\s*app|webapp|dashboard|page|component|document|report|spec|prototype|script|tool|cli|service|api|schema|database|module|library|design|mockup|wireframe|template|file)\b/i.test(text) ||
    /(?:산출물|결과물|앱|웹사이트|웹\s*앱|웹앱|대시보드|화면|페이지|컴포넌트|문서|보고서|명세|기획서|프로토타입|스크립트|도구|툴|프로그램|서비스|api|스키마|데이터베이스|모듈|라이브러리|디자인|시안|와이어프레임|템플릿|파일)/i.test(text);
  if (!hasConcreteDeliverable) return false;
  const looksLikeQualityOnly =
    /(?:\breview[-\s]?only\b|\bverification[-\s]?only\b|\baudit[-\s]?only\b|\binspect[-\s]?only\b|\bread[-\s]?only\b|검수만|검토만|확인만|검증만|읽기\s*전용)/i.test(text);
  if (looksLikeQualityOnly) return false;
  const looksLikeNoChangeConfirmation =
    /\b(?:confirm|check|inspect|summarize|explain|analyze)\b.+\b(?:no\s+change|already|existing)\b/i.test(text) ||
    /(?:이미|기존|변경\s*없이|수정\s*없이).*(?:확인|검토|요약|분석)/i.test(text);
  return !looksLikeNoChangeConfirmation;
}

function LooksLikeFreshArtifactDeliveryRequest(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (!LooksLikeConcreteArtifactCreationRequest(text) && !LooksLikeGeneratedWebArtifactRequest(text)) {
    return false;
  }
  const hasFreshIntent =
    /\b(?:new|fresh|from\s+scratch|clean\s+slate|build|create|make|generate|scaffold|prototype|produce|write)\b/i.test(text) ||
    /(?:새로|처음부터|신규|만들어줘|만들|제작|생성|작성|구축|짜줘)/i.test(text);
  if (!hasFreshIntent) return false;
  return !LooksLikeExistingArtifactRepairIntent(text);
}

function LooksLikeExistingArtifactRepairIntent(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (value === "") return false;
  const strongRepairIntent =
    /\b(?:fix|repair|refactor|patch|rework)\b/i.test(value) ||
    /(?:고쳐|고치|수리|보수|패치|리팩터|리팩토|재작업)/i.test(value);
  if (strongRepairIntent) return true;

  const existingScope = String.raw`(?:existing|previous|prior|old|기존|이전|방금|아까)`;
  const artifactScope = String.raw`(?:artifact|output|deliverable|file|code|implementation|project|workspace|dashboard|website|web\s*app|webapp|app|page|component|source|repo|repository|산출물|결과물|파일|코드|구현|프로젝트|작업물|대시보드|웹사이트|웹\s*앱|웹앱|앱|페이지|컴포넌트|소스|저장소)`;
  const existingArtifactScope = new RegExp(
    `${existingScope}.{0,48}${artifactScope}|${artifactScope}.{0,48}${existingScope}`,
    "i",
  );
  const currentArtifactScope = new RegExp(
    String.raw`(?:current|현재).{0,16}${artifactScope}`,
    "i",
  );
  return existingArtifactScope.test(value) || currentArtifactScope.test(value);
}

type RequestWorkMode =
  | "fresh_create"
  | "modify_existing"
  | "repair"
  | "explicit_backend_python"
  | "ambiguous";

type RequestIntentClassification = {
  mode: RequestWorkMode;
  isFreshCreate: boolean;
  isModifyExisting: boolean;
  isRepair: boolean;
  isClientSideWebArtifact: boolean;
  allowsPythonBackend: boolean;
  explicitlyNamesBackendPythonPath: boolean;
};

function ClassifyRequestIntent(assignmentContext: string): RequestIntentClassification {
  const text = StripSequencerSignals(assignmentContext).replace(/\s+/g, " ").trim().toLowerCase();
  const explicitlyNamesBackendPythonPath =
    /(?:^|[\s`'"])(?:backend|server|services|tests)\/[^\s`'"]+\.py\b/i.test(text) ||
    /(?:^|[\s`'"])[^\s`'"]+\.py\b/i.test(text);
  const explicitlyAsksForPythonOrServer =
    /\b(?:python|fastapi|flask|django|pytest|server-side|server side|backend\s+api|api\s+server)\b/i.test(text) ||
    /(?:파이썬|백엔드\s*서버|서버\s*(?:구현|백엔드|api)|pytest)/i.test(text) ||
    explicitlyNamesBackendPythonPath;
  const looksLikeWebArtifact =
    /\b(?:web\s*(?:app|site|artifact)?|website|webapp|vite|react|tsx|frontend|client-side)\b/i.test(text) ||
    /(?:브라우저|웹\s*(?:앱|사이트)?|프론트엔드|웹사이트)/i.test(text);
  const isRepairIntent = LooksLikeExistingArtifactRepairIntent(text);
  const mentionsExistingContext =
    /\b(?:existing|previous|prior|old|this\s+file|these\s+files|workspace|repo|repository|codebase|modify|update|change)\b/i.test(text) ||
    /\bcurrent\s+(?:file|code|implementation|artifact|output|project|workspace|repo|repository|page|app|website)\b/i.test(text) ||
    /(?:기존|이전|방금|아까|이\s*파일|저\s*파일|작업물|워크스페이스|저장소|코드베이스|수정|변경|업데이트)/i.test(text) ||
    /현재\s*(?:파일|코드|구현|산출물|결과물|프로젝트|작업물|저장소|앱|웹사이트|페이지)/i.test(text);
  const isFreshCreate = LooksLikeFreshArtifactDeliveryRequest(text) && !isRepairIntent && !mentionsExistingContext;
  const isModifyExisting = !isFreshCreate && (isRepairIntent || mentionsExistingContext || explicitlyNamesBackendPythonPath);
  let mode: RequestWorkMode = "ambiguous";
  if (explicitlyAsksForPythonOrServer && (isRepairIntent || mentionsExistingContext || explicitlyNamesBackendPythonPath)) {
    mode = "explicit_backend_python";
  } else if (isRepairIntent) {
    mode = "repair";
  } else if (isModifyExisting) {
    mode = "modify_existing";
  } else if (isFreshCreate) {
    mode = "fresh_create";
  } else if (explicitlyAsksForPythonOrServer) {
    mode = "explicit_backend_python";
  }
  return {
    mode,
    isFreshCreate,
    isModifyExisting,
    isRepair: isRepairIntent || mode === "repair",
    isClientSideWebArtifact: looksLikeWebArtifact && !explicitlyAsksForPythonOrServer,
    allowsPythonBackend: explicitlyAsksForPythonOrServer,
    explicitlyNamesBackendPythonPath,
  };
}

function BuildRequestIntentClassificationBlock(assignmentContext: string): string {
  const intent = ClassifyRequestIntent(assignmentContext);
  const lines = [
    "## Request intent classification",
    `Intent: ${intent.mode}`,
    `Surface: ${intent.isClientSideWebArtifact ? "client-side web artifact" : intent.allowsPythonBackend ? "backend/python allowed by request" : "general project work"}`,
    `Python/backend scope: ${intent.allowsPythonBackend ? "allowed only where the original user request or named files require it" : "not allowed unless the original user request explicitly asks for it"}`,
  ];
  if (intent.isFreshCreate) {
    lines.push(
      "Workspace rule: treat dirty/untracked files as context only. Do not repair or follow old generated files unless the original request names them.",
    );
  } else if (intent.mode === "explicit_backend_python" || intent.isModifyExisting || intent.isRepair) {
    lines.push(
      "Workspace rule: existing named/dirty files can be the source of truth. Fix the requested existing work instead of scaffolding an unrelated new app.",
    );
  } else {
    lines.push(
      "Workspace rule: if scope is unclear, keep changes narrow and prefer files explicitly named by the request or current evidence.",
    );
  }
  return lines.join("\n");
}

function ShouldEmitRequestIntentClassification(assignmentContext: string): boolean {
  const intent = ClassifyRequestIntent(assignmentContext);
  if (intent.isFreshCreate || intent.isModifyExisting || intent.isRepair || intent.allowsPythonBackend) return true;
  const text = StripSequencerSignals(assignmentContext).replace(/\s+/g, " ").trim();
  return LooksLikeConcreteArtifactCreationRequest(text) || LooksLikeGeneratedWebArtifactRequest(text);
}

function BuildArtifactDeliveryIntentBlock(assignmentContext: string): string {
  const intent = ClassifyRequestIntent(assignmentContext);
  if (!intent.isFreshCreate) {
    return ShouldEmitRequestIntentClassification(assignmentContext)
      ? BuildRequestIntentClassificationBlock(assignmentContext)
      : "";
  }
  return [
    BuildRequestIntentClassificationBlock(assignmentContext),
    "## Artifact delivery intent",
    "Intent: create a fresh requested deliverable from the user's natural-language assignment.",
    "Do not treat existing dirty/untracked workspace files as prior generated output to repair unless the assignment explicitly names those files.",
    "Use existing source files only as project context or reusable infrastructure; create/report the concrete deliverable files for this new request.",
  ].join("\n");
}

function NormalizeGeneratedArtifactPath(path: string): string {
  return String(path ?? "")
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim()
    .toLowerCase();
}

function IsGeneratedWebEntryFile(path: string): boolean {
  const value = NormalizeGeneratedArtifactPath(path);
  if (value === "") return false;
  const base = value.split("/").pop() ?? value;
  return (
    base === "index.html" ||
    base === "app.html" ||
    base === "package.json" ||
    base === "vite.config.ts" ||
    base === "vite.config.js" ||
    value.endsWith("/app/page.tsx") ||
    value.endsWith("/app/page.jsx") ||
    value.endsWith("/pages/index.tsx") ||
    value.endsWith("/pages/index.jsx")
  );
}

function IsGeneratedWebClientCodeFile(path: string): boolean {
  const value = NormalizeGeneratedArtifactPath(path);
  if (value === "") return false;
  if (
    /(?:^|\/)(?:node_modules|dist|build|coverage|playwright-report|test-results|reports?)\//.test(value) ||
    /(?:\.test|\.spec|\.d)\.(?:ts|tsx|js|jsx)$/.test(value)
  ) {
    return false;
  }
  return /\.(?:ts|tsx|js|jsx|vue|svelte)$/.test(value);
}

function OutputClaimsSelfContainedWebArtifact(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (value === "") return false;
  return (
    /\b(?:self-contained|single-file|single\s+file|inline\s+(?:script|javascript|css|styles?))\b/i.test(value) ||
    /(?:단일\s*파일|셀프\s*컨테인|인라인\s*(?:스크립트|자바스크립트|css|스타일)|index\.html\s*하나)/i.test(value)
  );
}

function HasUsableGeneratedWebArtifactShape(files: string[], outputText: string): boolean {
  const paths = [...new Set(files.map(NormalizeGeneratedArtifactPath).filter((value) => value !== ""))];
  if (paths.length === 0) return false;
  const hasEntry = paths.some(IsGeneratedWebEntryFile);
  const hasHtmlEntry = paths.some((path) => {
    const base = NormalizeGeneratedArtifactPath(path).split("/").pop() ?? "";
    return base === "index.html" || base === "app.html";
  });
  const hasClientCode = paths.some(IsGeneratedWebClientCodeFile);
  if (hasHtmlEntry && OutputClaimsSelfContainedWebArtifact(outputText)) return true;
  return hasEntry && hasClientCode;
}

function RequiredRunnableWebScaffoldFilesText(): string {
  return "package.json | tsconfig.json | vite.config | index.html | src/main | src/App";
}

function LooksLikeEmptyOrNonSubstantiveProviderOutput(outputText: string): boolean {
  const stripped = StripTaggedBlock(String(outputText ?? ""), "FilesCreated")
    .replace(/\{END_TASK_\d+\}/gi, "")
    .replace(/\[\/?STEP_\d+_RESULT\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === "") return true;
  return /^(?:reading\s+additional\s+input\s+from\s+stdin\.{0,3}|processing\.{0,3}|working\.{0,3}|done\.?)$/i.test(
    stripped,
  );
}

function ExtractScopedImplementationWorkBlock(command: string): string {
  const raw = StripSequencerSignals(command);
  if (raw === "") return "";

  const assignedSliceMatch = raw.match(
    /(?:^|\n\n)Assigned slice:\s*([\s\S]*?)(?=\n\n(?:Implementation requirement guardrails:|Original user requirement checklist to preserve:|Domain-neutral quality invariants to prove:|$))/i,
  );
  if (assignedSliceMatch?.[1] != null) {
    return assignedSliceMatch[1].trim();
  }

  const boundedRepairMatch = raw.match(
    /(?:^|\n\n)Bounded repair slice for this cycle:\s*([\s\S]*?)(?=\n\n(?:Prefer delegating the repair to:|Own only the bounded repair slice above\.|$))/i,
  );
  if (boundedRepairMatch?.[1] != null) {
    return boundedRepairMatch[1].trim();
  }

  return "";
}

function LooksLikeRunnableWebArtifactAssemblyScope(command: string): boolean {
  const text = String(command ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;

  const hasCreationIntent =
    /\b(?:build|create|make|generate|scaffold|implement|prototype|ship|produce|render|assemble)\b/i.test(text) ||
    /(?:만들|구현|제작|생성|짜줘|만들어줘|구축|그린다|렌더)/i.test(text);
  if (!hasCreationIntent) return false;

  const hasSurfaceSignals =
    /\b(?:index\.html|app\.html|html|entry|page|screen|layout|render|ui|ux|component|card|button|form|modal|styles?|css|frontend|browser)\b/i.test(text) ||
    /(?:화면(?!\s*상태)|페이지|레이아웃|렌더|ui|ux|컴포넌트|카드|버튼|폼|모달|스타일|css|프론트엔드|브라우저|html|엔트리)/i.test(text);
  if (!hasSurfaceSignals) return false;

  const stateOnlySignals =
    /\b(?:state|store|engine|logic|types?|schema|sample\s+data|data\s+model|adapter|parser|reducer|serializer)\b/i.test(text) ||
    /(?:상태|저장소|엔진|로직|타입|스키마|샘플\s*데이터|데이터\s*모델|어댑터|파서|리듀서|직렬화)/i.test(text);

  return !stateOnlySignals;
}

function ShouldRequireGeneratedWebArtifactShape(stepCommand: string): boolean {
  const scopedWorkBlock = ExtractScopedImplementationWorkBlock(stepCommand);
  if (scopedWorkBlock !== "") {
    return LooksLikeRunnableWebArtifactAssemblyScope(scopedWorkBlock);
  }
  return LooksLikeGeneratedWebArtifactRequest(stepCommand);
}

function BuildGeneratedWebArtifactShapeSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
  changedFiles: string[] = [],
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  if (!ShouldRequireGeneratedWebArtifactShape(stepCommand)) return null;
  const files = ExtractReportedFilesList(outputText, changedFiles);
  if (files.length > 0 && IsIncrementalImplementationSliceAssignment(stepCommand)) return null;
  if (
    IsIncrementalImplementationSliceAssignment(stepCommand) &&
    LooksLikeNoChangeVerificationHandoff(outputText)
  ) {
    return null;
  }
  if (HasUsableGeneratedWebArtifactShape(files, outputText)) return null;
  const fileEvidence = files.length > 0 ? files.join(" | ") : "none reported";
  const missingScaffoldEvidence =
    files.length === 0 && LooksLikeGeneratedWebArtifactRequest(ResolveOriginAssignmentContext("", stepCommand))
      ? [
          `missing_required_scaffold_files=${RequiredRunnableWebScaffoldFilesText()}`,
          "expected_scaffold=package.json, tsconfig.json, vite.config, index.html, src/main, and src/App before reviewer/verifier",
        ]
      : [];
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated web artifact is incomplete: the website/web-app request did not report a runnable frontend entry plus client code.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `files_created=${fileEvidence}`,
      "expected_shape=web entry file plus client app code, or an explicitly self-contained HTML artifact",
      LooksLikeEmptyOrNonSubstantiveProviderOutput(outputText)
        ? "provider_output=empty_or_non_substantive"
        : "",
      ...missingScaffoldEvidence,
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function IsIncrementalImplementationSliceAssignment(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (text === "") return false;
  return /^complete this pm-assigned [^:\n]+ slice for the assignment:/i.test(text) ||
    /^quality gate feedback requires another repair cycle for this assignment:/i.test(text) ||
    LooksLikeBoundedImplementationSlice(text);
}

function ExtractExplicitReportedFilesList(text: string): string[] {
  const taskComplete = ParseTaskCompletePayload(text);
  return [...new Set([
    ...ExtractFilesCreatedList(text),
    ...(taskComplete?.ChangedFiles ?? []),
    ...ExtractLooseReportedFileList(text),
  ]
    .map(NormalizeReportedFilePath)
    .filter((value) => value !== ""))];
}

function HasHostCommandRequest(text: string): boolean {
  return ExtractTaggedBlockText(text, "Command") !== "" || ExtractTaggedBlockText(text, "Commands") !== "";
}

function LooksLikeNoChangeVerificationHandoff(outputText: string): boolean {
  const raw = String(outputText ?? "").trim();
  if (raw === "" || /\[SEQUENCER_PLAN\]/i.test(raw)) return false;
  const agentCommands = ExtractTaggedBlockText(raw, "AGENT_COMMANDS");
  if (!/"AgentName"\s*:\s*"verifier"/i.test(agentCommands)) return false;

  const text = StripSequencerSignals(raw).replace(/\s+/g, " ").trim();
  const hasNoChangeClaim =
    /\b(?:already|currently|existing|no\s+files?\s+(?:changed|created)|did\s+not\s+(?:change|modify)|nothing\s+to\s+change|already\s+(?:implemented|satisfies|wired))\b/i.test(text) ||
    /(?:현재|이미|더\s*고치지\s*않|수정하지\s*않|변경하지\s*않|요구사항을\s*만족|이미\s*구현|연결되어\s*있)/i.test(text);
  const hasConcreteEvidence =
    /\b(?:useMemo|state|request|input|control|localStorage|recommend|recompute|excluded|verified|confirmed)\b/i.test(text) ||
    /(?:확인\s*결과|입력|상태|추천|제외|재계산|예약\s*충돌|즐겨찾기|필터|검색)/i.test(text);
  const asksForVerification =
    /\b(?:verify|verification|host|smoke|build|ui)\b/i.test(raw) ||
    /(?:검증|확인|실제\s*UI)/i.test(raw);

  return hasNoChangeClaim && hasConcreteEvidence && asksForVerification;
}

function LooksLikeImplementationPlanOnlyOutput(stepCommand: string, outputText: string): boolean {
  const commandText = StripSequencerSignals(stepCommand).replace(/\s+/g, " ").trim();
  const text = String(outputText ?? "").replace(/\s+/g, " ").trim();
  if (commandText === "" || text === "") return false;
  if (
    !IsIncrementalImplementationSliceAssignment(commandText) &&
    !LooksLikeConcreteArtifactCreationRequest(commandText) &&
    !LooksLikeImplementationWork(commandText)
  ) {
    return false;
  }
  if (ExtractExplicitReportedFilesList(outputText).length > 0) return false;
  if (HasHostCommandRequest(outputText)) return false;

  const hasSequencerPlan = /\[SEQUENCER_PLAN\]/i.test(outputText);
  const hasPlanningNarration =
    /\b(?:i\s+will|i'll|i\s+plan\s+to|i\s+am\s+going\s+to|start\s+by|begin\s+by|analy[sz]ed|reviewed|sketched|planned|identified\s+the\s+need|prepare\s+for|먼저|계획|분석|검토)\b/i.test(text);
  const hasConcreteChangeClaim =
    /\b(?:created|implemented|updated|modified|changed|wrote|fixed|added|refactored)\b/i.test(text) ||
    /(?:생성|구현|수정|변경|작성|추가|고쳤|리팩터|리팩토)/i.test(text);
  return hasSequencerPlan || (hasPlanningNarration && !hasConcreteChangeClaim);
}

function BuildImplementationPlanOnlySignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  if (!LooksLikeImplementationPlanOnlyOutput(stepCommand, outputText)) return null;
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Implementation output only described a plan or inspection, but this slice requires a concrete change or an explicit blocker.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      /\[SEQUENCER_PLAN\]/i.test(outputText) ? "implementation_format=unexpected SEQUENCER_PLAN" : "",
      "files_created=none explicitly reported in this implementation reply",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function BuildMissingConcreteArtifactFilesSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
  changedFiles: string[] = [],
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  if (!LooksLikeConcreteArtifactCreationRequest(stepCommand)) return null;
  const files = ExtractReportedFilesList(outputText, changedFiles);
  if (files.length > 0) return null;
  if (
    IsIncrementalImplementationSliceAssignment(stepCommand) &&
    LooksLikeNoChangeVerificationHandoff(outputText)
  ) {
    return null;
  }
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated artifact has no reported files: the request asked for a concrete deliverable, but the implementation did not report any created or changed file paths.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      "files_created=none reported",
      "expected_artifact_evidence=at least one created or changed workspace-relative file path",
      LooksLikeEmptyOrNonSubstantiveProviderOutput(outputText)
        ? "provider_output=empty_or_non_substantive"
        : "",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function ExtractExplicitRequestedArtifactFilePaths(text: string): string[] {
  const paths: string[] = [];
  const filePathPattern =
    /(?:^|[\s"'`([{])(?:\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:html|css|js|jsx|ts|tsx|vue|svelte|json|md|py|rs|go|java|kt|swift|sql|yaml|yml|toml|sh|mjs|cjs)\b/g;
  for (const rawLine of StripSequencerSignals(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (
      /\b(?:do\s+not|don't|must\s+not)\s+(?:edit|modify|rewrite|touch|change|create|add|remove|delete)\b/i.test(line) ||
      /(?:수정하지\s*말|변경하지\s*말|건드리지\s*말|삭제하지\s*말|만들지\s*말|추가하지\s*말|금지)/i.test(line)
    ) {
      continue;
    }
    for (const match of line.match(filePathPattern) ?? []) {
      const normalized = NormalizeReportedFilePath(match.replace(/^[\s"'`([{]+/, ""));
      if (!LooksLikeReportableFilePath(normalized)) continue;
      if (!IsCheckableWorkspaceRelativeFilePath(normalized)) continue;
      paths.push(normalized);
    }
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    const key = NormalizeGeneratedArtifactPath(path);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    unique.push(path);
  }
  return unique.slice(0, 20);
}

function IsExplicitRequestedFileSatisfied(requestedPath: string, files: string[]): boolean {
  const requested = NormalizeGeneratedArtifactPath(requestedPath);
  if (requested === "") return true;
  const requestedBase = requested.split("/").pop() ?? requested;
  const requestedHasDir = requested.includes("/");
  return files.some((file) => {
    const actual = NormalizeGeneratedArtifactPath(file);
    if (actual === "") return false;
    if (actual === requested || actual.endsWith(`/${requested}`)) return true;
    if (!requestedHasDir && (actual.split("/").pop() ?? actual) === requestedBase) return true;
    return false;
  });
}

function LooksLikeExplicitArtifactFileRepairContext(text: string): boolean {
  return /(?:missing explicitly requested artifact files|missing_requested_files|user-named artifact file paths|user-named paths)/i.test(
    text,
  );
}

function BuildMissingExplicitRequestedArtifactFilesSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
  changedFiles: string[] = [],
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  const requestContext =
    ExtractScopedImplementationWorkBlock(stepCommand) ||
    ExtractPrimaryImplementationContext(stepCommand) ||
    stepCommand;
  if (
    !LooksLikeFreshArtifactDeliveryRequest(requestContext) &&
    !LooksLikeGeneratedWebArtifactRequest(requestContext) &&
    !LooksLikeExplicitArtifactFileRepairContext(requestContext)
  ) {
    return null;
  }
  const requestedFiles = ExtractExplicitRequestedArtifactFilePaths(requestContext);
  if (requestedFiles.length === 0) return null;
  const files = ExtractReportedFilesList(outputText, changedFiles);
  const missingFiles = requestedFiles
    .filter((requestedFile) => !IsExplicitRequestedFileSatisfied(requestedFile, files))
    .slice(0, 12);
  if (missingFiles.length === 0) return null;
  const fileEvidence = files.length > 0 ? files.join(" | ") : "none reported";
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated artifact missed explicitly requested file paths: the implementation must create or report every file the assignment named before review.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `files_created=${fileEvidence}`,
      `missing_requested_files=${missingFiles.join(" | ")}`,
      "expected_artifact_evidence=all user-named artifact file paths must be created or reported before reviewer/verifier",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function ExtractMissingReportedArtifactFiles(text: string): string[] {
  const body = ExtractTaggedBlockText(text, ARTIFACT_FILE_STATUS_TAG);
  if (body === "") return [];
  const missingLine = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^missing\s*=/.test(line));
  if (missingLine == null) return [];
  return [...new Set(
    missingLine
      .replace(/^missing\s*=\s*/i, "")
      .split(/\s+\|\s+|,/)
      .map(NormalizeReportedFilePath)
      .filter((value) => value !== ""),
  )].slice(0, 12);
}

function IsRunnableWebScaffoldFile(path: string): boolean {
  const value = NormalizeGeneratedArtifactPath(path);
  if (value === "") return false;
  const base = value.split("/").pop() ?? value;
  return (
    base === "package.json" ||
    base === "index.html" ||
    base === "app.html" ||
    base === "tsconfig.json" ||
    base === "tsconfig.node.json" ||
    base === "vite.config.ts" ||
    base === "vite.config.js" ||
    /(?:^|\/)src\/main\.(?:ts|tsx|js|jsx)$/.test(value) ||
    /(?:^|\/)src\/app\.(?:ts|tsx|js|jsx)$/.test(value)
  );
}

function MissingRequiredRunnableWebScaffoldFiles(files: string[]): string[] {
  const paths = [...new Set(files.map(NormalizeGeneratedArtifactPath).filter((value) => value !== ""))];
  const hasPath = (predicate: (path: string) => boolean): boolean => paths.some(predicate);
  const missing: string[] = [];
  if (!hasPath((path) => path.split("/").pop() === "package.json")) missing.push("package.json");
  if (!hasPath((path) => path.split("/").pop() === "tsconfig.json")) missing.push("tsconfig.json");
  if (!hasPath((path) => /^vite\.config\.(?:ts|js|mjs|mts)$/.test(path.split("/").pop() ?? ""))) {
    missing.push("vite.config");
  }
  if (!hasPath((path) => path.split("/").pop() === "index.html")) missing.push("index.html");
  if (!hasPath((path) => /(?:^|\/)src\/main\.(?:ts|tsx|js|jsx)$/.test(path))) missing.push("src/main");
  if (!hasPath((path) => /(?:^|\/)src\/app\.(?:ts|tsx|js|jsx)$/.test(path))) missing.push("src/App");
  return missing;
}

function LooksLikePartialPackageWebScaffold(files: string[], stepCommand: string, outputText: string): boolean {
  const paths = [...new Set(files.map(NormalizeGeneratedArtifactPath).filter((value) => value !== ""))];
  const hasPackage = paths.some((path) => path.split("/").pop() === "package.json");
  const hasIndex = paths.some((path) => path.split("/").pop() === "index.html");
  const hasMain = paths.some((path) => /(?:^|\/)src\/main\.(?:ts|tsx|js|jsx)$/.test(path));
  const text = `${StripSequencerSignals(stepCommand)}\n${outputText}\n${paths.join("\n")}`;
  const claimsViteReact =
    /\b(?:vite|react|typescript|npm\s+run\s+build)\b/i.test(text) ||
    /(?:리액트|타입스크립트)/i.test(text) ||
    (hasPackage && hasMain);
  return hasPackage && (hasIndex || hasMain) && claimsViteReact && !OutputClaimsSelfContainedWebArtifact(outputText);
}

function LooksLikeRunnableWebScaffoldContext(stepCommand: string, outputText: string): boolean {
  if (ShouldRequireGeneratedWebArtifactShape(stepCommand)) return true;
  const text = `${StripSequencerSignals(stepCommand)}\n${outputText}`.replace(/\s+/g, " ").trim();
  if (text === "") return false;
  return (
    /\b(?:package\.json|npm\s+(?:install|run|test|build)|vite|react|typescript|tsx|src\/main\.(?:ts|tsx|js|jsx)|src\/app\.(?:ts|tsx|js|jsx))\b/i.test(text) ||
    /(?:실행\s*골격|엔트리\s*포인트|패키지\s*설정|리액트|타입스크립트)/i.test(text)
  );
}

function BuildMissingRunnableWebScaffoldFilesSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  const missingFiles = ExtractMissingReportedArtifactFiles(outputText)
    .filter(IsRunnableWebScaffoldFile);
  if (missingFiles.length === 0) return null;
  if (!LooksLikeRunnableWebScaffoldContext(stepCommand, outputText)) return null;
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated web scaffold is not runnable yet: required entry or manifest files reported by the implementation are missing from the workspace.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `missing_required_scaffold_files=${missingFiles.join(" | ")}`,
      "expected_scaffold=before reviewer/verifier, create the missing runnable web entry/manifest files or explicitly switch to a self-contained HTML artifact",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function BuildIncompleteRunnableWebScaffoldContractSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
  changedFiles: string[] = [],
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  const files = ExtractReportedFilesList(outputText, changedFiles);
  if (!LooksLikePartialPackageWebScaffold(files, stepCommand, outputText)) return null;
  const missingFiles = MissingRequiredRunnableWebScaffoldFiles(files);
  if (missingFiles.length === 0) return null;
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated web scaffold is incomplete: package-based Vite/React web artifacts must include the full runnable scaffold before review.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `files_created=${files.join(" | ")}`,
      `missing_required_scaffold_files=${missingFiles.join(" | ")}`,
      "expected_scaffold=package.json, tsconfig.json, vite.config, index.html, src/main, and src/App before reviewer/verifier",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function BuildMissingReportedArtifactFilesSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
): QualityGateSignal | null {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return null;
  const missingFiles = ExtractMissingReportedArtifactFiles(outputText);
  if (missingFiles.length === 0) return null;
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Generated artifact reported files that are missing from the workspace.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `missing_reported_files=${missingFiles.join(" | ")}`,
      "expected_artifact_evidence=reported file paths must exist in the workspace",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function ExtractImplementationTimeoutReason(text: string): string {
  const body = ExtractTaggedBlockText(text, IMPLEMENTATION_TIMEOUT_TAG);
  if (body === "") return "";
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^reason\s*=/.test(line))
    ?.replace(/^reason\s*=\s*/i, "")
    .trim() ?? "provider_timeout_before_artifact_progress";
}

function BuildImplementationTimeoutSignal(
  officeRole: AgentRole,
  stepCommand: string,
  outputText: string,
): QualityGateSignal | null {
  if (!IsImplementationOfficeRole(officeRole)) return null;
  const reason = ExtractImplementationTimeoutReason(outputText);
  if (reason === "") return null;
  return {
    requiresRework: true,
    roleLabel: officeRole,
    summary:
      "Implementation timed out before producing verifiable artifact progress.",
    evidence: [
      stepCommand !== "" ? `quality_step=${stepCommand}` : "",
      `implementation_timeout=${reason}`,
      "expected_repair_shape=split the assignment into a smaller concrete artifact slice and report real files",
    ].filter((part) => part !== ""),
    resolutionTarget: "implementation",
  };
}

function LooksLikeFrontendImplementationContext(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  if (LooksLikeFrontendWork(text)) return true;
  return [
    "apps/web/",
    "apps\\web\\",
    "sequencercoordinator",
    "sequencer coordinator",
    "defaultbundledagentprompttexts",
    "prompt text",
    "prompt texts",
    "bundled prompt",
    "httpclient.ts",
    "workflowapi.ts",
    "agentapi.ts",
    "llmsettingsmodal",
    "llm settings",
    "settings modal",
    "modal path",
    "settings reachability",
    "office overlay",
    "byok modal",
  ].some((needle) => text.includes(needle));
}

function LooksLikeBackendImplementationContext(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  const explicitFrontendContext = LooksLikeFrontendImplementationContext(text);
  const hardBackendClues = [
    ".rs",
    ".py",
    ".sql",
    "backend",
    "database",
    "rust",
    "cargo",
    "cli.rs",
    "src-tauri",
    "desktop",
    "백엔드",
    "서버",
    "데이터베이스",
    "디비",
    "러스트",
    "타우리",
    "tauri",
  ];
  if (hardBackendClues.some((needle) => text.includes(needle))) {
    return true;
  }
  if (explicitFrontendContext) {
    return false;
  }
  return [
    "server",
    "/api/",
    "\\api\\",
    "api route",
    "endpoint",
    "auth",
    "login",
    "signup",
    "sign-up",
    "register",
    "command-line",
    "cli",
    "script",
    "tool",
    "automation",
    "백엔드",
    "서버",
    "인증",
    "로그인",
    "회원가입",
    "데이터베이스",
    "디비",
    "마이그레이션",
    "러스트",
    "타우리",
    "데스크탑",
    "데스크톱",
    "스크립트",
    "도구",
    "툴",
    "프로그램",
  ].some((needle) => text.includes(needle));
}

function LooksLikeDesignImplementationContext(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  return [
    "designer",
    "design system",
    "visual",
    "wireframe",
    "mockup",
    "prototype",
    "layout pass",
    "ux review",
    "ui review",
    "figma",
    "spacing",
    "typography",
    "color palette",
    "interaction flow",
    "디자이너",
    "디자인",
    "시안",
    "와이어프레임",
    "프로토타입",
    "레이아웃",
    "타이포그래피",
    "색상",
  ].some((needle) => text.includes(needle));
}

function LooksLikeDevopsImplementationContext(command: string): boolean {
  const text = (command ?? "").toLowerCase();
  if (text === "") return false;
  return [
    "devops",
    "deploy",
    "deployment",
    "rollout",
    "release",
    "infra",
    "infrastructure",
    "docker",
    "k8s",
    "kubernetes",
    "helm",
    "terraform",
    "observability",
    "monitoring",
    "health check",
    "healthcheck",
    "ci",
    "cd",
    "pipeline",
    "buildkite",
    "github actions",
    "배포",
    "릴리즈",
    "인프라",
    "도커",
    "쿠버네티스",
    "헬름",
    "테라폼",
    "모니터링",
    "헬스체크",
    "파이프라인",
  ].some((needle) => text.includes(needle));
}

function IsLikelyCopiedReferenceNoiseLine(item: string, occurrenceCount: number = 1): boolean {
  const value = String(item ?? "").trim();
  if (value === "") return true;
  const normalized = value.toLowerCase();
  if (/^\+\d+$/.test(normalized)) return true;
  if (/^(?:source|sources|reference|references|citation|citations|출처|참고|참고자료)$/i.test(value)) return true;
  if (/^(?:주요\s*)?(?:단계|규칙|절차|개요|요약)(?:\s*및\s*(?:단계|규칙|절차|개요|요약))*$/i.test(value)) {
    return true;
  }
  const looksLikeBareCompanyLine = /^[a-z][a-z0-9&.'-]*(?:\s+[a-z][a-z0-9&.'-]*){0,3}$/i.test(value) &&
    /\b(?:games|inc|corp|corporation|ltd|llc|co|company|foundation|labs|studio|studios)\b/i.test(value);
  return looksLikeBareCompanyLine && occurrenceCount > 1;
}

function ChunkRequirementText(part: string): string[] {
  const text = part.trim();
  if (text === "") return [];
  if (text.length <= 180) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= 180) {
      chunks.push(rest.trim());
      break;
    }
    const head = rest.slice(0, 180);
    const boundary = Math.max(
      head.lastIndexOf(" "),
      head.lastIndexOf(","),
      head.lastIndexOf("，"),
      head.lastIndexOf("、"),
    );
    const cut = boundary >= 90 ? boundary + 1 : 180;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  return chunks.filter((chunk) => chunk !== "");
}

function ExpandRequirementChecklistCandidates(goalText: string): string[] {
  const cleanedLines = String(goalText ?? "").split(/\r?\n/).map((rawLine) =>
    rawLine
      .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "")
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .trim(),
  );
  const candidates: string[] = [];
  for (const line of cleanedLines) {
    if (line.length <= 180) {
      candidates.push(line);
      continue;
    }
    const sentenceParts = line
      .split(/(?:[.!?。！？;；]+|\s{2,})/)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (sentenceParts.length === 0) {
      candidates.push(...ChunkRequirementText(line));
      continue;
    }
    for (const part of sentenceParts) {
      if (part.length <= 180) {
        candidates.push(part);
        continue;
      }
      const clauseParts = part
        .split(/(?:[,，、]|\s+(?:and|also|plus|but|or)\s+|그리고|또한|또|다만|하지만)/i)
        .map((clause) => clause.trim())
        .filter((clause) => clause !== "");
      if (clauseParts.length === 0) {
        candidates.push(...ChunkRequirementText(part));
        continue;
      }
      for (const clause of clauseParts) {
        candidates.push(...ChunkRequirementText(clause));
      }
    }
  }
  return candidates;
}

function IsHighSignalRequirementChecklistItem(item: string): boolean {
  return /(?:\b(?:must|only|never|not|cannot|can't|exclude|excluded|unavailable|already|reserved|booked|banned|blocked|current\s+input|condition|negative|required|mandatory)\b|안\s*돼|하면\s*안|못\s*하|못해야|제외|금지|이미|예약된|차단|막아|현재\s*입력|조건|반드시|꼭|오직|만\s*(?:추천|선택|허용)|폐점|닫은|싫어|비선호)/i.test(
    item,
  );
}

function ExtractUserRequirementChecklist(goalText: string): string[] {
  const seen = new Set<string>();
  const candidates: Array<{ item: string; index: number; highSignal: boolean }> = [];
  const checklistCandidates = ExpandRequirementChecklistCandidates(goalText);
  const occurrenceCounts = checklistCandidates.reduce((counts, item) => {
    const normalized = item.toLowerCase();
    if (normalized !== "") counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  for (const item of checklistCandidates) {
    if (item === "" || item.length > 180) continue;
    const normalized = item.toLowerCase();
    if (IsLikelyCopiedReferenceNoiseLine(item, occurrenceCounts.get(normalized) ?? 1)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push({
      item,
      index: candidates.length,
      highSignal: IsHighSignalRequirementChecklistItem(item),
    });
  }

  if (candidates.length > 0) {
    const maxItems = 12;
    const selected = new Set<number>();
    for (const candidate of candidates.slice(0, 2)) {
      selected.add(candidate.index);
    }
    for (const candidate of candidates.filter((entry) => entry.highSignal)) {
      if (selected.size >= maxItems) break;
      selected.add(candidate.index);
    }
    for (const candidate of candidates) {
      if (selected.size >= maxItems) break;
      selected.add(candidate.index);
    }
    return candidates
      .filter((candidate) => selected.has(candidate.index))
      .sort((a, b) => a.index - b.index)
      .map((candidate) => candidate.item);
  }
  const fallback = String(goalText ?? "").replace(/\s+/g, " ").trim();
  return fallback === "" ? [] : [fallback.slice(0, 180)];
}

function BuildQualityRequirementChecklistBlock(goalText: string): string {
  const items = ExtractUserRequirementChecklist(goalText);
  if (items.length === 0) return "";
  return [
    "Original user requirement checklist to preserve:",
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function BuildQualityInvariantChecklistBlock(goalText: string): string {
  const compactGoal = String(goalText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const hasInputDrivenSelection =
    /recommend|ranking|rank|select|selection|choose|filter|search|match|book|reserve|schedule|assign|allocate|추천|순위|선택|고르|픽|필터|검색|매칭|예약|일정|배정|할당/.test(
      compactGoal,
    );
  const baselineItems = [
    "Every visible result must be consistent with the current user input, not just with a static default example.",
    "Conditional explanations must only appear when the condition is true for the current input.",
    "Negative wording such as missing, unavailable, none, short, weak, full, blocked, or already-used must not be treated as a positive signal.",
    "Preference wording such as preferred, likes, favorite, soft, priority, or similar must be treated as ranking/weighting, not as a hard exclusion, unless the user explicitly says must, only, required, unavailable, excluded, or blocked.",
  ];
  const selectionItems = hasInputDrivenSelection
    ? [
        "For recommendation, selection, scheduling, filtering, booking, or ranking flows, unavailable, already-used, reserved, banned, excluded, or conflicting entities must not be recommended as valid primary choices.",
        "Verification must include at least one negative/adversarial scenario derived from the user's words, not only a happy-path smoke test.",
      ]
    : [];
  return [
    "Domain-neutral quality invariants to prove:",
    ...baselineItems
      .concat(selectionItems)
      .map((item, index) => `${index + 1}. ${item}`),
  ].join("\n");
}

function BuildFrontendUxEvidenceChecklistBlock(goalText: string): string {
  const text = String(goalText ?? "").replace(/\s+/g, " ").trim();
  if (
    !/(?:\b(?:web|website|frontend|ui|ux|react|vite|browser|mobile|responsive|dashboard|form|button)\b|웹|화면|프론트|모바일|반응형|대시보드|폼|버튼)/i.test(
      text,
    )
  ) {
    return "";
  }
  return [
    "Frontend/web UI evidence to report when applicable:",
    "1. In [ReviewFindings] or [Verification], name the concrete UI/UX evidence categories that were checked: input/search/filter, empty/loading state, mobile/responsive, error/validation, correction/recovery path, button interaction, scanability, visual layout, viewport overflow/action visibility.",
    "2. Claim a category only when it is backed by source, smoke/test, local preview, browser, or host-command evidence. A requested feature is not proof by itself.",
    "3. If a requested UI/UX category cannot be proven, keep it in [OpenRisks] and do not mark final user-facing verification as pass.",
    "4. For premium product quality, report these higher-level evidence categories only when proven: primary task flow, interaction feedback, state coverage, correction/recovery path, scanability, mobile/responsive, no horizontal viewport overflow or clipped primary actions, accessibility basics, visual craft, one coherent reference_archetype, honest source_level, reference_quality_bar coverage, and reference pattern adaptation.",
    "5. Source-string-only smoke is insufficient for layout quality: when tables, cards, grids, or action buttons are present, prove desktop and narrow/mobile viewport fit and that primary interactive controls are visible/reachable.",
  ].join("\n");
}

function AppendQualityRequirementGuidanceToCommand(
  command: string,
  officeRole: "reviewer" | "verifier",
  goalText: string,
): string {
  if (command.includes("Original user requirement checklist to preserve:")) return command;
  const requirementBlock = BuildQualityRequirementChecklistBlock(goalText);
  const invariantBlock = BuildQualityInvariantChecklistBlock(goalText);
  const frontendUxBlock = BuildFrontendUxEvidenceChecklistBlock(goalText);
  const qualityBlock = [requirementBlock, invariantBlock, frontendUxBlock].filter((block) => block !== "").join("\n\n");
  if (qualityBlock === "") return command;
  const isBoundedRepairQualityCommand =
    /(?:Bounded repair slice|Verification gaps to close|Review gate format issues to close|Quality gate failures outside this bounded slice)/i.test(command);
  const roleGuidance =
    isBoundedRepairQualityCommand
      ? (
        officeRole === "reviewer"
          ? "Bounded quality gate coverage: review only the bounded repair slice above. Use the checklist below as context to catch regressions inside the changed slice, but do not fail this bounded gate for future-card or deferred requirements that the slice explicitly says are outside scope. Fail only when the bounded fix is missing, false for current input, or creates a concrete regression."
          : "Bounded quality gate coverage: verify only the bounded repair slice above with the smallest relevant executable evidence. Use the checklist below as context to catch regressions inside the changed slice, but do not fail this bounded gate for future-card or deferred requirements that the slice explicitly says are outside scope. Fail or block only when the bounded fix itself is unproven, still failing, or creates a concrete regression."
      )
      : (
        officeRole === "reviewer"
          ? "Quality gate requirement coverage: compare the deliverable against every user-visible checklist item below. Also derive domain-neutral invariants from the original request: unavailable/already-used items, mutually exclusive choices, user-stated negatives, and conditional explanation claims. For frontend or web artifacts, report concrete UI/UX evidence categories actually checked, not wishlist prose: input/search/filter, empty/loading state, mobile/responsive, error/validation, correction/recovery path, button interaction, scanability, visual layout, viewport overflow/action visibility. For premium product quality, separately report proven evidence for primary task flow, interaction feedback, state coverage, correction/recovery path, scanability, mobile/responsive, no horizontal viewport overflow or clipped primary actions, accessibility basics, visual craft, one coherent reference_archetype, honest source_level, reference_quality_bar coverage, and reference pattern adaptation; if unproven, list it as a premium gap rather than pretending the artifact is polished. Source-string-only smoke is insufficient for layout quality when tables, grids, cards, or action buttons can clip off viewport. If any required item is missing, unsupported, only hand-waved, or contradicted by the current input/output behavior, [ReviewVerdict] must be needs_rework. This is not domain-specific: apply the same rule extraction to any natural-language request. Treat transient/generated sample artifacts as verification evidence, not as project feature scope or commit targets, unless the user explicitly asks to keep them."
          : "Quality gate requirement coverage: prove the checklist below with concrete evidence and at least one negative/adversarial scenario when the deliverable depends on user input. For frontend or web artifacts, include a user-flow, local preview, or smoke check when possible, and report concrete UI/UX evidence categories actually checked: input/search/filter, empty/loading state, mobile/responsive, error/validation, correction/recovery path, button interaction, scanability, visual layout, viewport overflow/action visibility. For premium product quality, separately report proven evidence for primary task flow, interaction feedback, state coverage, correction/recovery path, scanability, mobile/responsive, no horizontal viewport overflow or clipped primary actions, accessibility basics, visual craft, one coherent reference_archetype, honest source_level, reference_quality_bar coverage, and reference pattern adaptation. Build/lint alone is not enough for final user-facing artifact quality; source-string-only smoke is insufficient for layout quality when tables, grids, cards, or action buttons can clip off viewport. Fail or block if unavailable/already-used items can still be recommended/selected, mutually exclusive states co-exist, negative wording is read as positive, conditional explanations appear when false for current input, or primary interactive controls are not proven visible/reachable. If coverage is missing or cannot be proven, [VerificationStatus] must be fail or blocked with actionable [OpenRisks]."
      );
  return `${command}\n\n${roleGuidance}\n${qualityBlock}`;
}

function BuildRunnableFrontendScaffoldContractBlock(command: string, goalText: string): string {
  const commandText = String(command ?? "");
  if (commandText.includes("Runnable Vite/React scaffold contract:")) return "";
  const combined = `${commandText}\n${String(goalText ?? "")}`;
  const commandMentionsScaffold =
    /(?:package\.json|tsconfig(?:\.json)?|vite\.config|src\/main|src\/App|scaffold|skeleton|foundation\/data|base data|스캐폴|뼈대|골격)/i.test(
      commandText,
    );
  const looksLikeViteReactWeb =
    /(?:vite|react|tsx|frontend|web\s*app|website|client-side|브라우저|웹\s*(?:앱|사이트)?|프론트엔드)/i.test(
      combined,
    );
  if (!commandMentionsScaffold || !looksLikeViteReactWeb) return "";
  return [
    "Runnable Vite/React scaffold contract:",
    "- If this slice creates or repairs package.json, tsconfig.json, vite.config, index.html, src/main, or src/App, make that scaffold build-ready in the same slice.",
    "- package.json must include `type: \"module\"`, keep runtime dependencies (`react`, `react-dom`) in dependencies, and keep build/type tooling (`vite`, `typescript`, `@vitejs/plugin-react`, `@types/react`, `@types/react-dom`) in devDependencies.",
    "- Use current stable Vite/React/TypeScript-compatible versions; avoid known vulnerable/stale scaffolds such as Vite <=6.4.1, Vite 5 CJS deprecation output, or any brand-new artifact that emits npm audit warnings.",
    "- tsconfig.json must be compatible with current TypeScript/Vite: use `jsx: \"react-jsx\"`, `moduleResolution: \"bundler\"`, and avoid deprecated `node`/`node10` moduleResolution.",
    "- Include `src/vite-env.d.ts` with `/// <reference types=\"vite/client\" />` when Vite/TS ambient types are needed.",
    "- Do not leave these as a later repair unless the current slice explicitly does not own scaffold/config files.",
  ].join("\n");
}

function BuildClientSideWebArtifactBoundaryBlock(command: string, goalText: string): string {
  const originalIntentText = String(goalText ?? "").trim() !== "" ? goalText : command;
  const intent = ClassifyRequestIntent(originalIntentText);
  if (!intent.isClientSideWebArtifact || intent.allowsPythonBackend) return "";
  return [
    "Client-side web artifact boundary:",
    "- Treat this as a client-side web deliverable unless the original user request explicitly asks for Python runtime or backend-service work.",
    "- Do not create or edit Python files, `backend/**`, `tests/**/*.py`, `__pycache__/**`, or legacy service-folder files for this web artifact.",
    "- If existing dirty paths or reviewer/verifier context mention stale Python/backend files from prior runs, ignore them as workspace noise and repair only the active web files.",
    "- Keep fixes inside the active web surface: package.json, tsconfig*, vite.config*, index.html, src/**, and artifact-local JS/TS smoke support.",
  ].join("\n");
}

function BuildRepairScopeAuthorityText(assignmentContext: string): string {
  const intent = ClassifyRequestIntent(assignmentContext);
  const common =
    "Use the Request intent classification as the file-scope authority. ";
  if (intent.isClientSideWebArtifact && !intent.allowsPythonBackend) {
    return common +
      "This is a fresh/client-side web artifact unless the original request says otherwise: do not create or edit Python files, backend/**, tests/**/*.py, __pycache__/**, or legacy service-folder files even if stale workspace files or quality context mention them; ignore those as prior-run noise and repair only the active web files. ";
  }
  if (intent.allowsPythonBackend || intent.explicitlyNamesBackendPythonPath) {
    return common +
      "The original request names or allows backend/Python work, so do not discard backend/Python files as stale noise when they are named by the request, dirty workspace, or failing evidence. Keep the repair narrow to those named files and their direct dependencies. ";
  }
  if (intent.isModifyExisting || intent.isRepair) {
    return common +
      "This is existing-work repair/modification, so prioritize named or dirty files and do not scaffold an unrelated fresh app unless the request explicitly asks for one. ";
  }
  return common +
    "Keep the repair narrow to the bounded slice and files named by current evidence. ";
}

function BuildDirtyWorkspaceScopeRule(assignmentContext: string): string {
  const intent = ClassifyRequestIntent(assignmentContext);
  if (intent.isFreshCreate && intent.isClientSideWebArtifact && !intent.allowsPythonBackend) {
    return [
      "Request intent: fresh client-side web artifact.",
      "Dirty files are workspace context, not automatic scope. Do not treat old Python/backend/generated files as prior output to repair unless the original assignment names them.",
      "Keep fresh web work inside the active artifact surface: package.json, tsconfig*, vite.config*, index.html, src/**, and artifact-local JS/TS smoke support.",
    ].join("\n");
  }
  if (intent.isFreshCreate) {
    return [
      "Request intent: fresh artifact/deliverable.",
      "Dirty files are workspace context, not automatic scope. Do not treat them as prior output to repair unless the assignment names them.",
    ].join("\n");
  }
  if (intent.mode === "explicit_backend_python" || intent.isModifyExisting || intent.isRepair) {
    return [
      `Request intent: ${intent.mode}.`,
      "For repair/refactor/debug/modify requests, prioritize named or dirty files and their immediate dependencies before expanding to broad repo inspection.",
      "Do not discard Python/backend files as stale noise when the original request or failing evidence names them.",
    ].join("\n");
  }
  return [
    "Request intent: ambiguous.",
    "These files are workspace context, not automatic scope. Prefer explicitly named files and current failing evidence before broad repo inspection.",
  ].join("\n");
}

function AppendImplementationRequirementGuidanceToCommand(command: string, goalText: string): string {
  if (command.includes("Original user requirement checklist to preserve:")) return command;
  const originalIntentText = String(goalText ?? "").trim() !== "" ? goalText : command;
  const requestIntentBlock = ShouldEmitRequestIntentClassification(originalIntentText)
    ? BuildRequestIntentClassificationBlock(originalIntentText)
    : "";
  const requirementBlock = BuildQualityRequirementChecklistBlock(goalText);
  const invariantBlock = BuildQualityInvariantChecklistBlock(goalText);
  const scaffoldContractBlock = BuildRunnableFrontendScaffoldContractBlock(command, goalText);
  const clientSideWebBoundaryBlock = BuildClientSideWebArtifactBoundaryBlock(command, goalText);
  const qualityBlock = [requirementBlock, invariantBlock].filter((block) => block !== "").join("\n\n");
  const extraBlocks = [requestIntentBlock, scaffoldContractBlock, clientSideWebBoundaryBlock, qualityBlock].filter((block) => block !== "").join("\n\n");
  if (extraBlocks === "") return command;
  return `${command}\n\nImplementation requirement guardrails: preserve the user-visible requirements below while making the smallest needed change. Execute only the assigned slice. Treat words like only, do not, not yet, next slice, later slice, and 하지 말/아직 as hard scope boundaries: do not implement future-card UI, persistence, scoring, or polish in an earlier scaffold/data card, and do not overwrite previous slices with a placeholder preview. Do not optimize for only one sample domain or one static default example. Do not use [Command] to write or overwrite source files, scaffold multi-file apps, or run large inline Python/Node/heredoc scripts that author files; make source changes in your main reply and use [FilesCreated] to report them. Reserve [Command] for truly necessary install/build/test/runtime commands or tiny unblockers only. Do not spend the main reply only restating defects, review findings, or risk analysis; implementation output must either apply a concrete change and report the changed files, or say exactly what blocker prevented a safe code change.\n${extraBlocks}`;
}

function AttachQualityRequirementGuidance(
  row: DispatchRow | null,
  officeRole: "reviewer" | "verifier",
  goalText: string,
): DispatchRow | null {
  if (row == null) return null;
  return {
    ...row,
    command: AppendQualityRequirementGuidanceToCommand(row.command, officeRole, goalText),
  };
}

type ImplementationOfficeRole =
  | "frontend"
  | "backend"
  | "developer"
  | "designer"
  | "devops";

function ResolveImplementationOwnerRole(command: string): ImplementationOfficeRole | null {
  const rowText = (command ?? "").toLowerCase();
  const designScore =
    (LooksLikeDesignImplementationContext(rowText) ? 4 : 0) +
    (rowText.includes("figma") || rowText.includes("wireframe") || rowText.includes("mockup") ? 3 : 0) +
    (rowText.includes("designer") || rowText.includes("design system") || rowText.includes("디자인") ? 2 : 0);
  const devopsScore =
    (LooksLikeDevopsImplementationContext(rowText) ? 4 : 0) +
    (rowText.includes("deploy") || rowText.includes("infrastructure") || rowText.includes("kubernetes") || rowText.includes("배포") ? 3 : 0) +
    (rowText.includes("devops") || rowText.includes("ci") || rowText.includes("cd") ? 2 : 0);
  const frontendScore =
    (LooksLikeFrontendImplementationContext(rowText) ? 3 : 0) +
    (rowText.includes("apps/web/") || rowText.includes("apps\\web\\") ? 4 : 0) +
    (rowText.includes(".tsx") || rowText.includes(".jsx") ? 2 : 0) +
    (rowText.includes("frontend") || rowText.includes("프론트") ? 1 : 0);
  const backendScore =
    (LooksLikeBackendImplementationContext(rowText) ? 3 : 0) +
    (rowText.includes("src-tauri") || rowText.includes(".rs") ? 4 : 0) +
    (rowText.includes(".py") || rowText.includes(".sql") ? 2 : 0) +
    (rowText.includes("backend") || rowText.includes("백엔드") ? 1 : 0);
  const developerScore =
    (LooksLikeImplementationWork(rowText) ? 2 : 0) +
    (rowText.includes("developer") ? 2 : 0) +
    (rowText.includes("implement") || rowText.includes("fix") || rowText.includes("refactor") ? 1 : 0);

  const scoredRoles: Array<{ role: ImplementationOfficeRole; score: number }> = [
    { role: "designer", score: designScore },
    { role: "devops", score: devopsScore },
    { role: "frontend", score: frontendScore },
    { role: "backend", score: backendScore },
    { role: "developer", score: developerScore },
  ];
  scoredRoles.sort((left, right) => right.score - left.score);
  const lead = scoredRoles[0];
  if (lead != null && lead.score > 0) {
    return lead.role;
  }

  return null;
}

function ShouldPreferCurrentImplementationAgentForQualityRework(
  registry: AgentRegistry,
  agentId: string,
  signals: QualityGateSignal[],
): boolean {
  const normalizedAgentId = String(agentId ?? "").trim().toLowerCase();
  if (normalizedAgentId === "" || !IsImplementationAgentId(registry, normalizedAgentId)) return false;
  if (signals.length === 0) return false;
  return signals.some((signal) => {
    const text = `${signal.summary}\n${signal.evidence.join("\n")}`.toLowerCase();
    return (
      text.includes("generated artifact has no reported files") ||
      text.includes("generated artifact reported files that are missing") ||
      text.includes("generated web scaffold is not runnable yet") ||
      text.includes("implementation output only described a plan or inspection") ||
      text.includes("implementation_format=unexpected sequencer_plan") ||
      text.includes("files_created=none reported") ||
      text.includes("files_created=none explicitly reported") ||
      text.includes("missing_required_scaffold_files=") ||
      text.includes("expected_artifact_evidence=") ||
      text.includes("reported file paths must exist in the workspace")
    );
  });
}

function ResolveImplementationOwnerRoles(command: string): ImplementationOfficeRole[] {
  const text = (command ?? "").toLowerCase();
  if (text === "") return [];

  const findFirstIndex = (patterns: string[]): number => {
    let best = Number.MAX_SAFE_INTEGER;
    for (const pattern of patterns) {
      const idx = text.indexOf(pattern);
      if (idx >= 0 && idx < best) best = idx;
    }
    return best === Number.MAX_SAFE_INTEGER ? -1 : best;
  };
  const roleHits: Array<{ role: ImplementationOfficeRole; index: number }> = [];
  const pushRoleHit = (role: ImplementationOfficeRole, index: number): void => {
    if (index < 0) return;
    roleHits.push({ role, index });
  };

  if (LooksLikeDesignImplementationContext(text)) {
    pushRoleHit(
      "designer",
      findFirstIndex([
        "designer",
        "figma",
        "wireframe",
        "mockup",
        "prototype",
        "design system",
        "visual",
        "디자이너",
        "디자인",
        "시안",
        "와이어프레임",
        "프로토타입",
        "레이아웃",
      ]),
    );
  }
  if (LooksLikeDevopsImplementationContext(text)) {
    pushRoleHit(
      "devops",
      findFirstIndex([
        "devops",
        "deploy",
        "deployment",
        "rollout",
        "infrastructure",
        "docker",
        "kubernetes",
        "helm",
        "terraform",
        "ci",
        "cd",
        "배포",
        "릴리즈",
        "인프라",
        "도커",
        "쿠버네티스",
        "헬름",
        "테라폼",
        "모니터링",
        "파이프라인",
      ]),
    );
  }
  const preferDesignerOverFrontend =
    LooksLikeDesignImplementationContext(text) &&
    ![
      ".tsx",
      ".jsx",
      "component",
      "react",
      "tailwind",
      "vite",
    ].some((needle) => text.includes(needle));
  if (LooksLikeFrontendImplementationContext(text)) {
    const frontendIndex = findFirstIndex([
      "frontend",
      "프론트",
      "프론트엔드",
      "website",
      "web app",
      "webapp",
      "browser app",
      "user-facing",
      "dashboard",
      "apps/web/",
      "apps\\web\\",
      ".tsx",
      ".jsx",
      "httpclient.ts",
      "workflowapi.ts",
      "agentapi.ts",
      "화면",
      "페이지",
      "웹사이트",
      "웹앱",
      "웹 앱",
      "브라우저",
      "대시보드",
      "모달",
      "버튼",
    ]);
    pushRoleHit(
      "frontend",
      frontendIndex >= 0
        ? frontendIndex + (preferDesignerOverFrontend ? 500 : 0)
        : -1,
    );
  }
  if (LooksLikeBackendImplementationContext(text)) {
    pushRoleHit(
      "backend",
      findFirstIndex([
        "backend",
        "백엔드",
        "서버",
        "src-tauri",
        ".rs",
        ".py",
        ".sql",
        "/api/",
        "\\api\\",
        "endpoint",
        "auth",
        "인증",
        "로그인",
        "회원가입",
        "데이터베이스",
        "디비",
        "마이그레이션",
        "command-line",
        "cli",
        "script",
        "tool",
        "automation",
        "스크립트",
        "도구",
        "툴",
        "프로그램",
      ]),
    );
  }
  const hasSpecificImplementationHit = roleHits.some((hit) => hit.role !== "developer");
  if (LooksLikeImplementationWork(text) && !hasSpecificImplementationHit) {
    pushRoleHit(
      "developer",
      findFirstIndex([
        "developer",
        "implement",
        "fix",
        "repair",
        "refactor",
        "feature",
      ]),
    );
  }

  const explicitRolePatterns: Array<{ role: ImplementationOfficeRole; regex: RegExp }> = [
    { role: "designer", regex: /\bdesigner\b/g },
    { role: "devops", regex: /\bdevops\b/g },
    { role: "frontend", regex: /\bfrontend\b/g },
    { role: "backend", regex: /\bbackend\b/g },
    { role: "developer", regex: /\bdeveloper\b/g },
    { role: "designer", regex: /디자이너|디자인/g },
    { role: "devops", regex: /devops|배포|인프라|도커|쿠버네티스/g },
    { role: "frontend", regex: /프론트엔드|프론트/g },
    { role: "backend", regex: /백엔드|서버/g },
  ];
  for (const { role, regex } of explicitRolePatterns) {
    const match = regex.exec(text);
    pushRoleHit(role, match?.index ?? -1);
  }

  const orderedRoles = roleHits
    .sort((a, b) => {
      const left = a.index >= 0 ? a.index : Number.MAX_SAFE_INTEGER;
      const right = b.index >= 0 ? b.index : Number.MAX_SAFE_INTEGER;
      return left - right;
    })
    .map((hit) => hit.role);
  const uniqueRoles = [...new Set(orderedRoles)];
  if (uniqueRoles.length > 0) return uniqueRoles;

  const fallbackRole = ResolveImplementationOwnerRole(text);
  return fallbackRole != null ? [fallbackRole] : [];
}

function ResolvePreferredImplementationAgentId(
  registry: AgentRegistry,
  role: ImplementationOfficeRole,
): string | null {
  const developerId = registry.FindAgentIdByOfficeRole("developer")?.trim().toLowerCase() ?? "";
  const frontendId = registry.FindAgentIdByOfficeRole("frontend")?.trim().toLowerCase() ?? "";
  const backendId = registry.FindAgentIdByOfficeRole("backend")?.trim().toLowerCase() ?? "";
  const designerId = registry.FindAgentIdByOfficeRole("designer")?.trim().toLowerCase() ?? "";
  const devopsId = registry.FindAgentIdByOfficeRole("devops")?.trim().toLowerCase() ?? "";
  const candidates: string[] = (() => {
    switch (role) {
      case "designer":
        return [designerId, developerId, frontendId];
      case "devops":
        return [devopsId, developerId, backendId];
      case "frontend":
        return [frontendId, developerId];
      case "backend":
        return [backendId, developerId];
      case "developer":
      default:
        return [developerId, backendId, frontendId];
    }
  })();
  const resolved = candidates.find((value) => value.trim() !== "") ?? "";
  return resolved !== "" ? resolved : null;
}

function RoutePmImplementationRowsByContext(
  rows: DispatchRow[],
  registry: AgentRegistry,
  goalText: string,
): DispatchRow[] {
  if (rows.length === 0) return rows;
  const pmAgentId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "pm";

  return rows.map((row) => {
    const normalizedCommand = String(row.command ?? "").trim();
    const hasGeneratedArtifactGoal =
      LooksLikeGeneratedWebArtifactRequest(goalText) ||
      LooksLikeInputDrivenDecisionArtifactQualityContext(goalText);
    const looksLikeArtifactFeatureSlice = LooksLikeGeneratedArtifactFeatureSlice(
      normalizedCommand,
      goalText,
    );
    const looksLikePmTriageStep =
      /^(audit|inspect|triage|analyze|assess|confirm)\b/i.test(normalizedCommand);
    if (
      row.officeRole !== "pm" ||
      (!looksLikeArtifactFeatureSlice && LooksLikePmPlanningWork(row.command)) ||
      looksLikePmTriageStep ||
      (!LooksLikeImplementationWork(row.command) && !looksLikeArtifactFeatureSlice) ||
      String(row.agentId ?? "").trim().toLowerCase() !== pmAgentId
    ) {
      return row;
    }
    const targetContext = looksLikeArtifactFeatureSlice || hasGeneratedArtifactGoal
      ? `${goalText}\n${normalizedCommand}`
      : row.command;
    const targetAgentId =
      InferQualityReworkTargets(registry, targetContext, []).find(
        (agentId) => agentId.trim().toLowerCase() !== pmAgentId,
      ) ?? null;
    if (targetAgentId != null && targetAgentId.trim() !== "") {
      return {
        ...row,
        agentId: targetAgentId,
        cliRole: registry.MapTauriCliRoleKeyToCliRole(targetAgentId),
        officeRole: registry.MapAgentIdToOfficeRole(targetAgentId),
      };
    }
    return {
      ...row,
      agentId: row.agentId,
      cliRole: row.cliRole,
      officeRole: row.officeRole,
    };
  });
}

function KeepPmPlanningRowsOnPm(
  rows: DispatchRow[],
  registry: AgentRegistry,
): DispatchRow[] {
  if (rows.length === 0) return rows;
  const pmAgentId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "pm";
  return rows.map((row) => {
    if (row.officeRole !== "reviewer" && row.officeRole !== "verifier" && LooksLikePmPlanningWork(row.command)) {
      return {
        ...row,
        agentId: pmAgentId,
        cliRole: registry.MapTauriCliRoleKeyToCliRole(pmAgentId),
        officeRole: registry.MapAgentIdToOfficeRole(pmAgentId),
      };
    }
    if (
      row.officeRole === "pm" ||
      row.officeRole === "reviewer" ||
      row.officeRole === "verifier" ||
      LooksLikeImplementationWork(row.command)
    ) {
      return row;
    }
    return {
      ...row,
      agentId: pmAgentId,
      cliRole: registry.MapTauriCliRoleKeyToCliRole(pmAgentId),
      officeRole: registry.MapAgentIdToOfficeRole(pmAgentId),
    };
  });
}

function CollapsePmOnlyPlanningRows(
  rows: DispatchRow[],
  registry: AgentRegistry,
): DispatchRow[] {
  if (rows.length <= 2) return rows;
  const pmAgentId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "pm";
  const allPmOwned = rows.every(
    (row) =>
      row.officeRole === "pm" &&
      String(row.agentId ?? "").trim().toLowerCase() === pmAgentId,
  );
  if (!allPmOwned) return rows;

  const focusList = rows
    .map((row, index) => `${index + 1}. ${String(row.command ?? "").trim()}`)
    .filter((line) => line.trim() !== `${line.split(".")[0]}.`);

  const base = rows[0]!;
  return [
    {
      ...base,
      command:
        "Create one compact PM execution brief that merges the PM-only planning topics below. " +
        "Do not expand into a long requirements document; capture only scope, key risks, input/output contract, and success criteria needed for handoff.\n\n" +
        focusList.join("\n"),
      stepNumber: 1,
    },
    {
      ...base,
      command:
        "Produce the final role handoff from the compact brief. Keep it short: one PM summary line, one role note per needed role, and only the minimum implementation/reviewer/verifier tasks. " +
        "If implementation should continue, emit exactly one [AGENT_COMMANDS] block with compact execution cards after the final step marker.",
      stepNumber: 2,
    },
  ];
}

function BuildDefaultQualityGateRow(
  registry: AgentRegistry,
  officeRole: "reviewer" | "verifier",
  rows: DispatchRow[],
): DispatchRow | null {
  const agentId = registry.FindAgentIdByOfficeRole(officeRole);
  if (agentId == null || agentId.trim() === "") return null;
  const looksFrontend = rows.some((row) => LooksLikeFrontendImplementationContext(row.command));
  const looksDesign = rows.some((row) => LooksLikeDesignImplementationContext(row.command));
  const looksDevops = rows.some((row) => LooksLikeDevopsImplementationContext(row.command));
  return {
    agentId,
    command:
      officeRole === "reviewer"
        ? "Review the completed implementation from prior steps using the provided diff/prior-step evidence first. Keep it bounded: at most 4 one-line findings and 4 one-line open risks. Do not run broad exploration or emit host commands. Check user-visible requirement coverage before marking ready. If any unresolved risk remains, the verdict must be needs_rework and [OpenRisks] must stay actionable; do not mark the work ready while open risks remain. If a separate verifier gate is already assigned, do not list 'I did not run tests/build' as an OpenRisk; leave that to verifier unless it reveals a concrete review blocker."
        : looksDesign
          ? "Verify the completed design work against the acceptance criteria, intended user flow, visual consistency, and handoff readiness. Keep evidence compact: at most 6 one-line verification bullets and 4 one-line risks. Report concrete mismatches, missing assets, and any blockers to implementation."
        : looksDevops
            ? "Verify the completed operations work with the most relevant deployment, health-check, rollback, and observability evidence. Keep evidence compact: at most 6 one-line verification bullets and 4 one-line risks. Report concrete pass/fail facts, missing safeguards, and any blocked rollout dependencies."
        : looksFrontend
          ? "Verify the completed client-side work with the most relevant build, test, and runtime smoke checks. Keep evidence compact: at most 6 one-line verification bullets and 4 one-line risks. If a lightweight local preview is possible, use an existing project start/dev script or a setup-wrapped verification command; do not launch standalone generic preview servers such as `python -m http.server`, raw `vite`, or `serve`."
          : "Verify the completed work with the most relevant build, test, or runtime checks. Keep evidence compact: at most 6 one-line verification bullets and 4 one-line risks. For DAACS work, do not request Python runtime or legacy service-folder commands; use Rust/Tauri/client-side checks, with Auth covered by the Rust auth server.",
    stepNumber: rows.length + 1,
    cliRole: registry.MapTauriCliRoleKeyToCliRole(agentId),
    officeRole: registry.MapAgentIdToOfficeRole(agentId),
  };
}

function EnsureQualityGateSteps(
  rows: DispatchRow[],
  registry: AgentRegistry,
  goalText: string,
): DispatchRow[] {
  if (rows.length === 0) return rows;
  const hasImplementation = rows.some(
    (row) => row.officeRole !== "pm" && LooksLikeImplementationWork(row.command),
  );
  if (!hasImplementation) return rows;
  const coreRows = rows.filter(
    (row) => row.officeRole !== "reviewer" && row.officeRole !== "verifier",
  );
  const existingReviewer = rows.find((row) => row.officeRole === "reviewer") ?? null;
  const existingVerifier = rows.find((row) => row.officeRole === "verifier") ?? null;
  const reviewerRow = AttachQualityRequirementGuidance(
    existingReviewer ?? BuildDefaultQualityGateRow(registry, "reviewer", coreRows),
    "reviewer",
    goalText,
  );
  const verifierRow = AttachQualityRequirementGuidance(
    existingVerifier ?? BuildDefaultQualityGateRow(registry, "verifier", coreRows),
    "verifier",
    goalText,
  );

  const insertionIndex = (() => {
    for (let idx = coreRows.length - 1; idx >= 0; idx -= 1) {
      const row = coreRows[idx]!;
      if (row.officeRole !== "pm" && LooksLikeImplementationWork(row.command)) {
        return idx + 1;
      }
    }
    return coreRows.length;
  })();

  const orderedRows = [...coreRows];
  const qualityRows = [reviewerRow, verifierRow].filter(
    (row): row is DispatchRow => row != null,
  );
  orderedRows.splice(insertionIndex, 0, ...qualityRows);
  return orderedRows.map((row, idx) => ({ ...row, stepNumber: idx + 1 }));
}

function BuildPmPlanFallbackRows(
  registry: AgentRegistry,
  assignmentContext: string,
): DispatchRow[] {
  const implementationTargets = InferQualityReworkTargets(registry, assignmentContext, []);
  const pmAgentId = registry.FindAgentIdByOfficeRole("pm") ?? "pm";
  const intent = ClassifyRequestIntent(assignmentContext);
  const preferredFreshWebTarget =
    registry.FindAgentIdByOfficeRole("frontend") ??
    registry.FindAgentIdByOfficeRole("developer") ??
    registry.FindAgentIdByOfficeRole("backend") ??
    pmAgentId;
  const targetAgentId =
    intent.isFreshCreate && intent.isClientSideWebArtifact && !intent.allowsPythonBackend
      ? preferredFreshWebTarget
      : (implementationTargets[0] ??
        registry.FindAgentIdByOfficeRole("developer") ??
        registry.FindAgentIdByOfficeRole("backend") ??
        registry.FindAgentIdByOfficeRole("frontend") ??
        pmAgentId);
  if (targetAgentId == null || targetAgentId.trim() === "") return [];
  if (intent.isFreshCreate && intent.isClientSideWebArtifact && !intent.allowsPythonBackend) {
    const slices = [
      {
        title: "Create the fresh client-side web scaffold/foundation",
        scope:
          "Own only the runnable foundation: package.json, tsconfig.json, vite.config, index.html, src/main, src/App, base styles, and the minimal data/type files needed for later slices. Do not inspect or repair unrelated dirty files. Do not create Python/backend/service files.",
      },
      {
        title: "Implement the domain data, rules, and scoring engine",
        scope:
          "Own only artifact-local data/type/rule/scoring files. Encode the user's constraints, ranking reasons, exclusions, and recommendation math without touching UI layout or persistence.",
      },
      {
        title: "Wire input state, search/filter, and immediate recompute",
        scope:
          "Own only input state, search/filter behavior, validation, and derived recomputation wiring. Keep persistence and visual polish out of this slice unless required to compile.",
      },
      {
        title: "Add local persistence and modification-safe user state",
        scope:
          "Own only localStorage/favorites/saved preferences plus safe load/save/error handling. Do not rebuild the scaffold or rewrite the scoring engine.",
      },
      {
        title: "Finish results UI, empty/error states, premium polish, and smoke/build support",
        scope:
          "Own only final user-facing result cards, reasons, empty/error/mobile states, premium visual polish, accessibility basics, and artifact-local smoke/build scripts needed by reviewer/verifier.",
      },
    ];
    const rows = slices.map((slice, idx): DispatchRow => ({
      agentId: targetAgentId,
      command:
        `${slice.title} for this assignment: ${assignmentContext}\n\n` +
        `${slice.scope}\n\n` +
        "Report the exact files created or changed in [FilesCreated]. Keep this slice bounded; do not broaden into Python/backend/service files.",
      stepNumber: idx + 1,
      cliRole: registry.MapTauriCliRoleKeyToCliRole(targetAgentId),
      officeRole: registry.MapAgentIdToOfficeRole(targetAgentId),
    }));
    return EnsureQualityGateSteps(rows, registry, assignmentContext);
  }
  const triageRow: DispatchRow = {
    agentId: pmAgentId,
    command:
      `Audit the current dirty diff and identify the narrowest hotspot for this assignment before any repair handoff: ${assignmentContext}\n\n` +
      "Use changed-file evidence first, name the concrete file/module at risk, and state whether legacy compatibility must be preserved. Do not hand off a generic implementation assignment when a specific hotspot can be named.",
    stepNumber: 1,
    cliRole: registry.MapTauriCliRoleKeyToCliRole(pmAgentId),
    officeRole: registry.MapAgentIdToOfficeRole(pmAgentId),
  };
  const implementationRow: DispatchRow = {
    agentId: targetAgentId,
    command:
      `Implement the assignment with tight scope control: ${assignmentContext}\n\n` +
      "Use the PM triage findings from the prior step to target the specific hotspot, preserve existing behavior outside that scope, and keep legacy compatibility unless the triage step explicitly narrowed removal as safe.",
    stepNumber: 2,
    cliRole: registry.MapTauriCliRoleKeyToCliRole(targetAgentId),
    officeRole: registry.MapAgentIdToOfficeRole(targetAgentId),
  };
  return EnsureQualityGateSteps([triageRow, implementationRow], registry, assignmentContext);
}

const CASCADE_PLAN_PHASE_DELEGATION_SUFFIX =
  "Follow Phase 1 in the Prompting Sequencer Protocol: output [SEQUENCER_PLAN] with numbered lines only inside that block. Each line must be YOUR own work breakdown for the assignment below, not other agents' assignments as separate plan steps. Prefer 3-4 substantial steps; only use 5 when a real quality gate would otherwise be lost. Merge adjacent PM-only reasoning steps when they depend on the same evidence, especially risk triage plus execution-priority judgment. Request skills only if you are genuinely blocked on domain-specific knowledge that is missing from the current prompt; do not request generic planning/process skills for routine decomposition. If you need full skill bodies to plan or execute this goal safely, append exactly one [SKILL_REQUEST]skillA,skillB[/SKILL_REQUEST] immediately after [/SEQUENCER_PLAN] and nothing else (no prose). Delegate other roster agents only via [AGENT_COMMANDS] after the final Phase 2 step when your steps are done. Do not output [AGENT_COMMANDS] in this planning call.";

function BuildCascadePlanPhaseDelegationSuffix(InOfficeRole: AgentRole): string {
  if (InOfficeRole === "pm") {
    return `${CASCADE_PLAN_PHASE_DELEGATION_SUFFIX} For PM-owned planning, prefer 2 steps total: one compact scope/requirements brief, then one final role handoff. Do not split requirements, rules, UI flow, and handoff into separate PM-only steps unless each step requires different evidence.`;
  }
  if (InOfficeRole === "reviewer" || InOfficeRole === "verifier") {
    return `${CASCADE_PLAN_PHASE_DELEGATION_SUFFIX} For quality-gate work, prefer exactly 1 step. Use 2 steps only if host command evidence and human review cannot fit in one step. Never create 3 or more reviewer/verifier steps.`;
  }
  return CASCADE_PLAN_PHASE_DELEGATION_SUFFIX;
}

const PM_PLAN_RETRY_SUFFIX =
  "Your last planning reply did not include a usable complete [SEQUENCER_PLAN], or it started PM_SUMMARY/FRONTEND_TASKS and was cut off before closing. Do not repeat long task sections during planning. Do not output WAITING_FOR_STEP_SIGNAL or any placeholder. Emit only a compact concrete [SEQUENCER_PLAN] with numbered steps now. If implementation is needed, prefer two PM-owned steps: 1) compact scope brief, 2) final compact role handoff. Put detailed FRONTEND_TASKS/REVIEWER_TASKS/VERIFIER_TASKS only in the final execution step, not in this planning retry.";
const PM_PLAN_FAILURE_RETRY_SUFFIX =
  "The previous planning attempt failed before producing a usable plan. Ignore provider/internal error logs as plan content. Retry once and emit only a valid [SEQUENCER_PLAN] with numbered steps. If you still cannot plan, leave stdout empty rather than inventing fallback work from error text.";

const DIRECT_COMMAND_EXECUTION_SUFFIX =
  "Execute the assigned command in your reply with concrete work product. Prefer substantive progress over status narration. When changing code, name the files changed and summarize what was improved. When verifying, report the result briefly and concretely. You MAY inspect workspace files with read-only CLI/tool usage when needed to understand the codebase (for example: rg, ls, sed, cat, git diff). Do NOT treat read-only inspection as forbidden shell execution. If the host must run a real command outside your own read-only inspection or if a mutating/build/test command is required, emit [Command] for the host instead of assuming you are blocked. Do not reply with only [SEQUENCER_PLAN]. When another roster agent should act next, emit exactly one [AGENT_COMMANDS] block after your main output. Use a JSON array of objects {\"AgentName\":\"<roster_id>\",\"Commands\":\"<standalone brief>\",\"CommandSender\":\"<current_agent_id>\",\"DependsOn\":[\"<roster_id>\"]}. DependsOn names earlier queued agent slices only; the coordinator maps each agent id to the latest previously queued command for that agent, not future slices. Use only agent ids from the roster.";

function BuildDirectCommandExecutionSuffix(InOfficeRole: AgentRole): string {
  const compact =
    " Keep the final answer compact: at most 8 bullets plus required tags. Do not paste full diffs, full logs, or long reasoning transcripts.";
  const implementationBudget = [
    "Implementation-specific: start from assigned scope, dirty diff, and prior evidence.",
    "Default budget is at most 2 read-only commands and at most 3 file reads.",
    "If the dirty diff already satisfies the assignment, do not edit; confirm it and request only the needed host verification.",
    "Do not run broad repo exploration, full-file dumps, or apply_patch unless you found one exact missing change.",
    "Do not request standalone preview/build/test host commands merely to prove quality or open a localhost page at the end of an implementation slice; leave routine smoke/build/preview evidence to verifier unless the command is required to unblock implementation or produce the artifact itself.",
    "Do not use [Command] to write or overwrite source files, scaffold multi-file apps, or run large inline Python/Node/heredoc scripts that author files; make source changes in your main reply and reserve [Command] for install/build/test/runtime commands or tiny unblockers only.",
    "If you create or change files, include one [FilesCreated]...[/FilesCreated] block with one workspace-relative path per line.",
  ].join(" ");
  if (InOfficeRole === "reviewer") {
    const reviewerRules = [
      "Reviewer-specific: use provided diff, host-command evidence, created-file evidence, and prior-step summaries before opening files.",
      "A fresh temp workspace or non-git workspace is still valid review input; if git status/diff is unavailable, do not fail the review for that reason alone and inspect the created files or prior-step evidence instead.",
      "Review only the assigned deliverable and its directly related files.",
      "Always check user-visible requirement coverage against the original assignment; if a requirement is missing, unsupported, or replaced by a generic placeholder, [ReviewVerdict] must be needs_rework.",
      "For frontend/web deliverables, include concrete UI/UX evidence categories in [ReviewFindings] when approving or in [OpenRisks] when missing: input/search/filter, empty/loading state, mobile/responsive, error/validation, correction/recovery path, button interaction, scanability, visual layout, viewport overflow/action visibility.",
      "Tables, cards, grids, and action buttons must not be approved from source-string-only smoke; if desktop and narrow/mobile viewport fit or primary interactive controls visible/reachable are unproven, keep that in [OpenRisks].",
      "For premium/reference-informed deliverables, also check whether one coherent reference_archetype was chosen, source_level is honest, the reference_quality_bar is visible in the UI, no horizontal viewport overflow or clipped primary actions are proven, and reference patterns were adapted to the user's task instead of copied as brand assets, screenshots, trademarked layouts, or decorative award-site styling.",
      "Before approving, derive a small domain-neutral rule map from the user's words: entities/states, unavailable or already-used items, mutually exclusive choices, negative conditions, and conditional explanation claims.",
      "For recommendation, ranking, booking, scheduling, filtering, or selection flows, [ReviewVerdict] must be needs_rework if the deliverable can recommend/select/reserve/justify something the current input makes unavailable, already used, conflicting, or false.",
      "Do not hard-code one domain; apply the same rule extraction to any natural-language request.",
      "Treat transient/generated sample artifacts as evidence only unless the user explicitly asks to keep them in the project.",
      "Do not fail the review just because the repo has unrelated dirty files; unrelated pre-existing or parallel system changes are context only unless you can tie them to a concrete behavior, regression, or requirement risk in the assigned deliverable.",
      "Do not label unrelated dirty files as a scope-isolation violation unless the prompt or evidence proves the current assignment changed those files.",
      "When the repo already has broad dirty diff and the assignment is narrow, assume out-of-scope dirty files are pre-existing or parallel work unless direct evidence says otherwise.",
      "If you must inspect locally, ask one narrow question first, then inspect at most one read-only command or two short file excerpts; never dump full files, full diffs, full logs, or long command output.",
      "Do not emit [SEQUENCER_PLAN].",
      "During normal quality gates, report rework inside [ReviewFindings] and [OpenRisks] instead of emitting [AGENT_COMMANDS]; the coordinator will route any needed repair.",
      "If the only blocker is missing review evidence such as unavailable git diff, missing non-git context, or missing host-run proof, keep findings evidence-focused and let verifier close that gap instead of asking implementation to rewrite working code.",
      "Include [ReviewVerdict], [ReviewFindings], and [OpenRisks] inside the required step-result envelope; do not put role tags outside that envelope.",
      "If a separate verifier gate is already assigned, do not list 'I did not run tests/build' as an OpenRisk; leave that to verifier unless it reveals a concrete review blocker.",
      "If [OpenRisks] is non-empty, [ReviewVerdict] must be needs_rework; for ready, omit [OpenRisks] or leave it empty.",
    ].join(" ");
    return `${DIRECT_COMMAND_EXECUTION_SUFFIX}${compact} ${reviewerRules}`;
  }
  if (InOfficeRole === "verifier") {
    const verifierRules = [
      "Verifier-specific: prove user-visible requirement coverage against the original assignment.",
      "Derive domain-neutral invariants from the request and include a happy path plus a negative/adversarial path when the deliverable depends on user input.",
      "For frontend or web artifacts, include a user-perspective flow, local preview, or smoke check when possible; build/lint alone is not enough for user-facing artifact quality.",
      "For frontend/web deliverables, [Verification] must name the concrete UI/UX evidence categories proven by source/smoke/preview/browser/host evidence; if a requested category is missing, keep it in [OpenRisks].",
      "For tables, cards, grids, or action buttons, source-string-only smoke is insufficient for layout quality: prove no horizontal viewport overflow/clipping at desktop and narrow/mobile viewport, and prove primary interactive controls/action buttons are visible/reachable.",
      "For premium/reference-informed deliverables, source names or inspiration claims are not enough; verify visible adaptation evidence such as one coherent reference_archetype, honest source_level, reference_quality_bar coverage, hierarchy, state behavior, interaction feedback, responsive layout, no horizontal viewport overflow or clipped primary actions, accessibility basics, and visual rhythm.",
      "For recommendation, ranking, booking, scheduling, filtering, or selection flows, [VerificationStatus] must not be pass unless executable evidence proves unavailable/already-used/conflicting items stay excluded and conditional explanations are true for the current input.",
      "For DAACS work, do not request Python runtime or legacy service-folder commands; use Rust/Tauri/client-side checks, with Auth covered by the Rust auth server.",
      "Do not run install/build/test/smoke commands yourself inside the model CLI; emit [Command] for the host to run them, then evaluate the returned host evidence.",
      "If build/test fails because node_modules or a package module such as react/vite/typescript is missing and no install command has run yet, request one install command once, then rerun the existing build/smoke command before calling it an implementation defect.",
      "When requesting host commands, use existing scripts, package commands, or existing test files only; do not invent throwaway verification script filenames.",
      "Do not request standalone generic preview servers such as `python -m http.server`, raw `vite`, or `serve`; if preview evidence is needed, prefer an existing project dev/start command wrapped together with the check, or fall back to dependency-free verification that does not start a standalone server.",
      "For Python artifacts outside legacy DAACS service folders without pytest, prefer dependency-free stdlib checks such as `python3 -m unittest discover -s tests` or a concrete existing `tests/test_*.py` file.",
      "Do not emit [SEQUENCER_PLAN].",
      "During normal quality gates, report failed checks inside [Verification] and [OpenRisks] instead of emitting [AGENT_COMMANDS]; the coordinator will route any needed repair.",
      "Use [OpenRisks] only for required unmet checks; put non-blocking scope notes inside [Verification].",
      "Include [VerificationStatus], [Verification], and [OpenRisks] inside the required step-result envelope; use at most 3 host commands if needed.",
    ].join(" ");
    return `${DIRECT_COMMAND_EXECUTION_SUFFIX}${compact} ${verifierRules}`;
  }
  if (
    InOfficeRole === "developer" ||
    InOfficeRole === "frontend" ||
    InOfficeRole === "backend" ||
    InOfficeRole === "designer" ||
    InOfficeRole === "devops"
  ) {
    return `${DIRECT_COMMAND_EXECUTION_SUFFIX}${compact} ${implementationBudget}`;
  }
  return `${DIRECT_COMMAND_EXECUTION_SUFFIX}${compact}`;
}

function BuildCascadeStepSuffix(
  InStepNumber: number,
  InFinalStepNumber: number,
  InOfficeRole?: AgentRole | null,
): string {
  const pmCompactSuffix =
    InOfficeRole === "pm"
      ? " PM-specific limit: write a compact decision memo. Use the full PM_SUMMARY / ROLE_ASSIGNMENT / task-section format only in the final PM handoff or when [AGENT_COMMANDS] is required. Keep each section to the minimum useful lines; avoid long paragraphs."
      : "";
  const filesCreatedSuffix =
    InOfficeRole === "frontend" ||
    InOfficeRole === "backend" ||
    InOfficeRole === "developer" ||
    InOfficeRole === "designer" ||
    InOfficeRole === "devops"
      ? " If you create or change files, include one [FilesCreated]...[/FilesCreated] block with one workspace-relative path per line."
      : "";
  if (InStepNumber !== InFinalStepNumber) {
    return `Execute this step's assigned work in your response with concrete, reviewable output. Prefer compact execution-ready results over long narrative analysis: short sections, bullets, file paths, diffs, or verification facts.${pmCompactSuffix}${filesCreatedSuffix} If you are PM, do not emit PM_SUMMARY, ROLE_ASSIGNMENT_NOTES, FRONTEND_TASKS, BACKEND_TASKS, REVIEWER_TASKS, or VERIFIER_TASKS in this intermediate step; write at most 5 compact bullets and stop. Reuse the Active Sequencer Plan and Prior steps as working memory, but avoid restating prior context unless it changes the decision for this step. Execute ONLY the current step. You MAY inspect workspace files with read-only CLI/tool usage when needed to do this step correctly (for example: rg, ls, sed, cat, git diff). Read-only inspection is allowed and expected when the prompt references local files; do not claim you are blocked solely because file contents were not pasted into the prompt. Do NOT perform mutating/build/test shell execution yourself; if such host execution is required, include [Command]...[/Command] before {END_TASK_${InStepNumber}} per the Prompting Sequencer protocol. For implementation-owned intermediate steps, do not spend host commands on standalone preview servers or routine smoke/build proof just to demonstrate quality; leave that evidence to verifier unless the command is needed to unblock implementation. Do not reply with only [SEQUENCER_PLAN] unless the user explicitly asked for a plan update. This is an intermediate plan step: after {END_TASK_${InStepNumber}} you MUST NOT output [AGENT_COMMANDS] and MUST NOT append anything after {END_TASK_${InStepNumber}}.`;
  }
  return `Execute this step's assigned work in your response with a high-quality but compact final artifact. Prefer explicit file references, concise verification evidence, and a short execution-ready handoff over generic wrap-up text or repeated retrospectives.${pmCompactSuffix}${filesCreatedSuffix} You MAY inspect workspace files with read-only CLI/tool usage when needed (for example: rg, ls, sed, cat, git diff). Read-only inspection is allowed and expected; do not claim you are blocked solely because file contents were not pasted into the prompt. Do NOT perform mutating/build/test shell execution yourself; if such host execution is required, emit [Command] before {END_TASK_${InFinalStepNumber}}. Do not reply with only [SEQUENCER_PLAN] unless the user explicitly asked for a plan update. This is the FINAL plan step (K=${InFinalStepNumber}): after {END_TASK_${InFinalStepNumber}}, if any roster agent still needs Commands or Tasks, you MUST output exactly one [AGENT_COMMANDS]...[/AGENT_COMMANDS] block and you MUST NOT replace it with prose instructions. If your final artifact names a downstream owner, reviewer, verifier, implementer, follow-up action, unresolved blocker, not-ready state, conditional handoff, inconsistency, regression, or required rework, that counts as delegation and requires [AGENT_COMMANDS]. When the result is not ready or further work is needed, the block MUST include at least one non-quality implementation owner plus any required reviewer/verifier follow-up. Body = valid JSON array of objects {"AgentName":"<roster_id>","Commands":"<standalone brief>","CommandSender":"<current_agent_id>","DependsOn":["<roster_id>"]}, covering every such agent; DependsOn names earlier queued agent slices only, and the coordinator resolves each agent id to the latest previously queued command for that agent, not future slices; use only ids from the roster. If the current agent is PM, each Commands value must be a compact execution card, not a full requirements document. Synthesize from the full session (plan plus all prior step outcomes), not only this step. If no delegation is needed, stop after {END_TASK_${InFinalStepNumber}} and omit the block.`;
}

type CascadeWorkflowCommand = {
  agentId: string;
  command: string;
  senderId: string | null;
  dependsOn: string[];
  originAssignmentContext?: string | null;
};

function BuildPreferredPmWorkflowCommands(
  registry: AgentRegistry,
  assignmentContext: string,
  outputText: string,
  defaultSenderId?: string | null,
  originAssignmentContext?: string | null,
): CascadeWorkflowCommand[] {
  const modelOutputText = StripCliTranscriptFromOutput(outputText);
  const resolvedOriginAssignmentContext = ResolveOriginAssignmentContext(
    originAssignmentContext,
    assignmentContext,
  );
  const parsed = SequencerParser.ParseWorkflowCommands(modelOutputText, registry, defaultSenderId).map((command) => ({
    ...command,
    originAssignmentContext: resolvedOriginAssignmentContext,
  }));
  const taskSectionFallback = BuildPmTaskSectionDelegationCommands(
    registry,
    assignmentContext,
    modelOutputText,
  );
  const preferred = PreferPmDelegationCommands(
    parsed,
    taskSectionFallback,
    registry,
    assignmentContext,
  );
  return preferred.map((command) => ({
    ...command,
    originAssignmentContext: ResolveOriginAssignmentContext(
      command.originAssignmentContext,
      resolvedOriginAssignmentContext,
    ),
  }));
}

function CollectCascadeAgentCommands(
  seqRuns: SequencerStepRunRecord[],
  registry: AgentRegistry,
  assignmentContext: string,
): CascadeWorkflowCommand[] {
  const out: CascadeWorkflowCommand[] = [];
  for (const { row, stepResult } of seqRuns) {
    if (stepResult == null || (stepResult.exit_code ?? -1) !== 0) continue;
    const outputText = CombineCascadeCliOutput(stepResult);
    const effective: CascadeWorkflowCommand[] =
      row.officeRole === "pm"
        ? BuildPreferredPmWorkflowCommands(
            registry,
            assignmentContext,
            outputText,
            row.agentId,
            assignmentContext,
          )
        : SequencerParser.ParseWorkflowCommands(outputText, registry, row.agentId).map((command) => ({
            ...command,
            originAssignmentContext: null,
          }));
    if (effective.length > 0) {
      out.push(
        ...effective.map((command) => ({
          ...command,
          originAssignmentContext: ResolveOriginAssignmentContext(
            command.originAssignmentContext,
            assignmentContext,
          ),
        })),
      );
    }
  }
  return out;
}

function ExtractPmTaskSectionItems(text: string, sectionName: string): string[] {
  const header = `${sectionName.trim().toUpperCase()}:`;
  const out: string[] = [];
  let inSection = false;
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (/^[A-Z_]+:$/.test(line)) {
      inSection = line.toUpperCase() === header;
      continue;
    }
    if (!inSection) continue;
    if (line === "" || line === "(none)" || line === "- (none)") continue;
    if (/^\[\/?[A-Za-z0-9_]+\]/.test(line) || /^\{END_TASK_\d+\}/.test(line)) break;
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bullet?.[1] == null) continue;
    const item = bullet[1].trim();
    if (item === "" || item === "(none)") continue;
    out.push(item);
  }
  return out;
}

function LooksLikeIncompletePmTaskSectionDelegation(text: string): boolean {
  const value = StripCliTranscriptFromOutput(String(text ?? ""));
  if (value.trim() === "") return false;
  if (!/\b(?:PM_SUMMARY|FRONTEND_TASKS|BACKEND_TASKS|REVIEWER_TASKS|VERIFIER_TASKS):/i.test(value)) {
    return false;
  }
  if (/\[\/(?:SEQUENCER_PLAN|STEP_\d+_RESULT|AGENT_COMMANDS)\]/i.test(value)) return false;
  if (/\{END_TASK_\d+\}/i.test(value)) return false;
  return /\[(?:SEQUENCER_PLAN|STEP_\d+_RESULT)\]/i.test(value);
}

function IsIncompletePmTaskSectionRetryAssignment(text: string): boolean {
  return /\[IncompletePmTaskSectionRetry\]/i.test(String(text ?? ""));
}

function BuildIncompletePmTaskSectionRetryCommands(
  registry: AgentRegistry,
  originalAssignment: string,
  truncatedOutput: string,
  originAssignmentContext?: string | null,
): CascadeWorkflowCommand[] {
  const pmId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "pm";
  const assignment = StripSequencerSignals(originAssignmentContext ?? originalAssignment);
  const outputExcerpt = CompactLargeModelOutputForMemory(truncatedOutput, 1800);
  return [
    {
      agentId: pmId,
      senderId: pmId,
      dependsOn: [],
      originAssignmentContext: ResolveOriginAssignmentContext(originAssignmentContext, originalAssignment),
      command: [
        "[IncompletePmTaskSectionRetry]",
        "Your previous PM handoff was cut off while writing PM_SUMMARY/FRONTEND_TASKS, so the coordinator did not execute those partial cards.",
        "Do not implement files. Re-emit only a complete compact final PM handoff.",
        "Use [STEP_1_RESULT]...[/STEP_1_RESULT] and close with {END_TASK_1}.",
        "Inside the step result, include PM_SUMMARY, FRONTEND_TASKS, BACKEND_TASKS, REVIEWER_TASKS, and VERIFIER_TASKS, or include a complete [AGENT_COMMANDS] JSON block.",
        "Keep each task one line. Use 3-5 bounded implementation slices for complex frontend artifacts. Close every tag.",
        "",
        "Original assignment:",
        assignment,
        "",
        "Previous cut-off output excerpt:",
        outputExcerpt,
        "",
        "Prompting_Sequencer_1",
      ].join("\n"),
    },
  ];
}

function CountCommandsForOfficeRole(
  registry: AgentRegistry,
  commands: CascadeWorkflowCommand[],
  officeRole: AgentRole,
): number {
  return commands.filter((command) => registry.MapAgentIdToOfficeRole(command.agentId) === officeRole).length;
}

function IsIgnorableDirtyWorkspacePath(path: string): boolean {
  const value = String(path ?? "").trim();
  if (value === "") return true;
  return (
    value.startsWith(".daacs_timeout_marker_") ||
    value.includes("/.daacs_timeout_marker_") ||
    value.includes("\\.daacs_timeout_marker_")
  );
}

function LooksLikeExplicitBackendRequirement(text: string): boolean {
  const normalized = (text ?? "")
    .toLowerCase()
    .replace(/no-login|without login|login-free|로그인 없는|로그인 불필요|로그인 필요 없다|로그인 없이/g, " ");
  if (normalized.trim() === "") return false;
  return [
    "/api/",
    "\\api\\",
    "admin",
    "auth",
    "backend",
    "credential",
    "database",
    "db",
    "endpoint",
    "external integration",
    "integration",
    "multi-user",
    "oauth",
    "payment",
    "secret",
    "server",
    "shared persistence",
    "signup",
    "sign-up",
    "sql",
    "sync",
    "user account",
    "webhook",
    "write api",
    "관리자",
    "백엔드",
    "서버",
    "외부 연동",
    "외부 통합",
    "인증",
    "자격증명",
    "회원가입",
    "결제",
    "공유 저장",
    "공유 상태",
    "공유 데이터",
    "데이터베이스",
    "디비",
    "멀티유저",
    "멀티 유저",
    "비밀키",
    "시크릿",
    "웹훅",
    "쓰기 api",
  ].some((needle) => normalized.includes(needle));
}

function ShouldPreferFrontendOnlyPmArtifact(assignmentContext: string): boolean {
  const text = (assignmentContext ?? "").toLowerCase();
  if (text === "") return false;
  const looksUserFacingWeb =
    LooksLikeFrontendWork(text) ||
    /\b(?:website|web\s*app|webapp|single-page|single\s+page|browser\s+app|dashboard)\b/i.test(text) ||
    /(웹사이트|웹앱|브라우저|페이지|화면)/.test(text);
  if (!looksUserFacingWeb) return false;
  if (LooksLikeExplicitBackendRequirement(text)) return false;
  return [
    "no-login",
    "without login",
    "login-free",
    "localstorage",
    "local storage",
    "reference data",
    "static data",
    "static dataset",
    "로그인 없는",
    "로그인 불필요",
    "로그인 필요 없다",
    "로그인 없이",
    "즐겨찾기",
    "로컬 저장",
    "정적 데이터",
    "참조 데이터",
  ].some((needle) => text.includes(needle));
}

function RehomeBackendTaskToFrontendSupport(task: string): string {
  const trimmed = String(task ?? "").trim();
  if (trimmed === "") return trimmed;
  const withoutPrefix = trimmed.replace(/^backend slice(?:\s*\d+)?\s*:\s*/i, "");
  const rewritten = withoutPrefix
    .replace(/existing service\/api pattern/gi, "existing frontend support pattern")
    .replace(/service\/api pattern/gi, "frontend support pattern")
    .replace(/api pattern/gi, "frontend support pattern")
    .replace(/server-side/gi, "frontend support layer")
    .replace(/server side/gi, "frontend support layer")
    .replace(/서버쪽/g, "프론트 지원층")
    .replace(/서버 쪽/g, "프론트 지원층")
    .replace(/백엔드/g, "프론트 지원층")
    .replace(/\bbackend\b/gi, "frontend support")
    .trim();
  return `Frontend support/data slice: ${rewritten}`;
}

function CountBackendishImplementationCommands(
  commands: CascadeWorkflowCommand[],
  registry: AgentRegistry,
): number {
  return commands.filter((command) => {
    if (!IsImplementationAgentId(registry, command.agentId)) return false;
    return LooksLikeBackendImplementationContext(command.command);
  }).length;
}

function PreferPmDelegationCommands(
  parsed: CascadeWorkflowCommand[],
  taskSectionFallback: CascadeWorkflowCommand[],
  registry: AgentRegistry,
  assignmentContext: string,
): CascadeWorkflowCommand[] {
  if (taskSectionFallback.length === 0) return parsed;
  if (parsed.length === 0) return taskSectionFallback;
  const parsedImplementationCount = parsed.filter((command) => IsImplementationAgentId(registry, command.agentId)).length;
  const fallbackImplementationCount =
    taskSectionFallback.filter((command) => IsImplementationAgentId(registry, command.agentId)).length;
  if (fallbackImplementationCount > parsedImplementationCount) {
    return taskSectionFallback;
  }
  if (
    CountCommandsForOfficeRole(registry, taskSectionFallback, "reviewer") >
      CountCommandsForOfficeRole(registry, parsed, "reviewer") ||
    CountCommandsForOfficeRole(registry, taskSectionFallback, "verifier") >
      CountCommandsForOfficeRole(registry, parsed, "verifier")
  ) {
    return taskSectionFallback;
  }
  if (ShouldPreferFrontendOnlyPmArtifact(assignmentContext)) {
    const parsedBackendRoleCount = CountCommandsForOfficeRole(registry, parsed, "backend");
    const fallbackBackendRoleCount = CountCommandsForOfficeRole(registry, taskSectionFallback, "backend");
    const parsedBackendishCount = CountBackendishImplementationCommands(parsed, registry);
    const fallbackBackendishCount = CountBackendishImplementationCommands(taskSectionFallback, registry);
    if (
      fallbackBackendRoleCount < parsedBackendRoleCount ||
      fallbackBackendishCount < parsedBackendishCount
    ) {
      return taskSectionFallback;
    }
  }
  return parsed;
}

function BuildPmTaskSectionDelegationCommands(
  registry: AgentRegistry,
  assignmentContext: string,
  finalOutputText: string,
): CascadeWorkflowCommand[] {
  if (LooksLikeIncompletePmTaskSectionDelegation(finalOutputText)) {
    return [];
  }
  const frontendTasks = ExtractPmTaskSectionItems(finalOutputText, "FRONTEND_TASKS");
  const backendTasks = ExtractPmTaskSectionItems(finalOutputText, "BACKEND_TASKS");
  const reviewerTasks = ExtractPmTaskSectionItems(finalOutputText, "REVIEWER_TASKS");
  const verifierTasks = ExtractPmTaskSectionItems(finalOutputText, "VERIFIER_TASKS");
  if (
    frontendTasks.length === 0 &&
    backendTasks.length === 0 &&
    reviewerTasks.length === 0 &&
    verifierTasks.length === 0
  ) {
    return [];
  }

  const pmId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "pm";
  const primaryAssignmentContext =
    ExtractPrimaryImplementationContext(assignmentContext) ||
    StripSequencerSignals(assignmentContext) ||
    SummarizeForTaskComplete(finalOutputText, 500);
  const qualityGoalContext = primaryAssignmentContext;
  let effectiveFrontendTasks = [...frontendTasks];
  let effectiveBackendTasks = [...backendTasks];
  if (ShouldPreferFrontendOnlyPmArtifact(primaryAssignmentContext) && effectiveBackendTasks.length > 0) {
    effectiveFrontendTasks = [
      ...effectiveBackendTasks.map((task) => RehomeBackendTaskToFrontendSupport(task)),
      ...effectiveFrontendTasks,
    ];
    effectiveBackendTasks = [];
  }
  const richOriginAssignmentContext = [
    primaryAssignmentContext,
    "",
    "PM final handoff summary:",
    effectiveFrontendTasks.length > 0 ? `FRONTEND_TASKS:\n${effectiveFrontendTasks.map((task) => `- ${task}`).join("\n")}` : "",
    effectiveBackendTasks.length > 0 ? `BACKEND_TASKS:\n${effectiveBackendTasks.map((task) => `- ${task}`).join("\n")}` : "",
    reviewerTasks.length > 0 ? `REVIEWER_TASKS:\n${reviewerTasks.map((task) => `- ${task}`).join("\n")}` : "",
    verifierTasks.length > 0 ? `VERIFIER_TASKS:\n${verifierTasks.map((task) => `- ${task}`).join("\n")}` : "",
  ].filter((line) => line !== "").join("\n");
  const commands: CascadeWorkflowCommand[] = [];
  const implementationDependencies = new Set<string>();
  const missingImplementationTasks: string[] = [];

  const appendImplementationTasks = (tasks: string[], officeRole: ImplementationOfficeRole): void => {
    if (tasks.length === 0) return;
    const agentId = ResolvePreferredImplementationAgentId(registry, officeRole);
    if (agentId == null) {
      missingImplementationTasks.push(...tasks.map((task) => `${officeRole}: ${task}`));
      return;
    }
    implementationDependencies.add(agentId);
    let dependsOn: string[] = [];
    for (const task of tasks) {
      commands.push({
        agentId,
        senderId: pmId,
        dependsOn,
        originAssignmentContext: richOriginAssignmentContext,
        command: AppendImplementationRequirementGuidanceToCommand(
          `Complete this PM-assigned ${officeRole} slice for the assignment: ${primaryAssignmentContext}\n\nAssigned slice:\n${task}`,
          qualityGoalContext,
        ),
      });
      dependsOn = [agentId];
    }
  };

  appendImplementationTasks(effectiveFrontendTasks, "frontend");
  appendImplementationTasks(effectiveBackendTasks, "backend");

  if (missingImplementationTasks.length > 0) {
    commands.push({
      agentId: pmId,
      senderId: pmId,
      dependsOn: [...implementationDependencies],
      originAssignmentContext: richOriginAssignmentContext,
      command: [
        "Implementation is blocked because this roster has no user-created implementation agent for the PM-assigned slices below.",
        "Do not send reviewer/verifier quality gates for unimplemented work.",
        "Respond with a concise blocker report and ask the user to create or select an implementation agent in the roster, or revise the handoff to use an existing roster agent id.",
        "",
        "Blocked implementation slices:",
        ...missingImplementationTasks.map((task) => `- ${task}`),
      ].join("\n"),
    });
    return commands;
  }

  const reviewerId = registry.FindAgentIdByOfficeRole("reviewer")?.trim().toLowerCase() ?? "";
  if (reviewerId !== "" && reviewerTasks.length > 0) {
    let dependsOn = implementationDependencies.size > 0 ? [...implementationDependencies] : [];
    for (const task of reviewerTasks) {
      commands.push({
        agentId: reviewerId,
        senderId: pmId,
        dependsOn,
        originAssignmentContext: richOriginAssignmentContext,
        command: AppendQualityRequirementGuidanceToCommand(
          `Execute this PM-assigned review gate for the assignment: ${primaryAssignmentContext}\n\nAssigned review task:\n${task}`,
          "reviewer",
          qualityGoalContext,
        ),
      });
      dependsOn = [reviewerId];
    }
  }

  const verifierId = registry.FindAgentIdByOfficeRole("verifier")?.trim().toLowerCase() ?? "";
  if (verifierId !== "" && verifierTasks.length > 0) {
    let dependsOn =
      reviewerId !== "" && reviewerTasks.length > 0
        ? [reviewerId]
        : implementationDependencies.size > 0
          ? [...implementationDependencies]
          : [];
    for (const task of verifierTasks) {
      commands.push({
        agentId: verifierId,
        senderId: pmId,
        dependsOn,
        originAssignmentContext: richOriginAssignmentContext,
        command: AppendQualityRequirementGuidanceToCommand(
          `Execute this PM-assigned verification gate for the assignment: ${primaryAssignmentContext}\n\nAssigned verification task:\n${task}`,
          "verifier",
          qualityGoalContext,
        ),
      });
      dependsOn = [verifierId];
    }
  }

  return commands;
}

function IsImplementationAgentId(registry: AgentRegistry, agentId: string): boolean {
  const normalizedAgentId = String(agentId ?? "").trim().toLowerCase();
  if (normalizedAgentId === "") return false;
  const officeRole = registry.MapAgentIdToOfficeRole(normalizedAgentId);
  return officeRole !== "pm" && officeRole !== "reviewer" && officeRole !== "verifier";
}

function IsImplementationOfficeRole(officeRole: AgentRole): boolean {
  return officeRole !== "pm" && officeRole !== "reviewer" && officeRole !== "verifier";
}

function HasRepairExecutionPath(
  commands: Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }>,
  registry: AgentRegistry,
): boolean {
  return commands.some((command) => IsImplementationAgentId(registry, command.agentId));
}

function ShouldSkipImplementationSenderFollowup(
  registry: AgentRegistry,
  senderId: string | null | undefined,
  completedAgentId: string,
): boolean {
  const sender = String(senderId ?? "").trim().toLowerCase();
  const completed = String(completedAgentId ?? "").trim().toLowerCase();
  if (sender === "" || completed === "") return false;
  if (!IsImplementationAgentId(registry, sender)) return false;
  if (IsImplementationAgentId(registry, completed)) return true;
  const completedRole = registry.MapAgentIdToOfficeRole(completed);
  return completedRole === "reviewer" || completedRole === "verifier";
}

function LooksLikePmDelegationFallback(text: string): boolean {
  const value = (text ?? "").toLowerCase();
  if (value === "") return false;
  const suppressedHandoff =
    /(?:do\s+not\s+handoff|do\s+not\s+hand\s+off|no\s+handoff|without\s+handoff|without\s+handing\s+off|인계\s*하지|인계하지|인계\s*없이|넘기지|넘기면\s*안|새\s*작업.*인계\s*하지)/i.test(
      value,
    );
  if (suppressedHandoff) return false;
  const handoffSignals = [
    "handoff",
    "downstream workflow",
    "not ready",
    "인계",
    "넘김",
    "넘겨",
    "준비 안",
    "준비 완료가 아니",
  ];
  if (handoffSignals.some((needle) => value.includes(needle))) return true;

  const roleSignals = [
    "reviewer",
    "verifier",
    "owner",
    "backend",
    "frontend",
    "담당",
    "프론트",
    "백엔드",
    "리뷰어",
    "검토자",
    "검수자",
    "검증자",
    "검수",
    "검증",
  ];
  const workSignals = [
    "implementation",
    "implement",
    "rework",
    "repair",
    "fix",
    "quality",
    "check",
    "verify",
    "review",
    "구현",
    "재작업",
    "수리",
    "수정",
    "고쳐",
    "품질",
    "확인",
    "검수",
    "검증",
  ];
  return roleSignals.some((needle) => value.includes(needle)) &&
    workSignals.some((needle) => value.includes(needle));
}

function BuildPmDelegationFallbackCommands(
  registry: AgentRegistry,
  assignmentContext: string,
  finalOutputText: string,
  preferredTargets: string[],
  originAssignmentContext?: string | null,
): CascadeWorkflowCommand[] {
  if (!LooksLikePmDelegationFallback(finalOutputText)) return [];

  const primaryAssignmentContext =
    ExtractPrimaryImplementationContext(assignmentContext) || StripSequencerSignals(assignmentContext);
  const qualityGoalContext = StripSequencerSignals(assignmentContext) || primaryAssignmentContext;
  const inferenceContext = `${primaryAssignmentContext}\n\n${String(finalOutputText ?? "").trim()}`.trim();
  const implementationTargets = InferQualityReworkTargets(
    registry,
    inferenceContext,
    preferredTargets,
  );
  if (implementationTargets.length === 0) return [];

  const summary = SummarizeForTaskComplete(finalOutputText, 700);
  const commands: CascadeWorkflowCommand[] =
    implementationTargets.map((agentId) => ({
      agentId,
      senderId: registry.FindAgentIdByOfficeRole("pm") ?? "pm",
      dependsOn: [],
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: AppendImplementationRequirementGuidanceToCommand(
        `Continue this PM-directed implementation handoff for the assignment: ${primaryAssignmentContext}\n\n` +
        `PM final handoff summary:\n${summary}\n\n` +
        "Execute the implementation work owned by your role, keep the scope tight to the PM handoff, and produce concrete code/test changes before handing off to review.",
        qualityGoalContext,
      ),
    }));

  const reviewerId = registry.FindAgentIdByOfficeRole("reviewer")?.trim().toLowerCase() ?? "";
  const verifierId = registry.FindAgentIdByOfficeRole("verifier")?.trim().toLowerCase() ?? "";
  const dependencyTargets = implementationTargets.map((value) => value.trim().toLowerCase());

  if (reviewerId !== "") {
    commands.push({
      agentId: reviewerId,
      senderId: registry.FindAgentIdByOfficeRole("pm") ?? "pm",
      dependsOn: dependencyTargets,
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: AppendQualityRequirementGuidanceToCommand(
        `Review the implementation completed for this assignment: ${primaryAssignmentContext}\n\n` +
        `PM final handoff summary:\n${summary}\n\n` +
        "Prioritize correctness issues, regression risks, and missing tests before any summary.",
        "reviewer",
        qualityGoalContext,
      ),
    });
  }

  if (verifierId !== "") {
    commands.push({
      agentId: verifierId,
      senderId: registry.FindAgentIdByOfficeRole("pm") ?? "pm",
      dependsOn: reviewerId !== "" ? [reviewerId] : dependencyTargets,
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: AppendQualityRequirementGuidanceToCommand(
        `Verify the completed work for this assignment: ${primaryAssignmentContext}\n\n` +
        `PM final handoff summary:\n${summary}\n\n` +
        "Collect concrete pass/fail evidence from the most relevant build, test, or runtime checks. If verification fails, report exact evidence for rework.",
        "verifier",
        qualityGoalContext,
      ),
    });
  }

  return commands;
}

type TaskCompletePayload = {
  Sender: string;
  Command: string;
  Status?: "success" | "failed";
  Summary?: string;
  ChangedFiles?: string[];
  Verification?: string;
  ReviewFindings?: string[];
  OpenRisks?: string[];
};

export type AgentExecutionCompletionStatus =
  | "completed"
  | "failed"
  | "needs_rework"
  | "blocked";

export type AgentExecutionCompletion = {
  agentId: string;
  agentName: string;
  officeRole: AgentRole;
  mode: "bundle" | "direct";
  command: string;
  status: AgentExecutionCompletionStatus;
  summary: string;
  changedFiles: string[];
  verification?: string;
  reviewFindings: string[];
  openRisks: string[];
  evidence: string[];
};

type ReviewerVerdict = "ready" | "needs_rework" | null;
type VerificationStatus = "pass" | "fail" | "blocked" | null;
type HostFeedbackStatus = "pass" | "blocked" | null;
type QualityGateSignal = {
  requiresRework: boolean;
  roleLabel: string;
  summary: string;
  evidence: string[];
  resolutionTarget?: "implementation" | "reviewer" | "verifier";
};
type QualityGateInput = {
  officeRole: AgentRole;
  outputText: string;
  stepCommand?: string;
  assignmentContext?: string | null;
  exitCode?: number | null;
  changedFiles?: string[];
};

function ExtractTaggedBlockText(text: string, tag: string): string {
  const m = (text ?? "").match(new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i"));
  return m?.[1]?.trim() ?? "";
}

function StripCliTranscriptFromOutput(text: string): string {
  const raw = String(text ?? "");
  const beforeCliTranscript = raw.split(/\nOpenAI Codex v|^OpenAI Codex v/m)[0] ?? raw;
  return beforeCliTranscript.trim() !== "" ? beforeCliTranscript : raw;
}

function ExtractPrimaryAgentResultText(text: string): string {
  const preferred = StripCliTranscriptFromOutput(text);
  const match = preferred.match(/\[STEP_\d+_RESULT\][\s\S]*?\{END_TASK_\d+\}/i);
  if (match?.[0] != null) return match[0];
  return preferred;
}

function ExtractLooseTagLineValue(text: string, tag: string): string {
  const m = (text ?? "").match(new RegExp(`\\[${tag}\\]\\s*([A-Za-z_]+)`, "i"));
  return m?.[1]?.trim() ?? "";
}

function ParseReviewerVerdict(text: string): ReviewerVerdict {
  const primary = ExtractPrimaryAgentResultText(text);
  const tagged = (ExtractTaggedBlockText(primary, "ReviewVerdict") || ExtractLooseTagLineValue(primary, "ReviewVerdict")).toLowerCase();
  if (tagged === "ready" || tagged === "needs_rework") return tagged;
  const lineMatch = primary.match(/verdict\s*:\s*(ready|needs_rework)/i);
  if (lineMatch?.[1] != null) {
    const verdict = lineMatch[1].toLowerCase();
    if (verdict === "ready" || verdict === "needs_rework") return verdict;
  }
  return null;
}

function ParseVerificationStatus(text: string): VerificationStatus {
  const primary = ExtractPrimaryAgentResultText(text);
  const tagged = (ExtractTaggedBlockText(primary, "VerificationStatus") || ExtractLooseTagLineValue(primary, "VerificationStatus")).toLowerCase();
  if (tagged === "pass" || tagged === "fail" || tagged === "blocked") return tagged;
  const lineMatch = primary.match(/verification status\s*:\s*(pass|fail|blocked)/i);
  if (lineMatch?.[1] != null) {
    const status = lineMatch[1].toLowerCase();
    if (status === "pass" || status === "fail" || status === "blocked") return status;
  }
  return null;
}

function ParseHostFeedbackStatus(text: string): HostFeedbackStatus {
  const primary = ExtractPrimaryAgentResultText(text);
  const tagged = ExtractTaggedBlockText(primary, "HostFeedbackStatus").toLowerCase();
  if (tagged === "pass" || tagged === "blocked") return tagged;
  const lineMatch = primary.match(/host feedback status\s*:\s*(pass|blocked)/i);
  if (lineMatch?.[1] != null) {
    const status = lineMatch[1].toLowerCase();
    if (status === "pass" || status === "blocked") return status;
  }
  return null;
}

function ExtractContradictoryVerifierPassFailures(text: string): string[] {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const failurePrefix =
    /^(?:[-*]\s*)?(?:(?:실패|검증\s*실패|확인하지\s*못|검증하지\s*못|부족|불충분)|(?:fail(?:ed|ure)?|blocked|cannot\s+verify|could\s+not\s+verify|not\s+verified|unverified|missing|insufficient)\b)\s*[:：-]/i;
  const failureEvidence =
    /\b(?:cannot\s+be\s+proven|cannot\s+be\s+verified|cannot\s+confirm|not\s+proven|not\s+implemented|has\s+no\s+actual|no\s+actual\s+\S+(?:\s+\S+){0,6}\s+implementation|missing\s+(?:required|requested|happy|negative|adversarial|implementation|coverage)|unverified|insufficient\s+(?:coverage|evidence|data))\b|(?:증명|검증|확인)(?:할\s+수\s+)?(?:없|못)|구현(?:이|은)?\s*(?:없|누락)|근거(?:가)?\s*(?:없|부족)/i;
  return [...new Set(lines.filter((line) => failurePrefix.test(line) || failureEvidence.test(line)).slice(0, 6))];
}

function IsVerifierEvidenceGapRisk(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (
    /\b(?:not\s+implemented|missing\s+implementation|broken|runtime\s+error|failed|failure|assertion|exception|crash)\b/i.test(value) ||
    /(?:구현(?:이|은)?\s*(?:없|누락)|오류|실패|깨짐|불일치|동작하지)/i.test(value)
  ) {
    return false;
  }
  return /\b(?:not\s+(?:executed|run|verified)|unverified|could\s+not\s+verify|cannot\s+verify|verification\s+scope|smoke\s+(?:check\s+)?(?:not\s+run|missing)|host\s+command|evidence\s+gap)\b/i.test(value) ||
    /(?:실행하지|검증하지|확인하지|검증\s*범위|미확인|호스트\s*명령|증거\s*부족|스모크\s*확인)/i.test(value);
}

function IsEvidenceGapOnlyQualityText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const lower = value.toLowerCase();
  const hasEvidenceGapSignal =
    IsVerifierEvidenceGapRisk(value) ||
    /\b(?:fresh\s+host-run\s+evidence|host-run\s+evidence|verification\s+evidence|test\s+evidence|test\s+artifact|ui\s+run|browser\s+run|capture|screenshot|executed\s+negative(?:-|\s)scenario\s+evidence|(?:build|first-screen|browser|smoke|host-run|verification)[\w\s/-]{0,80}evidence\s+(?:is\s+)?(?:still\s+)?missing|no\s+provided\s+(?:evidence|run\s+log|smoke\s+result)|no\s+evidence\s+shows|no\s+provided\s+run\s+log\s+or\s+smoke\s+result|negative(?:\/|[-\s])adversarial\s+verification\s+(?:is\s+)?(?:still\s+)?unsupported|checklist\s+item\s+\d+\s+remains?\s+unclosed|dependency-free\s+host\s+verification|run\s+(?:or\s+request\s+)?(?:the\s+)?(?:test|verification|command)|need\s+one\s+.*verification\s+run|pytest\s+(?:is\s+)?(?:missing|unavailable)|no\s+module\s+named\s+pytest|command\s+not\s+found:\s*python|can't\s+open\s+file|no\s+such\s+file\s+or\s+directory|not\s+(?:a|inside\s+a)\s+git\s+repo|git\s+diff\s+(?:is\s+)?unavailable|no\s+diff\s+evidence|current\s+material\s+does\s+not\s+show|cannot\s+review\s+from\s+current\s+material|submitted\s+evidence\s+is\s+insufficient)\b/i.test(value) ||
    /(?:실행\s*증거|실행\s*확인|검증\s*증거|확인\s*명령|실제로\s*통과|통과했다는\s*(?:새\s*)?증거|ui\s*실행|브라우저\s*실행|캡처|스크린샷|테스트\s*산출물|음수\s*시나리오\s*증거|체크리스트\s*항목[^\n.。]{0,40}(?:닫히지|미완료|안\s*닫)|근거(?:가)?\s*(?:없|부족)|증거(?:가)?\s*(?:없|부족|맞지|불일치)|확인(?:이)?\s*빠져|확인(?:할\s*수)?\s*없|확인되지|현재\s*증거만으로|현재\s*자료로는|검토할\s*수\s*없|제출되지\s*않|작업\s*위치에\s*없|파일\s*위치|의존성\s*없는\s*확인|git\s*저장소|diff(?:를|자체를)?\s*확인할\s*(?:근거가\s*없|수\s*없)|pytest|unittest|verify_[\w.-]+\.py)/i.test(value);
  if (!hasEvidenceGapSignal) return false;

  const environmentOnly =
    /(?:not\s+a\s+code\s+(?:failure|bug)|environment\s+(?:issue|problem|blocker)|pytest\s+(?:is\s+)?(?:missing|unavailable)|no\s+module\s+named\s+pytest|command\s+not\s+found:\s*python)/i.test(value) ||
    /(?:코드\s*동작\s*실패가\s*아니라|실행\s*환경\s*문제|pytest|unittest|python\s*없|의존성\s*문제)/i.test(value);
  const concreteDefect =
    /\b(?:not\s+implemented|missing\s+implementation|missing\s+script:|missing\s+package\.json|package\.json[`'"]?\s+(?:is\s+)?missing|broken|runtime\s+error|referenceerror|typeerror|syntaxerror|assertion|exception|crash|incorrect|wrong|false\s+reason|does\s+not\s+exclude|can\s+(?:still\s+)?(?:recommend|select|reserve|justify)|still\s+can\s+(?:recommend|select|reserve|justify)|violates)\b/i.test(lower) ||
    /(?:구현(?:이|은)?\s*(?:없|누락)|오류|깨짐|불일치|동작하지|틀림|잘못|거짓|추천될\s*수|선택될\s*수|제외(?:하지|가\s*안))/i.test(value);
  return environmentOnly || !concreteDefect;
}

function IsReviewerEvidenceGapOnlyText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const reviewerSpecificEvidenceGap =
    /(?:not\s+(?:a|inside\s+a)\s+git\s+repo|git\s+diff\s+(?:is\s+)?unavailable|cannot\s+review\s+from\s+current\s+material|current\s+material\s+does\s+not\s+show|need\s+more\s+(?:browser|host-run|verification)\s+evidence|(?:build|first-screen|browser|smoke|host-run|verification)[\w\s/-]{0,80}evidence\s+(?:is\s+)?(?:still\s+)?missing|no\s+provided\s+(?:evidence|run\s+log|smoke\s+result)|no\s+evidence\s+shows|no\s+provided\s+run\s+log\s+or\s+smoke\s+result|no\s+actual\s+(?:ui|browser)\s+run|no\s+(?:capture|screenshot|test\s+artifact)\s+proving|no\s+executed\s+negative(?:-|\s)scenario\s+evidence|negative(?:\/|[-\s])adversarial\s+verification\s+(?:is\s+)?(?:still\s+)?unsupported|checklist\s+item\s+\d+\s+remains?\s+unclosed)/i.test(value) ||
    /(?:git\s*저장소[^\n.。]{0,80}(?:아니|없)|diff\s*(?:자체를|를)?\s*확인할\s*(?:근거가\s*없|수\s*없)|현재\s*자료로는|검토할\s*수\s*없|브라우저\s*또는\s*host-run\s*검증\s*증거|host-run\s*검증\s*증거|검증\s*증거가\s*더\s*필요|ui\s*실행\s*증거|브라우저\s*실행\s*증거|캡처\s*증거|테스트\s*산출물|음수\s*시나리오\s*증거|체크리스트\s*항목[^\n.。]{0,40}(?:닫히지|미완료|안\s*닫))/i.test(value);
  if (reviewerSpecificEvidenceGap) return true;
  if (!IsEvidenceGapOnlyQualityText(value)) return false;
  return !IsConcreteReviewFinding(value);
}

function IsEnvironmentOnlyHostFeedbackText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const hasHostEvidence =
    /(?:HostFeedbackStatus|Host command evidence|host feedback status|host command evidence)/i.test(value);
  if (!hasHostEvidence) return false;
  const missingNodeDependencyBeforeInstall =
    !/(?:^|\s)(?:npm\s+(?:install|i|ci)|pnpm\s+(?:install|i)|yarn\s+(?:install|add)|bun\s+install)\b/i.test(value) &&
    (
      /Cannot\s+find\s+module\s+['"`](?:react|react-dom(?:\/client)?|react\/jsx-runtime|@vitejs\/plugin-react|vite|typescript|tsx|[\w@./-]+)['"`]/i.test(value) ||
      /module\s+path\s+['"`](?:react\/jsx-runtime|react|react-dom(?:\/client)?)['"`]\s+to\s+exist,\s+but\s+none\s+could\s+be\s+found/i.test(value) ||
      /node_modules[^\n.。]{0,80}(?:missing|not\s+found|없|누락)/i.test(value)
    );
  if (missingNodeDependencyBeforeInstall) return true;
  const environmentSignal =
    /(?:command\s+not\s+found|no\s+module\s+named\s+pytest|pytest\s+(?:is\s+)?(?:missing|unavailable)|failed\s+to\s+create\s+unified\s+exec\s+process|CreateProcess\s*\{[^}]*No\s+such\s+file\s+or\s+directory|sh:\s*(?:python3?|pytest|rg|fd)\s*:\s*command\s+not\s+found)/i.test(value) ||
    /(?:Rejected invalid host command before execution:\s*(?:python3?\s+-m\s+http\.server|(?:npm|pnpm)\b[\s\S]{0,80}\b(?:run\s+)?(?:dev|preview)\b|(?:npx\s+)?vite\b|(?:npx\s+)?serve\b))/i.test(value) ||
    /(?:실행\s*환경\s*문제|의존성\s*문제|pytest\s*없|python\s*없|명령(?:어)?\s*없)/i.test(value);
  if (!environmentSignal) return false;
  const concreteDefect =
    /\b(?:ReferenceError|TypeError|SyntaxError|AssertionError|TS\d{4}|runtime\s+error|build\s+failed|test\s+failed|npm\s+ERR!\s+Missing\s+script:|Missing\s+script:|not\s+implemented|missing\s+implementation|incorrect|wrong|does\s+not\s+exclude|violates)\b/i.test(value) ||
    /(?:구현(?:이|은)?\s*(?:없|누락)|오류|깨짐|동작하지|틀림|잘못|제외(?:하지|가\s*안))/i.test(value);
  return !concreteDefect;
}

function IsConcreteReviewFinding(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (LooksLikeResolvedReviewFinding(value)) return false;
  if (IsEvidenceGapOnlyQualityText(value)) return false;
  const negatedOrResolvedDefect =
    /\b(?:no|not|never|without)\b[^\n.]{0,80}\b(?:bug|issue|problem|regression|wrong|incorrect|mismatch|failure)\b/i.test(value) ||
    /\b(?:bug|issue|problem|regression|wrong|incorrect|mismatch|failure)\b[^\n.]{0,80}\b(?:not\s+(?:seen|present|reproduced|found|happening)|no\s+longer|resolved|fixed|prevented|blocked|kept\s+out|filtered\s+out)\b/i.test(
      value,
    ) ||
    /(?:문제|이슈|버그|회귀|잘못|틀림|불일치)[^\n.。]{0,80}(?:없|없음|해소|사라졌|보이지\s*않|재현되지\s*않|막고\s*있|차단|제외|남지\s*않)/i.test(
      value,
    ) ||
    /(?:없|없음|해소|사라졌|보이지\s*않|재현되지\s*않|막고\s*있|차단|제외|남지\s*않)[^\n.。]{0,80}(?:문제|이슈|버그|회귀|잘못|틀림|불일치)/i.test(
      value,
    );
  if (negatedOrResolvedDefect) return false;
  const explicitlyNonBlocking =
    /^(?:no\s+(?:blocker|blocking\s+issue|blocking\s+findings?|defect|issue|problem)s?|no\s+critical\s+issue|no\s+major\s+issue|looks\s+good\b|차단\s*(?:이슈|문제)?\s*없음|문제\s*없음|이상\s*없음|결함\s*없음|버그\s*없음|정상(?:임|입니다)?|통과|진행\s*가능)\s*[:：-]?/i.test(
      value,
    ) ||
    /(?:막을?\s*이슈를\s*찾지\s*못했|차단할?\s*이슈를\s*찾지\s*못했|block(?:ing)?\s+issue\s+not\s+found|no\s+blocking\s+issue\s+found)/i.test(
      value,
    );
  if (explicitlyNonBlocking) return false;
  return /\b(?:not\s+implemented|missing\s+implementation|missing\s+script:|missing\s+package\.json|package\.json[`'"]?\s+(?:is\s+)?missing|broken|runtime\s+error|referenceerror|typeerror|syntaxerror|assertion|exception|crash|incorrect|wrong|false\s+reason|does\s+not\s+exclude|can\s+(?:still\s+)?(?:recommend|select|reserve|justify)|still\s+can\s+(?:recommend|select|reserve|justify)|violates|cannot\s+(?:show|render|display|return|provide)\s+\d+|only\s+\d+\s+(?:items?|records?|rooms?|candidates?|options?))\b/i.test(value) ||
    /(?:구현(?:이|은)?\s*(?:없|누락)|오류|깨짐|불일치|동작하지|틀림|잘못|거짓|추천될\s*수|선택될\s*수|제외(?:하지|가\s*안)|\d+\s*개\s*뿐|추천\s*\d+\s*개[^\n.。]{0,80}(?:만족|표시|보여)[^\n.。]{0,80}(?:못|없|불가)|\d+\s*개(?:를)?\s*(?:보여|표시|제공|반환)할\s*수\s*없)/i.test(value);
}

function LooksLikeResolvedReviewFinding(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (
    /\b(?:not\s+(?:fixed|resolved|addressed)|unresolved|still\s+(?:broken|failing|wrong|missing|needs?))\b/i.test(value) ||
    /(?:해결(?:되지| 안)|미해결|아직\s*(?:깨져|실패|틀리|부족|누락|남아)|여전히\s*(?:깨져|실패|틀리|부족|누락|남아))/i.test(value)
  ) {
    return false;
  }
  const explicitReadyPrefix =
    /^(?:acceptable|accepted|ok|pass(?:ed)?|confirmed|verified|no\s+(?:issue|finding|blocker)s?|없음|문제\s*없음|이상\s*없음|통과|확인(?:됨|되었|됐)?)\s*[:：-]/i.test(value);
  if (explicitReadyPrefix) {
    const explicitOpenProblem =
      /\b(?:but|however|except|unless|unverified|untested|cannot\s+confirm|still\s+(?:missing|broken|failing|wrong)|needs?|must|should)\b/i.test(value) ||
      /(?:하지만|다만|그러나|확인(?:이)?\s*안|검증(?:이)?\s*안|확인할\s*수\s*없|필요|고쳐야|수정해야)/i.test(value);
    if (!explicitOpenProblem) return true;
  }
  const hasResolvedSignal =
    /\b(?:fixed|resolved|addressed|no\s+longer|now\s+(?:passes|uses|returns|shows|excludes|filters)|confirmed|verified)\b/i.test(value) ||
    /(?:해결(?:됨|되었|됐)|해소(?:됨|되었|됐)|수정(?:됨|되었|됐)|반영(?:됨|되었|됐)|더\s*이상[^\n.。]{0,80}(?:않|없)|이제[^\n.。]{0,80}(?:보|사용|반환|표시|제외|필터|계산)|문제(?:가)?\s*없|맞음|통과|확인(?:됨|되었|됐))/i.test(value);
  if (!hasResolvedSignal) return false;
  const hasOpenQualifier =
    /\b(?:but|however|except|unless|risk|missing|lacks?|needs?|should|must|unverified|untested|cannot\s+confirm)\b/i.test(value) ||
    /(?:하지만|다만|그러나|위험|누락(?!되지)|부족|필요|검증(?:이)?\s*안|확인(?:이)?\s*안|확인할\s*수\s*없)/i.test(value);
  if (!hasOpenQualifier) return true;
  return /(?:이전\s*문제|previous\s+(?:issue|finding|problem)|was\s+fixed|has\s+been\s+(?:fixed|resolved|addressed))/i.test(value);
}

function IsAffirmativeQualityRepairItem(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (
    /\b(?:but|however|though|yet|except|unless|recheck|revisit|review\s+again|risk|missing|mismatch|different|differs?|could|may|might|should|must|need(?:s|ed)?)\b/i.test(value) ||
    /(?:하지만|그런데|다만|그러나|다시\s*봐야|위험|누락(?!되지)|부족|불일치|달라질\s*수|다를\s*수|필요|고쳐|수정)/i.test(value)
  ) {
    return false;
  }
  if (
    IsConcreteReviewFinding(value) ||
    IsConcreteVerifierFailureText(value) ||
    IsEvidenceGapOnlyQualityText(value)
  ) {
    return false;
  }
  return (
    /\b(?:is|are|was|were)\s+(?:correct|fine|right|okay|ok|good|valid|supported)\b/i.test(value) ||
    /\b(?:looks\s+good|works?\s+as\s+expected|matches?\s+(?:the\s+)?(?:expected|contract|requirement)|confirmed|verified)\b/i.test(value) ||
    /(?:맞습니다|기본\s*흐름은\s*맞|누락되지\s*않|문제\s*없음|문제\s*없습니다|이상\s*없음|이상\s*없습니다|정상(?:임|입니다)?|통과(?:했|됨|입니다)?|확인됐|확인되었|검증됐|검증되었)/i.test(
      value,
    )
  );
}

function IsActionableQualityRepairItem(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (IsAffirmativeQualityRepairItem(value)) return false;
  if (
    IsConcreteReviewFinding(value) ||
    IsConcreteVerifierFailureText(value) ||
    IsEvidenceGapOnlyQualityText(value)
  ) {
    return true;
  }
  return (
    /\b(?:need(?:s|ed)?|should|must|required|missing|mismatch|different|differs?|drift|risk|recheck|revisit|review\s+again|unresolved|not\s+yet|still\s+needs?|could\s+diverge|may\s+diverge|can\s+diverge|could\s+differ|may\s+differ|can\s+differ)\b/i.test(
      value,
    ) ||
    /(?:필요|누락(?!되지)|부족|다시\s*봐야|불일치|위험|미완료|남아|달라질\s*수|다를\s*수|고쳐|수정)/i.test(value)
  );
}

function IsConcreteVerifierFailureText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const explicitMismatch =
    /\b(?:mismatch|does\s+not\s+match|still\s+does\s+not\s+match|drift(?:ed)?|instead\s+of|expected\s+\d+\b[^\n.]{0,80}\b(?:but|got|current)|current\s+\d+\b[^\n.]{0,80}\b(?:instead\s+of|not\s+match)|requirement\s+is\s+not\s+met|pass\s+criteria\s+.*not\s+met|contract\s+is\s+not\s+preserved)\b/i.test(
      value,
    ) ||
    /(?:기준(?:이|은)?\s*아직\s*맞지\s*않|요구사항(?:과)?\s*맞지\s*않|요구\s*계약(?:이|은)?\s*보존되지\s*않|필터\s*\d+종[^\n.。]{0,80}맞지\s*않|불일치|드리프트|여전히\s*틀리)/i.test(
      value,
    );
  if (explicitMismatch) return true;
  return IsConcreteReviewFinding(value);
}

function LooksLikeUserFacingArtifactQualityContext(command: string): boolean {
  const raw = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (raw === "") return false;
  const primary = ExtractPrimaryImplementationContext(raw).replace(/\s+/g, " ").trim();
  const candidates = [...new Set([raw, primary].filter((value) => value !== ""))];
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    const hasInternalSourcePath =
      /(?:apps\/web\/src\/|apps\\web\\src\\|src-tauri|sequencercoordinator|sequencerparser|workflowapi|agentapi|hostcommand|\.test\.[tj]sx?|\.spec\.[tj]sx?|\.(?:ts|tsx|rs|py)\b)/i.test(lower);
    const hasMaintenanceIntent =
      /\b(?:restore|fix|repair|refactor|compatibility|parser|sequencer|workflow|regression|test|internal|migration|debug)\b/i.test(lower) ||
      /(?:복구|고치|수리|리팩터|호환|파서|시퀀서|워크플로|회귀|테스트|내부|마이그레이션|디버그)/i.test(candidate);
    const hasExplicitUserArtifact =
      /\b(?:website|web\s*app|webapp|browser\s+app|landing\s*page|dashboard|user-facing\s+artifact|generated\s+artifact|deliverable|prototype)\b/i.test(candidate) ||
      /(?:웹사이트|웹\s*앱|웹앱|브라우저\s*앱|랜딩\s*페이지|대시보드|실사용\s*산출물|생성된\s*산출물|결과물|프로토타입)/i.test(candidate);
    if (hasInternalSourcePath && hasMaintenanceIntent && !hasExplicitUserArtifact) return false;
    if (LooksLikeGeneratedWebArtifactRequest(candidate) || LooksLikeConcreteArtifactCreationRequest(candidate)) {
      return true;
    }
    const hasQualityGateIntent =
      /\b(?:verify|review|inspect|quality|acceptance|smoke|user-flow|user\s+flow)\b/i.test(candidate) ||
      /(?:검증|검수|확인|품질|스모크|사용자\s*흐름)/i.test(candidate);
    const hasArtifactSubject =
      /\b(?:generated|artifact|deliverable|user-facing|website|web\s*app|webapp|dashboard|prototype|recommendation|ranking|selection|booking|scheduler|tool|app|page)\b/i.test(candidate) ||
      /(?:산출물|결과물|실사용|웹사이트|웹\s*앱|웹앱|대시보드|프로토타입|추천|순위|선택|예약|도구|툴|앱|페이지)/i.test(candidate);
    return hasQualityGateIntent && hasArtifactSubject;
  });
}

type VerifierPassEvidenceOptions = {
  countFileEvidence?: boolean;
  countHostFeedbackStatus?: boolean;
  requireUserFacingEvidence?: boolean;
  requireInteractiveUserFacingEvidence?: boolean;
  requireDecisionConstraintEvidence?: boolean;
};

function LooksLikeInputDrivenDecisionArtifactQualityContext(command: string): boolean {
  const raw = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (raw === "") return false;
  const primary = ExtractPrimaryImplementationContext(raw).replace(/\s+/g, " ").trim();
  const candidates = [...new Set([raw, primary].filter((value) => value !== ""))];
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    const hasInternalSourcePath =
      /(?:apps\/web\/src\/|apps\\web\\src\\|src-tauri|sequencercoordinator|sequencerparser|workflowapi|agentapi|hostcommand|\.test\.[tj]sx?|\.spec\.[tj]sx?|\.(?:ts|tsx|rs|py)\b)/i.test(lower);
    const hasMaintenanceIntent =
      /\b(?:restore|fix|repair|refactor|compatibility|parser|sequencer|workflow|regression|test|internal|migration|debug)\b/i.test(lower) ||
      /(?:복구|고치|수리|리팩터|호환|파서|시퀀서|워크플로|회귀|테스트|내부|마이그레이션|디버그)/i.test(candidate);
    const hasDecisionSubject =
      /\b(?:recommend|recommendation|ranking|rank|select|selection|choose|filter|search|match|book|booking|reserve|reservation|schedule|scheduler|assign|allocate)\b/i.test(candidate) ||
      /(?:추천|순위|선택|고르|픽|필터|검색|매칭|예약|일정|배정|할당)/i.test(candidate);
    if (!hasDecisionSubject) return false;
    return !(hasInternalSourcePath && hasMaintenanceIntent);
  });
}

function LooksLikeInteractiveWebArtifactQualityContext(command: string): boolean {
  const raw = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (raw === "") return false;
  const primary = ExtractPrimaryImplementationContext(raw).replace(/\s+/g, " ").trim();
  const candidates = [...new Set([raw, primary].filter((value) => value !== ""))];
  return candidates.some((candidate) => {
    const lower = candidate.toLowerCase();
    const hasInternalSourcePath =
      /(?:apps\/web\/src\/|apps\\web\\src\\|src-tauri|sequencercoordinator|sequencerparser|workflowapi|agentapi|hostcommand|\.test\.[tj]sx?|\.spec\.[tj]sx?|\.(?:ts|tsx|rs|py)\b)/i.test(lower);
    const hasMaintenanceIntent =
      /\b(?:restore|fix|repair|refactor|compatibility|parser|sequencer|workflow|regression|test|internal|migration|debug)\b/i.test(lower) ||
      /(?:복구|고치|수리|리팩터|호환|파서|시퀀서|워크플로|회귀|테스트|내부|마이그레이션|디버그)/i.test(candidate);
    const hasWebArtifactSubject =
      /\b(?:website|web\s*app|webapp|browser\s+app|landing\s*page|dashboard|single-page|single\s+page|frontend\s+artifact|user-facing\s+web|web\s+artifact|page)\b/i.test(candidate) ||
      /(?:웹사이트|웹\s*앱|웹앱|브라우저\s*앱|랜딩\s*페이지|대시보드|프론트엔드\s*산출물|웹\s*산출물|화면|페이지)/i.test(candidate);
    if (!hasWebArtifactSubject) return false;
    return !(hasInternalSourcePath && hasMaintenanceIntent);
  });
}

function LooksLikeBoundedRepairVerificationContext(command: string): boolean {
  const raw = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (raw === "") return false;
  return /\bverify\s+the\s+bounded\s+repair\s+slice\s+for\s+this\s+assignment\b/i.test(raw) ||
    /(?:bounded\s+repair\s+slice|repair\s+cycle).{0,120}(?:verify|verification|검증)/i.test(raw) ||
    /(?:제한된|좁은)\s*수리.{0,80}검증/i.test(raw);
}

function LooksLikeVerifierEvidenceGapClosureContext(command: string): boolean {
  const raw = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  if (raw === "") return false;
  return /\bre-run\s+verification\s+for\s+this\s+assignment\b[\s\S]*\bverification\s+gaps?\s+to\s+close\b/i.test(raw) ||
    /\bhost\s+(?:command|evidence|run)\b[\s\S]{0,240}\b(?:do\s+not\s+broaden|deferred|evidence\s+gap)\b/i.test(raw) ||
    /(?:호스트|실행)\s*증거[\s\S]{0,160}(?:다시|재실행|확인)/i.test(raw);
}

function HasBoundedRepairTargetClosureEvidence(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  return (
    /\bHostFeedbackStatus\]\s*pass\b/i.test(text) ||
    /\bhost\s+feedback\s+status\s*:\s*pass\b/i.test(value) ||
    /\bexit[_\s-]*code\s*(?:=|:)?\s*`?0`?\b/i.test(value) ||
    /\b(?:build|smoke|test|verification|host)\b[^\n.]{0,180}\b(?:pass(?:ed)?|success|completed|succeeded|exit[_\s-]*code\s*(?:=|:)?\s*`?0`?|통과|성공|완료)\b/i.test(value) ||
    /\b(?:prior|reported|target|bounded)\b[^\n.]{0,160}\b(?:failure|error|issue)\b[^\n.]{0,160}\b(?:gone|fixed|resolved|closed|addressed|cleared|사라|해결|수리|고쳤|닫힘)\b/i.test(value) ||
    /(?:이전|보고된|대상|제한된)[^\n.。]{0,160}(?:실패|오류|문제)[^\n.。]{0,160}(?:사라|해결|수리|고쳤|닫힘)/i.test(value)
  );
}

function HasDirectBoundedRepairFailureText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  if (/\bHost command evidence:[\s\S]*\bexit_code=(?!0\b)\d+\b/i.test(text)) return true;
  return (
    /\b(?:bounded|target|reported|prior|same)\b[^\n.]{0,160}\b(?:repair|fix|failure|error|issue)\b[^\n.]{0,160}\b(?:still|not|failed|fails|missing|unfixed|unresolved|regress(?:ed|ion)?)\b/i.test(value) ||
    /\b(?:still|not|failed|fails|missing|unfixed|unresolved|regress(?:ed|ion)?)\b[^\n.]{0,160}\b(?:bounded|target|reported|prior|same)\b[^\n.]{0,160}\b(?:repair|fix|failure|error|issue)\b/i.test(value) ||
    /(?:대상|보고된|이전|같은|제한된)[^\n.。]{0,160}(?:수리|실패|오류|문제)[^\n.。]{0,160}(?:아직|안\s*됨|못\s*고침|미해결|회귀)/i.test(value)
  );
}

function StripStandalonePreviewAvoidancePhrases(value: string): string {
  return String(value ?? "")
    .replace(
      /\bwithout(?:\s+using)?\b[^\n.]{0,100}\b(?:a\s+)?(?:standalone|generic)\s+(?:local\s+)?preview\s+server\b/gi,
      " ",
    )
    .replace(
      /\b(?:a\s+)?(?:standalone|generic)\s+(?:local\s+)?preview\s+server\b[^\n.]{0,100}\b(?:was\s+not\s+used|not\s+used|unused|avoided|skipped)\b/gi,
      " ",
    )
    .replace(
      /(?:standalone|generic)\s*(?:프리뷰|미리보기)\s*서버[^\n.。]{0,80}(?:안\s*썼|쓰지\s*않|미사용|제외)/gi,
      " ",
    );
}

function HasDecisionConstraintVerifierEvidence(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const sanitized = StripStandalonePreviewAvoidancePhrases(value);

  const englishMissingEvidence =
    /\b(?:need(?:s|ed)?|required|missing|lacks?|without|not\s+(?:run|executed|verified|covered|tested)|unverified|untested|should\s+(?:include|verify|test)|must\s+(?:include|verify|test)|cannot\s+confirm|could\s+not\s+verify|still\s+needs?)\b[^\n.]{0,140}\b(?:negative|adversarial|unavailable|already(?:\s|-)(?:used|selected|reserved|booked)|reserved|booked|banned|excluded|conflicting|conflict|false\s+condition|decision[-\s]?flow|constraint|scenario|case)\b/i.test(sanitized) ||
    /\b(?:negative|adversarial|unavailable|already(?:\s|-)(?:used|selected|reserved|booked)|reserved|booked|banned|excluded|conflicting|conflict|false\s+condition|decision[-\s]?flow|constraint|scenario|case)\b[^\n.]{0,140}\b(?:need(?:s|ed)?|required|missing|lacks?|without|not\s+(?:run|executed|verified|covered|tested)|unverified|untested|should\s+(?:include|verify|test)|must\s+(?:include|verify|test)|cannot\s+confirm|could\s+not\s+verify|still\s+needs?)\b/i.test(sanitized);
  const koreanMissingEvidence =
    /(?:필요|부족|누락|없|미실행|미검증|미확인|실행하지|검증하지|확인하지|검증\s*필요|확인\s*필요)[^\n.。]{0,140}(?:부정\s*케이스|역공격|사용\s*불가|이미\s*(?:사용|선택|예약)|예약된|금지된|밴된|제외|충돌|거짓\s*조건|조건부\s*설명|의사결정|결정\s*흐름|시나리오|케이스|조건)/i.test(sanitized) ||
    /(?:부정\s*케이스|역공격|사용\s*불가|이미\s*(?:사용|선택|예약)|예약된|금지된|밴된|제외|충돌|거짓\s*조건|조건부\s*설명|의사결정|결정\s*흐름|시나리오|케이스|조건)[^\n.。]{0,140}(?:필요|부족|누락|없|미실행|미검증|미확인|실행하지|검증하지|확인하지|검증\s*필요|확인\s*필요)/i.test(sanitized);
  if (englishMissingEvidence || koreanMissingEvidence) return false;

  const englishOutcomeEvidence =
    /\b(?:negative|adversarial|unavailable|already(?:\s|-)(?:used|selected|reserved|booked)|reserved|booked|banned|conflicting|conflict|false\s+condition|decision[-\s]?flow|constraint|scenario|case)\b[^\n.]{0,180}\b(?:pass(?:ed)?|ok|success|confirmed|verified|assert(?:ed)?|covered|tested|excluded|stayed\s+excluded|kept\s+excluded|remain(?:ed)?\s+excluded|filtered\s+out|not\s+recommended|not\s+selected|not\s+(?:reserved|booked)|blocked|blocking|prevented|cannot\s+be\s+(?:recommended|selected|reserved|booked)|does\s+not\s+(?:recommend|select|reserve|book))\b/i.test(sanitized) ||
    /\b(?:negative|adversarial)[-/\s]*(?:path|case|scenario|flow)?s?\b[^\n.]{0,220}\b(?:exclusion|exclusions|excluded|locked|sold[-\s]?out|out[-\s]?of[-\s]?stock|stock)\b/i.test(sanitized) ||
    /\b(?:adversarial|negative|hard)\s+exclusions?\b/i.test(sanitized) ||
    /\b(?:stayed\s+excluded|kept\s+excluded|remain(?:ed)?\s+excluded|filtered\s+out|not\s+recommended|not\s+selected|not\s+(?:reserved|booked)|blocked|blocking|prevented|cannot\s+be\s+(?:recommended|selected|reserved|booked)|does\s+not\s+(?:recommend|select|reserve|book))\b/i.test(sanitized) ||
    /\b(?:locked|sold[-\s]?out|out[-\s]?of[-\s]?stock|stock)\b[^\n.]{0,140}\b(?:exclusion|exclusions|excluded|filtered\s+out|not\s+recommended|not\s+selected|blocked|prevented)\b/i.test(sanitized) ||
    /\b(?:booked|reserved|conflicting|conflict)[-\s]*(?:room|item|option|entry|candidate)s?\s+exclusion\b/i.test(sanitized) ||
    /\bexclusion\s+(?:of|for)\s+(?:booked|reserved|conflicting|conflict)[-\s]*(?:room|item|option|entry|candidate)s?\b/i.test(sanitized);
  const koreanOutcomeEvidence =
    /(?:부정\s*케이스|역공격|사용\s*불가|이미\s*(?:사용|선택|예약)|예약된|금지된|밴된|제외|충돌|거짓\s*조건|조건부\s*설명|의사결정|결정\s*흐름|시나리오|케이스|조건)[^\n.。]{0,180}(?:통과|성공|확인|검증|제외(?:됐|되었|됨|했다)|필터링(?:됐|되었|됨|했다)|추천(?:하지|되지)\s*않|선택(?:하지|되지)\s*않|예약(?:하지|되지)\s*않|막았|차단)/i.test(sanitized) ||
    /(?:부정\s*케이스|역공격|negative|adversarial|잠긴|품절|locked|stock)[^\n.。]{0,220}(?:추천에\s*끼지\s*않|추천\s*목록에\s*끼지\s*않|제외\s*사유|검사(?:함|했다)?|확인|검증|제외(?:됐|되었|됨|했다)|필터링(?:됐|되었|됨|했다)|추천(?:하지|되지)\s*않|막았|차단)/i.test(sanitized) ||
    /(?:제외(?:됐|되었|됨|했다)|제외\s*사유|필터링(?:됐|되었|됨|했다)|추천에\s*끼지\s*않|추천(?:하지|되지)\s*않|선택(?:하지|되지)\s*않|예약(?:하지|되지)\s*않|막았|차단)[^\n.。]{0,180}(?:부정\s*케이스|역공격|사용\s*불가|이미\s*(?:사용|선택|예약)|예약된|금지된|밴된|잠긴|품절|locked|stock|충돌|거짓\s*조건|조건부\s*설명|의사결정|결정\s*흐름|시나리오|케이스|조건)/i.test(sanitized) ||
    /(?:예약(?:된)?|충돌|잠긴|품절)[^\n.。]{0,40}(?:방|항목|후보|구역|sku)?[^\n.。]{0,40}(?:제외|추천에\s*끼지\s*않)/i.test(sanitized);
  return englishOutcomeEvidence || koreanOutcomeEvidence;
}

type RequestedUserFacingFeatureEvidenceRule = {
  label: string;
  requestPatterns: RegExp[];
  evidencePatterns: RegExp[];
};

const REQUESTED_USER_FACING_FEATURE_EVIDENCE_RULES: RequestedUserFacingFeatureEvidenceRule[] = [
  {
    label: "add/create item flow",
    requestPatterns: [
      /\badd\b(?=[^\n.]{0,100}\b(?:edit|delete|remove|todo|task|item|record|entry|card|button|form)\b)/i,
      /\badd\s+(?:an?\s+)?(?:todo|task|item|record|entry|card|note)\b/i,
      /(?:할\s*일|항목|작업|아이템|레코드|카드|버튼|폼)[^\n.。]{0,40}(?:추가|등록)|(?:추가|등록)[^\n.。]{0,40}(?:할\s*일|항목|작업|아이템|레코드|카드|버튼|폼)/i,
    ],
    evidencePatterns: [/\badd(?:ed|s)?\b|\bcreate[sd]?\b|\bnew\s+(?:item|task|todo|record|entry)\b/i, /(?:추가|등록|새\s*(?:항목|작업|할\s*일))/i],
  },
  {
    label: "edit/update item flow",
    requestPatterns: [/\bedit\b|\bupdate\b/i, /(?:수정|편집|변경)/i],
    evidencePatterns: [/\bedit(?:ed|s)?\b|\bupdate[sd]?\b|\bsave[sd]?\b/i, /(?:수정|편집|변경|저장)/i],
  },
  {
    label: "delete/remove item flow",
    requestPatterns: [/\bdelete\b|\bremove\b/i, /(?:삭제|제거)/i],
    evidencePatterns: [/\bdelete[sd]?\b|\bremove[sd]?\b/i, /(?:삭제|제거)/i],
  },
  {
    label: "search flow",
    requestPatterns: [/\bsearch\b/i, /(?:검색)/i],
    evidencePatterns: [/\bsearch(?:ed|es)?\b|\bquery\b|\bkeyword\b/i, /(?:검색|검색어)/i],
  },
  {
    label: "filter flow",
    requestPatterns: [/\bfilters?\b|\bfiltering\b/i, /(?:필터)/i],
    evidencePatterns: [/\bfilters?\b|\bfiltering\b|\bfiltered\b|\ball\/active\/completed\b|\bactive\/completed\b/i, /(?:필터|전체\/진행|전체\/완료|진행\/완료|완료\s*필터)/i],
  },
  {
    label: "empty state flow",
    requestPatterns: [/\bempty\b|\bno\s+(?:data|result|results|items?)\b|\bblank\s+state\b/i, /(?:빈\s*(?:상태|결과)|결과\s*없|없을\s*때|목록이\s*비었)/i],
    evidencePatterns: [/\bempty\b|\bno\s+(?:data|result|results|items?)\b|\bblank\s+state\b|\bzero\s+state\b/i, /(?:빈\s*(?:상태|결과)|결과\s*없|없을\s*때|없습니다|목록이\s*비었)/i],
  },
  {
    label: "mobile/responsive flow",
    requestPatterns: [/\bmobile\b|\bresponsive\b|\bbreakpoint\b|\btouch\b/i, /(?:모바일|반응형|브레이크포인트|터치)/i],
    evidencePatterns: [/\bmobile\b|\bresponsive\b|\bbreakpoint\b|\btouch\b|\b@media\b/i, /(?:모바일|반응형|브레이크포인트|터치)/i],
  },
  {
    label: "button interaction flow",
    requestPatterns: [/\bbutton\b|\bclick\b|\bcomplete\s+button\b|\baction\b/i, /(?:버튼|클릭|완료\s*버튼|동작|액션)/i],
    evidencePatterns: [/\bbutton\b|\bclick(?:ed)?\b|\bdisabled\b|\baction\b|\binteraction\b/i, /(?:버튼|클릭|비활성|동작|상호작용)/i],
  },
  {
    label: "viewport overflow/action visibility flow",
    requestPatterns: [
      /\b(?:clip(?:ped|ping)?|overflow|off[-\s]?viewport|outside\s+the\s+viewport|fit\s+(?:on|within)|horizontal\s+scroll|table\s+actions?|action\s+buttons?)\b/i,
      /(?:잘림|넘침|화면\s*밖|뷰포트|가로\s*스크롤|액션|작업\s*버튼|버튼이\s*안\s*보)/i,
    ],
    evidencePatterns: [
      /\b(?:browser|preview|screenshot|playwright|viewport|mobile|desktop|bounding|clientWidth|scrollWidth|layout)\b[^\n.]{0,180}\b(?:no\s+horizontal\s+(?:viewport\s+)?overflow|no\s+clipp(?:ing|ed)|not\s+clipped|within\s+viewport|fit(?:s|ted)?\s+(?:on|within)|action(?:s|\s+buttons?)?\s+(?:visible|reachable|fit)|primary\s+interactive\s+controls\s+(?:visible|reachable))\b/i,
      /\b(?:no\s+horizontal\s+(?:viewport\s+)?overflow|no\s+clipp(?:ing|ed)|not\s+clipped|within\s+viewport|fit(?:s|ted)?\s+(?:on|within)|action(?:s|\s+buttons?)?\s+(?:visible|reachable|fit)|primary\s+interactive\s+controls\s+(?:visible|reachable))\b[^\n.]{0,180}\b(?:browser|preview|screenshot|playwright|viewport|mobile|desktop|bounding|clientWidth|scrollWidth|layout)\b/i,
      /(?:브라우저|프리뷰|스크린샷|뷰포트|모바일|데스크톱|레이아웃)[^\n.。]{0,180}(?:가로\s*넘침\s*없|잘림\s*없|화면\s*안|버튼\s*(?:보임|도달|맞음)|액션\s*(?:보임|도달|맞음))/i,
    ],
  },
  {
    label: "favorite persistence flow",
    requestPatterns: [/\bfavou?rites?\b|\bstarred\b|\bsaved\s+(?:items?|places?|candidates?)\b/i, /(?:즐겨찾기|찜|저장\s*목록)/i],
    evidencePatterns: [/\bfavou?rites?\b|\bstar(?:red)?\b|\bsaved\s+(?:items?|places?|candidates?)\b/i, /(?:즐겨찾기|찜|저장\s*목록)/i],
  },
  {
    label: "localStorage persistence flow",
    requestPatterns: [/\blocalStorage\b|\blocal\s+storage\b|\bpersist(?:ence|ent)?\b/i, /(?:로컬\s*스토리지|localStorage|저장|복원|유지)/i],
    evidencePatterns: [/\blocalStorage\b|\blocal\s+storage\b|\bpersist(?:ed|s|ence)?\b|\breload\b|\brestore[sd]?\b/i, /(?:로컬\s*스토리지|localStorage|저장|복원|유지|새로고침)/i],
  },
  {
    label: "sort/order flow",
    requestPatterns: [/\bsort\b|\border(?:ing)?\b/i, /(?:정렬|순서)/i],
    evidencePatterns: [/\bsort(?:ed|s)?\b|\border(?:ed|ing)?\b/i, /(?:정렬|순서)/i],
  },
  {
    label: "drag/drop flow",
    requestPatterns: [/\bdrag\b|\bdrop\b|\bdrag-and-drop\b/i, /(?:드래그|드롭|끌어)/i],
    evidencePatterns: [/\bdrag(?:ged)?\b|\bdrop(?:ped)?\b|\bdrag-and-drop\b/i, /(?:드래그|드롭|끌어)/i],
  },
  {
    label: "artifact-local smoke/test flow",
    requestPatterns: [/\bsmoke\b|\buser-flow\b|\buser\s+flow\b|\be2e\b/i, /(?:스모크|사용자\s*흐름|엔드\s*투\s*엔드)/i],
    evidencePatterns: [/\bsmoke\b|\buser-flow\b|\buser\s+flow\b|\be2e\b|\btest\s+script\b|\btest\s+file\b|\bplaywright\b|\bvitest\b/i, /(?:스모크|사용자\s*흐름|엔드\s*투\s*엔드|테스트\s*(?:스크립트|파일)|플레이라이트|비테스트)/i],
  },
];

function ExtractMissingRequestedUserFacingFeatureEvidence(requestText: string, evidenceText: string): string[] {
  const request = StripSequencerSignals(requestText).replace(/\s+/g, " ").trim();
  const evidence = StripSequencerSignals(evidenceText).replace(/\s+/g, " ").trim();
  if (request === "" || evidence === "") return [];
  return REQUESTED_USER_FACING_FEATURE_EVIDENCE_RULES
    .filter((rule) =>
      rule.requestPatterns.some((pattern) => pattern.test(request)) &&
      !rule.evidencePatterns.some((pattern) => pattern.test(evidence)),
    )
    .map((rule) => rule.label);
}

function SaysInteractiveUserFacingEvidenceIsMissing(value: string): boolean {
  const sanitized = StripStandalonePreviewAvoidancePhrases(value);
  return (
    /\b(?:need(?:s|ed)?|required|missing|lacks?|without|not\s+(?:run|executed|verified|covered|tested|loaded|rendered)|unverified|untested|should\s+(?:include|verify|test|run)|must\s+(?:include|verify|test|run)|cannot\s+confirm|could\s+not\s+verify|still\s+needs?)\b[^\n.]{0,140}\b(?:smoke|user-flow|user\s+flow|e2e|end-to-end|preview|browser|playwright|cypress|render(?:ed|ing)?|screenshot|click|form|input|interaction)\b/i.test(sanitized) ||
    /\b(?:smoke|user-flow|user\s+flow|e2e|end-to-end|preview|browser|playwright|cypress|render(?:ed|ing)?|screenshot|click|form|input|interaction)\b[^\n.]{0,140}\b(?:need(?:s|ed)?|required|missing|lacks?|without|not\s+(?:run|executed|verified|covered|tested|loaded|rendered)|unverified|untested|should\s+(?:include|verify|test|run)|must\s+(?:include|verify|test|run)|cannot\s+confirm|could\s+not\s+verify|still\s+needs?)\b/i.test(sanitized) ||
    /(?:필요|부족|누락|없|미실행|미검증|미확인|실행하지|검증하지|확인하지|로드하지|렌더(?:링)?하지|검증\s*필요|확인\s*필요)[^\n.。]{0,140}(?:스모크|사용자\s*흐름|e2e|엔드\s*투\s*엔드|프리뷰|브라우저|플레이라이트|렌더(?:링)?|스크린샷|클릭|폼|입력|상호작용)/i.test(sanitized) ||
    /(?:스모크|사용자\s*흐름|e2e|엔드\s*투\s*엔드|프리뷰|브라우저|플레이라이트|렌더(?:링)?|스크린샷|클릭|폼|입력|상호작용)[^\n.。]{0,140}(?:필요|부족|누락|없|미실행|미검증|미확인|실행하지|검증하지|확인하지|로드하지|렌더(?:링)?하지|검증\s*필요|확인\s*필요)/i.test(sanitized)
  );
}

function IsMissingGeneratedWebSmokeSupportText(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const mentionsWebUserFlow =
    /\b(?:web\s*app|website|frontend|browser|dom|ui|render(?:ed|ing)?|user-flow|user\s+flow|smoke|script\/test|test\s+(?:file|script|dependency|config)|playwright|puppeteer|jsdom|cypress|vitest|assert(?:s|ion)?|executable\s+proof|smoke\s+(?:file|script|dependency|config))\b/i.test(value) ||
    /(?:웹\s*앱|웹사이트|프론트엔드|브라우저|화면|렌더(?:링)?|사용자\s*흐름|스모크|테스트\s*(?:파일|스크립트|의존성|설정))/i.test(value);
  if (!mentionsWebUserFlow) return false;
  const missingSupport =
    /\b(?:no|missing|without|lacks?|not\s+installed|not\s+available|cannot\s+be\s+proven|cannot\s+prove|cannot\s+verify|could\s+not\s+verify|required\s+gap|needs?\s+(?:an?\s+)?(?:existing|approved)?)\b[^\n.]{0,180}\b(?:smoke|test\s+script|test\s+file|browser\s+test|user-flow|user\s+flow|playwright|puppeteer|jsdom|cypress|vitest|dom\s+interaction|localStorage)\b/i.test(value) ||
    /\b(?:smoke|test\s+script|test\s+file|browser\s+test|user-flow|user\s+flow|playwright|puppeteer|jsdom|cypress|vitest|dom\s+interaction|localStorage)\b[^\n.]{0,180}\b(?:no|missing|without|lacks?|not\s+installed|not\s+available|cannot\s+be\s+proven|cannot\s+prove|cannot\s+verify|could\s+not\s+verify|required\s+gap|needs?)\b/i.test(value) ||
    /\b(?:no|missing|without|lacks?)\s+(?:existing\s+)?(?:script\/test|test|smoke)[^\n.]{0,140}\b(?:asserts?|covers?|proves?|directly\s+(?:asserts?|covers?|proves?))\b/i.test(value) ||
    /\b(?:existing\s+)?(?:script\/test|test|smoke)[^\n.]{0,140}\b(?:does\s+not|doesn't|cannot|can't)\s+(?:directly\s+)?(?:assert|cover|prove)\b/i.test(value) ||
    /(?:없|누락|미설치|사용할\s*수\s*없|검증할\s*수\s*없|증명할\s*수\s*없|필요)[^\n.。]{0,180}(?:스모크|테스트\s*스크립트|테스트\s*파일|브라우저\s*테스트|사용자\s*흐름|플레이라이트|퍼피티어|jsdom|cypress|vitest|dom\s*상호작용|localStorage)/i.test(value) ||
    /(?:스모크|테스트\s*스크립트|테스트\s*파일|브라우저\s*테스트|사용자\s*흐름|플레이라이트|퍼피티어|jsdom|cypress|vitest|dom\s*상호작용|localStorage)[^\n.。]{0,180}(?:없|누락|미설치|사용할\s*수\s*없|검증할\s*수\s*없|증명할\s*수\s*없|필요)/i.test(value);
  if (!missingSupport) return false;
  const onlyForbiddenPreview =
    /(?:dev\s+server|preview\s+server|standalone\s+server|generic\s+server|npm\s+run\s+dev|npm\s+run\s+preview|vite|serve|로컬\s*서버|프리뷰\s*서버)/i.test(value) &&
    !/(?:playwright|puppeteer|jsdom|cypress|vitest|test\s+script|test\s+file|smoke\s+script|smoke\s+file|localStorage|dom\s+interaction|사용자\s*흐름|테스트\s*스크립트|테스트\s*파일)/i.test(value);
  return !onlyForbiddenPreview;
}

function HasInteractiveUserFacingOutcomeEvidence(value: string): boolean {
  if (SaysInteractiveUserFacingEvidenceIsMissing(value)) return false;
  return (
    /\b(?:smoke|user-flow|user\s+flow|e2e|end-to-end|preview|browser|playwright|cypress|render(?:ed|ing)?|screenshot|click|form|input|interaction|localhost|127\.0\.0\.1|happy\s+path)\b[^\n.]{0,180}\b(?:pass(?:ed)?|success|ok|loaded|opened|render(?:ed)?|submitted|clicked|filled|captured|confirmed|verified|check(?:ed)?|assert(?:ed)?|covered|tested|reached|excluded|통과|성공|로드|렌더(?:링)?|클릭|입력|확인|검증|제외)\b/i.test(value) ||
    /\b(?:pass(?:ed)?|success|ok|loaded|opened|render(?:ed)?|submitted|clicked|filled|captured|confirmed|verified|check(?:ed)?|assert(?:ed)?|covered|tested|reached|excluded)\b[^\n.]{0,180}\b(?:smoke|user-flow|user\s+flow|e2e|end-to-end|preview|browser|playwright|cypress|render(?:ed|ing)?|screenshot|click|form|input|interaction|localhost|127\.0\.0\.1|happy\s+path)\b/i.test(value) ||
    /(?:스모크|사용자\s*흐름|e2e|엔드\s*투\s*엔드|프리뷰|브라우저|플레이라이트|렌더(?:링)?|스크린샷|클릭|폼|입력|상호작용)[^\n.。]{0,180}(?:통과|성공|로드|열림|렌더(?:링)?|제출|클릭|입력|캡처|확인|검증|검사|도달)/i.test(value) ||
    /(?:통과|성공|로드|열림|렌더(?:링)?|제출|클릭|입력|캡처|확인|검증|검사|도달)[^\n.。]{0,180}(?:스모크|사용자\s*흐름|e2e|엔드\s*투\s*엔드|프리뷰|브라우저|플레이라이트|렌더(?:링)?|스크린샷|클릭|폼|입력|상호작용)/i.test(value)
  );
}

function HasConcreteVerifierPassEvidence(
  text: string,
  changedFiles: string[] = [],
  options: VerifierPassEvidenceOptions = {},
): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  const countHostFeedbackStatus = options.countHostFeedbackStatus ?? true;
  if (countHostFeedbackStatus && ParseHostFeedbackStatus(text) === "pass") return true;
  const countFileEvidence = options.countFileEvidence ?? true;
  if (countFileEvidence && ExtractReportedFilesList(text, changedFiles).length > 0) return true;
  const interactiveUserFacingRuntimeEvidence =
    /\b(?:smoke|user-flow|user\s+flow|e2e|end-to-end|preview|local\s+preview|browser|playwright|cypress|localhost|127\.0\.0\.1|happy\s+path|negative|adversarial|render(?:ed|ing)?|screenshot|click|form|input|interaction)\b/i.test(value) ||
    /(?:스모크|사용자\s*흐름|e2e|엔드\s*투\s*엔드|로컬\s*프리뷰|프리뷰|브라우저|해피\s*패스|부정\s*케이스|역공격|렌더(?:링)?|스크린샷|클릭|폼|입력|상호작용)/i.test(value);
  const interactiveUserFacingOutcomeEvidence = HasInteractiveUserFacingOutcomeEvidence(value);
  const apiOnlyUserFacingEvidence =
    /\bapi\s+checks?\b/i.test(value) ||
    /api\s*검사/i.test(value);
  const userFacingRuntimeEvidence =
    (options.requireInteractiveUserFacingEvidence === true
      ? interactiveUserFacingOutcomeEvidence
      : interactiveUserFacingRuntimeEvidence) ||
    (options.requireInteractiveUserFacingEvidence !== true && apiOnlyUserFacingEvidence);
  const commandBackedInteractiveUserFacingEvidence =
    /\b(?:npm|pnpm|yarn|bun|deno)\b[^\n]{0,180}\b(?:smoke|e2e|playwright|cypress)\b[^\n]{0,180}\b(?:pass(?:ed)?|success|ok|exit[_\s-]*code\s*[:=]?\s*0|exit\s+0\b|통과|성공)/i.test(value) ||
    /\b(?:playwright|cypress)\b[^\n]{0,180}\b(?:pass(?:ed)?|success|ok|exit[_\s-]*code\s*[:=]?\s*0|exit\s+0\b|통과|성공)/i.test(value) ||
    /\b(?:user-flow|user\s+flow|browser|preview|render(?:ed|ing)?)\b[^\n]{0,180}\b(?:pass(?:ed)?|success|ok|loaded|excluded|통과|성공|로드|제외)/i.test(value) ||
    /(?:사용자\s*흐름|브라우저|프리뷰|렌더(?:링)?)\s*(?:통과|성공|로드|제외)/i.test(value);
  const commandBackedGeneralUserFacingEvidence =
    /\b(?:npm|pnpm|yarn|bun|deno)\b[^\n]{0,180}\b(?:test|smoke|e2e|playwright|cypress|vitest)\b[^\n]{0,180}\b(?:pass(?:ed)?|success|ok|exit[_\s-]*code\s*[:=]?\s*0|exit\s+0\b|통과|성공)/i.test(value) ||
    /\b(?:python3?|pytest|unittest|vitest|playwright|cypress|curl)\b[^\n]{0,180}\b(?:pass(?:ed)?|success|ok|exit[_\s-]*code\s*[:=]?\s*0|exit\s+0\b|ran\s+\d+\s+tests?|통과|성공)/i.test(value) ||
    /\b(?:existing\s+)?(?:test|smoke|verification)\s+command\s+pass(?:ed)?\b/i.test(value) ||
    /\b(?:dependency-free\s+fallback|fallback|existing\s+(?:test|smoke|verification)\s+command)\s+pass(?:ed)?\s*:/i.test(value) ||
    /(?:테스트|스모크|검증)\s*(?:통과|성공)/i.test(value);
  const commandBackedUserFacingEvidence =
    options.requireInteractiveUserFacingEvidence === true
      ? commandBackedInteractiveUserFacingEvidence
      : commandBackedGeneralUserFacingEvidence;
  if (options.requireUserFacingEvidence === true) {
    const hasRuntimeEvidence = userFacingRuntimeEvidence || commandBackedUserFacingEvidence;
    if (!hasRuntimeEvidence) return false;
    if (options.requireDecisionConstraintEvidence === true) {
      return HasDecisionConstraintVerifierEvidence(text);
    }
    return true;
  }
  const commandBackedRuntimeEvidence =
    /\b(?:npm|pnpm|yarn|bun|deno|cargo|python3?|pytest|unittest|vitest|playwright|cypress|curl)\b[^\n]{0,160}\b(?:pass(?:ed)?|success|ok|exit[_\s-]*code\s*[:=]?\s*0|exit\s+0\b|통과|성공)/i.test(value) ||
    /\b(?:test|build|smoke|verification)\s+command\s+pass(?:ed)?\b/i.test(value) ||
    /\b(?:dependency-free\s+fallback|fallback|existing\s+(?:test|smoke|build|verification)\s+command)\s+pass(?:ed)?\s*:/i.test(value) ||
    /(?:테스트|빌드|검증)\s*(?:통과|성공)/i.test(value);
  if (commandBackedRuntimeEvidence || userFacingRuntimeEvidence) return true;
  const fileEvidenceText =
    /\bfile\s+list\b/i.test(value) || /파일\s*목록/i.test(value);
  if (countFileEvidence && fileEvidenceText) return true;
  return false;
}

function IsGenericVerifierPassEvidence(
  text: string,
  changedFiles: string[] = [],
  options: VerifierPassEvidenceOptions = {},
): boolean {
  const verificationText = ExtractTaggedBlockText(text, "Verification") || text;
  const stripped = ["VerificationStatus", "HostFeedbackStatus", "Command", "Commands", "FilesCreated"]
    .reduce((current, tag) => StripTaggedBlock(current, tag), verificationText)
    .replace(/\s+/g, " ")
    .trim();
  if (stripped === "") return true;
  if (HasConcreteVerifierPassEvidence(text, changedFiles, options)) return false;
  if ((options.countHostFeedbackStatus ?? true) === false && /Host command evidence:/i.test(text)) {
    return true;
  }
  if (stripped.length > 180) return false;
  return (
    /\b(?:pass(?:ed)?|ok|done|complete(?:d)?|ready|verified|checked|looks\s+good|works?)\b/i.test(stripped) ||
    /(?:작업\s*완료|완료|통과|확인\s*완료|검증\s*완료|문제\s*없|좋습니다|됩니다)/i.test(stripped)
  );
}

function BuildQualityGateSignal(
  input: QualityGateInput,
): QualityGateSignal | null {
  const officeRole = input.officeRole;
  const text = ExtractPrimaryAgentResultText(input.outputText);
  const stepCommand = String(input.stepCommand ?? "").trim();
  const assignmentContext = ResolveOriginAssignmentContext(input.assignmentContext, stepCommand);
  const exitCode = typeof input.exitCode === "number" ? input.exitCode : null;
  const hostFeedbackStatus = ParseHostFeedbackStatus(text);
  if (officeRole === "reviewer") {
    const verificationText = ExtractTaggedBlockText(text, "Verification") || text;
    const findings = ParseListLines(ExtractTaggedBlockText(text, "ReviewFindings")).slice(0, 6);
    const risks = ParseListLines(ExtractTaggedBlockText(text, "OpenRisks")).slice(0, 4);
    if (
      hostFeedbackStatus === "blocked" ||
      (
        hostFeedbackStatus !== "pass" &&
        /Host command evidence:/i.test(verificationText) &&
        /\bexit_code=(?!0\b)\d+\b/i.test(verificationText)
      )
    ) {
      const evidence = SummarizeQualityVerificationEvidence(verificationText, 360);
      const qualityItems = [verificationText, ...findings, ...risks]
        .map((item) => String(item ?? "").trim())
        .filter((item) => item !== "");
      const hasConcreteImplementationFinding =
        qualityItems.some(IsConcreteReviewFinding) ||
        /Host command evidence:[\s\S]*(?:ReferenceError|TypeError|SyntaxError|AssertionError|npm\s+ERR!\s+Missing script:|Missing script:)/i.test(
          verificationText,
        );
      return {
        requiresRework: true,
        roleLabel: "reviewer",
        summary: hasConcreteImplementationFinding
          ? "Reviewer host-command-backed inspection found concrete implementation evidence that needs repair."
          : "Reviewer host-command-backed inspection did not complete cleanly and needs verification evidence, not implementation repair.",
        evidence: [
          stepCommand !== "" ? `quality_step=${stepCommand}` : "",
          exitCode != null ? `exit_code=${String(exitCode)}` : "",
          hostFeedbackStatus != null ? `host_feedback_status=${hostFeedbackStatus}` : "",
          evidence !== "" ? `verification=${evidence}` : "",
        ].filter((part) => part !== ""),
        resolutionTarget: hasConcreteImplementationFinding ? "implementation" : "verifier",
      };
    }
    const verdict = ParseReviewerVerdict(text);
    if (verdict == null) {
      return {
        requiresRework: true,
        roleLabel: "reviewer",
        summary:
          "Reviewer output did not include the required [ReviewVerdict] gate. Rerun the review in strict quality-gate format before treating it as ready.",
        evidence: [
          stepCommand !== "" ? `quality_step=${stepCommand}` : "",
          /\[SEQUENCER_PLAN\]/i.test(text) ? "reviewer_format=unexpected SEQUENCER_PLAN" : "",
          "reviewer_format=missing ReviewVerdict",
        ].filter((part) => part !== ""),
        resolutionTarget: "reviewer",
      };
    }
    if (verdict === "ready" && risks.length > 0) {
      return {
        requiresRework: true,
        roleLabel: "reviewer",
        summary: "Reviewer marked the work ready but still listed unresolved open risks. Convert those risks into concrete repair work before the review can pass.",
        evidence: [
          stepCommand !== "" ? `quality_step=${stepCommand}` : "",
          findings.length > 0 ? `review_findings=${findings.join(" | ")}` : "",
          risks.length > 0 ? `open_risks=${risks.join(" | ")}` : "",
        ].filter((part) => part !== ""),
      };
    }
    const concreteReadyFindings =
      verdict === "ready" ? findings.filter(IsConcreteReviewFinding).slice(0, 4) : [];
    if (concreteReadyFindings.length > 0) {
      return {
        requiresRework: true,
        roleLabel: "reviewer",
        summary:
          "Reviewer marked the work ready but still listed concrete defects. Repair those findings before the review can pass.",
        evidence: [
          stepCommand !== "" ? `quality_step=${stepCommand}` : "",
          `review_findings=${concreteReadyFindings.join(" | ")}`,
        ].filter((part) => part !== ""),
        resolutionTarget: "implementation",
      };
    }
    if (verdict !== "needs_rework") return null;
    const parts = [
      "Reviewer requested rework.",
      findings.length > 0 ? `Address these review findings: ${findings.join(" | ")}` : "",
      risks.length > 0 ? `Watch these open risks: ${risks.join(" | ")}` : "",
    ].filter((part) => part !== "");
    const qualityItems = [...findings, ...risks];
    const reviewerEvidenceText = qualityItems.join(" | ");
    const nonGitEvidenceGapOnly =
      /(?:not\s+(?:a|inside\s+a)\s+git\s+repo|git\s+diff\s+(?:is\s+)?unavailable|git\s*저장소|diff\s*(?:자체를|를)?\s*확인할)/i.test(reviewerEvidenceText) &&
      /(?:cannot\s+review\s+from\s+current\s+material|current\s+material\s+does\s+not\s+show|need\s+more\s+(?:browser|host-run|verification)\s+evidence|현재\s*자료로는|검토할\s*수\s*없|근거가\s*없|검증\s*증거|host-run\s*검증\s*증거|브라우저\s*또는\s*host-run\s*검증\s*증거)/i.test(reviewerEvidenceText) &&
      qualityItems.every((item) => !IsConcreteReviewFinding(item));
    const evidenceGapOnly =
      nonGitEvidenceGapOnly ||
      (
        qualityItems.length > 0 && qualityItems.some(IsReviewerEvidenceGapOnlyText) &&
        qualityItems.every((item) => IsReviewerEvidenceGapOnlyText(item) || !IsConcreteReviewFinding(item))
      );
    return {
      requiresRework: true,
      roleLabel: "reviewer",
      summary: parts.join(" "),
      evidence: [
        stepCommand !== "" ? `quality_step=${stepCommand}` : "",
        findings.length > 0 ? `review_findings=${findings.join(" | ")}` : "",
        risks.length > 0 ? `open_risks=${risks.join(" | ")}` : "",
      ].filter((part) => part !== ""),
      resolutionTarget: evidenceGapOnly ? "verifier" : "implementation",
    };
  }
  if (officeRole === "verifier") {
    const verifierRoleText = StripTaggedBlocks(text, ["ReviewVerdict", "ReviewFindings"]);
    const verifierHostFeedbackStatus = ParseHostFeedbackStatus(verifierRoleText);
    const status = ParseVerificationStatus(verifierRoleText);
    const verificationText = ExtractTaggedBlockText(verifierRoleText, "Verification") || verifierRoleText;
    const risks = ParseListLines(ExtractTaggedBlockText(verifierRoleText, "OpenRisks")).slice(0, 4);
    const isVerifierEvidenceGapClosure =
      LooksLikeVerifierEvidenceGapClosureContext(stepCommand);
    if (status == null && verifierHostFeedbackStatus == null) {
      return {
        requiresRework: true,
        roleLabel: "verifier",
        summary:
          "Verifier output did not include the required [VerificationStatus] gate. Rerun verification in strict quality-gate format before treating it as complete.",
        evidence: [
          stepCommand !== "" ? `quality_step=${stepCommand}` : "",
          /\[SEQUENCER_PLAN\]/i.test(verifierRoleText) ? "verifier_format=unexpected SEQUENCER_PLAN" : "",
          "verifier_format=missing VerificationStatus",
        ].filter((part) => part !== ""),
        resolutionTarget: "verifier",
      };
    }
    const contradictoryPassFailures =
      status === "pass" ? ExtractContradictoryVerifierPassFailures(verificationText).slice(0, 4) : [];
    const hasConcreteHostFailure =
      /Host command evidence:[\s\S]*(?:ReferenceError|TypeError|SyntaxError|AssertionError|TS\d{4}|error\s+TS\d{4}|tsconfig[^\n]*not\s+found|package\.json[^\n]*(?:not\s+found|missing|enoent)|(?:not\s+found|missing|enoent)[^\n]*package\.json|npm\s+ERR!\s+Missing script:|Missing script:)/i.test(verifierRoleText) ||
      (
        /Host command evidence:/i.test(verifierRoleText) &&
        (
          IsViteEsbuildAuditHostFailure(verifierRoleText) ||
          IsPackagePeerDependencyConflictHostFailure(verifierRoleText) ||
          IsMissingGeneratedWebTestRunnerHostFailure(verifierRoleText)
        )
      );
    const primaryStepContext =
      ExtractPrimaryImplementationContext(stepCommand) || stepCommand;
    const primaryAssignmentContext =
      ExtractPrimaryImplementationContext(assignmentContext) || assignmentContext;
    const verifierRequirementContext = [
      primaryStepContext,
      primaryAssignmentContext,
    ]
      .map((value) => StripSequencerSignals(value).trim())
      .filter((value, index, arr) => value !== "" && arr.indexOf(value) === index)
      .join("\n");
    const isBoundedRepairVerification =
      LooksLikeBoundedRepairVerificationContext(stepCommand);
    const requiresInteractiveUserFacingEvidence =
      !isBoundedRepairVerification &&
      LooksLikeInteractiveWebArtifactQualityContext(primaryStepContext);
    const requiresUserFacingEvidence =
      !isBoundedRepairVerification &&
      (
        requiresInteractiveUserFacingEvidence ||
        (
          LooksLikeUserFacingArtifactQualityContext(primaryStepContext) &&
          !LooksLikeBackendImplementationContext(primaryStepContext)
        )
      );
    const requiresDecisionConstraintEvidence =
      !isBoundedRepairVerification &&
      LooksLikeInputDrivenDecisionArtifactQualityContext(primaryStepContext);
    const strictVerifierPassEvidenceOptions = {
      countFileEvidence: false,
      countHostFeedbackStatus: false,
      requireUserFacingEvidence: true,
      requireInteractiveUserFacingEvidence: requiresInteractiveUserFacingEvidence,
      requireDecisionConstraintEvidence: requiresDecisionConstraintEvidence,
    };
    const hasStrictConcreteVerifierPassEvidence =
      HasConcreteVerifierPassEvidence(verifierRoleText, input.changedFiles ?? [], strictVerifierPassEvidenceOptions);
    const hasGenericPassEvidenceGap =
      status === "pass" &&
      requiresUserFacingEvidence &&
      IsGenericVerifierPassEvidence(verifierRoleText, input.changedFiles ?? [], strictVerifierPassEvidenceOptions);
    const hasUserFacingEvidenceGap =
      status === "pass" &&
      requiresUserFacingEvidence &&
      !hasStrictConcreteVerifierPassEvidence;
    const hasDecisionConstraintEvidenceGap =
      status === "pass" &&
      requiresDecisionConstraintEvidence &&
      !hasStrictConcreteVerifierPassEvidence;
    const missingRequestedFeatureEvidence =
      status === "pass" && LooksLikeInteractiveWebArtifactQualityContext(verifierRequirementContext)
        ? ExtractMissingRequestedUserFacingFeatureEvidence(verifierRequirementContext, verifierRoleText).slice(0, 6)
        : [];
    const hasRequestedFeatureEvidenceGap = missingRequestedFeatureEvidence.length > 0;
    const requestedFeatureVerifierEvidenceGap =
      hasRequestedFeatureEvidenceGap && !hasStrictConcreteVerifierPassEvidence;
    const environmentOnlyHostBlocked =
      verifierHostFeedbackStatus === "blocked" &&
      IsEnvironmentOnlyHostFeedbackText(verifierRoleText);
    const verifierQualityItems =
      [verificationText, verifierRoleText, ...risks].filter((item) => String(item ?? "").trim() !== "");
    const concreteVerifierFailures = verifierQualityItems
      .filter((item) => IsConcreteVerifierFailureText(item))
      .slice(0, 4);
    const missingGeneratedWebSmokeSupport =
      status === "blocked" &&
      requiresInteractiveUserFacingEvidence &&
      verifierQualityItems.some(IsMissingGeneratedWebSmokeSupportText);
    const insufficientGeneratedWebSmokeCoverage =
      status === "pass" &&
      verifierHostFeedbackStatus === "pass" &&
      requiresInteractiveUserFacingEvidence &&
      hasUserFacingEvidenceGap &&
      /Host command evidence:[\s\S]*(?:\bnpm\s+run\s+smoke\b|\bsmoke\s+passed\b|\bsmoke\b)/i.test(
        verifierRoleText,
      );
    const evidenceGapOnly =
      !missingGeneratedWebSmokeSupport &&
      !insufficientGeneratedWebSmokeCoverage &&
      (!hasRequestedFeatureEvidenceGap || requestedFeatureVerifierEvidenceGap) &&
      concreteVerifierFailures.length === 0 &&
      contradictoryPassFailures.length === 0 &&
      !hasConcreteHostFailure &&
      (
        requestedFeatureVerifierEvidenceGap ||
        environmentOnlyHostBlocked ||
        hasGenericPassEvidenceGap ||
        hasUserFacingEvidenceGap ||
        hasDecisionConstraintEvidenceGap ||
        (
          status === "pass" &&
          risks.length > 0 &&
          risks.every(IsVerifierEvidenceGapRisk)
        ) ||
        (
          status === "blocked" &&
          verifierQualityItems.length > 0 &&
          verifierQualityItems.some(IsEvidenceGapOnlyQualityText) &&
          verifierQualityItems.every((item) => IsEvidenceGapOnlyQualityText(item) || !IsConcreteVerifierFailureText(item))
        )
      );
    const effectiveStatus =
      status === "fail" || status === "blocked"
        ? status
        : verifierHostFeedbackStatus === "blocked"
          ? "blocked"
          : verifierHostFeedbackStatus === "pass" && risks.length > 0
            ? "blocked"
          : null;
    const hasContradictoryPass =
      status === "pass" &&
      (
        contradictoryPassFailures.length > 0 ||
        risks.length > 0 ||
        hasGenericPassEvidenceGap ||
        hasUserFacingEvidenceGap ||
        hasDecisionConstraintEvidenceGap ||
        hasRequestedFeatureEvidenceGap
      );
    const boundedRepairTargetClosed =
      isBoundedRepairVerification &&
      !hasConcreteHostFailure &&
      HasBoundedRepairTargetClosureEvidence(verifierRoleText) &&
      !HasDirectBoundedRepairFailureText(verifierRoleText);
    const passingHostUserFacingSmokeEvidence =
      status === "pass" &&
      verifierHostFeedbackStatus === "pass" &&
      !hasConcreteHostFailure &&
      risks.length === 0 &&
      concreteVerifierFailures.length === 0 &&
      contradictoryPassFailures.length === 0 &&
      /Host command evidence:[\s\S]*exit_code=0[\s\S]*(?:smoke\s+passed|user-flow\s+smoke\s+passed)[\s\S]*(?:user-flow|rendered\s+DOM|DOM\s+renders|localStorage|recompute|1-5\s+input)/i.test(
        verifierRoleText,
      );
    if (
      isVerifierEvidenceGapClosure &&
      status === "pass" &&
      verifierHostFeedbackStatus === "pass" &&
      !hasConcreteHostFailure
    ) {
      return null;
    }
    if (boundedRepairTargetClosed) return null;
    if (passingHostUserFacingSmokeEvidence && !hasRequestedFeatureEvidenceGap) return null;
    if (effectiveStatus !== "fail" && effectiveStatus !== "blocked" && !hasContradictoryPass) return null;
    const verification = SummarizeQualityVerificationEvidence(verificationText, 360);
    const hostFailureRepairItem =
      hasConcreteHostFailure
        ? BuildHostCommandFailureRepairItem(
          {
            requiresRework: true,
            roleLabel: "verifier",
            summary: "",
            evidence: [],
            resolutionTarget: "implementation",
          },
          verifierRoleText,
        )
        : null;
    const parts = [
      missingGeneratedWebSmokeSupport
        ? "Verifier could not prove the required user-flow because the generated web artifact has no runnable smoke/test support; add the smallest artifact-local smoke script instead of retrying the same verifier check."
        : insufficientGeneratedWebSmokeCoverage
          ? "Verifier host smoke passed, but the generated smoke does not prove rendered DOM/user-flow/localStorage behavior; add the smallest artifact-local user-flow smoke coverage instead of rerunning the same verifier check."
        : hasRequestedFeatureEvidenceGap
          ? "Verifier marked the work as pass without evidence for explicit requested user-facing features; add the missing feature support or artifact-local smoke coverage before approving."
        : concreteVerifierFailures.length > 0
        ? "Verifier found concrete requirement mismatches that need implementation repair."
        :
      contradictoryPassFailures.length > 0 || risks.length > 0
        ? "Verifier marked the work as pass while still listing failed or unresolved checks."
        : hasGenericPassEvidenceGap || hasUserFacingEvidenceGap || hasDecisionConstraintEvidenceGap
          ? "Verifier marked the work as pass without the required concrete user-facing evidence."
        : environmentOnlyHostBlocked
          ? "Verifier was blocked by a local verification-command issue and should rerun with a safer existing command."
        : effectiveStatus === "fail"
          ? "Verifier reported failed checks."
          : "Verifier reported blocked checks.",
      verification !== "" ? `Evidence: ${verification}` : "",
      contradictoryPassFailures.length > 0
        ? `Contradictory pass evidence: ${contradictoryPassFailures.join(" | ")}`
        : "",
      concreteVerifierFailures.length > 0
        ? `Verifier findings: ${concreteVerifierFailures.join(" | ")}`
        : "",
      risks.length > 0 ? `Open risks: ${risks.join(" | ")}` : "",
    ].filter((part) => part !== "");
    return {
      requiresRework: true,
      roleLabel: "verifier",
      summary: parts.join(" "),
      evidence: [
        stepCommand !== "" ? `quality_step=${stepCommand}` : "",
        exitCode != null ? `exit_code=${String(exitCode)}` : "",
        verifierHostFeedbackStatus != null ? `host_feedback_status=${verifierHostFeedbackStatus}` : "",
        hostFailureRepairItem != null ? `host_failure=${hostFailureRepairItem}` : "",
        verification !== "" ? `verification=${verification}` : "",
        contradictoryPassFailures.length > 0
          ? `verifier_pass_conflicts=${contradictoryPassFailures.join(" | ")}`
          : "",
        concreteVerifierFailures.length > 0
          ? `verifier_findings=${concreteVerifierFailures.join(" | ")}`
          : "",
        missingGeneratedWebSmokeSupport
          ? "verifier_artifact_gap=missing generated web user-flow smoke script or test file"
          : insufficientGeneratedWebSmokeCoverage
            ? "verifier_artifact_gap=existing generated web smoke lacks rendered DOM/user-flow/localStorage evidence"
            : hasRequestedFeatureEvidenceGap
              ? `verifier_artifact_gap=missing requested feature evidence: ${missingRequestedFeatureEvidence.join(" | ")}`
          : "",
        hasDecisionConstraintEvidenceGap
          ? "verifier_pass_gap=missing negative/adversarial decision-flow evidence"
          : hasGenericPassEvidenceGap || hasUserFacingEvidenceGap
            ? "verifier_pass_gap=missing concrete user-facing evidence"
            : "",
        risks.length > 0 ? `open_risks=${risks.join(" | ")}` : "",
      ].filter((part) => part !== ""),
      resolutionTarget: evidenceGapOnly ? "verifier" : "implementation",
    };
  }
  const verificationText = ExtractTaggedBlockText(text, "Verification") || text;
  const implementationPlanOnlySignal = BuildImplementationPlanOnlySignal(
    officeRole,
    stepCommand,
    text,
  );
  if (implementationPlanOnlySignal != null) return implementationPlanOnlySignal;
  if (
    officeRole !== "reviewer" &&
    officeRole !== "verifier" &&
    (
      hostFeedbackStatus === "blocked" ||
      (
        hostFeedbackStatus !== "pass" &&
        /Host command evidence:/i.test(verificationText) &&
        /\bexit_code=(?!0\b)\d+\b/i.test(verificationText)
      )
    )
  ) {
    const evidence = SummarizeQualityVerificationEvidence(verificationText, 360);
    const environmentOnly = IsEnvironmentOnlyHostFeedbackText(text);
    const hostFailureRepairItem = BuildHostCommandFailureRepairItem(
      {
        requiresRework: true,
        roleLabel: officeRole,
        summary: "",
        evidence: [],
        resolutionTarget: environmentOnly ? "verifier" : "implementation",
      },
      verificationText,
    );
    return {
      requiresRework: true,
      roleLabel: officeRole,
      summary: environmentOnly
        ? "Host-command evidence is blocked by local tool availability; rerun verification with an existing dependency-free command instead of repairing implementation."
        : "Host-command-backed verification evidence shows the implementation is not ready yet.",
      evidence: [
        stepCommand !== "" ? `quality_step=${stepCommand}` : "",
        exitCode != null ? `exit_code=${String(exitCode)}` : "",
        hostFeedbackStatus != null ? `host_feedback_status=${hostFeedbackStatus}` : "",
        evidence !== "" ? `verification=${evidence}` : "",
        hostFailureRepairItem != null ? `host_failure=${hostFailureRepairItem}` : "",
      ].filter((part) => part !== ""),
      resolutionTarget: environmentOnly ? "verifier" : "implementation",
    };
  }
  const implementationTimeoutSignal = BuildImplementationTimeoutSignal(
    officeRole,
    stepCommand,
    text,
  );
  if (implementationTimeoutSignal != null) return implementationTimeoutSignal;
  const missingExplicitRequestedArtifactFilesSignal = BuildMissingExplicitRequestedArtifactFilesSignal(
    officeRole,
    stepCommand,
    text,
    input.changedFiles ?? [],
  );
  if (missingExplicitRequestedArtifactFilesSignal != null) {
    return missingExplicitRequestedArtifactFilesSignal;
  }
  const generatedWebShapeSignal = BuildGeneratedWebArtifactShapeSignal(
    officeRole,
    stepCommand,
    text,
    input.changedFiles ?? [],
  );
  const missingRunnableWebScaffoldFilesSignal = BuildMissingRunnableWebScaffoldFilesSignal(
    officeRole,
    stepCommand,
    text,
  );
  const incompleteRunnableWebScaffoldContractSignal = BuildIncompleteRunnableWebScaffoldContractSignal(
    officeRole,
    stepCommand,
    text,
    input.changedFiles ?? [],
  );
  if (missingRunnableWebScaffoldFilesSignal != null) return missingRunnableWebScaffoldFilesSignal;
  if (incompleteRunnableWebScaffoldContractSignal != null) return incompleteRunnableWebScaffoldContractSignal;
  if (generatedWebShapeSignal != null) return generatedWebShapeSignal;
  const missingReportedArtifactFilesSignal = BuildMissingReportedArtifactFilesSignal(
    officeRole,
    stepCommand,
    text,
  );
  if (missingReportedArtifactFilesSignal != null) return missingReportedArtifactFilesSignal;
  const missingConcreteArtifactFilesSignal = BuildMissingConcreteArtifactFilesSignal(
    officeRole,
    stepCommand,
    text,
    input.changedFiles ?? [],
  );
  if (missingConcreteArtifactFilesSignal != null) return missingConcreteArtifactFilesSignal;
  return null;
}

function InferQualityReworkTargets(
  registry: AgentRegistry,
  assignmentContext: string,
  preferredTargets: string[],
): string[] {
  const effectiveAssignmentContext =
    ExtractPrimaryImplementationContext(assignmentContext) || StripSequencerSignals(assignmentContext);
  const normalizedTargets = preferredTargets
    .map((value) => String(value ?? "").trim().toLowerCase())
    .filter((value) => value !== "")
    .filter((value) => {
      try {
        return IsImplementationAgentId(registry, value);
      } catch {
        return false;
      }
    });
  if (normalizedTargets.length > 0) return [...new Set(normalizedTargets)];

  const preferredRoles = ResolveImplementationOwnerRoles(effectiveAssignmentContext);
  const preferredTargetsByRole = preferredRoles
    .map((role) => ResolvePreferredImplementationAgentId(registry, role))
    .filter((value): value is string => value != null && value.trim() !== "");
  if (preferredTargetsByRole.length > 0) {
    return [...new Set(preferredTargetsByRole)];
  }
  const developerId = ResolvePreferredImplementationAgentId(registry, "developer");
  const designerId = ResolvePreferredImplementationAgentId(registry, "designer");
  const devopsId = ResolvePreferredImplementationAgentId(registry, "devops");
  const frontendId = ResolvePreferredImplementationAgentId(registry, "frontend");
  const backendId = ResolvePreferredImplementationAgentId(registry, "backend");
  if (LooksLikeDesignImplementationContext(effectiveAssignmentContext) && designerId != null) {
    return [designerId];
  }
  if (LooksLikeDevopsImplementationContext(effectiveAssignmentContext) && devopsId != null) {
    return [devopsId];
  }
  if (LooksLikeFrontendImplementationContext(effectiveAssignmentContext)) {
    return frontendId != null ? [frontendId] : developerId != null ? [developerId] : [];
  }
  if (LooksLikeBackendImplementationContext(effectiveAssignmentContext)) {
    return backendId != null ? [backendId] : developerId != null ? [developerId] : [];
  }
  if (developerId != null) return [developerId];
  if (backendId != null) return [backendId];
  if (frontendId != null) return [frontendId];
  if (designerId != null) return [designerId];
  if (devopsId != null) return [devopsId];
  return [];
}

function IsQualityRepairSuppressedByAssignment(assignmentContext: string): boolean {
  const text = String(assignmentContext ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  const isExplicitQualityOnly =
    /(?:\breview[-\s]?only\b|\bverification[-\s]?only\b|\baudit[-\s]?only\b|\binspect[-\s]?only\b|\bread[-\s]?only\b|검수만|검토만|확인만|검증만|읽기\s*전용)/i.test(
      text,
    );
  const isExplicitRepairSuppression =
    /(?:\bno\s+repair\b|\bdo\s+not\s+repair\b|\bwithout\s+repair\b|repair\s*(?:는|은|을|를)?\s*하지|자동\s*수리\s*금지|수리\s*하지)/i.test(
      text,
    );
  return isExplicitQualityOnly || isExplicitRepairSuppression;
}

function ExtractFirstFailedHostCommand(text: string): string {
  const match = (text ?? "").match(/(?:^|\n)\s*\d+\.\s+(.+?)\s+\|\s+exit_code=(?!0\b)\d+\b/i);
  return match?.[1]?.trim() ?? "";
}

function ExtractInlineThrownErrorMessage(line: string): string {
  const match = String(line ?? "").match(/\bthrow\s+new\s+Error\(\s*["'`]([^"'`]+)["'`]\s*\)/i);
  const message = match?.[1]?.trim() ?? "";
  return message !== "" ? `Error: ${message}` : "";
}

function ExtractHostFailureLine(text: string): string {
  const lines = (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^\.\.\. \[truncated\] \.\.\.$/.test(line));
  for (const line of lines) {
    const thrownMessage = ExtractInlineThrownErrorMessage(line);
    if (thrownMessage !== "") return thrownMessage;
  }
  const explicitRuntimeError = lines.find((line) =>
    /\b(?:ReferenceError|TypeError|SyntaxError|AssertionError|Error):\s+/i.test(line) &&
    !/\bError:\s+Command failed:/i.test(line),
  );
  if (explicitRuntimeError != null) return explicitRuntimeError;
  const strongFailure = lines.find((line) =>
    /\b(?:ReferenceError|TypeError|SyntaxError|AssertionError|Error|failed|failure|cannot|missing|not found|timeout|panic|exception)\b/i.test(
      line,
    ),
  );
  if (strongFailure != null) return strongFailure;
  return lines[lines.length - 1] ?? "";
}

function ExtractMissingRunnableScaffoldFileFromHostFailure(text: string): string {
  const value = String(text ?? "");
  const quotedFileMatch = value.match(/(?:error\s+TS6053:\s*)?File\s+['"`]([^'"`]+)['"`]\s+not\s+found/i);
  const noSuchFileMatch = value.match(/(?:no\s+such\s+file\s+or\s+directory|ENOENT)[^\n]*['"`]?([^'"`\s]+(?:package\.json|tsconfig(?:\.node)?\.json|vite\.config\.(?:ts|js)|index\.html))['"`]?/i);
  const raw = quotedFileMatch?.[1] ?? noSuchFileMatch?.[1] ?? "";
  if (raw === "") return "";
  const normalized = NormalizeGeneratedArtifactPath(raw);
  if (normalized === "") return "";
  const basename = normalized.split("/").pop() ?? normalized;
  if (IsRunnableWebScaffoldFile(basename)) return basename;
  return IsRunnableWebScaffoldFile(normalized) ? normalized : "";
}

function IsMissingReactTypeDeclarationHostFailure(text: string): boolean {
  return /Could not find a declaration file for module ['"](?:react|react-dom\/client|react\/jsx-runtime)['"]|JSX element implicitly has type 'any' because no interface 'JSX\.IntrinsicElements' exists/i.test(
    text,
  );
}

function IsViteEsbuildAuditHostFailure(text: string): boolean {
  return /(?:npm audit report|(?:moderate|high|critical)\s+severity\s+vulnerabilit(?:y|ies)|Severity:\s*(?:moderate|high|critical)|esbuild\s+<=0\.24\.2|vite\s+<=6\.4\.1)/i.test(
    text,
  );
}

function IsPackagePeerDependencyConflictHostFailure(text: string): boolean {
  return /(?:npm\s+ERR!\s+)?ERESOLVE[\s\S]{0,400}(?:unable to resolve dependency tree|Could not resolve dependency)|peer\s+\S+@["'][^"']+["']\s+from\s+\S+@/i.test(
    text,
  );
}

function IsMissingGeneratedWebTestRunnerHostFailure(text: string): boolean {
  return /(?:ERR_MODULE_NOT_FOUND|Cannot\s+find\s+(?:package|module))[\s\S]{0,500}(?:@playwright\/test|vitest|jsdom|@testing-library\/react)|(?:@playwright\/test|vitest|jsdom|@testing-library\/react)[\s\S]{0,240}(?:ERR_MODULE_NOT_FOUND|Cannot\s+find\s+(?:package|module))/i.test(
    text,
  );
}

function BuildHostCommandFailureRepairItem(signal: QualityGateSignal, evidenceText: string): string | null {
  const hasHostEvidence = /Host command evidence:/i.test(evidenceText);
  const hasFailedCommand = /\bexit_code=(?!0\b)\d+\b/i.test(evidenceText);
  const hasAuditFailure =
    hasHostEvidence &&
    (
      IsViteEsbuildAuditHostFailure(evidenceText) ||
      IsPackagePeerDependencyConflictHostFailure(evidenceText)
    );
  if (
    !hasHostEvidence ||
    (!hasFailedCommand && !hasAuditFailure)
  ) {
    return null;
  }
  const command = ExtractFirstFailedHostCommand(evidenceText);
  const failureLine = ExtractHostFailureLine(evidenceText);
  if (IsViteEsbuildAuditHostFailure(evidenceText)) {
    return `${signal.roleLabel}: package audit found vulnerable or stale Vite/esbuild scaffold dependencies. Edit package.json only: keep react/react-dom in dependencies, move build/type tooling to devDependencies, add "type": "module", bump vite to a current non-vulnerable stable major (Vite 8+ when compatible) and @vitejs/plugin-react to its compatible current major, then rerun npm install, npm audit --audit-level=moderate, and npm run build; do not rewrite app UI, data, scoring, or unrelated files.`;
  }
  if (IsPackagePeerDependencyConflictHostFailure(evidenceText)) {
    return `${signal.roleLabel}: package install failed because package.json has incompatible dependency peer ranges. Edit package.json only: keep react/react-dom in dependencies, keep Vite/TypeScript/build tooling in devDependencies, align vite and @vitejs/plugin-react to compatible current stable majors, then rerun npm install, npm audit --audit-level=moderate, and npm run build; do not use --force/--legacy-peer-deps and do not rewrite app UI, data, scoring, or unrelated files.`;
  }
  if (IsMissingGeneratedWebTestRunnerHostFailure(evidenceText)) {
    return `${signal.roleLabel}: generated smoke/test harness imports a test runner that is not installed. failing_command=${command !== "" ? command : "the failed smoke/test command"} ; failure=${failureLine !== "" ? failureLine : "missing generated web test runner package"}. Edit package.json and artifact-local smoke/test files only: either add the missing test runner to devDependencies or replace the smoke script with a dependency-free check, then rerun npm install, npm run build, and ${command !== "" ? command : "the failed smoke/test command"}; do not rewrite app UI, data, scoring, or unrelated files.`;
  }
  const missingScaffoldFile = ExtractMissingRunnableScaffoldFileFromHostFailure(evidenceText);
  if (missingScaffoldFile !== "") {
    return `${signal.roleLabel}: Missing runnable scaffold file: ${missingScaffoldFile}. Create only this missing file or remove the stale reference before rerunning ${command !== "" ? command : "the failed host command"}; do not only rerun the command.`;
  }
  if (/TS5107[\s\S]*moduleResolution[\s\S]*(?:node10|node)[\s\S]*deprecated/i.test(evidenceText)) {
    return `${signal.roleLabel}: TypeScript build config failed in tsconfig.json: moduleResolution node/node10 is deprecated under the current TypeScript version. Edit tsconfig.json only, changing compilerOptions.moduleResolution to "bundler" or adding an explicit ignoreDeprecations setting, then rerun ${command !== "" ? command : "npm run build"}; do not claim this is only missing host evidence.`;
  }
  if (IsMissingReactTypeDeclarationHostFailure(evidenceText)) {
    return `${signal.roleLabel}: React/JSX type declarations are missing for the generated Vite/React TypeScript artifact. Edit package.json only, adding devDependencies @types/react and @types/react-dom that match the React major version, then rerun ${command !== "" ? command : "npm run build"}; do not rewrite app UI, data, scoring, or unrelated files.`;
  }
  const compactEvidence = SummarizeForTaskComplete(evidenceText, 700);
  const parts = [
    command !== "" ? `failing_command=${command}` : "",
    failureLine !== "" ? `failure=${failureLine}` : "",
    compactEvidence !== "" ? `evidence=${compactEvidence}` : "",
  ].filter((part) => part !== "");
  return `${signal.roleLabel}: Host command failed. First make this exact host command pass before touching unrelated behavior. ${parts.join(" ; ")}. If the failing line comes from a smoke/test assertion, satisfy that assertion through product code or narrow only the overbroad assertion while preserving equivalent coverage for the original requirement; do not delete the check or switch to another repair target.`;
}

function SummarizeQualityVerificationEvidence(text: string, maxLen: number): string {
  const compact = SummarizeForTaskComplete(text, maxLen);
  if (!/Host command evidence:/i.test(text) || !/\bexit_code=(?!0\b)\d+\b/i.test(text)) {
    return compact;
  }
  const command = ExtractFirstFailedHostCommand(text);
  const failureLine = ExtractHostFailureLine(text);
  const keyFailure = [
    command !== "" ? `Key failing command: ${command}` : "",
    failureLine !== "" ? `Key failure: ${failureLine}` : "",
  ].filter((part) => part !== "").join("\n");
  if (keyFailure === "" || compact.includes(failureLine)) return compact;
  return SummarizeForTaskComplete(`${keyFailure}\n${text}`, Math.max(700, maxLen));
}

function ExtractQualityRepairItems(signal: QualityGateSignal): string[] {
  const items: string[] = [];
  const hasVerifierPassGap = signal.evidence.some((item) =>
    /^verifier_pass_gap=/i.test(String(item ?? "").trim()),
  );
  const providerOutputEvidence = signal.evidence
    .map((item) => String(item ?? "").trim())
    .find((item) => /^provider_output=/i.test(item)) ?? "";
  if (/Generated web artifact is incomplete|Generated artifact has no reported files|Generated artifact reported files that are missing|Generated web scaffold is not runnable yet|Generated artifact missed explicitly requested file paths|Implementation output only described a plan or inspection|Implementation timed out/i.test(signal.summary)) {
    items.push(`${signal.roleLabel}: ${signal.summary}`);
  }
  for (const evidence of signal.evidence) {
    const raw = String(evidence ?? "").trim();
    const generatedFilesMatch = raw.match(/^files_created=([\s\S]+)$/i);
    if (generatedFilesMatch?.[1] != null) {
      const filesEvidence = generatedFilesMatch[1].trim();
      const noFilesGuidance =
        /\bnone\b/i.test(filesEvidence)
          ? ". Create the smallest concrete assigned slice and report exact workspace-relative paths in [FilesCreated]; do not return another plan-only reply."
          : "";
      items.push(`${signal.roleLabel}: reported artifact files: ${filesEvidence}${noFilesGuidance}`);
      continue;
    }
    const expectedShapeMatch = raw.match(/^expected_shape=([\s\S]+)$/i);
    if (expectedShapeMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: expected artifact shape: ${expectedShapeMatch[1]}`);
      continue;
    }
    const missingReportedFilesMatch = raw.match(/^missing_reported_files=([\s\S]+)$/i);
    if (missingReportedFilesMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: missing reported artifact files: ${missingReportedFilesMatch[1]}. Create or correct only these reported paths first; do not rewrite unrelated artifact files.`);
      continue;
    }
    const missingRequestedFilesMatch = raw.match(/^missing_requested_files=([\s\S]+)$/i);
    if (missingRequestedFilesMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: missing explicitly requested artifact files: ${missingRequestedFilesMatch[1]}. Create or report only these user-named paths first; do not rewrite unrelated artifact files.`);
      continue;
    }
    const missingScaffoldFilesMatch = raw.match(/^missing_required_scaffold_files=([\s\S]+)$/i);
    if (missingScaffoldFilesMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: missing runnable scaffold files: ${missingScaffoldFilesMatch[1]}. ${providerOutputEvidence !== "" ? `${providerOutputEvidence}. ` : ""}Create only these missing scaffold files before adding UI polish or unrelated features.`);
      continue;
    }
    const expectedScaffoldMatch = raw.match(/^expected_scaffold=([\s\S]+)$/i);
    if (expectedScaffoldMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: expected runnable scaffold: ${expectedScaffoldMatch[1]}`);
      continue;
    }
    const implementationFormatMatch = raw.match(/^implementation_format=([\s\S]+)$/i);
    if (implementationFormatMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: implementation format issue: ${implementationFormatMatch[1]}. Return concrete file changes or an explicit blocker only; do not emit [SEQUENCER_PLAN] from an implementation repair.`);
      continue;
    }
    const implementationTimeoutMatch = raw.match(/^implementation_timeout=([\s\S]+)$/i);
    if (implementationTimeoutMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: implementation timeout reason: ${implementationTimeoutMatch[1]}`);
      continue;
    }
    const providerOutputMatch = raw.match(/^provider_output=([\s\S]+)$/i);
    if (providerOutputMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: provider_output=${providerOutputMatch[1]}. Treat this as no implementation result even if the CLI exit code is 0; create the smallest concrete assigned slice and report exact paths in [FilesCreated].`);
      continue;
    }
    const hostFailureMatch = raw.match(/^host_failure=([\s\S]+)$/i);
    if (hostFailureMatch?.[1] != null) {
      items.push(hostFailureMatch[1]);
      continue;
    }
    const verifierPassGapMatch = raw.match(/^verifier_pass_gap=([\s\S]+)$/i);
    if (verifierPassGapMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: ${verifierPassGapMatch[1]}`);
      continue;
    }
    const verifierArtifactGapMatch = raw.match(/^verifier_artifact_gap=([\s\S]+)$/i);
    if (verifierArtifactGapMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: ${verifierArtifactGapMatch[1]}. Add only the smallest artifact-local smoke/test support needed to prove the user flow, such as a package script plus one test or smoke file; do not rewrite domain logic unless the test exposes a real defect.`);
      continue;
    }
    const verifierPassConflictsMatch = raw.match(/^verifier_pass_conflicts=([\s\S]+)$/i);
    if (verifierPassConflictsMatch?.[1] != null) {
      items.push(`${signal.roleLabel}: Contradictory pass evidence: ${verifierPassConflictsMatch[1]}`);
      continue;
    }
    const match = raw.match(/^(review_findings|open_risks|verification)=([\s\S]+)$/i);
    if (match?.[2] == null) continue;
    if (match[1]?.toLowerCase() === "verification") {
      const hostFailureItem = BuildHostCommandFailureRepairItem(signal, match[2]);
      if (hostFailureItem != null) {
        items.push(hostFailureItem);
        continue;
      }
      if (hasVerifierPassGap) continue;
    }
    for (const part of match[2].split(/\s+\|\s+/)) {
      const item = part.trim();
      if (item !== "") items.push(`${signal.roleLabel}: ${item}`);
    }
  }
  if (items.length > 0) return [...new Set(items)];
  return [`${signal.roleLabel}: ${signal.summary}`];
}

function BuildBoundedQualityRepairSlice(parsedSignals: QualityGateSignal[]): {
  details: string;
  deferredCount: number;
} {
  const items = [...new Set(parsedSignals.flatMap((signal) => ExtractQualityRepairItems(signal)))];
  const maxRepairItems = 2;
  const hostFailures = items.filter((item) =>
    /\bHost command failed\b|failing_command=|failure=/i.test(item),
  );
  const actionable = items.filter((item) => IsActionableQualityRepairItem(item));
  const affirmative = items.filter((item) => IsAffirmativeQualityRepairItem(item));
  const neutral = items.filter((item) =>
    !hostFailures.includes(item) &&
    !actionable.includes(item) &&
    !affirmative.includes(item),
  );
  const actionableWithoutHostFailures = actionable.filter((item) => !hostFailures.includes(item));
  const prioritizedPool =
    hostFailures.length > 0
      ? [...hostFailures, ...actionableWithoutHostFailures, ...neutral]
      : actionable.length > 0
        ? [...actionable, ...neutral]
        : [...neutral, ...affirmative];
  const selected = (prioritizedPool.length > 0 ? prioritizedPool : items).slice(0, maxRepairItems);
  const details = selected
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n");
  return {
    details: details !== "" ? details : "1. Apply the smallest corrective change needed for the first reported quality failure.",
    deferredCount: Math.max(0, items.length - selected.length),
  };
}

function HasImplementationTimeoutSignal(parsedSignals: QualityGateSignal[]): boolean {
  return parsedSignals.some(
    (signal) =>
      /Implementation timed out before producing verifiable artifact progress/i.test(signal.summary) ||
      signal.evidence.some((item) => /^implementation_timeout=/i.test(String(item ?? "").trim())),
  );
}

function ExtractQualityStepFromSignals(parsedSignals: QualityGateSignal[]): string {
  for (const signal of parsedSignals) {
    for (const item of signal.evidence) {
      const match = String(item ?? "").trim().match(/^quality_step=(.+)$/i);
      if (match?.[1] != null && match[1].trim() !== "") return match[1].trim();
    }
  }
  return "";
}

function BuildQualityReworkAgentMessage(
  officeRole: AgentRole,
  signal: QualityGateSignal,
): string {
  if (/Implementation timed out before producing verifiable artifact progress/i.test(signal.summary)) {
    return "구현 timeout으로 더 작은 재계획 루프로 전환";
  }
  if (
    /Generated web artifact is incomplete|Generated artifact has no reported files|Generated artifact reported files that are missing|Generated web scaffold is not runnable yet|Generated artifact missed explicitly requested file paths/i.test(
      signal.summary,
    )
  ) {
    return "산출물 근거가 부족해 재작업 루프로 전환";
  }
  return officeRole === "reviewer"
    ? "리뷰 결과 재작업 루프로 전환"
    : officeRole === "verifier"
      ? "검증 결과 재작업 루프로 전환"
      : "호스트 검증 근거상 재작업 루프로 전환";
}

function BuildTimeoutSafeRepairBudgetBlock(parsedSignals: QualityGateSignal[]): string {
  if (!HasImplementationTimeoutSignal(parsedSignals)) return "";
  return [
    "Timeout-safe repair budget:",
    "- Create the smallest verifiable artifact slice first: entry point, core interaction/data path, and the required negative guard when the request has one.",
    "- Limit this retry to at most 3 created/changed source files unless an existing manifest or package file must be updated for the artifact to run.",
    "- Defer polish, large datasets, secondary screens, and non-critical extras to the next review/verifier loop instead of broadening this retry.",
    "- Report concrete files in [FilesCreated]; if even this slice is too large, report the blocker instead of starting another broad rewrite.",
  ].join("\n");
}

function ExtractArtifactPathsFromText(text: string): string[] {
  const matches = String(text ?? "").match(
    /\b(?:tmp\/verification\/smoke-verification\/[^\s)\]]+|artifacts\/[^\s)\]]+|coverage\/[^\s)\]]+|playwright-report\/[^\s)\]]+|test-results\/[^\s)\]]+|reports?\/[^\s)\]]+\.(?:json|xml|html|log|txt)|[^\s)\]]+\.(?:json|xml|html|log|lcov|trx|sarif))\b/gi,
  );
  return [...new Set((matches ?? []).map((value) => String(value).trim()).filter((value) => value !== ""))];
}

function ExtractArtifactPaths(paths: string[] | undefined): string[] {
  return [...new Set((paths ?? []).filter((value) => {
    const text = String(value ?? "").trim().toLowerCase();
    if (text === "") return false;
    return (
      text.includes("/tmp/verification/smoke-verification/") ||
      text.startsWith("tmp/verification/smoke-verification/") ||
      text.includes("/artifacts/") ||
      text.startsWith("artifacts/") ||
      text.includes("/coverage/") ||
      text.startsWith("coverage/") ||
      text.includes("/playwright-report/") ||
      text.startsWith("playwright-report/") ||
      text.includes("/test-results/") ||
      text.startsWith("test-results/") ||
      text.includes("/reports/") ||
      text.startsWith("reports/") ||
      text.endsWith(".json") ||
      text.endsWith(".xml") ||
      text.endsWith(".html") ||
      text.endsWith(".log") ||
      text.endsWith(".lcov") ||
      text.endsWith(".trx") ||
      text.endsWith(".sarif")
    );
  }))];
}

function NormalizeNestedCommands(
  commands: CascadeWorkflowCommand[],
  registry?: AgentRegistry,
): CascadePendingCommand[] {
  const knownAgents = new Set(
    commands.map((command) => String(command.agentId ?? "").trim().toLowerCase()).filter((value) => value !== ""),
  );
  const normalized: CascadeWorkflowCommand[] = commands.map((command) => {
    const dependsOn = [...new Set((command.dependsOn ?? [])
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter((value) => value !== "" && knownAgents.has(value)))];
    const normalizedCommand =
      registry != null ? BuildDirectStepSeed(command.command) : String(command.command ?? "").trim();
    return {
      ...command,
      command: normalizedCommand,
      dependsOn,
      originAssignmentContext: ResolveOriginAssignmentContext(
        command.originAssignmentContext,
        command.command,
      ),
    };
  });
  const seen = new Set<string>();
  const deduped = normalized.filter((command) => {
    const agentId = String(command.agentId ?? "").trim().toLowerCase();
    const commandText = StripSequencerSignals(command.command).replace(/\s+/g, " ").trim().toLowerCase();
    const dependencies = [...command.dependsOn].sort().join(",");
    const key = `${agentId}\0${commandText}\0${dependencies}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const commandCounts = new Map<string, number>();
  const pending = deduped.map((command) => {
    const agentId = String(command.agentId ?? "").trim().toLowerCase();
    const nextCount = (commandCounts.get(agentId) ?? 0) + 1;
    commandCounts.set(agentId, nextCount);
    return {
      ...command,
      agentId,
      commandKey: `${agentId}#${nextCount}`,
      dependencyKeys: [] as string[],
    };
  });
  const commandKeysByAgent = new Map<string, string[]>();
  for (const command of pending) {
    const existing = commandKeysByAgent.get(command.agentId) ?? [];
    existing.push(command.commandKey);
    commandKeysByAgent.set(command.agentId, existing);
  }
  const previousCommandKeyByAgent = new Map<string, string>();
  for (const command of pending) {
    const resolved = new Set<string>();
    const previousOwnCommandKey = previousCommandKeyByAgent.get(command.agentId) ?? null;
    if (previousOwnCommandKey != null) {
      resolved.add(previousOwnCommandKey);
    }
    for (const dependencyAgentId of command.dependsOn) {
      if (dependencyAgentId === command.agentId) {
        if (previousOwnCommandKey != null) {
          resolved.add(previousOwnCommandKey);
        } else {
          resolved.add(command.commandKey);
        }
        continue;
      }
      const dependencyCommandKey =
        previousCommandKeyByAgent.get(dependencyAgentId) ??
        (commandKeysByAgent.get(dependencyAgentId) ?? []).find((key) => key !== command.commandKey);
      if (dependencyCommandKey != null) {
        resolved.add(dependencyCommandKey);
      }
    }
    command.dependencyKeys = [...resolved];
    previousCommandKeyByAgent.set(command.agentId, command.commandKey);
  }
  if (registry != null) {
    const priorImplementationCommandKeys: string[] = [];
    for (const command of pending) {
      if (IsQualityAgentId(registry, command.agentId)) {
        command.dependencyKeys = [...new Set([...command.dependencyKeys, ...priorImplementationCommandKeys])];
      }
      if (IsImplementationAgentId(registry, command.agentId)) {
        priorImplementationCommandKeys.push(command.commandKey);
      }
    }
  }
  return pending;
}

function LooksLikeConditionalPmReviewRepairCommand(text: string): boolean {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  if (value === "") return false;
  return (
    /\breviewer\b[^\n.]{0,120}\bfindings?\b/i.test(value) ||
    /\breview\b[^\n.]{0,120}\bready(?:-only)?\b/i.test(value) ||
    /\bblocking\s+issue(?:s)?\s+only\b/i.test(value) ||
    /\bif\s+the\s+review\s+is\s+ready\b/i.test(value) ||
    /(?:Reviewer\s*최신\s*findings|리뷰(?:어)?\s*최신\s*findings|리뷰가\s*ready(?:-only)?면|blocking\s*issue만)/i.test(
      value,
    )
  );
}

function SanitizePmWorkflowCommands(
  commands: CascadeWorkflowCommand[],
  registry: AgentRegistry,
): CascadeWorkflowCommand[] {
  const reviewerId = registry.FindAgentIdByOfficeRole("reviewer")?.trim().toLowerCase() ?? "";
  if (commands.length === 0) return commands;

  const droppedRepairAgentIds = new Set<string>();
  const keptWithIndex: Array<{ command: CascadeWorkflowCommand; index: number }> = [];

  commands.forEach((command, index) => {
    const agentId = String(command.agentId ?? "").trim().toLowerCase();
    const dependsOnReviewer = (command.dependsOn ?? []).some((value) => String(value ?? "").trim().toLowerCase() === reviewerId);
    const isImplementation = IsImplementationAgentId(registry, agentId);
    const isConditionalReviewRepair =
      isImplementation &&
      dependsOnReviewer &&
      LooksLikeConditionalPmReviewRepairCommand(command.command);
    if (isConditionalReviewRepair) {
      droppedRepairAgentIds.add(agentId);
      return;
    }
    keptWithIndex.push({ command, index });
  });

  const sanitizedWithoutConditionalRepair =
    droppedRepairAgentIds.size === 0
      ? commands
      : (() => {
          const reviewerIndex = keptWithIndex.find((item) =>
            String(item.command.agentId ?? "").trim().toLowerCase() === reviewerId
          )?.index;
          if (reviewerIndex == null) return keptWithIndex.map((item) => item.command);

          return keptWithIndex.map(({ command, index }) => {
            if (index <= reviewerIndex) {
              return command;
            }
            const dependsOn = [...(command.dependsOn ?? [])];
            const touchesDroppedRepairAgent = dependsOn.some((value) =>
              droppedRepairAgentIds.has(String(value ?? "").trim().toLowerCase())
            );
            if (!touchesDroppedRepairAgent) return command;
            const normalizedReviewerDependsOn = dependsOn.map((value) => String(value ?? "").trim().toLowerCase());
            if (!normalizedReviewerDependsOn.includes(reviewerId)) {
              dependsOn.push(reviewerId);
            }
            return {
              ...command,
              dependsOn,
            };
          });
        })();
  const verifierId = registry.FindAgentIdByOfficeRole("verifier")?.trim().toLowerCase() ?? "";
  const hasReviewerCommand =
    reviewerId !== "" &&
    sanitizedWithoutConditionalRepair.some((command) =>
      String(command.agentId ?? "").trim().toLowerCase() === reviewerId
    );
  const reviewSequencedCommands =
    verifierId === "" || !hasReviewerCommand
      ? sanitizedWithoutConditionalRepair
      : sanitizedWithoutConditionalRepair.map((command) => {
          const agentId = String(command.agentId ?? "").trim().toLowerCase();
          if (agentId !== verifierId) return command;
          const dependsOn = [...(command.dependsOn ?? [])];
          const normalizedDependsOn = dependsOn.map((value) => String(value ?? "").trim().toLowerCase());
          if (!normalizedDependsOn.includes(reviewerId)) {
            dependsOn.push(reviewerId);
          }
          return {
            ...command,
            dependsOn,
          };
        });
  return SplitDensePmInteractiveImplementationCommands(reviewSequencedCommands, registry);
}

function CountDistinctDenseSliceSignals(text: string, patterns: RegExp[]): number {
  let count = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) count += 1;
  }
  return count;
}

function LooksLikeDensePmInteractiveImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const agentId = String(command.agentId ?? "").trim().toLowerCase();
  if (!IsImplementationAgentId(registry, agentId)) return false;
  const officeRole = registry.MapAgentIdToOfficeRole(agentId);
  if (officeRole !== "frontend" && officeRole !== "developer") return false;
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (officeRole !== "frontend" && !LooksLikeFrontendWork(text)) return false;

  const liveInputSignals = CountDistinctDenseSliceSignals(text, [
    /\bparty\b/i,
    /\battendees?\b/i,
    /\btime\b/i,
    /\bweight\b/i,
    /\bvolume\b/i,
    /\bturnover\b/i,
    /\brefrigerat(?:ed|ion)\b/i,
    /\bambient\b/i,
    /\bfragile\b/i,
    /\bincompat(?:ible|ibility)\b/i,
    /\boccupanc(?:y|ied)\b/i,
    /\bpick(?:ing)?\s+(?:distance|path)\b/i,
    /\bwarehouse\b/i,
    /\bslot(?:s)?\b/i,
    /\bbin(?:s)?\b/i,
    /\bshelf\b/i,
    /\blocation\b/i,
    /\bhighchair\b/i,
    /\bwheelchair\b/i,
    /\bwindow\b/i,
    /\bquiet\b/i,
    /\bzone\b/i,
    /\bindoor\b/i,
    /\boutdoor\b/i,
    /인원/,
    /시간/,
    /무게/,
    /부피/,
    /회전율/,
    /냉장/,
    /상온/,
    /깨지/,
    /같이\s*두면\s*안\s*되/,
    /점유/,
    /적치/,
    /위치/,
    /칸/,
    /구역/,
    /피킹\s*동선/,
    /유아의자/,
    /휠체어/,
    /창가/,
    /조용/,
    /실내/,
    /야외/,
  ]);
  const interactionSignals = CountDistinctDenseSliceSignals(text, [
    /\bsearch\b/i,
    /\bcard\s+click\b/i,
    /\bclick\b/i,
    /\bselected\b/i,
    /\bselection\b/i,
    /\bcurrent\s+(?:table|selection)\b/i,
    /\bfavorites?\b/i,
    /\blocalstorage\b/i,
    /검색/,
    /카드\s*클릭/,
    /선택/,
    /현재\s*선택/,
    /즐겨찾기/,
    /localstorage/i,
  ]);
  const mentionsImmediateRecompute =
    /\b(?:live\s+recompute|immediate(?:ly)?\s+recompute|refresh\s+without\s+reload|without\s+reload|single\s+state\s+flow)\b/i.test(
      text,
    ) ||
    /(?:즉시\s*재계산|새로고침\s*없이|하나의\s*상태\s*흐름|같은\s*상태\s*흐름)/i.test(text);
  const mentionsPersistence =
    /\blocalstorage\b/i.test(text) ||
    /즐겨찾기/.test(text);
  return liveInputSignals >= 4 && interactionSignals >= 3 && mentionsImmediateRecompute && mentionsPersistence;
}

function LooksLikeDensePmFoundationEngineImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const agentId = String(command.agentId ?? "").trim().toLowerCase();
  if (!IsImplementationAgentId(registry, agentId)) return false;
  const officeRole = registry.MapAgentIdToOfficeRole(agentId);
  if (officeRole !== "frontend" && officeRole !== "developer") return false;
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (officeRole !== "frontend" && !LooksLikeFrontendWork(text)) return false;

  const dataSignals = CountDistinctDenseSliceSignals(text, [
    /\bdataset\b/i,
    /\bsource-of-truth\b/i,
    /\breference data\b/i,
    /\bfixture(?:s)?\b/i,
    /\bwarehouse(?:\s+map)?\b/i,
    /\boccupanc(?:y|ied)\b/i,
    /\bzone(?:s)?\b/i,
    /\bbin(?:s)?\b/i,
    /\bshelf\b/i,
    /\blocation(?:s)?\b/i,
    /\bdomain model\b/i,
    /\bavailability\b/i,
    /\bslot(?:s)?\b/i,
    /\bsupport layer\b/i,
    /실제 데이터/,
    /창고\s*맵/,
    /점유/,
    /구역/,
    /위치/,
    /칸/,
    /도메인 모델/,
    /가용 슬롯/,
    /지원 레이어/,
    /픽스처/,
  ]);
  const engineSignals = CountDistinctDenseSliceSignals(text, [
    /\bfilter(?:ing)?\b/i,
    /\bscor(?:e|ing)\b/i,
    /\brecommend(?:ation|ations)?\b/i,
    /\btop\s*10\b/i,
    /\bno-match\b/i,
    /\bfallback\b/i,
    /\bunit test(?:s)?\b/i,
    /\btest(?:s)?\b/i,
    /필터/,
    /점수/,
    /추천/,
    /추천\s*10개/,
    /차선책/,
    /실패 사유/,
    /테스트/,
  ]);
  const ruleSignals = CountDistinctDenseSliceSignals(text, [
    /\bsold-out\b/i,
    /\ballerg(?:y|ies)\b/i,
    /\bbudget\b/i,
    /\bdistance\b/i,
    /\bweight\b/i,
    /\bvolume\b/i,
    /\bturnover\b/i,
    /\brefrigerat(?:ed|ion)\b/i,
    /\bambient\b/i,
    /\bfragile\b/i,
    /\bincompat(?:ible|ibility)\b/i,
    /\boccupanc(?:y|ied)\b/i,
    /\bwarehouse\b/i,
    /\bzone(?:s)?\b/i,
    /\bbin(?:s)?\b/i,
    /\bshelf\b/i,
    /\blocation(?:s)?\b/i,
    /\bpick(?:ing)?\s+(?:distance|path)\b/i,
    /\bdate\b/i,
    /\btime\b/i,
    /\bparty\b/i,
    /\bseat\b/i,
    /\bfull\s+slot(?:s)?\b/i,
    /만석/,
    /알레르기/,
    /예산/,
    /거리/,
    /무게/,
    /부피/,
    /회전율/,
    /냉장/,
    /상온/,
    /깨지/,
    /같이\s*두면\s*안\s*되/,
    /점유/,
    /구역/,
    /적치/,
    /위치/,
    /칸/,
    /피킹\s*동선/,
    /날짜/,
    /시간/,
    /인원/,
    /선호/,
  ]);
  const compactFoundationSignals = CountDistinctDenseSliceSignals(text, [
    /\blocal\b(?:\s+\w+){0,3}\s+data\b/i,
    /\btype(?:s)?\b/i,
    /\bpure\b/i,
    /\bcalculator\b/i,
    /\brecommend(?:ation|ations)?\b/i,
    /\bexclusion\b/i,
    /\bexclude\b/i,
    /\bfrontend-only\b/i,
    /로컬(?:\s*\S+){0,3}\s*데이터/,
    /타입/,
    /순수\s*계산기/,
    /추천/,
    /제외/,
  ]);
  const mentionsExclusionIntegrity =
    /\b(?:invalid|violating|ineligible)\s+(?:candidate|item|restaurant|option)s?\b.{0,80}\brecommend(?:ation|ed)?\b/i.test(text) ||
    /\bdo\s+not\s+let\b.{0,80}\brecommend/i.test(text) ||
    /조건\s*위반/.test(text) ||
    /추천\s*배열/.test(text) ||
    /추천\s*목록/.test(text);
  return (
    (dataSignals >= 2 && engineSignals >= 4 && ruleSignals >= 4) ||
    (
      compactFoundationSignals >= 4 &&
      ruleSignals >= 5 &&
      mentionsExclusionIntegrity
    )
  );
}

function LooksLikeDensePmStateRecomputeImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const agentId = String(command.agentId ?? "").trim().toLowerCase();
  if (!IsImplementationAgentId(registry, agentId)) return false;
  const officeRole = registry.MapAgentIdToOfficeRole(agentId);
  if (officeRole !== "frontend" && officeRole !== "developer") return false;
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (officeRole !== "frontend" && !LooksLikeFrontendWork(text)) return false;

  const stateSignals = CountDistinctDenseSliceSignals(text, [
    /\bstate\b/i,
    /\binput\s+state\b/i,
    /\bstore\b/i,
    /\bhook\b/i,
    /\bzustand\b/i,
    /\bselector\b/i,
    /\bsnapshot\b/i,
    /\bderived\b/i,
    /\brevision\b/i,
    /\bpatchinputs\b/i,
    /\bsetinput\b/i,
    /상태/,
    /입력\s*상태/,
    /스토어/,
    /훅/,
    /스냅샷/,
    /파생/,
  ]);
  const recomputeSignals = CountDistinctDenseSliceSignals(text, [
    /\brecompute\b/i,
    /\bimmediate(?:ly)?\b/i,
    /\blive\b/i,
    /\bwithout\s+reload\b/i,
    /\bresult(?:s)?\b/i,
    /\beligible\b/i,
    /\bexcluded\b/i,
    /\bempty\s*state\b/i,
    /\brefresh\b/i,
    /\bcurrent\s+input\b/i,
    /즉시\s*재계산/,
    /실시간/,
    /새로고침\s*없이/,
    /결과/,
    /제외/,
    /빈\s*상태/,
    /현재\s*입력/,
  ]);
  const inputSignals = CountDistinctDenseSliceSignals(text, [
    /\bdate\b/i,
    /\btime\b/i,
    /\bparty\b/i,
    /\battendees?\b/i,
    /\bseat\b/i,
    /\ballerg(?:y|ies)\b/i,
    /\bbudget\b/i,
    /\bdistance\b/i,
    /\bsearchquery\b/i,
    /\bsearch\b/i,
    /\bfavorites?\b/i,
    /\bweight\b/i,
    /\bvolume\b/i,
    /\bturnover\b/i,
    /\boccupanc(?:y|ied)\b/i,
    /\bwarehouse\b/i,
    /\bslot(?:s)?\b/i,
    /날짜/,
    /시간/,
    /인원/,
    /좌석/,
    /알레르기/,
    /예산/,
    /거리/,
    /검색/,
    /즐겨찾기/,
    /무게/,
    /부피/,
    /회전율/,
    /점유/,
    /창고/,
    /적치/,
  ]);
  const uiStateWiringSignals = CountDistinctDenseSliceSignals(text, [
    /\binteraction\s+layer\b/i,
    /\binput\/search\/favorites\b/i,
    /\binput\s+layer\b/i,
    /\bwire(?:\s+it)?\s+into\b/i,
    /\bapp\.tsx\b/i,
    /\bcontrol\s+change\b/i,
    /\bpersist(?:s|ence|ed)?\b/i,
    /\blocalstorage\b/i,
    /\bsearch\b/i,
    /\bfavorites?\b/i,
    /입력/,
    /검색/,
    /즐겨찾기/,
    /연결/,
    /즉시/,
    /로컬/,
    /저장/,
  ]);
  const mentionsPersistence =
    /\blocalstorage\b/i.test(text) ||
    /\bpersist(?:s|ence|ed)?\b/i.test(text) ||
    /즐겨찾기/.test(text) ||
    /로컬\s*저장/.test(text);
  const mentionsAppWiring =
    /\bapp\.tsx\b/i.test(text) ||
    /\bwire(?:\s+it)?\s+into\b/i.test(text) ||
    /연결/.test(text);
  const mentionsControlDrivenRecompute =
    /\b(?:any|every)\s+control\s+change\b/i.test(text) ||
    /\binput\s+change\b/i.test(text) ||
    /컨트롤\s*변경/.test(text) ||
    /입력\s*변경/.test(text);
  return (
    (stateSignals >= 3 && recomputeSignals >= 3 && inputSignals >= 5) ||
    (
      uiStateWiringSignals >= 5 &&
      inputSignals >= 2 &&
      mentionsPersistence &&
      mentionsAppWiring &&
      (recomputeSignals >= 2 || mentionsControlDrivenRecompute)
    )
  );
}

function LooksLikeDensePmInteractionPersistenceImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const agentId = String(command.agentId ?? "").trim().toLowerCase();
  if (!IsImplementationAgentId(registry, agentId)) return false;
  const officeRole = registry.MapAgentIdToOfficeRole(agentId);
  if (officeRole !== "frontend" && officeRole !== "developer") return false;
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (officeRole !== "frontend" && !LooksLikeFrontendWork(text)) return false;

  const liveStateSignals = CountDistinctDenseSliceSignals(text, [
    /\blive\s+state\b/i,
    /\bstate\s+flow\b/i,
    /\binput\s+state\b/i,
    /\bwire\b.{0,60}\binputs?\b/i,
    /\bcurrent\s+state\b/i,
    /\bwire\b.{0,80}\b(?:filters?|controls?|search|favorites?)\b/i,
    /\bbind\b.{0,80}\b(?:filters?|controls?|inputs?|search)\b/i,
    /실시간\s*상태/,
    /상태\s*흐름/,
    /입력\s*상태/,
    /입력.{0,20}연결/,
  ]);
  const recomputeSignals = CountDistinctDenseSliceSignals(text, [
    /\brecompute\b/i,
    /\bimmediate(?:ly)?\b/i,
    /\binstantly\b/i,
    /\bevery\s+change\b/i,
    /\bwithout\s+reload\b/i,
    /\blive\b/i,
    /즉시\s*재계산/,
    /실시간/,
    /바로\s*갱신/,
    /새로고침\s*없이/,
  ]);
  const persistenceSignals = CountDistinctDenseSliceSignals(text, [
    /\blocalstorage\b/i,
    /\bpersist(?:s|ence|ed)?\b/i,
    /\bfavorites?\b/i,
    /\brecent\s+selection(?:s)?\b/i,
    /\brestore\b/i,
    /즐겨찾기/,
    /최근\s*선택/,
    /로컬\s*저장/,
    /저장\s*복원/,
  ]);
  const countedInputSignals = CountDistinctDenseSliceSignals(text, [
    /\bfive\s+inputs?\b/i,
    /\ball\s+inputs?\b/i,
    /\bevery\s+input\b/i,
    /\bcurrent\s+inputs?\b/i,
    /\bteam\s+size\b/i,
    /\bequipment\b/i,
    /\bfloor\b/i,
    /\bquiet\b/i,
    /\bfilters?\b/i,
    /\bcontrols?\b/i,
    /\bbudget\b/i,
    /\bdistance\b/i,
    /\ballerg(?:y|ies)\b/i,
    /\bparking\b/i,
    /\bopen(?:ing)?\s*hours?\b/i,
    /\bcuisine\b/i,
    /\bspic(?:e|y)\b/i,
    /\bparty\s*size\b/i,
    /\bgoal\b/i,
    /\bequipment\b/i,
    /\binjur(?:y|ies)\b/i,
    /\bskill\s*level\b/i,
    /\btime\s*limit\b/i,
    /\bavailable\b/i,
    /\bunavailable\b/i,
    /입력\s*5개/,
    /다섯\s*입력/,
    /모든\s*입력/,
    /인원/,
    /예산/,
    /거리/,
    /알레르기/,
    /주차/,
    /영업\s*시간/,
    /음식\s*취향/,
    /매운맛/,
    /목표/,
    /장비/,
    /부상/,
    /난이도/,
    /가능/,
    /불가/,
    /층수/,
    /조용/,
  ]);
  const mentionsControlDrivenRecompute =
    /\b(?:every|any)\s+change\b/i.test(text) ||
    /\binput\s+change\b/i.test(text) ||
    /\bcontrol\s+change\b/i.test(text) ||
    /입력\s*변경/.test(text) ||
    /컨트롤\s*변경/.test(text);

  return (
    persistenceSignals >= 3 &&
    liveStateSignals >= 2 &&
    (recomputeSignals >= 3 || mentionsControlDrivenRecompute) &&
    countedInputSignals >= 1
  );
}

function LooksLikeDensePmResultPolishImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const agentId = String(command.agentId ?? "").trim().toLowerCase();
  if (!IsImplementationAgentId(registry, agentId)) return false;
  const officeRole = registry.MapAgentIdToOfficeRole(agentId);
  if (officeRole !== "frontend" && officeRole !== "developer") return false;
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (officeRole !== "frontend" && !LooksLikeFrontendWork(text)) return false;

  const resultSignals = CountDistinctDenseSliceSignals(text, [
    /\bresult(?:s)?\b/i,
    /\bcard(?:s)?\b/i,
    /\brecommend(?:ation|ations)?\b/i,
    /\brecommend\b/i,
    /\bselection\b/i,
    /결과/,
    /카드/,
    /추천/,
    /선택/,
    /ux/,
  ]);
  const explanationSignals = CountDistinctDenseSliceSignals(text, [
    /\btop\s*10\b/i,
    /\breason(?:s)?\b/i,
    /\bwhy\b/i,
    /\balternative(?:s)?\b/i,
    /\bfallback\b/i,
    /\bempty(?:\s+state)?\b/i,
    /\bimpossible\b/i,
    /\bhonest\b/i,
    /\bunavailable\b/i,
    /\bblocked\b/i,
    /\breserved\b/i,
    /추천\s*10개/,
    /이유/,
    /대안/,
    /빈\s*상태/,
    /불가/,
    /정직/,
    /예약됨/,
    /막힘/,
  ]);
  const mentionsTopCap =
    /\btop\s*10\b/i.test(text) ||
    /추천\s*10개/.test(text);
  const mentionsAlternativesOrEmpty =
    /\balternative(?:s)?\b/i.test(text) ||
    /\bfallback\b/i.test(text) ||
    /\bempty(?:\s+state)?\b/i.test(text) ||
    /\bimpossible\b/i.test(text) ||
    /대안/.test(text) ||
    /빈\s*상태/.test(text) ||
    /불가/.test(text);
  const mentionsHonestyConstraint =
    /\bhonest\b/i.test(text) ||
    /\bunavailable\b/i.test(text) ||
    /\bblocked\b/i.test(text) ||
    /\breserved\b/i.test(text) ||
    /정직/.test(text) ||
    /예약됨/.test(text) ||
    /막힘/.test(text);

  return resultSignals >= 2 &&
    explanationSignals >= 4 &&
    mentionsTopCap &&
    mentionsAlternativesOrEmpty &&
    mentionsHonestyConstraint;
}

function LooksLikeWarehouseDenseRecommendationText(text: string): boolean {
  return CountDistinctDenseSliceSignals(text, [
    /\bwarehouse\b/i,
    /\bslot(?:s)?\b/i,
    /\bbin(?:s)?\b/i,
    /\bshelf\b/i,
    /\blocation(?:s)?\b/i,
    /\boccupanc(?:y|ied)\b/i,
    /\bweight\b/i,
    /\bvolume\b/i,
    /\bturnover\b/i,
    /\brefrigerat(?:ed|ion)\b/i,
    /\bambient\b/i,
    /\bfragile\b/i,
    /\bincompat(?:ible|ibility)\b/i,
    /\bpick(?:ing)?\s+(?:distance|path)\b/i,
    /창고/,
    /적치/,
    /위치/,
    /칸/,
    /구역/,
    /점유/,
    /무게/,
    /부피/,
    /회전율/,
    /냉장/,
    /상온/,
    /깨지/,
    /같이\s*두면\s*안\s*되/,
    /피킹\s*동선/,
  ]) >= 3;
}

function LooksLikeDensePmWarehouseVerticalImplementationCommand(
  command: CascadeWorkflowCommand,
  registry: AgentRegistry,
): boolean {
  const text = (
    ExtractScopedImplementationWorkBlock(String(command.command ?? "")) ||
    String(command.command ?? "")
  ).replace(/\s+/g, " ").trim().toLowerCase();
  if (text === "") return false;
  if (!LooksLikeWarehouseDenseRecommendationText(text)) return false;
  return (
    LooksLikeDensePmFoundationEngineImplementationCommand(command, registry) &&
    LooksLikeDensePmInteractiveImplementationCommand(command, registry)
  );
}

function SplitDensePmInteractiveImplementationCommands(
  commands: CascadeWorkflowCommand[],
  registry: AgentRegistry,
): CascadeWorkflowCommand[] {
  const out: CascadeWorkflowCommand[] = [];
  for (const command of commands) {
    if (LooksLikeDensePmWarehouseVerticalImplementationCommand(command, registry)) {
      const original = String(command.command ?? "").trim();
      out.push({
        ...command,
        command:
          "Split dense warehouse recommendation vertical slice part 1/2: build the smallest end-to-end no-login warehouse entry path from the original slice below. " +
          "Include bundled warehouse map or occupancy data, the main card and search selection path, current constraint state, immediate top-10 recompute without reload, and honest impossible-slot exclusion for the visible results. " +
          "Defer only localStorage favorites or persistence and secondary polish.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense warehouse recommendation persistence slice part 2/2: after part 1, add localStorage favorites or persistence and any remaining explanation polish on top of the verified live recommendation path. " +
          "Do not reopen the bundled warehouse data or main card and search recompute flow unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    if (LooksLikeDensePmFoundationEngineImplementationCommand(command, registry)) {
      const original = String(command.command ?? "").trim();
      out.push({
        ...command,
        command:
          "Split dense recommendation foundation/frontend support slice part 1/2: create only the source-of-truth/reference data, domain model, availability or exclusion primitives, and the smallest support-layer wiring needed for later scoring. " +
          "Do not implement full ranking, recommendation/scoring engine files, fallback explanation, or broad rule tests in this part; if a file naturally belongs to the engine or tests, leave it for part 2.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense recommendation engine slice part 2/2: after part 1, implement filtering/scoring, top-10 cap, honest no-match/fallback calculation, and focused unit tests on top of the existing data/model primitives. " +
          "Own the recommendation/scoring engine and focused tests here. Do not reopen the source-of-truth or support-layer setup unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    if (LooksLikeDensePmInteractionPersistenceImplementationCommand(command, registry)) {
      const original = String(command.command ?? "").trim();
      out.push({
        ...command,
        command:
          "Split dense interaction/persistence frontend slice part 1/2: wire only the live input state and immediate recompute path from the original slice below. " +
          "Keep every required input in one state flow and update recommendations instantly without manual submit or reload. " +
          "Do not implement favorites, recent-selection restore, or localStorage persistence in this part.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense interaction/persistence frontend slice part 2/2: after part 1, add favorites, recent selections, and localStorage persistence/restore on top of the existing recompute flow. " +
          "Do not reopen the core recompute wiring unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    if (LooksLikeDensePmStateRecomputeImplementationCommand(command, registry)) {
      const original = String(command.command ?? "").trim();
      out.push({
        ...command,
        command:
          "Split dense state/recompute frontend slice part 1/2: build only the input state model, defaults, persistence-ready shape, and update actions for the original slice below. " +
          "Capture every required input field in one state surface, but do not wire derived recommendation recompute, selectors, or visible result snapshots in this part.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense state/recompute frontend slice part 2/2: after part 1, wire the derived recompute hook/store path that turns current inputs into live eligible/excluded/empty-state results without extra clicks. " +
          "Do not reopen localStorage/UI persistence wiring unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    if (LooksLikeDensePmInteractiveImplementationCommand(command, registry)) {
      const original = String(command.command ?? "").trim();
      out.push({
        ...command,
        command:
          "Split dense interactive frontend slice part 1/2: complete only the live input state and immediate recompute path from the original slice below. " +
          "Wire the main request/filter inputs into one state flow and make the result update immediately without reload. " +
          "Do not implement search, card-click current selection, or localStorage favorites in this part.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense interactive frontend slice part 2/2: after part 1, complete only search, card-click current selection, and localStorage favorites/persistence on top of the existing recompute flow. " +
          "Preserve the original slice completion criteria, but do not reopen the core recompute wiring unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    if (LooksLikeDensePmResultPolishImplementationCommand(command, registry)) {
      out.push(command);
      const original = String(command.command ?? "").trim();
      out.pop();
      out.push({
        ...command,
        command:
          "Split dense results/polish frontend slice part 1/2: complete only the visible top-10 result cards and per-item reason rendering from the original slice below. " +
          "Keep the result cap and card-level explanation honest, but do not implement fallback summaries, impossible-state guidance, or alternative suggestions in this part.\n\n" +
          `Original dense slice:\n${original}`,
      });
      out.push({
        ...command,
        command:
          "Split dense results/polish frontend slice part 2/2: after part 1, complete only fallback summaries, impossible/empty-state explanation, alternative suggestions, and wording honesty for unavailable or blocked choices. " +
          "Do not reopen the main result-card rendering unless part 1 left a blocker.\n\n" +
          `Original dense slice:\n${original}`,
      });
      continue;
    }
    out.push(command);
  }
  return out;
}

type CascadePendingCommand = {
  commandKey: string;
  agentId: string;
  command: string;
  senderId: string | null;
  dependsOn: string[];
  dependencyKeys: string[];
  originAssignmentContext?: string | null;
};

function SelectReadyCascadeNodes(
  pending: CascadePendingCommand[],
  completedCommandKeys: Set<string>,
): CascadePendingCommand[] {
  return pending.filter((command) => {
    const dependencies = command.dependencyKeys ?? [];
    return dependencies.length === 0 || dependencies.every((dependencyKey) => completedCommandKeys.has(dependencyKey));
  });
}

function SummarizeBlockedCascadeDependencies(pending: CascadePendingCommand[]): string {
  return pending
    .slice(0, 6)
    .map((command) => {
      const agentId = String(command.agentId ?? "").trim() || "unknown";
      const dependencies = (command.dependsOn ?? []).join(", ") || "none";
      return `${agentId} waits for ${dependencies}`;
    })
    .join("; ");
}

function IsQualityAgentId(registry: AgentRegistry, agentId: string): boolean {
  const role = registry.MapAgentIdToOfficeRole(agentId);
  return role === "reviewer" || role === "verifier";
}

function ShouldPruneSiblingQualityNodesAfterChildBranch(
  registry: AgentRegistry,
  child: CascadePendingCommand,
  branchCompletions: AgentExecutionCompletion[],
): boolean {
  const childRole = registry.MapAgentIdToOfficeRole(child.agentId);
  if (childRole !== "reviewer" && childRole !== "verifier") return false;
  if (branchCompletions.length <= 1) return false;
  return branchCompletions.some((completion) =>
    completion.agentId !== child.agentId ||
    completion.status === "needs_rework" ||
    completion.status === "blocked"
  );
}

function PruneSiblingQualityNodesForResolvedBranch(
  pending: CascadePendingCommand[],
  child: CascadePendingCommand,
  registry: AgentRegistry,
): void {
  const senderId = String(child.senderId ?? "").trim().toLowerCase();
  if (senderId === "") return;
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    const candidate = pending[index];
    if (candidate == null || candidate.commandKey === child.commandKey) continue;
    const candidateSenderId = String(candidate.senderId ?? "").trim().toLowerCase();
    if (candidateSenderId !== senderId) continue;
    if (!IsQualityAgentId(registry, candidate.agentId)) continue;
    pending.splice(index, 1);
  }
}

function ShouldPruneDescendantNodesAfterPmRescope(
  registry: AgentRegistry,
  child: CascadePendingCommand,
  branchCompletions: AgentExecutionCompletion[],
): boolean {
  if (!IsImplementationAgentId(registry, child.agentId)) return false;
  return branchCompletions.some((completion) => completion.officeRole === "pm");
}

function PruneDescendantNodesForSupersededCommand(
  pending: CascadePendingCommand[],
  rootCommandKey: string,
): void {
  const superseded = new Set<string>([String(rootCommandKey ?? "").trim()]);
  if (superseded.has("")) superseded.delete("");
  if (superseded.size === 0) return;

  let changed = true;
  while (changed) {
    changed = false;
    for (const command of pending) {
      if (superseded.has(command.commandKey)) continue;
      const dependencies = command.dependencyKeys ?? [];
      if (dependencies.some((dependencyKey) => superseded.has(dependencyKey))) {
        superseded.add(command.commandKey);
        changed = true;
      }
    }
  }

  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (superseded.has(pending[index]?.commandKey ?? "")) {
      pending.splice(index, 1);
    }
  }
}

function StripSequencerSignals(command: string): string {
  return String(command ?? "")
    .replace(/\n?\s*Prompting_Sequencer_\d+\s*$/gi, "")
    .replace(/\bPrompting_Sequencer_\d+\b/gi, "")
    .trim();
}

function ResolveOriginAssignmentContext(
  originAssignmentContext: string | null | undefined,
  fallbackCommand: string,
): string {
  const explicit = StripSequencerSignals(originAssignmentContext ?? "");
  if (explicit !== "") return explicit;
  return StripSequencerSignals(fallbackCommand);
}

function NormalizeAssignmentContextForComparison(value: string): string {
  const stripped = StripSequencerSignals(value);
  const comparisonTarget =
    ExtractScopedImplementationWorkBlock(stripped) ||
    ExtractPrimaryImplementationContext(stripped) ||
    stripped;
  return comparisonTarget
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function BuildDirectStepSeed(command: string): string {
  return BuildDirectStepSeedWithNumber(command, 1);
}

function BuildDirectStepSeedWithNumber(command: string, stepNumber: number): string {
  const text = StripSequencerSignals(command);
  const normalizedStepNumber = Number.isFinite(stepNumber) && stepNumber > 0 ? Math.floor(stepNumber) : 1;
  if (text === "") return `Prompting_Sequencer_${normalizedStepNumber}`;
  return `${text}\n\nPrompting_Sequencer_${normalizedStepNumber}`;
}

function ExtractPrimaryImplementationContext(command: string): string {
  const raw = StripSequencerSignals(command);
  if (raw === "") return "";

  let text = raw;
  const knownPrefixes = [
    /^timeout-triggered pm re-scope is required for this assignment:\s*/i,
    /^partial-artifact timeout quality review requires pm re-scope for this assignment:\s*/i,
    /^complete this pm-assigned [^:\n]+ slice for the assignment:\s*/i,
    /^execute this pm-assigned review gate for the assignment:\s*/i,
    /^execute this pm-assigned verification gate for the assignment:\s*/i,
    /^continue this pm-directed implementation handoff for the assignment:\s*/i,
    /^review the implementation completed for this assignment:\s*/i,
    /^verify the completed work for this assignment:\s*/i,
    /^review the candidate artifact created before an implementation timeout for this assignment:\s*/i,
    /^verify the candidate artifact created before an implementation timeout for this assignment:\s*/i,
    /^review the bounded repair slice for this assignment:\s*/i,
    /^verify the bounded repair slice for this assignment:\s*/i,
    /^review the repaired implementation for this assignment:\s*/i,
    /^verify the repaired work for this assignment:\s*/i,
    /^re-run verification for this assignment:\s*/i,
    /^quality gate feedback requires another repair cycle for this assignment:\s*/i,
    /^implement the assignment with tight scope control:\s*/i,
  ];
  for (const pattern of knownPrefixes) {
    if (pattern.test(text)) {
      text = text.replace(pattern, "");
      break;
    }
  }

  const stopMarkers = [
    /\n\nCurrent implementation slice that timed out without verifiable artifact progress:\s*/i,
    /\n\nCurrent unfinished slice that produced only partial artifact progress:\s*/i,
    /\n\nPM final handoff summary:\s*/i,
    /\n\nQuality gate failures that triggered the repair:\s*/i,
    /\n\nQuality gate failures:\s*/i,
    /\n\nVerification gaps to close:\s*/i,
    /\n\nPrefer delegating the repair to:\s*/i,
    /\n\nQuality gate requirement coverage:\s*/i,
    /\n\nOriginal user requirement checklist to preserve:\s*/i,
    /\n\nDomain-neutral quality invariants to prove:\s*/i,
    /\n\n## /,
  ];
  let cutoff = text.length;
  for (const pattern of stopMarkers) {
    const match = pattern.exec(text);
    if (match?.index != null && match.index >= 0) {
      cutoff = Math.min(cutoff, match.index);
    }
  }
  text = text.slice(0, cutoff);
  text = text.replace(/^Prefer delegating the repair to:.*$/gim, "").trim();
  if (text === "") return raw;

  const firstParagraph =
    text
      .split(/\n\s*\n/)
      .map((value) => value.trim())
      .find((value) => value !== "") ?? "";
  return firstParagraph !== "" ? firstParagraph : text;
}

function IsVerifierEvidenceFollowupCommand(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  return /^re-run verification for this assignment:/i.test(text) ||
    /\bVerification gaps to close:/i.test(text);
}

function LooksLikeBoundedImplementationSlice(command: string): boolean {
  const text = (ExtractPrimaryImplementationContext(command) || StripSequencerSignals(command))
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return false;
  return /^slice\s+\d+\s*:/i.test(text) ||
    /\bbounded\b[^\n.]{0,80}\bslice\b/i.test(text) ||
    /\bunfinished\b[^\n.]{0,80}\bslice\b/i.test(text) ||
    /(?:슬라이스|미완료\s*구간|미완성\s*구간)/i.test(text);
}

function IsPartialArtifactTimeoutQualityAssignment(command: string): boolean {
  const text = StripSequencerSignals(command).replace(/\s+/g, " ").trim();
  return /^(?:review|verify) the candidate artifact created before an implementation timeout for this assignment:/i.test(
    text,
  );
}

function ShouldStopRepeatedVerifierEvidenceGap(
  signals: QualityGateInput[],
  assignmentContext: string,
): boolean {
  if (!IsVerifierEvidenceFollowupCommand(assignmentContext)) return false;
  const parsedSignals = signals
    .map((signal) => BuildQualityGateSignal(signal))
    .filter((signal): signal is QualityGateSignal => signal?.requiresRework === true);
  return parsedSignals.length > 0 &&
    parsedSignals.every((signal) => signal.resolutionTarget === "verifier");
}

function ShouldStopRepeatedImplementationNoArtifactRework(
  signals: QualityGateInput[],
  assignmentContext: string,
): boolean {
  const cleanedContext = StripSequencerSignals(assignmentContext).replace(/\s+/g, " ").trim();
  if (!/^quality gate feedback requires another repair cycle for this assignment:/i.test(cleanedContext)) {
    return false;
  }
  const parsedSignals = signals
    .map((signal) => BuildQualityGateSignal(signal))
    .filter((signal): signal is QualityGateSignal => signal?.requiresRework === true);
  if (parsedSignals.length === 0) return false;
  return parsedSignals.every((signal) =>
    signal.resolutionTarget === "implementation" &&
    /Generated web artifact is incomplete|Generated artifact has no reported files/i.test(signal.summary),
  );
}

function NormalizeQualityFailureSliceForComparison(value: string): string {
  return StripSequencerSignals(value)
    .replace(/\r/g, "\n")
    .replace(/^\s*\d+\.\s*/gm, "")
    .replace(/\b(?:pm|reviewer|verifier|frontend|backend|developer|designer|devops)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function ExtractExistingBoundedQualitySlice(assignmentContext: string): string {
  const text = StripSequencerSignals(assignmentContext);
  if (text === "") return "";
  const heading = /(?:Bounded repair slice for this cycle|Bounded repair slice under review|Bounded repair slice under verification|Verification gaps to close|Review gate format issues to close|Quality findings to preserve|Timeout evidence to preserve)\s*:\s*/i.exec(text);
  if (heading?.index == null) return "";
  const rest = text.slice(heading.index + heading[0].length);
  const stop = rest.search(
    /\n\n(?:Deferred quality failures|Timeout-safe repair budget|Prefer delegating|Own only|Quality gate failures outside|Focus on|Do not modify|Run or request|Implementation requirement guardrails|Original user requirement|Domain-neutral quality|Re-plan only|Current implementation slice|Current unfinished slice|PM final handoff|## )/i,
  );
  return (stop >= 0 ? rest.slice(0, stop) : rest).trim();
}

function ShouldStopRepeatedSameQualityFailure(
  signals: QualityGateInput[],
  assignmentContext: string,
): boolean {
  const existingSlice = NormalizeQualityFailureSliceForComparison(
    ExtractExistingBoundedQualitySlice(assignmentContext),
  );
  if (existingSlice === "") return false;
  const parsedSignals = signals
    .map((signal) => BuildQualityGateSignal(signal))
    .filter((signal): signal is QualityGateSignal => signal?.requiresRework === true);
  if (parsedSignals.length === 0) return false;
  const currentItems = BuildBoundedQualityRepairSlice(parsedSignals)
    .details
    .split(/\r?\n/)
    .map(NormalizeQualityFailureSliceForComparison)
    .filter((item) => item !== "");
  if (currentItems.length === 0) return false;
  const currentHostFailureKeys = parsedSignals
    .flatMap((signal) => signal.evidence)
    .map((raw) => {
      const value = String(raw ?? "").trim();
      const verificationMatch = value.match(/^verification=([\s\S]+)$/i);
      if (verificationMatch?.[1] != null) return ExtractHostFailureLine(verificationMatch[1]);
      const hostFailureMatch = value.match(/^host_failure=([\s\S]+)$/i);
      return hostFailureMatch?.[1]?.trim() ?? "";
    })
    .map(NormalizeQualityFailureSliceForComparison)
    .filter((item) => item !== "");
  if (
    currentHostFailureKeys.length > 0 &&
    currentHostFailureKeys.some((item) => !existingSlice.includes(item))
  ) {
    return false;
  }
  return currentItems.every((item) => existingSlice.includes(item));
}

function ShouldEscalateImplementationTimeoutToPmRescope(
  parsedSignals: QualityGateSignal[],
  assignmentContext: string,
  originAssignmentContext: string | null | undefined,
): boolean {
  if (!HasImplementationTimeoutSignal(parsedSignals)) return false;
  if (IsImplementationTimeoutRepairAssignment(assignmentContext)) return false;
  const currentContext = NormalizeAssignmentContextForComparison(assignmentContext);
  const originContext = NormalizeAssignmentContextForComparison(
    ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext),
  );
  if (currentContext === "" || originContext === "") return false;
  const rawQualityStep = ExtractQualityStepFromSignals(parsedSignals);
  const qualityStepContext = NormalizeAssignmentContextForComparison(rawQualityStep);
  const qualityStepNeedsPmRescope =
    /(?:vite|react|scaffold|project|src\/domain|engine|recommend|top-?10|\bui\b|프로젝트|스캐폴|엔진|추천|화면)/i.test(
      rawQualityStep,
    );
  if (qualityStepContext !== "" && qualityStepContext !== originContext && qualityStepNeedsPmRescope) return true;
  return currentContext !== originContext;
}

function ShouldEscalatePartialArtifactQualityReworkToPmRescope(
  parsedSignals: QualityGateSignal[],
  assignmentContext: string,
  originAssignmentContext: string | null | undefined,
): boolean {
  if (parsedSignals.length === 0) return false;
  if (!IsPartialArtifactTimeoutQualityAssignment(assignmentContext)) return false;
  if (parsedSignals.every((signal) => signal.resolutionTarget === "verifier")) return false;
  const currentSlice = ExtractPrimaryImplementationContext(assignmentContext) || StripSequencerSignals(assignmentContext);
  if (!LooksLikeBoundedImplementationSlice(currentSlice)) return false;
  const currentContext = NormalizeAssignmentContextForComparison(currentSlice);
  const originContext = NormalizeAssignmentContextForComparison(
    ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext),
  );
  if (currentContext === "" || originContext === "") return false;
  return currentContext !== originContext;
}

function BuildImplementationTimeoutPmRescopeCommands(
  registry: AgentRegistry,
  parsedSignals: QualityGateSignal[],
  assignmentContext: string,
  originAssignmentContext: string | null | undefined,
): CascadeWorkflowCommand[] {
  const pmId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "";
  if (pmId === "") return [];
  const cleanedAssignmentContext = StripSequencerSignals(assignmentContext);
  const signalQualityStep = ExtractQualityStepFromSignals(parsedSignals);
  const currentSliceContext =
    signalQualityStep ||
    ExtractScopedImplementationWorkBlock(cleanedAssignmentContext) ||
    ExtractPrimaryImplementationContext(cleanedAssignmentContext) ||
    cleanedAssignmentContext;
  const resolvedOriginAssignmentContext = ResolveOriginAssignmentContext(
    originAssignmentContext,
    assignmentContext,
  );
  const primaryOriginAssignmentContext =
    /(?:PM final handoff summary:|FRONTEND_TASKS:|BACKEND_TASKS:|REVIEWER_TASKS:|VERIFIER_TASKS:)/i.test(
      resolvedOriginAssignmentContext,
    )
      ? resolvedOriginAssignmentContext
      : ExtractPrimaryImplementationContext(resolvedOriginAssignmentContext) || resolvedOriginAssignmentContext;
  if (primaryOriginAssignmentContext === "") return [];
  const timeoutRepairSlice = BuildBoundedQualityRepairSlice(parsedSignals);
  return [
    {
      agentId: pmId,
      senderId: null,
      dependsOn: [],
      originAssignmentContext: primaryOriginAssignmentContext,
      command: BuildDirectStepSeed(
        `Timeout-triggered PM re-scope is required for this assignment: ${primaryOriginAssignmentContext}\n\n` +
        `Current implementation slice that timed out without verifiable artifact progress:\n${currentSliceContext}\n\n` +
        `Timeout evidence to preserve:\n${timeoutRepairSlice.details}\n\n` +
        "Re-plan only the unfinished slice. Keep already completed implementation slices intact. Do not send the same large slice back unchanged. Emit compact [AGENT_COMMANDS] that break the unfinished implementation into smaller execution-owned slices, then reviewer/verifier follow-up after those smaller slices.",
      ),
    },
  ];
}

function FormatBulletLines(items: string[], fallback: string): string {
  const lines = [...new Set(items.map((item) => String(item ?? "").trim()).filter((item) => item !== ""))]
    .slice(0, 20)
    .map((item) => `- ${item}`);
  return lines.length > 0 ? lines.join("\n") : fallback;
}

function ExtractChangedFilesObservedByEngine(text: string): string[] {
  const match = String(text ?? "").match(/Changed files observed by the engine:\s*\n([\s\S]*?)(?:\n\s*\n|$)/i);
  if (match?.[1] == null) return [];
  return [...new Set(
    match[1]
      .split(/\r?\n/)
      .map((line) => NormalizeReportedFilePath(line.replace(/^[-*•]\s*/, "").trim()))
      .filter((line) => line !== "" && IsCheckableWorkspaceRelativeFilePath(line)),
  )];
}

function BuildPartialArtifactQualityPmRescopeCommands(
  registry: AgentRegistry,
  parsedSignals: QualityGateSignal[],
  assignmentContext: string,
  originAssignmentContext: string | null | undefined,
): CascadeWorkflowCommand[] {
  const pmId = registry.FindAgentIdByOfficeRole("pm")?.trim().toLowerCase() ?? "";
  if (pmId === "") return [];
  const resolvedOriginAssignmentContext = ResolveOriginAssignmentContext(
    originAssignmentContext,
    assignmentContext,
  );
  const primaryOriginAssignmentContext =
    /(?:PM final handoff summary:|FRONTEND_TASKS:|BACKEND_TASKS:|REVIEWER_TASKS:|VERIFIER_TASKS:)/i.test(
      resolvedOriginAssignmentContext,
    )
      ? resolvedOriginAssignmentContext
      : ExtractPrimaryImplementationContext(resolvedOriginAssignmentContext) || resolvedOriginAssignmentContext;
  const currentSlice =
    ExtractScopedImplementationWorkBlock(assignmentContext) ||
    ExtractPrimaryImplementationContext(assignmentContext) ||
    StripSequencerSignals(assignmentContext);
  if (primaryOriginAssignmentContext === "" || currentSlice === "") return [];
  const boundedRepairSlice = BuildBoundedQualityRepairSlice(parsedSignals);
  const partialFiles = ExtractChangedFilesObservedByEngine(assignmentContext);
  const partialFilesBlock =
    partialFiles.length > 0
      ? `\n\nPartial files already changed before timeout:\n${FormatBulletLines(partialFiles, "- no file list captured")}\nPreserve useful partial files. Only replace them when a quality finding proves that file is the blocker.`
      : "";
  return [
    {
      agentId: pmId,
      senderId: null,
      dependsOn: [],
      originAssignmentContext: primaryOriginAssignmentContext,
      command: BuildDirectStepSeed(
        `Partial-artifact timeout quality review requires PM re-scope for this assignment: ${primaryOriginAssignmentContext}\n\n` +
        `Current unfinished slice that produced only partial artifact progress:\n${currentSlice}\n\n` +
        `Quality findings to preserve:\n${boundedRepairSlice.details}${partialFilesBlock}\n\n` +
        "Re-plan only the unfinished slice. Keep already completed implementation slices intact. Do not send the same large slice or the same incomplete candidate-review loop back unchanged. Emit compact [AGENT_COMMANDS] that break the unfinished implementation into smaller execution-owned slices, then reviewer/verifier follow-up after those smaller slices.",
      ),
    },
  ];
}

function ResolveQualitySignalPreferredImplementationTargets(
  registry: AgentRegistry,
  parsedSignals: QualityGateSignal[],
  primaryAssignmentContext: string,
): string[] {
  const combinedSignalText = parsedSignals
    .map((signal) => `${signal.summary}\n${signal.evidence.join("\n")}`)
    .join("\n")
    .toLowerCase();
  const webScaffoldRepair =
    (
      combinedSignalText.includes("generated web scaffold is not runnable yet") ||
      combinedSignalText.includes("missing_required_scaffold_files=") ||
      /\bpackage\.json\b/.test(combinedSignalText)
    ) &&
    (
      LooksLikeFrontendImplementationContext(primaryAssignmentContext) ||
      LooksLikeGeneratedWebArtifactRequest(primaryAssignmentContext) ||
      LooksLikeUserFacingArtifactQualityContext(primaryAssignmentContext)
    );
  if (!webScaffoldRepair) return [];
  const frontendTarget = ResolvePreferredImplementationAgentId(registry, "frontend");
  return frontendTarget != null ? [frontendTarget] : [];
}

function BuildCombinedQualityReworkCommand(
  registry: AgentRegistry,
  signals: QualityGateInput[],
  assignmentContext: string,
  preferredTargets: string[],
  originAssignmentContext?: string | null,
): CascadeWorkflowCommand[] {
  const parsedSignals = signals
    .map((signal) => BuildQualityGateSignal(signal))
    .filter((signal): signal is QualityGateSignal => signal?.requiresRework === true);
  if (parsedSignals.length === 0) return [];

  const cleanedAssignmentContext = StripSequencerSignals(assignmentContext);
  const resolvedOriginAssignmentContext = ResolveOriginAssignmentContext(
    originAssignmentContext,
    cleanedAssignmentContext,
  );
  const primaryAssignmentContext =
    ExtractPrimaryImplementationContext(resolvedOriginAssignmentContext) ||
    resolvedOriginAssignmentContext ||
    ExtractPrimaryImplementationContext(cleanedAssignmentContext) ||
    cleanedAssignmentContext;
  const qualityGoalContext = resolvedOriginAssignmentContext || primaryAssignmentContext;
  if (IsQualityRepairSuppressedByAssignment(primaryAssignmentContext)) return [];
  if (
    ShouldEscalateImplementationTimeoutToPmRescope(
      parsedSignals,
      assignmentContext,
      originAssignmentContext,
    )
  ) {
    return BuildImplementationTimeoutPmRescopeCommands(
      registry,
      parsedSignals,
      assignmentContext,
      originAssignmentContext,
    );
  }
  if (
    ShouldEscalatePartialArtifactQualityReworkToPmRescope(
      parsedSignals,
      assignmentContext,
      originAssignmentContext,
    )
  ) {
    return BuildPartialArtifactQualityPmRescopeCommands(
      registry,
      parsedSignals,
      assignmentContext,
      originAssignmentContext,
    );
  }
  const reviewerId = registry.FindAgentIdByOfficeRole("reviewer")?.trim().toLowerCase() ?? "";
  if (
    reviewerId !== "" &&
    parsedSignals.every((signal) => signal.resolutionTarget === "reviewer")
  ) {
    const reviewFormatSlice = BuildBoundedQualityRepairSlice(parsedSignals);
    return [
      {
        agentId: reviewerId,
        senderId: null,
        dependsOn: [],
        originAssignmentContext: ResolveOriginAssignmentContext(
          originAssignmentContext,
          qualityGoalContext,
        ),
        command: BuildDirectStepSeed(AppendQualityRequirementGuidanceToCommand(
          `Re-run review for this assignment: ${primaryAssignmentContext}\n\n` +
          `Review gate format issues to close:\n${reviewFormatSlice.details}\n\n` +
          "Do not modify generated artifacts or source files in this review step. Return the required review tags only: [ReviewVerdict], [ReviewFindings], and [OpenRisks]. Do not emit [SEQUENCER_PLAN] or [AGENT_COMMANDS].",
          "reviewer",
          qualityGoalContext,
        )),
      },
    ];
  }
  const verifierId = registry.FindAgentIdByOfficeRole("verifier")?.trim().toLowerCase() ?? "";
  if (
    verifierId !== "" &&
    parsedSignals.every((signal) => signal.resolutionTarget === "verifier")
  ) {
    const verificationGapSlice = BuildBoundedQualityRepairSlice(parsedSignals);
    return [
      {
        agentId: verifierId,
        senderId: null,
        dependsOn: [],
        originAssignmentContext: ResolveOriginAssignmentContext(
          originAssignmentContext,
          qualityGoalContext,
        ),
        command: BuildDirectStepSeed(AppendQualityRequirementGuidanceToCommand(
          `Re-run verification for this assignment: ${primaryAssignmentContext}\n\n` +
          `Verification gaps to close:\n${verificationGapSlice.details}\n\n` +
          "Do not modify generated artifacts or source files in this verification step. Run or request the smallest host commands needed to close the evidence gap, using existing scripts, package commands, or existing test files only. Do not invent throwaway verification script filenames. For Python artifacts without pytest, prefer dependency-free stdlib checks such as `python3 -m unittest discover -s tests` or a concrete existing `tests/test_*.py` file. Only return [VerificationStatus]pass when the new evidence closes every listed gap; otherwise return fail or blocked with actionable [OpenRisks].",
          "verifier",
          qualityGoalContext,
        )),
      },
    ];
  }
  const signalPreferredTargets = ResolveQualitySignalPreferredImplementationTargets(
    registry,
    parsedSignals,
    primaryAssignmentContext,
  );
  const normalizedTargets =
    signalPreferredTargets.length > 0
      ? signalPreferredTargets
      : InferQualityReworkTargets(
        registry,
        primaryAssignmentContext,
        preferredTargets,
      );
  if (normalizedTargets.length === 0) return [];
  const targetHint =
    normalizedTargets.length > 0
      ? `Prefer delegating the repair to: ${normalizedTargets.join(", ")}.`
      : "Prefer delegating the repair to a non-quality implementation agent, not reviewer/verifier.";
  const boundedRepairSlice = BuildBoundedQualityRepairSlice(parsedSignals);
  const deferredRepairText =
    boundedRepairSlice.deferredCount > 0
      ? `\nDeferred quality failures not in this repair slice: ${boundedRepairSlice.deferredCount}. Leave them for the next review/verifier pass instead of broadening this repair.`
      : "";
  const timeoutSafeRepairText = BuildTimeoutSafeRepairBudgetBlock(parsedSignals);
  const repairScopeAuthorityText = BuildRepairScopeAuthorityText(
    `${primaryAssignmentContext}\n${qualityGoalContext}`,
  );

  const implementationCommands: CascadeWorkflowCommand[] = normalizedTargets.map((agentId) => ({
    agentId,
    originAssignmentContext: ResolveOriginAssignmentContext(
      originAssignmentContext,
      qualityGoalContext,
    ),
    command: BuildDirectStepSeed(AppendImplementationRequirementGuidanceToCommand(
      `Quality gate feedback requires another repair cycle for this assignment: ${primaryAssignmentContext}\n\n` +
      `Bounded repair slice for this cycle:\n${boundedRepairSlice.details}${deferredRepairText}${timeoutSafeRepairText !== "" ? `\n\n${timeoutSafeRepairText}` : ""}\n\n${targetHint}\n` +
      `Own only the bounded repair slice above. If the slice mentions failing_command, Key failing command, Host command evidence, failure, Key failure, Error:, or a smoke/test assertion, that exact host command/error is the current target: make it pass before fixing adjacent symptoms, and do not replace it with an unrelated improvement. ${repairScopeAuthorityText}If the slice names concrete files, create or correct those paths first and leave unrelated files alone. If the slice says no files or plan-only output, make the smallest concrete file change for this assigned slice and report exact paths in [FilesCreated]. Keep the fix minimal and evidence-driven. Do not attempt a broad rewrite or solve every reported quality failure in one pass; reviewer/verifier will trigger another small repair if more remains.`,
      qualityGoalContext,
    )),
    senderId: null,
    dependsOn: [],
  }));
  const implementationDependencies = normalizedTargets.map((value) => value.trim().toLowerCase());
  if (reviewerId !== "") {
    implementationCommands.push({
      agentId: reviewerId,
      senderId: null,
      dependsOn: implementationDependencies,
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: BuildDirectStepSeedWithNumber(AppendQualityRequirementGuidanceToCommand(
        `Review the bounded repair slice for this assignment: ${primaryAssignmentContext}\n\n` +
        `Bounded repair slice under review:\n${boundedRepairSlice.details}${deferredRepairText}\n\n` +
        "Quality gate failures outside this bounded slice are intentionally deferred until a later review/verifier pass.\n\n" +
        "Focus on whether the corrective change actually addresses the reported evidence without introducing regressions.",
        "reviewer",
        qualityGoalContext,
      ),
        1,
      ),
    });
  }
  if (verifierId !== "") {
    implementationCommands.push({
      agentId: verifierId,
      senderId: null,
      dependsOn: reviewerId !== "" ? [reviewerId] : implementationDependencies,
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: BuildDirectStepSeedWithNumber(AppendQualityRequirementGuidanceToCommand(
        `Verify the bounded repair slice for this assignment: ${primaryAssignmentContext}\n\n` +
        `Bounded repair slice under verification:\n${boundedRepairSlice.details}${deferredRepairText}\n\n` +
        "Quality gate failures outside this bounded slice are intentionally deferred until a later review/verifier pass.\n\n" +
        "Run the most relevant checks again, surface required host commands explicitly, and preserve concrete verification evidence including command results and any generated artifacts. Use existing scripts, package commands, or existing test files only; do not invent throwaway verification script filenames. For Python artifacts without pytest, prefer dependency-free stdlib checks such as `python3 -m unittest discover -s tests` or a concrete existing `tests/test_*.py` file.",
        "verifier",
        qualityGoalContext,
      ),
        2,
      ),
    });
  }
  return implementationCommands;
}

type HostCommandArtifactWriteResult = {
  relativePath: string;
  summary: string;
};

function NormalizeWorkspaceRelativePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function SummarizeHostCommandRuns(runs: HostCommandExecutionRecord[]): string {
  if (runs.length === 0) return "No host commands were executed.";
  return runs
    .slice(0, 6)
    .map((run, index) => {
      const stdoutSummary = SummarizeForTaskComplete(run.stdout, 200);
      const stderrSummary = SummarizeForTaskComplete(run.stderr, 200);
      const keyFailure = run.exit_code !== 0
        ? ExtractHostFailureLine(`${run.stderr ?? ""}\n${run.stdout ?? ""}`)
        : "";
      const pieces = [
        `${index + 1}. ${run.command}`,
        `exit_code=${String(run.exit_code)}`,
        keyFailure !== "" ? `key_failure=${keyFailure}` : "",
        stdoutSummary !== "" ? `stdout=${stdoutSummary}` : "",
        stderrSummary !== "" ? `stderr=${stderrSummary}` : "",
      ].filter((part) => part !== "");
      return pieces.join(" | ");
    })
    .join("\n");
}

function HostCommandRunsProveSuccessfulFeedback(runs: HostCommandExecutionRecord[]): boolean {
  if (runs.length === 0) return false;
  return runs.every((run) => {
    if ((run.exit_code ?? -1) !== 0) return false;
    if ((run.feedback_exit_code ?? -1) !== 0) return false;
    if ((run.followupCommands ?? []).length > 0) return false;
    const feedback = String(run.feedback ?? "").trim();
    return feedback === "" || ParseHostCommandFeedbackOk(feedback) || /^OK:/i.test(feedback);
  });
}

function NormalizeHostCommandEvidenceKey(command: string): string {
  return String(command ?? "").trim().replace(/\s+/g, " ");
}

function MissingRequestedHostCommandEvidence(
  sourceCommands: string[],
  runs: HostCommandExecutionRecord[],
): string[] {
  const runKeys = new Set(runs.map((run) => NormalizeHostCommandEvidenceKey(run.command)));
  return sourceCommands
    .map(NormalizeHostCommandEvidenceKey)
    .filter((command) => command !== "" && !runKeys.has(command));
}

function HostCommandRunsCoverRequestedCommands(
  sourceCommands: string[],
  runs: HostCommandExecutionRecord[],
): boolean {
  return MissingRequestedHostCommandEvidence(sourceCommands, runs).length === 0;
}

async function WriteVerificationArtifact(
  workspace: string,
  officeRole: AgentRole,
  logLabel: string,
  sourceCommands: string[],
  result: { ok: boolean; runs: HostCommandExecutionRecord[] },
): Promise<HostCommandArtifactWriteResult | null> {
  const trimmedWorkspace = String(workspace ?? "").trim();
  if (trimmedWorkspace === "" || result.runs.length === 0) return null;
  const nodeVersion = globalThis.process?.versions?.node;
  if (typeof nodeVersion !== "string" || nodeVersion.trim() === "") return null;
  // Avoid exposing `node:` specifiers to the browser bundle while still allowing
  // Node-backed verification artifact writes in desktop/test contexts.
  const loadNodeModule = new Function("s", "return import(s)") as <T>(specifier: string) => Promise<T>;
  const [{ mkdir, writeFile }, { join, relative }] = await Promise.all([
    loadNodeModule<{ mkdir: typeof import("node:fs/promises").mkdir; writeFile: typeof import("node:fs/promises").writeFile }>(
      ["node", "fs/promises"].join(":"),
    ),
    loadNodeModule<{ join: typeof import("node:path").join; relative: typeof import("node:path").relative }>(
      ["node", "path"].join(":"),
    ),
  ]);
  const safeLabel = String(logLabel ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const artifactDir = join(trimmedWorkspace, "tmp", "verification", "smoke-verification");
  const fileName = `${officeRole}-${safeLabel || "host"}-${stamp}.json`;
  const artifactPath = join(artifactDir, fileName);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    artifactPath,
    JSON.stringify(
      {
        officeRole,
        generatedAt: new Date().toISOString(),
        sourceCommands,
        ok: result.ok,
        runs: result.runs,
      },
      null,
      2,
    ),
    "utf8",
  );
  const relativePath = NormalizeWorkspaceRelativePath(relative(trimmedWorkspace, artifactPath));
  return {
    relativePath,
    summary: SummarizeHostCommandRuns(result.runs),
  };
}

function BuildPreservedSuccessfulVerificationContext(text: string): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const kept = lines.filter((line) => {
    const value = line.replace(/^[-*•]\s*/, "").trim();
    if (value === "") return false;
    if (
      /\b(?:not\s+enough|cannot\s+approve|cannot\s+verify|did\s+not\s+run|without\s+(?:host|fresh)|needs?\s+fresh|need\s+(?:fresh|host|execution)|still\s+(?:fails?|blocked|missing)|failed|exited?\s+[1-9]|exit(?:ed|_code)?\s*[=:]?\s*[1-9])\b/i.test(value) ||
      /\b(?:host\s+(?:has\s+)?not\s+returned|until\s+the\s+host\s+(?:runs|returns)|evidence\s+(?:is\s+)?(?:still\s+)?missing|executable\s+proof\s+(?:is\s+)?(?:still\s+)?missing|pending\s+because)\b/i.test(value) ||
      /(?:아직\s*(?:통과|확정|승인|검증).{0,40}(?:불가|못|안)|실행하지\s*않|호스트.{0,40}(?:필요|없으면|돌려줘야)|실패|막힘|부족|불가)/i.test(value)
    ) {
      return false;
    }
    return (
      /\b(?:package\.json|smoke|dom|user[-\s]?flow|localStorage|favorite|recompute|search|filter|negative|adversarial|conflict|booked|excluded|exclusion|reason|top-?10|build|vite|react|src\/|scripts\/)\b/i.test(value) ||
      /(?:스모크|검색|필터|즐겨찾기|예약\s*충돌|제외|추천\s*10|입력\s*변경|재계산|부정|정적\s*데이터|외부\s*서버|소스|앱\s*로직)/i.test(value)
    );
  });
  return kept.slice(0, 8).join("\n");
}

async function AppendVerificationArtifactEvidence(
  workspace: string,
  officeRole: AgentRole,
  logLabel: string,
  baseOutput: string,
  sourceCommands: string[],
  result: { ok: boolean; runs: HostCommandExecutionRecord[] },
): Promise<string> {
  if (result.runs.length === 0) return baseOutput;
  const missingRequestedCommands = MissingRequestedHostCommandEvidence(sourceCommands, result.runs);
  const hasCompleteRequestedCommandEvidence =
    missingRequestedCommands.length === 0 &&
    HostCommandRunsCoverRequestedCommands(sourceCommands, result.runs);
  const effectiveOk =
    hasCompleteRequestedCommandEvidence &&
    (result.ok || HostCommandRunsProveSuccessfulFeedback(result.runs));
  const effectiveResult = effectiveOk === result.ok ? result : { ...result, ok: effectiveOk };
  let artifact: HostCommandArtifactWriteResult | null = null;
  try {
    artifact = await WriteVerificationArtifact(workspace, officeRole, logLabel, sourceCommands, effectiveResult);
  } catch {
    artifact = null;
  }
  const existingVerification = ExtractTaggedBlockText(baseOutput, "Verification");
  const existingFiles = ExtractFilesCreatedList(baseOutput);
  const hasExplicitStatus = ParseVerificationStatus(baseOutput) != null;
  const mergedFiles = [...new Set([artifact?.relativePath ?? "", ...existingFiles].filter((value) => value !== ""))];
  const hostFeedbackStatus = effectiveOk ? "pass" : "blocked";
  const preservedExistingVerification =
    effectiveOk
      ? BuildPreservedSuccessfulVerificationContext(existingVerification)
      : /Host command evidence:/i.test(existingVerification)
        ? ""
        : existingVerification;
  const verificationLines = [
    preservedExistingVerification !== "" ? preservedExistingVerification : "",
    `Host feedback status: ${hostFeedbackStatus}`,
    missingRequestedCommands.length > 0
      ? `Missing requested host command evidence: ${missingRequestedCommands.join(" | ")}`
      : "",
    "Host command evidence:",
    artifact?.summary ?? SummarizeHostCommandRuns(result.runs),
    artifact != null ? `Artifact: ${artifact.relativePath}` : "",
  ].filter((line) => line !== "");
  const evidenceBlocks = [
    officeRole === "verifier" && (effectiveOk || !hasExplicitStatus)
      ? `[VerificationStatus]\n${hostFeedbackStatus}\n[/VerificationStatus]`
      : "",
    `[HostFeedbackStatus]\n${hostFeedbackStatus}\n[/HostFeedbackStatus]`,
    `[Verification]\n${verificationLines.join("\n")}\n[/Verification]`,
    mergedFiles.length > 0 ? `[FilesCreated]\n${mergedFiles.join("\n")}\n[/FilesCreated]` : "",
  ].filter((block) => block !== "");
  const extraStripTags = officeRole === "verifier" && effectiveOk ? ["OpenRisks", "Command", "Commands"] : [];
  return evidenceBlocks.length > 0
    ? MergeEvidenceIntoStepResultWithStripTags(baseOutput, evidenceBlocks, extraStripTags)
    : baseOutput;
}

function ExtractFilesCreatedList(text: string): string[] {
  const body = ExtractTaggedBlockText(text, "FilesCreated") || ExtractLooseFilesCreatedBody(text);
  if (body === "") return [];
  return body
    .split(/\r?\n/)
    .map(NormalizeReportedFilePath)
    .filter(LooksLikeReportableFilePath);
}

function ExtractLooseFilesCreatedBody(text: string): string {
  const source = String(text ?? "");
  const start = source.search(/\[FilesCreated\]/i);
  if (start < 0) return "";
  const bodyStart = source.slice(start).match(/\[FilesCreated\]/i)?.[0]?.length ?? 0;
  const rest = source.slice(start + bodyStart);
  const end = rest.search(
    /\[\/(?:FilesCreated|STEP_\d+_RESULT|TaskComplete|ReviewVerdict|OpenRisks|Verification|VerificationStatus|HostFeedbackStatus|ArtifactFileStatus|AGENT_COMMANDS)\]|\{END_TASK_\d+\}|\[(?:AGENT_COMMANDS|Command|Commands|SEQUENCER_PLAN|STEP_\d+_RESULT)\]/i,
  );
  return (end >= 0 ? rest.slice(0, end) : rest).trim();
}

function LooksLikeReportableFilePath(value: string): boolean {
  const text = String(value ?? "")
    .trim()
    .replace(/^`+|`+$/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[),.;:]+$/g, "")
    .trim();
  if (text === "" || /\s/.test(text)) return false;
  if (/^(?:https?:|data:|mailto:)/i.test(text)) return false;
  if (/(?:^|\/)(?:node_modules|dist|build|target|coverage|playwright-report|test-results)\//i.test(text)) return false;
  return /(?:^|\/)[^/]+\.(?:html|css|js|jsx|ts|tsx|vue|svelte|json|md|py|rs|go|java|kt|swift|sql|yaml|yml|toml|sh|mjs|cjs)$/i.test(text);
}

function NormalizeReportedFilePath(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/^[-*•]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/^`+|`+$/g, "")
    .replace(/^['"]+|['"]+$/g, "")
    .replace(/[),.;:]+$/g, "")
    .trim();
}

const FILE_SCOPE_HINT_STOPWORDS = new Set([
  "after",
  "agent",
  "assignment",
  "backend",
  "before",
  "blocker",
  "bounded",
  "browser",
  "build",
  "bundle",
  "bundled",
  "button",
  "card",
  "cards",
  "changed",
  "check",
  "client",
  "coherent",
  "command",
  "commands",
  "complete",
  "completed",
  "component",
  "components",
  "constraint",
  "create",
  "current",
  "data",
  "deliverable",
  "developer",
  "domain",
  "entry",
  "evidence",
  "feature",
  "features",
  "feedback",
  "files",
  "filter",
  "flow",
  "flows",
  "focus",
  "foundation",
  "frontend",
  "guardrails",
  "implementation",
  "input",
  "inputs",
  "interactive",
  "local",
  "login",
  "model",
  "needs",
  "next",
  "origin",
  "output",
  "page",
  "pages",
  "part",
  "pass",
  "partial",
  "path",
  "paths",
  "polish",
  "preserve",
  "quality",
  "ready",
  "recommendation",
  "recommendations",
  "repair",
  "report",
  "reported",
  "required",
  "requirement",
  "requirements",
  "result",
  "results",
  "review",
  "reviewed",
  "reviewer",
  "route",
  "routes",
  "scoring",
  "search",
  "server",
  "shell",
  "single",
  "slice",
  "smallest",
  "source",
  "state",
  "static",
  "step",
  "support",
  "timed",
  "timeout",
  "top",
  "ui",
  "user",
  "verify",
  "verifier",
  "view",
  "visible",
  "web",
  "wire",
  "wiring",
]);

function NormalizeScopeHintToken(value: string): string {
  const token = String(value ?? "").trim().toLowerCase();
  if (token.length <= 5) return token;
  if (token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.endsWith("es")) return token.slice(0, -2);
  if (token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function ExtractScopeHintTokens(value: string): string[] {
  const normalized = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return [...new Set(
    normalized
      .split(/[^a-z0-9가-힣]+/)
      .map(NormalizeScopeHintToken)
      .filter((token) => token.length >= 4 && !FILE_SCOPE_HINT_STOPWORDS.has(token)),
  )];
}

function IsCommonArtifactEntryFilePath(path: string): boolean {
  const value = NormalizeReportedFilePath(path).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (value === "") return false;
  return /(?:^|\/)(?:index\.html|app\.(?:tsx?|jsx?|vue|svelte)|main\.(?:tsx?|jsx?|js|mjs|cjs)|styles?\.(?:css|scss|sass|less))$/i.test(
    value,
  );
}

function FilterMarkerChangedFilesToAssignmentScope(
  files: string[],
  assignmentContext: string,
  originAssignmentContext?: string | null,
): string[] {
  const normalizedFiles = [...new Set(
    files
      .map((file) => NormalizeReportedFilePath(file).replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter((file) => file !== "" && IsCheckableWorkspaceRelativeFilePath(file)),
  )];
  if (normalizedFiles.length === 0) return normalizedFiles;

  const scopeText = [
    ExtractScopedImplementationWorkBlock(assignmentContext),
    ExtractPrimaryImplementationContext(assignmentContext),
    ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext),
  ].filter((value) => String(value ?? "").trim() !== "").join("\n");
  const scopeTokens = ExtractScopeHintTokens(scopeText);
  if (scopeTokens.length === 0) return normalizedFiles;
  const scopeTokenSet = new Set(scopeTokens);

  const fileEntries = normalizedFiles.map((file) => {
    const tokens = ExtractScopeHintTokens(file);
    const overlappingTokens = tokens.filter((token) => scopeTokenSet.has(token));
    return { file, tokens, overlappingTokens };
  });
  const anchoredEntries = fileEntries.filter((entry) => entry.overlappingTokens.length > 0);
  const commonEntryFiles = fileEntries
    .filter((entry) => IsCommonArtifactEntryFilePath(entry.file))
    .map((entry) => entry.file);
  if (anchoredEntries.length === 0) {
    return [...new Set(commonEntryFiles)];
  }
  if (anchoredEntries.length === 1) {
    return [...new Set([
      anchoredEntries[0]!.file,
      ...commonEntryFiles,
    ])];
  }

  const dominantTokenCounts = new Map<string, number>();
  for (const entry of anchoredEntries) {
    for (const token of new Set(entry.overlappingTokens)) {
      dominantTokenCounts.set(token, (dominantTokenCounts.get(token) ?? 0) + 1);
    }
  }
  const dominantTokens = [...dominantTokenCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([token]) => token);
  if (dominantTokens.length === 0) return normalizedFiles;
  const dominantTokenSet = new Set(dominantTokens);

  const filtered = fileEntries
    .filter((entry) =>
      entry.overlappingTokens.length > 0 ||
      IsCommonArtifactEntryFilePath(entry.file) ||
      entry.tokens.some((token) => dominantTokenSet.has(token))
    )
    .map((entry) => entry.file);
  return filtered.length > 0 ? filtered : normalizedFiles;
}

function ExtractLooseReportedFileList(text: string): string[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const files: string[] = [];
  let captureBudget = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const lower = line.toLowerCase();
    if (
      /^(?:files?\s+(?:created|changed|modified|updated)|changed\s+files?|created\s+files?|files?\s*:)/i.test(line) ||
      /^(?:생성|수정|변경)(?:한)?\s*파일|^파일\s*(?:목록|변경|생성|수정)/i.test(line)
    ) {
      captureBudget = 8;
      for (const token of line.split(/[,]/)) {
        const normalized = NormalizeReportedFilePath(token.replace(/^[^:]*:/, ""));
        if (LooksLikeReportableFilePath(normalized)) files.push(normalized);
      }
      continue;
    }
    if (captureBudget <= 0) continue;
    if (line === "" || /^\[\/?[A-Za-z0-9_]+\]/.test(line)) {
      captureBudget = 0;
      continue;
    }
    if (/^(?:remaining|risk|summary|verification|review|open risks?|남은|위험|요약)/i.test(lower)) {
      captureBudget = 0;
      continue;
    }
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
    if (bullet?.[1] == null) {
      captureBudget -= 1;
      continue;
    }
    for (const token of bullet[1].split(/[,]/)) {
      const normalized = NormalizeReportedFilePath(token);
      if (LooksLikeReportableFilePath(normalized)) files.push(normalized);
    }
    captureBudget -= 1;
  }
  return files;
}

function ExtractReportedFilesList(text: string, changedFiles: string[] = []): string[] {
  const taskComplete = ParseTaskCompletePayload(text);
  return [...new Set([
    ...ExtractFilesCreatedList(text),
    ...(taskComplete?.ChangedFiles ?? []),
    ...changedFiles,
    ...ExtractLooseReportedFileList(text),
  ]
    .map(NormalizeReportedFilePath)
    .filter((value) => value !== ""))];
}

function IsCheckableWorkspaceRelativeFilePath(path: string): boolean {
  const value = NormalizeReportedFilePath(path).replace(/\\/g, "/").replace(/^\.\//, "");
  if (value === "") return false;
  if (value.startsWith("/") || value.startsWith("~") || /^[a-z]:\//i.test(value)) return false;
  if (value === ".." || value.startsWith("../") || value.includes("/../")) return false;
  return LooksLikeReportableFilePath(value);
}

function BuildArtifactFileStatusEvidenceBlock(missingFiles: string[]): string {
  return [
    `[${ARTIFACT_FILE_STATUS_TAG}]`,
    `missing=${missingFiles.join(" | ")}`,
    `[/${ARTIFACT_FILE_STATUS_TAG}]`,
  ].join("\n");
}

async function FindMissingReportedWorkspaceFiles(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  outputText: string,
): Promise<string[]> {
  const targetWorkspace = String(workspace ?? "").trim();
  if (runHost == null || targetWorkspace === "") return [];
  const files = [...new Set(
    ExtractReportedFilesList(outputText)
      .map((file) => NormalizeReportedFilePath(file).replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter(IsCheckableWorkspaceRelativeFilePath),
  )].slice(0, 12);
  if (files.length === 0) return [];
  const command =
    `for p in ${files.map(QuoteShellArg).join(" ")}; do ` +
    `if [ ! -e "$p" ]; then printf '%s\\n' "$p"; fi; ` +
    "done; true";
  try {
    const result = await runHost(command, targetWorkspace);
    const reported = new Set(files);
    return [...new Set(
      String(result?.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => NormalizeReportedFilePath(line).replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((line) => reported.has(line)),
    )];
  } catch {
    return [];
  }
}

async function AppendReportedFileExistenceEvidence(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  officeRole: AgentRole,
  _stepCommand: string,
  outputText: string,
): Promise<string> {
  if (officeRole === "pm" || officeRole === "reviewer" || officeRole === "verifier") return outputText;
  const reportedFiles = ExtractReportedFilesList(outputText);
  if (reportedFiles.length === 0) return outputText;
  const missingFiles = await FindMissingReportedWorkspaceFiles(runHost, workspace, outputText);
  if (missingFiles.length === 0) return outputText;
  return MergeEvidenceIntoStepResultWithStripTags(
    outputText,
    [BuildArtifactFileStatusEvidenceBlock(missingFiles)],
    [ARTIFACT_FILE_STATUS_TAG],
  );
}

function BuildImplementationTimeoutMarkerPath(sessionKey: string, officeRole: AgentRole): string {
  const token = NormalizeSessionKeySegment(`${officeRole}-${sessionKey || "default"}`);
  return `.daacs_timeout_marker_${token || officeRole}`;
}

async function CreateImplementationTimeoutMarker(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  sessionKey: string,
  officeRole: AgentRole,
): Promise<string | null> {
  const targetWorkspace = String(workspace ?? "").trim();
  if (runHost == null || targetWorkspace === "" || !IsImplementationOfficeRole(officeRole)) return null;
  const markerPath = BuildImplementationTimeoutMarkerPath(sessionKey, officeRole);
  try {
    await runHost(`rm -f ${QuoteShellArg(markerPath)} && : > ${QuoteShellArg(markerPath)}`, targetWorkspace);
    return markerPath;
  } catch {
    return null;
  }
}

async function FindWorkspaceFilesChangedSinceMarker(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  markerPath: string | null | undefined,
  assignmentContext: string,
  originAssignmentContext?: string | null,
): Promise<string[]> {
  const targetWorkspace = String(workspace ?? "").trim();
  const normalizedMarkerPath = NormalizeReportedFilePath(String(markerPath ?? "").trim()).replace(/^\.\//, "");
  if (runHost == null || targetWorkspace === "" || normalizedMarkerPath === "") return [];
  const command = [
    "find .",
    "\\(",
    "-path './.git' -o -path './.git/*' -o",
    "-path './node_modules' -o -path './node_modules/*' -o",
    "-path './.venv' -o -path './.venv/*' -o",
    "-path './venv' -o -path './venv/*' -o",
    "-path './__pycache__' -o -path './__pycache__/*'",
    "\\) -prune -o -type f -newer",
    QuoteShellArg(normalizedMarkerPath),
    "-print",
  ].join(" ");
  try {
    const result = await runHost(command, targetWorkspace);
    const changedFiles = [...new Set(
      String(result?.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => NormalizeReportedFilePath(line).replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((line) => line !== "" && line !== normalizedMarkerPath && IsCheckableWorkspaceRelativeFilePath(line)),
    )];
    return FilterMarkerChangedFilesToAssignmentScope(
      changedFiles,
      assignmentContext,
      originAssignmentContext,
    ).slice(0, 20);
  } catch {
    return [];
  }
}

function IsLikelyGeneratedArtifactInventoryFile(path: string): boolean {
  const value = NormalizeReportedFilePath(path).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  if (value === "") return false;
  if (
    /(?:^|\/)(?:node_modules|dist|build|coverage|playwright-report|test-results|reports?|target|\.git|\.daacs_cli_tmp)\//.test(value) ||
    /(?:^|\/)\.daacs_timeout_marker_/.test(value)
  ) {
    return false;
  }
  if (/(?:^|\/)(?:package\.json|tsconfig(?:\.[a-z0-9_-]+)?\.json|vite\.config\.(?:ts|js|mjs|cjs)|index\.html|readme\.md)$/i.test(value)) {
    return true;
  }
  if (/^(?:src|scripts)\//.test(value) && /\.(?:ts|tsx|js|jsx|mjs|cjs|css|scss|sass|html|json|md)$/i.test(value)) {
    return true;
  }
  return false;
}

function ShouldRecoverGeneratedArtifactInventory(
  workspace: string,
  assignmentContext: string,
  originAssignmentContext?: string | null,
): boolean {
  const targetWorkspace = String(workspace ?? "");
  const context = ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext);
  if (!/daacs-artifact-/i.test(targetWorkspace)) return false;
  return (
    LooksLikeFreshArtifactDeliveryRequest(context) ||
    LooksLikeGeneratedWebArtifactRequest(context) ||
    LooksLikeConcreteArtifactCreationRequest(context)
  );
}

function HasRecoverableGeneratedArtifactInventoryShape(files: string[], context: string): boolean {
  const normalized = [...new Set(
    files
      .map((file) => NormalizeReportedFilePath(file).replace(/\\/g, "/").replace(/^\.\//, ""))
      .filter((file) => file !== "" && IsLikelyGeneratedArtifactInventoryFile(file)),
  )];
  if (normalized.length === 0) return false;
  const looksLikeWeb =
    LooksLikeGeneratedWebArtifactRequest(context) ||
    LooksLikeFreshArtifactDeliveryRequest(context) ||
    normalized.some((file) => IsGeneratedWebEntryFile(file) || IsGeneratedWebClientCodeFile(file));
  if (!looksLikeWeb) return normalized.length >= 2;

  if (HasUsableGeneratedWebArtifactShape(normalized, "")) return true;
  const hasPackage = normalized.some((file) => /(?:^|\/)package\.json$/i.test(file));
  const hasTsconfig = normalized.some((file) => /(?:^|\/)tsconfig(?:\.[a-z0-9_-]+)?\.json$/i.test(file));
  const hasVite = normalized.some((file) => /(?:^|\/)vite\.config\.(?:ts|js|mjs|cjs)$/i.test(file));
  const hasIndex = normalized.some((file) => /(?:^|\/)index\.html$/i.test(file));
  const hasMain = normalized.some((file) => /(?:^|\/)src\/main\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file));
  const hasApp = normalized.some((file) => /(?:^|\/)src\/app\.(?:tsx?|jsx?)$/i.test(file));
  return [hasPackage, hasTsconfig, hasVite, hasIndex, hasMain, hasApp].filter(Boolean).length >= 5;
}

async function FindGeneratedArtifactWorkspaceInventoryFiles(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  assignmentContext: string,
  originAssignmentContext?: string | null,
): Promise<string[]> {
  const targetWorkspace = String(workspace ?? "").trim();
  if (
    runHost == null ||
    targetWorkspace === "" ||
    !ShouldRecoverGeneratedArtifactInventory(targetWorkspace, assignmentContext, originAssignmentContext)
  ) {
    return [];
  }
  const command = [
    "find .",
    "\\(",
    "-path './.git' -o -path './.git/*' -o",
    "-path './node_modules' -o -path './node_modules/*' -o",
    "-path './dist' -o -path './dist/*' -o",
    "-path './build' -o -path './build/*' -o",
    "-path './coverage' -o -path './coverage/*' -o",
    "-path './target' -o -path './target/*' -o",
    "-path './.daacs_cli_tmp' -o -path './.daacs_cli_tmp/*'",
    "\\) -prune -o -type f",
    "\\(",
    "-name 'package.json' -o",
    "-name 'tsconfig*.json' -o",
    "-name 'vite.config.*' -o",
    "-name 'index.html' -o",
    "-name 'README.md' -o",
    "-path './src/*' -o",
    "-path './scripts/*'",
    "\\) -print",
  ].join(" ");
  try {
    const result = await runHost(command, targetWorkspace);
    const files = [...new Set(
      String(result?.stdout ?? "")
        .split(/\r?\n/)
        .map((line) => NormalizeReportedFilePath(line).replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((file) => file !== "" && IsCheckableWorkspaceRelativeFilePath(file))
        .filter(IsLikelyGeneratedArtifactInventoryFile),
    )];
    const context = ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext);
    if (!HasRecoverableGeneratedArtifactInventoryShape(files, context)) return [];
    return files.slice(0, 30);
  } catch {
    return [];
  }
}

async function FindWorkspaceArtifactEvidenceFiles(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  markerPath: string | null | undefined,
  assignmentContext: string,
  originAssignmentContext?: string | null,
): Promise<string[]> {
  const changedFiles = await FindWorkspaceFilesChangedSinceMarker(
    runHost,
    workspace,
    markerPath,
    assignmentContext,
    originAssignmentContext,
  );
  const context = ResolveOriginAssignmentContext(originAssignmentContext, assignmentContext);
  if (
    changedFiles.length > 0 &&
    (
      !ShouldRecoverGeneratedArtifactInventory(workspace, assignmentContext, originAssignmentContext) ||
      HasRecoverableGeneratedArtifactInventoryShape(changedFiles, context)
    )
  ) {
    return changedFiles;
  }
  const inventoryFiles = await FindGeneratedArtifactWorkspaceInventoryFiles(
    runHost,
    workspace,
    assignmentContext,
    originAssignmentContext,
  );
  return [...new Set([...changedFiles, ...inventoryFiles])].slice(0, 30);
}

async function CleanupImplementationTimeoutMarker(
  runHost: RunCascadeParams["runHostWorkspaceCommand"] | undefined,
  workspace: string,
  markerPath: string | null | undefined,
): Promise<void> {
  const targetWorkspace = String(workspace ?? "").trim();
  const normalizedMarkerPath = NormalizeReportedFilePath(String(markerPath ?? "").trim()).replace(/^\.\//, "");
  if (runHost == null || targetWorkspace === "" || normalizedMarkerPath === "") return;
  try {
    await runHost(`rm -f ${QuoteShellArg(normalizedMarkerPath)}`, targetWorkspace);
  } catch {
    // ignore cleanup failures
  }
}

function ExtractPartialArtifactTimeoutFiles(text: string): string[] {
  const body = ExtractTaggedBlockText(text, PARTIAL_ARTIFACT_TIMEOUT_TAG);
  if (body === "") return [];
  return [...new Set(body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.replace(/^-\s+/, "").trim())
    .filter((line) => line !== ""))];
}

function BuildPartialArtifactTimeoutCandidateOutput(baseOutput: string, files: string[]): string {
  const fileList = [...new Set(files.map((file) => String(file ?? "").trim()).filter((file) => file !== ""))];
  const evidenceBlocks = [
    [
      "[PartialArtifactTimeout]",
      "The implementation agent changed files before the provider timeout, but did not return a final completion message. Treat this as candidate artifact output that must be reviewed and verified before acceptance.",
      "[/PartialArtifactTimeout]",
    ].join("\n"),
    fileList.length > 0 ? `[FilesCreated]\n${fileList.join("\n")}\n[/FilesCreated]` : "",
  ].filter((block) => block !== "");
  return MergeEvidenceIntoStepResultWithStripTags(baseOutput, evidenceBlocks, ["PartialArtifactTimeout"]);
}

function BuildObservedArtifactProgressOutput(baseOutput: string, files: string[]): string {
  const fileList = [...new Set(files.map((file) => String(file ?? "").trim()).filter((file) => file !== ""))];
  if (fileList.length === 0) return baseOutput;
  return MergeEvidenceIntoStepResultWithStripTags(
    baseOutput,
    [`[FilesCreated]\n${fileList.join("\n")}\n[/FilesCreated]`],
    [],
  );
}

function IsProviderTimeoutFailureText(text: string): boolean {
  return /(?:(?:codex|claude|gemini|llm|model|provider|agent|cli)(?:\s+\w+){0,5}\s+timed\s+out\s+after\s+\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|sec|s)\b|command\s+timed\s+out\s+after\s+\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|secs?|sec|s)\b|daacs_test_timeout\s+after\s+\d+(?:\.\d+)?s\b|provider\s+timeout|모델\s*타임아웃|provider\s*타임아웃)/i.test(
    String(text ?? ""),
  );
}

function IsImplementationTimeoutRepairAssignment(command: string): boolean {
  return /(?:Implementation timed out before producing verifiable artifact progress|implementation timeout reason|provider_timeout_before_artifact_progress|no_artifact_progress)/i.test(
    String(command ?? ""),
  );
}

function BuildImplementationTimeoutReworkCandidateOutput(baseOutput: string): string {
  const evidenceBlocks = [
    [
      `[${IMPLEMENTATION_TIMEOUT_TAG}]`,
      "status=no_artifact_progress",
      "reason=provider_timeout_before_artifact_progress",
      `[/${IMPLEMENTATION_TIMEOUT_TAG}]`,
    ].join("\n"),
  ];
  return MergeEvidenceIntoStepResultWithStripTags(
    baseOutput,
    evidenceBlocks,
    [IMPLEMENTATION_TIMEOUT_TAG],
  );
}

function BuildPartialArtifactQualityCommands(
  registry: AgentRegistry,
  sourceAgentId: string,
  assignmentContext: string,
  files: string[],
  originAssignmentContext?: string | null,
): CascadeWorkflowCommand[] {
  if (!IsImplementationAgentId(registry, sourceAgentId)) return [];
  const primaryAssignmentContext =
    ExtractPrimaryImplementationContext(assignmentContext) || StripSequencerSignals(assignmentContext);
  const qualityGoalContext = StripSequencerSignals(assignmentContext) || primaryAssignmentContext;
  const fileLines = [...new Set(files.map((file) => String(file ?? "").trim()).filter((file) => file !== ""))]
    .slice(0, 30)
    .map((file) => `- ${file}`)
    .join("\n");
  const source = String(sourceAgentId ?? "").trim().toLowerCase();
  const reviewerId = registry.FindAgentIdByOfficeRole("reviewer")?.trim().toLowerCase() ?? "";
  const verifierId = registry.FindAgentIdByOfficeRole("verifier")?.trim().toLowerCase() ?? "";
  const commands: CascadeWorkflowCommand[] = [];
  if (reviewerId !== "" && reviewerId !== source) {
    commands.push({
      agentId: reviewerId,
      senderId: source,
      dependsOn: [],
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: BuildDirectStepSeedWithNumber(AppendQualityRequirementGuidanceToCommand(
        `Review the candidate artifact created before an implementation timeout for this assignment: ${primaryAssignmentContext}\n\n` +
        `Changed files observed by the engine:\n${fileLines || "- no file list captured"}\n\n` +
        "Do not edit files in this review step. Decide whether the candidate artifact is coherent, complete, and aligned with the user request. If it is not ready, report concrete findings with [ReviewVerdict]needs_rework[/ReviewVerdict], [ReviewFindings], and [OpenRisks].",
        "reviewer",
        qualityGoalContext,
      ),
        1,
      ),
    });
  }
  if (verifierId !== "" && verifierId !== source) {
    commands.push({
      agentId: verifierId,
      senderId: source,
      dependsOn: reviewerId !== "" && reviewerId !== source ? [reviewerId] : [],
      originAssignmentContext: ResolveOriginAssignmentContext(
        originAssignmentContext,
        qualityGoalContext,
      ),
      command: BuildDirectStepSeedWithNumber(AppendQualityRequirementGuidanceToCommand(
        `Verify the candidate artifact created before an implementation timeout for this assignment: ${primaryAssignmentContext}\n\n` +
        `Changed files observed by the engine:\n${fileLines || "- no file list captured"}\n\n` +
        "Run the most relevant user-perspective checks you can. For web artifacts, load or smoke-test the generated entry point when possible. Report [VerificationStatus]pass, fail, or blocked with concrete [Verification] evidence and [OpenRisks].",
        "verifier",
        qualityGoalContext,
      ),
        2,
      ),
    });
  }
  return commands;
}

function StripTaggedBlock(text: string, tag: string): string {
  return String(text ?? "")
    .replace(new RegExp(`\\[${tag}\\][\\s\\S]*?\\[\\/${tag}\\]`, "gi"), "")
    .trim();
}

function StripTaggedBlocks(text: string, tags: readonly string[]): string {
  return tags.reduce((current, tag) => StripTaggedBlock(current, tag), String(text ?? "")).trim();
}

function MergeEvidenceIntoStepResultWithStripTags(
  baseOutput: string,
  evidenceBlocks: string[],
  extraStripTags: string[],
): string {
  const stripTags = ["HostFeedbackStatus", "VerificationStatus", "Verification", "FilesCreated", ...extraStripTags];
  const match = (baseOutput ?? "").match(/(\[STEP_\d+_RESULT\])([\s\S]*?)(\[\/STEP_\d+_RESULT\])/i);
  if (match?.[0] == null || match[1] == null || match[2] == null || match[3] == null) {
    const openOnlyMatch = (baseOutput ?? "").match(/(\[STEP_\d+_RESULT\])([\s\S]*?)(\{END_TASK_\d+\})/i);
    if (
      openOnlyMatch?.[0] == null ||
      openOnlyMatch[1] == null ||
      openOnlyMatch[2] == null ||
      openOnlyMatch[3] == null
    ) {
      return `${evidenceBlocks.join("\n\n")}\n\n${baseOutput}`;
    }
    const cleanedBody = stripTags.reduce(
      (current, tag) => StripTaggedBlock(current, tag),
      openOnlyMatch[2].trim(),
    );
    const mergedBody = [...evidenceBlocks, cleanedBody].filter((part) => part !== "").join("\n\n");
    const closingTag = openOnlyMatch[1].replace("[STEP_", "[/STEP_");
    return baseOutput.replace(
      openOnlyMatch[0],
      `${openOnlyMatch[1]}\n${mergedBody}\n${closingTag}\n${openOnlyMatch[3]}`,
    );
  }
  const cleanedBody = stripTags.reduce(
    (current, tag) => StripTaggedBlock(current, tag),
    match[2].trim(),
  );
  const mergedBody = [...evidenceBlocks, cleanedBody].filter((part) => part !== "").join("\n\n");
  return baseOutput.replace(match[0], `${match[1]}\n${mergedBody}\n${match[3]}`);
}

function SummarizeForTaskComplete(text: string, maxLen: number = 500): string {
  const value = (text ?? "").trim();
  if (value === "") return "";
  if (value.length <= maxLen) return value;
  const headLen = Math.max(180, Math.floor(maxLen * 0.4));
  const tailLen = Math.max(180, maxLen - headLen);
  return `${value.slice(0, headLen).trim()}\n... [truncated] ...\n${value.slice(value.length - tailLen).trim()}`;
}

function IsEmptyQualityListItem(text: string): boolean {
  const value = String(text ?? "")
    .replace(/^[-*•]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value === "") return true;
  return /^(?:none|n\/a|no\s+(?:open\s+)?risks?|no\s+remaining\s+risks?|no\s+blockers?|not\s+applicable|없음|위험\s*없음|남은\s*(?:위험|리스크)\s*없음|해당\s*없음|없습니다|없다)\s*[.:：-]?$/i.test(value);
}

function ParseListLines(text: string): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, "").trim())
    .filter((line) => !IsEmptyQualityListItem(line));
}

function NormalizeTaskCompletePayload(InPayload: TaskCompletePayload): TaskCompletePayload {
  return {
    ...InPayload,
    Sender: String(InPayload.Sender ?? "").trim(),
    Command: String(InPayload.Command ?? "").trim(),
    Summary: String(InPayload.Summary ?? "").trim() || undefined,
    Verification: String(InPayload.Verification ?? "").trim() || undefined,
    ChangedFiles: [...new Set((InPayload.ChangedFiles ?? [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => value !== ""))].slice(0, 12),
    ReviewFindings: [...new Set((InPayload.ReviewFindings ?? [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => value !== ""))].slice(0, 8),
    OpenRisks: [...new Set((InPayload.OpenRisks ?? [])
      .map((value) => String(value ?? "").trim())
      .filter((value) => !IsEmptyQualityListItem(value)))].slice(0, 8),
  };
}

function BuildTaskCompletePayloadResult(
  InPayload: TaskCompletePayload,
): { text: string; payload: TaskCompletePayload } {
  const payload = NormalizeTaskCompletePayload(InPayload);
  return {
    text: `[TaskComplete]\n${JSON.stringify(payload)}\n[/TaskComplete]`,
    payload,
  };
}

function ParseTaskCompletePayload(InText: string): TaskCompletePayload | null {
  const m = (InText ?? "").match(/\[TaskComplete\]([\s\S]*?)\[\/TaskComplete\]/i);
  if (m?.[1] == null) return null;
  try {
    const parsed = JSON.parse(m[1]) as Partial<TaskCompletePayload>;
    const sender = String(parsed.Sender ?? "").trim();
    const command = String(parsed.Command ?? "").trim();
    if (sender === "" || command === "") return null;
    return {
      Sender: sender,
      Command: command,
      Status: parsed.Status === "failed" ? "failed" : parsed.Status === "success" ? "success" : undefined,
      Summary: String(parsed.Summary ?? "").trim() || undefined,
      ChangedFiles: Array.isArray(parsed.ChangedFiles) ? parsed.ChangedFiles.map((v) => String(v).trim()).filter(Boolean) : undefined,
      Verification: String(parsed.Verification ?? "").trim() || undefined,
      ReviewFindings: Array.isArray(parsed.ReviewFindings) ? parsed.ReviewFindings.map((v) => String(v).trim()).filter(Boolean) : undefined,
      OpenRisks: Array.isArray(parsed.OpenRisks) ? parsed.OpenRisks.map((v) => String(v).trim()).filter((v) => !IsEmptyQualityListItem(v)) : undefined,
    };
  } catch {
    return null;
  }
}

function ResolveAgentExecutionCompletionStatus(
  officeRole: AgentRole,
  outputText: string,
  command: string,
  exitCode?: number | null,
  changedFiles: string[] = [],
  assignmentContext?: string | null,
): AgentExecutionCompletionStatus {
  const gateSignal = BuildQualityGateSignal({
    officeRole,
    outputText,
    stepCommand: command,
    assignmentContext,
    exitCode,
    changedFiles,
  });
  if (officeRole === "reviewer" && ParseReviewerVerdict(outputText) === "needs_rework") {
    return "needs_rework";
  }
  if (officeRole === "verifier") {
    const verificationStatus = ParseVerificationStatus(outputText);
    if (verificationStatus === "blocked") return "blocked";
    if (verificationStatus === "fail") return "failed";
  }
  if ((exitCode ?? 0) !== 0) return "failed";
  if (gateSignal?.requiresRework === true) {
    return officeRole === "verifier" ? "blocked" : "needs_rework";
  }
  return "completed";
}

function MapExecutionStatusToTaskCompleteStatus(
  status: AgentExecutionCompletionStatus,
): "success" | "failed" {
  return status === "completed" ? "success" : "failed";
}

function BuildDefaultExecutionSummary(
  agentName: string,
  status: AgentExecutionCompletionStatus,
): string {
  switch (status) {
    case "needs_rework":
      return `${agentName} requested another repair cycle.`;
    case "blocked":
      return `${agentName} reported a blocked verification path.`;
    case "failed":
      return `${agentName} failed to complete the assigned work.`;
    default:
      return `${agentName} completed the assigned work.`;
  }
}

function BuildAgentExecutionCompletion(
  agentId: string,
  agentName: string,
  officeRole: AgentRole,
  mode: "bundle" | "direct",
  command: string,
  outputText: string,
  exitCode: number | null | undefined,
  payload: TaskCompletePayload,
  assignmentContext?: string | null,
): AgentExecutionCompletion {
  const gateSignal = BuildQualityGateSignal({
    officeRole,
    outputText,
    stepCommand: command,
    assignmentContext,
    exitCode,
    changedFiles: payload.ChangedFiles ?? [],
  });
  const status = ResolveAgentExecutionCompletionStatus(
    officeRole,
    outputText,
    command,
    exitCode,
    payload.ChangedFiles ?? [],
    assignmentContext,
  );
  const evidence = [...new Set([
    ...(gateSignal?.evidence ?? []),
    String(payload.Verification ?? "").trim(),
  ].filter((value) => value !== ""))].slice(0, 12);
  const summary =
    (gateSignal?.requiresRework === true ? gateSignal.summary : payload.Summary)?.trim() ||
    BuildDefaultExecutionSummary(agentName, status);
  return {
    agentId,
    agentName,
    officeRole,
    mode,
    command,
    status,
    summary,
    changedFiles: payload.ChangedFiles ?? [],
    verification: payload.Verification,
    reviewFindings: payload.ReviewFindings ?? [],
    openRisks: payload.OpenRisks ?? [],
    evidence,
  };
}

export class SequencerCoordinator {
  private readonly stateMachine = new SequencerStateMachine();
  private readonly executorFactory = new AgentExecutorFactory(new AgentRegistry([]));

  public SetRegistry(InRegistry: AgentRegistry): void {
    this.executorFactory.SetRegistry(InRegistry);
  }

  public ParseRosterAgents(InAgentsMetadataJson: string): RosterAgentMeta[] {
    try {
      const parsed: unknown = JSON.parse(InAgentsMetadataJson);
      if (
        parsed != null &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { agents?: unknown }).agents)
      ) {
        return (parsed as { agents: RosterAgentMeta[] }).agents;
      }
    } catch {
      /**/
    }
    return [];
  }

  public ClearAgentTasks(
    InSetAgentTaskByRole: (role: AgentRole, task: string) => void,
    InRegistry: AgentRegistry,
  ): void {
    const roleSet = new Set<AgentRole>();
    for (const meta of InRegistry.GetRosterAgents()) {
      const id = String(meta.id ?? "").trim();
      if (id === "") continue;
      roleSet.add(InRegistry.MapAgentIdToOfficeRole(id));
    }
    if (roleSet.size === 0) roleSet.add("pm");
    for (const agent of useOfficeStore.getState().agents) {
      const r = String(agent?.role ?? "").trim();
      if (r !== "") roleSet.add(r as AgentRole);
    }
    for (const role of roleSet) {
      InSetAgentTaskByRole(role, "");
    }
  }

  public BuildPriorStepsBlock(InRuns: SequencerStepRunRecord[], InMaxStdout: number): string {
    return SequencerParser.BuildPriorStepsBlock(InRuns, InMaxStdout);
  }

  public ResolvePhaseForPromptRole(InPromptRole: string): GoalPhase {
    return this.executorFactory.ResolvePhaseForPromptRole(InPromptRole);
  }

  public async RunAgentCommandCascade(InParams: RunCascadeParams): Promise<boolean> {
    this.stateMachine.Transit("CascadeExecuting");
    const rosterAgents = this.ParseRosterAgents(InParams.agentsMetadataJson);
    const registry = new AgentRegistry(rosterAgents);
    this.executorFactory.SetRegistry(registry);
    const queue: Array<{
      agentId: string;
      command: string;
      senderId: string | null;
      originAssignmentContext: string;
    }> = InParams.seed.map(
      (x) => ({
        agentId: x.agentId,
        command: x.command,
        senderId: x.senderId ?? null,
        originAssignmentContext: ResolveOriginAssignmentContext(
          x.originAssignmentContext,
          x.command,
        ),
      }),
    );
    const rootAssignmentContext = queue[0]?.originAssignmentContext ?? queue[0]?.command ?? "";
    let allOk = true;
    let cliCalls = 0;
    const maxCliCalls = InParams.maxCliCalls ?? Math.max(InParams.maxCascade * 4, 16);
    const injectedSkillSetByAgentId =
      InParams.injectedSkillSetByAgentId ?? new Map<string, Set<string>>();
    const suppressNestedModelDelegation = InParams.suppressNestedModelDelegation === true;
    const completionContextByAgentId = new Map<string, TaskCompletePayload[]>();
    const cascadeSessionNamespace = BuildSequencerSessionNamespace();
    const ws = (InParams.workspace ?? "").trim();
    const ResolveWorkspaceForAgent = (InAgentId: string): string => {
      const resolved = InParams.resolveWorkspaceForAgentId?.(InAgentId);
      const candidate = (resolved ?? "").trim();
      return candidate !== "" ? candidate : ws;
    };
    const runHost = InParams.runHostWorkspaceCommand;
    const skipHost = InParams.shouldSkipHostCommand;
    const ResolveSkillRequestForAgent = (
      InAgentId: string,
      InBundleRefs: string[],
      InRequestedSkills: string[],
    ): { toInject: string[]; dropped: string[] } => {
      const partition = PartitionSkillRequestByBundle(InBundleRefs, InRequestedSkills);
      const normalizedAgentId = (InAgentId ?? "").trim().toLowerCase();
      const already = injectedSkillSetByAgentId.get(normalizedAgentId) ?? new Set<string>();
      const toInject = partition.injected.filter((skillId) => !already.has(skillId));
      const duplicated = partition.injected.filter((skillId) => already.has(skillId));
      return { toInject, dropped: [...partition.dropped, ...duplicated] };
    };
    const MarkInjectedSkills = (InAgentId: string, InSkills: string[]): void => {
      if (InSkills.length === 0) return;
      const normalizedAgentId = (InAgentId ?? "").trim().toLowerCase();
      const current = injectedSkillSetByAgentId.get(normalizedAgentId) ?? new Set<string>();
      for (const skillId of InSkills) current.add(skillId);
      injectedSkillSetByAgentId.set(normalizedAgentId, current);
    };
    const drainDeferredToCommands = (): Array<{
      agentId: string;
      command: string;
      senderId: string | null;
      originAssignmentContext: string;
    }> => {
      const drained = useSequencerDeferredCommandsStore.getState().DrainDeferredAgentCommands();
      const mapped: Array<{
        agentId: string;
        command: string;
        senderId: string | null;
        originAssignmentContext: string;
      }> = [];
      for (const it of drained) {
        if (it == null) continue;
        const aid =
          it.agentId != null && it.agentId.trim() !== ""
            ? it.agentId.trim().toLowerCase()
            : String(it.officeRole ?? "").trim().toLowerCase();
        const cmd = String(it.message ?? "").trim();
        if (aid !== "" && cmd !== "") {
          mapped.push({
            agentId: aid,
            command: cmd,
            senderId: null,
            originAssignmentContext: ResolveOriginAssignmentContext(null, cmd),
          });
        }
      }
      return mapped;
    };
    const setAgentTask = (InAgentId: string, InOfficeRole: AgentRole, InTask: string): void => {
      if (InParams.setAgentTaskById != null) {
        InParams.setAgentTaskById(InAgentId, InTask);
        return;
      }
      InParams.setAgentTaskByRole(InOfficeRole, InTask);
    };
    const buildCliSessionKey = (
      InAgentId: string,
      InPhase: string,
      InExtra?: string | number | null,
    ): string => {
      const parts = [
        "sequencer",
        NormalizeSessionKeySegment(InParams.projectName),
        NormalizeSessionKeySegment(cascadeSessionNamespace),
        NormalizeSessionKeySegment(InAgentId),
        NormalizeSessionKeySegment(InPhase),
        NormalizeSessionKeySegment(String(InExtra ?? "")),
      ].filter((value) => value !== "");
      return parts.join(":");
    };
    const buildHostFeedbackSessionKey = (
      InSessionKey: string | null | undefined,
    ): string | null => {
      const base = String(InSessionKey ?? "").trim();
      if (base === "") return null;
      return `${base}:host-feedback`;
    };
    const recordCompletionContext = (InAgentId: string, InPayload: TaskCompletePayload): void => {
      const key = (InAgentId ?? "").trim().toLowerCase();
      if (key === "") return;
      const current = completionContextByAgentId.get(key) ?? [];
      current.push(InPayload);
      completionContextByAgentId.set(key, current.slice(-6));
    };
    const inferPreferredImplementationTargetsFromCompletionContext = (
      InAgentId: string,
    ): string[] => {
      const key = (InAgentId ?? "").trim().toLowerCase();
      if (key === "") return [];
      const items = completionContextByAgentId.get(key) ?? [];
      return [...new Set(
        items
          .map((item) => String(item.Sender ?? "").trim().toLowerCase())
          .filter((value) => {
            if (value === "") return false;
            try {
              return IsImplementationAgentId(registry, value);
            } catch {
              return false;
            }
          }),
      )];
    };
    const dirtyWorkspaceSummaryByPath = new Map<string, string>();
    const buildDirtyWorkspaceBlock = async (
      InWorkspace: string,
      InOfficeRole: AgentRole,
      InMode: "planning" | "step",
    ): Promise<string> => {
      if (InOfficeRole !== "pm" || runHost == null || InWorkspace.trim() === "") return "";
      const key = `${InWorkspace.trim()}::${InMode}`;
      const cached = dirtyWorkspaceSummaryByPath.get(key);
      if (cached != null) return cached;
      const workspace = InWorkspace.trim();
      const status = await runHost("git status --short --untracked-files=normal", workspace);
      if ((status?.exit_code ?? -1) !== 0) {
        dirtyWorkspaceSummaryByPath.set(key, "");
        return "";
      }
      const statusText = `${status?.stdout ?? ""}`;
      const text = statusText
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "")
        .filter((line) => !IsIgnorableDirtyWorkspacePath(line.slice(3).trim()));
      if (text.length === 0) {
        dirtyWorkspaceSummaryByPath.set(key, "");
        return "";
      }
      const trimmedLines = TruncateLineList(text, 12);
      const dirtyPaths = trimmedLines
        .filter((line) => !line.startsWith("... ("))
        .map((line) => line.slice(3).trim())
        .filter((line) => line !== "");
      let diffStatBlock = "";
      let diffDigestBlock = "";
      if (dirtyPaths.length > 0) {
        const diffStat = await runHost(
          `git diff --stat -- ${dirtyPaths.map((value) => QuoteShellArg(value)).join(" ")}`,
          workspace,
        );
        const diffStatText = CombineCascadeCliOutput(diffStat)
          .split(/\r?\n/)
          .map((line) => line.trimEnd())
          .filter((line) => line.trim() !== "");
        if (diffStatText.length > 0) {
          diffStatBlock = `\n\n## Changed-file diff stat\n${TruncateLineList(diffStatText, InMode === "planning" ? 6 : 10).join("\n")}`;
        }
        if (InMode === "step") {
          const diffDigest = await runHost(
            `git diff --unified=0 -- ${dirtyPaths.map((value) => QuoteShellArg(value)).join(" ")}`,
            workspace,
          );
          const diffDigestLines = ExtractDiffDigest(CombineCascadeCliOutput(diffDigest), 6, 10);
          if (diffDigestLines.length > 0) {
            diffDigestBlock = `\n\n## Changed-file diff digest\nUse this as the primary evidence before opening more files.\n${diffDigestLines.join("\n")}`;
          }
        }
      }
      const trimmed = trimmedLines.join("\n");
      const dirtyScopeRule = BuildDirtyWorkspaceScopeRule(rootAssignmentContext);
      const block = `## Current dirty paths\n${dirtyScopeRule}\nDefault to changed files first, then at most one ownership/caller file per hotspot unless the current evidence forces expansion.\n${trimmed}${diffStatBlock}${diffDigestBlock}`;
      dirtyWorkspaceSummaryByPath.set(key, block);
      return block;
    };
    const buildCompletionContextBlock = (InAgentId: string): string => {
      const key = (InAgentId ?? "").trim().toLowerCase();
      const items = completionContextByAgentId.get(key) ?? [];
      if (items.length === 0) return "";
      const lines = items.map((item, idx) => {
        const artifactPaths = [...new Set([
          ...ExtractArtifactPaths(item.ChangedFiles),
          ...ExtractArtifactPathsFromText(item.Verification ?? ""),
        ])];
        const parts = [
          `${idx + 1}. ${item.Sender} completed: ${item.Command}`,
          item.Status != null ? `status=${item.Status}` : "",
          item.Summary != null && item.Summary !== "" ? `summary=${item.Summary}` : "",
          item.ChangedFiles != null && item.ChangedFiles.length > 0 ? `files=${item.ChangedFiles.join(", ")}` : "",
          artifactPaths.length > 0 ? `artifacts=${artifactPaths.join(", ")}` : "",
          item.Verification != null && item.Verification !== "" ? `verification=${item.Verification}` : "",
          item.ReviewFindings != null && item.ReviewFindings.length > 0 ? `review=${item.ReviewFindings.join(" | ")}` : "",
          item.OpenRisks != null && item.OpenRisks.length > 0 ? `risks=${item.OpenRisks.join(" | ")}` : "",
        ].filter((part) => part !== "");
        return parts.join(" | ");
      });
      return `## Recent child agent outcomes\n${lines.join("\n")}`;
    };
    const buildPmEvidenceBudgetBlock = (
      InOfficeRole: AgentRole,
      InStepNumber?: number | null,
    ): string => {
      if (InOfficeRole !== "pm") return "";
      if ((InStepNumber ?? 0) === 1) {
        return "## PM evidence budget\nThis is PM Step 1 triage. Default budget: about 5-7 read-only commands and about 5-7 files. Prefer changed-file diffs, diff stat, and already-provided dirty-path evidence over opening full files. Open a full file only when the diff is insufficient to identify the hotspot, owner, or likely regression surface.\n\n## PM output budget\nReturn a compact decision memo, not an essay. Prefer about 8-10 bullets total. Keep each bullet short. Do not re-explain the product domain, game rules, or user request in long prose. Use at most 2 task lines per role bucket. If more work exists, group it. Capture only the minimum facts needed for the next step.";
      }
      if ((InStepNumber ?? 0) >= 2) {
        return "## PM evidence budget\nThis is a later PM step. Reuse prior findings as the default scope boundary. Default budget: about 4-6 read-only commands, about 4-6 files, and no more than 2 newly opened files beyond the prior step's scope. Do not fan out across multiple callers, UI entry points, or sibling subsystems unless the current diff digest or prior finding directly points there. Prefer confirming or narrowing the existing hypothesis over exploring.\n\n## PM output budget\nKeep the reply compact and execution-facing. Prefer about 6-8 bullets total. Each section should be one-line facts or task lines, not long paragraphs. Use at most 2 task lines per role bucket. If more work exists, group it. Do not repeat earlier requirements unless they changed the decision in this step.";
      }
      return "## PM evidence budget\nInspect the fewest files needed to make the next decision. Default budget: about 6-8 read-only commands and about 8-10 files, focused on dirty paths first. Once you have 3-5 high-confidence findings or confirmations, stop expanding scope unless the current evidence explicitly points outward. Prefer changed-file diffs and nearby code over broad searches.\n\n## PM output budget\nUse a compact decision memo. Avoid long prose and repeated restatements.";
    };
    const buildBundleTaskCompletePayloadResult = (
      InSender: string,
      InCommand: string,
      InOfficeRole: AgentRole,
      InRuns: SequencerStepRunRecord[],
      InAssignmentContext?: string | null,
    ): { text: string; payload: TaskCompletePayload; outputText: string; exitCode: number } => {
      const outputs = InRuns
        .map(({ stepResult }) => CombineCascadeCliOutput(stepResult))
        .filter((v) => v.trim() !== "");
      const combined = outputs.join("\n\n").trim();
      const changedFiles = [...new Set(outputs.flatMap((out) => ExtractReportedFilesList(out)))];
      const latest = outputs.length > 0 ? outputs[outputs.length - 1] ?? "" : "";
      const latestPrimary = ExtractPrimaryAgentResultText(latest || combined);
      const hadStepFailure = InRuns.some(({ stepResult }) => (stepResult?.exit_code ?? -1) !== 0);
      const status = ResolveAgentExecutionCompletionStatus(
        InOfficeRole,
        latestPrimary,
        InCommand,
        hadStepFailure ? 1 : 0,
        changedFiles,
        InAssignmentContext,
      );
      const gateSignal = BuildQualityGateSignal({
        officeRole: InOfficeRole,
        outputText: latestPrimary,
        stepCommand: InCommand,
        assignmentContext: InAssignmentContext,
        exitCode: hadStepFailure ? 1 : 0,
        changedFiles,
      });
      const verification =
        InOfficeRole === "verifier"
          ? SummarizeForTaskComplete(ExtractTaggedBlockText(latestPrimary, "Verification") || latestPrimary, 320)
          : "";
      const reviewFindings =
        InOfficeRole === "reviewer"
          ? ParseListLines(ExtractTaggedBlockText(latestPrimary, "ReviewFindings")).slice(0, 6)
          : [];
      const openRisks = ParseListLines(ExtractTaggedBlockText(latestPrimary, "OpenRisks")).slice(0, 6);
      const payloadResult = BuildTaskCompletePayloadResult({
        Sender: InSender,
        Command: InCommand,
        Status: MapExecutionStatusToTaskCompleteStatus(status),
        Summary: SummarizeForTaskComplete(
          (gateSignal?.requiresRework === true ? gateSignal.summary : combined) ||
            `${InSender} completed delegated work.`,
          420,
        ),
        ChangedFiles: changedFiles,
        Verification: verification || undefined,
        ReviewFindings: reviewFindings.length > 0 ? reviewFindings : undefined,
        OpenRisks: openRisks.length > 0 ? openRisks : undefined,
      });
      return {
        ...payloadResult,
        outputText: latestPrimary,
        exitCode: hadStepFailure ? 1 : 0,
      };
    };
    const buildDirectTaskCompletePayloadResult = (
      InSender: string,
      InCommand: string,
      InOfficeRole: AgentRole,
      InResult: CliRunResult,
      InAssignmentContext?: string | null,
    ): { text: string; payload: TaskCompletePayload; outputText: string; exitCode: number } => {
      const combined = CombineCascadeCliOutput(InResult);
      const primary = ExtractPrimaryAgentResultText(combined);
      const changedFiles = ExtractReportedFilesList(combined);
      const status = ResolveAgentExecutionCompletionStatus(
        InOfficeRole,
        primary,
        InCommand,
        InResult?.exit_code ?? -1,
        changedFiles,
        InAssignmentContext,
      );
      const gateSignal = BuildQualityGateSignal({
        officeRole: InOfficeRole,
        outputText: primary,
        stepCommand: InCommand,
        assignmentContext: InAssignmentContext,
        exitCode: InResult?.exit_code ?? -1,
        changedFiles,
      });
      const reviewFindings =
        InOfficeRole === "reviewer"
          ? ParseListLines(ExtractTaggedBlockText(primary, "ReviewFindings")).slice(0, 6)
          : [];
      const openRisks = ParseListLines(ExtractTaggedBlockText(primary, "OpenRisks")).slice(0, 6);
      const verification =
        InOfficeRole === "verifier"
          ? SummarizeForTaskComplete(ExtractTaggedBlockText(primary, "Verification") || primary, 320)
          : "";
      const payloadResult = BuildTaskCompletePayloadResult({
        Sender: InSender,
        Command: InCommand,
        Status: MapExecutionStatusToTaskCompleteStatus(status),
        Summary: SummarizeForTaskComplete(
          (gateSignal?.requiresRework === true ? gateSignal.summary : combined) ||
            `${InSender} completed delegated work.`,
          420,
        ),
        ChangedFiles: changedFiles,
        Verification: verification || undefined,
        ReviewFindings: reviewFindings.length > 0 ? reviewFindings : undefined,
        OpenRisks: openRisks.length > 0 ? openRisks : undefined,
      });
      return {
        ...payloadResult,
        outputText: primary,
        exitCode: InResult?.exit_code ?? -1,
      };
    };
    const buildDirectSenderFollowupPayload = (
      InSender: string,
      InCommand: string,
      InOfficeRole: AgentRole,
      InResult: CliRunResult,
      InTaskCompleteResult?: { text: string; payload: TaskCompletePayload; outputText: string; exitCode: number },
      InNestedFollowupsHandled: boolean = false,
    ): string => {
      const combined = CombineCascadeCliOutput(InResult).trim();
      if (combined !== "" && !InNestedFollowupsHandled) {
        const preservesDelegation =
          SequencerParser.ParseWorkflowCommands(combined, registry, InSender).length > 0;
        if (preservesDelegation) {
          return combined;
        }
      }
      return (
        InTaskCompleteResult?.text ??
        buildDirectTaskCompletePayloadResult(InSender, InCommand, InOfficeRole, InResult, rootAssignmentContext).text
      );
    };

    const ExecHostCommandsFromModelOutput = async (
      combinedOut: string,
      hostCommandSourceText: string,
      logLabel: string,
      officeAgentRole: AgentRole,
      feedbackSessionKey?: string | null,
    ): Promise<{ combinedOut: string; ok: boolean }> => {
      if (
        InParams.extractHostCommandsFromStepOutput == null ||
        runHost == null ||
        ws === "" ||
        combinedOut.trim() === ""
      ) {
        return { combinedOut, ok: true };
      }
      const hostWorkspace = ResolveWorkspaceForAgent(logLabel.split(",")[0] ?? "");
      const primaryHostCommandSourceText = ExtractPrimaryAgentResultText(hostCommandSourceText);
      const hostLines = await InParams.extractHostCommandsFromStepOutput(
        primaryHostCommandSourceText.trim() !== "" ? primaryHostCommandSourceText : hostCommandSourceText,
      );
      const trimmedLines = hostLines
        .map((c) => (c ?? "").trim())
        .filter((c) => c !== "");
      if (trimmedLines.length === 0) return { combinedOut, ok: true };
      const shouldIgnoreReadOnlyInspectionHostCommands =
        officeAgentRole !== "reviewer" &&
        officeAgentRole !== "verifier" &&
        trimmedLines.every(IsReadOnlyInspectionHostCommand);
      if (shouldIgnoreReadOnlyInspectionHostCommands) {
        return {
          combinedOut: StripHostCommandBlocks(combinedOut),
          ok: true,
        };
      }
      const feedback = await RunHostCommandsWithAgentFeedback({
        commands: trimmedLines,
        workspace: hostWorkspace || ws,
        cwdForCli: hostWorkspace || ws,
        cliProvider: InParams.cliProvider,
        feedbackSessionKey: feedbackSessionKey ?? null,
        officeAgentRole,
        logLabelPrefix: `HostFeedback(AgentCascade,post:${logLabel})`,
        runWorkspaceCommand: (InCmd, InCwd) =>
          runHost(InCmd, (InCwd ?? hostWorkspace ?? ws).trim() || hostWorkspace || ws),
        extractCommandsFromAgentText: (InText) => InParams.extractHostCommandsFromStepOutput!(InText),
        shouldSkipHostCommand: skipHost ?? undefined,
        runAgentCli: (InUser, InOpts) =>
          InParams.runCliCommand(InUser, {
            systemPrompt: InOpts.systemPrompt,
            cwd: InOpts.cwd ?? hostWorkspace ?? InParams.workspace,
            provider: InOpts.provider ?? InParams.cliProvider,
            sessionKey: InOpts.sessionKey ?? null,
          }),
        onCliLog: InParams.onCliLog,
      });
      const outputWithEvidence = await AppendVerificationArtifactEvidence(
        hostWorkspace || ws,
        officeAgentRole,
        logLabel,
        combinedOut,
        trimmedLines,
        feedback,
      );
      const hostFeedbackOk =
        HostCommandRunsCoverRequestedCommands(trimmedLines, feedback.runs) &&
        (
          feedback.ok ||
          HostCommandRunsProveSuccessfulFeedback(feedback.runs)
        );
      return {
        combinedOut: outputWithEvidence,
        ok: hostFeedbackOk,
      };
    };

    let consecutiveErrorCount = 0;


    while (queue.length > 0) {
      if (InParams.abortSignal?.aborted) {
        allOk = false;
        break;
      }
      if (!allOk) {
        break;
      }
      
      const bumped = drainDeferredToCommands();
      queue.push(...bumped);

      const next = queue.shift();
      if (next == null) break;

      const officeRole = registry.MapAgentIdToOfficeRole(next.agentId);
      const agentId = registry.NormalizeAgentId(next.agentId);
      const agentWorkspace = ResolveWorkspaceForAgent(agentId);
      const meta = rosterAgents.find(
        (candidate) => String(candidate.id ?? "").trim().toLowerCase() === agentId,
      );
      const promptRole = InParams.mapTauriCliRoleKeyToAgentPromptRole(agentId);
      const rosterPromptKey = String(meta?.prompt_key ?? "").trim();
      const rosterSkillBundleRole = String(meta?.skill_bundle_role ?? "").trim();
      const rosterSkillBundleRefs = Array.isArray(meta?.skill_bundle_refs)
        ? meta!.skill_bundle_refs!
            .map((value) => String(value ?? "").trim())
            .filter((value) => value !== "")
        : [];
      const agentDisplayName = String(meta?.display_name ?? meta?.id ?? agentId);
      const hasStepSignal = /Prompting_Sequencer_\d+/i.test(next.command);
      const isTaskComplete = /\[TaskComplete\]/i.test(next.command);

      // Issue #4 Fix: TaskComplete messages should NOT trigger re-planning.
      // Record completion evidence so the parent agent can use it in later steps.
      if (isTaskComplete) {
        const completion = ParseTaskCompletePayload(next.command);
        if (completion != null) {
          recordCompletionContext(agentId, completion);
        }
        InParams.onAgentMessage?.({
          agentId,
          agentName: agentDisplayName,
          officeRole,
          text:
            completion?.Summary != null && completion.Summary !== ""
              ? `하위 에이전트 완료 수신: ${completion.Summary}`
              : `하위 에이전트 작업 완료 수신`,
          type: "done",
        });
        setAgentTask(agentId, officeRole, "");
        continue;
      }

      if (!hasStepSignal) {
        const delegationBaseline = next.command.trim();
        setAgentTask(agentId, officeRole, delegationBaseline.slice(0, 120));
        InParams.setPhase(this.ResolvePhaseForPromptRole(promptRole));
        InParams.onAgentMessage?.({
          agentId,
          agentName: agentDisplayName,
          officeRole,
          text: `플래닝 시작: ${delegationBaseline.slice(0, 100)}`,
          type: "start",
        });

        let planUserMessage = delegationBaseline;
        const completionContextBlock = buildCompletionContextBlock(agentId);
        const dirtyWorkspaceBlock = await buildDirtyWorkspaceBlock(agentWorkspace, officeRole, "planning");
        const artifactDeliveryIntentBlock = BuildArtifactDeliveryIntentBlock(delegationBaseline);
        const pmEvidenceBudgetBlock = buildPmEvidenceBudgetBlock(officeRole);
        if (runHost != null && agentWorkspace !== "" && delegationBaseline !== "") {
          const skipPre = skipHost != null && skipHost(delegationBaseline);
          if (LooksLikeHostShellTaskBody(delegationBaseline) && !skipPre) {
            const preResult = await runHost(delegationBaseline, agentWorkspace);
            const preExit = preResult?.exit_code ?? -1;
            if (preExit !== 0) {
              allOk = false;
            }
            const preSummary = CombineCascadeCliOutput(preResult);
            InParams.onCliLog({
              stdin: delegationBaseline,
              stdout: preResult?.stdout ?? "",
              stderr: preResult?.stderr ?? "",
              exit_code: preExit,
              provider: preResult?.provider,
              label: `WorkspaceShell(AgentCascade,preplan:${agentId})`,
              officeAgentRole: officeRole,
            });
            const preSummaryTruncated = TruncateLogTail(preSummary);
            planUserMessage = `## Host shell (already executed in workspace)\n${delegationBaseline}\n\n## Host output (truncated)\n${preSummaryTruncated}\n\n${artifactDeliveryIntentBlock !== "" ? `${artifactDeliveryIntentBlock}\n\n` : ""}${dirtyWorkspaceBlock !== "" ? `${dirtyWorkspaceBlock}\n\n` : ""}${pmEvidenceBudgetBlock !== "" ? `${pmEvidenceBudgetBlock}\n\n` : ""}${completionContextBlock !== "" ? `${completionContextBlock}\n\n` : ""}## Planning assignment\n${delegationBaseline}`;
          }
        }
        if (
          planUserMessage === delegationBaseline &&
          (artifactDeliveryIntentBlock !== "" || completionContextBlock !== "" || dirtyWorkspaceBlock !== "")
        ) {
          planUserMessage = `${artifactDeliveryIntentBlock !== "" ? `${artifactDeliveryIntentBlock}\n\n` : ""}${dirtyWorkspaceBlock !== "" ? `${dirtyWorkspaceBlock}\n\n` : ""}${pmEvidenceBudgetBlock !== "" ? `${pmEvidenceBudgetBlock}\n\n` : ""}${completionContextBlock !== "" ? `${completionContextBlock}\n\n` : ""}## Planning assignment\n${delegationBaseline}`;
        }

        const planSystemPrompt = await InParams.buildRosterDelegationSystemPrompt(
          InParams.projectName,
          promptRole,
          InParams.agentsMetadataJson,
          {
            promptKey: rosterPromptKey || null,
            sequencerStepSuffix: BuildCascadePlanPhaseDelegationSuffix(officeRole),
            skillBundleRole: rosterSkillBundleRole || null,
            skillBundleRefs: rosterSkillBundleRefs,
          },
        );
        if (planSystemPrompt == null) {
          allOk = false;
          continue;
        }

        if (cliCalls >= maxCliCalls) {
          allOk = false;
          break;
        }
        cliCalls++;
        const planSessionKey = buildCliSessionKey(agentId, "plan");
        const planOut = (await InParams.runCliCommand(planUserMessage, {
          systemPrompt: planSystemPrompt,
          cwd: agentWorkspace,
          provider: InParams.cliProvider,
          sessionKey: planSessionKey,
        })) as CliRunResult;
        let planOutFinal = planOut;
        InParams.onCliLog({
          stdin: planUserMessage,
          systemPrompt: planSystemPrompt,
          stdout: planOut?.stdout ?? "",
          stderr: planOut?.stderr ?? "",
          exit_code: planOut?.exit_code ?? -1,
          provider: planOut?.provider,
          label: `AgentCascadePlan(${agentId})`,
          officeAgentRole: officeRole,
        });
        const planRequestedSkills = parseSkillRequest(planOut?.stdout ?? "");
        const planSkillResolved = ResolveSkillRequestForAgent(
          agentId,
          rosterSkillBundleRefs,
          planRequestedSkills,
        );
        if (planRequestedSkills.length > 0 && cliCalls < maxCliCalls && planSkillResolved.toInject.length > 0) {
          const planSkillPrompt = await InParams.buildRosterDelegationSystemPrompt(
            InParams.projectName,
            promptRole,
            InParams.agentsMetadataJson,
            {
              promptKey: rosterPromptKey || null,
              sequencerStepSuffix: BuildCascadePlanPhaseDelegationSuffix(officeRole),
              skillBundleRole: rosterSkillBundleRole || null,
              skillBundleRefs: rosterSkillBundleRefs,
              injectRequestedSkillRefs: planSkillResolved.toInject,
            },
          );
          if (planSkillPrompt != null) {
            cliCalls++;
            planOutFinal = (await InParams.runCliCommand(planUserMessage, {
              systemPrompt: planSkillPrompt,
              cwd: agentWorkspace,
              provider: InParams.cliProvider,
              sessionKey: planSessionKey,
            })) as CliRunResult;
            MarkInjectedSkills(agentId, planSkillResolved.toInject);
            InParams.onCliLog({
              stdin: planUserMessage,
              systemPrompt: planSkillPrompt,
              stdout: planOutFinal?.stdout ?? "",
              stderr: planOutFinal?.stderr ?? "",
              exit_code: planOutFinal?.exit_code ?? -1,
              provider: planOutFinal?.provider,
              label: `AgentCascadePlanSkill(${agentId})`,
              officeAgentRole: officeRole,
              skillRequestParsed:
                planRequestedSkills.length > 0 ? [...planRequestedSkills] : null,
              skillInjectedRefs:
                planSkillResolved.toInject.length > 0 ? [...planSkillResolved.toInject] : null,
              skillRequestDroppedRefs:
                planSkillResolved.dropped.length > 0 ? [...planSkillResolved.dropped] : null,
            });
          }
        } else if (planRequestedSkills.length > 0) {
          InParams.onCliLog({
            stdin: planUserMessage,
            systemPrompt: planSystemPrompt,
            stdout: planOut?.stdout ?? "",
            stderr: planOut?.stderr ?? "",
            exit_code: planOut?.exit_code ?? -1,
            provider: planOut?.provider,
            label: `AgentCascadePlanSkill(${agentId})`,
            officeAgentRole: officeRole,
            skillRequestParsed:
              planRequestedSkills.length > 0 ? [...planRequestedSkills] : null,
            skillInjectedRefs: null,
            skillRequestDroppedRefs:
              planSkillResolved.dropped.length > 0 ? [...planSkillResolved.dropped] : null,
          });
        }

        let activePlanPrompt = planSystemPrompt;
        if (planRequestedSkills.length > 0 && planSkillResolved.toInject.length > 0) {
          activePlanPrompt = await InParams.buildRosterDelegationSystemPrompt(
            InParams.projectName,
            promptRole,
            InParams.agentsMetadataJson,
            {
              promptKey: rosterPromptKey || null,
              sequencerStepSuffix: BuildCascadePlanPhaseDelegationSuffix(officeRole),
              skillBundleRole: rosterSkillBundleRole || null,
              skillBundleRefs: rosterSkillBundleRefs,
              injectRequestedSkillRefs: planSkillResolved.toInject,
            },
          ) ?? activePlanPrompt;
        }
        const pmAgentId = registry.FindAgentIdByOfficeRole("pm") ?? "pm";
        let planExit = planOutFinal?.exit_code ?? -1;
        let planFailedDueTransientProvider = IsTransientProviderFailure(planOutFinal);
        if (
          agentId === pmAgentId &&
          planExit !== 0 &&
          !planFailedDueTransientProvider &&
          cliCalls < maxCliCalls
        ) {
          cliCalls++;
          const retryPlanUserMessage = `${planUserMessage}\n\n${PM_PLAN_FAILURE_RETRY_SUFFIX}\nPrevious exit_code=${String(planExit)}.`;
          const retryPlanOut = (await InParams.runCliCommand(retryPlanUserMessage, {
            systemPrompt: activePlanPrompt,
            cwd: agentWorkspace,
            provider: InParams.cliProvider,
            sessionKey: planSessionKey,
          })) as CliRunResult;
          planOutFinal = retryPlanOut;
          InParams.onCliLog({
            stdin: retryPlanUserMessage,
            systemPrompt: activePlanPrompt,
            stdout: retryPlanOut?.stdout ?? "",
            stderr: retryPlanOut?.stderr ?? "",
            exit_code: retryPlanOut?.exit_code ?? -1,
            provider: retryPlanOut?.provider,
            label: `AgentCascadePlanRetry(${agentId})`,
            officeAgentRole: officeRole,
          });
          planExit = planOutFinal?.exit_code ?? -1;
          planFailedDueTransientProvider = IsTransientProviderFailure(planOutFinal);
        }
        if (planExit !== 0) {
          allOk = false;
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: planFailedDueTransientProvider
              ? `플랜 단계 실패: 외부 LLM provider temporary failure (exit ${planExit})`
              : `플랜 단계 실패 (exit ${planExit})`,
            type: "error",
          });
          setAgentTask(agentId, officeRole, "");
          continue;
        }
        let planText = ReadCascadeCliOutputForPlanParsing(planOutFinal);
        let planTextHasIncompleteTaskSections =
          agentId === pmAgentId && LooksLikeIncompletePmTaskSectionDelegation(planText);
        const looksLikeMergedCardReference = (command: string): boolean =>
          /(?:위\s*카드|전체\s*카드|모든\s*카드|카드\s*\d+\s*(?:~|-|부터)\s*\d+|cards?\s*(?:above|all)|cards?\s*\d+\s*(?:~|-|to|through)\s*\d+|all\s+cards|순서대로\s*구현)/i.test(
            String(command ?? ""),
          );
        const buildPmAgentCommandRows = (text: string): DispatchRow[] => {
          if (agentId !== pmAgentId) return [];
          const commands = SanitizePmWorkflowCommands(
            BuildPreferredPmWorkflowCommands(
              registry,
              next.originAssignmentContext ?? next.command,
              text,
              agentId,
              next.originAssignmentContext,
            ),
            registry,
          );
          const rows = commands.map((command, index) => {
            const targetAgentId = registry.NormalizeAgentId(command.agentId);
            return {
              agentId: targetAgentId,
              command: command.command,
              stepNumber: index + 1,
              cliRole: registry.MapTauriCliRoleKeyToCliRole(targetAgentId),
              officeRole: registry.MapAgentIdToOfficeRole(targetAgentId),
            };
          });
          const implementationRows = rows.filter((row) => {
            const role = registry.MapAgentIdToOfficeRole(row.agentId);
            return role !== "pm" && role !== "reviewer" && role !== "verifier";
          });
          if (
            implementationRows.length === 1 &&
            looksLikeMergedCardReference(implementationRows[0]?.command ?? "")
          ) {
            const owner = implementationRows[0]!;
            const planRows = InParams.parseSequencerPlanSteps(text)
              .filter((step) => !/^(?:review|verify|verification|리뷰|검토|검증)\b/i.test(step.task.trim()))
              .map((step, index) => ({
                ...owner,
                command: `Implement PM card ${step.stepNumber}: ${step.task}`,
                stepNumber: index + 1,
              }));
            if (planRows.length >= 2) {
              const qualityRows = rows.filter((row) => {
                const role = registry.MapAgentIdToOfficeRole(row.agentId);
                return role === "reviewer" || role === "verifier";
              });
              return [...planRows, ...qualityRows];
            }
          }
          return rows;
        };
        // Issue #2 Fix: Do NOT extract [Command] blocks from Phase 1 (planning) output.
        // The Sequencer Protocol forbids commands during planning. Extracting here
        // would cause premature shell execution before any step is run.

        let workQueue: DispatchRow[] = planTextHasIncompleteTaskSections
          ? []
          : buildPmAgentCommandRows(planText);
        if (workQueue.length === 0) {
          workQueue = planTextHasIncompleteTaskSections
            ? []
            : InParams.parseSequencerPlanSteps(planText).map((s) =>
                registry.BuildDispatchRow(s),
              );
        }
        if (
          agentId === pmAgentId &&
          workQueue.length === 0 &&
          cliCalls < maxCliCalls
        ) {
          cliCalls++;
          const retryPlanUserMessage = `${planUserMessage}\n\n${PM_PLAN_RETRY_SUFFIX}`;
          const retryPlanOut = (await InParams.runCliCommand(retryPlanUserMessage, {
            systemPrompt: activePlanPrompt,
            cwd: agentWorkspace,
            provider: InParams.cliProvider,
            sessionKey: planSessionKey,
          })) as CliRunResult;
          planOutFinal = retryPlanOut;
          InParams.onCliLog({
            stdin: retryPlanUserMessage,
            systemPrompt: activePlanPrompt,
            stdout: retryPlanOut?.stdout ?? "",
            stderr: retryPlanOut?.stderr ?? "",
            exit_code: retryPlanOut?.exit_code ?? -1,
            provider: retryPlanOut?.provider,
            label: `AgentCascadePlanRetry(${agentId})`,
            officeAgentRole: officeRole,
          });
          planText = ReadCascadeCliOutputForPlanParsing(retryPlanOut);
          planTextHasIncompleteTaskSections =
            agentId === pmAgentId && LooksLikeIncompletePmTaskSectionDelegation(planText);
          workQueue = planTextHasIncompleteTaskSections
            ? []
            : buildPmAgentCommandRows(planText);
          if (workQueue.length === 0) {
            workQueue = planTextHasIncompleteTaskSections
              ? []
              : InParams.parseSequencerPlanSteps(planText).map((s) =>
                  registry.BuildDispatchRow(s),
                );
          }
        }
        if (agentId !== pmAgentId) {
          workQueue = ForceDispatchRowsToAgent(workQueue, agentId, registry);
          workQueue = CollapseQualityGateRowsForOwner(workQueue, officeRole);
        } else {
          if (workQueue.length === 0) {
            workQueue = BuildPmPlanFallbackRows(registry, delegationBaseline);
          }
          workQueue = KeepPmPlanningRowsOnPm(workQueue, registry);
          workQueue = RoutePmImplementationRowsByContext(workQueue, registry, delegationBaseline);
          workQueue = CollapsePmOnlyPlanningRows(workQueue, registry);
          workQueue = EnsureQualityGateSteps(workQueue, registry, delegationBaseline);
        }
        workQueue = RenumberCascadeSteps(workQueue);
        if (workQueue.length === 0) {
          allOk = false;
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text:
              agentId === pmAgentId
                ? `플랜 파싱 및 PM 보정 DAG 생성 실패: 유효한 Step을 추출하지 못했습니다.`
                : `플랜 파싱 실패: 유효한 Step을 추출하지 못했습니다.`,
            type: "error",
          });
          setAgentTask(agentId, officeRole, "");
          continue;
        }

        const queuedDuringPlanning = drainDeferredToCommands();
        if (queuedDuringPlanning.length > 0 && InParams.maxCascade > 1) {
          const queuedResults = await Promise.all(
            queuedDuringPlanning.map((child) =>
              this.RunAgentCommandCascade({
                ...InParams,
                seed: [child],
                maxCascade: InParams.maxCascade - 1,
                injectedSkillSetByAgentId,
              }),
            ),
          );
          if (queuedResults.some((ok) => ok !== true)) {
            allOk = false;
          }
        }

        const channelId = InParams.resolveSequencerChannelIdForAgentId?.(agentId)?.trim() ?? "";
        if (InParams.persistAgentCascadePlanTodo != null && channelId !== "") {
          const items: SequencerItem[] = workQueue.map((w) => ({
            number: w.stepNumber,
            title: TruncateCascadeLabel(`${w.agentId}: ${w.command}`, 40),
            description: `${w.agentId} -> ${w.command}`,
            status: "pending",
          }));
          const todo: SequencerTodoList = {
            main_task_name: TruncateCascadeLabel(delegationBaseline, 60) || "Delegated task",
            project_name: InParams.projectName,
            channel_id: channelId,
            items,
          };
          const saved = await InParams.persistAgentCascadePlanTodo(todo);
          if (!saved) {
            allOk = false;
          } else if (InParams.onAgentPlanGenerated != null) {
            await InParams.onAgentPlanGenerated(agentId, planText);
          }
        }

        const planDisplayLines = workQueue.map((w, idx) => `${idx + 1}. ${w.command}`);
        const seqRuns: SequencerStepRunRecord[] = [];
        const implementationAgentIds = [
          ...new Set(
            workQueue
              .map((item) => item.agentId)
              .filter((value) => {
                const role = registry.MapAgentIdToOfficeRole(value);
                return role !== "pm" && role !== "reviewer" && role !== "verifier";
              }),
          ),
        ];
        const finalK =
          workQueue.length > 0 ? workQueue[workQueue.length - 1]!.stepNumber : 0;

        for (const row of workQueue) {
          if (cliCalls >= maxCliCalls) {
            allOk = false;
            break;
          }

          const stepAgentId = registry.NormalizeAgentId(row.agentId);
          const stepOfficeRole = registry.MapAgentIdToOfficeRole(stepAgentId);
          const stepWorkspace = ResolveWorkspaceForAgent(stepAgentId);
          const stepPromptRole = InParams.mapTauriCliRoleKeyToAgentPromptRole(row.cliRole);
          const stepMeta = rosterAgents.find(
            (candidate) => String(candidate.id ?? "").trim().toLowerCase() === stepAgentId,
          );
          const stepPromptKey = String(stepMeta?.prompt_key ?? "").trim();
          const stepSkillBundleRole = String(stepMeta?.skill_bundle_role ?? "").trim();
          const stepSkillBundleRefs = Array.isArray(stepMeta?.skill_bundle_refs)
            ? stepMeta!.skill_bundle_refs!
                .map((value) => String(value ?? "").trim())
                .filter((value) => value !== "")
            : [];
          const accumulatedSkills = Array.from(injectedSkillSetByAgentId.get(stepAgentId) ?? []);
          
          const stepSystemPrompt = await InParams.buildRosterDelegationSystemPrompt(
            InParams.projectName,
            stepPromptRole,
            InParams.agentsMetadataJson,
            {
              promptKey: stepPromptKey || null,
              sequencerStepSuffix: BuildCascadeStepSuffix(row.stepNumber, finalK, stepOfficeRole),
              skillBundleRole: stepSkillBundleRole || null,
              skillBundleRefs: stepSkillBundleRefs,
              omitRoster: row.stepNumber !== finalK,
              injectRequestedSkillRefs: accumulatedSkills.length > 0 ? accumulatedSkills : null,
            },
          );
          if (stepSystemPrompt == null) {
            allOk = false;
            break;
          }

          const priorBlock = this.BuildPriorStepsBlock(
            seqRuns,
            stepOfficeRole === "pm" ? 1200 : 14000,
          );
          const completionContextBlock = buildCompletionContextBlock(stepAgentId);
          const dirtyWorkspaceBlock = await buildDirtyWorkspaceBlock(stepWorkspace, stepOfficeRole, "step");
          const artifactDeliveryIntentBlock = BuildArtifactDeliveryIntentBlock(delegationBaseline);
          const pmEvidenceBudgetBlock = buildPmEvidenceBudgetBlock(
            stepOfficeRole,
            row.stepNumber,
          );
          const goalContext = `## NEW EXECUTION SESSION\nThis is an independent CLI invocation. You do not retain prior context automatically, so use the Active Sequencer Plan and Prior steps below as your working memory for consistency.\n\n## Active Sequencer Plan\nExecute ONLY the current step, but keep the full plan in mind for coherence.\n${planDisplayLines.join("\n")}\n\n${artifactDeliveryIntentBlock !== "" ? `${artifactDeliveryIntentBlock}\n\n` : ""}${dirtyWorkspaceBlock !== "" ? `${dirtyWorkspaceBlock}\n\n` : ""}${pmEvidenceBudgetBlock !== "" ? `${pmEvidenceBudgetBlock}\n\n` : ""}${completionContextBlock !== "" ? `${completionContextBlock}\n\n` : ""}## Delegated assignment\n${delegationBaseline}\n\n## Current Step (Step ${row.stepNumber} of ${workQueue.length})\n${row.command}`;
          const stepInstruction =
            row.stepNumber === 1
              ? `${goalContext}\n\nPrompting_Sequencer_${row.stepNumber}`
              : `${goalContext}\n\n${priorBlock}\n\nPrompting_Sequencer_${row.stepNumber}`;

          let instructionForStep = stepInstruction;
          if (runHost != null && stepWorkspace !== "") {
            const { taskBody, sequencerSuffix } = SplitSequencerInstruction(stepInstruction);
            const skipPre = skipHost != null && skipHost(taskBody);
            if (taskBody !== "" && LooksLikeHostShellTaskBody(taskBody) && !skipPre) {
              const preResult = await runHost(taskBody, stepWorkspace);
              const preExit = preResult?.exit_code ?? -1;
              if (preExit !== 0) {
                allOk = false;
              }
              const preSummary = CombineCascadeCliOutput(preResult);
              const preSummaryTruncated = TruncateLogTail(preSummary);
              let seqForModel =
                sequencerSuffix !== ""
                  ? sequencerSuffix
                  : ExtractSequencerLineFromText(stepInstruction);
              if (seqForModel === "") {
                seqForModel = `Prompting_Sequencer_${row.stepNumber}`;
              }
              InParams.onCliLog({
                stdin: taskBody,
                stdout: preResult?.stdout ?? "",
                stderr: preResult?.stderr ?? "",
                exit_code: preExit,
                provider: preResult?.provider,
                label: `WorkspaceShell(AgentCascade,pre:${stepAgentId},step${row.stepNumber})`,
                officeAgentRole: stepOfficeRole,
              });
              instructionForStep = `${taskBody}\n\n## Host shell (already executed in workspace)\n${taskBody}\n\n## Host output (truncated)\n${preSummaryTruncated}\n\nUse the executed host output above as ground truth. Do not re-run the same shell command unless recovery is required.\n\n${seqForModel}`;
            }
          }

          setAgentTask(stepAgentId, stepOfficeRole, row.command.slice(0, 120));
          const stepSessionKey = buildCliSessionKey(stepAgentId, "step", row.stepNumber);
          const stepTimeoutMarker = await CreateImplementationTimeoutMarker(
            runHost,
            stepWorkspace,
            stepSessionKey,
            stepOfficeRole,
          );
          cliCalls++;
          const stepOut = (await InParams.runCliCommand(instructionForStep, {
            systemPrompt: stepSystemPrompt,
            cwd: stepWorkspace,
            provider: InParams.cliProvider,
            sessionKey: stepSessionKey,
          })) as CliRunResult;
          let stepOutFinal = stepOut;
          InParams.onCliLog({
            stdin: instructionForStep,
            systemPrompt: stepSystemPrompt,
            stdout: stepOut?.stdout ?? "",
            stderr: stepOut?.stderr ?? "",
            exit_code: stepOut?.exit_code ?? -1,
            provider: stepOut?.provider,
            label: `AgentCascadeStep(${stepAgentId},${row.stepNumber})`,
            officeAgentRole: stepOfficeRole,
          });
          const stepRequestedSkills = parseSkillRequest(stepOut?.stdout ?? "");
          const stepSkillResolved = ResolveSkillRequestForAgent(
            stepAgentId,
            stepSkillBundleRefs,
            stepRequestedSkills,
          );
          if (stepRequestedSkills.length > 0 && cliCalls < maxCliCalls && stepSkillResolved.toInject.length > 0) {
            // Merge accumulated skills with newly requested skills
            const mergedSkills = Array.from(new Set([...accumulatedSkills, ...stepSkillResolved.toInject]));
            
            const stepSkillPrompt = await InParams.buildRosterDelegationSystemPrompt(
              InParams.projectName,
              stepPromptRole,
              InParams.agentsMetadataJson,
              {
                promptKey: stepPromptKey || null,
                sequencerStepSuffix: BuildCascadeStepSuffix(row.stepNumber, finalK, stepOfficeRole),
                skillBundleRole: stepSkillBundleRole || null,
                skillBundleRefs: stepSkillBundleRefs,
                injectRequestedSkillRefs: mergedSkills,
                omitRoster: row.stepNumber !== finalK,
              },
            );
            if (stepSkillPrompt != null) {
              cliCalls++;
              stepOutFinal = (await InParams.runCliCommand(instructionForStep, {
                systemPrompt: stepSkillPrompt,
                cwd: stepWorkspace,
                provider: InParams.cliProvider,
                sessionKey: stepSessionKey,
              })) as CliRunResult;
              MarkInjectedSkills(stepAgentId, stepSkillResolved.toInject);
              InParams.onCliLog({
                stdin: instructionForStep,
                systemPrompt: stepSkillPrompt,
                stdout: stepOutFinal?.stdout ?? "",
                stderr: stepOutFinal?.stderr ?? "",
                exit_code: stepOutFinal?.exit_code ?? -1,
                provider: stepOutFinal?.provider,
                label: `AgentCascadeStepSkill(${stepAgentId},${row.stepNumber})`,
                officeAgentRole: stepOfficeRole,
                skillRequestParsed:
                  stepRequestedSkills.length > 0 ? [...stepRequestedSkills] : null,
                skillInjectedRefs:
                  stepSkillResolved.toInject.length > 0 ? [...stepSkillResolved.toInject] : null,
                skillRequestDroppedRefs:
                  stepSkillResolved.dropped.length > 0 ? [...stepSkillResolved.dropped] : null,
              });
            }
          } else if (stepRequestedSkills.length > 0) {
            InParams.onCliLog({
              stdin: instructionForStep,
              systemPrompt: stepSystemPrompt,
              stdout: stepOut?.stdout ?? "",
              stderr: stepOut?.stderr ?? "",
              exit_code: stepOut?.exit_code ?? -1,
              provider: stepOut?.provider,
              label: `AgentCascadeStepSkill(${stepAgentId},${row.stepNumber})`,
              officeAgentRole: stepOfficeRole,
              skillRequestParsed:
                stepRequestedSkills.length > 0 ? [...stepRequestedSkills] : null,
              skillInjectedRefs: null,
              skillRequestDroppedRefs:
                stepSkillResolved.dropped.length > 0 ? [...stepSkillResolved.dropped] : null,
            });
          }

          let stepExit = stepOutFinal?.exit_code ?? -1;
          const rawStepOut = CombineCascadeCliOutput(stepOutFinal);
          const stepLooksTimedOut =
            IsImplementationOfficeRole(stepOfficeRole) &&
            IsProviderTimeoutFailureText(rawStepOut);
          const stepReportedPartialArtifactFiles =
            (stepExit !== 0 || stepLooksTimedOut) && IsImplementationOfficeRole(stepOfficeRole)
              ? ExtractPartialArtifactTimeoutFiles(rawStepOut)
              : [];
          const stepWorkspacePartialArtifactFiles =
            (stepExit !== 0 || stepLooksTimedOut) &&
            IsImplementationOfficeRole(stepOfficeRole) &&
            stepReportedPartialArtifactFiles.length === 0
              ? await FindWorkspaceArtifactEvidenceFiles(
                runHost,
                stepWorkspace,
                stepTimeoutMarker,
                row.command,
                row.command,
              )
              : [];
          const stepObservedArtifactProgressFiles =
            stepExit === 0 &&
            !stepLooksTimedOut &&
            IsImplementationOfficeRole(stepOfficeRole) &&
            ExtractReportedFilesList(rawStepOut).length === 0
              ? await FindWorkspaceArtifactEvidenceFiles(
                runHost,
                stepWorkspace,
                stepTimeoutMarker,
                row.command,
                row.command,
              )
              : [];
          await CleanupImplementationTimeoutMarker(runHost, stepWorkspace, stepTimeoutMarker);
          const stepPartialArtifactTimeoutFiles = [...new Set([
            ...stepReportedPartialArtifactFiles,
            ...stepWorkspacePartialArtifactFiles,
          ])];
          const stepHasRecoverableTimeout =
            stepLooksTimedOut &&
            !IsImplementationTimeoutRepairAssignment(row.command) &&
            IsProviderTimeoutFailureText(rawStepOut);
          if (stepHasRecoverableTimeout) {
            const compactStepOut = CompactLargeModelOutputForMemory(rawStepOut);
            const recoveredStepOut =
              stepPartialArtifactTimeoutFiles.length > 0
                ? BuildPartialArtifactTimeoutCandidateOutput(compactStepOut, stepPartialArtifactTimeoutFiles)
                : BuildImplementationTimeoutReworkCandidateOutput(compactStepOut);
            stepOutFinal = {
              ...(stepOutFinal ?? {}),
              stdout: recoveredStepOut,
              stderr: "",
              exit_code: 0,
            };
            stepExit = 0;
          } else if (stepObservedArtifactProgressFiles.length > 0) {
            stepOutFinal = {
              ...(stepOutFinal ?? {}),
              stdout: BuildObservedArtifactProgressOutput(
                CompactLargeModelOutputForMemory(rawStepOut),
                stepObservedArtifactProgressFiles,
              ),
              stderr: "",
              exit_code: 0,
            };
          }
          if (stepExit !== 0) {
            allOk = false;
            consecutiveErrorCount++;
            if (consecutiveErrorCount >= 3) {
              InParams.onAgentMessage?.({
                agentId: stepAgentId,
                agentName: String(stepMeta?.display_name ?? stepMeta?.id ?? stepAgentId),
                officeRole: stepOfficeRole,
                text: `[시스템 오류 차단] 무한 에러 루프가 감지되어 진행을 강제 종료합니다. (${consecutiveErrorCount}회 연속 실패)`,
                type: "error",
              });
              break;
            }
          } else {
            consecutiveErrorCount = 0;
          }

          stepOutFinal = CompactCliRunResultForDownstream(stepOutFinal) as CliRunResult;
          seqRuns.push({
            row,
            stepResult: stepOutFinal as SequencerStepRunRecord["stepResult"],
          });
          let stepCombined = CompactLargeModelOutputForMemory(CombineCascadeCliOutput(stepOutFinal));
          if (stepExit === 0) {
            const hostExecution = await ExecHostCommandsFromModelOutput(
              stepCombined,
              ReadCascadeCliOutputForHostCommandParsing(stepOutFinal),
              `${stepAgentId},step${row.stepNumber}`,
              stepOfficeRole,
              buildHostFeedbackSessionKey(stepSessionKey),
            );
            stepCombined = hostExecution.combinedOut;
            if (stepOutFinal != null) {
              stepOutFinal.stdout = stepCombined;
              stepOutFinal.stderr = "";
            }
            stepCombined = await AppendReportedFileExistenceEvidence(
              runHost,
              ResolveWorkspaceForAgent(stepAgentId),
              stepOfficeRole,
              row.command,
              stepCombined,
            );
            if (stepOutFinal != null) {
              stepOutFinal.stdout = stepCombined;
              stepOutFinal.stderr = "";
            }
            if (!hostExecution.ok && InParams.maxCascade <= 1) {
              allOk = false;
            }
            const postHostGateSignal = BuildQualityGateSignal({
              officeRole: stepOfficeRole,
              outputText: stepCombined,
              stepCommand: row.command,
              assignmentContext: next.originAssignmentContext,
              exitCode: stepExit,
              changedFiles: ExtractReportedFilesList(stepCombined),
            });
            if (postHostGateSignal?.requiresRework) {
              InParams.onAgentMessage?.({
                agentId: stepAgentId,
                agentName: String(stepMeta?.display_name ?? stepMeta?.id ?? stepAgentId),
                officeRole: stepOfficeRole,
                text: BuildQualityReworkAgentMessage(stepOfficeRole, postHostGateSignal),
                type: "error",
              });
              if (InParams.maxCascade <= 1) {
                allOk = false;
              }
              break;
            } else if (!hostExecution.ok) {
              InParams.onAgentMessage?.({
                agentId: stepAgentId,
                agentName: String(stepMeta?.display_name ?? stepMeta?.id ?? stepAgentId),
                officeRole: stepOfficeRole,
                text: "호스트 검증 피드백이 작업 완료를 확인하지 못함",
                type: "error",
              });
            }
          }
        }

        const nestedFollow = suppressNestedModelDelegation && officeRole !== "pm"
          ? []
          : NormalizeNestedCommands(
            officeRole === "pm"
              ? SanitizePmWorkflowCommands(CollectCascadeAgentCommands(seqRuns, registry, delegationBaseline), registry)
              : CollectCascadeAgentCommands(seqRuns, registry, delegationBaseline),
            registry,
          );
        const shouldAllowPmFallback =
          officeRole === "pm" && implementationAgentIds.length === 0;
        const shouldUsePmFallback =
          shouldAllowPmFallback && nestedFollow.length === 0;
        const pmFallbackFollow =
          shouldAllowPmFallback &&
          shouldUsePmFallback &&
          seqRuns.length > 0
            ? BuildPmDelegationFallbackCommands(
                registry,
                delegationBaseline,
                CombineCascadeCliOutput(seqRuns[seqRuns.length - 1]?.stepResult),
                implementationAgentIds,
                next.originAssignmentContext,
              )
            : [];
        const shouldSuppressQualityOnlyNestedFollow =
          nestedFollow.length > 0 &&
          (officeRole === "reviewer" || officeRole === "verifier") &&
          !HasRepairExecutionPath(nestedFollow, registry);
        const seqQualityInputs = seqRuns.map(({ row, stepResult }) => ({
          officeRole: row.officeRole,
          outputText: CombineCascadeCliOutput(stepResult),
          stepCommand: row.command,
          exitCode: stepResult?.exit_code ?? null,
          changedFiles: ExtractReportedFilesList(CombineCascadeCliOutput(stepResult)),
        }));
        const seqRequiresQualityRework = seqQualityInputs.some(
          (signal) => BuildQualityGateSignal(signal)?.requiresRework === true,
        );
        const shouldSuppressFailedQualityNestedFollow =
          seqRequiresQualityRework &&
          nestedFollow.length > 0 &&
          !HasRepairExecutionPath(nestedFollow, registry);
        const effectiveNestedFollow = shouldSuppressFailedQualityNestedFollow || shouldSuppressQualityOnlyNestedFollow
          ? []
          : shouldUsePmFallback
            ? pmFallbackFollow
          : nestedFollow.length > 0
            ? nestedFollow
            : pmFallbackFollow;
        const needsAutoQualityFollow =
          shouldSuppressFailedQualityNestedFollow ||
          shouldSuppressQualityOnlyNestedFollow ||
          (seqRequiresQualityRework && !HasRepairExecutionPath(effectiveNestedFollow, registry));
        if (needsAutoQualityFollow && InParams.maxCascade <= 1) {
          allOk = false;
        }
        const repeatedVerifierEvidenceGapFollow =
          needsAutoQualityFollow &&
          ShouldStopRepeatedVerifierEvidenceGap(seqQualityInputs, delegationBaseline);
        const repeatedImplementationNoArtifactFollow =
          needsAutoQualityFollow &&
          ShouldStopRepeatedImplementationNoArtifactRework(seqQualityInputs, delegationBaseline);
        const repeatedSameQualityFailureFollow =
          needsAutoQualityFollow &&
          ShouldStopRepeatedSameQualityFailure(seqQualityInputs, delegationBaseline);
        if (repeatedVerifierEvidenceGapFollow) {
          allOk = false;
        }
        if (repeatedImplementationNoArtifactFollow) {
          allOk = false;
        }
        if (repeatedSameQualityFailureFollow) {
          allOk = false;
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: "같은 품질 실패가 반복되어 자동 수리를 멈춤",
            type: "error",
          });
        }
        const autoQualityFollow =
          needsAutoQualityFollow &&
          !repeatedVerifierEvidenceGapFollow &&
          !repeatedImplementationNoArtifactFollow &&
          !repeatedSameQualityFailureFollow
            ? BuildCombinedQualityReworkCommand(
                registry,
                seqQualityInputs,
                delegationBaseline,
                implementationAgentIds,
                next.originAssignmentContext,
              )
            : [];
        if ((effectiveNestedFollow.length > 0 || autoQualityFollow.length > 0) && InParams.maxCascade > 1) {
          const pending = NormalizeNestedCommands(
            [...effectiveNestedFollow, ...autoQualityFollow],
            registry,
          );
          const completedCommandKeys = new Set<string>();
          
          while (pending.length > 0) {
            if (InParams.abortSignal?.aborted || !allOk) {
              allOk = false;
              break;
            }
            
            const readyNodes = SelectReadyCascadeNodes(pending, completedCommandKeys);
            if (readyNodes.length === 0) {
              allOk = false;
              InParams.onAgentMessage?.({
                agentId,
                agentName: agentDisplayName,
                officeRole,
                text: `의존성 그래프가 막혀 후속 작업을 중단합니다: ${SummarizeBlockedCascadeDependencies(pending)}`,
                type: "error",
              });
              break;
            }
            
            // Execute ready nodes in parallel
            const branchRuns = await Promise.all(
              readyNodes.map(async (child) => {
                const branchCompletions: AgentExecutionCompletion[] = [];
                const ok = await this.RunAgentCommandCascade({
                  ...InParams,
                  seed: [child],
                  maxCascade: InParams.maxCascade - 1,
                  injectedSkillSetByAgentId,
                  suppressNestedModelDelegation:
                    suppressNestedModelDelegation ||
                    pending.some((candidate) => candidate.commandKey !== child.commandKey),
                  onAgentExecutionComplete: (completion) => {
                    branchCompletions.push(completion);
                    InParams.onAgentExecutionComplete?.(completion);
                  },
                });
                return { child, ok, branchCompletions };
              }),
            );
            
            if (branchRuns.some((run) => !run.ok)) {
              allOk = false;
            }

            for (const run of branchRuns) {
              if (
                ShouldPruneSiblingQualityNodesAfterChildBranch(
                  registry,
                  run.child,
                  run.branchCompletions,
                )
              ) {
                PruneSiblingQualityNodesForResolvedBranch(pending, run.child, registry);
              }
              if (
                ShouldPruneDescendantNodesAfterPmRescope(
                  registry,
                  run.child,
                  run.branchCompletions,
                )
              ) {
                PruneDescendantNodesForSupersededCommand(pending, run.child.commandKey);
              }
            }

            for (const node of readyNodes) {
              completedCommandKeys.add(node.commandKey);
              const idx = pending.indexOf(node);
              if (idx > -1) pending.splice(idx, 1);
            }
          }
        }
        InParams.onAgentMessage?.({
          agentId,
          agentName: agentDisplayName,
          officeRole,
          text: `에이전트 플랜·실행 묶음 완료 (${workQueue.length} steps)`,
          type: allOk ? "done" : "error",
        });
        const bundleTaskComplete = buildBundleTaskCompletePayloadResult(
          agentId,
          next.command,
          officeRole,
          seqRuns,
          next.originAssignmentContext,
        );
        InParams.onAgentExecutionComplete?.(
          BuildAgentExecutionCompletion(
            agentId,
            agentDisplayName,
            officeRole,
            "bundle",
            next.command,
            bundleTaskComplete.outputText,
            bundleTaskComplete.exitCode,
            bundleTaskComplete.payload,
            next.originAssignmentContext,
          ),
        );
        if (
          allOk &&
          !suppressNestedModelDelegation &&
          next.senderId != null &&
          next.senderId.trim() !== "" &&
          !ShouldSkipImplementationSenderFollowup(registry, next.senderId, agentId)
        ) {
          queue.push({
            agentId: next.senderId.trim().toLowerCase(),
            command: bundleTaskComplete.text,
            senderId: agentId,
            originAssignmentContext: next.originAssignmentContext,
          });
        }
        setAgentTask(agentId, officeRole, "");
        continue;
      }

      const combined = await InParams.buildRosterDelegationSystemPrompt(
        InParams.projectName,
        promptRole,
        InParams.agentsMetadataJson,
        {
          promptKey: rosterPromptKey || null,
          sequencerStepSuffix:
            BuildDirectCommandExecutionSuffix(officeRole),
          skillBundleRole: rosterSkillBundleRole || null,
          skillBundleRefs: rosterSkillBundleRefs,
        },
      );
      if (combined == null) {
        allOk = false;
        continue;
      }

      const completionContextBlock = buildCompletionContextBlock(agentId);
      const commandAlreadyCarriesIntent =
        next.command.includes("## Request intent classification") ||
        next.command.includes("Implementation requirement guardrails:") ||
        next.command.includes("Original user requirement checklist to preserve:");
      const artifactDeliveryIntentBlock = commandAlreadyCarriesIntent
        ? ""
        : BuildArtifactDeliveryIntentBlock(next.originAssignmentContext || next.command);
      const directCommandBody =
        completionContextBlock !== "" || artifactDeliveryIntentBlock !== ""
          ? `${completionContextBlock !== "" ? `${completionContextBlock}\n\n` : ""}${artifactDeliveryIntentBlock !== "" ? `${artifactDeliveryIntentBlock}\n\n` : ""}## Assigned command\n${next.command}`
          : next.command;
      const dispatchedInstruction = EnsureSequencerStepSignal(
        directCommandBody,
      );

      setAgentTask(agentId, officeRole, next.command.trim().slice(0, 120));
      InParams.setPhase(this.ResolvePhaseForPromptRole(promptRole));
      InParams.onAgentMessage?.({
        agentId,
        agentName: agentDisplayName,
        officeRole,
        text: `작업 시작: ${next.command.trim().slice(0, 100)}`,
        type: "start",
      });

      let instructionForCli = dispatchedInstruction;
      if (runHost != null && agentWorkspace !== "") {
        const { taskBody, sequencerSuffix } = SplitSequencerInstruction(dispatchedInstruction);
        const skipPre = skipHost != null && skipHost(taskBody);
        if (taskBody !== "" && LooksLikeHostShellTaskBody(taskBody) && !skipPre) {
          const preResult = await runHost(taskBody, agentWorkspace);
          const preExit = preResult?.exit_code ?? -1;
          if (preExit !== 0) {
            allOk = false;
          }
          const preSummary = CombineCascadeCliOutput(preResult);
          const preSummaryTruncated = TruncateLogTail(preSummary);
          let seqForModel = sequencerSuffix;
          if (seqForModel === "") {
            seqForModel = ExtractSequencerLineFromText(dispatchedInstruction);
          }
          if (seqForModel === "") {
            seqForModel = "Prompting_Sequencer_1";
          }
          InParams.onCliLog({
            stdin: taskBody,
            stdout: preResult?.stdout ?? "",
            stderr: preResult?.stderr ?? "",
            exit_code: preExit,
            provider: preResult?.provider,
            label: `WorkspaceShell(AgentCascade,pre:${agentId})`,
            officeAgentRole: officeRole,
          });
          instructionForCli = `${taskBody}\n\n## Assigned command\n${next.command}\n\n## Host shell (already executed in workspace)\n${taskBody}\n\n## Host output (truncated)\n${preSummaryTruncated}\n\nUse the executed host output above as ground truth. Do not re-run the same shell command unless recovery is required.\n\n${seqForModel}`;
        }
      }

      if (cliCalls >= maxCliCalls) {
        allOk = false;
        break;
      }
      const directSessionKey = buildCliSessionKey(agentId, "direct");
      const directTimeoutMarker = await CreateImplementationTimeoutMarker(
        runHost,
        agentWorkspace,
        directSessionKey,
        officeRole,
      );
      cliCalls++;
      const dispatched = (await InParams.runCliCommand(instructionForCli, {
        systemPrompt: combined,
        cwd: agentWorkspace,
        provider: InParams.cliProvider,
        sessionKey: directSessionKey,
      })) as CliRunResult;
      let dispatchedFinal = dispatched;
      const requestedSkills = parseSkillRequest(dispatched?.stdout ?? "");
      const commandSkillResolved = ResolveSkillRequestForAgent(
        agentId,
        rosterSkillBundleRefs,
        requestedSkills,
      );
      if (requestedSkills.length > 0 && cliCalls < maxCliCalls && commandSkillResolved.toInject.length > 0) {
        const injectedPrompt = await InParams.buildRosterDelegationSystemPrompt(
          InParams.projectName,
          promptRole,
          InParams.agentsMetadataJson,
          {
            promptKey: rosterPromptKey || null,
            sequencerStepSuffix: BuildDirectCommandExecutionSuffix(officeRole),
            skillBundleRole: rosterSkillBundleRole || null,
            skillBundleRefs: rosterSkillBundleRefs,
            injectRequestedSkillRefs: commandSkillResolved.toInject,
          },
        );
        if (injectedPrompt != null) {
          cliCalls++;
          dispatchedFinal = (await InParams.runCliCommand(instructionForCli, {
            systemPrompt: injectedPrompt,
            cwd: agentWorkspace,
            provider: InParams.cliProvider,
            sessionKey: directSessionKey,
          })) as CliRunResult;
          const injectedRawDirectOut = CombineCascadeCliOutput(dispatchedFinal);
          const injectedDirectOut = CompactLargeModelOutputForMemory(injectedRawDirectOut);
          if (injectedRawDirectOut.length > 24000) {
            InParams.onCliLog({
              stdin: instructionForCli,
              systemPrompt: injectedPrompt,
              stdout: injectedRawDirectOut,
              stderr: "",
              exit_code: dispatchedFinal?.exit_code ?? -1,
              provider: dispatchedFinal?.provider,
              label: `AgentCommandSkillRaw(${agentId})`,
              officeAgentRole: officeRole,
              skillRequestParsed: requestedSkills.length > 0 ? [...requestedSkills] : null,
              skillInjectedRefs:
                commandSkillResolved.toInject.length > 0
                  ? [...commandSkillResolved.toInject]
                  : null,
              skillRequestDroppedRefs:
                commandSkillResolved.dropped.length > 0
                  ? [...commandSkillResolved.dropped]
                  : null,
            });
          }
          MarkInjectedSkills(agentId, commandSkillResolved.toInject);
          InParams.onCliLog({
            stdin: instructionForCli,
            systemPrompt: injectedPrompt,
            stdout: injectedDirectOut,
            stderr: "",
            exit_code: dispatchedFinal?.exit_code ?? -1,
            provider: dispatchedFinal?.provider,
            label: `AgentCommandSkill(${agentId})`,
            officeAgentRole: officeRole,
            skillRequestParsed: requestedSkills.length > 0 ? [...requestedSkills] : null,
            skillInjectedRefs:
              commandSkillResolved.toInject.length > 0
                ? [...commandSkillResolved.toInject]
                : null,
            skillRequestDroppedRefs:
              commandSkillResolved.dropped.length > 0
                ? [...commandSkillResolved.dropped]
                : null,
          });
        }
      } else if (requestedSkills.length > 0) {
        InParams.onCliLog({
          stdin: instructionForCli,
          systemPrompt: combined,
          stdout: dispatched?.stdout ?? "",
          stderr: dispatched?.stderr ?? "",
          exit_code: dispatched?.exit_code ?? -1,
          provider: dispatched?.provider,
          label: `AgentCommandSkill(${agentId})`,
          officeAgentRole: officeRole,
          skillRequestParsed: requestedSkills.length > 0 ? [...requestedSkills] : null,
          skillInjectedRefs: null,
          skillRequestDroppedRefs:
            commandSkillResolved.dropped.length > 0 ? [...commandSkillResolved.dropped] : null,
        });
      }

      const exitCode = dispatchedFinal?.exit_code ?? -1;
      const rawDirectOut = CombineCascadeCliOutput(dispatchedFinal);
      const reportedPartialArtifactTimeoutFiles =
        exitCode !== 0 && IsImplementationOfficeRole(officeRole)
          ? ExtractPartialArtifactTimeoutFiles(rawDirectOut)
          : [];
      const workspacePartialArtifactTimeoutFiles =
        exitCode !== 0 &&
        IsImplementationOfficeRole(officeRole) &&
        reportedPartialArtifactTimeoutFiles.length === 0
          ? await FindWorkspaceArtifactEvidenceFiles(
            runHost,
            agentWorkspace,
            directTimeoutMarker,
            next.command,
            next.originAssignmentContext,
          )
          : [];
      const observedArtifactProgressFiles =
        exitCode === 0 &&
        IsImplementationOfficeRole(officeRole) &&
        ExtractReportedFilesList(rawDirectOut).length === 0
          ? await FindWorkspaceArtifactEvidenceFiles(
            runHost,
            agentWorkspace,
            directTimeoutMarker,
            next.command,
            next.originAssignmentContext,
          )
          : [];
      await CleanupImplementationTimeoutMarker(runHost, agentWorkspace, directTimeoutMarker);
      const partialArtifactTimeoutFiles = [...new Set([
        ...reportedPartialArtifactTimeoutFiles,
        ...workspacePartialArtifactTimeoutFiles,
      ])];
      const hasPartialArtifactTimeout = partialArtifactTimeoutFiles.length > 0;
      const hasImplementationTimeoutWithoutArtifact =
        exitCode !== 0 &&
        IsImplementationOfficeRole(officeRole) &&
        !hasPartialArtifactTimeout &&
        !IsImplementationTimeoutRepairAssignment(next.command) &&
        IsProviderTimeoutFailureText(rawDirectOut);
      const hasBoundedRepairTimeoutWithoutArtifact =
        exitCode !== 0 &&
        IsImplementationOfficeRole(officeRole) &&
        !hasPartialArtifactTimeout &&
        IsImplementationTimeoutRepairAssignment(next.command) &&
        IsProviderTimeoutFailureText(rawDirectOut);
      const partialArtifactQualityCommands = hasPartialArtifactTimeout
        ? BuildPartialArtifactQualityCommands(
            registry,
            agentId,
            next.command,
            partialArtifactTimeoutFiles,
            next.originAssignmentContext,
          )
        : [];
      const canHandoffPartialArtifact = partialArtifactQualityCommands.length > 0;
      if (rawDirectOut.length > 24000) {
        InParams.onCliLog({
          stdin: instructionForCli,
          systemPrompt: combined,
          stdout: rawDirectOut,
          stderr: "",
          exit_code: exitCode,
          provider: dispatchedFinal?.provider,
          label: `AgentCommandRaw(${agentId})`,
          officeAgentRole: officeRole,
        });
      }
      let combinedOut = CompactLargeModelOutputForMemory(rawDirectOut);
      let effectiveExitCode = exitCode;
      if (hasPartialArtifactTimeout && canHandoffPartialArtifact) {
        combinedOut = BuildPartialArtifactTimeoutCandidateOutput(
          combinedOut,
          partialArtifactTimeoutFiles,
        );
        effectiveExitCode = 0;
      } else if (hasImplementationTimeoutWithoutArtifact || hasBoundedRepairTimeoutWithoutArtifact) {
        combinedOut = BuildImplementationTimeoutReworkCandidateOutput(combinedOut);
        effectiveExitCode = 0;
      } else if (observedArtifactProgressFiles.length > 0) {
        combinedOut = BuildObservedArtifactProgressOutput(
          combinedOut,
          observedArtifactProgressFiles,
        );
      }
      if (dispatchedFinal != null && (combinedOut !== rawDirectOut || effectiveExitCode !== exitCode)) {
        dispatchedFinal = {
          ...dispatchedFinal,
          stdout: combinedOut,
          stderr: "",
          exit_code: effectiveExitCode,
        };
      }
      const directPmOutputHasIncompleteTaskSections =
        officeRole === "pm" && LooksLikeIncompletePmTaskSectionDelegation(combinedOut);
      const repeatedIncompletePmTaskSectionRetry =
        directPmOutputHasIncompleteTaskSections && IsIncompletePmTaskSectionRetryAssignment(next.command);
      if (effectiveExitCode !== 0) {
        allOk = false;
        consecutiveErrorCount++;
        if (consecutiveErrorCount >= 3) {
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: `[시스템 오류 차단] 무한 에러 루프 감지 (최근 ${consecutiveErrorCount}회 실패)`,
            type: "error",
          });
          break;
        } else {
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: `작업 실패 (exit ${effectiveExitCode})`,
            type: "error",
          });
        }
      }

      let hostExecutionOk = true;
      if (effectiveExitCode === 0) {
        const hostExecution = await ExecHostCommandsFromModelOutput(
          combinedOut,
          ReadCascadeCliOutputForHostCommandParsing(dispatchedFinal),
          agentId,
          officeRole,
          buildHostFeedbackSessionKey(directSessionKey),
        );
        combinedOut = hostExecution.combinedOut;
        hostExecutionOk = hostExecution.ok;
        if (dispatchedFinal != null) {
          dispatchedFinal.stdout = combinedOut;
          dispatchedFinal.stderr = "";
        }
        combinedOut = await AppendReportedFileExistenceEvidence(
          runHost,
          ResolveWorkspaceForAgent(agentId),
          officeRole,
          next.command,
          combinedOut,
        );
        if (dispatchedFinal != null) {
          dispatchedFinal.stdout = combinedOut;
          dispatchedFinal.stderr = "";
        }
        if (!hostExecutionOk && InParams.maxCascade <= 1) {
          allOk = false;
        }
      }
      if (effectiveExitCode === 0) {
        consecutiveErrorCount = 0;
        const postHostGateSignal = BuildQualityGateSignal({
          officeRole,
          outputText: combinedOut,
          stepCommand: next.command,
          assignmentContext: next.originAssignmentContext,
          exitCode: effectiveExitCode,
          changedFiles: ExtractReportedFilesList(combinedOut),
        });
        if (postHostGateSignal?.requiresRework) {
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: BuildQualityReworkAgentMessage(officeRole, postHostGateSignal),
            type: "error",
          });
        } else if (!hostExecutionOk) {
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: "호스트 검증 피드백이 작업 완료를 확인하지 못함",
            type: "error",
          });
        } else {
          InParams.onAgentMessage?.({
            agentId,
            agentName: agentDisplayName,
            officeRole,
            text: directPmOutputHasIncompleteTaskSections
              ? "PM handoff가 중간에 잘려 compact 재요청으로 전환"
              : hasPartialArtifactTimeout && canHandoffPartialArtifact
              ? "부분 산출물 생성됨 - 최종 보고 전 타임아웃, 검수 단계로 넘김"
              : "작업 완료",
            type: "done",
          });
        }
      }
      setAgentTask(agentId, officeRole, "");
      InParams.onCliLog({
        stdin: instructionForCli,
        systemPrompt: combined,
        stdout: combinedOut,
        stderr: "",
        exit_code: effectiveExitCode,
        provider: dispatchedFinal?.provider,
        label: `AgentCommand(${agentId})`,
        officeAgentRole: officeRole,
      });
      const directTaskComplete = buildDirectTaskCompletePayloadResult(
        agentId,
        next.command,
        officeRole,
        dispatchedFinal,
        next.originAssignmentContext,
      );
      InParams.onAgentExecutionComplete?.(
        BuildAgentExecutionCompletion(
          agentId,
          agentDisplayName,
          officeRole,
          "direct",
          next.command,
          directTaskComplete.outputText,
          directTaskComplete.exitCode,
          directTaskComplete.payload,
          next.originAssignmentContext,
        ),
      );
      if (effectiveExitCode !== 0) {
        break;
      }
      if (repeatedIncompletePmTaskSectionRetry) {
        allOk = false;
        InParams.onAgentMessage?.({
          agentId,
          agentName: agentDisplayName,
          officeRole,
          text: "PM handoff가 compact 재요청 후에도 잘려서 부분 실행을 막고 중단합니다.",
          type: "error",
        });
        break;
      }

      const nested = suppressNestedModelDelegation && officeRole !== "pm"
        ? []
        : NormalizeNestedCommands(
          directPmOutputHasIncompleteTaskSections
            ? BuildIncompletePmTaskSectionRetryCommands(
                registry,
                next.command,
                combinedOut,
                next.originAssignmentContext,
              )
          : (
            officeRole === "pm"
              ? SanitizePmWorkflowCommands(
                BuildPreferredPmWorkflowCommands(
                  registry,
                  next.originAssignmentContext ?? next.command,
                  rawDirectOut,
                  agentId,
                  next.originAssignmentContext,
                ),
                registry,
              )
              : SequencerParser.ParseWorkflowCommands(combinedOut, registry, agentId).map((command) => ({
                ...command,
                originAssignmentContext: next.originAssignmentContext,
              }))
          ),
          registry,
        );
      const shouldUsePmFallback =
        officeRole === "pm" && nested.length === 0;
      const shouldSuppressQualityOnlyNested =
        nested.length > 0 &&
        (officeRole === "reviewer" || officeRole === "verifier") &&
        !HasRepairExecutionPath(nested, registry);
      const pmFallbackNested =
        officeRole === "pm" &&
        shouldUsePmFallback
          ? BuildPmDelegationFallbackCommands(
              registry,
              next.command,
              combinedOut,
              [],
              next.originAssignmentContext,
            )
          : [];
      const directQualityInputs = [
        {
          officeRole,
          outputText: combinedOut,
          stepCommand: next.command,
          assignmentContext: next.originAssignmentContext,
          exitCode: effectiveExitCode,
          changedFiles: ExtractReportedFilesList(combinedOut),
        },
      ];
      const directQualitySignals = directQualityInputs
        .map((signal) => BuildQualityGateSignal(signal))
        .filter((signal): signal is QualityGateSignal => signal?.requiresRework === true);
      const boundedRepairTimeoutPmRescope =
        hasBoundedRepairTimeoutWithoutArtifact && directQualitySignals.length > 0
          ? BuildImplementationTimeoutPmRescopeCommands(
              registry,
              directQualitySignals,
              next.command,
              next.originAssignmentContext,
            )
          : [];
      const directRequiresQualityRework =
        directQualitySignals.length > 0 && boundedRepairTimeoutPmRescope.length === 0;
      const shouldSuppressFailedQualityNested =
        directRequiresQualityRework &&
        nested.length > 0 &&
        !HasRepairExecutionPath(nested, registry);
      const effectiveNested = shouldSuppressFailedQualityNested || shouldSuppressQualityOnlyNested
        ? []
        : shouldUsePmFallback
          ? pmFallbackNested
        : nested.length > 0
          ? nested
          : pmFallbackNested;
      const directPreferredTargets =
        officeRole === "reviewer" || officeRole === "verifier"
          ? (() => {
              const recentTargets = inferPreferredImplementationTargetsFromCompletionContext(agentId);
              return recentTargets.length > 0
                ? recentTargets
                : InferQualityReworkTargets(
                    registry,
                    next.originAssignmentContext ?? next.command,
                    [],
                  );
            })()
          : hasImplementationTimeoutWithoutArtifact ||
              ShouldPreferCurrentImplementationAgentForQualityRework(
                registry,
                agentId,
                directQualitySignals,
              )
            ? [agentId]
          : [];
      const needsAutoQualityRework =
        shouldSuppressFailedQualityNested ||
        shouldSuppressQualityOnlyNested ||
        (directRequiresQualityRework && !HasRepairExecutionPath(effectiveNested, registry));
      const needsPartialArtifactQuality =
        hasPartialArtifactTimeout && canHandoffPartialArtifact;
      if (needsAutoQualityRework && InParams.maxCascade <= 1) {
        allOk = false;
      }
      if (needsPartialArtifactQuality && InParams.maxCascade <= 1) {
        allOk = false;
      }
      const repeatedVerifierEvidenceGapRework =
        needsAutoQualityRework &&
        ShouldStopRepeatedVerifierEvidenceGap(directQualityInputs, next.command);
      const repeatedImplementationNoArtifactRework =
        needsAutoQualityRework &&
        ShouldStopRepeatedImplementationNoArtifactRework(directQualityInputs, next.command);
      const repeatedSameQualityFailureRework =
        needsAutoQualityRework &&
        ShouldStopRepeatedSameQualityFailure(directQualityInputs, next.command);
      if (repeatedVerifierEvidenceGapRework) {
        allOk = false;
      }
      if (repeatedImplementationNoArtifactRework) {
        allOk = false;
      }
      if (repeatedSameQualityFailureRework) {
        allOk = false;
        InParams.onAgentMessage?.({
          agentId,
          agentName: agentDisplayName,
          officeRole,
          text: "같은 품질 실패가 반복되어 자동 수리를 멈춤",
          type: "error",
        });
      }
      const autoQualityRework =
        needsAutoQualityRework &&
        !repeatedVerifierEvidenceGapRework &&
        !repeatedImplementationNoArtifactRework &&
        !repeatedSameQualityFailureRework
          ? BuildCombinedQualityReworkCommand(
              registry,
              directQualityInputs,
              next.command,
              directPreferredTargets,
              next.originAssignmentContext,
            )
          : [];
      let ranDirectFollowups = false;
      if (
        (effectiveNested.length > 0 ||
          partialArtifactQualityCommands.length > 0 ||
          boundedRepairTimeoutPmRescope.length > 0 ||
          autoQualityRework.length > 0) &&
        InParams.maxCascade > 1
      ) {
        const pending = NormalizeNestedCommands(
          [
            ...effectiveNested,
            ...partialArtifactQualityCommands,
            ...boundedRepairTimeoutPmRescope,
            ...autoQualityRework,
          ],
          registry,
        );
        ranDirectFollowups = pending.length > 0;
        const completedCommandKeys = new Set<string>();
        
        while (pending.length > 0) {
          if (InParams.abortSignal?.aborted || !allOk) {
            allOk = false;
            break;
          }
          
          const readyNodes = SelectReadyCascadeNodes(pending, completedCommandKeys);
          if (readyNodes.length === 0) {
            allOk = false;
            InParams.onAgentMessage?.({
              agentId,
              agentName: agentDisplayName,
              officeRole,
              text: `의존성 그래프가 막혀 후속 작업을 중단합니다: ${SummarizeBlockedCascadeDependencies(pending)}`,
              type: "error",
            });
            break;
          }
          
          const branchRuns = await Promise.all(
            readyNodes.map(async (child) => {
              const branchCompletions: AgentExecutionCompletion[] = [];
              const ok = await this.RunAgentCommandCascade({
                ...InParams,
                seed: [child],
                maxCascade: InParams.maxCascade - 1,
                injectedSkillSetByAgentId,
                suppressNestedModelDelegation:
                  suppressNestedModelDelegation ||
                  pending.some((candidate) => candidate.commandKey !== child.commandKey),
                onAgentExecutionComplete: (completion) => {
                  branchCompletions.push(completion);
                  InParams.onAgentExecutionComplete?.(completion);
                },
              });
              return { child, ok, branchCompletions };
            }),
          );
          
          if (branchRuns.some((run) => !run.ok)) {
            allOk = false;
          }

          for (const run of branchRuns) {
            if (
              ShouldPruneSiblingQualityNodesAfterChildBranch(
                registry,
                run.child,
                run.branchCompletions,
              )
            ) {
              PruneSiblingQualityNodesForResolvedBranch(pending, run.child, registry);
            }
            if (
              ShouldPruneDescendantNodesAfterPmRescope(
                registry,
                run.child,
                run.branchCompletions,
              )
            ) {
              PruneDescendantNodesForSupersededCommand(pending, run.child.commandKey);
            }
          }

          for (const node of readyNodes) {
            completedCommandKeys.add(node.commandKey);
            const idx = pending.indexOf(node);
            if (idx > -1) pending.splice(idx, 1);
          }
        }
      }
      const shouldSuppressStaleQualityFailureFollowup =
        needsAutoQualityRework && ranDirectFollowups;
      if (
        allOk &&
        !suppressNestedModelDelegation &&
        next.senderId != null &&
        next.senderId.trim() !== "" &&
        !shouldSuppressStaleQualityFailureFollowup &&
        !ShouldSkipImplementationSenderFollowup(registry, next.senderId, agentId)
      ) {
        queue.push({
          agentId: next.senderId.trim().toLowerCase(),
          command: buildDirectSenderFollowupPayload(
            agentId,
            next.command,
            officeRole,
            dispatchedFinal,
            directTaskComplete,
            ranDirectFollowups,
          ),
          senderId: agentId,
          originAssignmentContext: next.originAssignmentContext,
        });
      }
    }

    if (queue.length > 0) allOk = false;
    this.stateMachine.Transit(allOk ? "Completed" : "Failed");
    return allOk;
  }
}
