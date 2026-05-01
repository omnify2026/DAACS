import type { TeamParallelResponse, TeamTaskResponse } from "../types/agent";
import { isAppApiStubEnabled } from "./appApiStub";
import { requestJson } from "./httpClient";

export interface OvernightConstraints {
  max_runtime_minutes: number;
  max_spend_usd: number;
  max_iterations: number;
  allowed_tools: string[];
  blocked_commands: string[];
}

export interface OvernightStartPayload {
  workflow_name?: string;
  goal: string;
  constraints?: Partial<OvernightConstraints>;
  definition_of_done?: string[];
  verification_profile?: "quick" | "default" | "strict";
  quality_threshold?: number;
}

export interface OvernightStatusResponse {
  run_id: string;
  status: string;
  goal: string;
  spent_usd: number;
  deadline_at?: string | null;
  overnight_config: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
}

function requestWorkflowJson<T>(path: string, options: RequestInit): Promise<T> {
  if (isAppApiStubEnabled()) {
    return Promise.reject(
      new Error(
        `UI-only development mode does not provide workflow execution for ${path}. ` +
          "Disable VITE_UI_ONLY or connect a real backend before starting workflow or overnight runs.",
      ),
    );
  }
  return requestJson<T>(path, options);
}

export function startWorkflow(projectId: string, workflowName: string): Promise<{ workflow_id: string; status: string }> {
  return requestWorkflowJson(`/api/workflows/${projectId}/start`, {
    method: "POST",
    body: JSON.stringify({ workflow_name: workflowName }),
  });
}

export function stopWorkflow(projectId: string, workflowId: string): Promise<{ status: string }> {
  return requestWorkflowJson(`/api/workflows/${projectId}/${workflowId}/stop`, { method: "POST" });
}

export function startOvernightWorkflow(
  projectId: string,
  payload: OvernightStartPayload,
): Promise<{ status: string; run_id: string; task_id: string }> {
  return requestWorkflowJson(`/api/workflows/${projectId}/overnight`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getOvernightWorkflowStatus(
  projectId: string,
  runId: string,
): Promise<OvernightStatusResponse> {
  return requestWorkflowJson(`/api/workflows/${projectId}/overnight/${runId}`, { method: "GET" });
}

export function stopOvernightWorkflow(
  projectId: string,
  runId: string,
): Promise<{ status: string; run_id: string }> {
  return requestWorkflowJson(`/api/workflows/${projectId}/overnight/${runId}/stop`, { method: "POST" });
}

export function resumeOvernightWorkflow(
  projectId: string,
  runId: string,
  payload: { additional_budget_usd?: number; additional_time_minutes?: number; additional_iterations?: number },
): Promise<{ status: string; run_id: string; task_id: string }> {
  return requestWorkflowJson(`/api/workflows/${projectId}/overnight/${runId}/resume`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getOvernightWorkflowReport(
  projectId: string,
  runId: string,
): Promise<Record<string, unknown>> {
  return requestWorkflowJson(`/api/workflows/${projectId}/overnight/${runId}/report`, { method: "GET" });
}

export function submitTeamTask(
  projectId: string,
  payload: { team: string; instruction: string; context?: Record<string, unknown> },
): Promise<TeamTaskResponse> {
  return requestWorkflowJson(`/api/teams/${projectId}/task`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function submitParallelTeamTasks(
  projectId: string,
  items: Array<{ team: string; instruction: string; context?: Record<string, unknown> }>,
): Promise<TeamParallelResponse> {
  return requestWorkflowJson(`/api/teams/${projectId}/parallel`, {
    method: "POST",
    body: JSON.stringify({ items }),
  });
}
