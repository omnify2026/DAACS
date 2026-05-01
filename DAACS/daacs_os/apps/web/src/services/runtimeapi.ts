import {
  PATH_BLUEPRINTS,
  PATH_EXECUTION_PLANS,
  PATH_RUNTIMES,
  PATH_SKILLS,
} from "../constants";
import type { ProjectOfficeProfile } from "../types/office";
import type {
  AgentBlueprint,
  AgentInstance,
  BlueprintInput,
  CompanyRuntime,
  CreateExecutionIntentInput,
  ExecutionMode,
  ExecutionIntent,
  ExecutionPlan,
  ExecutionStep,
  JsonValue,
  RuntimeEvent,
  RuntimeBundleResponse,
  SkillBundleSummary,
  SkillMeta,
  StepListResponse,
} from "../types/runtime";
import { requestJson } from "./httpClient";

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function isApiStatus(error: unknown, status: number): boolean {
  if (typeof error !== "object" || error == null || !("status" in error)) {
    return false;
  }
  return (error as { status?: unknown }).status === status;
}

function normalizeBlueprintInput(input: BlueprintInput): BlueprintInput {
  return {
    capabilities: [],
    skill_bundle_refs: [],
    tool_policy: {},
    permission_policy: {},
    memory_policy: {},
    collaboration_policy: {},
    approval_policy: {},
    ui_profile: {},
    ...input,
  };
}

function projectBasePath(projectId: string): string {
  return `/api/projects/${encodeSegment(projectId)}`;
}

function projectRuntimePath(projectId: string): string {
  return `${projectBasePath(projectId)}/runtime`;
}

function projectRuntimeOfficeProfilePath(projectId: string): string {
  return `${projectRuntimePath(projectId)}/office-profile`;
}

function projectInstancesPath(projectId: string): string {
  return `${projectBasePath(projectId)}/instances`;
}

function projectPlansPath(projectId: string): string {
  return `${projectBasePath(projectId)}/plans`;
}

function projectExecutionIntentsPath(projectId: string): string {
  return `${projectBasePath(projectId)}/execution-intents`;
}

export async function listBlueprints(): Promise<AgentBlueprint[]> {
  return requestJson<AgentBlueprint[]>(PATH_BLUEPRINTS);
}

export async function getBlueprint(blueprintId: string): Promise<AgentBlueprint> {
  return requestJson<AgentBlueprint>(`${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`);
}

export async function createBlueprint(input: BlueprintInput): Promise<AgentBlueprint> {
  return requestJson<AgentBlueprint>(PATH_BLUEPRINTS, {
    method: "POST",
    body: JSON.stringify(normalizeBlueprintInput(input)),
  });
}

export async function updateBlueprint(
  blueprintId: string,
  input: BlueprintInput,
): Promise<AgentBlueprint> {
  return requestJson<AgentBlueprint>(`${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`, {
    method: "PUT",
    body: JSON.stringify(normalizeBlueprintInput(input)),
  });
}

export async function deleteBlueprint(
  blueprintId: string,
): Promise<{ status: string; blueprint_id: string }> {
  return requestJson<{ status: string; blueprint_id: string }>(
    `${PATH_BLUEPRINTS}/${encodeSegment(blueprintId)}`,
    { method: "DELETE" },
  );
}

export async function getRuntime(runtimeId: string): Promise<CompanyRuntime> {
  return requestJson<CompanyRuntime>(`${PATH_RUNTIMES}/${encodeSegment(runtimeId)}`);
}

export async function listProjectRuntimes(projectId: string): Promise<CompanyRuntime[]> {
  const qp = new URLSearchParams({ project_id: projectId });
  return requestJson<CompanyRuntime[]>(`${PATH_RUNTIMES}?${qp.toString()}`);
}

