import { useEffect, useState } from "react";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Bot, Server, Plus, Trash2, Settings, Brain, Code, Layout, Hammer, Sparkles, Box, Zap, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { listModels } from "@/lib/daacsApi";

interface SettingsPopoverProps {
    collapsed?: boolean;
}

interface FullConfig {
    // AI
    executionMode: "quick" | "full" | "auto";
    orchestratorModel: string;
    backendModel: string;
    frontendModel: string;
    // Build
    parallelExecution: boolean;
    forceBackend: boolean;
    maxIterations: number;
    maxRetries: number;
    noProgressRetries: number;
    // Quality
    minScore: number;
    plateauRetries: number;
    allowBestEffort: boolean;
    enableQualityGates: boolean;  // 🆕 ruff/mypy/bandit/pytest 활성화
    enableReleaseGate: boolean;  // 🆕 post-build release gate checks
    verificationLane: "fast" | "full";
}

interface McpServer {
    name: string;
    command: string;
}

const FALLBACK_MODELS = [
    // Gemini Models
    "gemini-3-pro-high",
    "gemini-3-pro-low",
    "gemini-3-flash",
    // Codex Models
    "gpt-5.2-codex",
    "gpt-5.1-codex-max",
    "gpt-5.2",
    "gpt-5.1-codex-mini",
];

// 🆕 Display labels for models
const MODEL_LABELS: Record<string, string> = {
    "gemini-3-pro-high": "Gemini 3 Pro (High)",
    "gemini-3-pro-low": "Gemini 3 Pro (Low)",
    "gemini-3-flash": "Gemini 3 Flash (New)",
    "gpt-5.2-codex": "GPT-5.2-Codex",
    "gpt-5.1-codex-max": "GPT-5.1-Codex-Max",
    "gpt-5.2": "GPT-5.2",
    "gpt-5.1-codex-mini": "GPT-5.1-Codex-Mini",
};

const NODES = [
    { id: "orchestrator", label: "Orchestrator", icon: Brain, desc: "Planning & coordination" },
    { id: "backend", label: "Backend", icon: Code, desc: "Server-side code" },
    { id: "frontend", label: "Frontend", icon: Layout, desc: "UI components" },
] as const;

