import { create } from "zustand";

interface OfficeSceneState {
  arrivingAgentIds: string[];
  agentSlots: number;
  emptySlots: number;
  setArrivingAgentIds: (ids: string[]) => void;
  setSlotState: (agentSlots: number, used: number) => void;
}

export const useOfficeSceneStore = create<OfficeSceneState>((set) => ({
  arrivingAgentIds: [],
  agentSlots: 3,
  emptySlots: 3,
  setArrivingAgentIds: (ids) => set({ arrivingAgentIds: ids }),
  setSlotState: (agentSlots, used) =>
    set({
      agentSlots,
      emptySlots: Math.max(0, agentSlots - used),
    }),
}));
