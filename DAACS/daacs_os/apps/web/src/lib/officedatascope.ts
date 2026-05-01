import type { Agent, AgentRole, AgentMessageRecord } from "../types/agent";

export function buildPrimaryAgentDataKey(agent: Pick<Agent, "id">): string {
  return `agent:${agent.id}`;
}

export function buildAgentDataKeys(agent: Pick<Agent, "id" | "instanceId" | "role">): string[] {
  const keys = [
    buildPrimaryAgentDataKey(agent),
    agent.instanceId ? `instance:${agent.instanceId}` : null,
    agent.role,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return [...new Set(keys)];
}

export function messageMatchesAgent(
  message: AgentMessageRecord,
  agent: Pick<Agent, "id" | "role">,
): boolean {
  if (message.fromAgentId === agent.id || message.toAgentId === agent.id) return true;
  return message.from === agent.role || message.to === agent.role;
}

export function buildLegacyRoleAlias(role: AgentRole): string {
  return role;
}
