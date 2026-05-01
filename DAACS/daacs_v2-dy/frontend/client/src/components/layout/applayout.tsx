import { useState, useEffect } from "react";
import { Sidebar } from "./Sidebar";
import { listProjects, deleteProject, type Project } from "@/lib/daacsApi";
import { useLocation } from "wouter";
import { Loader2 } from "lucide-react";

export function AppLayout({ children }: { children: React.ReactNode }) {
    const [projects, setProjects] = useState<Project[]>([]);
    const [collapsed, setCollapsed] = useState(false);
    const [location, setLocation] = useLocation();
    const [isLoading, setIsLoading] = useState(true);

    // Extract current project ID from URL
    const currentProjectId = location.startsWith("/workspace/")
        ? location.split("/")[2]
        : undefined;

    useEffect(() => {
        const fetchProjects = async () => {
            try {
                const data = await listProjects();
                setProjects(data);
            } catch (error) {
                console.error("Failed to fetch projects:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchProjects();
    }, []);

    // Refresh projects when returning from workspace
    useEffect(() => {
        if (location === "/" || location === "/home") {
            listProjects().then(setProjects).catch(console.error);
        }
    }, [location]);

    const handleNewProject = () => {
        setLocation("/");
    };

    const handleDeleteProject = async (projectId: string) => {
        try {
            await deleteProject(projectId);
            setProjects((prev) => prev.filter((p) => p.id !== projectId));
            // If we deleted the current project, go home
            if (currentProjectId === projectId) {
                setLocation("/");
            }
        } catch (error) {
            console.error("Failed to delete project:", error);
        }
    };

    return (
        <div className="flex h-screen bg-background text-foreground overflow-hidden selection:bg-primary/20 selection:text-primary">
            {/* Background Gradient Mesh */}
            <div className="fixed inset-0 z-0 pointer-events-none">
                <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-primary/5 blur-[120px]" />
                <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-violet-500/5 blur-[120px]" />
            </div>

            <Sidebar
                projects={projects}
                currentProjectId={currentProjectId}
                onNewProject={handleNewProject}
                onDeleteProject={handleDeleteProject}
                collapsed={collapsed}
                onToggleCollapse={() => setCollapsed(!collapsed)}
            />

            <main className="flex-1 flex flex-col relative z-10 overflow-hidden">
                {isLoading ? (
                    <div className="flex-1 flex items-center justify-center">
                        <Loader2 className="w-8 h-8 animate-spin text-primary" />
                    </div>
                ) : (
                    <div className="flex-1 flex flex-col h-full overflow-hidden">
                        {children}
                    </div>
                )}
            </main>
        </div>
    );
}
