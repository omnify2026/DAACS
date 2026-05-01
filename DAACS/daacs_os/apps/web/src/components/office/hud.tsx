/**
 * DAACS OS Heads-Up Display component.

 */
/* eslint-disable react-hooks/set-state-in-effect */
import { motion, AnimatePresence, type PanInfo } from "framer-motion";
import { useOfficeStore } from "../../stores/officeStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import { getAgentMeta } from "../../types/agent";
import type { AgentRole, AgentTeam } from "../../types/agent";
import {
    Clock, Users, AlertTriangle, X, Play, Workflow, RefreshCw,
    MoreHorizontal, ChevronRight, Check,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { OwnerOpsPanel } from "./OwnerOpsPanel";
import { AgentFactoryModal } from "./AgentFactoryModal";
import { AgentsMetadataEditorModal } from "./AgentsMetadataEditorModal";
import { AgentWorkspace, type AgentWorkspaceTab } from "./AgentWorkspace";
import { CompanyBuilderModal } from "./CompanyBuilderModal";
import { AgentMessengerWidget } from "./AgentMessengerWidget";
import { useMessengerStore } from "../../stores/messengerStore";
import { unlockAgentSlot } from "../../services/agentApi";
import {
    getSavedLocalLlmBaseUrl,
    isTauri,
    setSavedLocalLlmBaseUrl,
} from "../../services/tauriCli";
import { useI18n, type Locale } from "../../i18n";
import { STORAGE_KEY_OWNER_DOCK_POS } from "../../constants";
import { OfficeCustomizationPanel } from "./OfficeCustomizationPanel";
import { getAgentIconComponent } from "../../lib/agentVisuals";
import { LlmSettingsModal } from "./LlmSettingsModal";
import { NotificationToast } from "./Effects";

const statusColors: Record<string, string> = {
    idle: 'bg-gray-400',
    working: 'bg-emerald-500',
    reviewing: 'bg-sky-500',
    meeting: 'bg-violet-500',
    walking: 'bg-amber-500',
    error: 'bg-red-500',
    celebrating: 'bg-cyan-400',
};

// Settings panel

export function SettingsPanel({ onClose }: { onClose: () => void }) {
    const { t } = useI18n();
    const [localLlmBaseUrl, setLocalLlmBaseUrl] = useState<string>(() => getSavedLocalLlmBaseUrl() ?? "");
    const [localLlmFeedback, setLocalLlmFeedback] = useState<string>("");

    const saveLocalLlmBaseUrl = () => {
        const trimmed = localLlmBaseUrl.trim();
        if (trimmed === "") {
            setSavedLocalLlmBaseUrl(null);
            setLocalLlmFeedback(t("hud.localLlm.cleared"));
            return;
        }
        try {
            const url = new URL(trimmed);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                setLocalLlmFeedback(t("hud.localLlm.invalidUrl"));
                return;
            }
            setSavedLocalLlmBaseUrl(url.toString().replace(/\/$/, ""));
            setLocalLlmFeedback(t("hud.localLlm.saved"));
        } catch {
            setLocalLlmFeedback(t("hud.localLlm.invalidUrl"));
        }
    };

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="fixed bottom-20 left-1/2 -translate-x-1/2 z-[60] bg-[#1A1A2E]/95 backdrop-blur-xl rounded-2xl p-6 shadow-2xl border border-[#2A2A4A] w-[400px]"
            onClick={(e) => e.stopPropagation()}
        >
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-white font-['Press_Start_2P']">{t("hud.settings")}</h3>
                <button onClick={onClose} className="p-1 rounded-lg hover:bg-white/5 text-gray-400 hover:text-white">
                    <X className="w-4 h-4" />
                </button>
            </div>
            <div className="space-y-3">
                <div className="flex items-center justify-between bg-[#0F0F23]/60 backdrop-blur-sm rounded-lg p-3 border border-[#2A2A4A]/50">
                    <span className="text-sm text-white">{t("hud.particleEffects")}</span>
                    <div className="w-10 h-5 bg-emerald-500/30 rounded-full relative cursor-pointer">
                        <div className="absolute right-0.5 top-0.5 w-4 h-4 bg-emerald-500 rounded-full" />
                    </div>
                </div>
                <div className="flex items-center justify-between bg-[#0F0F23]/60 backdrop-blur-sm rounded-lg p-3 border border-[#2A2A4A]/50">
                    <span className="text-sm text-white">{t("hud.minimapOverlay")}</span>
                    <div className="w-10 h-5 bg-emerald-500/30 rounded-full relative cursor-pointer">
                        <div className="absolute right-0.5 top-0.5 w-4 h-4 bg-emerald-500 rounded-full" />
                    </div>
                </div>
                <div className="bg-[#0F0F23]/60 backdrop-blur-sm rounded-lg p-3 border border-[#2A2A4A]/50 space-y-2">
                    <div className="text-sm text-white">{t("hud.localLlm.title")}</div>
                    <input
                        value={localLlmBaseUrl}
                        onChange={(e) => {
                            setLocalLlmBaseUrl(e.target.value);
                            if (localLlmFeedback !== "") setLocalLlmFeedback("");
                        }}
                        onBlur={saveLocalLlmBaseUrl}
                        placeholder={t("hud.localLlm.placeholder")}
                        className="w-full rounded bg-[#0b1220] border border-[#2A2A4A] px-2.5 py-2 text-xs text-white focus:outline-none focus:ring-2 focus:ring-cyan-500/40"
                    />
                    <div className="flex items-center justify-between gap-2">
                        <button
                            type="button"
                            onClick={saveLocalLlmBaseUrl}
                            className="px-2.5 py-1.5 rounded border border-cyan-500/50 text-cyan-300 hover:bg-cyan-500/20 text-xs"
                        >
                            {t("hud.localLlm.save")}
                        </button>
                        {localLlmFeedback !== "" && (
                            <span className="text-[10px] text-gray-400 truncate" title={localLlmFeedback}>
                                {localLlmFeedback}
                            </span>
                        )}
                    </div>
                </div>
                <div className="pt-2 border-t border-[#2A2A4A]">
                    <div className="text-[10px] text-gray-500 text-center">DAACS OS 버전 1.0.0</div>
                </div>
            </div>
        </motion.div>
    );
}

