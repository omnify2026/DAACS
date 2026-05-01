import { pathToFileURL } from "node:url";

import { getAgentMeta } from "./agent";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

export async function runAgentTypeRegressionTests(): Promise<void> {
  const meta = getAgentMeta("developer_front", {
    name: "Frontend Product Builder",
    title: "Frontend Product Builder",
  });

  assert(
    meta.name === "Frontend Product Builder",
    "agent metadata overrides should keep user-created display names above bundled role defaults",
  );
  assert(
    meta.title === "Frontend Product Builder",
    "agent metadata overrides should keep user-created titles above bundled role defaults",
  );

  console.log("agent type metadata regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAgentTypeRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
