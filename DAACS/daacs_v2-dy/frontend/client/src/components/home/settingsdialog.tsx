import { useState, useEffect } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Bot, Server, Plus, Trash2, Settings, Wrench } from "lucide-react";
import type { ProjectConfig } from "@/lib/daacsApi";

interface McpServer {
    name: string;
    command: string;
}

type SettingsDialogProps = {
    config: ProjectConfig;
    availableModels: Record<string, unknown>;
    onChange: (config: ProjectConfig) => void;
    triggerLabel?: string;
    triggerClassName?: string;
};

export function SettingsDialog({
    config,
    availableModels,
    onChange,
    triggerLabel = "Settings",
    triggerClassName = "hover:text-foreground transition-colors",
}: SettingsDialogProps) {
    const [activeTab, setActiveTab] = useState("ai");
    const [mcpServers, setMcpServers] = useState<McpServer[]>(() => {
        const saved = localStorage.getItem("daacs_mcp_servers");
        return saved ? JSON.parse(saved) : [];
    });
    const [newServerName, setNewServerName] = useState("");
    const [newServerCommand, setNewServerCommand] = useState("");

    // Save MCP servers when they change
    useEffect(() => {
        localStorage.setItem("daacs_mcp_servers", JSON.stringify(mcpServers));
    }, [mcpServers]);

    const handleAddMcpServer = () => {
        if (!newServerName.trim() || !newServerCommand.trim()) return;
        setMcpServers([...mcpServers, { name: newServerName, command: newServerCommand }]);
        setNewServerName("");
        setNewServerCommand("");
    };

    const handleRemoveMcpServer = (index: number) => {
        setMcpServers(mcpServers.filter((_, i) => i !== index));
    };

    return (
        <Dialog>
            <DialogTrigger asChild>
                <button className={triggerClassName}>{triggerLabel}</button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[85vh]">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2">
                        <Settings className="w-5 h-5" />
                        Settings
                    </DialogTitle>
                </DialogHeader>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <TabsList className="grid w-full grid-cols-4 h-9">
                        <TabsTrigger value="ai" className="text-xs gap-1">
                            <Bot className="w-3.5 h-3.5" />
                            AI
                        </TabsTrigger>
                        <TabsTrigger value="build" className="text-xs gap-1">
                            <Wrench className="w-3.5 h-3.5" />
                            Build
                        </TabsTrigger>
                        <TabsTrigger value="quality" className="text-xs gap-1">
                            <Settings className="w-3.5 h-3.5" />
                            Quality
                        </TabsTrigger>
                        <TabsTrigger value="mcp" className="text-xs gap-1">
                            <Server className="w-3.5 h-3.5" />
                            MCP
                        </TabsTrigger>
                    </TabsList>

                    <ScrollArea className="h-[400px] pr-4">
                        {/* AI Models Tab */}
                        <TabsContent value="ai" className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <Label>Execution Mode</Label>
                                <Select
                                    value={config.mode || "prod"}
                                    onValueChange={(val) => {
                                        const nextMode = val as ProjectConfig["mode"];
                                        const nextLane = nextMode === "test" ? "fast" : "full";
                                        onChange({ ...config, mode: nextMode, verification_lane: nextLane });
                                    }}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="prod">Full (Prod)</SelectItem>
                                        <SelectItem value="test">Quick (Test)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Orchestrator</Label>
                                <Select value={config.orchestrator_model} onValueChange={(val) => onChange({ ...config, orchestrator_model: val })}>
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(availableModels).map(([id]) => (
                                            <SelectItem key={id} value={id}>{id}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Backend Code</Label>
                                <Select value={config.backend_model} onValueChange={(val) => onChange({ ...config, backend_model: val })}>
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(availableModels).map(([id]) => (
                                            <SelectItem key={id} value={id}>{id}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="space-y-2">
                                <Label>Frontend Code</Label>
                                <Select value={config.frontend_model} onValueChange={(val) => onChange({ ...config, frontend_model: val })}>
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        {Object.entries(availableModels).map(([id]) => (
                                            <SelectItem key={id} value={id}>{id}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </TabsContent>

                        {/* Build Settings Tab */}
                        <TabsContent value="build" className="space-y-4 mt-4">
                            <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                                <Label>Parallel Execution</Label>
                                <Switch
                                    checked={config.parallel_execution ?? true}
                                    onCheckedChange={(val) => onChange({ ...config, parallel_execution: val })}
                                />
                            </div>
                            <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                                <Label>Force Backend</Label>
                                <Switch
                                    checked={config.force_backend ?? false}
                                    onCheckedChange={(val) => onChange({ ...config, force_backend: val })}
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between">
                                    <Label>Max Iterations</Label>
                                    <span className="text-sm text-muted-foreground">{config.max_iterations}</span>
                                </div>
                                <Slider
                                    value={[config.max_iterations || 10]}
                                    onValueChange={(val) => onChange({ ...config, max_iterations: val[0] })}
                                    min={1}
                                    max={20}
                                    step={1}
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between">
                                    <Label>Max Retries (연속 실패)</Label>
                                    <span className="text-sm text-muted-foreground">{config.max_failures}</span>
                                </div>
                                <Slider
                                    value={[config.max_failures || 10]}
                                    onValueChange={(val) => onChange({ ...config, max_failures: val[0] })}
                                    min={1}
                                    max={20}
                                    step={1}
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between">
                                    <Label>No-Progress Retries (정체)</Label>
                                    <span className="text-sm text-muted-foreground">{config.max_no_progress}</span>
                                </div>
                                <Slider
                                    value={[config.max_no_progress || 2]}
                                    onValueChange={(val) => onChange({ ...config, max_no_progress: val[0] })}
                                    min={1}
                                    max={5}
                                    step={1}
                                />
                            </div>
                        </TabsContent>

                        {/* Quality Settings Tab */}
                        <TabsContent value="quality" className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <div className="flex justify-between">
                                    <Label>Code Review Min Score</Label>
                                    <span className="text-sm text-muted-foreground">{config.code_review_min_score}</span>
                                </div>
                                <Slider
                                    value={[config.code_review_min_score || 9]}
                                    onValueChange={(val) => onChange({ ...config, code_review_min_score: val[0] })}
                                    min={9}
                                    max={10}
                                    step={1}
                                />
                            </div>
                            <div className="space-y-2">
                                <div className="flex justify-between">
                                    <Label>Plateau Retries</Label>
                                    <span className="text-sm text-muted-foreground">{config.plateau_max_retries}</span>
                                </div>
                                <Slider
                                    value={[config.plateau_max_retries || 3]}
                                    onValueChange={(val) => onChange({ ...config, plateau_max_retries: val[0] })}
                                    min={1}
                                    max={6}
                                    step={1}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Verification Lane</Label>
                                <Select
                                    value={config.verification_lane || "full"}
                                    onValueChange={(val) => onChange({ ...config, verification_lane: val as ProjectConfig["verification_lane"] })}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="full">Full (release checks)</SelectItem>
                                        <SelectItem value="fast">Fast (skip heavy checks)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                                <Label>Allow Best-Effort Delivery</Label>
                                <Switch
                                    checked={config.allow_low_quality_delivery ?? false}
                                    onCheckedChange={(val) => onChange({ ...config, allow_low_quality_delivery: val })}
                                    disabled
                                />
                            </div>
                            <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                                <Label>Release Gate</Label>
                                <Switch
                                    checked={config.enable_release_gate ?? false}
                                    onCheckedChange={(val) => onChange({ ...config, enable_release_gate: val })}
                                />
                            </div>
                        </TabsContent>

                        {/* MCP Servers Tab */}
                        <TabsContent value="mcp" className="space-y-4 mt-4">
                            <div className="space-y-2">
                                <h4 className="text-sm font-medium text-muted-foreground">
                                    MCP (Model Context Protocol) Servers
                                </h4>
                                <p className="text-xs text-muted-foreground">
                                    외부 도구 및 데이터 소스에 연결할 MCP 서버를 추가하세요.
                                </p>
                            </div>

                            {/* Existing servers list */}
                            {mcpServers.length > 0 && (
                                <div className="space-y-2">
                                    {mcpServers.map((server, i) => (
                                        <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-muted/30 border border-border/50 group">
                                            <div className="min-w-0 flex-1">
                                                <div className="font-medium text-sm truncate">{server.name}</div>
                                                <code className="text-xs text-muted-foreground truncate block">{server.command}</code>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => handleRemoveMcpServer(i)}
                                                className="h-7 w-7 opacity-50 group-hover:opacity-100 hover:text-destructive"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Add new server form */}
                            <div className="space-y-3 pt-2 border-t border-border/50">
                                <Label className="text-xs">Add New Server</Label>
                                <Input
                                    placeholder="Server name (e.g., filesystem)"
                                    value={newServerName}
                                    onChange={(e) => setNewServerName(e.target.value)}
                                    className="h-9 text-sm"
                                />
                                <Input
                                    placeholder="Command (e.g., npx -y @modelcontextprotocol/server-filesystem /path)"
                                    value={newServerCommand}
                                    onChange={(e) => setNewServerCommand(e.target.value)}
                                    className="h-9 text-sm"
                                />
                                <Button
                                    onClick={handleAddMcpServer}
                                    variant="outline"
                                    size="sm"
                                    className="w-full"
                                    disabled={!newServerName.trim() || !newServerCommand.trim()}
                                >
                                    <Plus className="w-4 h-4 mr-1" />
                                    Add MCP Server
                                </Button>
                            </div>

                            {/* Info box */}
                            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-muted-foreground">
                                <p className="font-medium text-blue-600 dark:text-blue-400 mb-1">💡 예시 MCP 서버</p>
                                <ul className="space-y-1 ml-4 list-disc">
                                    <li>Filesystem: <code className="text-[10px]">npx -y @modelcontextprotocol/server-filesystem /</code></li>
                                    <li>GitHub: <code className="text-[10px]">npx -y @modelcontextprotocol/server-github</code></li>
                                    <li>Brave Search: <code className="text-[10px]">npx -y @anthropic/mcp-server-brave-search</code></li>
                                </ul>
                            </div>
                        </TabsContent>
                    </ScrollArea>
                </Tabs>
            </DialogContent>
        </Dialog>
    );
}
