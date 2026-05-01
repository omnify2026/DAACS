import { create } from "zustand";

import type { CollaborationArtifact } from "../types/agent";

interface CollaborationState {
  projectId: string | null;
  sessionId: string | null;
  sharedGoal: string;
  rounds: Array<{ round_id: string; status: string; created_at: number }>;
  artifacts: CollaborationArtifact[];
  loading: boolean;
  error: string | null;
  setSession: (projectId: string, sessionId: string, goal: string) => void;
  addRoundArtifact: (
    artifact: CollaborationArtifact,
    roundId: string,
    createdAt: number,
    status?: string,
  ) => void;
  reset: () => void;
}

export const useCollaborationStore = create<CollaborationState>((set) => ({
  projectId: null,
  sessionId: null,
  sharedGoal: "",
  rounds: [],
  artifacts: [],
  loading: false,
  error: null,
  setSession: (projectId, sessionId, goal) => set({ projectId, sessionId, sharedGoal: goal }),
  addRoundArtifact: (artifact, roundId, createdAt, status) =>
    set((s) => ({
      rounds: [
        ...s.rounds,
        {
          round_id: roundId,
          status: status ?? artifact.status ?? "completed",
          created_at: createdAt,
        },
      ],
      artifacts: [
        ...s.artifacts,
        {
          ...artifact,
          status: status ?? artifact.status ?? "completed",
        },
      ],
    })),
  reset: () =>
    set({
      projectId: null,
      sessionId: null,
      sharedGoal: "",
      rounds: [],
      artifacts: [],
      loading: false,
      error: null,
    }),
}));
