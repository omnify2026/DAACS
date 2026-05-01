import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Sparkles, ArrowRight, FolderOpen, Loader2, Zap, Code2, Bot, Terminal, GitBranch } from "lucide-react";
import { createProject, getProject, runProject, deleteProject, listProjects, listModels, getProjectMessages, sendProjectInput, type Project, type ProjectConfig, type Message } from "@/lib/daacsApi";
import { logError, logInfo } from "@/lib/logger";
import { SettingsDialog } from "@/components/home/SettingsDialog";
import { FeatureItem } from "@/components/home/FeatureItem";
import { ProjectChips } from "@/components/home/ProjectChips";
import { PromptingDialog } from "@/components/home/PromptingDialog";
import { defaultProjectConfig } from "@/lib/defaultProjectConfig";
import { RUN_TRIGGER_KEYWORDS, DRAFT_PROJECT_KEY } from "@/lib/homeConstants";
import { storage } from "@/lib/storage";

export default function Home() {
  const [requirement, setRequirement] = useState("");
  const [, setLocation] = useLocation();
  const { logout } = useAuth();
  const { toast } = useToast();
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [availableModels, setAvailableModels] = useState<Record<string, any>>({});
  const [promptingProject, setPromptingProject] = useState<Project | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [config, setConfig] = useState<ProjectConfig>(defaultProjectConfig);
  const [sourceType, setSourceType] = useState<"new" | "folder" | "git">("new");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceGit, setSourceGit] = useState("");

  const { data: polledMessages } = useQuery({
    queryKey: ["projectMessages", promptingProject?.id],
    queryFn: () => getProjectMessages(promptingProject!.id),
    enabled: !!promptingProject?.id,
    refetchInterval: 2000,
  });

  const { data: polledProject } = useQuery({
    queryKey: ["projectDetails", promptingProject?.id],
    queryFn: () => getProject(promptingProject!.id),
    enabled: !!promptingProject?.id,
    refetchInterval: 2000,
  });

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [projectsData, modelsData] = await Promise.all([
          listProjects(),
          listModels()
        ]);
        setProjects(projectsData);
        setAvailableModels(modelsData);
      } catch {
        logInfo("DAACS API not available yet");
      } finally {
        setProjectsLoading(false);
      }
    };
    fetchData();
  }, []);

  useEffect(() => {
    const checkDraftProject = async () => {
      if (projectsLoading) return;
      const draftId = storage.get(DRAFT_PROJECT_KEY);
      if (draftId) {
        try {
          const project = projects.find(p => p.id === draftId);
          if (project && project.status === "created") {
            setPromptingProject(project);
            const msgs = await getProjectMessages(draftId);
            setMessages(msgs);
          } else {
            storage.remove(DRAFT_PROJECT_KEY);
          }
        } catch (e) {
          logError("Failed to resume draft:", e);
        }
      }
    };
    checkDraftProject();
  }, [projectsLoading, projects]);

  useEffect(() => {
    if (!polledMessages) return;
    if (polledMessages.length !== messages.length) {
      setMessages(polledMessages);
      setIsTyping(false);
    }
  }, [polledMessages, messages.length]);

  useEffect(() => {
    if (polledProject) {
      setPromptingProject(polledProject);
    }
  }, [polledProject]);

  const handleStart = async () => {
    if (requirement.trim() && !isLoading) {
      setIsLoading(true);
      try {
        // Load latest config from localStorage (saved by SettingsPopover)
        let finalConfig = { ...config };
        try {
          const savedConfig = localStorage.getItem("daacs_config");
          if (savedConfig) {
            const parsed = JSON.parse(savedConfig);
            // Map camelCase (SettingsPopover) to snake_case (ProjectConfig)
            finalConfig = {
              ...finalConfig,
              mode: parsed.executionMode === "quick" ? "test" : "prod",
              parallel_execution: parsed.parallelExecution,
              force_backend: parsed.forceBackend,
              orchestrator_model: parsed.orchestratorModel,
              backend_model: parsed.backendModel,
              frontend_model: parsed.frontendModel,
              max_iterations: parsed.maxIterations,
              max_failures: parsed.maxRetries, // mapped to max_failures on API
              max_no_progress: parsed.noProgressRetries,
              code_review_min_score: parsed.minScore,
              allow_low_quality_delivery: parsed.allowBestEffort,
              plateau_max_retries: parsed.plateauRetries,
              enable_quality_gates: parsed.enableQualityGates,  // 🆕
              enable_release_gate: parsed.enableReleaseGate,
              verification_lane: parsed.verificationLane,
            };
            logInfo("Loaded config from localStorage:", finalConfig);
          }
        } catch (e) {
          console.error("Failed to load local config", e);
        }

        const project = await createProject(
          requirement.trim(),
          finalConfig,
          sourceType === "folder" ? sourcePath : undefined,
          sourceType === "git" ? sourceGit : undefined
        );
        await runProject(project.id);
        storage.set(DRAFT_PROJECT_KEY, project.id);
        setPromptingProject(project);
        const initialMessage: Message = {
          id: -1,
          projectId: project.id,
          role: "user",
          content: requirement.trim(),
          createdAt: new Date().toISOString(),
        };
        setMessages([initialMessage]);
        setIsTyping(true);
        setSourcePath("");
        setSourceGit("");
        setSourceType("new");

        // Navigate to workspace after successful project creation
        setLocation(`/workspace/${project.id}`);
      } catch (error: any) {
        logError("Failed to create project:", error);
        toast({
          title: "프로젝트 생성 실패",
          description: error.message || "PRIMUS API 서버에 연결할 수 없습니다.",
          variant: "destructive"
        });
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey && requirement.trim()) {
      handleStart();
    }
  };

  const handleDelete = async (projectId: string) => {
    if (!confirm("정말 이 프로젝트를 삭제하시겠습니까?")) return;
    try {
      await deleteProject(projectId);
      setProjects(prev => prev.filter(p => p.id !== projectId));
      if (promptingProject?.id === projectId) {
        setPromptingProject(null);
      }
      toast({ title: "삭제 완료", description: "프로젝트가 삭제되었습니다." });
    } catch (error) {
      logError("Failed to delete:", error);
      toast({ title: "삭제 실패", description: "프로젝트 삭제에 실패했습니다.", variant: "destructive" });
    }
  };

  const handleResumeProject = async (project: Project) => {
    if (project.status === 'created') {
      setPromptingProject(project);
      const msgs = await getProjectMessages(project.id);
      setMessages(msgs);
      setIsTyping(false);
    } else {
      setLocation(`/workspace/${project.id}`);
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans selection:bg-black selection:text-white dark:selection:bg-white dark:selection:text-black">
      {/* Navbar: Extremely Minimal - Only Sign out remains */}
      <nav className="flex items-center justify-end px-8 py-6 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-4 text-sm font-medium text-muted-foreground">
          <Button
            variant="default"
            className="rounded-full bg-foreground text-background hover:bg-foreground/90 px-5 h-9 font-medium"
            onClick={() => logout()}
          >
            Sign out
          </Button>
        </div>
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center px-4 pb-32">
        <div className="w-full max-w-2xl mx-auto flex flex-col items-center space-y-12">

          {/* Mascot / Identity */}
          <div className="relative group cursor-default animate-in fade-in zoom-in duration-700">
            <div className="absolute inset-0 bg-gradient-to-tr from-purple-200 to-blue-200 dark:from-purple-900/40 dark:to-blue-900/40 rounded-full blur-3xl opacity-60 group-hover:opacity-80 transition-opacity duration-1000" />
            <div className="relative bg-background/80 backdrop-blur-sm rounded-3xl p-6 shadow-2xl ring-1 ring-border/5 hover:scale-105 transition-transform duration-300">
              <Bot className="w-16 h-16 text-foreground stroke-[1.5]" />
            </div>
          </div>

          <div className="text-center space-y-4 animate-in slide-in-from-bottom-5 duration-700 delay-100">
            <h1 className="text-5xl md:text-6xl font-bold tracking-tighter text-foreground">
              Build meaningful things.
            </h1>
            <p className="text-xl text-muted-foreground font-light tracking-wide">
              Just describe it. We&apos;ll handle the rest.
            </p>
          </div>

          {/* Input Area - Floating Pill Style (Trendy) */}
          <div className="w-full relative z-10 animate-in slide-in-from-bottom-5 duration-700 delay-200">
            <div className="relative group transition-all duration-300 focus-within:scale-[1.01]">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-800 dark:via-gray-700 dark:to-gray-800 rounded-full opacity-50 group-hover:opacity-70 blur transition duration-500" />
              <div className="relative flex items-center bg-background rounded-full shadow-xl shadow-black/5 ring-1 ring-border/20 p-2 pl-6">
                <Textarea
                  value={requirement}
                  onChange={(e) => setRequirement(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="Describe your app idea..."
                  className="min-h-[56px] py-4 w-full resize-none border-0 bg-transparent text-lg focus-visible:ring-0 placeholder:text-muted-foreground/50 leading-tight"
                  rows={1}
                  style={{ minHeight: '56px', height: requirement ? 'auto' : '56px', maxHeight: '200px' }}
                  data-testid="home-input-requirement"
                />

                <div className="flex items-center gap-2 pr-2">
                  {/* Source Type Toggle (Mini) */}
                  <div className="flex items-center gap-1 bg-muted/50 rounded-full p-1 mr-2 px-2 hover:bg-muted transition-colors">
                    {(() => {
                      const sourceOrder: Array<"new" | "folder" | "git"> = ["new", "folder", "git"];
                      const meta = {
                        folder: { label: "local", icon: FolderOpen },
                        git: { label: "git", icon: GitBranch },
                        new: { label: "new", icon: Sparkles },
                      };
                      const currentMeta = meta[sourceType];
                      const SourceIcon = currentMeta.icon;
                      const nextType = sourceOrder[(sourceOrder.indexOf(sourceType) + 1) % sourceOrder.length];
                      return (
                        <button
                          onClick={() => setSourceType(nextType)}
                          className="text-xs font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1.5 h-6"
                          title="Change Source"
                          data-testid="home-toggle-source-btn"
                        >
                          <SourceIcon className="w-3.5 h-3.5" />
                          <span className="uppercase tracking-wider text-[10px]">{currentMeta.label}</span>
                        </button>
                      );
                    })()}
                  </div>

                  <Button
                    onClick={handleStart}
                    disabled={!requirement.trim() || isLoading}
                    size="icon"
                    className="h-10 w-10 rounded-full bg-foreground text-background hover:bg-foreground/90 shrink-0 mb-[1px] shadow-sm hover:shadow-md transition-all hover:scale-105" // Slight alignment adjustment
                    data-testid="home-button-generate"
                  >
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
                  </Button>
                </div>
              </div>
            </div>

            {/* Inputs for folder/git if active */}
            {(sourceType === 'folder' || sourceType === 'git') && (
              <div className="mt-4 flex justify-center animate-in fade-in slide-in-from-top-2">
                <Input
                  value={sourceType === 'folder' ? sourcePath : sourceGit}
                  onChange={(e) => sourceType === 'folder' ? setSourcePath(e.target.value) : setSourceGit(e.target.value)}
                  placeholder={sourceType === 'folder' ? "Folder absolute path..." : "Git repository URL..."}
                  className="rounded-full max-w-md bg-muted/30 border-border/40 text-center h-10 backdrop-blur-sm focus-visible:ring-1 focus-visible:ring-foreground/20"
                  data-testid="home-input-source-path"
                />
              </div>
            )}
          </div>

          {/* Removed ProjectChips as requested */}

        </div>
      </main>

      {/* Feature Grid - Subtle Footer Area */}
      <footer className="py-12 border-t border-border/20 bg-muted/20">
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-1 md:grid-cols-3 gap-8">
          <FeatureItem icon={<Terminal className="w-5 h-5" />} title="CLI Power" desc="Full control from your terminal." />
          <FeatureItem icon={<Zap className="w-5 h-5" />} title="Fast Build" desc="Optimized for speed and quality." />
          <FeatureItem icon={<Code2 className="w-5 h-5" />} title="Modern Stack" desc="React, Python, and AI Native." />
        </div>
        <div className="text-center mt-12 text-sm text-muted-foreground font-light">
          © 2024 PRIMUS. Built for builders.
        </div>
      </footer>

      {/* Dialog Implementation Preserved */}
      <PromptingDialog
        open={!!promptingProject}
        project={promptingProject}
        messages={messages}
        isTyping={isTyping}
        chatInput={chatInput}
        setChatInput={setChatInput}
        onSendMessage={async () => {
          if (!promptingProject) return;
          const isEmptySubmit = chatInput.trim() === "";
          const text = isEmptySubmit ? "" : chatInput;
          setChatInput("");
          if (!isEmptySubmit) {
            const userMsg: Message = {
              id: Date.now(),
              projectId: promptingProject.id,
              role: "user",
              content: text,
              createdAt: new Date().toISOString()
            };
            setMessages(prev => [...prev, userMsg]);
          }
          try {
            await sendProjectInput(promptingProject.id, text);
            setIsTyping(true);
            if (!isEmptySubmit) {
              const lower = text.toLowerCase();
              if (RUN_TRIGGER_KEYWORDS.some(keyword => lower.includes(keyword))) {
                setIsTyping(true);
                setTimeout(() => {
                  setLocation(`/workspace/${promptingProject.id}`);
                }, 5000);
              }
            }
          } catch (e) {
            logError(e);
          }
        }}
        onEnterWorkspace={() => promptingProject && setLocation(`/workspace/${promptingProject.id}`)}
        onClose={() => setPromptingProject(null)}
      />
    </div>
  );
}
