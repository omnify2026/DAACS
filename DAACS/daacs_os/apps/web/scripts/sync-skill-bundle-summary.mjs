import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "..");
const yamlPath = path.resolve(webRoot, "../desktop/Resources/skills/agent_bundles.yaml");
const outPath = path.join(webRoot, "src/lib/bundledSkillBundleSummary.json");

const raw = fs.readFileSync(yamlPath, "utf8");
const doc = YAML.parse(raw);
const bundles = doc && typeof doc === "object" && doc.bundles && typeof doc.bundles === "object" ? doc.bundles : {};
const out = {};
for (const [role, cfg] of Object.entries(bundles)) {
  if (!cfg || typeof cfg !== "object") continue;
  const core = Array.isArray(cfg.core_skills) ? cfg.core_skills : [];
  const support = Array.isArray(cfg.support_skills) ? cfg.support_skills : [];
  const description = typeof cfg.description === "string" ? cfg.description : "";
  out[role] = {
    description,
    core_count: core.length,
    support_count: support.length,
    core_skills: core,
    support_skills: support,
  };
}
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
console.log("Wrote", outPath, "keys:", Object.keys(out).length);
