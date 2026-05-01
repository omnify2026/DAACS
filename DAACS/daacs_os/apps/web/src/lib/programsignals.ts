import type { Agent } from "../types/agent";
import type { AgentProgramSignals } from "../types/program";

function tokenize(value: string | undefined | null): string[] {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

export function buildAgentProgramSignals(agent: Agent): AgentProgramSignals {
  const widgetIds = [
    ...(agent.uiProfile?.primary_widgets ?? []),
    ...(agent.uiProfile?.secondary_widgets ?? []),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const roleTokens = [
    ...tokenize(agent.role),
    ...tokenize(agent.operatingProfile?.workspace_mode),
    ...tokenize(agent.uiProfile?.focus_mode),
    ...(agent.capabilities ?? []).flatMap((value) => tokenize(value)),
    ...(agent.skillBundleRefs ?? []).flatMap((value) => tokenize(value)),
  ];

  return {
    workspace_mode: agent.operatingProfile?.workspace_mode ?? "adaptive_workspace",
    capabilities: (agent.capabilities ?? []).map((value) => value.trim().toLowerCase()),
    skill_bundle_refs: (agent.skillBundleRefs ?? []).map((value) => value.trim().toLowerCase()),
    widget_ids: [...new Set(widgetIds)],
    role_tokens: [...new Set(roleTokens)],
  };
}
