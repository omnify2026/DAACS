import React, { useMemo } from "react";
import { cn } from "@/lib/utils";

interface SimpleMarkdownProps {
    content: string;
    className?: string;
}

export function SimpleMarkdown({ content, className }: SimpleMarkdownProps) {
    const elements = useMemo(() => {
        if (!content) return null;

        // Split by lines to handle block elements
        const lines = content.split('\n');
        const nodes: React.ReactNode[] = [];

        let currentList: React.ReactNode[] = [];
        let isOrdered = false;
        let listKey = 0;

        const flushList = () => {
            if (currentList.length > 0) {
                nodes.push(
                    isOrdered ? (
                        <ol key={`list-${listKey++}`} className="list-decimal pl-5 space-y-1 mb-4">{currentList}</ol>
                    ) : (
                        <ul key={`list-${listKey++}`} className="list-disc pl-5 space-y-1 mb-4">{currentList}</ul>
                    )
                );
                currentList = [];
            }
        };

        const parseInline = (text: string) => {
            // Simple bold parsing: **text**
            const parts = text.split(/(\*\*.*?\*\*)/);
            return parts.map((part, i) => {
                if (part.startsWith('**') && part.endsWith('**')) {
                    return <strong key={i}>{part.slice(2, -2)}</strong>;
                }
                return part;
            });
        };

        lines.forEach((line, index) => {
            const trimmed = line.trim();

            // Headers
            if (trimmed.startsWith('# ')) {
                flushList();
                nodes.push(<h1 key={index} className="text-2xl font-bold mt-6 mb-4">{parseInline(trimmed.slice(2))}</h1>);
            } else if (trimmed.startsWith('## ')) {
                flushList();
                nodes.push(<h2 key={index} className="text-xl font-bold mt-5 mb-3">{parseInline(trimmed.slice(3))}</h2>);
            } else if (trimmed.startsWith('### ')) {
                flushList();
                nodes.push(<h3 key={index} className="text-lg font-semibold mt-4 mb-2">{parseInline(trimmed.slice(4))}</h3>);
            }
            // Lists
            else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
                if (currentList.length === 0 || isOrdered) {
                    flushList();
                    isOrdered = false;
                }
                currentList.push(<li key={index}>{parseInline(trimmed.slice(2))}</li>);
            } else if (/^\d+\. /.test(trimmed)) {
                if (currentList.length === 0 || !isOrdered) {
                    flushList();
                    isOrdered = true;
                }
                const itemContent = trimmed.replace(/^\d+\. /, '');
                currentList.push(<li key={index}>{parseInline(itemContent)}</li>);
            }
            // Paragraphs / Empty lines
            else if (trimmed === '') {
                flushList();
                nodes.push(<div key={index} className="h-2" />); // Spacer
            } else {
                flushList();
                nodes.push(<p key={index} className="mb-2 leading-relaxed">{parseInline(trimmed)}</p>);
            }
        });

        flushList();

        return nodes;
    }, [content]);

    if (!content || !elements) return null;

    return <div className={cn("text-sm text-foreground/90", className)}>{elements}</div>;
}
