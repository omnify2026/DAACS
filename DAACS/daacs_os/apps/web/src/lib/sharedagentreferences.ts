import type { Agent, AgentRole, AgentUiProfile, SharedAgentReference } from "../types/agent";
import { getAgentMeta } from "../types/agent";
import type { SharedAgentProfileDocument } from "../types/office";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function buildSharedReference(
  sharedAgent: SharedAgentProfileDocument,
  current?: SharedAgentReference | null,
): SharedAgentReference {
  return {
    global_agent_id: sharedAgent.global_agent_id,
    source_project_id: sharedAgent.source_project_id ?? null,
    sync_mode: current?.sync_mode === "detached" ? "detached" : "linked",
    imported_at: current?.imported_at ?? new Date().toISOString(),
  };
}

export function applySharedAgentProfileToAgent(
  agent: Agent,
  sharedAgent: SharedAgentProfileDocument,
): Agent {
  const nextUiProfile = cloneJson((sharedAgent.ui_profile ?? {}) as AgentUiProfile);
  return {
    ...agent,
    role: sharedAgent.role_label as AgentRole,
    name: sharedAgent.name,
    capabilities: [...sharedAgent.capabilities],
    skillBundleRefs: [...sharedAgent.skill_bundle_refs],
    uiProfile: {
      ...nextUiProfile,
      home_zone: agent.uiProfile?.home_zone ?? nextUiProfile.home_zone,
      team_affinity: agent.uiProfile?.team_affinity ?? nextUiProfile.team_affinity,
    },
    operatingProfile: cloneJson(sharedAgent.operating_profile) as unknown as Agent["operatingProfile"],
    meta: getAgentMeta(sharedAgent.role_label as AgentRole, {
      name: sharedAgent.name,
      title:
        typeof nextUiProfile.title === "string" && nextUiProfile.title.trim().length > 0
          ? nextUiProfile.title
          : sharedAgent.name,
      color:
        typeof nextUiProfile.accent_color === "string" && nextUiProfile.accent_color.trim().length > 0
          ? nextUiProfile.accent_color
          : undefined,
      icon:
        typeof nextUiProfile.icon === "string" && nextUiProfile.icon.trim().length > 0
          ? nextUiProfile.icon
          : undefined,
    }),
    sharedAgentRef: buildSharedReference(sharedAgent, agent.sharedAgentRef),
  };
}

export function syncAgentsFromSharedReferences(
  agents: Agent[],
  sharedAgents: SharedAgentProfileDocument[],
): Agent[] {
  if (agents.length === 0) return agents;
  const byId = new Map(sharedAgents.map((agent) => [agent.global_agent_id, agent]));
  return agents.map((agent) => {
    const reference = agent.sharedAgentRef;
    if (!reference?.global_agent_id) return agent;

    const sharedAgent = byId.get(reference.global_agent_id);
    if (!sharedAgent) {
      return {
        ...agent,
        sharedAgentRef: {
          ...reference,
          sync_mode: "detached",
        },
      };
    }

    if (reference.sync_mode === "detached") {
      return agent;
    }

    return applySharedAgentProfileToAgent(agent, sharedAgent);
  });
}
