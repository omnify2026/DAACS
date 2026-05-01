import { buildProjectOfficeProfile } from "./officeProfile";
import {
  buildDefaultGlobalOfficeState,
  deriveGlobalOfficeProfileFromProject,
  mergeOfficeProfileWithGlobalDefaults,
  parseGlobalOfficeState,
} from "./officeGlobalState";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const projectOffice = buildProjectOfficeProfile("project-global-test");
projectOffice.theme.accent_color = "#22D3EE";
projectOffice.metadata.source = "default";

const globalProfile = deriveGlobalOfficeProfileFromProject({
  ...projectOffice,
  name: "Shared Default Office",
  desks: [
    {
      id: "desk-1",
      zone_id: "lobby",
      label: "Lobby Desk",
      anchor: { x: 520, y: 690 },
      agent_id: null,
    },
  ],
});

const globalState = parseGlobalOfficeState({
  settings: {
    default_office_profile_id: globalProfile.office_profile_id,
    theme: {
      shell_color: "#050816",
    },
  },
  office_profiles: [globalProfile],
  shared_agents: [],
});

assert(
  globalState.settings.default_office_profile_id === globalProfile.office_profile_id,
  "global office state should preserve default office profile ids",
);

const merged = mergeOfficeProfileWithGlobalDefaults(projectOffice, globalState);
assert(
  merged.theme.shell_color === "#050816",
  "global theme should overlay the project office theme",
);
assert(
  merged.desks.length === 1 && merged.desks[0].id === "desk-1",
  "default global office profile should bootstrap desks for default project offices",
);

const customizedOffice = buildProjectOfficeProfile("project-customized");
customizedOffice.metadata.source = "customized";
customizedOffice.desks = [
  {
    id: "custom-desk",
    zone_id: "rd_lab",
    label: "Custom Desk",
    anchor: { x: 900, y: 400 },
    agent_id: null,
  },
];

const customizedMerged = mergeOfficeProfileWithGlobalDefaults(customizedOffice, globalState);
assert(
  customizedMerged.desks[0].id === "custom-desk",
  "customized project offices should keep their own desks instead of being overwritten",
);

const fallbackState = buildDefaultGlobalOfficeState();
assert(
  fallbackState.shared_agents.length === 0 && fallbackState.office_profiles.length === 0,
  "default global office state should start with no shared agents or global office profiles",
);
assert(
  fallbackState.office_templates.length >= 3,
  "default global office state should ship with built-in office templates",
);
assert(
  fallbackState.settings.office_template_ids.length === fallbackState.office_templates.length,
  "default template ids should mirror built-in office templates",
);

const templateState = parseGlobalOfficeState({
  settings: {
    default_template_id: fallbackState.office_templates[0]?.template_id,
  },
  office_templates: fallbackState.office_templates,
  office_profiles: [],
  shared_agents: [],
});
const runtimeOffice = buildProjectOfficeProfile("project-template-bootstrap");
const templateMerged = mergeOfficeProfileWithGlobalDefaults(runtimeOffice, templateState);
assert(
  templateMerged.furniture.length === fallbackState.office_templates[0].furniture.length,
  "default template should bootstrap furniture for runtime-derived offices",
);

console.log("officeGlobalState tests passed");
