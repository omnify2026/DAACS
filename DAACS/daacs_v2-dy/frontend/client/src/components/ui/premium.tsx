/**
 * Phase 9 UI 고도화 - Premium Components
 * 
 * CSS 기반 애니메이션으로 구현 (TypeScript 호환성 보장)
 */

import React from 'react';
import { cn } from '@/lib/utils';
import { Loader2, Check, X, AlertCircle, Clock } from 'lucide-react';

// ====================== GLASS CARD ======================

interface GlassCardProps {
    className?: string;
    variant?: 'default' | 'elevated' | 'subtle';
    glow?: boolean;
    animate?: boolean;
    children?: React.ReactNode;
    onClick?: () => void;
}

export function GlassCard({ className, variant = 'default', glow = false, animate = false, children, onClick }: GlassCardProps) {
    const baseClasses = "rounded-xl backdrop-blur-xl transition-all duration-300";

    const variantClasses = {
        default: "bg-white/5 dark:bg-white/5 border border-white/10 dark:border-white/10",
        elevated: "bg-white/10 dark:bg-white/8 border border-white/15 dark:border-white/12 shadow-xl",
        subtle: "bg-white/3 dark:bg-white/3 border border-white/5 dark:border-white/5",
    };

    const glowClasses = glow ? "hover:shadow-[0_0_30px_-5px_hsl(var(--primary)/0.4)] hover:border-primary/30" : "";
    const animateClasses = animate ? "animate-fade-in-up" : "";

    return (
        <div
            className={cn(baseClasses, variantClasses[variant], glowClasses, animateClasses, className)}
            onClick={onClick}
        >
            {children}
        </div>
    );
}

// ====================== GRADIENT BUTTON ======================

interface GradientButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'cosmic' | 'ocean' | 'sunset';
    size?: 'sm' | 'md' | 'lg';
    loading?: boolean;
    glow?: boolean;
}

const gradientVariants = {
    primary: "from-blue-500 via-purple-500 to-pink-500",
    cosmic: "from-indigo-500 via-purple-500 to-pink-400",
    ocean: "from-cyan-500 via-blue-500 to-indigo-500",
    sunset: "from-orange-500 via-red-500 to-pink-500",
};

export function GradientButton({
    className, variant = 'primary', size = 'md', loading = false, glow = false, children, disabled, ...props
}: GradientButtonProps) {
    const sizeClasses = {
        sm: "px-3 py-1.5 text-sm",
        md: "px-4 py-2 text-base",
        lg: "px-6 py-3 text-lg",
    };

    return (
        <button
            disabled={disabled || loading}
            className={cn(
                "relative inline-flex items-center justify-center gap-2 rounded-lg font-medium text-white",
                "transition-all duration-300 overflow-hidden",
                `bg-gradient-to-r ${gradientVariants[variant]}`,
                "hover:opacity-90 hover:scale-[1.02] active:scale-[0.98]",
                glow && "shadow-[0_0_20px_-5px_hsl(var(--primary)/0.5)] hover:shadow-[0_0_30px_-5px_hsl(var(--primary)/0.6)]",
                disabled && "opacity-50 cursor-not-allowed hover:scale-100",
                sizeClasses[size],
                className
            )}
            {...props}
        >
            {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
                children
            )}
        </button>
    );
}

// ====================== STATUS BADGE ======================

type StatusType = 'success' | 'warning' | 'error' | 'info' | 'processing' | 'pending';

interface StatusBadgeProps {
    status: StatusType;
    label?: string;
    pulse?: boolean;
    className?: string;
}

const statusConfig: Record<StatusType, { bg: string; icon: React.ReactNode; defaultLabel: string }> = {
    success: {
        bg: "from-green-500 to-emerald-600",
        icon: <Check className="w-3 h-3" />,
        defaultLabel: "완료",
    },
    warning: {
        bg: "from-yellow-500 to-orange-500",
        icon: <AlertCircle className="w-3 h-3" />,
        defaultLabel: "주의",
    },
    error: {
        bg: "from-red-500 to-rose-600",
        icon: <X className="w-3 h-3" />,
        defaultLabel: "오류",
    },
    info: {
        bg: "from-blue-500 to-indigo-600",
        icon: <AlertCircle className="w-3 h-3" />,
        defaultLabel: "정보",
    },
    processing: {
        bg: "from-purple-500 to-violet-600",
        icon: <Loader2 className="w-3 h-3 animate-spin" />,
        defaultLabel: "처리중",
    },
    pending: {
        bg: "from-gray-400 to-gray-500",
        icon: <Clock className="w-3 h-3" />,
        defaultLabel: "대기",
    },
};

export function StatusBadge({ status, label, pulse = false, className }: StatusBadgeProps) {
    const config = statusConfig[status];

    return (
        <span
            className={cn(
                "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium text-white",
                `bg-gradient-to-r ${config.bg}`,
                pulse && "animate-pulse",
                "animate-fade-in",
                className
            )}
        >
            {config.icon}
            <span>{label || config.defaultLabel}</span>
        </span>
    );
}