export function SettingsPopover({ collapsed }: SettingsPopoverProps) {
    const [open, setOpen] = useState(false);
    const [activeTab, setActiveTab] = useState("ai");
    const [availableModels, setAvailableModels] = useState<string[]>(FALLBACK_MODELS);
    const defaultConfig: FullConfig = {
        executionMode: "full",
        orchestratorModel: "gpt-5.1-codex-mini",
        backendModel: "gpt-5.1-codex-mini",
        frontendModel: "gpt-5.1-codex-mini",
        // Build Defaults
        parallelExecution: true,
        forceBackend: false,
        maxIterations: 10,
        maxRetries: 10,
        noProgressRetries: 2,
        // Quality Defaults
        minScore: 9,
        plateauRetries: 3,
        allowBestEffort: false,
        enableQualityGates: false,
        enableReleaseGate: false,
        verificationLane: "full",
    };
    const [config, setConfig] = useState<FullConfig>(() => {
        const saved = localStorage.getItem("daacs_config");
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                return { ...defaultConfig, ...parsed };
            } catch { }
        }
        return defaultConfig;
    });
    useEffect(() => {
        let canceled = false;
        const fetchModels = async () => {
            try {
                const models = await listModels();
                const ids = Object.keys(models);
                if (!canceled && ids.length > 0) setAvailableModels(ids);
            } catch {
                // server not available; keep fallback list
            }
        };
        fetchModels();
        return () => {
            canceled = true;
        };
    }, []);
    const [mcpServers, setMcpServers] = useState<McpServer[]>(() => {
        const saved = localStorage.getItem("daacs_mcp_servers");
        return saved ? JSON.parse(saved) : [];
    });
    const [newServerName, setNewServerName] = useState("");
    const [newServerCommand, setNewServerCommand] = useState("");

    const handleSave = () => {
        localStorage.setItem("daacs_config", JSON.stringify(config));
        localStorage.setItem("daacs_mcp_servers", JSON.stringify(mcpServers));
        setOpen(false);
    };

    const handleAddMcpServer = () => {
        if (!newServerName.trim() || !newServerCommand.trim()) return;
        setMcpServers([...mcpServers, { name: newServerName, command: newServerCommand }]);
        setNewServerName("");
        setNewServerCommand("");
    };

    const updateConfig = (key: keyof FullConfig, value: any) => {
        setConfig((prev) => {
            const next = { ...prev, [key]: value } as FullConfig;
            if (key === "executionMode") {
                if (value === "quick") {
                    next.verificationLane = "fast";
                } else if (value === "full") {
                    next.verificationLane = "full";
                }
            }
            return next;
        });
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-muted-foreground hover:bg-accent/50 hover:text-foreground transition-all duration-200",
                        collapsed && "justify-center px-0"
                    )}
                >
                    <Settings className="h-5 w-5 flex-shrink-0" />
                    {!collapsed && <span className="text-sm font-medium">Settings</span>}
                </button>
            </PopoverTrigger>

            <PopoverContent
                side="right"
                align="end"
                sideOffset={8}
                className="w-80 p-0 bg-background/95 backdrop-blur-xl border-border/50 shadow-xl overflow-hidden"
            >
                <div className="px-4 py-3 border-b border-border/50 bg-muted/20">
                    <h3 className="font-semibold text-sm">Settings</h3>
                </div>

                <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
                    <div className="px-3 pt-3">
                        <TabsList className="w-full grid grid-cols-4 bg-muted/40 h-8 p-0.5 rounded-lg">
                            <TabsTrigger value="ai" className="text-[10px] h-7 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm"><Bot className="w-3.5 h-3.5" /></TabsTrigger>
                            <TabsTrigger value="build" className="text-[10px] h-7 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm"><Hammer className="w-3.5 h-3.5" /></TabsTrigger>
                            <TabsTrigger value="quality" className="text-[10px] h-7 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm"><Sparkles className="w-3.5 h-3.5" /></TabsTrigger>
                            <TabsTrigger value="mcp" className="text-[10px] h-7 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm"><Box className="w-3.5 h-3.5" /></TabsTrigger>
                        </TabsList>
                    </div>

                    <ScrollArea className="h-[380px]">
                        <div className="p-3">
                            {/* AI Agents Tab */}
                            <TabsContent value="ai" className="m-0 space-y-3">
                                <div className="p-3 rounded-xl bg-gradient-to-br from-muted/50 to-muted/10 border border-border/50 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            <Zap className="w-4 h-4 text-amber-500" />
                                            <span className="font-medium text-xs">Execution Mode</span>
                                        </div>
                                    </div>
                                    <Select
                                        value={config.executionMode}
                                        onValueChange={(v) => updateConfig("executionMode", v)}
                                    >
                                        <SelectTrigger className="h-8 text-xs bg-background/50 border-border/40 focus:ring-0 focus:ring-offset-0">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="quick">⚡ Quick (Fast iterations)</SelectItem>
                                            <SelectItem value="full">🛡️ Prod (Full verification)</SelectItem>
                                            <SelectItem value="auto">🤖 Auto (Adaptive)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pl-1">Configuration</Label>
                                    {NODES.map((node) => {
                                        const configKey = `${node.id}Model` as keyof FullConfig;
                                        return (
                                            <div key={node.id} className="p-3 rounded-xl bg-card border border-border/40 shadow-sm space-y-2">
                                                <div className="flex items-center gap-2">
                                                    <div className="p-1.5 rounded-md bg-primary/10">
                                                        <node.icon className="w-3.5 h-3.5 text-primary" />
                                                    </div>
                                                    <div>
                                                        <div className="font-medium text-xs">{node.label}</div>
                                                        <div className="text-[10px] text-muted-foreground">{node.desc}</div>
                                                    </div>
                                                </div>
                                                <Select
                                                    value={config[configKey] as string}
                                                    onValueChange={(v) => updateConfig(configKey, v)}
                                                >
                                                    <SelectTrigger className="h-8 text-xs bg-muted/20 border-border/30 focus:ring-0 focus:ring-offset-0">
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {availableModels.map((m) => (
                                                            <SelectItem key={m} value={m} className="text-xs">{MODEL_LABELS[m] || m}</SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        );
                                    })}
                                </div>
                            </TabsContent>

                            {/* Build Tab */}
                            <TabsContent value="build" className="m-0 space-y-4 pt-1">
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/50">
                                        <Label className="text-xs font-medium">Parallel Execution</Label>
                                        <Switch
                                            checked={config.parallelExecution}
                                            onCheckedChange={(c) => updateConfig("parallelExecution", c)}
                                            className="scale-75"
                                        />
                                    </div>
                                    <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/50">
                                        <Label className="text-xs font-medium">Force Backend</Label>
                                        <Switch
                                            checked={config.forceBackend}
                                            onCheckedChange={(c) => updateConfig("forceBackend", c)}
                                            className="scale-75"
                                        />
                                    </div>
                                </div>

                                <div className="space-y-5 px-1">
                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">Max Iterations</span>
                                            <span className="font-mono bg-muted px-1.5 rounded text-[10px]">{config.maxIterations}</span>
                                        </div>
                                        <Slider
                                            value={[config.maxIterations]}
                                            max={20}
                                            step={1}
                                            onValueChange={(v) => updateConfig("maxIterations", v[0])}
                                            className="h-4"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">Max Retries (연속 실패)</span>
                                            <span className="font-mono bg-muted px-1.5 rounded text-[10px]">{config.maxRetries}</span>
                                        </div>
                                        <Slider
                                            value={[config.maxRetries]}
                                            max={20}
                                            step={1}
                                            onValueChange={(v) => updateConfig("maxRetries", v[0])}
                                            className="h-4"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">No-Progress Retries (정체)</span>
                                            <span className="font-mono bg-muted px-1.5 rounded text-[10px]">{config.noProgressRetries}</span>
                                        </div>
                                        <Slider
                                            value={[config.noProgressRetries]}
                                            max={10}
                                            step={1}
                                            onValueChange={(v) => updateConfig("noProgressRetries", v[0])}
                                            className="h-4"
                                        />
                                    </div>
                                </div>
                            </TabsContent>

                            {/* Quality Tab */}
                            <TabsContent value="quality" className="m-0 space-y-4 pt-1">
                                <div className="space-y-5 px-1 pt-2">
                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">Code Review Min Score</span>
                                            <span className="font-mono bg-muted px-1.5 rounded text-[10px]">{config.minScore}</span>
                                        </div>
                                        <Slider
                                            value={[config.minScore]}
                                            max={10}
                                            step={1}
                                            onValueChange={(v) => updateConfig("minScore", v[0])}
                                            className="h-4"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">Plateau Retries</span>
                                            <span className="font-mono bg-muted px-1.5 rounded text-[10px]">{config.plateauRetries}</span>
                                        </div>
                                        <Slider
                                            value={[config.plateauRetries]}
                                            max={5}
                                            step={1}
                                            onValueChange={(v) => updateConfig("plateauRetries", v[0])}
                                            className="h-4"
                                        />
                                    </div>

                                    <div className="space-y-2">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="text-muted-foreground">Verification Lane</span>
                                        </div>
                                        <Select
                                            value={config.verificationLane}
                                            onValueChange={(v) => updateConfig("verificationLane", v as FullConfig["verificationLane"])}
                                        >
                                            <SelectTrigger className="h-7 text-xs">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="full">Full (release checks)</SelectItem>
                                                <SelectItem value="fast">Fast (skip heavy checks)</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border border-border/50">
                                    <Label className="text-xs font-medium">Allow Best-Effort Delivery</Label>
                                    <Switch
                                        checked={config.allowBestEffort}
                                        onCheckedChange={(c) => updateConfig("allowBestEffort", c)}
                                        className="scale-75"
                                    />
                                </div>

                                {/* 🆕 Release Gate Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                                    <div>
                                        <Label className="text-xs font-medium">Release Gate</Label>
                                        <p className="text-[10px] text-muted-foreground mt-0.5">post-build runtime/E2E checks</p>
                                    </div>
                                    <Switch
                                        checked={config.enableReleaseGate}
                                        onCheckedChange={(c) => updateConfig("enableReleaseGate", c)}
                                        className="scale-75"
                                    />
                                </div>

                                {/* 🆕 Quality Gates Toggle */}
                                <div className="flex items-center justify-between p-3 rounded-xl bg-gradient-to-r from-purple-500/10 to-pink-500/10 border border-purple-500/20">
                                    <div>
                                        <Label className="text-xs font-medium">Quality Gates</Label>
                                        <p className="text-[10px] text-muted-foreground mt-0.5">ruff, mypy, bandit, pytest 등</p>
                                    </div>
                                    <Switch
                                        checked={config.enableQualityGates}
                                        onCheckedChange={(c) => updateConfig("enableQualityGates", c)}
                                        className="scale-75"
                                    />
                                </div>
                            </TabsContent>

                            {/* MCP Tab */}
                            <TabsContent value="mcp" className="m-0 space-y-3 pt-1">
                                <div className="space-y-2">
                                    <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pl-1">Add New Server</Label>
                                    <Input
                                        placeholder="Server name (e.g., filesystem)"
                                        value={newServerName}
                                        onChange={(e) => setNewServerName(e.target.value)}
                                        className="h-8 text-xs bg-muted/20 border-border/40 focus-visible:ring-1"
                                    />
                                    <Input
                                        placeholder="Command (e.g., npx -y ...)"
                                        value={newServerCommand}
                                        onChange={(e) => setNewServerCommand(e.target.value)}
                                        className="h-8 text-xs bg-muted/20 border-border/40 focus-visible:ring-1"
                                    />
                                    <Button
                                        onClick={handleAddMcpServer}
                                        variant="outline"
                                        size="sm"
                                        className="w-full h-8 text-xs border-dashed text-muted-foreground hover:text-primary hover:border-primary/50"
                                        disabled={!newServerName.trim() || !newServerCommand.trim()}
                                    >
                                        <Plus className="w-3.5 h-3.5 mr-1.5" />
                                        Add MCP Server
                                    </Button>
                                </div>

                                {/* Servers List */}
                                <div className="space-y-2">
                                    <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider pl-1">Configured Servers</Label>
                                    {mcpServers.length === 0 ? (
                                        <div className="text-center py-6 text-xs text-muted-foreground bg-muted/20 rounded-xl border border-dashed border-border/40">
                                            No servers configured
                                        </div>
                                    ) : (
                                        mcpServers.map((server, i) => (
                                            <div key={i} className="flex items-center justify-between p-2.5 rounded-xl bg-card border border-border/40 shadow-sm group">
                                                <div className="min-w-0 flex-1">
                                                    <div className="font-medium text-xs truncate flex items-center gap-2">
                                                        <Server className="w-3 h-3 text-sky-500" />
                                                        {server.name}
                                                    </div>
                                                    <code className="text-[10px] text-muted-foreground truncate block mt-0.5 ml-5">{server.command}</code>
                                                </div>
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    onClick={() => setMcpServers(mcpServers.filter((_, idx) => idx !== i))}
                                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </Button>
                                            </div>
                                        ))
                                    )}
                                </div>

                                {/* Tip Box */}
                                <div className="mt-2 p-3 rounded-xl bg-blue-500/5 border border-blue-500/10 space-y-1.5">
                                    <div className="flex items-center gap-2 text-blue-500">
                                        <Lightbulb className="w-3.5 h-3.5" />
                                        <span className="text-[10px] font-bold">예시 MCP 서버</span>
                                    </div>
                                    <ul className="text-[10px] text-muted-foreground space-y-1 list-disc pl-3 marker:text-blue-500/50">
                                        <li>Filesystem: <code className="bg-muted/50 px-1 rounded">npx -y @modelcontextprotocol/server-filesystem /</code></li>
                                        <li>GitHub: <code className="bg-muted/50 px-1 rounded">npx -y @modelcontextprotocol/server-github</code></li>
                                    </ul>
                                </div>
                            </TabsContent>
                        </div>
                    </ScrollArea>

                    <div className="p-3 border-t border-border/50">
                        <Button onClick={handleSave} size="sm" className="w-full h-8 text-xs font-medium">
                            Save Settings
                        </Button>
                    </div>
                </Tabs>
            </PopoverContent>
        </Popover>
    );
}
