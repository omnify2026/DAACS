import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runAgentMessengerWidgetRegressionTests(): Promise<void> {
  const source = readFileSync(path.join(currentDir, "AgentMessengerWidget.tsx"), "utf8");

  assert(
    source.includes('data-testid="messenger-panel"') &&
      source.includes('data-testid="messenger-close-button"') &&
      source.includes('data-testid="messenger-input"') &&
      source.includes('data-testid="messenger-toggle"'),
    "AgentMessengerWidget should preserve the stable smoke hooks for panel, close button, input, and launcher",
  );

  assert(
    source.includes("onClick={(e) => { e.stopPropagation(); setIsOpen(false); }}") &&
      source.includes("onClick={(e) => { e.stopPropagation(); toggleOpen(); }}"),
    "AgentMessengerWidget should keep explicit close and reopen controls for the messenger shell",
  );

  assert(
    source.includes("addMessage({") &&
      source.includes('senderId: "user"') &&
      source.includes("senderRole: selectedThread") &&
      source.includes("if (submitRfiAnswer) submitRfiAnswer(text);"),
    "AgentMessengerWidget should keep the selected-thread reply path wired through addMessage and submitRfiAnswer",
  );

  assert(
    source.includes("if (message.actionPayload.intentId && decideIntent)") &&
      source.includes("await decideIntent(message.actionPayload.intentId, action, messageId);") &&
      source.includes('action === "approve"') &&
      source.includes("await approveStep(message.actionPayload.planId, message.actionPayload.stepId, messageId);") &&
      source.includes("resolveMessage(messageId, action);"),
    "AgentMessengerWidget should keep both approval lanes wired: intent decisions and owner step approvals",
  );

  assert(
    source.includes('text: t("messenger.processed", { action: actionStyles[action].label })') &&
      source.includes('text: t("messenger.processFailed")'),
    "AgentMessengerWidget should keep both success and failure notification messages for approval actions",
  );

  assert(
    source.includes("originalGoal") &&
      source.includes("firstPmMessageId") &&
      source.includes('data-testid="messenger-message-context"') &&
      source.includes('t("messenger.originalRequest")'),
    "AgentMessengerWidget should show the original user request on the first PM message",
  );

  assert(
    source.includes("select-text") &&
      source.includes("cursor-text") &&
      source.includes("break-words"),
    "AgentMessengerWidget should allow messenger text to be selected and copied inside the select-none office scene",
  );

  console.log("AgentMessengerWidget approval and close-path regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runAgentMessengerWidgetRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
