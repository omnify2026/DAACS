/**
 * AssumptionEditor - Phase 1.5 UI Component
 * 
 * Allows users to edit design assumptions via structured UI (radio buttons, checkboxes)
 * instead of free-form text. This prevents LLM reinterpretation and ensures precision.
 * 
 * Design principles (from node1.5.md):
 * - Radio buttons for exclusive choices (environment, primary_focus)
 * - Checkboxes for optional toggles
 * - NO free-form text input
 * - Appears only when needed (not always visible)
 */

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Settings2, RefreshCw, AlertTriangle } from "lucide-react";

// Types matching Python daacs/context/types.py
export type Environment = "web" | "desktop" | "mobile";
export type PrimaryFocus = "mvp" | "design" | "stability";

export interface Assumptions {
    environment: Environment;
    primary_focus: PrimaryFocus;
    options: Record<string, boolean>;
}

export interface AssumptionDelta {
    removed: string[];
    added: string[];
    modified: Array<[string, string]>; // [old, new]
}

interface AssumptionEditorProps {
    assumptions: Assumptions;
    onApply: (delta: AssumptionDelta) => void;
    isVisible?: boolean;
    hasConflict?: boolean;
}

const ENVIRONMENT_OPTIONS: { value: Environment; label: string; description: string }[] = [
    { value: "web", label: "웹", description: "브라우저 기반 웹 애플리케이션" },
    { value: "desktop", label: "데스크톱", description: "네이티브 데스크톱 앱 (Electron/Tauri)" },
    { value: "mobile", label: "모바일", description: "모바일 앱 (React Native/Flutter)" },
];

const FOCUS_OPTIONS: { value: PrimaryFocus; label: string; description: string }[] = [
    { value: "mvp", label: "빠른 MVP", description: "최소 기능, 빠른 배포" },
    { value: "design", label: "디자인 중심", description: "UI/UX 품질 우선" },
    { value: "stability", label: "안정성", description: "테스트, 에러 처리 우선" },
];

const OPTIONAL_TOGGLES: { key: string; label: string }[] = [
    { key: "maintainability", label: "유지보수성" },
    { key: "ci_cd", label: "CI/CD 설정" },
    { key: "scalability", label: "확장성" },
];

