import type { Agent } from "../types/agent";
import type { AgentProgramDerivedData, AgentWorkspaceData } from "../types/program";
import { buildOutputLines, extractFileRefs } from "./agentFocusUtils";

export function resolveAgentConnectorId(
  agent: Agent,
  needle: string,
  fallback = "internal_workbench",
): string {
  return (
    agent.operatingProfile?.tool_connectors.find((value) => value.includes(needle)) ??
    agent.operatingProfile?.tool_connectors[0] ??
    fallback
  );
}

export function buildAgentProgramDerivedData(
  agent: Agent,
  data: AgentWorkspaceData,
): AgentProgramDerivedData {
  const latestCompletedTask = data.tasks.find((task) => task.status === "completed") ?? null;
  const latestOutputLines = latestCompletedTask
    ? buildOutputLines(agent.role, latestCompletedTask).slice(0, 4)
    : [];
  const latestFiles = latestOutputLines.flatMap((line) => extractFileRefs(line, 8));
  const approvalItems = (data.plan_view?.approvalQueue ?? []).filter((item) => {
    if (agent.operatingProfile?.workspace_mode === "orchestration_workspace") return true;
    return item.assigned_role_label === agent.role || item.approver_role_label === agent.role;
  });
  const pendingIntents = data.execution_intents.filter((intent) => {
    if (intent.status !== "pending_approval") return false;
    if (agent.operatingProfile?.workspace_mode === "orchestration_workspace") return true;
    return intent.agent_role === agent.role;
  });
  const recentIntentRuns = data.execution_intents.filter((intent) => {
    if (intent.status === "pending_approval") return false;
    if (agent.operatingProfile?.workspace_mode === "orchestration_workspace") return true;
    return intent.agent_role === agent.role;
  });

  return {
    latest_output_lines: latestOutputLines,
    latest_files: latestFiles,
    pending_intents: pendingIntents,
    recent_intent_runs: recentIntentRuns,
    approval_items: approvalItems,
  };
}
