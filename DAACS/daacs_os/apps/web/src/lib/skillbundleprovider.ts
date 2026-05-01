import type { SkillBundleSummary } from "../types/runtime";
import { isTauri, getSkillBundleSummary as getTauriSkillBundleSummary } from "../services/tauriCli";
import bundledSkillBundleSummary from "./bundledSkillBundleSummary.json";

export type SkillBundleLoadSource = "tauri" | "remote" | "bundled_static" | "empty";

export async function LoadSkillBundleSummary(): Promise<{
  summary: SkillBundleSummary;
  source: SkillBundleLoadSource;
}> {
  if (isTauri()) {
    const summary = await getTauriSkillBundleSummary();
    return { summary, source: "tauri" };
  }
  const remote =
    typeof import.meta.env.VITE_SKILL_BUNDLES_URL === "string"
      ? import.meta.env.VITE_SKILL_BUNDLES_URL.trim()
      : "";
  if (remote !== "") {
    try {
      const res = await fetch(remote, { credentials: "omit" });
      if (res.ok) {
        const data = (await res.json()) as SkillBundleSummary;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          return { summary: data, source: "remote" };
        }
      }
    } catch {
      // Remote summary is optional; fall through to bundled data.
    }
  }
  const summary = bundledSkillBundleSummary as SkillBundleSummary;
  if (summary && typeof summary === "object" && Object.keys(summary).length > 0) {
    return { summary, source: "bundled_static" };
  }
  return { summary: {}, source: "empty" };
}
