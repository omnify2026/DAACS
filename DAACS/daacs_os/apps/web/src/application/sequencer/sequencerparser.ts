import type { AgentRegistry } from "./AgentRegistry";
import type { ParsedPlanStep, SequencerStepRunRecord } from "./types";

export class SequencerParser {
  private static readonly PRIOR_STEP_HEAD_CHARS = 500;
  private static readonly PRIOR_STEP_TAIL_CHARS = 700;
  private static readonly PRIOR_STEP_MAX_FILES = 8;

  private static SummarizeStepContent(InText: string, InMaxChars: number): string {
    const text = (InText ?? "").trim();
    if (text === "") return "(no output)";
    if (text.length <= InMaxChars) return text;
    const headLen = Math.min(this.PRIOR_STEP_HEAD_CHARS, Math.max(200, Math.floor(InMaxChars * 0.35)));
    const tailLen = Math.min(this.PRIOR_STEP_TAIL_CHARS, Math.max(250, InMaxChars - headLen));
    if (headLen + tailLen >= text.length) return text;
    const omitted = text.length - headLen - tailLen;
    return `${text.slice(0, headLen).trim()}\n... [${omitted} chars omitted] ...\n${text.slice(text.length - tailLen).trim()}`;
  }

  private static ExtractFilesCreated(InText: string): string[] {
    const text = InText ?? "";
    const taggedMatch = text.match(/\[FilesCreated\]([\s\S]*?)\[\/FilesCreated\]/i);
    const taggedFiles = taggedMatch?.[1] == null ? [] : taggedMatch[1]
      .split("\n")
      .map((f) => this.NormalizeReportedFilePath(f))
      .filter((value) => this.LooksLikeReportableFilePath(value));
    const taskCompleteFiles = this.ExtractTaskCompleteChangedFiles(text);
    const looseFiles = this.ExtractLooseFileList(text);
    return [...new Set([...taggedFiles, ...taskCompleteFiles, ...looseFiles])]
      .slice(0, this.PRIOR_STEP_MAX_FILES);
  }

  private static NormalizeReportedFilePath(InValue: string): string {
    return (InValue ?? "")
      .trim()
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^`+|`+$/g, "")
      .replace(/^['"]+|['"]+$/g, "")
      .replace(/[),.;:]+$/g, "")
      .trim();
  }

  private static LooksLikeReportableFilePath(InValue: string): boolean {
    const text = this.NormalizeReportedFilePath(InValue);
    if (text === "" || /\s/.test(text)) return false;
    if (/^(?:https?:|data:|mailto:)/i.test(text)) return false;
    if (/(?:^|\/)(?:node_modules|dist|build|target|coverage|playwright-report|test-results)\//i.test(text)) {
      return false;
    }
    return /(?:^|\/)[^/]+\.(?:html|css|js|jsx|ts|tsx|vue|svelte|json|md|py|rs|go|java|kt|swift|sql|yaml|yml|toml|sh|mjs|cjs)$/i.test(text);
  }

  private static ExtractTaskCompleteChangedFiles(InText: string): string[] {
    const match = (InText ?? "").match(/\[TaskComplete\]([\s\S]*?)\[\/TaskComplete\]/i);
    if (match?.[1] == null) return [];
    try {
      const parsed = JSON.parse(match[1]) as { ChangedFiles?: unknown };
      if (!Array.isArray(parsed.ChangedFiles)) return [];
      return parsed.ChangedFiles
        .map((value) => this.NormalizeReportedFilePath(String(value ?? "")))
        .filter((value) => this.LooksLikeReportableFilePath(value));
    } catch {
      return [];
    }
  }

