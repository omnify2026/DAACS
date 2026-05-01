import { runAppRegressionTests } from "../App.test.tsx";
import { runAgentRegistryRegressionTests } from "../application/sequencer/AgentRegistry.test";
import { runHostCommandGuardsRegressionTests } from "../application/sequencer/HostCommandGuards.test";
import { runSequencerCoordinatorRegressionTests } from "../application/sequencer/SequencerCoordinator.test";
import { runCliProviderDevBannerRegressionTests } from "../components/dev/CliProviderDevBanner.test";
import { runAgentMessengerWidgetRegressionTests } from "../components/office/AgentMessengerWidget.test";
import { runGoalMeetingPanelRegressionTests } from "../components/office/GoalMeetingPanel.test";
import { runHudRegressionTests } from "../components/office/HUD.test";
import { runLlmSettingsModalRegressionTests } from "../components/office/LlmSettingsModal.test";
import { runOwnerOpsPanelRegressionTests } from "../components/office/OwnerOpsPanel.test";
import { runSharedBoardPanelRegressionTests } from "../components/office/SharedBoardPanel.test";
import { runHostCommandFeedbackRegressionTests } from "../../test_feedback";
import { runI18nRegressionTests } from "../i18n.test";
import { runThirdPhaseReadinessRegressionTests } from "../lib/thirdPhaseReadiness.test";
import { runAppApiStubRegressionTests } from "../services/appApiStub.test";
import { runCollaborationApiRegressionTests } from "../services/collaborationApi.test";
import { runHttpClientRegressionTests } from "../services/httpClient.test";
import { runTauriCliRegressionTests } from "../services/tauriCli.test";
import { runWorkflowApiRegressionTests } from "../services/workflowApi.test";
import { runCliLogStoreRegressionTests } from "../stores/cliLogStore.test";
import { runLlmSettingsStoreRegressionTests } from "../stores/llmSettingsStore.test";
import { runOfficeStoreRegressionTests } from "../stores/officeStore.test";
import { runWsEventBridgeRegressionTests } from "../stores/wsEventBridge.test";
import { runAgentTypeRegressionTests } from "../types/agent.test";

type RegressionCase = {
  label: string;
  run: () => Promise<void>;
};

const regressions: RegressionCase[] = [
  { label: "HostCommandFeedbackRunner result contract", run: runHostCommandFeedbackRegressionTests },
  { label: "AgentRegistry auth/BYOK owner resolution", run: runAgentRegistryRegressionTests },
  { label: "HostCommandGuards command safety", run: runHostCommandGuardsRegressionTests },
  { label: "SequencerCoordinator", run: runSequencerCoordinatorRegressionTests },
  { label: "tauriCli sequencer delegation prompt", run: runTauriCliRegressionTests },
  { label: "appApiStub BYOK/settings lane", run: runAppApiStubRegressionTests },
  { label: "collaborationApi stop/signal plumbing", run: runCollaborationApiRegressionTests },
  { label: "httpClient and auth flows", run: runHttpClientRegressionTests },
  { label: "workflowApi UI-only guardrails", run: runWorkflowApiRegressionTests },
  { label: "cliLogStore truncation", run: runCliLogStoreRegressionTests },
  { label: "llmSettingsStore BYOK flow", run: runLlmSettingsStoreRegressionTests },
  { label: "officeStore backend clock sync", run: runOfficeStoreRegressionTests },
  { label: "wsEventBridge collaboration status", run: runWsEventBridgeRegressionTests },
  { label: "agent metadata display overrides", run: runAgentTypeRegressionTests },
  { label: "App pre-office BYOK access", run: runAppRegressionTests },
  { label: "CLI provider dev banner local model selection", run: runCliProviderDevBannerRegressionTests },
  { label: "LLM settings modal isolation", run: runLlmSettingsModalRegressionTests },
  { label: "HUD BYOK reachability", run: runHudRegressionTests },
  { label: "GoalMeetingPanel web planner routing", run: runGoalMeetingPanelRegressionTests },
  { label: "SharedBoardPanel contribution visibility", run: runSharedBoardPanelRegressionTests },
  { label: "AgentMessengerWidget approvals", run: runAgentMessengerWidgetRegressionTests },
  { label: "OwnerOpsPanel approval paths", run: runOwnerOpsPanelRegressionTests },
  { label: "i18n locale parity", run: runI18nRegressionTests },
  { label: "third-phase release readiness gates", run: runThirdPhaseReadinessRegressionTests },
];

async function main(): Promise<void> {
  for (const regression of regressions) {
    console.log(`Running ${regression.label} regression`);
    await regression.run();
  }

  console.log("apps/web BYOK/settings verification suite passed");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
