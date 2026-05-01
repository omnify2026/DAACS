import React, { useState, useEffect, useMemo } from "react";
import { useRoute } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { useWorkspace } from "@/hooks/useWorkspace";
import {
  runProject,
  stopRun,
  getRunStatus,
  downloadProject,
  type RunStatus
} from "@/lib/daacsApi";

// Components
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { RightPanel } from "@/components/workspace/RightPanel";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Square, Download, LayoutGrid, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { motion, AnimatePresence } from "framer-motion";

export default function Workspace() {
  const [, params] = useRoute("/workspace/:id");
  const projectId = params?.id || "";
  const { toast } = useToast();

  // Core workspace state
  const {
    project,
    isLoading,
    logs,
    files,
    requirementsPlan,
    planStatus,
    refreshProject,
    setPlanStatus,
    setRequirementsPlan,
    techContext,
    structuredRfp,
    workflowNodes,
  } = useWorkspace({ projectId });

  // Local UI state
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState("plan");
  const [runStatus, setRunStatus] = useState<RunStatus | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);

  // Poll for run status when project is running
  useEffect(() => {
    if (!projectId || project?.status !== "completed") return;

    const checkRunStatus = async () => {
      try {
        const status = await getRunStatus(projectId);
        setRunStatus(status);
      } catch (error) {
        // 404 means no active run - this is normal
        if (error instanceof Error && error.message.includes("404")) {
          setRunStatus(null);
        } else {
          // Unexpected error - log but don't notify user as this is polling
          console.error("[RunStatus] Unexpected error:", error);
        }
      }
    };

    checkRunStatus();
    const interval = setInterval(checkRunStatus, 3000);
    return () => clearInterval(interval);
  }, [projectId, project?.status]);

  // Handlers
  const handleStartProject = async () => {
    setIsStarting(true);
    try {
      await runProject(projectId);
      toast({ title: "Started", description: "DAACS orchestrator is running" });
      await refreshProject();
    } catch (error) {
      toast({ title: "Error", description: "Failed to start project", variant: "destructive" });
    } finally {
      setIsStarting(false);
    }
  };

  const handleStopRun = async () => {
    try {
      await stopRun(projectId);
      setRunStatus(null);
      toast({ title: "Stopped", description: "Application stopped successfully" });
    } catch (error) {
      console.error("[StopRun] Error:", error);
      toast({
        title: "Stop Failed",
        description: error instanceof Error ? error.message : "Failed to stop application",
        variant: "destructive"
      });
    }
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      await downloadProject(projectId);
    } catch {
      toast({ title: "Error", description: "Download failed", variant: "destructive" });
    } finally {
      setIsDownloading(false);
    }
  };

  // Memoized status badge for performance - MUST be before early return!
  const statusBadge = useMemo(() => {
    if (!project) return null;
    const statusMap: Record<string, { label: string; class: string }> = {
      created: { label: "Created", class: "bg-muted text-muted-foreground" },
      planning: { label: "Planning", class: "bg-blue-500/20 text-blue-400" },
      running: { label: "Running", class: "bg-blue-500/20 text-blue-400" },
      completed: { label: "Completed", class: "bg-green-500/20 text-green-400" },
      failed: { label: "Failed", class: "bg-red-500/20 text-red-400" },
      stopped: { label: "Stopped", class: "bg-yellow-500/20 text-yellow-400" },
    };
    const s = statusMap[project.status] || statusMap.created;
    return <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${s.class}`}>{s.label}</span>;
  }, [project]);

  // Loading state - check AFTER all hooks are called
  if (isLoading || !project) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }



  const isRunning = runStatus?.backend?.running || runStatus?.frontend?.running || project.status === "planning";
  const previewUrl = runStatus?.frontend?.port ? `http://localhost:${runStatus.frontend.port}` : undefined;

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* 1. Header Area */}
      <header className="flex items-center justify-between px-6 py-3 border-b border-border shrink-0 bg-background/50 backdrop-blur-sm z-10">
        <div className="flex items-center gap-4">
          <h1 className="text-sm font-medium truncate max-w-[600px]" title={project.goal}>
            {project.goal}
          </h1>
          {statusBadge}
          {/* 기존 기능: 점수판 등이 있다면 여기에 작게 표시 가능 */}
          {requirementsPlan && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground border-l pl-4 ml-2">
              <span>Iteration: {project.iteration || 0}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Start/Stop buttons */}
          <Button
            size="sm"
            onClick={isRunning ? handleStopRun : handleStartProject}
            disabled={isStarting}
            variant={isRunning ? "outline" : "default"}
            className={cn("h-8 px-3 text-xs", isRunning && "text-destructive hover:text-destructive")}
          >
            {isStarting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
            ) : isRunning ? (
              <Square className="h-3.5 w-3.5 mr-1.5" />
            ) : (
              <Play className="h-3.5 w-3.5 mr-1.5" />
            )}
            {isRunning ? "Stop" : "Run"}
          </Button>

          <Button
            size="sm"
            variant="outline"
            onClick={handleDownload}
            disabled={isDownloading}
            className="h-8 px-3 text-xs"
          >
            {isDownloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          </Button>

          <Button
            size="sm"
            variant={rightPanelCollapsed ? "default" : "outline"}
            onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
            className="h-8 w-8 p-0"
          >
            <LayoutGrid className="h-3.5 w-3.5" />
          </Button>
        </div>
      </header>

      {/* 2. Main Content (Split View) */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Left: Chat Panel (35% width) */}
        <div className={cn("flex-1 transition-all duration-300", rightPanelCollapsed ? "mr-0" : "mr-[60%]")}>
          <ChatPanel
            projectId={projectId}
            projectStatus={project.status}
            planStatus={planStatus}
            onPlanReady={setRequirementsPlan}
            onPlanStatusChange={setPlanStatus}
            onSelectTab={setRightPanelTab}
            onOpenPanel={() => setRightPanelCollapsed(false)}
          />
        </div>

        {/* Right: Right Panel (Fixed width, collapsible) */}
        <div
          className={cn(
            "absolute top-0 right-0 bottom-0 border-l border-border bg-background transition-transform duration-300 ease-in-out shadow-xl z-20",
            rightPanelCollapsed ? "translate-x-full" : "translate-x-0"
          )}
          style={{ width: "60%" }}
        >
          <RightPanel
            projectId={projectId}
            requirementsPlan={requirementsPlan}
            planStatus={planStatus}
            files={files}
            logs={logs}
            techContext={techContext || undefined}
            structuredRfp={structuredRfp || undefined}
            workflowNodes={workflowNodes}
            runStatus={runStatus || undefined}
            onRun={handleStartProject}
            onStop={handleStopRun}
            isRunning={isRunning}
            previewUrl={previewUrl}
            activeTab={rightPanelTab}
            onTabChange={setRightPanelTab}
          />
        </div>
      </div>
    </div>
  );
}
