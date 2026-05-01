import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Bot, ArrowLeft, BookOpen, Zap, Settings, Code2, Play } from "lucide-react";

export default function Docs() {
    const [, setLocation] = useLocation();

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
                        <h1 className="text-3xl font-bold tracking-tight">Documentation</h1>
                        <p className="text-muted-foreground mt-2">
                            DAACS (Dynamic Autonomous Agent Coding System) 사용 가이드입니다.
                        </p>
                    </div>

                    {/* Quick Start */}
                    <section className="space-y-4">
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <Zap className="w-5 h-5 text-yellow-500" />
                            Quick Start
                        </h2>
                        <div className="p-6 rounded-xl border border-border/50 bg-card space-y-3">
                            <p className="text-sm">1. 홈 화면에서 프로젝트 설명을 입력합니다.</p>
                            <p className="text-sm">2. Settings에서 사용할 AI 모델을 선택합니다.</p>
                            <p className="text-sm">3. Generate 버튼을 클릭하여 프로젝트를 생성합니다.</p>
                            <p className="text-sm">4. DAACS가 요구사항을 분석하고 플랜을 제안합니다.</p>
                            <p className="text-sm">5. 플랜 확인 후 코드 생성이 진행됩니다.</p>
                        </div>
                    </section>

                    {/* Settings */}
                    <section className="space-y-4">
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <Settings className="w-5 h-5 text-gray-500" />
                            Settings 설명
                        </h2>
                        <div className="grid gap-4 md:grid-cols-2">
                            <div className="p-5 rounded-xl border border-border/50 bg-card">
                                <h3 className="font-medium mb-2">Orchestrator Model</h3>
                                <p className="text-sm text-muted-foreground">
                                    전체 워크플로우를 조율하고, 요구사항 분석 및 플랜 생성을 담당합니다.
                                </p>
                            </div>
                            <div className="p-5 rounded-xl border border-border/50 bg-card">
                                <h3 className="font-medium mb-2">Backend Model</h3>
                                <p className="text-sm text-muted-foreground">
                                    서버사이드 코드를 생성합니다 (FastAPI, Express, Django 등).
                                </p>
                            </div>
                            <div className="p-5 rounded-xl border border-border/50 bg-card">
                                <h3 className="font-medium mb-2">Frontend Model</h3>
                                <p className="text-sm text-muted-foreground">
                                    클라이언트사이드 코드를 생성합니다 (React, Vue, HTML/CSS 등).
                                </p>
                            </div>
                            <div className="p-5 rounded-xl border border-border/50 bg-card">
                                <h3 className="font-medium mb-2">Max Iterations</h3>
                                <p className="text-sm text-muted-foreground">
                                    코드 생성 시 최대 반복 횟수를 설정합니다 (1-20).
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* Workflow */}
                    <section className="space-y-4">
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <Code2 className="w-5 h-5 text-blue-500" />
                            워크플로우
                        </h2>
                        <div className="p-6 rounded-xl border border-border/50 bg-card">
                            <ol className="space-y-3 text-sm">
                                <li className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">1</span>
                                    <div>
                                        <strong>Requirements Analysis</strong>
                                        <p className="text-muted-foreground">사용자 입력을 분석하여 요구사항을 파악합니다.</p>
                                    </div>
                                </li>
                                <li className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">2</span>
                                    <div>
                                        <strong>Plan Generation</strong>
                                        <p className="text-muted-foreground">개발 플랜과 아키텍처를 설계합니다.</p>
                                    </div>
                                </li>
                                <li className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">3</span>
                                    <div>
                                        <strong>User Confirmation</strong>
                                        <p className="text-muted-foreground">사용자가 플랜을 확인하고 피드백을 제공합니다.</p>
                                    </div>
                                </li>
                                <li className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">4</span>
                                    <div>
                                        <strong>Code Generation</strong>
                                        <p className="text-muted-foreground">Backend/Frontend 코드를 생성합니다.</p>
                                    </div>
                                </li>
                                <li className="flex gap-3">
                                    <span className="shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary flex items-center justify-center text-xs font-bold">5</span>
                                    <div>
                                        <strong>Verification & Rework</strong>
                                        <p className="text-muted-foreground">생성된 코드를 검증하고 필요시 수정합니다.</p>
                                    </div>
                                </li>
                            </ol>
                        </div>
                    </section>

                    {/* Run Project */}
                    <section className="space-y-4">
                        <h2 className="text-xl font-semibold flex items-center gap-2">
                            <Play className="w-5 h-5 text-green-500" />
                            프로젝트 실행
                        </h2>
                        <div className="p-6 rounded-xl border border-border/50 bg-card space-y-3 text-sm">
                            <p>코드 생성이 완료되면 Workspace에서 프로젝트를 실행할 수 있습니다.</p>
                            <p className="text-muted-foreground">
                                • Backend: Python venv 생성 후 FastAPI/Flask 서버 실행<br />
                                • Frontend: npm install 후 Vite/Next.js 개발 서버 실행
                            </p>
                        </div>
                    </section>
                </div>
            </main>
        </div>
    );
}
