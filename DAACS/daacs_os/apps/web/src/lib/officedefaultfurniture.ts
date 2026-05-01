import type { OfficeFurnitureDocument } from "../types/office";
import type { RuntimeOfficeZone } from "./runtimeUi";

type FurnitureSeed = {
  suffix: string;
  type: OfficeFurnitureDocument["type"];
  x: number;
  y: number;
  rotation?: number;
  blocks_path?: boolean;
  variant?: string | null;
  label?: string | null;
};

function buildFurnitureDocument(
  zone: RuntimeOfficeZone,
  seed: FurnitureSeed,
): OfficeFurnitureDocument {
  return {
    id: `${zone.id}-${seed.suffix}`,
    zone_id: zone.id,
    type: seed.type,
    anchor: {
      x: Math.round(zone.left + zone.width * seed.x),
      y: Math.round(zone.top + zone.height * seed.y),
    },
    rotation: seed.rotation ?? 0,
    blocks_path: seed.blocks_path ?? false,
    variant: seed.variant ?? null,
    label: seed.label ?? null,
  };
}

function seedsForPreset(preset: string): FurnitureSeed[] {
  switch (preset) {
    case "ceo":
      return [
        { suffix: "desk", type: "desk", x: 0.56, y: 0.64, blocks_path: true, variant: "ceo" },
        { suffix: "plant-left", type: "plant", x: 0.12, y: 0.16 },
        { suffix: "plant-right", type: "plant", x: 0.88, y: 0.16 },
      ];
    case "meeting":
      return [
        { suffix: "table", type: "meeting", x: 0.55, y: 0.42, blocks_path: true },
        { suffix: "whiteboard", type: "whiteboard", x: 0.84, y: 0.16 },
        { suffix: "desk", type: "desk", x: 0.22, y: 0.62, blocks_path: true },
      ];
    case "design":
      return [
        { suffix: "empty-a", type: "empty", x: 0.72, y: 0.18 },
        { suffix: "empty-b", type: "empty", x: 0.9, y: 0.18 },
      ];
    case "marketing":
      return [
        { suffix: "desk", type: "desk", x: 0.28, y: 0.34, blocks_path: true },
        { suffix: "board", type: "bulletin", x: 0.76, y: 0.22, label: "Launch" },
      ];
    case "hallway":
      return [
        { suffix: "plant-left", type: "plant", x: 0.18, y: 0.28 },
        { suffix: "plant-right", type: "plant", x: 0.82, y: 0.72 },
        { suffix: "vending", type: "vending", x: 0.78, y: 0.52, blocks_path: true },
        { suffix: "board", type: "bulletin", x: 0.22, y: 0.74 },
      ];
    case "engineering":
      return [
        { suffix: "desk-a", type: "desk", x: 0.3, y: 0.34, blocks_path: true },
        { suffix: "desk-b", type: "desk", x: 0.7, y: 0.34, blocks_path: true },
      ];
    case "finance":
      return [
        { suffix: "desk", type: "desk", x: 0.28, y: 0.34, blocks_path: true },
        { suffix: "safe", type: "safe", x: 0.76, y: 0.72, blocks_path: true },
      ];
    case "lobby":
      return [
        { suffix: "plant-left", type: "plant", x: 0.18, y: 0.76 },
        { suffix: "plant-right", type: "plant", x: 0.82, y: 0.76 },
      ];
    case "server":
      return [
        { suffix: "desk", type: "desk", x: 0.28, y: 0.3, blocks_path: true },
        { suffix: "server-a", type: "server", x: 0.7, y: 0.62, blocks_path: true },
        { suffix: "server-b", type: "server", x: 0.82, y: 0.62, blocks_path: true },
        { suffix: "server-c", type: "server", x: 0.94, y: 0.62, blocks_path: true },
      ];
    default:
      return [
        { suffix: "desk", type: "desk", x: 0.28, y: 0.34, blocks_path: true },
        { suffix: "plant", type: "plant", x: 0.8, y: 0.76 },
      ];
  }
}

export function buildDefaultOfficeFurniture(
  officeZones: RuntimeOfficeZone[],
): OfficeFurnitureDocument[] {
  return officeZones.flatMap((zone) =>
    seedsForPreset(zone.preset).map((seed) => buildFurnitureDocument(zone, seed)),
  );
}
