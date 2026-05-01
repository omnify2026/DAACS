import type { ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
}

export function DashboardPanel({ title, children }: Props) {
  return (
    <section className="bg-[#111827]/90 border border-[#374151] rounded-xl p-4">
      <h3 className="text-sm text-cyan-300 font-semibold mb-3">{title}</h3>
      {children}
    </section>
  );
}

