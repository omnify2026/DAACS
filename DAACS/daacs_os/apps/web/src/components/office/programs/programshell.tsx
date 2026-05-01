import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function ProgramShell({
  title,
  description,
  accentClass,
  icon: Icon,
  children,
}: {
  title: string;
  description: string;
  accentClass: string;
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <section className={`rounded-2xl border ${accentClass} p-4`}>
      <div className="flex items-start gap-3">
        {Icon ? (
          <div className="rounded-xl border border-white/10 bg-black/20 p-2 text-white/80">
            <Icon className="h-4 w-4" />
          </div>
        ) : null}
        <div>
          <div className="text-sm font-semibold text-white">{title}</div>
          <div className="mt-1 text-xs text-gray-300">{description}</div>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
