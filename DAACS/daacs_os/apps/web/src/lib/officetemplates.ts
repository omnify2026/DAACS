import type {
  OfficeFurnitureDocument,
  OfficeTemplateDocument,
  ProjectOfficeProfile,
} from "../types/office";
import { buildProjectOfficeProfile } from "./officeProfile";
import { buildOfficeZonesForProfile } from "./officeCustomization";
import { buildDefaultOfficeFurniture } from "./officeDefaultFurniture";

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function furnitureTemplateKey(furniture: OfficeFurnitureDocument): string {
  return `${furniture.zone_id}:${furniture.type}`;
}

function mergeTemplateFurniture(
  projectId: string,
  currentOffice: ProjectOfficeProfile,
  templateFurniture: OfficeFurnitureDocument[],
  templateZones: ProjectOfficeProfile["zones"],
): OfficeFurnitureDocument[] {
  const templateProfile = {
    ...currentOffice,
    project_id: projectId,
    zones: cloneJson(templateZones),
    furniture: cloneJson(templateFurniture),
  };
  const defaultFurniture = buildDefaultOfficeFurniture(
    buildOfficeZonesForProfile(projectId, templateProfile),
  );
  const templateKeys = new Set(templateFurniture.map(furnitureTemplateKey));
  const preservedCurrentFurniture = currentOffice.furniture.filter(
    (furniture) => !templateKeys.has(furnitureTemplateKey(furniture)),
  );
  const mergedFurniture = [
    ...preservedCurrentFurniture.map((furniture) => cloneJson(furniture)),
    ...cloneJson(templateFurniture),
  ];
  const mergedKeys = new Set(mergedFurniture.map(furnitureTemplateKey));

  for (const fallbackFurniture of defaultFurniture) {
    const key = furnitureTemplateKey(fallbackFurniture);
    if (mergedKeys.has(key)) continue;
    mergedFurniture.push(fallbackFurniture);
    mergedKeys.add(key);
  }

  return mergedFurniture;
}