  private static ExtractLooseFileList(InText: string): string[] {
    const out: string[] = [];
    let captureBudget = 0;
    for (const rawLine of (InText ?? "").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (
        /^(?:files?\s+(?:created|changed|modified|updated)|changed\s+files?|created\s+files?|files?\s*:)/i.test(line) ||
        /^(?:생성|수정|변경)(?:한)?\s*파일|^파일\s*(?:목록|변경|생성|수정)/i.test(line)
      ) {
        captureBudget = 8;
        for (const token of line.split(/[,]/)) {
          const normalized = this.NormalizeReportedFilePath(token.replace(/^[^:]*:/, ""));
          if (this.LooksLikeReportableFilePath(normalized)) out.push(normalized);
        }
        continue;
      }
      if (captureBudget <= 0) continue;
      if (line === "" || /^\[\/?[A-Za-z0-9_]+\]/.test(line)) {
        captureBudget = 0;
        continue;
      }
      const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (bullet?.[1] == null) {
        captureBudget -= 1;
        continue;
      }
      for (const token of bullet[1].split(/[,]/)) {
        const normalized = this.NormalizeReportedFilePath(token);
        if (this.LooksLikeReportableFilePath(normalized)) out.push(normalized);
      }
      captureBudget -= 1;
    }
    return out;
  }

  private static StripFilesCreatedBlock(InText: string): string {
    return (InText ?? "").replace(/\[FilesCreated\][\s\S]*?\[\/FilesCreated\]/gi, "").trim();
  }

  private static ParseLoosePlanStepLine(
    InLine: string,
    InFallbackStepNumber: number,
  ): ParsedPlanStep | null {
    const rawLine = InLine ?? "";
    const line = rawLine.trim();
    if (line === "") return null;

    if (/^\s+(?:[-*•]|\d+[.)])\s+/.test(rawLine)) {
      return null;
    }

