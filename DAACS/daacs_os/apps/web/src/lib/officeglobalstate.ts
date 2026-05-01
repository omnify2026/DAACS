import type { Agent } from "../types/agent";
import type {
  GlobalOfficeProfileDocument,
  GlobalOfficeSettingsDocument,
  GlobalOfficeStateDocument,
  OfficeTemplateDocument,
  OfficeThemeDocument,
  ProjectOfficeProfile,
  SharedAgentProfileDocument,
} from "../types/office";
import { buildDefaultGlobalOfficeSettings } from "./officeProfile";
import { buildDefaultOfficeTemplates } from "./officeTemplates";

const GLOBAL_OFFICE_STATE_VERSION = 1 as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeGlobalOfficeSettings(
  value: unknown,
): GlobalOfficeSettingsDocument {
  const fallback = buildDefaultGlobalOfficeSettings();
  if (!isRecord(value)) return fallback;
  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    settings_id: asString(value.settings_id, fallback.settings_id),
    scope: "global",
    default_office_profile_id:
      typeof value.default_office_profile_id === "string" &&
      value.default_office_profile_id.trim().length > 0
        ? value.default_office_profile_id.trim()
        : null,
    default_template_id:
      typeof value.default_template_id === "string" &&
      value.default_template_id.trim().length > 0
        ? value.default_template_id.trim()
        : null,
    shared_agent_ids: asStringArray(value.shared_agent_ids),
    office_profile_ids: asStringArray(value.office_profile_ids),
    office_template_ids: asStringArray(value.office_template_ids),
    theme: isRecord(value.theme) ? cloneJson(value.theme) : cloneJson(fallback.theme),
    updated_at: asString(value.updated_at, new Date().toISOString()),
  };
}

function normalizeGlobalOfficeProfile(value: unknown): GlobalOfficeProfileDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.office_profile_id !== "string" || value.office_profile_id.trim() === "") {
    return null;
  }
  if (
    !Array.isArray(value.zones) ||
    !Array.isArray(value.desks) ||
    !Array.isArray(value.furniture) ||
    !Array.isArray(value.agent_assignments)
  ) {
    return null;
  }

  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    office_profile_id: value.office_profile_id.trim(),
    scope: "global",
    name: asString(value.name, "Global Office"),
    theme: cloneJson((value.theme ?? {}) as OfficeThemeDocument),
    zones: cloneJson(value.zones),
    desks: cloneJson(value.desks),
    furniture: cloneJson(value.furniture),
    agent_assignments: cloneJson(value.agent_assignments),
    routing: cloneJson(value.routing ?? {}),
    updated_at: asString(value.updated_at, new Date().toISOString()),
  } as GlobalOfficeProfileDocument;
}

function normalizeOfficeTemplate(value: unknown): OfficeTemplateDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.template_id !== "string" || value.template_id.trim() === "") {
    return null;
  }
  if (
    !Array.isArray(value.zones) ||
    !Array.isArray(value.desks) ||
    !Array.isArray(value.furniture)
  ) {
    return null;
  }

  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    template_id: value.template_id.trim(),
    name: asString(value.name, "Office Template"),
    description: asString(value.description, "Reusable office template."),
    category: asString(value.category, "custom"),
    theme: cloneJson((value.theme ?? {}) as OfficeThemeDocument),
    zones: cloneJson(value.zones),
    desks: cloneJson(value.desks),
    furniture: cloneJson(value.furniture),
    routing: cloneJson(value.routing ?? {}),
    updated_at: asString(value.updated_at, new Date().toISOString()),
    system: value.system === true,
  } as OfficeTemplateDocument;
}

function normalizeSharedAgent(value: unknown): SharedAgentProfileDocument | null {
  if (!isRecord(value)) return null;
  if (typeof value.global_agent_id !== "string" || value.global_agent_id.trim() === "") {
    return null;
  }
  if (typeof value.name !== "string" || typeof value.role_label !== "string") {
    return null;
  }
  return {
    global_agent_id: value.global_agent_id.trim(),
    source_agent_id: asString(value.source_agent_id, value.global_agent_id.trim()),
    source_project_id:
      typeof value.source_project_id === "string" && value.source_project_id.trim().length > 0
        ? value.source_project_id.trim()
        : null,
    name: value.name.trim(),
    role_label: value.role_label.trim(),
    prompt: asString(value.prompt, ""),
    summary:
      typeof value.summary === "string" && value.summary.trim().length > 0
        ? value.summary.trim()
        : null,
    capabilities: asStringArray(value.capabilities),
    skill_bundle_refs: asStringArray(value.skill_bundle_refs),
    ui_profile: isRecord(value.ui_profile) ? cloneJson(value.ui_profile) : {},
    operating_profile: isRecord(value.operating_profile)
      ? cloneJson(value.operating_profile)
      : {},
    shared_at: asString(value.shared_at, new Date().toISOString()),
    updated_at: asString(value.updated_at, asString(value.shared_at, new Date().toISOString())),
  };
}

export function buildDefaultGlobalOfficeState(): GlobalOfficeStateDocument {
  const defaultTemplates = buildDefaultOfficeTemplates();
  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    settings: {
      ...buildDefaultGlobalOfficeSettings(),
      office_template_ids: defaultTemplates.map((template) => template.template_id),
    },
    office_profiles: [],
    office_templates: defaultTemplates,
    shared_agents: [],
  };
}

