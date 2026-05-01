import { BRIEF_EXAMPLE_KEYS } from "./agentFactoryState";
import type { TranslateFn } from "./agentFactoryShared";

interface Props {
  t: TranslateFn;
  brief: string;
  aiAvailable: boolean;
  onBriefChange: (value: string) => void;
  onExampleClick: (value: string) => void;
  onManualDesign: () => void;
}

export function AgentFactoryBriefStep({
  t,
  brief,
  aiAvailable,
  onBriefChange,
  onExampleClick,
  onManualDesign,
}: Props) {
  return (
    <div className="mx-auto max-w-3xl rounded-2xl border border-[#374151] bg-[#0b1220] p-6">
      <div className="text-xl font-semibold text-white">{t("factory.brief.title")}</div>
      <p className="mt-2 text-sm text-gray-400">{t("factory.brief.description")}</p>
      <textarea
        value={brief}
        onChange={(event) => onBriefChange(event.target.value)}
        className="mt-5 h-44 w-full rounded-xl border border-[#374151] bg-[#111827] p-4 text-sm"
        placeholder={t("factory.placeholder")}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        {BRIEF_EXAMPLE_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onExampleClick(t(key))}
            className="rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs text-cyan-100"
          >
            {t(key)}
          </button>
        ))}
      </div>
      {!aiAvailable ? (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
          {t("factory.notice.directOnly")}
        </div>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onManualDesign}
          className="rounded-lg border border-[#374151] px-4 py-2 text-sm"
        >
          {t("factory.manualDesign")}
        </button>
      </div>
    </div>
  );
}
