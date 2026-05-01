import { create } from "zustand";
import type { RfiQuestion, RfiKnownAnswer } from "../services/tauriCli";

export type MessageAction = "approve" | "hold" | "reject";

export type MessageActionType =
  | "rfi"          // PM 질의 — 텍스트 답변
  | "approval"     // 승인 요청 — approve/hold/reject 버튼
  | "info";        // 단순 알림 — 읽기만

export interface MessageActionPayload {
  intentId?: string;
  planId?: string;
  stepId?: string;
  agentId?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole?: string;
  text: string;
  timestamp: number;
  actionType: MessageActionType;
  actionPayload?: MessageActionPayload;
  resolved?: boolean;          // 승인 요청이 처리 완료 되었는지
  resolvedAction?: MessageAction;
}

export type SubmitRfiFn = (answer: string) => void;
export type DecideIntentFn = (
  intentId: string,
  action: MessageAction,
  messageId: string,
) => Promise<void>;
export type ApproveStepFn = (
  planId: string,
  stepId: string,
  messageId: string,
) => Promise<void>;

interface MessengerState {
  isOpen: boolean;
  unreadCount: number;
  messages: ChatMessage[];

  // RFI backing state
  pendingQuestions: RfiQuestion[];
  historicalAnswers: RfiKnownAnswer[];
  originalGoal: string;

  // Callbacks
  submitRfiAnswer: SubmitRfiFn | null;
  decideIntent: DecideIntentFn | null;
  approveStep: ApproveStepFn | null;

  // Actions
  setIsOpen: (isOpen: boolean) => void;
  toggleOpen: () => void;
  addMessage: (msg: Omit<ChatMessage, "id" | "timestamp">) => void;
  clearMessages: () => void;
  resolveMessage: (messageId: string, action: MessageAction) => void;

  setRfiContext: (questions: RfiQuestion[], answers: RfiKnownAnswer[], originalGoal: string) => void;
  setSubmitRfiAnswer: (fn: SubmitRfiFn | null) => void;
  setDecideIntent: (fn: DecideIntentFn | null) => void;
  setApproveStep: (fn: ApproveStepFn | null) => void;

  // Convenience: push an approval request as a chat message
  pushApprovalRequest: (opts: {
    senderName: string;
    senderRole?: string;
    text: string;
    intentId?: string;
    planId?: string;
    stepId?: string;
    agentId?: string;
  }) => void;
}

let msgCounter = 0;
function nextId(): string {
  msgCounter += 1;
  return `msg-${Date.now()}-${msgCounter}`;
}

export const useMessengerStore = create<MessengerState>((set) => ({
  isOpen: false,
  unreadCount: 0,
  messages: [],

  pendingQuestions: [],
  historicalAnswers: [],
  originalGoal: "",

  submitRfiAnswer: null,
  decideIntent: null,
  approveStep: null,

  setIsOpen: (isOpen) =>
    set((s) => ({
      isOpen,
      unreadCount: isOpen ? 0 : s.unreadCount,
    })),

  toggleOpen: () =>
    set((s) => ({
      isOpen: !s.isOpen,
      unreadCount: !s.isOpen ? 0 : s.unreadCount,
    })),

  addMessage: (msg) =>
    set((s) => {
      const isWindowInactive = !s.isOpen;
      return {
        messages: [
          ...s.messages,
          { ...msg, id: nextId(), timestamp: Date.now() },
        ],
        unreadCount: isWindowInactive ? s.unreadCount + 1 : s.unreadCount,
      };
    }),

  clearMessages: () =>
    set({
      messages: [],
      unreadCount: 0,
    }),

  resolveMessage: (messageId, action) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === messageId ? { ...m, resolved: true, resolvedAction: action } : m,
      ),
    })),

  setRfiContext: (questions, answers, goal) =>
    set({
      pendingQuestions: questions,
      historicalAnswers: answers,
      originalGoal: goal,
    }),

  setSubmitRfiAnswer: (fn) => set({ submitRfiAnswer: fn }),
  setDecideIntent: (fn) => set({ decideIntent: fn }),
  setApproveStep: (fn) => set({ approveStep: fn }),

  pushApprovalRequest: (opts) =>
    set((s) => {
      const msg: ChatMessage = {
        id: nextId(),
        senderId: opts.agentId ?? opts.senderRole ?? "system",
        senderName: opts.senderName,
        senderRole: opts.senderRole,
        text: opts.text,
        timestamp: Date.now(),
        actionType: "approval",
        actionPayload: {
          intentId: opts.intentId,
          planId: opts.planId,
          stepId: opts.stepId,
          agentId: opts.agentId,
        },
        resolved: false,
      };
      return {
        messages: [...s.messages, msg],
        unreadCount: s.isOpen ? s.unreadCount : s.unreadCount + 1,
        isOpen: true, // Auto-open on approval request
      };
    }),
}));
