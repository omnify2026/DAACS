import { create } from "zustand";

import type { AgentRole } from "../types/agent";

export type SequencerDeferredAgentCommand = {
  projectId: string;
  officeRole: AgentRole;
  agentId: string | null;
  message: string;
  promptKey: string | null;
};

type State = {
  pipelineDepth: number;
  deferred: SequencerDeferredAgentCommand[];
  BeginSequencerPipeline: () => void;
  EndSequencerPipeline: () => void;
  IsSequencerPipelineActive: () => boolean;
  PushDeferredAgentCommand: (item: SequencerDeferredAgentCommand) => void;
  DrainDeferredAgentCommands: () => SequencerDeferredAgentCommand[];
};

export const useSequencerDeferredCommandsStore = create<State>((set, get) => ({
  pipelineDepth: 0,
  deferred: [],
  BeginSequencerPipeline: () => set((s) => ({ pipelineDepth: s.pipelineDepth + 1 })),
  EndSequencerPipeline: () =>
    set((s) => ({ pipelineDepth: Math.max(0, s.pipelineDepth - 1) })),
  IsSequencerPipelineActive: () => get().pipelineDepth > 0,
  PushDeferredAgentCommand: (item) =>
    set((s) => ({
      deferred: [
        ...s.deferred,
        {
          projectId: item.projectId.trim(),
          officeRole: item.officeRole,
          agentId: item.agentId != null && item.agentId.trim() !== "" ? item.agentId.trim() : null,
          message: item.message,
          promptKey: item.promptKey != null && item.promptKey.trim() !== "" ? item.promptKey.trim() : null,
        },
      ],
    })),
  DrainDeferredAgentCommands: () => {
    const d = get().deferred;
    set({ deferred: [] });
    return d;
  },
}));