export async function listRuntimePlans(runtimeId: string): Promise<ExecutionPlan[]> {
  const qp = new URLSearchParams({ runtime_id: runtimeId });
  return requestJson<ExecutionPlan[]>(`${PATH_EXECUTION_PLANS}?${qp.toString()}`);
}

export async function getRuntimePlan(planId: string): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(`${PATH_EXECUTION_PLANS}/${encodeSegment(planId)}`);
}

export async function listRuntimeAgents(runtimeId: string): Promise<AgentInstance[]> {
  return requestJson<AgentInstance[]>(`${PATH_RUNTIMES}/${encodeSegment(runtimeId)}/agents`);
}

export interface BootstrapRuntimeInput {
  company_name?: string;
  blueprint_ids?: string[];
  execution_mode?: ExecutionMode;
}

export interface CreateInstanceInput {
  blueprint_id: string;
  assigned_team?: string | null;
}

export interface CreatePlanInput {
  goal: string;
}

export type ExecutionTrack = "local_cli" | "server";

export interface ExecutePlanInput {
  execution_track?: ExecutionTrack;
}

export interface ApproveStepInput {
  note?: string;
  execution_track?: ExecutionTrack;
}

export interface CompleteStepInput {
  input?: unknown;
  output: unknown;
  status?: "completed" | "failed";
}

export interface CreateProjectExecutionIntentInput extends CreateExecutionIntentInput {
  agent_id: string;
  agent_role: string;
  requires_approval?: boolean;
}

export interface DecideExecutionIntentInput {
  action: "approved" | "hold" | "rejected";
  note?: string;
  execution_track?: ExecutionTrack;
}

export interface CompleteExecutionIntentInput {
  status?: "completed" | "failed";
  result_summary: string;
  result_payload?: JsonValue;
  note?: string;
}

export async function getProjectRuntime(projectId: string): Promise<RuntimeBundleResponse> {
  return requestJson<RuntimeBundleResponse>(projectRuntimePath(projectId));
}

export async function getProjectRuntimeBestEffort(
  projectId: string,
): Promise<RuntimeBundleResponse | null> {
  try {
    return await getProjectRuntime(projectId);
  } catch (error) {
    if (isApiStatus(error, 404)) {
      return null;
    }
    try {
      return await bootstrapRuntime(projectId);
    } catch (bootstrapError) {
      if (isApiStatus(bootstrapError, 404)) {
        return null;
      }
      throw bootstrapError;
    }
  }
}

