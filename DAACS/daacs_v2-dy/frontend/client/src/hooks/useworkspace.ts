import { useState, useEffect, useRef, useCallback } from "react";
import { useToast } from "@/hooks/use-toast";
import {
    getProject,
    getProjectFiles,
    getProjectPlan,
    connectToLogs,
    type Project,
    type LogEntry,
    type RequirementsPlan,
} from "@/lib/daacsApi";
import { logWarning, logError } from "@/lib/logger";

export interface UseWorkspaceOptions {
    projectId: string;
}

export interface TechContext {
    facts: string[];
    sources: string[];
    constraints: string[];
}

export interface StructuredRfp {
    specs: unknown[];
    blueprint: { mermaid_script: string };
}

export interface WorkflowNode {
    id: string;
    label: string;
    status: "pending" | "running" | "done" | "error";
    data?: unknown;
}

const LOG_CAP = 2000;
const ACTIVE_POLL_INTERVAL_MS = 1000;  // Reduced from 3000ms for faster UI updates
const IDLE_POLL_INTERVAL_MS = 3000;    // Reduced from 7000ms

const isTerminalStatus = (status?: Project["status"]) =>
    status === "completed" ||
    status === "completed_with_warnings" ||
    status === "failed" ||
    status === "stopped";

const getPollInterval = (status?: Project["status"]) =>
    status === "running" || status === "planning"
        ? ACTIVE_POLL_INTERVAL_MS
        : IDLE_POLL_INTERVAL_MS;

