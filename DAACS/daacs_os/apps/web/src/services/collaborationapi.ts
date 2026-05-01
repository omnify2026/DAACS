import { requestJson } from "./httpClient";
import type { CollaborationArtifact } from "../types/agent";

interface CollaborationRequestOptions {
  signal?: AbortSignal;
  projectCwd?: string | null;
}

export function createSession(
  projectId: string,
  sharedGoal: string,
  participants: string[],
  options: CollaborationRequestOptions = {},
): Promise<{ status: string; session_id: string; shared_goal: string; participants: string[] }> {
  return requestJson(`/api/collaboration/${projectId}/sessions`, {
    method: "POST",
    body: JSON.stringify({ shared_goal: sharedGoal, participants }),
    signal: options.signal,
  });
}

export function startRound(
  projectId: string,
  sessionId: string,
  prompt: string,
  teams: string[],
  options: CollaborationRequestOptions = {},
): Promise<{ status: string; session_id: string; round: { round_id: string; status: string; created_at: number }; artifact: CollaborationArtifact }> {
  return requestJson(`/api/collaboration/${projectId}/sessions/${sessionId}/rounds`, {
    method: "POST",
    body: JSON.stringify({
      prompt,
      teams,
      ...(options.projectCwd ? { project_cwd: options.projectCwd } : {}),
    }),
    signal: options.signal,
  });
}

export function getSession(projectId: string, sessionId: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/collaboration/${projectId}/sessions/${sessionId}`, { method: "GET" });
}

export function stopSession(
  projectId: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return requestJson(`/api/collaboration/${projectId}/sessions/${sessionId}/stop`, {
    method: "POST",
  });
}