export function AssumptionEditor({
    assumptions,
    onApply,
    isVisible = true,
    hasConflict = false,
}: AssumptionEditorProps) {
    const [editedAssumptions, setEditedAssumptions] = useState<Assumptions>(assumptions);

    if (!isVisible) {
        return null;
    }

    const handleEnvironmentChange = (value: Environment) => {
        setEditedAssumptions((prev) => ({ ...prev, environment: value }));
    };

    const handleFocusChange = (value: PrimaryFocus) => {
        setEditedAssumptions((prev) => ({ ...prev, primary_focus: value }));
    };

    const handleOptionToggle = (key: string, checked: boolean) => {
        setEditedAssumptions((prev) => ({
            ...prev,
            options: { ...prev.options, [key]: checked },
        }));
    };

    const calculateDelta = (): AssumptionDelta => {
        const delta: AssumptionDelta = { removed: [], added: [], modified: [] };

        // Check environment change
        if (assumptions.environment !== editedAssumptions.environment) {
            delta.modified.push([
                `environment:${assumptions.environment}`,
                `environment:${editedAssumptions.environment}`,
            ]);
        }

        // Check focus change
        if (assumptions.primary_focus !== editedAssumptions.primary_focus) {
            delta.modified.push([
                `primary_focus:${assumptions.primary_focus}`,
                `primary_focus:${editedAssumptions.primary_focus}`,
            ]);
        }

        // Check options changes
        for (const key of Object.keys(editedAssumptions.options)) {
            const oldVal = assumptions.options[key] || false;
            const newVal = editedAssumptions.options[key] || false;
            if (oldVal !== newVal) {
                if (newVal) {
                    delta.added.push(`option:${key}`);
                } else {
                    delta.removed.push(`option:${key}`);
                }
            }
        }

        return delta;
    };

    const handleApply = () => {
        const delta = calculateDelta();
        onApply(delta);
    };

    const hasChanges = calculateDelta();
    const isModified =
        hasChanges.added.length > 0 ||
        hasChanges.removed.length > 0 ||
        hasChanges.modified.length > 0;

    return (
        <Card className={`border-yellow-500/30 ${hasConflict ? "bg-yellow-500/10" : "bg-yellow-500/5"}`}>
            <CardHeader className="py-3 px-4">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <Settings2 className="h-4 w-4 text-yellow-400" />
                        <CardTitle className="text-sm font-medium">설계 기준 수정</CardTitle>
                        {hasConflict && (
                            <Badge variant="destructive" className="text-xs gap-1">
                                <AlertTriangle className="h-3 w-3" />
                                충돌 감지
                            </Badge>
                        )}
                    </div>
                    {isModified && (
                        <Badge variant="outline" className="text-xs text-yellow-400">
                            변경됨
                        </Badge>
                    )}
                </div>
            </CardHeader>

            <CardContent className="pt-0 pb-4 px-4 space-y-6">
                {/* Environment Selection */}
                <div className="space-y-3">
                    <Label className="text-sm font-medium">실행 환경</Label>
                    <RadioGroup
                        value={editedAssumptions.environment}
                        onValueChange={handleEnvironmentChange}
                        className="grid grid-cols-3 gap-2"
                    >
                        {ENVIRONMENT_OPTIONS.map((opt) => (
                            <div key={opt.value} className="flex items-center space-x-2">
                                <RadioGroupItem value={opt.value} id={`env-${opt.value}`} />
                                <Label
                                    htmlFor={`env-${opt.value}`}
                                    className="text-sm cursor-pointer"
                                >
                                    {opt.label}
                                </Label>
                            </div>
                        ))}
                    </RadioGroup>
                </div>

                {/* Primary Focus Selection */}
                <div className="space-y-3">
                    <Label className="text-sm font-medium">가장 중요한 기준</Label>
                    <RadioGroup
                        value={editedAssumptions.primary_focus}
                        onValueChange={handleFocusChange}
                        className="grid grid-cols-3 gap-2"
                    >
                        {FOCUS_OPTIONS.map((opt) => (
                            <div key={opt.value} className="flex items-center space-x-2">
                                <RadioGroupItem value={opt.value} id={`focus-${opt.value}`} />
                                <Label
                                    htmlFor={`focus-${opt.value}`}
                                    className="text-sm cursor-pointer"
                                >
                                    {opt.label}
                                </Label>
                            </div>
                        ))}
                    </RadioGroup>
                </div>

                {/* Optional Toggles */}
                <div className="space-y-3">
                    <Label className="text-sm font-medium">추가 고려사항</Label>
                    <div className="flex flex-wrap gap-4">
                        {OPTIONAL_TOGGLES.map((toggle) => (
                            <div key={toggle.key} className="flex items-center space-x-2">
                                <Checkbox
                                    id={`opt-${toggle.key}`}
                                    checked={editedAssumptions.options[toggle.key] || false}
                                    onCheckedChange={(checked) =>
                                        handleOptionToggle(toggle.key, checked === true)
                                    }
                                />
                                <Label
                                    htmlFor={`opt-${toggle.key}`}
                                    className="text-sm cursor-pointer"
                                >
                                    {toggle.label}
                                </Label>
                            </div>
                        ))}
                    </div>
                </div>

                {/* Apply Button */}
                <div className="pt-2 border-t border-border/40">
                    <Button
                        onClick={handleApply}
                        disabled={!isModified}
                        className="w-full gap-2"
                        variant={isModified ? "default" : "outline"}
                    >
                        <RefreshCw className="h-4 w-4" />
                        적용하고 다시 설계
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}

export default AssumptionEditor;
