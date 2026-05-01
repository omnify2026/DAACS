import { pathToFileURL } from "node:url";

import { useCliLogStore } from "./cliLogStore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runCliLogStoreRegressionTests(): Promise<void> {
  const longBlock = "x".repeat(12000);
  const longTrace = Array.from({ length: 20 }, (_, index) => `trace-${index}-${"y".repeat(500)}`);

  useCliLogStore.getState().clear();
  useCliLogStore.getState().addEntry({
    stdin: longBlock,
    systemPrompt: longBlock,
    stdout: longBlock,
    stderr: longBlock,
    exit_code: 0,
    skillRequestParsed: longTrace,
    skillInjectedRefs: longTrace,
    skillRequestDroppedRefs: longTrace,
  });

  const [entry] = useCliLogStore.getState().entries;
  assert(entry != null, "cliLogStore should keep the inserted entry");
  assert((entry.stdin ?? "").length < longBlock.length, "cliLogStore should truncate oversized stdin payloads");
  assert((entry.systemPrompt ?? "").length < longBlock.length, "cliLogStore should truncate oversized system prompts");
  assert(entry.stdout.length < longBlock.length, "cliLogStore should truncate oversized stdout payloads");
  assert(entry.stderr.length < longBlock.length, "cliLogStore should truncate oversized stderr payloads");
  assert(
    (entry.stdout.includes("...[truncated ") || entry.stderr.includes("...[truncated ")),
    "cliLogStore should mark truncated log payloads",
  );
  assert(
    (entry.skillRequestParsed?.length ?? 0) <= 12 &&
      (entry.skillInjectedRefs?.length ?? 0) <= 12 &&
      (entry.skillRequestDroppedRefs?.length ?? 0) <= 12,
    "cliLogStore should cap oversized skill trace arrays before they hit Zustand state",
  );

  useCliLogStore.getState().clear();
  console.log("cliLogStore truncation regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runCliLogStoreRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
