import { resolveProgramIcon } from "../../../lib/programIcons";
import type { AgentProgramComponentProps } from "../../../types/program";
import { EmptyState } from "./ProgramButtons";
import { ProgramShell } from "./ProgramShell";

export function FileChangesProgram({
  data,
  program,
  t,
}: AgentProgramComponentProps) {
  const Icon = resolveProgramIcon(program.id);

  return (
    <ProgramShell
      title={t(program.title_key)}
      description={t(program.description_key)}
      accentClass={program.accent_class}
      icon={Icon}
    >
      {data.file_changes.length === 0 ? (
        <EmptyState label={t("workspace.empty.files")} />
      ) : (
        <div className="space-y-2">
          {data.file_changes.slice(0, 6).map((change) => (
            <div key={change.id} className="rounded-lg bg-[#0b1220] p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-white">{change.filePath}</span>
                <span className="text-gray-400">{change.action}</span>
              </div>
              <div className="mt-1 text-gray-400">{change.toolName}</div>
            </div>
          ))}
        </div>
      )}
    </ProgramShell>
  );
}
