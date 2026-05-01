import { useState } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ArrowRight, Zap, Code2, Bot, Terminal, Loader2 } from "lucide-react";

export default function Landing() {
  const [requirement, setRequirement] = useState("");
  const [, setLocation] = useLocation();
  const [isLoading, setIsLoading] = useState(false);

  const handleStart = () => {
    if (requirement.trim()) {
      setIsLoading(true);
      sessionStorage.setItem("initialRequirement", requirement.trim());
      // Redirect to login page
      setTimeout(() => {
        setLocation("/login");
      }, 500);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && e.metaKey && requirement.trim()) {
      handleStart();
    }
  };

  return (
    <div className="min-h-screen bg-background flex flex-col font-sans selection:bg-black selection:text-white dark:selection:bg-white dark:selection:text-black">
      {/* Navbar: Mobile-responsive */}
      <nav className="flex items-center justify-between px-4 sm:px-8 py-4 sm:py-6 max-w-7xl mx-auto w-full">
        <div className="flex items-center gap-2">
          <Bot className="w-5 h-5 sm:w-6 sm:h-6" />
          <span className="font-bold text-base sm:text-lg tracking-tight">Transformers</span>
        </div>
        <div className="flex items-center gap-2 sm:gap-6 text-sm font-medium text-muted-foreground">
          <button
            type="button"
            onClick={() => setLocation("/login")}
            className="hidden sm:block hover:text-foreground transition-colors"
          >
            Models
          </button>
          <a href="#" className="hidden sm:block hover:text-foreground transition-colors">Docs</a>
          <ThemeToggle />
          <Button
            variant="default"
            className="rounded-full bg-foreground text-background hover:bg-foreground/90 px-3 sm:px-5 h-8 sm:h-9 text-xs sm:text-sm font-medium"
            onClick={() => setLocation("/login")}
            data-testid="button-login-header"
          >
            Sign in
          </Button>
        </div>
      </nav>

      <main className="flex-1 flex flex-col items-center justify-center px-4 pb-32">
        <div className="w-full max-w-2xl mx-auto flex flex-col items-center space-y-12">

          {/* Mascot / Identity - The "Cute" Factor */}
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
                  data-testid="input-requirement"
                />

                <div className="flex items-center gap-2 pr-2">
                  <Button
                    onClick={handleStart}
                    disabled={!requirement.trim() || isLoading}
                    size="icon"
                    className="h-10 w-10 rounded-full bg-foreground text-background hover:bg-foreground/90 shrink-0 mb-[1px] shadow-sm hover:shadow-md transition-all hover:scale-105"
                    data-testid="button-start"
                  >
                    {isLoading ? <Loader2 className="w-5 h-5 animate-spin" /> : <ArrowRight className="w-5 h-5" />}
                  </Button>
                </div>
              </div>
            </div>
          </div>

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
          © 2024 Transformers. Built for builders.
        </div>
      </footer>
    </div>
  );
}

function FeatureItem({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) {
  return (
    <div className="flex flex-col items-center text-center space-y-2 group">
      <div className="p-3 rounded-2xl bg-background border border-border/50 text-muted-foreground group-hover:text-foreground group-hover:border-foreground/30 transition-all shadow-sm group-hover:shadow-md">{icon}</div>
      <h4 className="font-semibold text-sm tracking-tight">{title}</h4>
      <p className="text-sm text-muted-foreground font-light">{desc}</p>
    </div>
  );
}
