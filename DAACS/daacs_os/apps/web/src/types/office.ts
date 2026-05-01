export type OfficeProfileVersion = 1;

export type OfficeProfileScope = "project" | "global";

export type OfficeLabelPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface OfficeThemeDocument {
  theme_id: string;
  shell_color: string;
  floor_color: string;
  panel_color: string;
  accent_color: string;
}

export interface OfficeZoneDocument {
  id: string;
  label: string;
  accent_color: string;
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  preset: string;
  label_position: OfficeLabelPosition;
}

export interface OfficeDeskDocument {
  id: string;
  zone_id: string;
  label: string;
  anchor: {
    x: number;
    y: number;
  };
  agent_id?: string | null;
}

export type OfficeFurnitureType =
  | "desk"
  | "server"
  | "meeting"
  | "plant"
  | "whiteboard"
  | "vending"
  | "safe"
  | "bulletin"
  | "empty";

export interface OfficeFurnitureDocument {
  id: string;
  zone_id: string;
  type: OfficeFurnitureType | (string & {});
  anchor: {
    x: number;
    y: number;
  };
  variant?: string | null;
  rotation?: number;
  blocks_path?: boolean;
  label?: string | null;
}

export interface OfficeAgentAssignment {
  agent_id: string;
  zone_id: string;
  desk_id?: string | null;
  spawn_point?: {
    x: number;
    y: number;
  } | null;
}

export interface OfficeRoutingCell {
  x: number;
  y: number;
}

export interface OfficeRoutingDocument {
  algorithm: "a_star_grid";
  cell_size: number;
  blocked_cells: OfficeRoutingCell[];
  preferred_zone_costs: Record<string, number>;
}

export interface OfficeProfileMetadata {
  source: "default" | "runtime" | "snapshot" | "customized";
  runtime_id?: string | null;
  furniture_initialized?: boolean;
  updated_at: string;
}

export interface SharedAgentProfileDocument {
  global_agent_id: string;
  source_agent_id: string;
  source_project_id?: string | null;
  name: string;
  role_label: string;
  prompt: string;
  summary?: string | null;
  capabilities: string[];
  skill_bundle_refs: string[];
  ui_profile: Record<string, unknown>;
  operating_profile: Record<string, unknown>;
  shared_at: string;
  updated_at: string;
}

export interface OfficeTemplateDocument {
  version: OfficeProfileVersion;
  template_id: string;
  name: string;
  description: string;
  category: string;
  theme: OfficeThemeDocument;
  zones: OfficeZoneDocument[];
  desks: OfficeDeskDocument[];
  furniture: OfficeFurnitureDocument[];
  routing: OfficeRoutingDocument;
  updated_at: string;
  system?: boolean;
}

export interface ProjectOfficeProfile {
  version: OfficeProfileVersion;
  office_profile_id: string;
  project_id: string;
  scope: "project";
  name: string;
  theme: OfficeThemeDocument;
  zones: OfficeZoneDocument[];
  desks: OfficeDeskDocument[];
  furniture: OfficeFurnitureDocument[];
  agent_assignments: OfficeAgentAssignment[];
  routing: OfficeRoutingDocument;
  metadata: OfficeProfileMetadata;
}

export interface GlobalOfficeProfileDocument {
  version: OfficeProfileVersion;
  office_profile_id: string;
  scope: "global";
  name: string;
  theme: OfficeThemeDocument;
  zones: OfficeZoneDocument[];
  desks: OfficeDeskDocument[];
  furniture: OfficeFurnitureDocument[];
  agent_assignments: OfficeAgentAssignment[];
  routing: OfficeRoutingDocument;
  updated_at: string;
}

export interface GlobalOfficeSettingsDocument {
  version: OfficeProfileVersion;
  settings_id: string;
  scope: "global";
  default_office_profile_id: string | null;
  default_template_id: string | null;
  shared_agent_ids: string[];
  office_profile_ids: string[];
  office_template_ids: string[];
  theme: Partial<OfficeThemeDocument>;
  updated_at: string;
}

export interface GlobalOfficeStateDocument {
  version: OfficeProfileVersion;
  settings: GlobalOfficeSettingsDocument;
  office_profiles: GlobalOfficeProfileDocument[];
  office_templates: OfficeTemplateDocument[];
  shared_agents: SharedAgentProfileDocument[];
}
