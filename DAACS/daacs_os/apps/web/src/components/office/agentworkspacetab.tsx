import { useMemo } from "react";

import { buildAgentProgramDerivedData } from "../../lib/agentProgramUtils";
import { buildAgentProgramSpecs } from "../../lib/programRegistry";
import type { AgentProgramProps } from "../../types/program";
import { ProgramGrid } from "./ProgramGrid";
import { PROGRAM_COMPONENTS } from "./programs";

export function AgentWorkspaceTab(props: AgentProgramProps) {
  const programs = useMemo(() => buildAgentProgramSpecs(props.agent), [props.agent]);
  const derived = useMemo(
    () => buildAgentProgramDerivedData(props.agent, props.data),
    [props.agent, props.data],
  );

  return (
    <ProgramGrid
      programs={programs}
      renderProgram={(program) => {
        const Component = PROGRAM_COMPONENTS[program.id];
        return <Component {...props} program={program} derived={derived} />;
      }}
    />
  );
}
