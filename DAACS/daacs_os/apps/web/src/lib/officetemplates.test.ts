import { buildProjectOfficeProfile } from "./officeProfile";
import {
  applyOfficeTemplateToProject,
  buildDefaultOfficeTemplates,
  deriveOfficeTemplateFromProject,
} from "./officeTemplates";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const templates = buildDefaultOfficeTemplates();
assert(templates.length >= 3, "default office templates should be seeded");

const template = templates.find((entry) => entry.template_id === "engineering-war-room");
assert(template, "engineering war room template should exist");

const projectOffice = buildProjectOfficeProfile("project-template-test");
projectOffice.agent_assignments = [
  {
    agent_id: "agent-developer",
    zone_id: "rd_lab",
    spawn_point: { x: 920, y: 410 },
  },
];

const applied = applyOfficeTemplateToProject(
  "project-template-test",
  template,
  projectOffice,
);
assert(applied.theme.theme_id === template.theme.theme_id, "template theme should be applied");
assert(applied.furniture.length === template.furniture.length, "template furniture should be copied");
assert(applied.agent_assignments.length === 1, "template application should preserve project agent assignments");

const derived = deriveOfficeTemplateFromProject(projectOffice, "My Office Template", "Saved template");
assert(derived.name === "My Office Template", "derived template should use the provided name");
assert(derived.description === "Saved template", "derived template should use the provided description");

console.log("officeTemplates tests passed");
