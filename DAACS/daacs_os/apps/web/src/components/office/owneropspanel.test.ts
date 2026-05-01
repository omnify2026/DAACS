import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runOwnerOpsPanelRegressionTests(): Promise<void> {
  const source = readFileSync(path.join(currentDir, "OwnerOpsPanel.tsx"), "utf8");

  assert(
    source.includes('data-testid="owner-ops-panel"') &&
      source.includes('data-testid="owner-ops-close-button"') &&
      source.includes('data-testid="owner-ops-toggle"'),
    "OwnerOpsPanel should preserve the stable smoke hooks for its open, close, and collapsed states",
  );

  assert(
    source.includes("onClick={() => setOpen(false)}") &&
      source.includes("onClick={() => setOpen(true)}"),
    "OwnerOpsPanel should keep explicit open and close actions around the owner-ops shell",
  );

  assert(
    source.includes("if (item.intentId) {") &&
      source.includes("const decided = await onDecideIntent(item.intentId, action);") &&
      source.includes('decided.status === "completed"') &&
      source.includes('decided.status === "failed"'),
    "OwnerOpsPanel should keep the execution-intent approval lane wired through onDecideIntent and resulting notifications",
  );

  assert(
    source.includes("if (!projectId) {") &&
      source.includes('message: t("owner.projectNotSelected")') &&
      source.includes("const result = await submitOwnerDecision(projectId, {") &&
      source.includes('if (action === "approved" && item.planId && item.stepId) {') &&
      source.includes("await onApproveStep(item.planId, item.stepId);"),
    "OwnerOpsPanel should fail closed without a project id and only escalate workflow approvals through onApproveStep for approve actions",
  );

  assert(
    source.includes("await loadDecisionHistory();") &&
      source.includes('message: result.applied_effect') &&
      source.includes('message: err instanceof Error ? err.message : t("owner.decisionSaveFailed")'),
    "OwnerOpsPanel should refresh decision history after saved approvals and surface both success and failure notifications",
  );

  console.log("OwnerOpsPanel approval-path regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runOwnerOpsPanelRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
