import type { OfficeRoutingDocument } from "../types/office";
import type { Point } from "../types/agent";
import type { RuntimeOfficeZone } from "./runtimeUi";
import { buildDefaultOfficeZones } from "./runtimeUi";

type GridNode = {
  col: number;
  row: number;
};

const DEFAULT_CELL_SIZE = 24;
const PATH_WALK_SPEED_PX_PER_SECOND = 200;
const DEFAULT_ZONE_COSTS: OfficeRoutingDocument["preferred_zone_costs"] = {
  hallway: 0.8,
  lobby: 0.9,
  meeting: 1.05,
  ceo: 1.2,
  design: 1.25,
  marketing: 1.25,
  engineering: 1.3,
  finance: 1.3,
  server: 1.3,
  generic: 1.35,
};

function dedup(path: Point[]): Point[] {
  return path.filter((point, index) => {
    if (index === 0) return true;
    const previous = path[index - 1];
    return Math.abs(point.x - previous.x) > 3 || Math.abs(point.y - previous.y) > 3;
  });
}

function distanceBetween(left: Point, right: Point): number {
  const dx = right.x - left.x;
  const dy = right.y - left.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function pointInsideZone(point: Point, zone: RuntimeOfficeZone): boolean {
  return (
    point.x >= zone.left &&
    point.x <= zone.left + zone.width &&
    point.y >= zone.top &&
    point.y <= zone.top + zone.height
  );
}

function findZoneForPoint(
  point: Point,
  officeZones: RuntimeOfficeZone[],
): RuntimeOfficeZone | null {
  const containingZone = officeZones.find((zone) => pointInsideZone(point, zone));
  if (containingZone) return containingZone;
  if (officeZones.length === 0) return null;

  return officeZones.reduce((closest, candidate) => {
    const closestDistance = Math.hypot(point.x - closest.center.x, point.y - closest.center.y);
    const candidateDistance = Math.hypot(point.x - candidate.center.x, point.y - candidate.center.y);
    return candidateDistance < closestDistance ? candidate : closest;
  });
}

function nodeKey(node: GridNode): string {
  return `${node.col}:${node.row}`;
}

function gridCenter(node: GridNode, cellSize: number): Point {
  return {
    x: Math.round(node.col * cellSize + cellSize / 2),
    y: Math.round(node.row * cellSize + cellSize / 2),
  };
}

function clampNode(node: GridNode, columns: number, rows: number): GridNode {
  return {
    col: Math.max(0, Math.min(columns - 1, node.col)),
    row: Math.max(0, Math.min(rows - 1, node.row)),
  };
}

function pointToNode(
  point: Point,
  cellSize: number,
  columns: number,
  rows: number,
): GridNode {
  return clampNode(
    {
      col: Math.floor(point.x / cellSize),
      row: Math.floor(point.y / cellSize),
    },
    columns,
    rows,
  );
}

function boundsForZones(officeZones: RuntimeOfficeZone[]): { width: number; height: number } {
  const right = Math.max(...officeZones.map((zone) => zone.left + zone.width), 1200);
  const bottom = Math.max(...officeZones.map((zone) => zone.top + zone.height), 800);
  return {
    width: Math.round(right),
    height: Math.round(bottom),
  };
}

function zoneCost(
  point: Point,
  officeZones: RuntimeOfficeZone[],
  routing: OfficeRoutingDocument,
): number {
  const zone = findZoneForPoint(point, officeZones);
  if (!zone) return Number.POSITIVE_INFINITY;
  return (
    routing.preferred_zone_costs[zone.id] ??
    routing.preferred_zone_costs[zone.preset] ??
    routing.preferred_zone_costs.generic ??
    DEFAULT_ZONE_COSTS.generic
  );
}

function heuristic(left: GridNode, right: GridNode): number {
  return Math.abs(left.col - right.col) + Math.abs(left.row - right.row);
}

function stepDistance(current: GridNode, next: GridNode, cellSize: number): number {
  return current.col !== next.col && current.row !== next.row
    ? cellSize * Math.SQRT2
    : cellSize;
}

function reconstructPath(
  cameFrom: Map<string, GridNode>,
  current: GridNode,
): GridNode[] {
  const path: GridNode[] = [current];
  let cursor = current;

  while (cameFrom.has(nodeKey(cursor))) {
    cursor = cameFrom.get(nodeKey(cursor))!;
    path.unshift(cursor);
  }

  return path;
}

function compressNodes(nodes: GridNode[]): GridNode[] {
  if (nodes.length <= 2) return nodes;
  const compressed: GridNode[] = [nodes[0]];

  for (let index = 1; index < nodes.length - 1; index += 1) {
    const previous = compressed[compressed.length - 1];
    const current = nodes[index];
    const next = nodes[index + 1];
    const previousDirection = {
      col: Math.sign(current.col - previous.col),
      row: Math.sign(current.row - previous.row),
    };
    const nextDirection = {
      col: Math.sign(next.col - current.col),
      row: Math.sign(next.row - current.row),
    };
    if (
      previousDirection.col !== nextDirection.col ||
      previousDirection.row !== nextDirection.row
    ) {
      compressed.push(current);
    }
  }

  compressed.push(nodes[nodes.length - 1]);
  return compressed;
}

function normalizeRouting(routing?: OfficeRoutingDocument | null): OfficeRoutingDocument {
  return {
    algorithm: "a_star_grid",
    cell_size:
      typeof routing?.cell_size === "number" && routing.cell_size > 0
        ? Math.round(routing.cell_size)
        : DEFAULT_CELL_SIZE,
    blocked_cells: Array.isArray(routing?.blocked_cells) ? routing.blocked_cells : [],
    preferred_zone_costs: {
      ...DEFAULT_ZONE_COSTS,
      ...(routing?.preferred_zone_costs ?? {}),
    },
  };
}

function blockedCellSet(routing: OfficeRoutingDocument): Set<string> {
  return new Set(
    routing.blocked_cells.map((cell) => `${Math.round(cell.x)}:${Math.round(cell.y)}`),
  );
}

function findAStarPath(
  start: Point,
  goal: Point,
  officeZones: RuntimeOfficeZone[],
  routing: OfficeRoutingDocument,
): Point[] {
  const { width, height } = boundsForZones(officeZones);
  const columns = Math.max(1, Math.ceil(width / routing.cell_size));
  const rows = Math.max(1, Math.ceil(height / routing.cell_size));
  const blocked = blockedCellSet(routing);
  const startNode = pointToNode(start, routing.cell_size, columns, rows);
  const goalNode = pointToNode(goal, routing.cell_size, columns, rows);
  const startKey = nodeKey(startNode);
  const goalKey = nodeKey(goalNode);

  const open: GridNode[] = [startNode];
  const openKeys = new Set([startKey]);
  const cameFrom = new Map<string, GridNode>();
  const gScore = new Map<string, number>([[startKey, 0]]);
  const fScore = new Map<string, number>([[startKey, heuristic(startNode, goalNode)]]);

  while (open.length > 0) {
    let currentIndex = 0;
    for (let index = 1; index < open.length; index += 1) {
      const candidate = open[index];
      const current = open[currentIndex];
      if ((fScore.get(nodeKey(candidate)) ?? Number.POSITIVE_INFINITY) <
        (fScore.get(nodeKey(current)) ?? Number.POSITIVE_INFINITY)) {
        currentIndex = index;
      }
    }

    const current = open[currentIndex];
    const currentKey = nodeKey(current);
    if (currentKey === goalKey) {
      const nodes = compressNodes(reconstructPath(cameFrom, current));
      return nodes.map((node) => gridCenter(node, routing.cell_size));
    }

    open.splice(currentIndex, 1);
    openKeys.delete(currentKey);

    const neighbors: GridNode[] = [
      { col: current.col + 1, row: current.row },
      { col: current.col - 1, row: current.row },
      { col: current.col, row: current.row + 1 },
      { col: current.col, row: current.row - 1 },
    ].filter(
      (node) =>
        node.col >= 0 &&
        node.row >= 0 &&
        node.col < columns &&
        node.row < rows,
    );

    for (const neighbor of neighbors) {
      const neighborKey = nodeKey(neighbor);
      if (blocked.has(neighborKey) && neighborKey !== goalKey && neighborKey !== startKey) {
        continue;
      }

      const neighborCenter = gridCenter(neighbor, routing.cell_size);
      const movementCost = zoneCost(neighborCenter, officeZones, routing);
      if (!Number.isFinite(movementCost)) continue;

      const tentativeScore =
        (gScore.get(currentKey) ?? Number.POSITIVE_INFINITY) +
        stepDistance(current, neighbor, routing.cell_size) * movementCost;

      if (tentativeScore >= (gScore.get(neighborKey) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.set(neighborKey, current);
      gScore.set(neighborKey, tentativeScore);
      fScore.set(neighborKey, tentativeScore + heuristic(neighbor, goalNode));
      if (!openKeys.has(neighborKey)) {
        open.push(neighbor);
        openKeys.add(neighborKey);
      }
    }
  }

  return [];
}

export function calculatePath(
  from: Point,
  to: Point,
  officeZones: RuntimeOfficeZone[] = buildDefaultOfficeZones(),
  routing?: OfficeRoutingDocument | null,
): Point[] {
  if (officeZones.length === 0) return dedup([from, to]);

  const resolvedRouting = normalizeRouting(routing);
  const waypoints = findAStarPath(from, to, officeZones, resolvedRouting);
  if (waypoints.length === 0) return dedup([from, to]);

  const points: Point[] = [from];
  for (const point of waypoints) {
    const previous = points[points.length - 1];
    if (Math.abs(previous.x - point.x) <= 3 && Math.abs(previous.y - point.y) <= 3) {
      continue;
    }
    points.push(point);
  }
  points.push(to);
  return dedup(points);
}

export function pathDuration(path: Point[]): number {
  if (path.length < 2) return 0;
  let distance = 0;
  for (let index = 1; index < path.length; index += 1) {
    distance += distanceBetween(path[index - 1], path[index]);
  }
  return (distance / PATH_WALK_SPEED_PX_PER_SECOND) * 1000;
}

export function advancePath(
  path: Point[],
  elapsedMs: number,
): {
  position: Point;
  remainingPath: Point[];
  completed: boolean;
} {
  if (path.length === 0) {
    return {
      position: { x: 0, y: 0 },
      remainingPath: [],
      completed: true,
    };
  }
  if (path.length === 1) {
    return {
      position: path[0],
      remainingPath: [path[0]],
      completed: true,
    };
  }

  const remainingDistance = Math.max(
    0,
    (elapsedMs / 1000) * PATH_WALK_SPEED_PX_PER_SECOND,
  );
  let traveled = remainingDistance;

  for (let index = 1; index < path.length; index += 1) {
    const previous = path[index - 1];
    const current = path[index];
    const segmentDistance = distanceBetween(previous, current);
    if (segmentDistance <= 0) {
      continue;
    }
    if (traveled >= segmentDistance) {
      traveled -= segmentDistance;
      continue;
    }

    const ratio = traveled / segmentDistance;
    const position = {
      x: Math.round(previous.x + (current.x - previous.x) * ratio),
      y: Math.round(previous.y + (current.y - previous.y) * ratio),
    };
    return {
      position,
      remainingPath: dedup([position, ...path.slice(index)]),
      completed: false,
    };
  }

  const destination = path[path.length - 1];
  return {
    position: destination,
    remainingPath: [destination],
    completed: true,
  };
}
