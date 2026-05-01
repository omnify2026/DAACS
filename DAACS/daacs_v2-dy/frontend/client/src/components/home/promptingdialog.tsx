import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ArrowRight, Sparkles } from "lucide-react";
import { InteractionConsole } from "@/components/workspace/InteractionConsole";
import type { Message, Project } from "@/lib/daacsApi";
import { StatusChip } from "@/components/home/StatusChip";

type PromptingDialogProps = {
    open: boolean;
    project: Project | null;
    messages: Message[];
    isTyping: boolean;
    chatInput: string;
    setChatInput: (value: string) => void;
    onSendMessage: () => Promise<void>;
    onEnterWorkspace: () => void;
    onClose: () => void;
};

export function PromptingDialog({
    open,
    project,
    messages,
    isTyping,
    chatInput,
    setChatInput,
    onSendMessage,
    onEnterWorkspace,
    onClose,
}: PromptingDialogProps) {
    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
            <DialogContent className="max-w-3xl h-[80vh] flex flex-col p-0 overflow-hidden bg-background border-border/40 sm:rounded-2xl">
                <div className="p-4 border-b border-border/20 flex items-center justify-between bg-muted/10">
                    <div className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-purple-500" />
                        <h3 className="font-semibold tracking-tight">Analyst</h3>
                        {project?.status !== "created" && (
                            <StatusChip status={project?.status || ""} />
                        )}
                    </div>
                    <Button
                        size="sm"
                        className="gap-2 rounded-full bg-foreground text-background hover:bg-foreground/90"
                        onClick={onEnterWorkspace}
                    >
                        Enter Workspace
                        <ArrowRight className="w-4 h-4" />
                    </Button>
                </div>
                <div className="flex-1 flex overflow-hidden">
                    <div className="flex-1 flex flex-col bg-background/50 p-6 space-y-4 overflow-y-auto">
                        <div className="p-5 rounded-2xl bg-muted/30 border border-border/20">
                            <h4 className="text-xs font-bold text-muted-foreground uppercase mb-2 tracking-wider">Project Goal</h4>
                            <p className="text-sm leading-relaxed text-foreground/90">{project?.goal}</p>
                        </div>
                    </div>
                    <div className="w-[450px] border-l border-border/20 flex flex-col h-full bg-background/80 backdrop-blur-xl">
                        <InteractionConsole
                            messages={messages}
                            inputValue={chatInput}
                            setInputValue={setChatInput}
                            onSendMessage={onSendMessage}
                            isDaacsTyping={isTyping}
                            isPending={false}
                        />
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
