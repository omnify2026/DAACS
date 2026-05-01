/* eslint-disable react-hooks/set-state-in-effect, react-hooks/static-components */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bot, CheckCircle2, MessageSquare, PauseCircle, Send, User, X, XCircle } from "lucide-react";

import { useI18n } from "../../i18n";
import { getAgentIconComponent, getAgentAccent } from "../../lib/agentVisuals";
import type { AgentRole } from "../../types/agent";
import { getAgentMeta } from "../../types/agent";
import { useMessengerStore, type ChatMessage, type MessageAction } from "../../stores/messengerStore";

type ActionStyle = {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: typeof CheckCircle2;
};

interface ThreadContact {
  senderId: string;
  senderRole?: string;
  senderName: string;
  roleLabel: string;
  lastMessage: string;
  lastTime: number;
  unread: number;
}

function shorten(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function isPmMessage(message: ChatMessage): boolean {
  const role = message.senderRole?.trim().toLowerCase();
  const senderId = message.senderId.trim().toLowerCase();
  const senderName = message.senderName.trim().toLowerCase();
  return role === "pm" || senderId === "pm" || senderName === "pm";
}

function resolveParticipantName(
  senderId: string,
  senderRole: string | undefined,
  senderName: string,
  userLabel: string,
  systemLabel: string,
): string {
  if (senderId === "user") return userLabel;
  if (senderId === "system") return systemLabel;
  if (senderRole) return getAgentMeta(senderRole as AgentRole).name;
  const trimmed = senderName.trim();
  return trimmed || senderId;
}

function resolveParticipantRoleLabel(
  senderId: string,
  senderRole: string | undefined,
  userLabel: string,
  systemLabel: string,
): string {
  if (senderId === "user") return userLabel;
  if (senderId === "system") return systemLabel;
  if (senderRole) return getAgentMeta(senderRole as AgentRole).title;
  return "";
}

function ContactIcon({
  senderId,
  senderRole,
  className,
}: {
  senderId: string;
  senderRole?: string;
  className?: string;
}) {
  if (senderId === "user") return <User className={className} />;
  if (senderId === "system") return <Bot className={className} />;
  if (!senderRole) return <Bot className={className} />;
  const Icon = getAgentIconComponent(senderRole as AgentRole);
  return <Icon className={className} />;
}

export function AgentMessengerWidget() {
  const { t } = useI18n();
  const {
    isOpen,
    unreadCount,
    messages,
    originalGoal,
    toggleOpen,
    setIsOpen,
    addMessage,
    submitRfiAnswer,
    decideIntent,
    approveStep,
    resolveMessage,
  } = useMessengerStore();

  const [inputText, setInputText] = useState("");
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [seenMessages, setSeenMessages] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const userLabel = t("messenger.user");
  const systemLabel = t("messenger.system");

  const actionStyles = useMemo<Record<MessageAction, ActionStyle>>(
    () => ({
      approve: {
        label: t("owner.approve"),
        color: "text-emerald-300",
        bg: "bg-emerald-500/20",
        border: "border-emerald-500/40",
        icon: CheckCircle2,
      },
      hold: {
        label: t("owner.hold"),
        color: "text-amber-300",
        bg: "bg-amber-500/20",
        border: "border-amber-500/40",
        icon: PauseCircle,
      },
      reject: {
        label: t("owner.reject"),
        color: "text-rose-300",
        bg: "bg-rose-500/20",
        border: "border-rose-500/40",
        icon: XCircle,
      },
    }),
    [t],
  );

  const contacts = useMemo<ThreadContact[]>(() => {
    const map = new Map<string, ThreadContact>();
    map.set("pm", {
      senderId: "pm",
      senderRole: "pm",
      senderName: getAgentMeta("pm").name,
      roleLabel: getAgentMeta("pm").title,
      lastMessage: "",
      lastTime: 0,
      unread: 0,
    });

    messages.forEach((message) => {
      if (message.senderId === "user" || message.senderId === "system") return;

      const normalizedRole = message.senderRole === "pm" || message.senderName === "PM"
        ? "pm"
        : message.senderRole;
      const key = normalizedRole === "pm" ? "pm" : message.senderId;
      const isUnseen = !seenMessages.has(message.id);
      const senderName = resolveParticipantName(
        key,
        normalizedRole,
        message.senderName,
        userLabel,
        systemLabel,
      );
      const roleLabel = resolveParticipantRoleLabel(
        key,
        normalizedRole,
        userLabel,
        systemLabel,
      );

      const existing = map.get(key);
      if (existing) {
        if (message.timestamp > existing.lastTime) {
          existing.lastMessage = shorten(message.text);
          existing.lastTime = message.timestamp;
          existing.senderName = senderName;
          existing.roleLabel = roleLabel;
          existing.senderRole = normalizedRole;
        }
        if (isUnseen && selectedThread !== key) {
          existing.unread += 1;
        }
        return;
      }

      map.set(key, {
        senderId: key,
        senderRole: normalizedRole,
        senderName,
        roleLabel,
        lastMessage: shorten(message.text),
        lastTime: message.timestamp,
        unread: isUnseen && selectedThread !== key ? 1 : 0,
      });
    });

    return Array.from(map.values()).sort(
      (left, right) => right.lastTime - left.lastTime || left.senderName.localeCompare(right.senderName),
    );
  }, [messages, seenMessages, selectedThread, systemLabel, userLabel]);

  const threadMessages = useMemo<ChatMessage[]>(
    () =>
      selectedThread
        ? messages.filter(
            (message) =>
              message.senderId === selectedThread ||
              (message.senderId === "user" && message.senderRole === selectedThread) ||
              (message.senderId === "system" && message.senderRole === selectedThread),
          )
        : [],
    [messages, selectedThread],
  );

  const firstPmMessageId = useMemo(
    () => threadMessages.find((message) => !message.senderId.startsWith("user") && isPmMessage(message))?.id ?? null,
    [threadMessages],
  );
  const originalGoalText = originalGoal.trim();

  useEffect(() => {
    if (!isOpen || !selectedThread) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    setSeenMessages((previous) => {
      const next = new Set(previous);
      messages
        .filter((message) => message.senderId === selectedThread)
        .forEach((message) => next.add(message.id));
      return next;
    });
  }, [isOpen, messages, selectedThread]);

  useEffect(() => {
    if (!isOpen || selectedThread) return;
    const firstActive = contacts.find((contact) => contact.lastTime > 0);
    if (firstActive) setSelectedThread(firstActive.senderId);
  }, [contacts, isOpen, selectedThread]);

  const handleSend = () => {
    const text = inputText.trim();
    if (!text || !selectedThread) return;
    addMessage({
      senderId: "user",
      senderName: userLabel,
      senderRole: selectedThread,
      text,
      actionType: "info",
    });
    setInputText("");
    if (submitRfiAnswer) submitRfiAnswer(text);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleApprovalAction = async (messageId: string, action: MessageAction) => {
    const message = messages.find((item) => item.id === messageId);
    if (!message || message.resolved || !message.actionPayload) return;

    try {
      if (message.actionPayload.intentId && decideIntent) {
        await decideIntent(message.actionPayload.intentId, action, messageId);
      } else if (
        message.actionPayload.planId &&
        message.actionPayload.stepId &&
        action === "approve" &&
        approveStep
      ) {
        await approveStep(message.actionPayload.planId, message.actionPayload.stepId, messageId);
      }

      resolveMessage(messageId, action);
      addMessage({
        senderId: "user",
        senderName: userLabel,
        senderRole: selectedThread ?? undefined,
        text: t("messenger.processed", { action: actionStyles[action].label }),
        actionType: "info",
      });
    } catch {
      addMessage({
        senderId: "system",
        senderName: systemLabel,
        senderRole: selectedThread ?? undefined,
        text: t("messenger.processFailed"),
        actionType: "info",
      });
    }
  };

  const selectedContact = selectedThread
    ? contacts.find((contact) => contact.senderId === selectedThread) ?? null
    : null;

  return (
    <div
      className="fixed bottom-6 right-6 z-[59] flex flex-col items-end pointer-events-auto"
      data-office-overlay="true"
    >
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            data-testid="messenger-panel"
            transition={{ type: "spring", stiffness: 300, damping: 25 }}
            className="mb-4 flex h-[480px] w-[560px] select-text overflow-hidden rounded-2xl border border-[#2A2A4A] bg-[#0E0E1C]/98 shadow-2xl backdrop-blur-xl"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex w-[68px] shrink-0 flex-col items-center gap-2 border-r border-[#1E1E36] bg-[#0A0A16] py-3">
              <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full border border-cyan-500/30 bg-cyan-500/20">
                <Bot className="h-5 w-5 text-cyan-400" />
              </div>
              <div className="mb-1 h-px w-8 bg-[#2A2A4A]" />

              {contacts.map((contact) => {
                const accent = getAgentAccent(contact.senderRole);
                const isActive = selectedThread === contact.senderId;
                const hasMessage = contact.lastTime > 0;

                return (
                  <button
                    key={contact.senderId}
                    type="button"
                    onClick={() => setSelectedThread(contact.senderId)}
                    title={contact.senderName}
                    className={`relative flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all ${
                      isActive
                        ? "scale-110 border-cyan-400/70 shadow-[0_0_12px_rgba(34,211,238,0.3)]"
                        : "border-transparent hover:scale-105"
                    } ${accent.avatar}`}
                  >
                    <ContactIcon senderId={contact.senderId} senderRole={contact.senderRole} className="h-4 w-4" />
                    {hasMessage && (
                      <span
                        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-[#0A0A16] ${accent.dot}`}
                      />
                    )}
                    {contact.unread > 0 && (
                      <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full border border-[#0A0A16] bg-rose-500 text-[9px] font-bold text-white">
                        {contact.unread > 9 ? "9+" : contact.unread}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-12 shrink-0 items-center justify-between border-b border-[#2A2A4A] bg-[#111127] px-4">
                {selectedContact ? (
                  <div className="flex items-center gap-2">
                    <div
                      className={`flex h-7 w-7 items-center justify-center rounded-full border ${getAgentAccent(selectedContact.senderRole).avatar}`}
                    >
                      <ContactIcon
                        senderId={selectedContact.senderId}
                        senderRole={selectedContact.senderRole}
                        className="h-3.5 w-3.5"
                      />
                    </div>
                    <div>
                      <p className={`text-sm font-semibold leading-none ${getAgentAccent(selectedContact.senderRole).name}`}>
                        {selectedContact.senderName}
                      </p>
                      <p className="mt-0.5 text-[10px] leading-none text-gray-500">
                        {selectedContact.roleLabel}
                      </p>
                    </div>
                  </div>
                ) : (
                  <span className="text-sm font-bold text-white">{t("messenger.title")}</span>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setIsOpen(false); }}
                  data-testid="messenger-close-button"
                  className="flex h-7 w-7 items-center justify-center rounded-full text-gray-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="flex-1 select-text space-y-3 overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-[#2A2A4A]">
                {!selectedThread ? (
                  <div className="flex h-full flex-col items-center justify-center space-y-2 text-gray-600">
                    <MessageSquare className="h-8 w-8 opacity-20" />
                    <p className="text-xs">{t("messenger.selectThread")}</p>
                  </div>
                ) : threadMessages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center space-y-2 text-gray-600">
                    <MessageSquare className="h-8 w-8 opacity-20" />
                    <p className="text-xs">{t("messenger.emptyThread")}</p>
                  </div>
                ) : (
                  threadMessages.map((message) => {
                    const isUser = message.senderId === "user";
                    const isSystem = message.senderId === "system";
                    const accent = getAgentAccent(isUser ? "user" : isSystem ? "system" : message.senderRole);
                    const senderName = resolveParticipantName(
                      message.senderId,
                      message.senderRole,
                      message.senderName,
                      userLabel,
                      systemLabel,
                    );

                    return (
                      <div
                        key={message.id}
                        className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                      >
                        <div
                          className={`flex max-w-[85%] gap-2 ${
                            isUser ? "flex-row-reverse" : "flex-row"
                          }`}
                        >
                          <div
                            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border ${accent.avatar}`}
                          >
                            <ContactIcon
                              senderId={message.senderId}
                              senderRole={message.senderRole}
                              className="h-3.5 w-3.5"
                            />
                          </div>
                          <div className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
                            <span className={`px-1 text-[10px] font-medium ${accent.name}`}>{senderName}</span>
                            {message.id === firstPmMessageId && originalGoalText && (
                              <div
                                data-testid="messenger-message-context"
                                className="max-w-full select-text rounded-xl border border-cyan-500/20 bg-cyan-500/10 px-3 py-2 text-[11px] leading-relaxed text-cyan-50"
                              >
                                <span className="mr-1 font-semibold text-cyan-300">
                                  {t("messenger.originalRequest")}
                                </span>
                                <span className="whitespace-pre-wrap break-words">{originalGoalText}</span>
                              </div>
                            )}
                            <div
                              className={`cursor-text select-text whitespace-pre-wrap break-words rounded-2xl border px-3 py-2 text-sm ${
                                isUser
                                  ? "rounded-tr-sm border-indigo-500/30 bg-indigo-600/50 text-white"
                                  : "rounded-tl-sm border-[#2A2A4A] bg-[#1E1E36] text-gray-100"
                              }`}
                            >
                              {message.text}
                            </div>

                            {message.actionType === "approval" && !message.resolved && (
                              <div className="mt-1 flex items-center gap-1.5">
                                {(["approve", "hold", "reject"] as MessageAction[]).map((action) => {
                                  const style = actionStyles[action];
                                  const Icon = style.icon;
                                  return (
                                    <button
                                      key={action}
                                      type="button"
                                      onClick={() => void handleApprovalAction(message.id, action)}
                                      className={`flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-medium transition-all hover:scale-105 ${style.bg} ${style.color} ${style.border}`}
                                    >
                                      <Icon className="h-3 w-3" />
                                      {style.label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}

                            {message.actionType === "approval" && message.resolved && message.resolvedAction && (
                              <div
                                className={`mt-1 flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] opacity-70 ${actionStyles[message.resolvedAction].bg} ${actionStyles[message.resolvedAction].color} ${actionStyles[message.resolvedAction].border}`}
                              >
                                {(() => {
                                  const Icon = actionStyles[message.resolvedAction].icon;
                                  return <Icon className="h-3 w-3" />;
                                })()}
                                {actionStyles[message.resolvedAction].label}
                              </div>
                            )}

                            <span className="px-1 font-mono text-[9px] text-gray-500">
                              {new Date(message.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
                <div ref={messagesEndRef} />
              </div>

              {selectedThread && (
                <div className="shrink-0 border-t border-[#2A2A4A] bg-[#111127] p-3">
                  <div className="relative flex items-center">
                    <input
                      type="text"
                      value={inputText}
                      onChange={(event) => setInputText(event.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={t("messenger.placeholder")}
                      data-testid="messenger-input"
                      className="w-full rounded-full border border-[#2A2A4A] bg-[#0D0D1A] py-2.5 pl-4 pr-12 text-sm text-white placeholder-gray-500 transition-all focus:border-cyan-500/50 focus:outline-none focus:ring-1 focus:ring-cyan-500/50"
                    />
                    <button
                      type="button"
                      onClick={handleSend}
                      disabled={!inputText.trim()}
                      className="absolute right-1.5 rounded-full bg-cyan-600/20 p-1.5 text-cyan-400 transition-colors hover:bg-cyan-600/40 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Send className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <motion.button
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        onClick={(e) => { e.stopPropagation(); toggleOpen(); }}
        data-testid="messenger-toggle"
        className="relative flex h-14 w-14 items-center justify-center rounded-full border border-[#2A2A4A] bg-gradient-to-br from-[#1E1E36] to-[#121223] text-gray-300 shadow-[0_8px_30px_rgb(0,0,0,0.4)] transition-colors hover:text-white"
      >
        <MessageSquare className="h-6 w-6" />
        {unreadCount > 0 && (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-[#121223] bg-rose-500 text-[10px] font-bold text-white shadow-lg"
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </motion.div>
        )}
      </motion.button>
    </div>
  );
}