export async function bootstrapRuntime(
  projectId: string,
  input: BootstrapRuntimeInput = {},
): Promise<RuntimeBundleResponse> {
  return requestJson<RuntimeBundleResponse>(`${projectRuntimePath(projectId)}/bootstrap`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateProjectOfficeProfile(
  projectId: string,
  officeProfile: ProjectOfficeProfile,
): Promise<RuntimeBundleResponse> {
  return requestJson<RuntimeBundleResponse>(projectRuntimeOfficeProfilePath(projectId), {
    method: "PUT",
    body: JSON.stringify({
      office_profile: officeProfile,
    }),
  });
}

export async function listProjectInstances(projectId: string): Promise<AgentInstance[]> {
  return requestJson<AgentInstance[]>(projectInstancesPath(projectId));
}

export async function createInstance(
  projectId: string,
  input: CreateInstanceInput,
): Promise<AgentInstance> {
  return requestJson<AgentInstance>(projectInstancesPath(projectId), {
    method: "POST",
    body: JSON.stringify({
      blueprint_id: input.blueprint_id,
      assigned_team: input.assigned_team ?? undefined,
    }),
  });
}

export async function listProjectPlans(projectId: string): Promise<ExecutionPlan[]> {
  return requestJson<ExecutionPlan[]>(projectPlansPath(projectId));
}

export async function createPlan(
  projectId: string,
  input: CreatePlanInput,
): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(projectPlansPath(projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getProjectPlan(
  projectId: string,
  planId: string,
): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}`,
  );
}

export async function listPlanSteps(
  projectId: string,
  planId: string,
): Promise<StepListResponse> {
  return requestJson<StepListResponse>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps`,
  );
}

export async function listPlanEvents(
  projectId: string,
  planId: string,
): Promise<RuntimeEvent[]> {
  return requestJson<RuntimeEvent[]>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/events`,
  );
}

export async function executePlan(
  projectId: string,
  planId: string,
  input: ExecutePlanInput = {},
): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/execute`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export async function getReadySteps(
  projectId: string,
  planId: string,
): Promise<ExecutionStep[]> {
  return requestJson<ExecutionStep[]>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/ready-steps`,
  );
}

export async function completeStep(
  projectId: string,
  planId: string,
  stepId: string,
  input: CompleteStepInput,
): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps/${encodeSegment(stepId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function approvePlanStep(
  projectId: string,
  planId: string,
  stepId: string,
  input: ApproveStepInput = {},
): Promise<ExecutionPlan> {
  return requestJson<ExecutionPlan>(
    `${projectPlansPath(projectId)}/${encodeSegment(planId)}/steps/${encodeSegment(stepId)}/approve`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function listProjectExecutionIntents(
  projectId: string,
  agentId?: string,
): Promise<ExecutionIntent[]> {
  const qp = new URLSearchParams();
  if (agentId) qp.set("agent_id", agentId);
  const suffix = qp.toString();
  return requestJson<ExecutionIntent[]>(
    suffix
      ? `${projectExecutionIntentsPath(projectId)}?${suffix}`
      : projectExecutionIntentsPath(projectId),
  );
}

export async function getProjectExecutionIntent(
  projectId: string,
  intentId: string,
): Promise<ExecutionIntent> {
  return requestJson<ExecutionIntent>(
    `${projectExecutionIntentsPath(projectId)}/${encodeSegment(intentId)}`,
  );
}

export async function createProjectExecutionIntent(
  projectId: string,
  input: CreateProjectExecutionIntentInput,
): Promise<ExecutionIntent> {
  return requestJson<ExecutionIntent>(projectExecutionIntentsPath(projectId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function decideProjectExecutionIntent(
  projectId: string,
  intentId: string,
  input: DecideExecutionIntentInput,
): Promise<ExecutionIntent> {
  return requestJson<ExecutionIntent>(
    `${projectExecutionIntentsPath(projectId)}/${encodeSegment(intentId)}/decision`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function completeProjectExecutionIntent(
  projectId: string,
  intentId: string,
  input: CompleteExecutionIntentInput,
): Promise<ExecutionIntent> {
  return requestJson<ExecutionIntent>(
    `${projectExecutionIntentsPath(projectId)}/${encodeSegment(intentId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function getSkillBundleSummary(): Promise<SkillBundleSummary> {
  const { LoadSkillBundleSummary } = await import("../lib/skillBundleProvider");
  const { summary } = await LoadSkillBundleSummary();
  return summary;
}

export async function getSkillCatalog(): Promise<SkillMeta[]> {
  const { getSkillCatalogBundled } = await import("../lib/skillCatalog");
  return getSkillCatalogBundled();
}

export async function getSkillPromptForRole(
  projectId: string,
  role: string,
): Promise<string> {
  const data = await requestJson<{ system_prompt?: string }>(
    `${PATH_SKILLS}/${encodeSegment(projectId)}/${encodeSegment(role)}`,
  );
  return data.system_prompt ?? "";
}

export async function getSkillPromptForCustom(
  projectId: string,
  role: string,
  skillIds: string[],
): Promise<string> {
  const data = await requestJson<{ system_prompt?: string }>(
    `${PATH_SKILLS}/${encodeSegment(projectId)}/custom`,
    {
      method: "POST",
      body: JSON.stringify({
        role,
        skill_ids: skillIds,
      }),
    },
  );
  return data.system_prompt ?? "";
}
