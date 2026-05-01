import {
  buildProjectOfficeProfile,
  embedOfficeProfileInOrgGraph,
  parseProjectOfficeProfile,
  serializeProjectOfficeProfile,
} from "./officeProfile";
import type { CompanyRuntime } from "../types/runtime";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const runtime: CompanyRuntime = {
  runtime_id: "runtime-office-1",
  project_id: "project-1",
  company_name: "Orbit Labs",
  org_graph: {
    zones: {
      strategy_hub: {
        label: "Strategy Hub",
        accent_color: "#22C55E",
        row: 0,
        col: 3,
        row_span: 1,
        col_span: 1,
        preset: "meeting",
        label_position: "top-right",
      },
    },
  },
  agent_instance_ids: [],
  meeting_protocol: {},
  approval_graph: {},
  shared_boards: {},
  execution_mode: "assisted",
  owner_ops_state: {},
  created_at: "2026-04-07T00:00:00.000Z",
  updated_at: "2026-04-07T00:00:00.000Z",
};

const profile = buildProjectOfficeProfile("project-1", runtime);
assert(profile.project_id === "project-1", "profile should target the project");
assert(profile.routing.algorithm === "a_star_grid", "routing should default to A*");
assert(
  profile.zones.some((zone) => zone.id === "strategy_hub"),
  "runtime custom zones should be preserved in the office profile",
);

const serialized = serializeProjectOfficeProfile(profile);
const roundtrip = parseProjectOfficeProfile(JSON.parse(serialized), "project-1", runtime);
assert(roundtrip, "serialized office profile should parse");
assert(
  roundtrip.zones.length === profile.zones.length,
  "roundtrip should preserve office zones",
);

const nextOrgGraph = embedOfficeProfileInOrgGraph(runtime.org_graph, profile) as {
  office_profile?: { office_profile_id?: string };
  zones?: Record<string, unknown>;
};
assert(
  nextOrgGraph.office_profile?.office_profile_id === profile.office_profile_id,
  "org graph embedding should include the serialized office profile",
);
assert(
  !!nextOrgGraph.zones?.strategy_hub,
  "org graph embedding should mirror office zones for runtime consumers",
);

console.log("officeProfile tests passed");
