import {
  AGENT_ROLES,
  getAgentMeta,
  isBuiltinAgentRole,
  type AgentMeta,
  type AgentRole,
} from "./agent";
import type { AgentBlueprint, AgentInstance } from "./runtime";

export interface LegacyAgentCompat {
  instance_id: string;
  blueprint_id: string;
  legacy_role: AgentRole;
  display_name: string;
  title: string;
  color: string;
  icon: string;
  home_zone: string;
  team_affinity: string;
  runtime_status: AgentInstance["runtime_status"];
}

const LEGACY_ROLE_HINTS: Record<AgentRole, string[]> = {
  ceo: ["ceo", "strategy", "approval", "executive"],
  pm: ["pm", "planning", "delivery", "coordination"],
  developer: ["developer", "fullstack", "engineer"],
  developer_front: ["developer_front", "frontend", "ui", "design_system"],
  developer_back: ["developer_back", "backend", "api", "server"],
  reviewer: ["reviewer", "review", "quality", "code_review"],
  verifier: ["verifier", "verification", "qa", "test"],
  devops: ["devops", "deployment", "infra", "monitoring"],
  marketer: ["marketer", "content", "distribution", "seo"],
  designer: ["designer", "design", "assets", "prototype"],
  cfo: ["cfo", "budget", "finance", "risk"],
};

export function isLegacyAgentRole(value: string | null | undefined): value is AgentRole {
  return isBuiltinAgentRole(value);
}

export function resolveLegacyAgentRole(
  blueprint: Pick<AgentBlueprint, "role_label" | "capabilities">,
): AgentRole {
  if (isLegacyAgentRole(blueprint.role_label)) {
    return blueprint.role_label;
  }

  const searchSpace = [
    blueprint.role_label,
    ...blueprint.capabilities,
  ]
    .join(" ")
    .toLowerCase();

  for (const role of AGENT_ROLES) {
    if (LEGACY_ROLE_HINTS[role].some((hint) => searchSpace.includes(hint))) {
      return role;
    }
  }

  return "developer_front";
}

export function adaptBlueprintMeta(
  blueprint: AgentBlueprint,
): AgentMeta & Pick<LegacyAgentCompat, "display_name" | "title" | "home_zone" | "team_affinity"> {
  const legacyRole = resolveLegacyAgentRole(blueprint);
  const fallbackMeta = getAgentMeta(legacyRole);

  return {
    name: blueprint.ui_profile.display_name || fallbackMeta.name,
    title: blueprint.ui_profile.title || fallbackMeta.title,
    color: blueprint.ui_profile.accent_color || fallbackMeta.color,
    icon: blueprint.ui_profile.icon || fallbackMeta.icon,
    display_name: blueprint.ui_profile.display_name || fallbackMeta.name,
    home_zone: blueprint.ui_profile.home_zone || "war_room",
    team_affinity: blueprint.ui_profile.team_affinity || "custom_team",
  };
}

export function adaptRuntimeInstanceToLegacyAgent(
  instance: AgentInstance,
  blueprints: AgentBlueprint[],
): LegacyAgentCompat {
  const blueprint = blueprints.find((candidate) => candidate.id === instance.blueprint_id);
  const legacyRole = blueprint
    ? resolveLegacyAgentRole(blueprint)
    : "developer_front";
  const fallbackMeta = getAgentMeta(legacyRole);
  const meta = blueprint ? adaptBlueprintMeta(blueprint) : {
    ...fallbackMeta,
    display_name: fallbackMeta.name,
    home_zone: "war_room",
    team_affinity: "custom_team",
  };

  return {
    instance_id: instance.instance_id,
    blueprint_id: instance.blueprint_id,
    legacy_role: legacyRole,
    display_name: meta.display_name,
    title: meta.title,
    color: meta.color,
    icon: meta.icon,
    home_zone: meta.home_zone,
    team_affinity: meta.team_affinity,
    runtime_status: instance.runtime_status,
  };
}

export function buildBlueprintIndex(
  blueprints: AgentBlueprint[],
): Record<string, AgentBlueprint> {
  return Object.fromEntries(blueprints.map((blueprint) => [blueprint.id, blueprint]));
}