export function parseGlobalOfficeState(value: unknown): GlobalOfficeStateDocument {
  if (!isRecord(value)) return buildDefaultGlobalOfficeState();
  const settings = normalizeGlobalOfficeSettings(value.settings);
  const officeProfiles = Array.isArray(value.office_profiles)
    ? value.office_profiles.flatMap((entry) => {
        const normalized = normalizeGlobalOfficeProfile(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  const officeTemplates = Array.isArray(value.office_templates)
    ? value.office_templates.flatMap((entry) => {
        const normalized = normalizeOfficeTemplate(entry);
        return normalized ? [normalized] : [];
      })
    : buildDefaultOfficeTemplates();
  const sharedAgents = Array.isArray(value.shared_agents)
    ? value.shared_agents.flatMap((entry) => {
        const normalized = normalizeSharedAgent(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    settings: {
      ...settings,
      office_profile_ids:
        settings.office_profile_ids.length > 0
          ? settings.office_profile_ids
          : officeProfiles.map((profile) => profile.office_profile_id),
      office_template_ids:
        settings.office_template_ids.length > 0
          ? settings.office_template_ids
          : officeTemplates.map((template) => template.template_id),
      shared_agent_ids:
        settings.shared_agent_ids.length > 0
          ? settings.shared_agent_ids
          : sharedAgents.map((agent) => agent.global_agent_id),
    },
    office_profiles: officeProfiles,
    office_templates: officeTemplates,
    shared_agents: sharedAgents,
  };
}

export function serializeGlobalOfficeState(state: GlobalOfficeStateDocument): string {
  return JSON.stringify(state, null, 2);
}

export function deriveGlobalOfficeProfileFromProject(
  officeProfile: ProjectOfficeProfile,
  name?: string,
): GlobalOfficeProfileDocument {
  return {
    version: GLOBAL_OFFICE_STATE_VERSION,
    office_profile_id: `global-${officeProfile.office_profile_id}`,
    scope: "global",
    name: name?.trim() || officeProfile.name,
    theme: cloneJson(officeProfile.theme),
    zones: cloneJson(officeProfile.zones),
    desks: cloneJson(officeProfile.desks),
    furniture: cloneJson(officeProfile.furniture),
    agent_assignments: cloneJson(officeProfile.agent_assignments),
    routing: cloneJson(officeProfile.routing),
    updated_at: new Date().toISOString(),
  };
}

export function mergeOfficeProfileWithGlobalDefaults(
  officeProfile: ProjectOfficeProfile,
  globalState: GlobalOfficeStateDocument | null,
): ProjectOfficeProfile {
  if (!globalState) return officeProfile;
  const globalTheme = globalState.settings.theme ?? {};
  const defaultProfile = globalState.settings.default_office_profile_id
    ? globalState.office_profiles.find(
        (profile) => profile.office_profile_id === globalState.settings.default_office_profile_id,
      ) ?? null
    : null;
  const defaultTemplate = globalState.settings.default_template_id
    ? globalState.office_templates.find(
        (template) => template.template_id === globalState.settings.default_template_id,
      ) ?? null
    : null;
  const bootstrapSource = defaultProfile ?? defaultTemplate;

  const shouldBootstrapFromGlobal =
    bootstrapSource != null &&
    officeProfile.metadata.source !== "customized" &&
    officeProfile.desks.length === 0 &&
    officeProfile.furniture.length === 0 &&
    officeProfile.agent_assignments.length === 0;
  const mergedTheme =
    officeProfile.metadata.source === "customized"
      ? {
          ...bootstrapSource?.theme,
          ...globalTheme,
          ...officeProfile.theme,
        }
      : {
          ...bootstrapSource?.theme,
          ...officeProfile.theme,
          ...globalTheme,
        };

  if (!shouldBootstrapFromGlobal) {
    return {
      ...officeProfile,
      theme: mergedTheme,
    };
  }

  return {
    ...officeProfile,
    name: officeProfile.name || bootstrapSource.name,
    theme: mergedTheme,
    zones:
      officeProfile.zones.length > 0
        ? cloneJson(officeProfile.zones)
        : cloneJson(bootstrapSource.zones),
    desks:
      officeProfile.desks.length > 0
        ? cloneJson(officeProfile.desks)
        : cloneJson(bootstrapSource.desks),
    furniture:
      officeProfile.furniture.length > 0
        ? cloneJson(officeProfile.furniture)
        : cloneJson(bootstrapSource.furniture),
    agent_assignments:
      officeProfile.agent_assignments.length > 0
        ? cloneJson(officeProfile.agent_assignments)
        : cloneJson("agent_assignments" in bootstrapSource ? bootstrapSource.agent_assignments : []),
    routing:
      officeProfile.routing.blocked_cells.length > 0
        ? cloneJson(officeProfile.routing)
        : cloneJson(bootstrapSource.routing),
  };
}

export function createSharedAgentProfile(
  agent: Agent,
  projectId: string | null,
): SharedAgentProfileDocument {
  const now = new Date().toISOString();
  return {
    global_agent_id: agent.instanceId ?? agent.id,
    source_agent_id: agent.id,
    source_project_id: projectId,
    name: agent.name,
    role_label: agent.role,
    prompt: "",
    summary: agent.currentTask ?? null,
    capabilities: [...(agent.capabilities ?? [])],
    skill_bundle_refs: [...(agent.skillBundleRefs ?? [])],
    ui_profile: cloneJson(agent.uiProfile ?? {}) as Record<string, unknown>,
    operating_profile: cloneJson(agent.operatingProfile ?? {}) as Record<string, unknown>,
    shared_at: now,
    updated_at: now,
  };
}
