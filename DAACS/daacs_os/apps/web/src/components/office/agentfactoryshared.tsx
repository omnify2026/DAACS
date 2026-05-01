import type { ReactNode } from "react";

import type { AgentProgramSpec } from "../../types/program";
import { ProgramGrid } from "./ProgramGrid";

export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function ProgramPreviewGrid({
  programs,
  t,
}: {
  programs: AgentProgramSpec[];
  t: TranslateFn;
}) {
  return (
    <ProgramGrid
      programs={programs}
      renderProgram={(program) => (
        <div className={`rounded-xl border p-3 ${program.accent_class}`} key={program.id}>
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-white">{t(program.title_key)}</div>
            <div className="rounded-full border border-white/15 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70">
              {program.id}
            </div>
          </div>
          <div className="mt-2 text-xs text-white/75">{t(program.description_key)}</div>
        </div>
      )}
    />
  );
}

export function StepPill({
  label,
  active,
}: {
  label: string;
  active: boolean;
}) {
  return (
    <div
      className={`rounded-full border px-3 py-1 text-xs ${
        active
          ? "border-cyan-400 bg-cyan-500/15 text-cyan-100"
          : "border-[#374151] text-gray-400"
      }`}
    >
      {label}
    </div>
  );
}

export function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-[#1f2937] bg-[#111827] p-3">
      <div className="text-[11px] uppercase tracking-[0.16em] text-gray-500">{label}</div>
      <div className="mt-2 text-sm text-gray-100">{value}</div>
    </div>
  );
}