// ====================== TYPING INDICATOR ======================

interface TypingIndicatorProps {
    className?: string;
}

export function TypingIndicator({ className }: TypingIndicatorProps) {
    return (
        <div className={cn("flex items-center gap-1", className)}>
            {[0, 1, 2].map((i) => (
                <span
                    key={i}
                    className="w-2 h-2 bg-primary rounded-full animate-bounce"
                    style={{ animationDelay: `${i * 0.2}s` }}
                />
            ))}
        </div>
    );
}

// ====================== WORKFLOW NODE ======================

type NodeStatus = 'pending' | 'active' | 'completed' | 'error';

interface WorkflowNodeProps {
    title: string;
    status: NodeStatus;
    subtitle?: string;
    icon?: React.ReactNode;
    onClick?: () => void;
    className?: string;
}

export function WorkflowNode({ title, status, subtitle, icon, onClick, className }: WorkflowNodeProps) {
    const statusStyles: Record<NodeStatus, string> = {
        pending: "border-muted-foreground/30 bg-muted/30",
        active: "border-primary bg-primary/10 shadow-[0_0_20px_-5px_hsl(var(--primary)/0.5)] animate-pulse",
        completed: "border-green-500/50 bg-green-500/10",
        error: "border-red-500/50 bg-red-500/10",
    };

    const iconStyles: Record<NodeStatus, React.ReactNode> = {
        pending: <Clock className="w-4 h-4 text-muted-foreground" />,
        active: <Loader2 className="w-4 h-4 text-primary animate-spin" />,
        completed: <Check className="w-4 h-4 text-green-500" />,
        error: <X className="w-4 h-4 text-red-500" />,
    };

    return (
        <div
            className={cn(
                "relative p-4 rounded-xl border-2 transition-all duration-300 cursor-pointer",
                "hover:scale-[1.02] active:scale-[0.98]",
                statusStyles[status],
                className
            )}
            onClick={onClick}
        >
            <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                    {icon || iconStyles[status]}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{title}</p>
                    {subtitle && (
                        <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
                    )}
                </div>
            </div>
        </div>
    );
}

// ====================== DEVICE FRAME ======================

type DeviceType = 'desktop' | 'tablet' | 'mobile';

interface DeviceFrameProps {
    device: DeviceType;
    children: React.ReactNode;
    className?: string;
}

const deviceStyles: Record<DeviceType, { wrapper: string; header: string; maxWidth: string }> = {
    desktop: {
        wrapper: "rounded-lg border-2 border-border overflow-hidden shadow-xl",
        header: "h-6 bg-muted border-b border-border flex items-center gap-1.5 px-3",
        maxWidth: "max-w-full",
    },
    tablet: {
        wrapper: "rounded-2xl border-4 border-border overflow-hidden shadow-xl",
        header: "h-5 bg-muted flex items-center justify-center",
        maxWidth: "max-w-[768px]",
    },
    mobile: {
        wrapper: "rounded-3xl border-4 border-border overflow-hidden shadow-xl",
        header: "h-7 bg-muted flex items-center justify-center",
        maxWidth: "max-w-[375px]",
    },
};

export function DeviceFrame({ device, children, className }: DeviceFrameProps) {
    const styles = deviceStyles[device];

    return (
        <div
            className={cn(styles.wrapper, styles.maxWidth, "animate-fade-in-up", className)}
        >
            <div className={styles.header}>
                {device === 'desktop' && (
                    <>
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
                        <span className="w-2.5 h-2.5 rounded-full bg-yellow-500" />
                        <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
                    </>
                )}
                {device === 'mobile' && (
                    <div className="w-20 h-1.5 bg-border rounded-full" />
                )}
            </div>
            <div className="bg-background">
                {children}
            </div>
        </div>
    );
}

// ====================== ANIMATED COUNTER ======================

interface AnimatedCounterProps {
    value: number;
    duration?: number;
    className?: string;
}

export function AnimatedCounter({ value, duration = 1, className }: AnimatedCounterProps) {
    const [displayValue, setDisplayValue] = React.useState(0);

    React.useEffect(() => {
        const startTime = Date.now();
        const startValue = displayValue;
        const diff = value - startValue;

        const animate = () => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / (duration * 1000), 1);
            const eased = 1 - Math.pow(1 - progress, 3);

            setDisplayValue(Math.round(startValue + diff * eased));

            if (progress < 1) {
                requestAnimationFrame(animate);
            }
        };

        requestAnimationFrame(animate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, duration]);

    return (
        <span className={className}>
            {displayValue.toLocaleString()}
        </span>
    );
}

// ====================== SHIMMER LOADING ======================

interface ShimmerProps {
    className?: string;
    width?: string | number;
    height?: string | number;
}

export function Shimmer({ className, width, height }: ShimmerProps) {
    return (
        <div
            className={cn(
                "relative overflow-hidden bg-muted rounded animate-pulse",
                className
            )}
            style={{ width, height }}
        >
            <div className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
        </div>
    );
}
