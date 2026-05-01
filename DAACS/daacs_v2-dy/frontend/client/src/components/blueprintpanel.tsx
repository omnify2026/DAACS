import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ZoomIn, ZoomOut, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { logError } from "@/lib/logger";

interface BlueprintPanelProps {
    mermaidScript: string;
}

export function BlueprintPanel({ mermaidScript }: BlueprintPanelProps) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [svgContent, setSvgContent] = useState<string>("");
    const [scale, setScale] = useState(1);
    const [isLoading, setIsLoading] = useState(false);

    useEffect(() => {
        if (!mermaidScript) return;

        setIsLoading(true);

        // Lazy load mermaid only when needed
        import("mermaid").then(async ({ default: mermaid }) => {
            mermaid.initialize({
                startOnLoad: false,
                theme: "dark",
                securityLevel: "loose",
                fontFamily: "Inter, sans-serif"
            });

            try {
                const { svg } = await mermaid.render(`blueprint-${Date.now()}`, mermaidScript);
                setSvgContent(svg);
            } catch (error) {
                logError("Mermaid render error:", error);
                setSvgContent(`<div class="text-red-400 p-4">Failed to render blueprint: ${error}</div>`);
            } finally {
                setIsLoading(false);
            }
        }).catch((error) => {
            logError("Failed to load mermaid:", error);
            setIsLoading(false);
        });
    }, [mermaidScript]);

    return (
        <Card className="border-border bg-card/50 h-full flex flex-col overflow-hidden relative">
            <div className="absolute top-4 right-4 z-10 flex gap-2">
                <Button variant="outline" size="icon" onClick={() => setScale(s => Math.min(s + 0.2, 2))}>
                    <ZoomIn className="w-4 h-4" />
                </Button>
                <Button variant="outline" size="icon" onClick={() => setScale(s => Math.max(s - 0.2, 0.5))}>
                    <ZoomOut className="w-4 h-4" />
                </Button>
            </div>

            <ScrollArea className="flex-1 w-full h-full">
                {isLoading ? (
                    <div className="w-full h-full min-h-[400px] flex items-center justify-center">
                        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                    </div>
                ) : (
                    <div
                        ref={containerRef}
                        className="w-full h-full min-h-[400px] flex items-center justify-center p-8 transition-transform duration-200 origin-center"
                        style={{ transform: `scale(${scale})` }}
                        dangerouslySetInnerHTML={{ __html: svgContent }}
                    />
                )}
            </ScrollArea>
        </Card>
    );
}
