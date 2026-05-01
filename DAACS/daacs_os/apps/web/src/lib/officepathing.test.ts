import { advancePath, calculatePath, pathDuration } from "./officePathing";
import { buildDefaultOfficeZones } from "./runtimeUi";
import { buildProjectOfficeProfile } from "./officeProfile";
import type { RuntimeOfficeZone } from "./runtimeUi";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const zones = buildDefaultOfficeZones();
const officeProfile = buildProjectOfficeProfile("project-a");
const hallway = zones.find((zone) => zone.id === "hallway");
assert(hallway, "default office should include hallway zone");

const crossOfficePath = calculatePath(
  { x: 180, y: 120 },
  { x: 1020, y: 660 },
  zones,
  officeProfile.routing,
);
assert(crossOfficePath.length > 3, "cross-office movement should produce routed waypoints");
assert(
  crossOfficePath.some(
    (point) =>
      point.x >= hallway.left &&
      point.x <= hallway.left + hallway.width &&
      point.y >= hallway.top &&
      point.y <= hallway.top + hallway.height,
  ),
  "A* routing should prefer hallway cells for cross-zone movement",
);

const singleZone: RuntimeOfficeZone[] = [
  {
    id: "single_zone",
    label: "Single Zone",
    accentColor: "#64748B",
    row: 0,
    col: 0,
    rowSpan: 1,
    colSpan: 1,
    preset: "generic",
    labelPosition: "top-left",
    left: 0,
    top: 0,
    width: 120,
    height: 72,
    center: { x: 60, y: 36 },
  },
];

const blockedPath = calculatePath(
  { x: 12, y: 36 },
  { x: 108, y: 36 },
  singleZone,
  {
    ...officeProfile.routing,
    cell_size: 24,
    blocked_cells: [{ x: 2, y: 1 }],
  },
);
assert(
  !blockedPath.some((point) => point.x === 60 && point.y === 36),
  "A* routing should avoid blocked cells from the office JSON profile",
);

const stagedPath = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
];
const halfDuration = pathDuration(stagedPath) / 2;
const midWalk = advancePath(stagedPath, halfDuration);
assert(!midWalk.completed, "advancePath should keep long paths in progress at half duration");
assert(
  midWalk.position.x === 100 && midWalk.position.y === 0,
  "advancePath should land on the segment boundary at half duration",
);
assert(
  midWalk.remainingPath.length >= 2 &&
    midWalk.remainingPath[0].x === 100 &&
    midWalk.remainingPath[0].y === 0 &&
    midWalk.remainingPath[midWalk.remainingPath.length - 1].x === 100 &&
    midWalk.remainingPath[midWalk.remainingPath.length - 1].y === 100,
  "advancePath should expose the remaining path from the current position",
);

const completedWalk = advancePath(stagedPath, pathDuration(stagedPath) + 10);
assert(completedWalk.completed, "advancePath should mark completed walks");
assert(
  completedWalk.position.x === 100 && completedWalk.position.y === 100,
  "advancePath should end at the destination once elapsed exceeds duration",
);

console.log("officePathing tests passed");
