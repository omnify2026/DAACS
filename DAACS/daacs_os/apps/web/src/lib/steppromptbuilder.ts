import {
  getAgentPrompt,
  getSkillPromptForCustom as getTauriSkillPromptForCustom,
  getSkillPromptForRole as getTauriSkillPromptForRole,
  isTauri,
  type AgentPromptRole,
} from "../services/tauriCli";
import { SKILL_BUNDLE_KEYS } from "../constants";
import type { AgentRole } from "../types/agent";
import {
  type AgentsMetadataEntry,
  findAgentMetadataByCandidatesSync,
  listAgentsMetadata,
} from "./agentsMetadata";
import type {
  AgentBlueprint,
  AgentInstance,
  ExecutionPlan,
  ExecutionStep,
  RuntimeBundleResponse,
} from "../types/runtime";

export interface StepCliRequest {
  cliRole: AgentPromptRole;
  officeAgentRole: AgentRole;
  systemPrompt: string;
  instruction: string;
  label: string;
}

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function serializeForPrompt(value: unknown): string {
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

function toBundleRole(roleLabel: string): string {
  const normalized = normalizeKey(roleLabel).replace(/^bundle_/, "");
  if (normalized.startsWith("developer")) {
    return "developer";
  }
  return normalized;
}

function isBundleKey(value: string | null | undefined): boolean {
  const normalized = normalizeKey(value);
  return (SKILL_BUNDLE_KEYS as readonly string[]).includes(normalized);
}

function findAssignedInstance(
  runtimeBundle: RuntimeBundleResponse,
  step: ExecutionStep,
): AgentInstance | undefined {
  return runtimeBundle.instances.find((candidate) => candidate.instance_id === step.assigned_to);
}

function findAssignedBlueprint(
  runtimeBundle: RuntimeBundleResponse,
  step: ExecutionStep,
): AgentBlueprint | undefined {
  const instance = findAssignedInstance(runtimeBundle, step);
  if (!instance) return undefined;
  return runtimeBundle.blueprints.find((candidate) => candidate.id === instance.blueprint_id);
}

function heuristicCliRole(blueprint: AgentBlueprint | undefined): AgentPromptRole {
  const roleLabel = normalizeKey(blueprint?.role_label);
  const capabilities = new Set((blueprint?.capabilities ?? []).map((item) => normalizeKey(item)));

  if (
    roleLabel === "pm" ||
    roleLabel.includes("product") ||
    capabilities.has("planning") ||
    capabilities.has("goal_decomposition") ||
    capabilities.has("approval")
  ) {
    return "pm";
  }

  if (
    roleLabel.includes("front") ||
    roleLabel.includes("design") ||
    capabilities.has("ui") ||
    capabilities.has("ux") ||
    capabilities.has("design")
  ) {
    return "frontend";
  }

  if (
    roleLabel.includes("back") ||
    roleLabel.includes("devops") ||
    capabilities.has("code_generation") ||
    capabilities.has("api") ||
    capabilities.has("database") ||
    capabilities.has("infrastructure")
  ) {
    return "backend";
  }

  return "agent";
}

function cliRoleFromMetadata(
  entries: AgentsMetadataEntry[],
  blueprint: AgentBlueprint | undefined,
): AgentPromptRole | null {
  if (!blueprint) return null;
  const match = findAgentMetadataByCandidatesSync(
    [
      blueprint.prompt_bundle_ref,
      blueprint.role_label,
      blueprint.name,
      blueprint.ui_profile.display_name,
      blueprint.ui_profile.title,
    ],
    entries,
  );
  return match?.id ?? null;
}

function officeRoleFromBlueprint(
  blueprint: AgentBlueprint | undefined,
  metadataMatch: AgentsMetadataEntry | null,
): AgentRole {
  const fromMetadata = metadataMatch?.office_role?.trim();
  if (fromMetadata) return fromMetadata as AgentRole;
  const roleLabel = blueprint?.role_label?.trim();
  return (roleLabel && roleLabel.length > 0 ? roleLabel : "pm") as AgentRole;
}

async function loadSkillPrompt(
  runtimeBundle: RuntimeBundleResponse,
  blueprint: AgentBlueprint | undefined,
): Promise<string> {
  if (!blueprint) return "";

  const refs = blueprint.skill_bundle_refs.filter(Boolean);
  const bundleRoleFromRef =
    refs.length === 1 && isBundleKey(refs[0]) ? toBundleRole(refs[0]) : "";
  const bundleRole = bundleRoleFromRef || toBundleRole(blueprint.role_label);

  try {
    if (refs.length > 0 && (refs.length > 1 || !isBundleKey(refs[0]))) {
      if (isTauri()) {
        return await getTauriSkillPromptForCustom(blueprint.role_label, refs);
      }
      const runtimeApi = await import("../services/runtimeApi");
      return await runtimeApi.getSkillPromptForCustom(
        runtimeBundle.runtime.project_id,
        blueprint.role_label,
        refs,
      );
    }

    if (!bundleRole) {
      return "";
    }

    if (isTauri()) {
      return await getTauriSkillPromptForRole(bundleRole);
    }
    const runtimeApi = await import("../services/runtimeApi");
    return await runtimeApi.getSkillPromptForRole(runtimeBundle.runtime.project_id, bundleRole);
  } catch {
    return "";
  }
}

async function loadAgentsMetadata(): Promise<AgentsMetadataEntry[]> {
  return listAgentsMetadata();
}

export async function buildStepCliRequest(
  runtimeBundle: RuntimeBundleResponse,
  plan: ExecutionPlan,
  step: ExecutionStep,
): Promise<StepCliRequest> {
  const blueprint = findAssignedBlueprint(runtimeBundle, step);
  const instance = findAssignedInstance(runtimeBundle, step);
  const metadata = await loadAgentsMetadata();
  const metadataMatch = blueprint
    ? findAgentMetadataByCandidatesSync(
        [
          blueprint.prompt_bundle_ref,
          blueprint.role_label,
          blueprint.name,
          blueprint.ui_profile.display_name,
          blueprint.ui_profile.title,
        ],
        metadata,
      )
    : null;
  const cliRole = cliRoleFromMetadata(metadata, blueprint) ?? heuristicCliRole(blueprint);
  const officeAgentRole = officeRoleFromBlueprint(blueprint, metadataMatch);
  const capabilityLine =
    step.required_capabilities && step.required_capabilities.length > 0
      ? step.required_capabilities.join(", ")
      : blueprint?.capabilities.join(", ") || "general execution";
  const basePrompt = await getAgentPrompt(cliRole);
  const skillPrompt = await loadSkillPrompt(runtimeBundle, blueprint);
  const systemPrompt = [
    basePrompt.trim(),
    "---",
    skillPrompt.trim() || null,
    skillPrompt.trim() ? "---" : null,
    `You are operating as ${blueprint?.name ?? step.label} (${blueprint?.role_label ?? officeAgentRole}).`,
    `Runtime company: ${runtimeBundle.runtime.company_name}`,
    `Capabilities: ${capabilityLine}`,
    `Tool policy: ${serializeForPrompt(blueprint?.tool_policy ?? {})}`,
    `Permission policy: ${serializeForPrompt(blueprint?.permission_policy ?? {})}`,
    `Memory policy: ${serializeForPrompt(blueprint?.memory_policy ?? {})}`,
    "Execute the step directly and return a concrete result that the next step can consume.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const instruction = [
    `Goal: ${plan.goal}`,
    `Plan rationale: ${plan.plan_rationale || "No explicit rationale provided."}`,
    `Current step: ${step.label}`,
    step.description,
    `Assigned runtime agent: ${blueprint?.ui_profile.display_name ?? blueprint?.name ?? instance?.instance_id ?? "unassigned"}`,
    `Selection reason: ${step.selection_reason || "No explicit selection reason provided."}`,
    `Planner notes: ${step.planner_notes || "No planner notes provided."}`,
    `Required capabilities: ${capabilityLine}`,
    `Handoff input:\n${serializeForPrompt(step.input)}`,
    "Return the actual work result. When relevant, include a short summary, key actions, deliverables, and remaining risks.",
  ].join("\n\n");

  return {
    cliRole,
    officeAgentRole,
    systemPrompt,
    instruction,
    label: step.label,
  };
}
