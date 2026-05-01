import { useOfficeStore } from "../../stores/officeStore";
import { useWorkflowStore } from "../../stores/workflowStore";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { AgentSprite } from "./AgentSprite";
import { HUD } from "./HUD";
import { CollaborationVisitLayer, FloatingParticles, ZoneLabel, FileTransferLayer } from "./Effects";
import { GiftBoxArrival } from "./GiftBoxArrival";
import { AgentFocusView } from "./AgentFocusView";
import { ExecutionOverlay } from "./ExecutionOverlay";
import { getAgentMeta, type Point } from "../../types/agent";
import { useI18n } from "../../i18n";
import {
  Desk,
  EmptySlot,
  MeetingTable,
  Plant,
  SafeBox,
  ServerRack,
  BulletinBoard,
  VendingMachine,
  Whiteboard,
} from "./Furniture";
import { findOfficeZoneForPoint, type RuntimeOfficeZone } from "../../lib/runtimeUi";
import { loadAgentsMetadataDocument } from "../../lib/agentsMetadata";
import { hydrateCharacterVisualsFromTauri } from "../../lib/characterVisuals";
import type { OfficeFurnitureDocument, OfficeFurnitureType } from "../../types/office";
import { clampFurnitureAnchorToZone } from "../../lib/officeFurniture";
import { isTauri } from "../../services/tauriCli";

const MIN_CANVAS_SCALE = 0.7;
const MAX_CANVAS_SCALE = 1.45;

