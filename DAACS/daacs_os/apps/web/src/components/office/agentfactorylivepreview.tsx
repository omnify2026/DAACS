import type { SkillMeta } from "../../types/runtime";
import type { FactoryBlueprintDraft } from "../../lib/runtimeBuilder";
import type { AgentRole } from "../../types/agent";
import type { TranslateFn } from "./agentFactoryShared";
import { AgentCharacterStaticPreview } from "./AgentSprite";

interface Props {
  t: TranslateFn;
  draft: FactoryBlueprintDraft;
  previewRole: AgentRole;
  characterFilename: string | null;
  selectedSkills: Array<{ id: string; meta: SkillMeta | undefined }>;
  onCharacterCustomize: () => void;
  canUseCharacterCustomize: boolean;
}

export function AgentFactoryLivePreview({
  t,
  draft,
  previewRole,
  characterFilename,
  selectedSkills,
  onCharacterCustomize,
  canUseCharacterCustomize,
}: Props) {
  const file = characterFilename?.trim() ?? "";
  return (
    <div className="rounded-xl border border-[#374151] bg-[#0b1220] p-4">
      <div className="text-sm font-semibold text-cyan-300">{t("factory.edit.previewTitle")}</div>
      <div className="mt-3">
        <div className="text-lg font-semibold">{draft.blueprint.name}</div>
        <div className="text-xs text-gray-400">{draft.blueprint.role_label}</div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <div className="flex min-h-[9rem] min-w-[7rem] flex-1 items-center justify-center rounded-xl border border-[#374151] bg-[#050810]/90 py-4">
          <div className="origin-top scale-[1.35]">
            <AgentCharacterStaticPreview role={previewRole} characterFilename={file !== "" ? file : null} />
          </div>
        </div>
        <button
          type="button"
          disabled={!canUseCharacterCustomize}
          onClick={onCharacterCustomize}
          className="shrink-0 rounded-lg border border-cyan-500/45 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {t("factory.characterCustomize")}
        </button>
      </div>

      <div className="mt-5">
        <div className="mb-2 text-xs font-semibold text-gray-400">{t("factory.preview.skills")}</div>
        {selectedSkills.length === 0 ? (
          <p className="text-xs text-gray-500">{t("factory.preview.noSkills")}</p>
        ) : (
          <ul className="flex flex-col gap-2 pr-1">
            {selectedSkills.map((s) => (
              <li
                key={s.id}
                className="rounded-lg border border-[#2A2A4A] bg-[#111827] px-3 py-2 text-xs text-gray-200"
              >
                <span className="font-mono text-cyan-200/90">{s.id}</span>
                {s.meta?.description != null && s.meta.description.trim() !== "" ? (
                  <span className="mt-0.5 block text-[11px] text-gray-500">{s.meta.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
