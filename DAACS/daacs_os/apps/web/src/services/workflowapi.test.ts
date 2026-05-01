import { pathToFileURL } from "node:url";

import {
  getOvernightWorkflowReport,
  getOvernightWorkflowStatus,
  resumeOvernightWorkflow,
  startOvernightWorkflow,
  startWorkflow,
  stopOvernightWorkflow,
  stopWorkflow,
  submitParallelTeamTasks,
  submitTeamTask,
} from "./workflowApi";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return [...store.keys()][index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

async function expectUiOnlyWorkflowError(
  action: () => Promise<unknown>,
  expectedPath: string,
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected UI-only workflow request to fail closed for ${expectedPath}`);
  } catch (error) {
    assert(error instanceof Error, "Expected workflow failure to throw an Error");
    assert(
      error.message.includes(`UI-only development mode does not provide workflow execution for ${expectedPath}`),
      `Expected workflow failure message for ${expectedPath}, got: ${error.message}`,
    );
  }
}

export async function runWorkflowApiRegressionTests(): Promise<void> {
  (import.meta as { env?: Record<string, unknown> }).env = {
    ...(import.meta.env ?? {}),
    DEV: true,
    VITE_UI_ONLY: "true",
  };
  process.env.DAACS_DEV = "true";
  process.env.VITE_UI_ONLY = "true";

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: createMemoryStorage(),
    },
  });

  await expectUiOnlyWorkflowError(
    () => submitTeamTask("local", { team: "frontend", instruction: "Implement the fix" }),
    "/api/teams/local/task",
  );

  await expectUiOnlyWorkflowError(
    () =>
      submitParallelTeamTasks("local", [
        { team: "frontend", instruction: "Implement the fix" },
        { team: "reviewer", instruction: "Review the implementation" },
      ]),
    "/api/teams/local/parallel",
  );

  await expectUiOnlyWorkflowError(
    () => startWorkflow("local", "overnight"),
    "/api/workflows/local/start",
  );

  await expectUiOnlyWorkflowError(
    () => stopWorkflow("local", "wf-123"),
    "/api/workflows/local/wf-123/stop",
  );

  await expectUiOnlyWorkflowError(
    () => startOvernightWorkflow("local", { goal: "Ship the fix" }),
    "/api/workflows/local/overnight",
  );

  await expectUiOnlyWorkflowError(
    () => getOvernightWorkflowStatus("local", "run-123"),
    "/api/workflows/local/overnight/run-123",
  );

  await expectUiOnlyWorkflowError(
    () => stopOvernightWorkflow("local", "run-123"),
    "/api/workflows/local/overnight/run-123/stop",
  );

  await expectUiOnlyWorkflowError(
    () => resumeOvernightWorkflow("local", "run-123", { additional_budget_usd: 5 }),
    "/api/workflows/local/overnight/run-123/resume",
  );

  await expectUiOnlyWorkflowError(
    () => getOvernightWorkflowReport("local", "run-123"),
    "/api/workflows/local/overnight/run-123/report",
  );

  console.log("workflowApi UI-only fail-closed tests passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runWorkflowApiRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
