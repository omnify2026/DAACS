import { requestJson } from "./httpClient";

export interface FactoryCreateResponse {
  status: string;
  project_id: string;
  agent: {
    id: string;
    name: string;
    role: string;
    prompt: string;
    color?: string | null;
  };
  slot: {
    used: number;
    total: number;
    remaining: number;
  };
}

export function createCustomAgent(
  projectId: string,
  prompt: string,
  preferredRole?: string,
  color?: string,
): Promise<FactoryCreateResponse> {
  return requestJson(`/api/agent-factory/${projectId}/create`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      preferred_role: preferredRole,
      color,
    }),
  });
}

export function unlockSlot(projectId: string): Promise<{ status: string; agent_slots: number; custom_agent_count: number }> {
  return requestJson(`/api/agent-factory/${projectId}/unlock-slot`, {
    method: "POST",
  });
}