type HudProps = {
    onLogout?: () => void | Promise<void>;
    showLogout?: boolean;
};

const LOCALES: Locale[] = ["ko", "en"];

export function HUD({ onLogout, showLogout = false }: HudProps) {
    const { t, locale, setLocale } = useI18n();
    const {
        agents,
        notifications,
        gameState,
        startMeeting,
        endMeeting,
        showSettings,
        editMode,
        toggleSettings,
        commandHistory,
        selectAgent,
        runTeamTask,
        runTeamSwarm,
        projectId,
        addNotification,
        dismissNotification,
        unlockSlotLocal,
    } = useOfficeStore();
    const activePlan = useWorkflowStore((state) => state.activePlan);
    const planView = useWorkflowStore((state) => state.planView);
    const executionPlans = useWorkflowStore((state) => state.plans);
    const executionIntents = useWorkflowStore((state) => state.executionIntents);
    const teamExecutionRunning = useWorkflowStore((state) => state.teamExecutionRunning);
    const createExecutionPlan = useWorkflowStore((state) => state.createExecutionPlan);
    const executeExecutionPlan = useWorkflowStore((state) => state.executeExecutionPlan);
    const approveExecutionStep = useWorkflowStore((state) => state.approveExecutionStep);
    const decideExecutionIntent = useWorkflowStore((state) => state.decideExecutionIntent);
    const refreshRuntimeContext = useWorkflowStore((state) => state.refreshRuntimeContext);
    const refreshPlans = useWorkflowStore((state) => state.refreshPlans);
    const isMeeting = gameState === 'MEETING';
    const errorCount = agents.filter(a => a.status === 'error').length;
    const [showPlannerMenu, setShowPlannerMenu] = useState(false);
    const [showTeamMenu, setShowTeamMenu] = useState(false);
    const [showFactoryModal, setShowFactoryModal] = useState(false);
    const [showCompanyBuilderModal, setShowCompanyBuilderModal] = useState(false);

    const [showMainMenu, setShowMainMenu] = useState(false);
    const [showAgentCommandModal, setShowAgentCommandModal] = useState(false);
    const [showLlmSettingsModal, setShowLlmSettingsModal] = useState(false);
    const [agentWorkspaceInitialTab, setAgentWorkspaceInitialTab] = useState<AgentWorkspaceTab>("task");
    const [showAgentsMetadataModal, setShowAgentsMetadataModal] = useState(false);
    const [showManagePanels, setShowManagePanels] = useState(true);
    const [langFlyoutOpen, setLangFlyoutOpen] = useState(false);
    const mainMenuRef = useRef<HTMLDivElement>(null);
    const [planGoal, setPlanGoal] = useState("");
    const [ownerDock, setOwnerDock] = useState(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY_OWNER_DOCK_POS);
            if (!raw) return { x: 160, y: 64 };
            const parsed = JSON.parse(raw) as { x: number; y: number };
            return { x: Number(parsed.x) || 160, y: Number(parsed.y) || 64 };
        } catch {
            return { x: 160, y: 64 };
        }
    });


    const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

    const clampDock = (x: number, y: number, width: number, height: number) => {
        const maxX = Math.max(8, window.innerWidth - width - 8);
        const maxY = Math.max(8, window.innerHeight - height - 8);
        return {
            x: clamp(x, 8, maxX),
            y: clamp(y, 8, maxY),
        };
    };

    useEffect(() => {
        localStorage.setItem(STORAGE_KEY_OWNER_DOCK_POS, JSON.stringify(ownerDock));
    }, [ownerDock]);



    useEffect(() => {
        if (!showMainMenu) return;
        const onPointerDown = (e: PointerEvent) => {
            const el = mainMenuRef.current;
            if (el && !el.contains(e.target as Node)) {
                setShowMainMenu(false);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        return () => document.removeEventListener("pointerdown", onPointerDown);
    }, [showMainMenu]);

    useEffect(() => {
        if (!showMainMenu) setLangFlyoutOpen(false);
    }, [showMainMenu]);

    useEffect(() => {
        if (!projectId) return;
        void refreshRuntimeContext(projectId);
        void refreshPlans(projectId);
    }, [projectId, refreshRuntimeContext, refreshPlans]);

    // --- Messenger: bind approval callbacks & push pending intents ---
    const pushedIntentIdsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        const store = useMessengerStore.getState();

        store.setDecideIntent(async (intentId, action, messageId) => {
            const mapped = action === "approve" ? "approved" as const : action === "reject" ? "rejected" as const : "hold" as const;
            const result = await decideExecutionIntent(intentId, mapped, undefined, addNotification);
            if (result) {
                useMessengerStore.getState().resolveMessage(messageId, action);
            }
        });

        store.setApproveStep(async (planId, stepId, messageId) => {
            if (!projectId) return;
            await approveExecutionStep(projectId, planId, stepId, undefined, addNotification);
            useMessengerStore.getState().resolveMessage(messageId, "approve");
        });
    }, [projectId, decideExecutionIntent, approveExecutionStep, addNotification]);

    useEffect(() => {
        const pendingIntents = executionIntents.filter((i) => i.status === "pending_approval");
        for (const intent of pendingIntents) {
            if (pushedIntentIdsRef.current.has(intent.intent_id)) continue;
            pushedIntentIdsRef.current.add(intent.intent_id);
            useMessengerStore.getState().pushApprovalRequest({
                senderName: intent.agent_role ? `${intent.agent_role}` : "에이전트",
                senderRole: intent.agent_role ?? undefined,
                text: `🔐 승인 요청: ${intent.title}\n${intent.kind} → ${intent.target}`,
                intentId: intent.intent_id,
                agentId: intent.agent_id,
            });
        }
    }, [executionIntents]);

    const onOwnerDragEnd = (_event: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
        setOwnerDock((prev) => clampDock(prev.x + info.offset.x, prev.y + info.offset.y, 420, 680));
    };



    const now = new Date();
    const dateLocale = locale === "ko" ? "ko-KR" : "en-US";
    const timeStr = now.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
    const dateStr = now.toLocaleDateString(dateLocale, { year: 'numeric', month: 'short', day: 'numeric' });

    const toggleMeeting = () => {
        if (isMeeting) { endMeeting(); } else { startMeeting(); }
    };
    const focusRole = (role: AgentRole) => {
        const target = agents.find((agent) => agent.role === role);
        if (target) {
            selectAgent(target.id);
        }
    };

    const onMenuPickAgent = () => {
        setShowMainMenu(false);
        setAgentWorkspaceInitialTab("task");
        setShowAgentCommandModal(true);
    };

    const onMenuPickAgentManagement = () => {
        setShowMainMenu(false);
        setShowAgentsMetadataModal(true);
    };

    const onMenuPickCompanyBuilder = () => {
        setShowMainMenu(false);
        setShowCompanyBuilderModal(true);
    };

    const onMenuPickManage = () => {
        setShowMainMenu(false);
        setShowManagePanels((v) => !v);
    };

    const onMenuPickSettings = () => {
        setShowMainMenu(false);
        setShowLlmSettingsModal(false);
        toggleSettings();
    };

    const onMenuPickLlmSettings = () => {
        setShowMainMenu(false);
        if (showSettings) {
            toggleSettings();
        }
        setShowLlmSettingsModal(true);
    };

    const teamEntries: Array<{ team: AgentTeam; label: string; hint: string; instruction: string }> = [
        {
            team: "development_team",
            label: t("hud.team.dev.label"),
            hint: t("hud.team.dev.hint"),
            instruction: t("hud.team.dev.instruction"),
        },
        {
            team: "review_team",
            label: t("hud.team.review.label"),
            hint: t("hud.team.review.hint"),
            instruction: t("hud.team.review.instruction"),
        },
        {
            team: "marketing_team",
            label: t("hud.team.marketing.label"),
            hint: t("hud.team.marketing.hint"),
            instruction: t("hud.team.marketing.instruction"),
        },
    ];

    const completedPlanSteps = activePlan
        ? activePlan.steps.filter((step) => step.status === "completed" || step.status === "approved").length
        : 0;
    const approvalCount = planView?.approvalQueue.length ?? 0;
    const createPlan = async () => {
        if (!projectId) return;
        const created = await createExecutionPlan(projectId, planGoal, addNotification);
        if (created) {
            setPlanGoal("");
        }
    };

    const runPlan = async (planId: string) => {
        if (!projectId) return;
        await executeExecutionPlan(projectId, planId, addNotification);
    };

    const handleNotificationAction = (notification: typeof notifications[number]) => {
        if (notification.action === "open_goal_recovery") {
            setAgentWorkspaceInitialTab("task");
            setShowAgentCommandModal(true);
            dismissNotification(notification.id);
            const focusRecovery = () => {
                window.dispatchEvent(new CustomEvent("daacs:open-goal-recovery"));
                const recoveryPanel =
                    document.querySelector('[data-testid="goal-recovery-panel"]') ??
                    document.querySelector('[data-testid="goal-quality-repair-button"]') ??
                    document.querySelector('[data-testid="goal-release-readiness"]');
                recoveryPanel?.scrollIntoView({ behavior: "smooth", block: "center" });
            };
            window.setTimeout(focusRecovery, 120);
            window.setTimeout(focusRecovery, 450);
            return;
        }
        dismissNotification(notification.id);
    };

    return (
        <>
            <div className="fixed top-16 right-4 z-[120] pointer-events-auto space-y-2">
                <AnimatePresence>
                    {notifications.slice(-5).map((notification) => (
                        <NotificationToast
                            key={notification.id}
                            type={notification.type}
                            message={notification.message}
                            actionLabel={notification.actionLabel}
                            onAction={notification.action ? () => handleNotificationAction(notification) : undefined}
                            onDismiss={() => dismissNotification(notification.id)}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {/* Top Bar */}
            <div className="absolute top-0 left-0 right-0 h-12 z-[70] pointer-events-none">
                <div className="flex items-center justify-between h-full px-4 pointer-events-auto">
                    <div className="flex items-center gap-3">
                        <div className="font-['Press_Start_2P'] text-sm text-cyan-400 tracking-wider" style={{ textShadow: '0 0 8px rgba(0,243,255,0.5)' }}>
                            DAACS OS
                        </div>
                        <div className="h-5 w-[1px] bg-[#2A2A4A]" />
                        <div className="text-xs text-gray-400 font-mono">{dateStr}</div>
                    </div>
                    <div className="flex items-center gap-4">
                        {errorCount > 0 && (
                            <motion.div
                                className="flex items-center gap-1.5 px-3 py-1 bg-red-500/10 border border-red-500/30 rounded-full"
                                animate={{ opacity: [1, 0.5, 1] }}
                                transition={{ duration: 1, repeat: Infinity }}
                            >
                                <AlertTriangle className="w-3.5 h-3.5 text-red-500" />
                                <span className="text-xs text-red-500 font-bold">{errorCount}</span>
                            </motion.div>
                        )}
                        <div className="flex items-center gap-1.5 text-gray-400">
                            <Clock className="w-4 h-4" />
                            <span className="text-sm font-mono">{timeStr}</span>
                        </div>
                        <div className="relative" ref={mainMenuRef}>
                            <button
                                type="button"
                                onClick={() => setShowMainMenu((v) => !v)}
                                aria-expanded={showMainMenu}
                                aria-haspopup="menu"
                                aria-label={t("hud.mainMenu.open")}
                                data-testid="hud-main-menu-button"
                                className="w-10 h-10 rounded-full flex items-center justify-center bg-[#1A1A2E]/95 border border-[#2A2A4A]/70 text-gray-300 hover:text-white hover:border-cyan-500/40 shadow-lg backdrop-blur-md transition-colors"
                            >
                                <MoreHorizontal className="w-5 h-5" />
                            </button>
                            <AnimatePresence>
                                {showMainMenu && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -8 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0, y: -8 }}
                                        transition={{ duration: 0.15 }}
                                        role="menu"
                                        className="absolute right-0 top-full mt-2 min-w-[11rem] py-1 rounded-xl bg-[#1A1A2E]/98 backdrop-blur-xl border border-[#2A2A4A] shadow-2xl z-50"
                                    >
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickAgent}
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.agent")}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickCompanyBuilder}
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.companyBuilder")}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickAgentManagement}
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.agentManagement")}
                                        </button>
                                        <div className="h-px bg-[#2A2A4A] my-1" role="separator" />
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickManage}
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.manage")}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickSettings}
                                            data-testid="hud-office-customization-menu-item"
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.officeCustomization")}
                                        </button>
                                        <button
                                            type="button"
                                            role="menuitem"
                                            onClick={onMenuPickLlmSettings}
                                            data-testid="hud-byok-settings-menu-item"
                                            className="w-full text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                        >
                                            {t("hud.menu.byokSettings")}
                                        </button>
                                        <div className="h-px bg-[#2A2A4A] my-1" role="separator" />
                                        <div className="relative">
                                            <button
                                                type="button"
                                                role="menuitem"
                                                aria-expanded={langFlyoutOpen}
                                                aria-haspopup="menu"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setLangFlyoutOpen((v) => !v);
                                                }}
                                                className="w-full flex items-center justify-between gap-2 text-left px-4 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                            >
                                                <span>{t("hud.menu.language")}</span>
                                                <ChevronRight className={`w-4 h-4 shrink-0 text-gray-400 transition-transform ${langFlyoutOpen ? "rotate-90" : ""}`} aria-hidden />
                                            </button>
                                            <AnimatePresence>
                                                {langFlyoutOpen && (
                                                    <motion.div
                                                        role="menu"
                                                        initial={{ opacity: 0, x: 6 }}
                                                        animate={{ opacity: 1, x: 0 }}
                                                        exit={{ opacity: 0, x: 6 }}
                                                        transition={{ duration: 0.12 }}
                                                        className="absolute right-full top-0 mr-1 min-w-[11rem] py-1 rounded-xl bg-[#1A1A2E]/99 backdrop-blur-xl border border-[#2A2A4A] shadow-2xl z-[60]"
                                                        onPointerDown={(e) => e.stopPropagation()}
                                                    >
                                                        {LOCALES.map((loc) => (
                                                            <button
                                                                key={loc}
                                                                type="button"
                                                                role="menuitem"
                                                                onClick={(ev) => {
                                                                    ev.stopPropagation();
                                                                    setLocale(loc);
                                                                    setLangFlyoutOpen(false);
                                                                    setShowMainMenu(false);
                                                                }}
                                                                className="w-full flex items-center justify-between gap-2 text-left px-3 py-2.5 text-sm text-white hover:bg-[#16213E] transition-colors"
                                                            >
                                                                <span>{t(`lang.${loc}`)}</span>
                                                                {locale === loc ? (
                                                                    <Check className="w-4 h-4 shrink-0 text-emerald-500" strokeWidth={2.5} aria-hidden />
                                                                ) : (
                                                                    <span className="w-4 h-4 shrink-0" aria-hidden />
                                                                )}
                                                            </button>
                                                        ))}
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                        {/* Project Switch */}
                                        {onLogout != null && (
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    setShowMainMenu(false);
                                                    useMessengerStore.getState().clearMessages();
                                                    void onLogout();
                                                }}
                                                className="w-full text-left px-4 py-2.5 text-sm text-cyan-300 hover:bg-cyan-500/10 transition-colors border-t border-[#2A2A4A]/50"
                                            >
                                                🔄 {t("hud.menu.switchProject")}
                                            </button>
                                        )}
                                        {showLogout && onLogout != null ? (
                                            <button
                                                type="button"
                                                role="menuitem"
                                                onClick={() => {
                                                    setShowMainMenu(false);
                                                    useMessengerStore.getState().clearMessages();
                                                    void onLogout();
                                                }}
                                                className="w-full text-left px-4 py-2.5 text-sm text-rose-300 hover:bg-rose-500/10 transition-colors"
                                            >
                                                {t("auth.logout")}
                                            </button>
                                        ) : null}
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>
                    </div>
                </div>
            </div>

            {/* Left: Agent List */}
            {!editMode && <div className="absolute top-16 left-3 z-40 pointer-events-auto">
                <div className="bg-[#0F0F23]/60 backdrop-blur-sm rounded-xl p-3 space-y-1 w-[140px] border border-[#2A2A4A]/50">
                    <div className="flex items-center gap-2 px-1 mb-2">
                        <Users className="w-3.5 h-3.5 text-gray-400" />
                        <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">{t("hud.team")}</span>
                    </div>
                    {agents.map((agent) => {
                        const Icon = getAgentIconComponent(agent.role, agent.meta);
                        const meta = agent.meta ?? getAgentMeta(agent.role);
                        return (
                            <div
                                key={agent.id}
                                className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 transition-colors cursor-pointer group"
                                onClick={() => selectAgent(agent.id)}
                            >
                                <div className={`w-1.5 h-1.5 rounded-full ${statusColors[agent.status] || 'bg-gray-400'}`}
                                    style={{ boxShadow: agent.status === 'error' ? '0 0 6px #EF4444' : 'none' }} />
                                {Icon && <Icon className="w-3.5 h-3.5 text-gray-400 group-hover:text-white transition-colors" />}
                                <span className="text-xs text-gray-400 group-hover:text-white transition-colors truncate">
                                    {meta.name}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </div>}

            {showManagePanels && !editMode && (
                <>
                    <motion.div
                        className="absolute top-0 left-0 z-[55] pointer-events-auto"
                        style={{ x: ownerDock.x, y: ownerDock.y }}
                        drag
                        dragMomentum={false}
                        onDragEnd={onOwnerDragEnd}
                    >
                        <OwnerOpsPanel
                            className="pointer-events-auto"
                            agents={agents}
                            notifications={notifications}
                            commandHistory={commandHistory}
                            activePlan={activePlan}
                            planView={planView}
                            executionIntents={executionIntents}
                            teamExecutionRunning={teamExecutionRunning}
                            onFocusRole={focusRole}
                            onApproveStep={async (planId, stepId) => {
                                if (!projectId) return;
                                await approveExecutionStep(projectId, planId, stepId, undefined, addNotification);
                            }}
                            onDecideIntent={async (intentId, action) => {
                                return decideExecutionIntent(intentId, action, undefined, addNotification);
                            }}
                            projectId={projectId}
                            addNotification={addNotification}
                        />
                    </motion.div>
                </>
            )}

            <AgentWorkspace
                open={showAgentCommandModal}
                onClose={() => setShowAgentCommandModal(false)}
                onOpenFactory={() => {
                    setShowAgentCommandModal(false);
                    setShowFactoryModal(true);
                }}
                initialTab={agentWorkspaceInitialTab}
            />

            <AgentsMetadataEditorModal
                open={showAgentsMetadataModal}
                onClose={() => setShowAgentsMetadataModal(false)}
            />

            {/* Bottom: Action Bar */}
            {!editMode && <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-50 pointer-events-auto">
                <motion.div
                    className="flex items-center bg-[#1A1A2E]/90 backdrop-blur-xl rounded-full px-3 py-2 shadow-2xl gap-2 border border-[#2A2A4A]/50"
                    initial={{ y: 60, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.5, type: "spring" }}
                >
                    {/* Meeting Button */}
                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={toggleMeeting}
                        className={`flex items-center gap-2 px-5 py-2.5 font-semibold rounded-full text-sm transition-all ${isMeeting
                            ? "bg-red-500 text-white shadow-lg shadow-red-500/20"
                            : "bg-violet-600/20 text-violet-300 hover:bg-violet-600/30 border border-violet-600/30"
                            }`}
                    >
                        <Users className="w-4 h-4" />
                        {isMeeting ? t("hud.endMeeting") : t("hud.startMeeting")}
                    </motion.button>

                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={onMenuPickAgent}
                        data-testid="hud-open-agent-workspace-button"
                        className="flex items-center gap-2 px-5 py-2.5 font-semibold rounded-full text-sm transition-all bg-violet-600/20 text-violet-200 hover:bg-violet-600/30 border border-violet-600/30"
                    >
                        <Workflow className="w-4 h-4" />
                        {t("hud.openAgentWorkspace")}
                    </motion.button>

                    <div className="hidden w-[1px] h-7 bg-[#2A2A4A] mx-1" />

                    {/* Plan Button */}
                    <div className="relative">
                        <motion.button
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowPlannerMenu(!showPlannerMenu);
                                setShowTeamMenu(false);
                            }}
                            data-testid="planner-toggle"
                            className={`flex items-center gap-2 px-5 py-2.5 font-semibold rounded-full text-sm transition-all ${
                                activePlan
                                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                    : "bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/30"
                            }`}
                        >
                            {activePlan ? <Workflow className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                            {activePlan ? t("phase3.hud.planActive") : t("phase3.hud.plan")}
                        </motion.button>

                        <AnimatePresence>
                            {showPlannerMenu && (
                                <motion.div
                                    className="absolute bottom-full mb-2 left-0 bg-[#1A1A2E]/95 backdrop-blur-xl rounded-xl p-2 shadow-2xl border border-[#2A2A4A] w-64"
                                    data-testid="planner-panel"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 10 }}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="space-y-1">
                                        <div className="px-3 py-2 text-xs text-gray-400 font-semibold">{t("phase3.hud.planPrompt")}</div>
                                        <textarea
                                            value={planGoal}
                                            onChange={(event) => setPlanGoal(event.target.value)}
                                            data-testid="planner-goal-input"
                                            className="min-h-[88px] w-full rounded-lg border border-[#374151] bg-[#0b1220] px-3 py-2 text-sm text-white"
                                            placeholder={t("phase3.hud.planPromptPlaceholder")}
                                        />
                                        <div className="grid grid-cols-2 gap-2 px-1 pt-1">
                                            <button
                                                onClick={() => void createPlan()}
                                                className="rounded-lg bg-cyan-600 px-3 py-2 text-sm font-medium text-white"
                                            >
                                                {t("phase3.hud.generatePlan")}
                                            </button>
                                            <button
                                                onClick={() => activePlan && void runPlan(activePlan.plan_id)}
                                                className="rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-sm font-medium text-emerald-200 disabled:opacity-50"
                                                disabled={!activePlan}
                                            >
                                                {t("phase3.hud.runActivePlan")}
                                            </button>
                                        </div>
                                        <div className="flex items-center justify-between px-3 py-2 text-[11px] text-gray-400">
                                            <span>
                                                {activePlan
                                                    ? t("phase3.hud.planProgress", { current: completedPlanSteps, total: activePlan.steps.length })
                                                    : t("phase3.hud.noPlan")}
                                            </span>
                                            <span>{t("phase3.hud.approvals", { count: approvalCount })}</span>
                                        </div>
                                        <div className="px-3 py-2 text-xs text-gray-400 font-semibold">{t("phase3.hud.recentPlans")}</div>
                                        {executionPlans.slice(0, 4).map((plan) => (
                                            <motion.div
                                                key={plan.plan_id}
                                                whileHover={{ x: 4 }}
                                                className="rounded-lg border border-[#2A2A4A] bg-[#101829] px-3 py-2 text-white"
                                            >
                                                <div className="flex items-start justify-between gap-2">
                                                    <div className="min-w-0">
                                                        <div className="truncate text-sm font-medium">{plan.goal}</div>
                                                        <div className="mt-1 text-xs text-gray-400">{plan.status}</div>
                                                    </div>
                                                    <button
                                                        onClick={() => void runPlan(plan.plan_id)}
                                                        className="rounded-md border border-cyan-500/30 px-2 py-1 text-[11px] text-cyan-200"
                                                    >
                                                        {t("phase3.hud.run")}
                                                    </button>
                                                </div>
                                            </motion.div>
                                        ))}
                                        <div className="flex justify-end px-1 pt-2">
                                            <button
                                                onClick={() => {
                                                    if (!projectId) return;
                                                    void refreshRuntimeContext(projectId);
                                                    void refreshPlans(projectId);
                                                }}
                                                className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-xs text-cyan-200 hover:bg-white/5"
                                            >
                                                <RefreshCw className="w-3.5 h-3.5" />
                                                {t("dashboard.refresh")}
                                            </button>
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <div className="hidden w-[1px] h-7 bg-[#2A2A4A] mx-1" />
                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setShowCompanyBuilderModal(true)}
                        className="hidden items-center gap-2 px-4 py-2 rounded-full text-sm bg-violet-500/20 text-violet-200 border border-violet-500/30"
                    >
                        회사 빌드
                    </motion.button>
                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={() => setShowFactoryModal(true)}
                        className="hidden items-center gap-2 px-4 py-2 rounded-full text-sm bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                    >
                        {t("hud.addAgent")}
                    </motion.button>
                    <motion.button
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                        onClick={async () => {
                            if (isTauri()) {
                                const res = unlockSlotLocal();
                                addNotification({ type: "success", message: t("hud.slotUnlocked", { count: res.agent_slots }) });
                                return;
                            }
                            if (!projectId) return;
                            try {
                                const res = await unlockAgentSlot(projectId);
                                addNotification({ type: "success", message: t("hud.slotUnlocked", { count: res.agent_slots }) });
                            } catch (err) {
                                addNotification({ type: "error", message: err instanceof Error ? err.message : t("hud.unlockFailed") });
                            }
                        }}
                        className="hidden items-center gap-2 px-4 py-2 rounded-full text-sm bg-amber-500/20 text-amber-300 border border-amber-500/30"
                    >
                        {t("hud.buySlot")}
                    </motion.button>

                    {/* Team Parallel Button */}
                    <div className="relative">
                        <motion.button
                            whileHover={{ scale: teamExecutionRunning ? 1 : 1.05 }}
                            whileTap={{ scale: teamExecutionRunning ? 1 : 0.95 }}
                            onClick={(e) => {
                                e.stopPropagation();
                                if (teamExecutionRunning) return;
                                setShowTeamMenu(!showTeamMenu);
                            }}
                            className={`flex items-center gap-2 px-5 py-2.5 font-semibold rounded-full text-sm transition-all ${
                                teamExecutionRunning
                                    ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30"
                                    : "bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20 border border-cyan-500/30"
                            }`}
                            disabled={teamExecutionRunning}
                        >
                            <Users className={`w-4 h-4 ${teamExecutionRunning ? "animate-pulse" : ""}`} />
                            {teamExecutionRunning ? t("hud.parallelRunning") : t("hud.teamParallel")}
                        </motion.button>

                        <AnimatePresence>
                            {showTeamMenu && !teamExecutionRunning && (
                                <motion.div
                                    className="absolute bottom-full mb-2 left-0 bg-[#1A1A2E]/95 backdrop-blur-xl rounded-xl p-2 shadow-2xl border border-[#2A2A4A] w-72"
                                    initial={{ opacity: 0, y: 10 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: 10 }}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    <div className="space-y-1">
                                        <div className="px-3 py-2 text-xs text-gray-400 font-semibold">{t("hud.teamScenarios")}</div>
                                        {teamEntries.map((entry) => (
                                            <motion.button
                                                key={entry.team}
                                                whileHover={{ x: 4 }}
                                                onClick={() => {
                                                    void runTeamTask(entry.team, entry.instruction);
                                                    setShowTeamMenu(false);
                                                }}
                                                className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#16213E] text-white text-sm"
                                            >
                                                <div className="font-medium">{entry.label}</div>
                                                <div className="text-xs text-gray-400">{entry.hint}</div>
                                            </motion.button>
                                        ))}
                                        <div className="h-px bg-[#2A2A4A] my-1" />
                                        <motion.button
                                            whileHover={{ x: 4 }}
                                            onClick={() => {
                                                void runTeamSwarm();
                                                setShowTeamMenu(false);
                                            }}
                                            className="w-full text-left px-3 py-2 rounded-lg hover:bg-[#16213E] text-cyan-300 text-sm"
                                        >
                                            <div className="font-semibold">{t("hud.run3teams")}</div>
                                            <div className="text-xs text-gray-400">{t("hud.run3teamsDesc")}</div>
                                        </motion.button>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>

                    <div className="hidden w-[1px] h-7 bg-[#2A2A4A] mx-1" />
                </motion.div>
            </div>}
            <AgentFactoryModal open={showFactoryModal} onClose={() => setShowFactoryModal(false)} />
            <CompanyBuilderModal
                open={showCompanyBuilderModal}
                onClose={() => setShowCompanyBuilderModal(false)}
            />
            
            <AgentMessengerWidget />

            {/* Settings Panel */}
            <AnimatePresence>
                {showSettings && <OfficeCustomizationPanel onClose={toggleSettings} />}
            </AnimatePresence>
            <LlmSettingsModal open={showLlmSettingsModal} onClose={() => setShowLlmSettingsModal(false)} />
        </>
    );
}
