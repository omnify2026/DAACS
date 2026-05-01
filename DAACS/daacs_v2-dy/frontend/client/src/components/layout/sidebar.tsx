import { useState } from "react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import {
    LayoutDashboard,
    Plus,
    X,
    FolderOpen,
    FileText,
    ChevronLeft,
    ChevronRight,
    Moon,
    Sun,
    Bot
} from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { Button } from "@/components/ui/button";
import { SettingsPopover } from "./SettingsPopover";

interface SidebarProps {
    projects: any[]; // Changed from string[] to handle Project objects
    currentProject?: string | null;
    currentProjectId?: string;  // 🆕 Support both prop names
    onSelectProject?: (name: string) => void;
    onCreateProject?: () => void;
    onNewProject?: () => void;  // 🆕 Support both prop names
    onDeleteProject?: (name: string) => void;
    collapsed?: boolean;
    onToggleCollapse?: () => void;
}

export function Sidebar({
    projects,
    currentProject,
    currentProjectId,
    onSelectProject,
    onCreateProject,
    onNewProject,
    onDeleteProject,
    collapsed: collapsedProp,
    onToggleCollapse,
}: SidebarProps) {
    const [location] = useLocation();
    const { theme, setTheme } = useTheme();
    const [collapsedState, setCollapsedState] = useState(false);

    // Support both prop styles
    const collapsed = collapsedProp ?? collapsedState;
    const handleCreateProject = onCreateProject ?? onNewProject;
    const activeProject = currentProject ?? currentProjectId ?? null;

    const toggleCollapse = () => {
        if (onToggleCollapse) {
            onToggleCollapse();
        } else {
            setCollapsedState(!collapsedState);
        }
    };

    return (
        <div
            className={cn(
                "flex flex-col h-screen bg-muted/20 border-r border-border/40 transition-all duration-300 ease-in-out relative z-20 backdrop-blur-xl",
                collapsed ? "w-16" : "w-64"
            )}
        >
            {/* Header */}
            <div className={cn(
                "h-14 flex items-center border-b border-border/40 transition-all px-4",
                collapsed ? "justify-center" : "justify-between"
            )}>
                {!collapsed && (
                    <span className="font-bold text-lg bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent tracking-widest">
                        PRIMUS
                    </span>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full hover:bg-muted"
                    onClick={toggleCollapse}
                >
                    {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
                </Button>
            </div>

            {/* Navigation */}
            <div className="flex-1 py-4 flex flex-col gap-1 px-2">
                <Link href="/">
                    <a className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all hover:bg-accent/50 hover:text-accent-foreground",
                        location === "/" && "bg-accent text-accent-foreground shadow-sm",
                        collapsed && "justify-center px-0"
                    )}>
                        <LayoutDashboard className="h-4 w-4" />
                        {!collapsed && <span>Home</span>}
                    </a>
                </Link>

                <div className="my-2 border-t border-border/40" />

                {/* Projects Section */}
                <div className="flex-1 overflow-y-auto px-1 space-y-1">
                    {!collapsed && (
                        <div className="flex items-center justify-between px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                            <span>Projects</span>
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-5 w-5 hover:bg-muted rounded-full"
                                onClick={handleCreateProject}
                            >
                                <Plus className="h-3.5 w-3.5" />
                            </Button>
                        </div>
                    )}
                    {collapsed && (
                        <div className="flex justify-center mb-2">
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 hover:bg-muted rounded-full"
                                onClick={handleCreateProject}
                            >
                                <Plus className="h-4 w-4" />
                            </Button>
                        </div>
                    )}

                    {projects.map((project) => {
                        // Handle both string IDs and Project objects for robustness
                        const projectId = typeof project === 'string' ? project : project.id;
                        const projectLabel = typeof project === 'string' ? project : (project.goal || project.id);

                        return (
                            <Link key={projectId} href={`/workspace/${projectId}`}>
                                <div
                                    className={cn(
                                        "group flex items-center justify-between px-3 py-2 rounded-xl text-sm transition-all cursor-pointer hover:bg-accent/50",
                                        activeProject === projectId && "bg-accent/60 text-accent-foreground font-medium shadow-sm",
                                        collapsed && "justify-center px-0 py-2"
                                    )}
                                    onClick={() => onSelectProject?.(projectId)}
                                >
                                    <div className="flex items-center gap-3 overflow-hidden">
                                        <FolderOpen className={cn("h-4 w-4 flex-shrink-0", activeProject === projectId ? "text-primary" : "text-muted-foreground")} />
                                        {!collapsed && <span className="truncate">{projectLabel}</span>}
                                    </div>
                                    {!collapsed && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity -mr-1 hover:text-destructive"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                e.preventDefault();
                                                onDeleteProject?.(projectId);
                                            }}
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </Button>
                                    )}
                                </div>
                            </Link>
                        );
                    })}
                </div>

                <div className="mt-auto space-y-1">
                    <div className="my-2 border-t border-border/40" />
                    <Link href="/models">
                        <a className={cn(
                            "flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            location === "/models" && "bg-accent/50 text-foreground",
                            collapsed && "justify-center px-0"
                        )}>
                            <Bot className="h-4 w-4" />
                            {!collapsed && <span>AI Models</span>}
                        </a>
                    </Link>
                    <Link href="/docs">
                        <a className={cn(
                            "flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium transition-all text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                            location === "/docs" && "bg-accent/50 text-foreground",
                            collapsed && "justify-center px-0"
                        )}>
                            <FileText className="h-4 w-4" />
                            {!collapsed && <span>Docs</span>}
                        </a>
                    </Link>

                    {/* Integrated Settings Popover (Replaces old Dialog) */}
                    <div className="pt-1">
                        <SettingsPopover collapsed={collapsed} />
                    </div>
                </div>
            </div>

            {/* Footer */}
            <div className={cn(
                "h-14 flex items-center border-t border-border/40 px-4",
                collapsed ? "justify-center" : "justify-between"
            )}>
                {!collapsed && (
                    <div className="flex flex-col">
                        <span className="text-xs font-medium">David</span>
                        <span className="text-[10px] text-muted-foreground">Pro Plan</span>
                    </div>
                )}
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-full hover:bg-muted"
                    onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                >
                    {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
                </Button>
            </div>
        </div>
    );
}
