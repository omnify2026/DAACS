function countUnescapedChars(text: string, target: string): number {
  let count = 0;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === target) count += 1;
  }
  return count;
}

function extractHeredocDelimiter(commandLine: string): string | null {
  const markerIndex = commandLine.indexOf("<<");
  if (markerIndex < 0 || commandLine.slice(markerIndex + 2).startsWith("<")) return null;
  const afterMarker = commandLine
    .slice(markerIndex + 2)
    .replace(/^-/, "")
    .trimStart();
  const token = afterMarker.split(/[\s;&|]/, 1)[0]?.trim() ?? "";
  const delimiter = token.replace(/^['"`]|['"`]$/g, "").trim();
  return delimiter === "" ? null : delimiter;
}

function hasUnterminatedHeredoc(command: string): boolean {
  const lines = String(command ?? "").split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const delimiter = extractHeredocDelimiter(lines[idx] ?? "");
    if (delimiter == null) continue;
    const hasTerminator = lines.slice(idx + 1).some((line) => line.trim() === delimiter);
    if (!hasTerminator) return true;
  }
  return false;
}

export function isLikelyMalformedShellCommand(command: string): boolean {
  const value = (command ?? "").trim();
  if (value === "") return true;
  if (value.startsWith("```")) return true;
  if (/^[|&;<>]/.test(value)) return true;
  if (hasUnterminatedHeredoc(value)) return true;
  if (countUnescapedChars(value, "'") % 2 !== 0) return true;
  if (countUnescapedChars(value, '"') % 2 !== 0) return true;
  if (countUnescapedChars(value, "`") % 2 !== 0) return true;
  return false;
}

export function isSequencerInternalArtifactCommand(command: string): boolean {
  const c = (command ?? "").trim();
  if (c === "") return false;
  if (/^\[\/?OutputCompacted\]$/i.test(c)) return true;
  if (/^\{END_TASK_\d+\}$/i.test(c)) return true;
  if (/^##\s+Preserved tagged blocks$/i.test(c)) return true;
  return /^\[\/?(?:STEP_\d+_RESULT|SEQUENCER_PLAN|AGENT_COMMANDS|Command|Commands|FilesCreated|Verification|VerificationStatus|HostFeedbackStatus|ReviewVerdict|ReviewFindings|OpenRisks|TaskComplete|ArtifactFileStatus|ImplementationTimeout|DAACS_PARTIAL_ARTIFACT_TIMEOUT|PartialArtifactTimeout)\]$/i.test(c);
}

function isStandaloneForegroundPreviewServerCommand(command: string): boolean {
  const value = (command ?? "").trim();
  if (value === "") return false;
  const lower = value.toLowerCase();
  const launchesPreviewServer =
    /\bpython3?\s+-m\s+http\.server\b/.test(lower) ||
    /\b(?:npm|pnpm)\b[\s\S]{0,120}\b(?:run\s+)?(?:dev|preview)\b/.test(lower) ||
    /\b(?:npx\s+)?vite\b[\s\S]{0,80}\b(?:dev|preview)?\b/.test(lower) ||
    /\b(?:npx\s+)?serve\b/.test(lower);
  if (!launchesPreviewServer) return false;
  const backgroundsServer =
    /\bnohup\b/.test(lower) ||
    /(?:^|[;&(])[\s\S]{0,220}&(?:\s|$)/.test(lower);
  return !backgroundsServer;
}

function touchesForbiddenDaacsPythonServices(command: string): boolean {
  const value = (command ?? "").trim();
  if (value === "") return false;
  return /(?:^|[\s"'`=;:])(?:\.[/\\])?(?:DAACS_OS[/\\])?services[/\\]/i.test(value);
}

function launchesPythonServerCommand(command: string): boolean {
  const lower = (command ?? "").trim().toLowerCase();
  if (lower === "") return false;
  return (
    /\b(?:uvicorn|gunicorn|hypercorn)\b/.test(lower) ||
    /\bfastapi\s+(?:dev|run)\b/.test(lower) ||
    /\bflask\s+run\b/.test(lower) ||
    /\bpython3?\b[\s\S]{0,160}\b(?:uvicorn|flask|fastapi|server\.py)\b/.test(lower)
  );
}

export function isInvalidSequencerCliCommand(command: string): boolean {
  const c = (command ?? "").trim();
  if (c === "") return true;
  const lower = c.toLowerCase();
  if (isSequencerInternalArtifactCommand(c)) return true;
  if (lower.includes("[outputcompacted]")) return true;
  if (lower === "true" || lower === ":" || lower.startsWith("#")) return true;
  if (lower.startsWith("echo ") && c.includes(">")) return true;
  if (lower.startsWith("type nul >")) return true;
  if (lower.startsWith("copy nul ")) return true;
  if (lower.includes(" > plan.md")) return true;
  if (lower.includes(' > "plan.md"')) return true;
  if (lower.includes("host must run shell commands")) return true;
  if (lower.includes("execute this step")) return true;
  if (lower.includes("[command]")) return true;
  if (lower.includes("sequencer protocol")) return true;
  if (lower.includes("do not reply with only")) return true;
  if (lower.includes("placeholder")) return true;
  if (lower.startsWith("first shell command")) return true;
  if (lower.startsWith("second shell command")) return true;
  if (lower.startsWith("```")) return true;
  if (/^`[^`]+`\s+\S/.test(c)) return true;
  if (
    /[\u3131-\uD79D]/.test(c) &&
    /(?:실행\s*결과|미확인|검증|확인|통과|실패|필요|호스트|명령|아직|아래)/.test(c) &&
    !/^(?:rg|grep|sed|awk|printf|echo)\b/.test(lower)
  ) {
    return true;
  }
  if ((lower.startsWith("echo ") || lower.startsWith("printf ")) && !c.includes(">") && !c.includes("|")) {
    return true;
  }
  if (touchesForbiddenDaacsPythonServices(c)) return true;
  if (launchesPythonServerCommand(c)) return true;
  if (isStandaloneForegroundPreviewServerCommand(c)) return true;
  if (/\bgit\s+reset\s+--hard\b/i.test(c)) return true;
  if (/\bgit\s+checkout\b[\s\S]*\s--(?:\s|$)/i.test(c)) return true;
  if (/\brm\s+-rf\b/i.test(c)) return true;
  if (isLikelyMalformedShellCommand(c)) return true;
  return false;
}
