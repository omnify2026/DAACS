import { Trash2 } from "lucide-react";
import type { Project } from "@/lib/daacsApi";
import { StatusChip } from "@/components/home/StatusChip";

type ProjectChipsProps = {
    projects: Project[];
    onResume: (project: Project) => void;
    onDelete: (projectId: string) => void;
};

export function ProjectChips({ projects, onResume, onDelete }: ProjectChipsProps) {
    if (projects.length === 0) {
        return null;
    }

    return (
        <div className="w-full max-w-3xl pt-8 animate-in fade-in slide-in-from-bottom-5 duration-700 delay-300 text-center">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest mb-6 opacity-50">Recent Projects</p>
            <div className="flex flex-wrap justify-center gap-3">
                {projects.slice(0, 5).map((project) => (
                    <button
                        key={project.id}
                        onClick={() => onResume(project)}
                        className="group flex items-center gap-3 pl-4 pr-2 py-2 bg-background/50 hover:bg-muted/40 border border-border/40 hover:border-foreground/20 rounded-full transition-all text-sm text-foreground shadow-sm hover:shadow-md backdrop-blur-sm"
                        data-testid={`home-project-chip-${project.id}`}
                    >
                        <StatusChip status={project.status} />
                        <span className="truncate max-w-[150px] font-medium">{project.goal}</span>
                        <div
                            className="w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ml-1 opacity-0 group-hover:opacity-100"
                            onClick={(e) => {
                                e.stopPropagation();
                                onDelete(project.id);
                            }}
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </div>
                    </button>
                ))}
            </div>
        </div>
    );
}
