import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export async function runHudRegressionTests(): Promise<void> {
  const hudSource = readFileSync(path.join(currentDir, "HUD.tsx"), "utf8");
  const effectsSource = readFileSync(path.join(currentDir, "Effects.tsx"), "utf8");

  assert(
    hudSource.includes('const [showLlmSettingsModal, setShowLlmSettingsModal] = useState(false);'),
    "HUD should track BYOK modal visibility in its own authenticated state",
  );

  assert(
    hudSource.includes('onClick={onMenuPickSettings}') &&
      hudSource.includes('{t("hud.menu.officeCustomization")}'),
    "HUD should keep a dedicated Office Customization menu action",
  );

  assert(
    hudSource.includes('onClick={onMenuPickLlmSettings}') &&
      hudSource.includes('{t("hud.menu.byokSettings")}'),
    "HUD should expose a dedicated BYOK Settings menu action after login",
  );

  assert(
    hudSource.includes('data-testid="hud-main-menu-button"') &&
      hudSource.includes('data-testid="hud-open-agent-workspace-button"') &&
      hudSource.includes('data-testid="hud-office-customization-menu-item"') &&
      hudSource.includes('data-testid="hud-byok-settings-menu-item"'),
    "HUD should preserve smoke hooks for direct work start, main menu, office customization, and BYOK actions",
  );

  assert(
    hudSource.includes('onClick={onMenuPickAgent}') &&
      hudSource.includes('{t("hud.openAgentWorkspace")}'),
    "HUD should expose the Agent Workspace directly from the bottom action bar",
  );

  assert(
    hudSource.includes("const onMenuPickLlmSettings = () => {") &&
      hudSource.includes("if (showSettings) {") &&
      hudSource.includes("toggleSettings();") &&
      hudSource.includes("setShowLlmSettingsModal(true);"),
    "Opening BYOK settings should close office customization first and then open the BYOK modal",
  );

  assert(
    hudSource.includes("{showSettings && <OfficeCustomizationPanel onClose={toggleSettings} />}"),
    "HUD should keep office customization mounted from the existing office settings state",
  );

  assert(
    hudSource.includes(
      '<LlmSettingsModal open={showLlmSettingsModal} onClose={() => setShowLlmSettingsModal(false)} />',
    ),
    "HUD should mount the BYOK modal from a reachable authenticated surface",
  );

  assert(
    hudSource.includes('import { NotificationToast } from "./Effects";') &&
      hudSource.includes("notifications.slice(-5).map") &&
      hudSource.includes("<NotificationToast") &&
      hudSource.includes("handleNotificationAction") &&
      hudSource.includes('notification.action === "open_goal_recovery"') &&
      hudSource.includes('setAgentWorkspaceInitialTab("task")') &&
      hudSource.includes("setShowAgentCommandModal(true)") &&
      hudSource.includes("notification.actionLabel") &&
      hudSource.includes('new CustomEvent("daacs:open-goal-recovery")') &&
      hudSource.includes("document.querySelector('[data-testid=\"goal-release-readiness\"]')") &&
      hudSource.includes("dismissNotification(notification.id)"),
    "HUD should render visible notification toasts and route recoverable artifact alerts back to the task panel",
  );

  assert(
    effectsSource.includes('data-testid="notification-action-button"') &&
      effectsSource.includes("event.stopPropagation();") &&
      effectsSource.includes("onAction();") &&
      effectsSource.includes("클릭하여 닫기"),
    "Recoverable notification toasts should expose a real action button instead of relying only on clicking the whole toast",
  );

  console.log("HUD authenticated BYOK reachability regression passed");
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry != null && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  void runHudRegressionTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
