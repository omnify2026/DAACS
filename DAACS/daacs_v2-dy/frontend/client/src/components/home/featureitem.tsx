import type { ReactNode } from "react";

type FeatureItemProps = {
    icon: ReactNode;
    title: string;
    desc: string;
};

export function FeatureItem({ icon, title, desc }: FeatureItemProps) {
    return (
        <div className="flex flex-col items-center text-center space-y-2 group">
            <div className="p-3 rounded-2xl bg-background border border-border/50 text-muted-foreground group-hover:text-foreground group-hover:border-foreground/30 transition-all shadow-sm group-hover:shadow-md">
                {icon}
            </div>
            <h4 className="font-semibold text-sm tracking-tight">{title}</h4>
            <p className="text-sm text-muted-foreground font-light">{desc}</p>
        </div>
    );
}
