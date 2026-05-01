import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { Loader2 } from 'lucide-react';

mermaid.initialize({
    startOnLoad: false,
    theme: 'dark', // or 'default' based on system theme, but PRIMUS is dark-ish
    securityLevel: 'loose',
    fontFamily: 'inherit',
});

interface MermaidProps {
    chart: string;
    className?: string;
}

export function Mermaid({ chart, className }: MermaidProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [svg, setSvg] = useState<string>('');
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!chart) return;

        let isMounted = true;
        const renderChart = async () => {
            setLoading(true);
            setError(null);
            try {
                const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
                const { svg } = await mermaid.render(id, chart);
                if (isMounted) {
                    setSvg(svg);
                }
            } catch (err: any) {
                if (isMounted) {
                    console.error("Mermaid error:", err);
                    // Mermaid often throws parsed error text, we try to show it or fallback
                    setError("Failed to render diagram. Syntax might be invalid.");
                }
            } finally {
                if (isMounted) setLoading(false);
            }
        };

        renderChart();

        return () => {
            isMounted = false;
        };
    }, [chart]);

    if (error) {
        return (
            <div className={`p-4 border border-destructive/50 rounded bg-destructive/10 text-destructive text-sm ${className}`}>
                <p className="font-semibold mb-1">Diagram Error</p>
                <p>{error}</p>
                <pre className="mt-2 text-xs opacity-70 whitespace-pre-wrap">{chart}</pre>
            </div>
        );
    }

    return (
        <div className={`relative ${className} min-h-[100px] flex items-center justify-center`}>
            {loading && <Loader2 className="absolute w-6 h-6 animate-spin text-muted-foreground" />}
            <div
                ref={ref}
                className={`w-full transition-opacity duration-300 ${loading ? 'opacity-0' : 'opacity-100'}`}
                dangerouslySetInnerHTML={{ __html: svg }}
            />
        </div>
    );
}
