import { useState } from "react";
import { useI18n } from "../../i18n";

interface Props {
  onSelect: (track: "project") => void;
}

export function TrackSelector({ onSelect }: Props) {
  const { t } = useI18n();
  const [value, setValue] = useState<"project">("project");

  return (
    <div className="w-full h-screen bg-[#0b1220] text-white flex items-center justify-center px-6">
      <div className="w-full max-w-xl bg-[#111827] border border-[#1f2937] rounded-2xl p-6 space-y-5">
        <h1 className="text-xl font-bold">{t("track.title")}</h1>
        <p className="text-sm text-gray-300">
          {t("track.desc")}
        </p>
        <div className="space-y-3">
          <label className="block border border-[#374151] rounded-lg p-4 cursor-pointer">
            <input
              type="radio"
              name="track"
              checked={value === "project"}
              onChange={() => setValue("project")}
              className="mr-2"
            />
            {t("track.project")}
          </label>
        </div>
        <button
          onClick={() => onSelect(value)}
          className="w-full bg-cyan-600 hover:bg-cyan-500 rounded-lg py-3 font-semibold"
        >
          {t("track.continue")}
        </button>
      </div>
    </div>
  );
}
