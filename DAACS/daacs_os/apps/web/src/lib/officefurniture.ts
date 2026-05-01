import type { Point } from "../types/agent";
import type {
  OfficeFurnitureDocument,
  OfficeFurnitureType,
  OfficeRoutingCell,
  OfficeRoutingDocument,
} from "../types/office";
import type { RuntimeOfficeZone } from "./runtimeUi";

export type OfficeFurniturePatch = Partial<
  Pick<
    OfficeFurnitureDocument,
    "zone_id" | "type" | "variant" | "rotation" | "blocks_path" | "label"
  >
> & {
  anchor?: Point;
};

type FurnitureDefinition = {
  label_key: string;
  footprint: {
    width_cells: number;
    height_cells: number;
  };
  blocks_path: boolean;
};

export const OFFICE_FURNITURE_LIBRARY: Record<OfficeFurnitureType, FurnitureDefinition> = {
  desk: {
    label_key: "officeCustomization.furnitureType.desk",
    footprint: { width_cells: 2, height_cells: 1 },
    blocks_path: true,
  },
  server: {
    label_key: "officeCustomization.furnitureType.server",
    footprint: { width_cells: 1, height_cells: 2 },
    blocks_path: true,
  },
  meeting: {
    label_key: "officeCustomization.furnitureType.meeting",
    footprint: { width_cells: 3, height_cells: 2 },
    blocks_path: true,
  },
  plant: {
    label_key: "officeCustomization.furnitureType.plant",
    footprint: { width_cells: 1, height_cells: 1 },
    blocks_path: true,
  },
  whiteboard: {
    label_key: "officeCustomization.furnitureType.whiteboard",
    footprint: { width_cells: 2, height_cells: 1 },
    blocks_path: false,
  },
  vending: {
    label_key: "officeCustomization.furnitureType.vending",
    footprint: { width_cells: 1, height_cells: 2 },
    blocks_path: true,
  },
  safe: {
    label_key: "officeCustomization.furnitureType.safe",
    footprint: { width_cells: 1, height_cells: 1 },
    blocks_path: true,
  },
  bulletin: {
    label_key: "officeCustomization.furnitureType.bulletin",
    footprint: { width_cells: 2, height_cells: 1 },
    blocks_path: false,
  },
  empty: {
    label_key: "officeCustomization.furnitureType.empty",
    footprint: { width_cells: 2, height_cells: 1 },
    blocks_path: false,
  },
};

export function isOfficeFurnitureType(value: string): value is OfficeFurnitureType {
  return value in OFFICE_FURNITURE_LIBRARY;
}

function definitionForFurniture(furniture: OfficeFurnitureDocument): FurnitureDefinition {
  return isOfficeFurnitureType(furniture.type)
    ? OFFICE_FURNITURE_LIBRARY[furniture.type]
    : OFFICE_FURNITURE_LIBRARY.plant;
}

export function createOfficeFurnitureDocument(
  zone: RuntimeOfficeZone,
  type: OfficeFurnitureType,
): OfficeFurnitureDocument {
  const now = Date.now();
  const definition = OFFICE_FURNITURE_LIBRARY[type];
  return {
    id: `furniture-${type}-${now}`,
    zone_id: zone.id,
    type,
    anchor: {
      x: Math.round(zone.center.x),
      y: Math.round(zone.center.y),
    },
    variant: null,
    rotation: 0,
    blocks_path: definition.blocks_path,
    label: null,
  };
}

export function clampFurnitureAnchorToZone(
  anchor: Point,
  zone: RuntimeOfficeZone,
): Point {
  return {
    x: Math.max(zone.left + 24, Math.min(zone.left + zone.width - 24, Math.round(anchor.x))),
    y: Math.max(zone.top + 24, Math.min(zone.top + zone.height - 24, Math.round(anchor.y))),
  };
}

export function upsertOfficeFurniture(
  furniture: OfficeFurnitureDocument[],
  nextFurniture: OfficeFurnitureDocument,
): OfficeFurnitureDocument[] {
  return [
    ...furniture.filter((entry) => entry.id !== nextFurniture.id),
    nextFurniture,
  ];
}

export function removeOfficeFurniture(
  furniture: OfficeFurnitureDocument[],
  furnitureId: string,
): OfficeFurnitureDocument[] {
  return furniture.filter((entry) => entry.id !== furnitureId);
}

function normalizeRotation(rotation?: number): number {
  if (typeof rotation !== "number" || !Number.isFinite(rotation)) return 0;
  const rounded = Math.round(rotation / 15) * 15;
  const modulo = ((rounded % 360) + 360) % 360;
  return modulo;
}

function effectiveFootprint(
  furniture: OfficeFurnitureDocument,
): FurnitureDefinition["footprint"] {
  const definition = definitionForFurniture(furniture);
  const rotation = normalizeRotation(furniture.rotation);
  const quarterTurn = rotation === 90 || rotation === 270;
  return quarterTurn
    ? {
        width_cells: definition.footprint.height_cells,
        height_cells: definition.footprint.width_cells,
      }
    : definition.footprint;
}

export function buildFurnitureBlockedCells(
  furniture: OfficeFurnitureDocument[],
  routing: OfficeRoutingDocument,
): OfficeRoutingCell[] {
  const cellSize = routing.cell_size;
  const seen = new Set<string>();
  const blocked: OfficeRoutingCell[] = [];

  for (const item of furniture) {
    const definition = definitionForFurniture(item);
    const blocksPath = item.blocks_path ?? definition.blocks_path;
    if (!blocksPath) continue;

    const footprint = effectiveFootprint(item);
    const centerCol = Math.floor(item.anchor.x / cellSize);
    const centerRow = Math.floor(item.anchor.y / cellSize);
    const startCol = centerCol - Math.floor((footprint.width_cells - 1) / 2);
    const startRow = centerRow - Math.floor((footprint.height_cells - 1) / 2);

    for (let dy = 0; dy < footprint.height_cells; dy += 1) {
      for (let dx = 0; dx < footprint.width_cells; dx += 1) {
        const col = startCol + dx;
        const row = startRow + dy;
        const key = `${col}:${row}`;
        if (seen.has(key)) continue;
        seen.add(key);
        blocked.push({ x: col, y: row });
      }
    }
  }

  return blocked;
}

export function buildEffectiveRoutingForFurniture(
  routing: OfficeRoutingDocument,
  furniture: OfficeFurnitureDocument[],
): OfficeRoutingDocument {
  const blockedByFurniture = buildFurnitureBlockedCells(furniture, routing);
  const merged = new Map<string, OfficeRoutingCell>();

  for (const cell of [...routing.blocked_cells, ...blockedByFurniture]) {
    merged.set(`${cell.x}:${cell.y}`, cell);
  }

  return {
    ...routing,
    blocked_cells: [...merged.values()],
  };
}
