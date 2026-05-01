import { useCliLogStore } from "../../stores/cliLogStore";
import { useI18n } from "../../i18n";

const FORMAT_TIME = (ts: number) => {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
};

export function CliLogPanel() {
  const { t } = useI18n();
  const { entries, panelOpen, setPanelOpen, clear } = useCliLogStore();

  if (!panelOpen) return null;

  return (
    <div className="fixed left-0 right-0 bottom-0 h-[min(260px,40vh)] z-[90] flex flex-col bg-[#0d0d1a] border-t border-amber-500/30 shadow-2xl">
      <div className="flex items-center justify-between px-3 py-2 border-b border-amber-500/30 bg-[#111127]/95">
        <span className="text-xs uppercase tracking-wider text-amber-400/90">{t("cliDev.logTitle")}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => clear()}
            className="px-2 py-1 text-[10px] rounded border border-amber-500/40 text-amber-300/80 hover:bg-amber-500/20"
          >
            {t("cliDev.clear")}
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen(false)}
            className="px-2 py-1 text-[10px] rounded border border-amber-500/40 text-amber-300/80 hover:bg-amber-500/20"
          >
            {t("cliDev.close")}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto p-2 space-y-3">
        {entries.length === 0 ? (
          <div className="text-xs text-gray-500 py-4 text-center">{t("cliDev.logEmpty")}</div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.id}
              className="rounded-lg border border-white/10 bg-black/30 overflow-hidden text-left"
            >
              <div className="flex items-center justify-between px-2 py-1.5 bg-white/5 border-b border-white/10 text-[10px]">
                <span className="text-gray-400">
                  {FORMAT_TIME(entry.timestamp)}
                  {entry.provider ? ` · ${entry.provider}` : ""}
                  {entry.label ? ` · ${entry.label.slice(0, 20)}` : ""}
                </span>
                <span className={entry.exit_code === 0 ? "text-green-400" : "text-red-400"}>
                  exit {entry.exit_code}
                </span>
              </div>
              <pre className="p-2 text-[11px] text-gray-300 whitespace-pre-wrap break-words font-mono max-h-48 overflow-auto">
                {(() => {
                  const skillTraceLines: string[] = [];
                  if ((entry.skillRequestParsed?.length ?? 0) > 0) {
                    skillTraceLines.push(`Parsed: ${entry.skillRequestParsed!.join(", ")}`);
                  }
                  if ((entry.skillInjectedRefs?.length ?? 0) > 0) {
                    skillTraceLines.push(`Injected (bundle): ${entry.skillInjectedRefs!.join(", ")}`);
                  }
                  if ((entry.skillRequestDroppedRefs?.length ?? 0) > 0) {
                    skillTraceLines.push(`Not in bundle: ${entry.skillRequestDroppedRefs!.join(", ")}`);
                  }
                  const skillTraceBlock =
                    skillTraceLines.length > 0 ? `## Skill request trace\n${skillTraceLines.join("\n")}` : "";
                  return [
                    entry.systemPrompt ? `## System Prompt\n${entry.systemPrompt}` : "",
                    skillTraceBlock,
                    entry.stdin ? `## Input\n${entry.stdin}` : "",
                    entry.stdout ? `## Stdout\n${entry.stdout}` : "",
                    entry.stderr ? `## Stderr\n${entry.stderr}` : "",
                  ]
                    .filter((v) => v.trim() !== "")
                    .join("\n\n");
                })() || "(no output)"}
              </pre>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
