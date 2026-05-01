import React, { useEffect, useState, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Bot, User, Terminal, CheckCircle, XCircle, AlertTriangle } from "lucide-react";

interface AgentMessage {
    message_id: string;
    sender: string;
    receiver: string;
    type: string;
    content: any;
    timestamp: string;
    metadata?: any;
}

export function AgentChat() {
    const [messages, setMessages] = useState<AgentMessage[]>([]);
    const [status, setStatus] = useState<"connected" | "disconnected">("disconnected");
    const scrollRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let eventSource: EventSource | null = null;
        let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

        const connect = () => {
            eventSource = new EventSource('/api/stream/events');

            eventSource.onopen = () => {
                setStatus("connected");
            };

            eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    // Skip heartbeat events from displaying
                    if (data.type === "ping") {
                        return;
                    }
                    setMessages((prev) => [...prev, data]);
                } catch (e) {
                    console.error("Failed to parse SSE message", e);
                }
            };

            // Handle heartbeat events specifically
            eventSource.addEventListener("heartbeat", () => {
                // Heartbeat received - connection is alive
                setStatus("connected");
            });

            eventSource.onerror = () => {
                setStatus("disconnected");
                eventSource?.close();
                // Reconnect after 3 seconds
                reconnectTimeout = setTimeout(connect, 3000);
            };
        };

        connect();

        return () => {
            eventSource?.close();
            if (reconnectTimeout) {
                clearTimeout(reconnectTimeout);
            }
        };
    }, []);


    // Auto-scroll logic
    useEffect(() => {
        // Only scroll if we are near bottom or it's a new message
        const scrollContainer = scrollRef.current?.querySelector('[data-radix-scroll-area-viewport]');
        if (scrollContainer) {
            (scrollContainer as HTMLElement).scrollTop = (scrollContainer as HTMLElement).scrollHeight;
        }
    }, [messages]);

    const getAgentColor = (sender: string) => {
        if (sender.includes('planner')) return 'bg-blue-500/10 text-blue-500 border-blue-500/20';
        if (sender.includes('coder')) return 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
        if (sender.includes('reviewer')) return 'bg-red-500/10 text-red-500 border-red-500/20';
        if (sender === 'system') return 'bg-gray-500/10 text-gray-500 border-gray-500/20';
        return 'bg-purple-500/10 text-purple-500 border-purple-500/20';
    };

    const getIcon = (type: string) => {
        switch (type) {
            case 'error': return <XCircle className="w-4 h-4 text-red-500" />;
            case 'done': return <CheckCircle className="w-4 h-4 text-green-500" />;
            case 'reject': return <AlertTriangle className="w-4 h-4 text-orange-500" />;
            default: return <Bot className="w-4 h-4 opacity-70" />;
        }
    };

    return (
        <Card className="h-full flex flex-col border-none shadow-none bg-transparent">
            <CardHeader className="px-4 py-3 border-b flex flex-row items-center justify-between">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <Bot className="w-4 h-4" />
                    Agent Live Stream
                </CardTitle>
                <Badge variant="outline" className={status === "connected" ? "bg-green-500/10 text-green-500 border-green-500/20" : "bg-red-500/10 text-red-500"}>
                    {status === "connected" ? "Live" : "Offline"}
                </Badge>
            </CardHeader>
            <CardContent className="flex-1 overflow-hidden p-0">
                <ScrollArea className="h-full px-4 py-4" ref={scrollRef}>
                    {messages.length === 0 && (
                        <div className="flex flex-col items-center justify-center h-64 text-muted-foreground opacity-50">
                            <Terminal className="w-8 h-8 mb-2" />
                            <p>Waiting for agent activity...</p>
                        </div>
                    )}
                    {messages.map((msg, i) => (
                        <div key={i} className="mb-6 last:mb-0 animate-in fade-in slide-in-from-bottom-2 duration-300">
                            <div className="flex items-center gap-2 mb-2">
                                <Badge variant="outline" className={getAgentColor(msg.sender)}>
                                    {msg.sender}
                                </Badge>
                                <span className="text-xs text-muted-foreground">➔</span>
                                <Badge variant="outline" className="text-muted-foreground border-border/50">
                                    {msg.receiver}
                                </Badge>
                                <div className="ml-auto text-[10px] text-muted-foreground opacity-50">
                                    {new Date(Number(msg.timestamp) * 1000).toLocaleTimeString()}
                                </div>
                            </div>
                            <div className={`
                    rounded-lg p-3 text-sm whitespace-pre-wrap border
                    ${msg.type === 'error' ? 'bg-red-500/5 border-red-500/20' :
                                    msg.type === 'reject' ? 'bg-orange-500/5 border-orange-500/20' :
                                        msg.type === 'done' ? 'bg-green-500/5 border-green-500/20' :
                                            'bg-muted/30 border-border/50'}
                  `}>
                                <div className="flex items-start gap-2">
                                    <div className="mt-0.5">{getIcon(msg.type)}</div>
                                    <div className="flex-1 overflow-x-auto">
                                        {typeof msg.content === 'string' ? msg.content : (
                                            <pre className="text-xs">{JSON.stringify(msg.content, null, 2)}</pre>
                                        )}
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </ScrollArea>
            </CardContent>
        </Card>
    );
}
