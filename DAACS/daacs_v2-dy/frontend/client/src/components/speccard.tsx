import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CheckCircle2, FlaskConical, Lightbulb, Edit } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface SpecItem {
    id: string;
    type: "feature" | "tech" | "architecture";
    title: string;
    description: string;
    status: "proposed" | "accepted" | "rejected";
    rationale?: string;
    sources?: string[];
    tech_category?: string;
}

interface SpecCardProps {
    spec: SpecItem;
    onEdit?: (spec: SpecItem) => void;
}

export function SpecCard({ spec, onEdit }: SpecCardProps) {
    const isTech = spec.type === "tech";
    const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);
    const getSourceLabel = (value: string) => {
        if (isHttpUrl(value)) {
            try {
                return new URL(value).hostname;
            } catch {
                return value;
            }
        }
        return value;
    };

    return (
        <Card className={`group relative transition-all duration-200 hover:shadow-md ${isTech ? "border-purple-500/20 bg-purple-500/5 mb-3" : "border-border mb-3"}`}>
            <CardHeader className="py-3 px-4">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                        {isTech ? (
                            <FlaskConical className="w-4 h-4 text-purple-400" />
                        ) : (
                            <CheckCircle2 className="w-4 h-4 text-green-400" />
                        )}
                        <CardTitle className="text-sm font-medium leading-none">
                            {spec.title}
                        </CardTitle>
                        <Badge variant="outline" className="text-xs font-normal">
                            {spec.id}
                        </Badge>
                        {isTech && spec.tech_category && (
                            <Badge variant="secondary" className="text-xs">
                                {spec.tech_category}
                            </Badge>
                        )}
                    </div>
                </div>
            </CardHeader>
            <CardContent className="py-0 pb-3 px-4">
                <p className="text-sm text-muted-foreground line-clamp-2">
                    {spec.description}
                </p>

                {/* Traceability / Rationale Section */}
                {spec.rationale && (
                    <div className="mt-3 flex items-center gap-2">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-yellow-500/10 cursor-help transition-colors hover:bg-yellow-500/20">
                                        <Lightbulb className="w-3 h-3 text-yellow-500" />
                                        <span className="text-xs text-yellow-600/90 font-medium">Why?</span>
                                    </div>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-sm p-3" side="top">
                                    <p className="text-xs mb-2">{spec.rationale || "이 기능/기술이 선택된 이유입니다."}</p>
                                    {spec.sources && spec.sources.length > 0 && (
                                        <div className="border-t pt-2 mt-2">
                                            <p className="text-[10px] text-muted-foreground font-semibold mb-1">Sources:</p>
                                            <ul className="space-y-1">
                                                {spec.sources.map((src, i) => (
                                                    <li key={i}>
                                                        {isHttpUrl(src) ? (
                                                            <a
                                                                href={src}
                                                                target="_blank"
                                                                rel="noopener noreferrer"
                                                                className="text-[10px] text-blue-400 hover:underline flex items-center gap-1 truncate max-w-[200px]"
                                                            >
                                                                {getSourceLabel(src)}
                                                            </a>
                                                        ) : (
                                                            <span className="text-[10px] text-muted-foreground flex items-center gap-1 truncate max-w-[200px]">
                                                                {getSourceLabel(src)}
                                                            </span>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                )}

                {/* On-hover Edit Action */}
                {isTech && onEdit && (
                    <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onEdit(spec)}>
                            <Edit className="w-3 h-3" />
                        </Button>
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
