import type { ReactNode } from "react";

import type { AgentProgramSpec } from "../../types/program";

export function ProgramGrid({
  programs,
  renderProgram,
}: {
  programs: AgentProgramSpec[];
  renderProgram: (program: AgentProgramSpec) => ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
      {programs.map((program) => (
        <div
          key={program.id}
          className={program.size === "full" ? "xl:col-span-2" : ""}
        >
          {renderProgram(program)}
        </div>
      ))}
    </div>
  );
}
