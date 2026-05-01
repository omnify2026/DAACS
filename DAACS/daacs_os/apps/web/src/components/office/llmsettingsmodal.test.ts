import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export async function runLlmSettingsModalRegressionTests(): Promise<void> {
  const modalSource = readFileSync(path.join(currentDir, "LlmSettingsModal.tsx"), "utf8");
  const hudSource = readFileSync(path.join(currentDir, "HUD.tsx"), "utf8");
  const messengerSource = readFileSync(path.join(currentDir, "AgentMessengerWidget.tsx"), "utf8");
  const officeCustomizationSource = readFileSync(
    path.join(currentDir, "OfficeCustomizationPanel.tsx"),
    "utf8",
  );
  const dashboardSource = readFileSync(
    path.join(currentDir, "..", "dashboard", "DashboardModal.tsx"),
    "utf8",
  );

  assert(
    modalSource.includes('className="fixed inset-0 z-[140]') &&
      modalSource.includes('className="relative z-[141]'),
    "LLM settings modal should render above the dashboard, HUD planner, messenger, and office overlays",
  );

  assert(
    modalSource.includes('data-office-overlay="true"') &&
      modalSource.includes('role="dialog"') &&
      modalSource.includes('aria-modal="true"') &&
      modalSource.includes("aria-labelledby={titleId}") &&
      modalSource.includes("aria-describedby={descriptionId}"),
    "LLM settings modal should declare a blocking office overlay dialog with modal semantics",
  );

  assert(
    modalSource.includes('document.body.style.overflow = "hidden";') &&
      modalSource.includes("closeButtonRef.current?.focus();") &&
      modalSource.includes('if (event.key === "Escape") {') &&
      modalSource.includes("onClose();"),
    "LLM settings modal should lock background scrolling and support direct keyboard dismissal/focus entry",
  );

  assert(
    modalSource.includes("if (event.target === event.currentTarget) {") &&
      modalSource.includes("event.stopPropagation();") &&
      modalSource.includes("onPointerDown={(event) => event.stopPropagation()}") &&
      modalSource.includes("onWheel={(event) => event.stopPropagation()}"),
    "LLM settings modal should absorb overlay interactions instead of letting office or messenger handlers receive them",
  );

  assert(
    modalSource.includes('data-testid="llm-settings-modal"') &&
      modalSource.includes('data-testid="llm-settings-close"') &&
      modalSource.includes('data-testid="llm-settings-save"') &&
      modalSource.includes('data-testid="llm-settings-openai-input"'),
    "LLM settings modal should preserve the stable browser smoke hooks used by the additive BYOK regression lane",
  );

  assert(
    modalSource.includes("const handleOverlayKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {") &&
      modalSource.includes('if (event.key !== "Tab") return;') &&
      modalSource.includes("last.focus();") &&
      modalSource.includes("first.focus();"),
    "LLM settings modal should trap keyboard focus inside the dialog while it is open",
  );

  assert(
    hudSource.includes('data-testid="planner-toggle"') &&
      hudSource.includes('data-testid="planner-panel"') &&
      hudSource.includes("<AgentMessengerWidget />") &&
      hudSource.includes("{showSettings && <OfficeCustomizationPanel onClose={toggleSettings} />}"),
    "HUD should keep explicit planner, messenger, and office customization surfaces mounted beneath the BYOK modal lane",
  );

  assert(
    messengerSource.includes('className="fixed bottom-6 right-6 z-[59] flex flex-col items-end pointer-events-auto"') &&
      messengerSource.includes('data-testid="messenger-panel"') &&
      messengerSource.includes('data-testid="messenger-toggle"'),
    "Messenger should preserve stable hooks and a lower z-layer than the BYOK modal",
  );

  assert(
    officeCustomizationSource.includes('data-testid="office-customization-panel"') &&
      officeCustomizationSource.includes('className={panelShellClass}') &&
      officeCustomizationSource.includes('z-[60] w-[min(440px,calc(100vw-1rem))]'),
    "Office customization should preserve a stable shell hook and a lower z-layer than the BYOK modal",
  );

  assert(
    dashboardSource.includes('data-testid="dashboard-modal-backdrop"') &&
      dashboardSource.includes('data-testid="dashboard-modal"') &&
      dashboardSource.includes('className="fixed inset-0 bg-black/60 z-40"') &&
      dashboardSource.includes('className="fixed inset-0 z-50 flex items-center justify-center p-8 pointer-events-none"'),
    "Dashboard should expose stable modal hooks and remain explicitly below the BYOK modal z-layer",
  );

  console.log("LlmSettingsModal isolation regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runLlmSettingsModalRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
