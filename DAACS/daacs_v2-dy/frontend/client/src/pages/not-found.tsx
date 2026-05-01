import { Bot, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-4 font-sans selection:bg-black selection:text-white dark:selection:bg-white dark:selection:text-black">
      {/* Mascot */}
      <div className="relative group cursor-default animate-in fade-in zoom-in duration-700 mb-8">
        <div className="absolute inset-0 bg-gradient-to-tr from-purple-200 to-blue-200 dark:from-purple-900/40 dark:to-blue-900/40 rounded-full blur-3xl opacity-60" />
        <div className="relative bg-background/80 backdrop-blur-sm rounded-3xl p-6 shadow-2xl ring-1 ring-border/5">
          <Bot className="w-16 h-16 text-muted-foreground stroke-[1.5]" />
        </div>
      </div>

      <div className="text-center space-y-4 animate-in slide-in-from-bottom-5 duration-700 delay-100">
        <h1 className="text-6xl font-bold tracking-tighter text-foreground">404</h1>
        <p className="text-xl text-muted-foreground font-light">
          Page not found.
        </p>
        <p className="text-sm text-muted-foreground/60">
          The page you&apos;re looking for doesn&apos;t exist or has been moved.
        </p>
      </div>

      <Button
        onClick={() => setLocation("/")}
        className="mt-8 rounded-full bg-foreground text-background hover:bg-foreground/90 px-6 h-10 font-medium gap-2 animate-in slide-in-from-bottom-5 duration-700 delay-200"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Home
      </Button>
    </div>
  );
}