export function useWorkspace({ projectId }: UseWorkspaceOptions) {
    const { toast } = useToast();

    // Core project state
    const [project, setProject] = useState<Project | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const [files, setFiles] = useState<{ backend_files: string[]; frontend_files: string[] }>({
        backend_files: [],
        frontend_files: [],
    });

    // Plan state
    const [requirementsPlan, setRequirementsPlan] = useState<RequirementsPlan | null>(null);
    const [planStatus, setPlanStatus] = useState<string>("draft");

    // Context from logs
    const [techContext, setTechContext] = useState<TechContext | null>(null);
    const [structuredRfp, setStructuredRfp] = useState<StructuredRfp | null>(null);

    // Workflow nodes
    const [workflowNodes, setWorkflowNodes] = useState<WorkflowNode[]>([]);

    // WebSocket ref
    const wsRef = useRef<WebSocket | null>(null);

    // Update workflow node status
    const updateWorkflowNode = useCallback((nodeId: string, status: WorkflowNode["status"], data?: unknown) => {
        setWorkflowNodes((prev) => {
            const existing = prev.find((n) => n.id === nodeId);
            if (existing) {
                return prev.map((n) => (n.id === nodeId ? { ...n, status, data } : n));
            }
            return [...prev, { id: nodeId, label: nodeId.replace(/_/g, " "), status, data }];
        });
    }, []);

    // Load project and connect WebSocket
    useEffect(() => {
        if (!projectId) return;

        const loadProject = async () => {
            try {
                const data = await getProject(projectId);
                setProject(data);

                // Load files
                try {
                    const filesData = await getProjectFiles(projectId);
                    setFiles(filesData);
                } catch (e) {
                    logWarning("Failed to load files:", e);
                }

                // Load plan status
                try {
                    const planData = await getProjectPlan(projectId);
                    setRequirementsPlan(planData.requirements_plan);
                    setPlanStatus(planData.plan_status);
                } catch {
                    // Plan not yet available
                }

                // 🆕 Load rfp_data from project if available
                if (data.rfp_data) {
                    let parsed: any = data.rfp_data;
                    if (typeof parsed === "string") {
                        try {
                            parsed = JSON.parse(parsed);
                        } catch {
                            parsed = null;
                        }
                    }
                    if (parsed && typeof parsed === "object") {
                        const rfp = parsed as any;
                        setStructuredRfp({
                            specs: rfp.specs || [],
                            blueprint: rfp.blueprint || { mermaid_script: "" },
                        });
                    }
                }

                // Load workflow state if available
                if (data.workflow_state && typeof data.workflow_state === "object") {
                    const statusMap: Record<string, WorkflowNode["status"]> = {
                        pending: "pending",
                        running: "running",
                        completed: "done",
                        done: "done",
                        success: "done",
                        error: "error",
                        failed: "error",
                    };
                    const nodes = Object.entries(data.workflow_state).map(([id, nodeData]) => {
                        const statusRaw = (nodeData as any)?.status || "pending";
                        const status = statusMap[String(statusRaw)] || "pending";
                        return {
                            id,
                            label: id.replace(/_/g, " "),
                            status,
                            data: nodeData,
                        };
                    });
                    setWorkflowNodes(nodes);
                }

                setIsLoading(false);
            } catch (error) {
                toast({
                    title: "Error",
                    description: "Failed to load project",
                    variant: "destructive",
                });
                setIsLoading(false);
            }
        };

        loadProject();

        // WebSocket connection for logs
        let cleanup: (() => void) | undefined;
        let sseCleanup: (() => void) | undefined;

        try {
            const connection = connectToLogs(projectId, (log) => {
                setLogs((prev) => {
                    const next = [...prev, log];
                    return next.length > LOG_CAP ? next.slice(-LOG_CAP) : next;
                });

                // Parse TECH_CONTEXT events
                const logMessage = log.message || "";
                if (logMessage.includes("[TECH_CONTEXT]")) {
                    try {
                        const jsonMatch = log.message.match(/\[TECH_CONTEXT\]\s*(.+)/);
                        if (jsonMatch?.[1]) {
                            const data = JSON.parse(jsonMatch[1]);
                            setTechContext({
                                facts: data.facts || [],
                                sources: data.sources || [],
                                constraints: data.constraints || [],
                            });
                        }
                    } catch (e) {
                        logWarning("Failed to parse TECH_CONTEXT:", e);
                    }
                }

                // Parse RFP_FINALIZED events
                if (logMessage.includes("[RFP_FINALIZED]")) {
                    try {
                        const jsonMatch = log.message.match(/\[RFP_FINALIZED\]\s*(.+)/);
                        if (jsonMatch?.[1]) {
                            const eventData = JSON.parse(jsonMatch[1]);
                            if (eventData.structured_rfp) {
                                setStructuredRfp(eventData.structured_rfp);
                            }
                        }
                    } catch (e) {
                        logWarning("Failed to parse RFP:", e);
                    }
                }

                // WebSocket specific parsing for legacy support or if SSE fails
                if (logMessage.includes("[WORKFLOW_NODE]")) {
                    try {
                        const jsonMatch = log.message.match(/\[WORKFLOW_NODE\]\s*(.+)/);
                        if (jsonMatch?.[1]) {
                            const nodeData = JSON.parse(jsonMatch[1]);
                            updateWorkflowNode(nodeData.node_id, nodeData.status, nodeData);
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            });
            wsRef.current = connection.ws;

            // Set up error handler for the WebSocket
            connection.ws.onerror = (event) => {
                logError("WebSocket error:", event);
            };

            cleanup = () => {
                connection.disconnect();
            };

            // 🆕 SSE Connection for Real-time Workflow Updates
            let eventSource: EventSource | null = null;
            let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

            const connectSSE = () => {
                eventSource = new EventSource("/api/stream/events");

                eventSource.onmessage = (event) => {
                    if (!event.data) return;
                    try {
                        const parsed = JSON.parse(event.data);
                        // Skip heartbeat events
                        if (parsed.type === "ping") return;

                        // Filter by projectId to avoid cross-talk if multiple projects active
                        if (parsed.project_id && parsed.project_id !== projectId) return;

                        if (parsed.type === "WORKFLOW_NODE") {
                            const nodeData = parsed.data;
                            if (nodeData && nodeData.node_id) {
                                // Direct update, bypassing regex
                                updateWorkflowNode(nodeData.node_id, nodeData.status, nodeData);
                            }
                        }
                    } catch (e) {
                        // ignore parse errors
                    }
                };

                // Handle heartbeat events to keep connection recognized as alive
                eventSource.addEventListener("heartbeat", () => {
                    // Heartbeat received - connection is alive
                });

                eventSource.onerror = () => {
                    eventSource?.close();
                    // Reconnect after 3 seconds
                    reconnectTimeout = setTimeout(connectSSE, 3000);
                };
            };

            connectSSE();

            sseCleanup = () => {
                eventSource?.close();
                if (reconnectTimeout) {
                    clearTimeout(reconnectTimeout);
                }
            };

        } catch (error) {
            logError("Connection failed:", error);
        }

        // Always return a cleanup function to ensure consistent hook execution
        return () => {
            if (cleanup) cleanup();
            if (sseCleanup) sseCleanup();
        };
    }, [projectId, toast, updateWorkflowNode]); // added updateWorkflowNode dependency


    // Polling for project updates
    useEffect(() => {
        if (!projectId) return;
        if (isTerminalStatus(project?.status)) return;

        const intervalMs = getPollInterval(project?.status);
        const interval = setInterval(async () => {
            try {
                const data = await getProject(projectId);
                setProject(data);

                // Also refresh plan status for real-time updates
                try {
                    const planData = await getProjectPlan(projectId);
                    if (planData.plan_status !== planStatus) {
                        setPlanStatus(planData.plan_status);
                    }
                    if (planData.requirements_plan) {
                        setRequirementsPlan(planData.requirements_plan);
                    }
                } catch {
                    // Plan not yet available
                }

                if (data.status === "running" || data.status === "planning") {
                    const filesData = await getProjectFiles(projectId);
                    setFiles(filesData);
                }
            } catch (error) {
                logError("Failed to refresh project:", error);
            }
        }, intervalMs);

        return () => clearInterval(interval);
    }, [projectId, project?.status, planStatus, requirementsPlan]);

    // Refresh files manually
    const refreshFiles = useCallback(async () => {
        try {
            const filesData = await getProjectFiles(projectId);
            setFiles(filesData);
        } catch (e) {
            logWarning("Failed to refresh files:", e);
        }
    }, [projectId]);

    // Refresh project manually
    const refreshProject = useCallback(async () => {
        try {
            const data = await getProject(projectId);
            setProject(data);
        } catch (e) {
            logWarning("Failed to refresh project:", e);
        }
    }, [projectId]);

    return {
        // State
        project,
        isLoading,
        logs,
        files,
        requirementsPlan,
        planStatus,
        techContext,
        structuredRfp,

        // Workflow
        workflowNodes,

        // Actions
        refreshFiles,
        refreshProject,
        setPlanStatus,
        setRequirementsPlan,
    };
}
