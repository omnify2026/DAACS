import { useState, useRef, useEffect, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
    runProject,
    getProjectMessages,
    sendProjectInput,
    type RequirementsPlan,
} from "@/lib/daacsApi";
import { logWarning } from "@/lib/logger";

export type PMType = "ui" | "tech";

export interface ChatMessage {
    id: number;
    role: "user" | "pm";
    content: string;
    pmType?: PMType; // Optional for unified mode
}

export interface UseDualChatOptions {
    projectId: string;
    projectStatus?: string;
    planStatus: string;
    onPlanReady?: (plan: RequirementsPlan) => void;
    onPlanStatusChange?: (status: string) => void;
}

/**
 * Single Analyst Chat Hook (Unified Mode)
 * Replaces dual PM mode with single analyst conversation
 */
export function useDualChat({
    projectId,
    projectStatus,
    planStatus,
    onPlanReady: _onPlanReady,
    onPlanStatusChange: _onPlanStatusChange,
}: UseDualChatOptions) {
    const { toast } = useToast();

    // 🆕 Unified mode - no active PM selection needed
    const [activePM, setActivePM] = useState<PMType>("ui"); // Kept for compatibility

    // Unified messages
    const [messages, setMessages] = useState<ChatMessage[]>([]);

    // Loading states
    const [isProceeding, setIsProceeding] = useState(false);
    const hasStartedRef = useRef(false);
    const messageIdRef = useRef(0);
    // Auto-start orchestrator during RFI phase
    useEffect(() => {
        const completedStatuses = new Set(["completed", "completed_with_warnings", "failed", "stopped"]);
        if (projectStatus && completedStatuses.has(projectStatus)) return;
        const shouldRun = planStatus === "rfi_pending" || planStatus === "draft" || planStatus === "planning" || planStatus === "created";
        if (!shouldRun || !projectId) return;
        if (!hasStartedRef.current) {
            hasStartedRef.current = true;
            runProject(projectId).catch((e) => {
                logWarning("[UnifiedChat] runProject failed:", e);
            });
        }
    }, [planStatus, projectId, projectStatus]);

    // Always poll messages so history persists after navigation
    useEffect(() => {
        if (!projectId) return;
        let cancelled = false;

        const pollMessages = async () => {
            try {
                const serverMessages = await getProjectMessages(projectId);
                if (cancelled) return;
                const mapped: ChatMessage[] = serverMessages.map((msg: any) => ({
                    id: msg.id || ++messageIdRef.current,
                    role: msg.role === "user" ? "user" : "pm",
                    content: msg.content,
                }));
                messageIdRef.current = mapped.length;
                setMessages(mapped);
            } catch (e) {
                if (!cancelled) {
                    logWarning("[UnifiedChat] Failed to poll messages:", e);
                }
            }
        };

        pollMessages();
        const interval = setInterval(pollMessages, 2000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
    }, [projectId]);

    // Send message
    const sendMessage = useCallback((content: string) => {
        const userMsg: ChatMessage = {
            id: ++messageIdRef.current,
            role: "user",
            content,
        };
        setMessages((prev) => [...prev, userMsg]);
        sendProjectInput(projectId, content).catch(() => {
            toast({
                title: "오류",
                description: "메시지 전송에 실패했습니다.",
                variant: "destructive",
            });
        });
    }, [projectId, toast]);

    // Proceed with plan generation
    const proceedToPlanning = useCallback(async () => {
        setIsProceeding(true);
        try {
            await sendProjectInput(projectId, "go");
            toast({ title: "요청 완료", description: "분석을 마무리합니다..." });
        } catch {
            toast({ title: "오류", description: "요청 전송에 실패했습니다", variant: "destructive" });
        } finally {
            setIsProceeding(false);
        }
    }, [projectId, toast]);

    // 🆕 Unified interface - keep dual PM interface for backwards compatibility
    const currentMessages = messages;
    const uiSufficient = false;
    const techSufficient = false;
    const canProceed = false;

    return {
        // State (compatibility with dual PM interface)
        activePM,
        setActivePM,
        currentMessages,
        uiMessages: messages, // Same as unified
        techMessages: messages, // Same as unified
        uiSufficient,
        techSufficient,
        isCurrentSufficient: false,
        canProceed,
        isProceeding,

        // Actions
        sendMessage,
        proceedToPlanning,
    };
}