    const namedCard = line.match(/^(?:카드|card)\s*(\d+)\s*[).:-]\s*(.+)$/i);
    if (namedCard) {
      const stepNumber = Number(namedCard[1]);
      const rest = (namedCard[2] ?? "").trim();
      if (!stepNumber || rest === "") return null;
      return { stepNumber, task: rest, routedAgentId: null };
    }

    const numbered = line.match(/^(?:step\s*)?(\d+)\s*(?:[.):]|-)\s*(.+)$/i);
    if (numbered) {
      const stepNumber = Number(numbered[1]);
      const rest = (numbered[2] ?? "").trim();
      if (!stepNumber || rest === "") return null;
      const arrow = rest.match(/^([a-z0-9_]+)\s*->\s*(.+)$/i);
      if (arrow) {
        return {
          stepNumber,
          task: arrow[2].trim(),
          routedAgentId: arrow[1].trim().toLowerCase(),
        };
      }
      return { stepNumber, task: rest, routedAgentId: null };
    }

    const bullet = line.match(/^[-*•]\s+(.+)$/);
    if (bullet) {
      const rest = (bullet[1] ?? "").trim();
      if (rest === "") return null;
      const arrow = rest.match(/^([a-z0-9_]+)\s*->\s*(.+)$/i);
      if (arrow) {
        return {
          stepNumber: InFallbackStepNumber,
          task: arrow[2].trim(),
          routedAgentId: arrow[1].trim().toLowerCase(),
        };
      }
      return { stepNumber: InFallbackStepNumber, task: rest, routedAgentId: null };
    }

    return null;
  }

  public static BuildPriorStepsBlock(InPrior: SequencerStepRunRecord[], InMaxStdout: number): string {
    const maxPerStep = Math.min(InMaxStdout, 1400);
    const parts: string[] = [];
    for (const { row, stepResult } of InPrior) {
      if (stepResult == null) continue;
      const exitCode = stepResult.exit_code ?? -1;
      const stdout = (stepResult.stdout ?? "").trim();
      const stderr = (stepResult.stderr ?? "").trim();
      const raw = [stdout, stderr].filter((v) => v.length > 0).join("\n").trim() || "(no output)";

      // Extract only the STEP_n_RESULT block if present, otherwise use raw
      const stepResultMatch = raw.match(/\[STEP_\d+_RESULT\]([\s\S]*?)\[\/STEP_\d+_RESULT\]/i);
      const extracted = stepResultMatch?.[1]?.trim() ?? raw;
      const files = this.ExtractFilesCreated(extracted);
      const compactionMarker = raw.includes("[OutputCompacted]")
        ? "[OutputCompacted]\nPrior step output was compacted for downstream memory; raw output remains in trace logs.\n[/OutputCompacted]\n"
        : "";
      const content = this.SummarizeStepContent(
        `${compactionMarker}${this.StripFilesCreatedBlock(extracted)}`,
        maxPerStep,
      );

      let entry = `### Step ${row.stepNumber}: ${row.command}\nStatus: ${exitCode === 0 ? "success" : `failed (exit ${exitCode})`}\n${content}`;
      if (files.length > 0) {
        entry += `\nFiles: ${files.join(", ")}`;
      }
      parts.push(entry);
    }
    if (parts.length === 0) return "";
    return `## Prior steps (summaries — maintain consistency)\n\n${parts.join("\n\n")}\n\n`;
  }

  public static ExtractPlanBody(InText: string): string {
    const text = (InText ?? "").trim();
    if (!text) return "";
    const closed = text.match(/\[SEQUENCER_PLAN\]([\s\S]*?)\[\/SEQUENCER_PLAN\]/i);
    if (closed?.[1] != null) return closed[1].trim();
    const open = text.match(/\[SEQUENCER_PLAN\]([\s\S]*)/i);
    if (open?.[1] != null) {
      const openBody = open[1].trim();
      const stop = openBody.search(/\[(?:AGENT_COMMANDS|FilesCreated|TaskComplete|ReviewVerdict|VerificationStatus|STEP_\d+_RESULT)\]/i);
      return (stop >= 0 ? openBody.slice(0, stop) : openBody).trim();
    }
    if (this.LooksLikeCompletedImplementationOutput(text)) return "";
    return text;
  }

  private static LooksLikeCompletedImplementationOutput(InText: string): boolean {
    const text = (InText ?? "").trim();
    if (text === "") return false;
    if (/\[(?:FilesCreated|TaskComplete|ReviewVerdict|VerificationStatus|STEP_\d+_RESULT)\]/i.test(text)) {
      return true;
    }
    const hasCompletionClaim =
      /\b(?:completed|implemented|created|modified|updated|wrote|generated|fixed)\b/i.test(text) ||
      /(?:완료|구현|생성|수정|변경|작성|고쳤)/i.test(text);
    if (!hasCompletionClaim) return false;
    return /(?:^|\s|`)(?:package\.json|index\.html|vite\.config\.[a-z]+|tsconfig\.json|src\/[^\s`]+?\.(?:ts|tsx|js|jsx|css|json))/i.test(text);
  }

  public static ParsePlanSteps(InStdout: string): ParsedPlanStep[] {
    const body = this.ExtractPlanBody(InStdout);
    if (!body) return [];
    const rawLines = body.split(/\r?\n/).filter((line) => line.trim() !== "");
    const commonIndent = rawLines.reduce((min, line) => {
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      return Math.min(min, indent);
    }, Number.POSITIVE_INFINITY);
    const lines = rawLines.map((line) => line.slice(Number.isFinite(commonIndent) ? commonIndent : 0));
    const stepMap = new Map<number, ParsedPlanStep>();
    let fallbackStepNumber = 1;
    for (const line of lines) {
      const parsed = this.ParseLoosePlanStepLine(line, fallbackStepNumber);
      if (parsed == null) continue;
      stepMap.set(parsed.stepNumber, parsed);
      fallbackStepNumber = Math.max(fallbackStepNumber, parsed.stepNumber + 1);
    }
    const ordered = Array.from(stepMap.keys()).sort((a, b) => a - b);
    return ordered.map((k) => stepMap.get(k) as ParsedPlanStep);
  }

  public static ParseAgentCommands(
    InStdout: string,
    InRegistry: AgentRegistry,
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    return this.ParseTaggedAgentCommands(InStdout, InRegistry, ["AGENT_COMMANDS"], InDefaultSenderId);
  }

  public static ParseWorkflowCommands(
    InStdout: string,
    InRegistry: AgentRegistry,
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    return this.ParseTaggedAgentCommands(InStdout, InRegistry, ["AGENT_COMMANDS"], InDefaultSenderId);
  }

  private static ParseTaggedAgentCommands(
    InStdout: string,
    InRegistry: AgentRegistry,
    InTags: string[],
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    const text = (InStdout ?? "").trim();
    const inner =
      InTags.map((tag) => this.ExtractTaggedBlock(text, tag)).find((value) => value != null && value !== "") ?? null;
    if (inner == null || inner === "") return [];
    const jsonOut = this.ParseAgentCommandsJsonArray(inner, InRegistry, InDefaultSenderId);
    if (jsonOut.length > 0) return jsonOut;
    const looseJsonOut = this.ParseAgentCommandsLooseObjectList(inner, InRegistry, InDefaultSenderId);
    if (looseJsonOut.length > 0) return looseJsonOut;
    const markdownOut = this.ParseAgentCommandsMarkdownList(inner, InRegistry, InDefaultSenderId);
    if (markdownOut.length > 0) return markdownOut;
    const outLegacy: Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> = [];
    const lines = inner.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      if (line.startsWith("{") || line.startsWith("[")) continue;
      const arrow = line.indexOf("->");
      if (arrow === -1) continue;
      const agentId = this.NormalizeAgentIdSafe(InRegistry, line.slice(0, arrow));
      const command = line.slice(arrow + 2).trim();
      if (!agentId || !command) continue;
      const senderId = this.NormalizeAgentIdSafe(InRegistry, String(InDefaultSenderId ?? ""));
      outLegacy.push({ agentId, command, senderId: senderId !== "" ? senderId : null, dependsOn: [] });
    }
    return outLegacy;
  }

  private static ParseAgentCommandsJsonArray(
    InBody: string,
    InRegistry: AgentRegistry,
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    const stripped = this.StripMarkdownFence(InBody);
    if (!stripped) return [];
    const candidates: string[] = [stripped];
    const open = stripped.indexOf("[");
    const close = stripped.lastIndexOf("]");
    if (open >= 0 && close > open) {
      const sliced = stripped.slice(open, close + 1);
      if (sliced !== stripped) candidates.push(sliced);
    }
    for (const cand of candidates) {
      try {
        const parsed: unknown = JSON.parse(cand);
        const rawList = Array.isArray(parsed)
          ? parsed
          : parsed != null && typeof parsed === "object"
            ? [parsed]
            : [];
        const out: Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> = [];
        for (const item of rawList) {
          if (item == null || typeof item !== "object") continue;
          const o = item as Record<string, unknown>;
          const nameRaw = o.AgentName ?? o.agentName ?? o.agent_id ?? o.agentId ?? o.id;
          const cmdRaw = o.Commands ?? o.commands ?? o.command ?? o.task ?? o.instruction;
          const senderRaw = o.CommandSender ?? o.commandSender ?? o.sender ?? o.senderId;
          const agentId = this.NormalizeAgentIdSafe(InRegistry, String(nameRaw ?? ""));
          const command = String(cmdRaw ?? "").trim();
          const senderIdParsed = this.NormalizeAgentIdSafe(InRegistry, String(senderRaw ?? ""));
          const senderIdDefault = this.NormalizeAgentIdSafe(InRegistry, String(InDefaultSenderId ?? ""));
          const senderId = senderIdParsed !== "" ? senderIdParsed : senderIdDefault !== "" ? senderIdDefault : null;
          if (!agentId || !command) continue;
          
          let dependsOn: string[] = [];
          const depsRaw = o.DependsOn ?? o.dependsOn ?? o.depends_on;
          if (Array.isArray(depsRaw)) {
             dependsOn = depsRaw.map(d => this.NormalizeAgentIdSafe(InRegistry, String(d))).filter(d => d !== "");
          }
          
          out.push({ agentId, command, senderId, dependsOn });
        }
        if (out.length > 0) return out;
      } catch {
        // Loose parsing is best-effort; malformed JSON falls back to other parsers.
      }
    }
    return [];
  }

  private static ParseAgentCommandsLooseObjectList(
    InBody: string,
    InRegistry: AgentRegistry,
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    const body = this.StripMarkdownFence(InBody);
    if (body === "") return [];
    const out: Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> = [];
    const objectMatches = body.match(/\{[\s\S]*?\}/g) ?? [];
    for (const rawObject of objectMatches) {
      const nameMatch = rawObject.match(/"(?:AgentName|agentName|agent_id|agentId|id)"\s*:\s*"([^"]+)"/i);
      const commandMatch =
        rawObject.match(/"(?:Commands|commands|command|task|instruction)"\s*:\s*"([\s\S]*?)"\s*(?:,|\})/i) ??
        rawObject.match(/"(?:Commands|commands|command|task|instruction)"\s*:\s*([\s\S]*?)\s*(?:,|\})/i);
      const senderMatch = rawObject.match(/"(?:CommandSender|commandSender|sender|senderId)"\s*:\s*"([^"]+)"/i);
      const agentId = this.NormalizeAgentIdSafe(InRegistry, String(nameMatch?.[1] ?? ""));
      const command = this.DecodeLooseJsonString(String(commandMatch?.[1] ?? ""));
      const senderIdParsed = this.NormalizeAgentIdSafe(InRegistry, String(senderMatch?.[1] ?? ""));
      const senderIdDefault = this.NormalizeAgentIdSafe(InRegistry, String(InDefaultSenderId ?? ""));
      const senderId = senderIdParsed !== "" ? senderIdParsed : senderIdDefault !== "" ? senderIdDefault : null;
      if (!agentId || !command) continue;
      
      let dependsOn: string[] = [];
      const depsMatch = rawObject.match(/"(?:DependsOn|dependsOn|depends_on)"\s*:\s*\[([\s\S]*?)\]/i);
      if (depsMatch?.[1]) {
        dependsOn = depsMatch[1].split(",").map(d => this.NormalizeAgentIdSafe(InRegistry, d.replace(/"/g, "").trim())).filter(d => d !== "");
      }
      
      out.push({ agentId, command, senderId, dependsOn });
    }
    return out;
  }

  private static ParseAgentCommandsMarkdownList(
    InBody: string,
    InRegistry: AgentRegistry,
    InDefaultSenderId?: string | null,
  ): Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> {
    const lines = this.StripMarkdownFence(InBody)
      .split(/\r?\n/)
      .map((line) => line.trimEnd());
    const out: Array<{ agentId: string; command: string; senderId: string | null; dependsOn: string[] }> = [];
    const senderIdDefault = this.NormalizeAgentIdSafe(InRegistry, String(InDefaultSenderId ?? ""));
    let currentAgentId = "";
    let currentCommandLines: string[] = [];
    let currentDependsOn: string[] = [];

    const normalizeCommandLines = (lines: string[]): string =>
      lines
        .map((line) =>
          line
            .replace(/^\s*(?:[-*•]+|\d+[.)])\s*/, "")
            .replace(/^(?:작업|task|commands?|instruction|지시)\s*[:：]\s*/i, "")
            .trim(),
        )
        .filter((line) => line !== "")
        .join("\n")
        .trim();
    const splitMarkdownCommandGroups = (lines: string[]): string[] => {
      const firstContentLine = lines.find((line) => line.trim() !== "") ?? "";
      if (firstContentLine !== "" && !/^(?:[-*•]+|\d+[.)])\s*/.test(firstContentLine.trim())) {
        const command = normalizeCommandLines(lines);
        return command !== "" ? [command] : [];
      }
      const splitStarts: number[] = [];
      lines.forEach((rawLine, index) => {
        const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
        const line = rawLine.trim();
        const item = line.match(/^(?:[-*•]+|\d+[.)])\s*(.+)$/);
        if (item?.[1] == null || indent > 2) return;
        const content = item[1].trim();
        const isMetadataLine =
          /^(?:작업|task|commands?|instruction|지시|생성\s*파일|created\s+files?|files?)\s*[:：]/i.test(content);
        if (!isMetadataLine) splitStarts.push(index);
      });
      if (splitStarts.length < 2) {
        const command = normalizeCommandLines(lines);
        return command !== "" ? [command] : [];
      }
      const groups: string[] = [];
      splitStarts.forEach((start, index) => {
        const end = splitStarts[index + 1] ?? lines.length;
        const command = normalizeCommandLines(lines.slice(start, end));
        if (command !== "") groups.push(command);
      });
      return groups;
    };
    const flush = () => {
      if (currentAgentId === "") return;
      const commands = splitMarkdownCommandGroups(currentCommandLines);
      for (const command of commands) {
        out.push({
          agentId: currentAgentId,
          command,
          senderId: senderIdDefault !== "" ? senderIdDefault : null,
          dependsOn: [...new Set(currentDependsOn)],
        });
      }
      currentAgentId = "";
      currentCommandLines = [];
      currentDependsOn = [];
    };

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line === "") continue;
      const header = line.match(/^(?:[-*•]?\s*)?(?:\d+[.)]\s*)?\(?\s*(?:to|agent|agentname)\s*[:：]\s*([^|)\n]+?)(?:\s*\|\s*id\s*[:：]\s*([^)\n]+?))?\s*\)?\s*$/i);
      if (header?.[1] != null || header?.[2] != null) {
        flush();
        currentAgentId = this.NormalizeAgentIdSafe(InRegistry, String(header[2] ?? header[1] ?? ""));
        continue;
      }
      const namedHeader = line.match(
        /^(?:[-*•]\s*)?(?:\d+[.)]\s*)?([a-z0-9_-]+)\s*(?:\(([^)]*)\)\s*[:：]?|[:：])\s*(.*)$/i,
      );
      if (namedHeader?.[1] != null) {
        const meta = String(namedHeader[2] ?? "");
        const explicitId = meta.match(/(?:^|[,;\s])id\s*=\s*([^,;\s)]+)/i)?.[1] ?? "";
        const agentId =
          this.NormalizeAgentIdSafe(InRegistry, explicitId) ||
          this.NormalizeAgentIdSafe(InRegistry, String(namedHeader[1] ?? ""));
        if (agentId !== "") {
          flush();
          currentAgentId = agentId;
          const trailingCommand = String(namedHeader[3] ?? "").trim();
          if (trailingCommand !== "") currentCommandLines.push(trailingCommand);
          continue;
        }
      }
      const dashHeader = line.match(/^(?:[-*•]\s*)?(?:\d+[.)]\s*)?([a-z0-9_-]+)\s*[—–-]\s*(.+)$/i);
      if (dashHeader?.[1] != null) {
        const agentId = this.NormalizeAgentIdSafe(InRegistry, String(dashHeader[1] ?? ""));
        if (agentId !== "") {
          flush();
          currentAgentId = agentId;
          const title = String(dashHeader[2] ?? "").trim();
          if (title !== "") currentCommandLines.push(title);
          continue;
        }
      }
      const dependsMatch = line.match(/^(?:[-*•]\s*)?(?:DependsOn|depends_on|의존)\s*[:：]\s*(.+)$/i);
      if (dependsMatch?.[1] != null && currentAgentId !== "") {
        currentDependsOn.push(
          ...dependsMatch[1]
            .split(/[,/|]/)
            .map((value) => this.NormalizeAgentIdSafe(InRegistry, value))
            .filter((value) => value !== ""),
        );
        continue;
      }
      if (currentAgentId !== "") currentCommandLines.push(rawLine);
    }
    flush();
    return out;
  }

  private static StripMarkdownFence(InText: string): string {
    let text = (InText ?? "").trim();
    if (!text.startsWith("```")) return text;
    text = text.replace(/^```(?:json)?\s*/i, "");
    const fenceEnd = text.lastIndexOf("```");
    if (fenceEnd > 0) text = text.slice(0, fenceEnd);
    return text.trim();
  }

  private static ExtractTaggedBlock(InText: string, InTag: string): string | null {
    const text = (InText ?? "").trim();
    const tag = (InTag ?? "").trim();
    if (text === "" || tag === "") return null;
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const closed = text.match(new RegExp(`\\[${escapedTag}\\]([\\s\\S]*?)\\[\\/${escapedTag}\\]`, "i"));
    if (closed?.[1] != null) return closed[1].trim();
    const open = text.match(new RegExp(`\\[${escapedTag}\\]([\\s\\S]*)`, "i"));
    if (open?.[1] != null) return open[1].trim();
    return null;
  }

  private static NormalizeAgentIdSafe(InRegistry: AgentRegistry, InAgentId: string): string {
    try {
      return InRegistry.NormalizeAgentId(InAgentId);
    } catch {
      return "";
    }
  }

  private static DecodeLooseJsonString(InValue: string): string {
    const v = (InValue ?? "").trim();
    if (v === "") return "";
    if (v.startsWith("\"") && v.endsWith("\"")) {
      try {
        const parsed = JSON.parse(v);
        if (typeof parsed === "string") return parsed.trim();
      } catch {
        // Keep the original loose value when JSON string decoding fails.
      }
    }
    return v
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  }
}
