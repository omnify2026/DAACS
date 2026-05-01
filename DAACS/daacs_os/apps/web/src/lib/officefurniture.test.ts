import { buildDefaultOfficeZones } from "./runtimeUi";
import { buildProjectOfficeProfile } from "./officeProfile";
import {
  buildEffectiveRoutingForFurniture,
  createOfficeFurnitureDocument,
} from "./officeFurniture";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const officeProfile = buildProjectOfficeProfile("project-furniture-test");
const rdLab = buildDefaultOfficeZones().find((zone) => zone.id === "rd_lab");
if (!rdLab) {
  throw new Error("rd_lab zone should exist");
}

const desk = createOfficeFurnitureDocument(rdLab, "desk");
const routing = buildEffectiveRoutingForFurniture(officeProfile.routing, [desk]);

assert(
  routing.blocked_cells.length > officeProfile.routing.blocked_cells.length,
  "furniture should contribute blocked cells to office routing",
);

console.log("officeFurniture tests passed");
