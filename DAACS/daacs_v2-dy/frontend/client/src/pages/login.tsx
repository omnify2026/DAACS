import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Bot, ArrowRight, Loader2 } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";

export default function Login() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const { login } = useAuth();
    const [, setLocation] = useLocation();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!username || !password) {
            setError("Please enter both username and password.");
            return;
        }

        setIsLoading(true);
        setError("");

        // Simulate brief loading
        await new Promise(resolve => setTimeout(resolve, 300));

        const success = login(username, password);
        if (success) {
            // Redirect to home page after successful login
            setLocation("/");
        } else {
            setError("Invalid username or password.");
        }
        setIsLoading(false);
    };

    return (
        <div className="min-h-screen bg-background flex flex-col font-sans selection:bg-black selection:text-white dark:selection:bg-white dark:selection:text-black">
            {/* Minimal Header */}
            <nav className="flex items-center justify-between px-8 py-6 max-w-7xl mx-auto w-full">
                <div className="flex items-center gap-2">
                    <Bot className="w-6 h-6" />
                    <span className="font-bold text-lg tracking-tight">Transformers</span>
                </div>
                <ThemeToggle />
            </nav>

            <main className="flex-1 flex flex-col items-center justify-center px-4 pb-32">
                <div className="w-full max-w-sm mx-auto flex flex-col items-center space-y-8">

                    {/* Mascot */}
                    <div className="relative group cursor-default animate-in fade-in zoom-in duration-700">
                        <div className="absolute inset-0 bg-gradient-to-tr from-purple-200 to-blue-200 dark:from-purple-900/40 dark:to-blue-900/40 rounded-full blur-3xl opacity-60 group-hover:opacity-80 transition-opacity duration-1000" />
                        <div className="relative bg-background/80 backdrop-blur-sm rounded-3xl p-5 shadow-2xl ring-1 ring-border/5 hover:scale-105 transition-transform duration-300">
                            <Bot className="w-12 h-12 text-foreground stroke-[1.5]" />
                        </div>
                    </div>

                    <div className="text-center space-y-2 animate-in slide-in-from-bottom-5 duration-700 delay-100">
                        <h1 className="text-3xl font-bold tracking-tighter text-foreground">
                            Welcome back
                        </h1>
                        <p className="text-muted-foreground font-light">
                            Sign in to continue building.
                        </p>
                    </div>

                    {/* Login Form - Soft Container */}
                    <div className="w-full animate-in slide-in-from-bottom-5 duration-700 delay-200">
                        <div className="relative group">
                            <div className="absolute -inset-0.5 bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-800 dark:via-gray-700 dark:to-gray-800 rounded-2xl opacity-50 blur transition duration-500" />
                            <div className="relative bg-background rounded-2xl shadow-xl shadow-black/5 ring-1 ring-border/20 p-6 space-y-5">
                                <form onSubmit={handleLogin} className="space-y-4">
                                    <div className="space-y-2">
                                        <Label htmlFor="username" className="text-sm font-medium">Username</Label>
                                        <Input
                                            id="username"
                                            type="text"
                                            placeholder="Enter your username"
                                            value={username}
                                            onChange={(e) => setUsername(e.target.value)}
                                            className="h-11 rounded-xl border-border/50 bg-muted/30 focus-visible:ring-1 focus-visible:ring-foreground/20"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="password" className="text-sm font-medium">Password</Label>
                                        <Input
                                            id="password"
                                            type="password"
                                            placeholder="Enter your password"
                                            value={password}
                                            onChange={(e) => setPassword(e.target.value)}
                                            className="h-11 rounded-xl border-border/50 bg-muted/30 focus-visible:ring-1 focus-visible:ring-foreground/20"
                                        />
                                    </div>

                                    {error && (
                                        <p className="text-sm text-red-500 font-medium animate-in fade-in">{error}</p>
                                    )}

                                    <Button
                                        type="submit"
                                        disabled={isLoading}
                                        className="w-full h-11 rounded-full bg-foreground text-background hover:bg-foreground/90 font-medium transition-transform hover:scale-[1.02] gap-2"
                                    >
                                        {isLoading ? (
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <>
                                                Sign in
                                                <ArrowRight className="w-4 h-4" />
                                            </>
                                        )}
                                    </Button>
                                </form>
                            </div>
                        </div>
                    </div>

                    <p className="text-xs text-muted-foreground/60 text-center">
                        Demo: Use any username/password to sign in.
                    </p>
                </div>
            </main>
        </div>
    );
}
