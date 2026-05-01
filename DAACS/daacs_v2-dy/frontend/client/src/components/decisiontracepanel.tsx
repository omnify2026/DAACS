/**
 * DecisionTracePanel - Phase 1.5 UI Component
 * 
 * Displays TechContext facts and decision reasoning to users.
 * Shows up only when relevant (not always visible).
 */

import { useState } from "react";
import { TechContext, DecisionTrace } from "@/lib/daacsApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronUp, Lightbulb, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DecisionTracePanelProps {
    techContext?: TechContext;
    decisionTrace?: DecisionTrace;
    isVisible?: boolean;
}

export function DecisionTracePanel({
    techContext,
    decisionTrace,
    isVisible = true,
}: DecisionTracePanelProps) {
    const [isExpanded, setIsExpanded] = useState(false);

    // Don't render if no data
    if (!techContext && !decisionTrace) {
        return null;
    }

    // Auto-collapse if not visible
    if (!isVisible) {
        return null;
    }

    const facts = techContext?.facts || [];
    const sources = techContext?.sources || [];
    const constraints = techContext?.constraints || [];
    const usedFacts = decisionTrace?.used_facts || [];
    const assumptions = decisionTrace?.assumptions || [];

    if (facts.length === 0 && usedFacts.length === 0 && constraints.length === 0) {
        return null;
    }

    return (
        <Card className="border-blue-500/30 bg-blue-500/5">
            <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Lightbulb className="h-4 w-4 text-blue-400" />
                        <CardTitle className="text-sm font-medium">
                            설계 근거
                        </CardTitle>
                        <Badge variant="outline" className="text-xs">
                            {facts.length} facts
                        </Badge>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setIsExpanded(!isExpanded)}
                    >
                        {isExpanded ? (
                            <ChevronUp className="h-4 w-4" />
                        ) : (
                            <ChevronDown className="h-4 w-4" />
                        )}
                    </Button>
                </div>
            </CardHeader>

            {isExpanded && (
                <CardContent className="pt-0 pb-4 px-4 space-y-4">
                    {/* NON-NEGOTIABLE Constraints (from Assumptions) */}
                    {constraints.length > 0 && (
                        <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/30">
                            <h4 className="text-xs font-medium text-red-400 mb-2 flex items-center gap-1">
                                🔒 NON-NEGOTIABLE
                            </h4>
                            <ul className="space-y-1">
                                {constraints.filter(c => c.startsWith("CONSTRAINT:")).map((constraint, i) => (
                                    <li
                                        key={i}
                                        className="text-sm text-red-300"
                                    >
                                        • {constraint.replace("CONSTRAINT: ", "")}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Used Facts */}
                    {usedFacts.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-muted-foreground mb-2">
                                적용된 기술 맥락
                            </h4>
                            <ul className="space-y-1">
                                {usedFacts.map((fact, i) => (
                                    <li
                                        key={i}
                                        className="text-sm text-green-400 flex items-start gap-2"
                                    >
                                        <span className="text-green-500">✓</span>
                                        {fact}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* All Facts (if no usedFacts) */}
                    {usedFacts.length === 0 && facts.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-muted-foreground mb-2">
                                참고된 기술 맥락
                            </h4>
                            <ul className="space-y-1">
                                {facts.map((fact, i) => (
                                    <li
                                        key={i}
                                        className="text-sm text-muted-foreground"
                                    >
                                        • {fact}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Assumptions */}
                    {assumptions.length > 0 && (
                        <div>
                            <h4 className="text-xs font-medium text-muted-foreground mb-2">
                                설계 가정
                            </h4>
                            <ul className="space-y-1">
                                {assumptions.map((assumption, i) => (
                                    <li
                                        key={i}
                                        className="text-sm text-yellow-400 flex items-start gap-2"
                                    >
                                        <span className="text-yellow-500">⚡</span>
                                        {assumption}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {/* Sources */}
                    {sources.length > 0 && (
                        <div className="pt-2 border-t border-border/40">
                            <h4 className="text-xs font-medium text-muted-foreground mb-1">
                                출처
                            </h4>
                            <div className="flex flex-wrap gap-2">
                                {sources.map((source, i) => (
                                    <Badge
                                        key={i}
                                        variant="secondary"
                                        className="text-xs"
                                    >
                                        {source.startsWith("http") ? (
                                            <a
                                                href={source}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="flex items-center gap-1"
                                            >
                                                <ExternalLink className="h-3 w-3" />
                                                {new URL(source).hostname}
                                            </a>
                                        ) : (
                                            source
                                        )}
                                    </Badge>
                                ))}
                            </div>
                        </div>
                    )}
                </CardContent>
            )}
        </Card>
    );
}

export default DecisionTracePanel;
