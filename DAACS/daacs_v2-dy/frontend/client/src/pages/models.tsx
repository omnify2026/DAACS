import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Bot, ArrowLeft, Cpu, Zap, Brain } from "lucide-react";
import { listModels } from "@/lib/daacsApi";

interface ModelInfo {
    provider: string;
    description?: string;
}

export default function Models() {
    const [, setLocation] = useLocation();
    const [models, setModels] = useState<Record<string, ModelInfo>>({});
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchModels = async () => {
            try {
                const data = await listModels();
                setModels(data);
            } catch (error) {
                console.error("Failed to fetch models:", error);
            } finally {
                setLoading(false);
            }
        };
        fetchModels();
    }, []);

    const getProviderIcon = (provider: string) => {
        switch (provider.toLowerCase()) {
            case "google":
                return <Brain className="w-5 h-5 text-blue-500" />;
            case "openai":
                return <Zap className="w-5 h-5 text-green-500" />;
            case "anthropic":
                return <Bot className="w-5 h-5 text-orange-500" />;
            default:
                return <Cpu className="w-5 h-5 text-gray-500" />;
        }
    };

    return (
        <div className="min-h-screen bg-background flex flex-col">
            <nav className="flex items-center justify-between px-8 py-6 max-w-7xl mx-auto w-full">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={() => setLocation("/")}>
                        <ArrowLeft className="w-5 h-5" />
                    </Button>
                    <div className="flex items-center gap-2">
                        <Bot className="w-6 h-6" />
                        <span className="font-bold text-lg tracking-tight">DAACS</span>
                    </div>
                </div>
                <ThemeToggle />
            </nav>

            <main className="flex-1 px-8 py-12 max-w-4xl mx-auto w-full">
                <div className="space-y-8">
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight">Supported Models</h1>
                        <p className="text-muted-foreground mt-2">
                            DAACS에서 사용 가능한 AI 모델 목록입니다. Settings에서 각 역할별로 모델을 선택할 수 있습니다.
                        </p>
                    </div>

                    {loading ? (
                        <div className="grid gap-4 md:grid-cols-2">
                            {[1, 2, 3, 4].map((i) => (
                                <div key={i} className="p-6 rounded-xl border border-border/50 animate-pulse">
                                    <div className="h-6 w-1/2 bg-muted rounded mb-4" />
                                    <div className="h-4 w-3/4 bg-muted rounded" />
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div className="grid gap-4 md:grid-cols-2">
                            {Object.entries(models).map(([id, info]) => (
                                <div
                                    key={id}
                                    className="p-6 rounded-xl border border-border/50 hover:border-foreground/20 transition-colors bg-card"
                                >
                                    <div className="flex items-center gap-3 mb-3">
                                        {getProviderIcon(info.provider)}
                                        <h3 className="font-semibold">{id}</h3>
                                    </div>
                                    <p className="text-sm text-muted-foreground">
                                        Provider: <span className="font-medium text-foreground">{info.provider}</span>
                                    </p>
                                    {info.description && (
                                        <p className="text-sm text-muted-foreground mt-1">{info.description}</p>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="p-6 rounded-xl bg-muted/30 border border-border/50">
                        <h3 className="font-semibold mb-2">모델 사용 시 참고사항</h3>
                        <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                            <li>Orchestrator: 전체 워크플로우와 플랜 생성을 담당</li>
                            <li>Backend: 서버사이드 코드 생성 (Python, Node.js 등)</li>
                            <li>Frontend: 클라이언트사이드 코드 생성 (React, Vue 등)</li>
                        </ul>
                    </div>
                </div>
            </main>
        </div>
    );
}