function hexToRgba(color: string | undefined, alpha: number, fallback: string): string {
  if (!color) return fallback;
  const normalized = color.trim();
  const hex = normalized.startsWith("#") ? normalized.slice(1) : normalized;
  if (!(hex.length === 3 || hex.length === 6)) return fallback;
  const expanded =
    hex.length === 3 ? hex.split("").map((char) => `${char}${char}`).join("") : hex;
  const value = Number.parseInt(expanded, 16);
  if (Number.isNaN(value)) return fallback;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function zoneShellClass(zone: RuntimeOfficeZone, officeZones: RuntimeOfficeZone[]): string {
  const maxRow = Math.max(...officeZones.map((candidate) => candidate.row + candidate.rowSpan));
  const maxCol = Math.max(...officeZones.map((candidate) => candidate.col + candidate.colSpan));
  const classes = ["absolute", "border"];

  if (zone.row === 0 && zone.col === 0) classes.push("rounded-tl-[24px]");
  if (zone.row === 0 && zone.col + zone.colSpan === maxCol) classes.push("rounded-tr-[24px]");
  if (zone.row + zone.rowSpan === maxRow && zone.col === 0) classes.push("rounded-bl-[24px]");
  if (zone.row + zone.rowSpan === maxRow && zone.col + zone.colSpan === maxCol) {
    classes.push("rounded-br-[24px]");
  }

  return classes.join(" ");
}

function zoneBackground(zone: RuntimeOfficeZone, floorColor: string): CSSProperties {
  if (zone.preset === "hallway" || zone.preset === "lobby") {
    return {
      backgroundColor: hexToRgba(floorColor, 0.22, "rgba(255,255,255,0.02)"),
    };
  }

  return {
    background: `linear-gradient(180deg, ${hexToRgba(zone.accentColor, 0.16, "rgba(124,58,237,0.16)")} 0%, ${hexToRgba(zone.accentColor, 0.08, "rgba(124,58,237,0.08)")} 100%)`,
  };
}

function renderZoneFurniture(
  zone: RuntimeOfficeZone,
  t: (key: string) => string,
  options?: { hidden?: boolean },
) {
  if (options?.hidden) {
    return null;
  }

  if (zone.preset === "hallway") {
    return (
      <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-['Press_Start_2P'] text-[12px] text-white/[0.04] uppercase tracking-[0.3em]">
        DAACS
      </div>
    );
  }

  if (zone.preset === "lobby") {
    return (
      <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2">
        <div className="w-24 h-3 bg-[#16213E] rounded-full border border-[#2A2A4A] shadow-inner relative overflow-hidden">
          <div
            className="absolute inset-0 bg-gradient-to-r from-transparent via-[#7C3AED]/20 to-transparent animate-[shimmer_3s_linear_infinite]"
            style={{ backgroundSize: "200% 100%" }}
          />
        </div>
        <div className="text-center mt-1">
          <span className="font-['Press_Start_2P'] text-[7px] text-gray-500/40 uppercase tracking-widest">
            {t("office.mainEntrance")}
          </span>
        </div>
      </div>
    );
  }

  return null;
}

function renderPlacedFurniture(
  furniture: OfficeFurnitureDocument,
  options?: {
    interactive?: boolean;
    anchor?: Point;
    onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove?: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  },
) {
  const type = (furniture.type in {
    desk: true,
    server: true,
    meeting: true,
    plant: true,
    whiteboard: true,
    vending: true,
    safe: true,
    bulletin: true,
    empty: true,
  } ? furniture.type : "plant") as OfficeFurnitureType;

  let content: ReactNode = null;
  switch (type) {
    case "desk":
      content = <Desk type={furniture.variant === "ceo" ? "ceo" : furniture.variant === "corner" ? "corner" : "standard"} rotate={0} />;
      break;
    case "server":
      content = <ServerRack />;
      break;
    case "meeting":
      content = <MeetingTable />;
      break;
    case "plant":
      content = <Plant />;
      break;
    case "whiteboard":
      content = <Whiteboard />;
      break;
    case "vending":
      content = <VendingMachine />;
      break;
    case "safe":
      content = <SafeBox />;
      break;
    case "bulletin":
      content = <BulletinBoard />;
      break;
    case "empty":
      content = <EmptySlot />;
      break;
    default:
      content = <Plant />;
      break;
  }

  return (
    <div
      key={furniture.id}
      data-furniture-interactive={options?.interactive ? "true" : undefined}
      className={`absolute -translate-x-1/2 -translate-y-1/2 ${
        options?.interactive
          ? "z-[14] pointer-events-auto touch-none cursor-grab active:cursor-grabbing"
          : "pointer-events-none"
      }`}
      style={{
        left: options?.anchor?.x ?? furniture.anchor.x,
        top: options?.anchor?.y ?? furniture.anchor.y,
        rotate: `${furniture.rotation ?? 0}deg`,
      }}
      onPointerDown={options?.onPointerDown}
      onPointerMove={options?.onPointerMove}
      onPointerUp={options?.onPointerUp}
      onPointerCancel={options?.onPointerCancel}
    >
      <div
        className={`flex min-h-[104px] min-w-[104px] items-center justify-center rounded-2xl ${
          options?.interactive
            ? "border border-cyan-300/20 bg-cyan-400/5 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]"
            : ""
        }`}
      >
        {content}
      </div>
    </div>
  );
}

type OfficeSceneProps = {
  onLogout?: () => void | Promise<void>;
  showLogout?: boolean;
};

export function OfficeScene({ onLogout, showLogout }: OfficeSceneProps = {}) {
  const { t } = useI18n();
  const {
    agents,
    officeZones,
    officeProfile,
    editMode,
    editFurnitureMode,
    editFurniturePlacementType,
    selectedAgentId,
    selectAgent,
    pendingTransfers,
    collaborationVisits,
    dismissTransfer,
    arrivingAgentIds,
    moveAgentToPoint,
    updateOfficeFurniture,
    removeOfficeFurniture,
    placeOfficeFurnitureAtPoint,
  } = useOfficeStore();
  const planView = useWorkflowStore((state) => state.planView);
  const [canvasView, setCanvasView] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [dragPreview, setDragPreview] = useState<
    | {
        kind: "agent";
        id: string;
        position: Point;
      }
    | {
        kind: "furniture";
        id: string;
        position: Point;
      }
    | null
  >(null);
  const panStateRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const dragStateRef = useRef<
    | {
        kind: "agent";
        id: string;
        pointerId: number;
        startClientX: number;
        startClientY: number;
        moved: boolean;
      }
    | {
        kind: "furniture";
        id: string;
        pointerId: number;
        startClientX: number;
        startClientY: number;
        moved: boolean;
      }
    | null
  >(null);
  const dragPreviewRef = useRef<
    | {
        kind: "agent";
        id: string;
        position: Point;
      }
    | {
        kind: "furniture";
        id: string;
        position: Point;
      }
    | null
  >(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const panMovedRef = useRef(false);

  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
  const theme = officeProfile?.theme;
  const shellColor = theme?.shell_color ?? "#1A1A2E";
  const floorColor = theme?.floor_color ?? "#111827";
  const panelColor = theme?.panel_color ?? "#2A2A4A";
  const accentColor = theme?.accent_color ?? "#22D3EE";
  const floorGridColor = hexToRgba(panelColor, 0.2, "rgba(255,255,255,0.02)");
  const shellShadow = `0 24px 56px ${hexToRgba(shellColor, 0.45, "rgba(15,23,42,0.45)")}`;
  const accentGlow = hexToRgba(accentColor, 0.12, "rgba(34,211,238,0.12)");
  const agentPositions: Record<string, Point> = Object.fromEntries(
    agents.map((agent) => [agent.role, agent.position]),
  );
  const agentMeta = Object.fromEntries(
    agents.map((agent) => [agent.role, agent.meta ?? getAgentMeta(agent.role)]),
  );

  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      await loadAgentsMetadataDocument();
      await hydrateCharacterVisualsFromTauri();
    })();
  }, []);

  useEffect(() => {
    if (!isPanning) return;

    const handlePointerMove = (event: PointerEvent) => {
      const origin = panStateRef.current;
      if (!origin || event.pointerId !== origin.pointerId) return;
      const nextX = origin.startX + (event.clientX - origin.startClientX);
      const nextY = origin.startY + (event.clientY - origin.startClientY);
      panMovedRef.current = true;
      setCanvasView((prev) => ({ ...prev, x: nextX, y: nextY }));
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (panStateRef.current && event.pointerId !== panStateRef.current.pointerId) return;
      setIsPanning(false);
      panStateRef.current = null;
      window.setTimeout(() => {
        panMovedRef.current = false;
      }, 0);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [isPanning]);

  const clientToScenePoint = useCallback((
    clientX: number,
    clientY: number,
    options?: { strict?: boolean },
  ): Point | null => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const insideRect =
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    if (options?.strict && !insideRect) return null;
    const relativeX = (clientX - rect.left) / rect.width;
    const relativeY = (clientY - rect.top) / rect.height;
    return {
      x: Math.max(24, Math.min(1176, Math.round(relativeX * 1200))),
      y: Math.max(24, Math.min(776, Math.round(relativeY * 800))),
    };
  }, []);

  const updateDragPreviewForPointer = useCallback((pointerId: number, clientX: number, clientY: number) => {
    const dragState = dragStateRef.current;
    if (!dragState || pointerId !== dragState.pointerId) return;
    const nextPoint = clientToScenePoint(clientX, clientY);
    if (!nextPoint) return;
    if (
      !dragState.moved &&
      Math.hypot(clientX - dragState.startClientX, clientY - dragState.startClientY) >= 4
    ) {
      dragState.moved = true;
    }
    if (!dragState.moved) return;
    const preview = { kind: dragState.kind, id: dragState.id, position: nextPoint } as const;
    dragPreviewRef.current = preview;
    setDragPreview(preview);
  }, [clientToScenePoint]);

  const finishDragPreviewForPointer = useCallback((pointerId: number) => {
    const dragState = dragStateRef.current;
    if (!dragState || pointerId !== dragState.pointerId) return;
    const preview = dragPreviewRef.current;
    if (dragState.moved && preview && preview.id === dragState.id) {
      if (dragState.kind === "agent" && preview.kind === "agent") {
        moveAgentToPoint(dragState.id, preview.position);
      }
      if (dragState.kind === "furniture" && preview.kind === "furniture") {
        const zone = findOfficeZoneForPoint(preview.position, officeZones);
        if (zone) {
          updateOfficeFurniture(dragState.id, {
            zone_id: zone.id,
            anchor: clampFurnitureAnchorToZone(preview.position, zone),
          });
        }
      }
    }
    dragStateRef.current = null;
    dragPreviewRef.current = null;
    setDragPreview(null);
  }, [moveAgentToPoint, officeZones, updateOfficeFurniture]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      updateDragPreviewForPointer(event.pointerId, event.clientX, event.clientY);
    };

    const handlePointerUp = (event: PointerEvent) => {
      finishDragPreviewForPointer(event.pointerId);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [finishDragPreviewForPointer, updateDragPreviewForPointer]);

  const handleAgentClick = (id: string, event: ReactMouseEvent) => {
    event.stopPropagation();
    if (editMode) return;
    selectAgent(id);
  };

  const handleAgentPointerDown = (id: string, event: ReactPointerEvent) => {
    if (!editMode || event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const agent = agents.find((candidate) => candidate.id === id);
    dragStateRef.current = {
      kind: "agent",
      id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    const preview = agent ? { kind: "agent" as const, id, position: agent.position } : null;
    dragPreviewRef.current = preview;
    setDragPreview(preview);
  };

  const handleFurniturePointerDown = (id: string, event: ReactPointerEvent) => {
    if (!editMode || event.button !== 0 || !officeProfile) return;
    event.stopPropagation();
    event.preventDefault();
    if (editFurnitureMode === "delete") {
      removeOfficeFurniture(id);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const furniture = officeProfile.furniture.find((candidate) => candidate.id === id);
    if (!furniture) return;
    dragStateRef.current = {
      kind: "furniture",
      id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };
    const preview = {
      kind: "furniture" as const,
      id,
      position: furniture.anchor,
    };
    dragPreviewRef.current = preview;
    setDragPreview(preview);
  };

  const handleFurniturePointerMove = (event: ReactPointerEvent) => {
    updateDragPreviewForPointer(event.pointerId, event.clientX, event.clientY);
  };

  const handleFurniturePointerUp = (event: ReactPointerEvent) => {
    finishDragPreviewForPointer(event.pointerId);
  };

  const startCanvasPan = (event: ReactPointerEvent<HTMLElement>) => {
    setIsPanning(true);
    panMovedRef.current = false;
    panStateRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: canvasView.x,
      startY: canvasView.y,
    };
  };

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if (event.button === 1) {
      event.preventDefault();
    }
    const target = event.target as HTMLElement;
    if (
      target.closest(
        "[data-agent-interactive='true'], [data-furniture-interactive='true'], [data-office-toolbar='true'], button, input, textarea, select",
      )
    ) {
      return;
    }
    if (editMode) {
      if (editFurniturePlacementType) {
        const point = clientToScenePoint(event.clientX, event.clientY, { strict: true });
        if (point) {
          placeOfficeFurnitureAtPoint(editFurniturePlacementType, point);
          return;
        }
      }
    }

    startCanvasPan(event);
  };

  useEffect(() => {
    const handleGlobalWheel = (event: WheelEvent) => {
      const canvasElement = canvasRef.current;
      if (!canvasElement) {
        return;
      }
      const topElement = document.elementFromPoint(
        event.clientX,
        event.clientY,
      ) as HTMLElement | null;
      if (
        topElement?.closest(
          "[data-office-overlay='true'], [data-office-settings-panel='true']",
        )
      ) {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], [data-office-toolbar='true'], [data-office-settings-panel='true']",
        )
      ) {
        return;
      }
      if (!target || !canvasElement.contains(target)) {
        return;
      }
      event.preventDefault();
      setCanvasView((prev) => ({
        ...prev,
        scale: Math.max(
          MIN_CANVAS_SCALE,
          Math.min(
            MAX_CANVAS_SCALE,
            prev.scale + (event.deltaY < 0 ? 0.08 : -0.08),
          ),
        ),
      }));
    };

    window.addEventListener("wheel", handleGlobalWheel, { passive: false });
    return () => {
      window.removeEventListener("wheel", handleGlobalWheel);
    };
  }, []);

  const resetCanvasView = () => {
    setCanvasView({ x: 0, y: 0, scale: 1 });
  };

  return (
    <div
      className="relative w-full h-screen bg-[#0F0F23] overflow-hidden select-none"
      onClick={() => {
        if (panMovedRef.current) return;
        selectAgent(null);
      }}
    >
      <FloatingParticles count={15} />
      <HUD onLogout={onLogout} showLogout={showLogout} />
      <GiftBoxArrival visible={arrivingAgentIds.length > 0} />

      <div
        className="absolute inset-0 flex items-center justify-center overflow-hidden"
        onPointerDown={handleViewportPointerDown}
      >
        <div
          className="absolute bottom-6 left-6 z-20 flex items-center gap-2 pointer-events-auto"
          data-office-toolbar="true"
        >
          <span className="rounded-full border border-[#2A2A4A] bg-[#111127]/85 px-3 py-1 text-[11px] text-cyan-200">
            {Math.round(canvasView.scale * 100)}%
          </span>
          {editMode && (
            <span className="rounded-full border border-cyan-400/40 bg-cyan-500/15 px-3 py-1 text-[11px] text-cyan-100">
              {t("officeCustomization.editModeBadge")}
            </span>
          )}
          <button
            type="button"
            onClick={() =>
              setCanvasView((prev) => ({
                ...prev,
                scale: Math.max(MIN_CANVAS_SCALE, prev.scale - 0.08),
              }))
            }
            className="rounded-full border border-[#2A2A4A] bg-[#111127]/85 px-3 py-1 text-sm text-white"
          >
            -
          </button>
          <button
            type="button"
            onClick={() =>
              setCanvasView((prev) => ({
                ...prev,
                scale: Math.min(MAX_CANVAS_SCALE, prev.scale + 0.08),
              }))
            }
            className="rounded-full border border-[#2A2A4A] bg-[#111127]/85 px-3 py-1 text-sm text-white"
          >
            +
          </button>
          <button
            type="button"
            onClick={resetCanvasView}
            className="rounded-full border border-[#2A2A4A] bg-[#111127]/85 px-3 py-1 text-[11px] text-cyan-200"
          >
            {t("phase3.office.resetView")}
          </button>
        </div>

        <div
          ref={canvasRef}
          className="relative h-[800px] w-[1200px] will-change-transform"
          style={{
            transform: `translate(${canvasView.x}px, ${canvasView.y}px) scale(${canvasView.scale})`,
            transformOrigin: "center center",
            cursor: editMode
              ? dragPreview
                ? "grabbing"
                : editFurniturePlacementType
                  ? "copy"
                  : isPanning
                    ? "grabbing"
                    : "grab"
              : isPanning
                ? "grabbing"
                : "grab",
            touchAction: editMode ? "none" : "auto",
          }}
        >
          <div
            className="absolute inset-0 overflow-hidden rounded-[32px] border-2 shadow-2xl"
            style={{
              backgroundColor: floorColor,
              borderColor: panelColor,
              boxShadow: shellShadow,
            }}
          >
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `linear-gradient(180deg, ${hexToRgba(shellColor, 0.26, "rgba(26,26,46,0.26)")} 0%, ${hexToRgba(floorColor, 0.04, "rgba(17,24,39,0.04)")} 100%)`,
              }}
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{ boxShadow: `inset 0 0 80px ${accentGlow}` }}
            />
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                backgroundImage: `linear-gradient(${floorGridColor} 1px, transparent 1px), linear-gradient(90deg, ${floorGridColor} 1px, transparent 1px)`,
                backgroundSize: "40px 40px",
              }}
            />

            {officeZones.map((zone) => (
              <div
                key={zone.id}
                className={zoneShellClass(zone, officeZones)}
                style={{
                  top: zone.top,
                  left: zone.left,
                  width: zone.width,
                  height: zone.height,
                  borderColor: hexToRgba(panelColor, 0.95, panelColor),
                  boxShadow: `inset 0 0 0 1px ${hexToRgba(accentColor, 0.08, "rgba(34,211,238,0.08)")}`,
                }}
              >
                <div className="absolute inset-0" style={zoneBackground(zone, floorColor)} />
                <ZoneLabel text={zone.label} position={zone.labelPosition} />
                {renderZoneFurniture(zone, t)}
              </div>
            ))}

            {/* eslint-disable-next-line react-hooks/refs */}
            {officeProfile?.furniture.map((furniture) =>
              renderPlacedFurniture(furniture, {
                interactive: editMode,
                anchor:
                  dragPreview?.kind === "furniture" && dragPreview.id === furniture.id
                    ? dragPreview.position
                    : undefined,
                onPointerDown: (event) => handleFurniturePointerDown(furniture.id, event),
                onPointerMove: handleFurniturePointerMove,
                onPointerUp: handleFurniturePointerUp,
                onPointerCancel: handleFurniturePointerUp,
              }),
            )}

            <ExecutionOverlay officeZones={officeZones} planView={planView} />

            <CollaborationVisitLayer
              visits={collaborationVisits}
              agentPositions={agentPositions}
              agentMeta={agentMeta}
            />

            <div className="absolute inset-0 pointer-events-none">
              {agents.map((agent) => (
                <AgentSprite
                  key={agent.id}
                  interactive
                  role={agent.role}
                  status={agent.status}
                  path={agent.path}
                  position={
                    dragPreview?.kind === "agent" && dragPreview.id === agent.id
                      ? dragPreview.position
                      : agent.position
                  }
                  meta={agent.meta}
                  message={agent.message}
                  currentTask={agent.currentTask}
                  onPointerDown={(event) => handleAgentPointerDown(agent.id, event)}
                  onClick={(event) => handleAgentClick(agent.id, event)}
                />
              ))}
            </div>

            <FileTransferLayer
              transfers={pendingTransfers}
              agentPositions={agentPositions}
              agentMeta={agentMeta}
              onDismiss={dismissTransfer}
            />
          </div>
        </div>
      </div>

      <AgentFocusView agent={selectedAgent ?? null} onClose={() => selectAgent(null)} />
    </div>
  );
}