function buildTemplateFurniture(
  templateId: string,
): Record<string, OfficeFurnitureDocument[]> {
  const byTemplate: Record<string, OfficeFurnitureDocument[]> = {
    "startup-studio": [
      {
        id: `${templateId}-meeting-table`,
        zone_id: "meeting_room",
        type: "meeting",
        anchor: { x: 600, y: 150 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null,
      },
      {
        id: `${templateId}-idea-board`,
        zone_id: "design_studio",
        type: "whiteboard",
        anchor: { x: 1020, y: 110 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Ideas",
      },
      {
        id: `${templateId}-marketing-board`,
        zone_id: "marketing_studio",
        type: "bulletin",
        anchor: { x: 140, y: 370 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Launch",
      },
      {
        id: `${templateId}-lobby-plant`,
        zone_id: "lobby",
        type: "plant",
        anchor: { x: 540, y: 690 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null,
      },
    ],
    "engineering-war-room": [
      {
        id: `${templateId}-war-table`,
        zone_id: "meeting_room",
        type: "meeting",
        anchor: { x: 600, y: 150 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: "Ship Room",
      },
      {
        id: `${templateId}-rd-desk-a`,
        zone_id: "rd_lab",
        type: "desk",
        anchor: { x: 920, y: 380 },
        rotation: 0,
        blocks_path: true,
        variant: "standard",
        label: null,
      },
      {
        id: `${templateId}-rd-desk-b`,
        zone_id: "rd_lab",
        type: "desk",
        anchor: { x: 1040, y: 380 },
        rotation: 0,
        blocks_path: true,
        variant: "corner",
        label: null,
      },
      {
        id: `${templateId}-server-a`,
        zone_id: "server_farm",
        type: "server",
        anchor: { x: 1040, y: 660 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null,
      },
      {
        id: `${templateId}-server-b`,
        zone_id: "server_farm",
        type: "server",
        anchor: { x: 1100, y: 660 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null,
      },
    ],
    "content-agency": [
      {
        id: `${templateId}-content-wall`,
        zone_id: "marketing_studio",
        type: "bulletin",
        anchor: { x: 180, y: 330 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Campaign Wall",
      },
      {
        id: `${templateId}-design-board`,
        zone_id: "design_studio",
        type: "whiteboard",
        anchor: { x: 1040, y: 100 },
        rotation: 0,
        blocks_path: false,
        variant: null,
        label: "Creative Review",
      },
      {
        id: `${templateId}-studio-desk`,
        zone_id: "design_studio",
        type: "desk",
        anchor: { x: 920, y: 180 },
        rotation: 0,
        blocks_path: true,
        variant: "standard",
        label: null,
      },
      {
        id: `${templateId}-snack-vending`,
        zone_id: "hallway",
        type: "vending",
        anchor: { x: 690, y: 390 },
        rotation: 0,
        blocks_path: true,
        variant: null,
        label: null,
      },
    ],
  };

  return byTemplate;
}

function templateFromBase(
  templateId: string,
  name: string,
  description: string,
  category: string,
  overrides: (base: ProjectOfficeProfile) => ProjectOfficeProfile,
): OfficeTemplateDocument {
  const base = buildProjectOfficeProfile(`template-${templateId}`);
  const customized = overrides(base);
  return {
    version: 1,
    template_id: templateId,
    name,
    description,
    category,
    theme: cloneJson(customized.theme),
    zones: cloneJson(customized.zones),
    desks: cloneJson(customized.desks),
    furniture: cloneJson(customized.furniture),
    routing: cloneJson(customized.routing),
    updated_at: new Date().toISOString(),
    system: true,
  };
}

export function buildDefaultOfficeTemplates(): OfficeTemplateDocument[] {
  const furniture = buildTemplateFurniture("template");

  return [
    templateFromBase(
      "startup-studio",
      "Startup Studio",
      "Balanced office for product, marketing, and shipping meetings.",
      "startup",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "startup_studio",
          shell_color: "#0B1020",
          floor_color: "#131C2C",
          panel_color: "#1D1733",
          accent_color: "#22D3EE",
        },
        furniture: cloneJson(furniture["startup-studio"]),
      }),
    ),
    templateFromBase(
      "engineering-war-room",
      "Engineering War Room",
      "Code-heavy office layout with more technical space and server presence.",
      "engineering",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "engineering_war_room",
          shell_color: "#08111B",
          floor_color: "#0F172A",
          panel_color: "#142033",
          accent_color: "#38BDF8",
        },
        zones: base.zones.map((zone) =>
          zone.id === "rd_lab"
            ? { ...zone, label: "Engineering War Room", row_span: 2 }
            : zone.id === "server_farm"
              ? { ...zone, label: "Ops Cluster" }
              : zone,
        ),
        furniture: cloneJson(furniture["engineering-war-room"]),
      }),
    ),
    templateFromBase(
      "content-agency",
      "Content Agency",
      "Creative-forward office with campaign boards and content review surfaces.",
      "creative",
      (base) => ({
        ...base,
        theme: {
          ...base.theme,
          theme_id: "content_agency",
          shell_color: "#160D1F",
          floor_color: "#22122B",
          panel_color: "#2B1633",
          accent_color: "#F472B6",
        },
        zones: base.zones.map((zone) =>
          zone.id === "marketing_studio"
            ? { ...zone, label: "Campaign Studio", col_span: 2 }
            : zone.id === "design_studio"
              ? { ...zone, label: "Creative Lab" }
              : zone,
        ),
        furniture: cloneJson(furniture["content-agency"]),
      }),
    ),
  ];
}

export function deriveOfficeTemplateFromProject(
  officeProfile: ProjectOfficeProfile,
  templateName?: string,
  description?: string,
): OfficeTemplateDocument {
  const now = new Date().toISOString();
  const name = templateName?.trim() || `${officeProfile.name} Template`;
  return {
    version: 1,
    template_id: `template-${officeProfile.office_profile_id}`,
    name,
    description: description?.trim() || "Saved from the current office layout.",
    category: "custom",
    theme: cloneJson(officeProfile.theme),
    zones: cloneJson(officeProfile.zones),
    desks: cloneJson(officeProfile.desks),
    furniture: cloneJson(officeProfile.furniture),
    routing: cloneJson(officeProfile.routing),
    updated_at: now,
    system: false,
  };
}

export function applyOfficeTemplateToProject(
  projectId: string,
  template: OfficeTemplateDocument,
  currentOffice: ProjectOfficeProfile,
): ProjectOfficeProfile {
  const mergedFurniture = mergeTemplateFurniture(
    projectId,
    currentOffice,
    template.furniture,
    template.zones,
  );

  return {
    ...currentOffice,
    project_id: projectId,
    name: `${template.name}`,
    theme: cloneJson(template.theme),
    zones: cloneJson(template.zones),
    desks: cloneJson(template.desks),
    furniture: mergedFurniture,
    agent_assignments: cloneJson(currentOffice.agent_assignments),
    routing: cloneJson(template.routing),
    metadata: {
      ...currentOffice.metadata,
      source: "customized",
      furniture_initialized: true,
      updated_at: new Date().toISOString(),
    },
  };
}
