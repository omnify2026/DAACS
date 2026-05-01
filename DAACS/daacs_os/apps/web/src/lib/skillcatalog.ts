import type { SkillMeta } from "../types/runtime";
import skillsMetadataDoc from "../../../desktop/Resources/skills/skills_metadata.json";

type SkillsMetadataRow = {
  id?: string;
  name?: string;
  description?: string;
  skill_md_relative?: string;
};

type SkillsMetadataFile = {
  skills?: SkillsMetadataRow[];
};

let cachedSkillCatalog: SkillMeta[] | null = null;

function normalizeSkillMeta(skill: SkillMeta): SkillMeta | null {
  const id = skill.id?.trim();
  if (!id) return null;
  const displayName = skill.displayName?.trim();
  return {
    id,
    description: skill.description?.trim() ?? "",
    category: skill.category?.trim() || null,
    displayName:
      displayName != null && displayName !== "" && displayName !== id ? displayName : null,
  };
}

function sortSkillCatalog(skills: SkillMeta[]): SkillMeta[] {
  return [...skills].sort((left, right) => left.id.localeCompare(right.id));
}

function buildCatalogFromDesktopMetadata(): SkillMeta[] {
  const rows = (skillsMetadataDoc as SkillsMetadataFile).skills ?? [];
  const built: SkillMeta[] = [];
  for (const row of rows) {
    const id = String(row.id ?? "").trim();
    if (id === "") continue;
    const name = String(row.name ?? "").trim();
    const description = String(row.description ?? "").trim();
    const meta: SkillMeta = {
      id,
      description,
      category: null,
      displayName: name !== "" && name !== id ? name : null,
    };
    const normalized = normalizeSkillMeta(meta);
    if (normalized != null) built.push(normalized);
  }
  return sortSkillCatalog(built);
}

export function getSkillCatalogBundled(): SkillMeta[] {
  if (cachedSkillCatalog != null) return cachedSkillCatalog;
  cachedSkillCatalog = buildCatalogFromDesktopMetadata();
  return cachedSkillCatalog;
}

export async function loadSkillCatalog(forceRefresh = false): Promise<SkillMeta[]> {
  if (forceRefresh) cachedSkillCatalog = null;
  return getSkillCatalogBundled();
}
