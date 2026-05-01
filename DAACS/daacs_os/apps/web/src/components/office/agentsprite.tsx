import { motion } from "framer-motion";
import {
  useMemo,
  useSyncExternalStore,
  type MouseEventHandler,
  type PointerEventHandler,
} from "react";

import { tStatic } from "../../i18n";
import type { AgentMeta, AgentRole, AgentStatus, Point } from "../../types/agent";
import { getAgentMeta } from "../../types/agent";
import {
  AgentCharacterAccessory,
  AgentRoleAccessory,
  getAgentSpriteFallbackTailwindClass,
} from "../../lib/agentVisuals";
import {
  getCharacterDocByFilename,
  getCharacterVisualForOfficeRole,
  getCharacterVisualOverlayRevision,
  resolveCharacterBodyPaint,
  subscribeCharacterVisualOverlay,
} from "../../lib/characterVisuals";

interface Props {
  role: AgentRole;
  status: AgentStatus;
  path: Point[];
  position: Point;
  meta?: AgentMeta;
  message?: string;
  currentTask?: string;
  interactive?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
}

const WALK_SPEED = 200;

export function AgentSpriteEyes({ status }: { status: AgentStatus }) {
  if (status === "error") {
    return (
      <div className="absolute top-2.5 left-1/2 -translate-x-1/2 flex gap-1.5">
        {[0, 1].map((index) => (
          <div key={index} className="relative w-2 h-2">
            <div className="absolute inset-0 rotate-45 flex items-center justify-center">
              <div className="w-2 h-[1.5px] bg-error" />
            </div>
            <div className="absolute inset-0 -rotate-45 flex items-center justify-center">
              <div className="w-2 h-[1.5px] bg-error" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const isWorking = status === "working";

  return (
    <div className="absolute top-2.5 left-1/2 -translate-x-1/2 flex gap-1.5">
      <motion.div
        className={`w-1.5 ${isWorking ? "h-[3px]" : "h-1.5"} bg-white rounded-full`}
        animate={!isWorking ? { scaleY: [1, 0.1, 1] } : {}}
        transition={{ repeat: Infinity, duration: 3.5, repeatDelay: 1.5 }}
      />
      <motion.div
        className={`w-1.5 ${isWorking ? "h-[3px]" : "h-1.5"} bg-white rounded-full`}
        animate={!isWorking ? { scaleY: [1, 0.1, 1] } : {}}
        transition={{ repeat: Infinity, duration: 3.5, repeatDelay: 2.8 }}
      />
    </div>
  );
}

export function AgentSprite({
  role,
  status,
  path,
  position,
  meta: metaOverride,
  message,
  currentTask,
  interactive = false,
  onClick,
  onPointerDown,
}: Props) {
  const characterVisualRev = useSyncExternalStore(
    subscribeCharacterVisualOverlay,
    getCharacterVisualOverlayRevision,
    () => 0,
  );
  const bodyPaint = useMemo(() => {
    void characterVisualRev;
    const doc = getCharacterVisualForOfficeRole(role);
    const fb = getAgentSpriteFallbackTailwindClass(role);
    return resolveCharacterBodyPaint(doc, fb);
  }, [role, characterVisualRev]);
  const bodyTw = bodyPaint.tailwindBgClass;
  const bodyFillStyle =
    bodyPaint.hexFill != null ? { backgroundColor: bodyPaint.hexFill } : undefined;
  const meta = useMemo(() => getAgentMeta(role, metaOverride), [role, metaOverride]);

  const isWorking = status === "working";
  const isError = status === "error";
  const isMeeting = status === "meeting";
  const isCelebrating = status === "celebrating";

  const { xValues, yValues, duration, times, pathKey } = useMemo(() => {
    const hasPath = path.length >= 2;
    if (!hasPath) {
      const point = path.length === 1 ? path[0] : position;
      return {
        xValues: point.x,
        yValues: point.y,
        duration: 0,
        times: [0] as number[],
        pathKey: `static-${point.x}-${point.y}`,
      };
    }

    const segments = path.map((point, index) => {
      if (index === 0) return 0;
      const prev = path[index - 1];
      return Math.sqrt((point.x - prev.x) ** 2 + (point.y - prev.y) ** 2);
    });
    const totalDistance = segments.reduce((sum, value) => sum + value, 0);
    const walkDuration = Math.max(totalDistance / WALK_SPEED, 0.5);
    let cumulative = 0;
    const normalizedTimes = segments.map((segment) => {
      cumulative += segment;
      return totalDistance > 0 ? cumulative / totalDistance : 1;
    });
    normalizedTimes[0] = 0;
    return {
      xValues: path.map((point) => point.x),
      yValues: path.map((point) => point.y),
      duration: walkDuration,
      times: normalizedTimes,
      pathKey: path.map((point) => `${point.x},${point.y}`).join("|"),
    };
  }, [path, position]);

  const isAnimating = path.length >= 2;
  const bubbleText = currentTask?.trim() || message;

  return (
    <motion.div
      key={pathKey}
      data-agent-interactive={interactive ? "true" : undefined}
      className={`absolute z-[22] -translate-x-1/2 -translate-y-1/2 ${
        interactive
          ? "pointer-events-auto touch-none cursor-grab active:cursor-grabbing"
          : "cursor-pointer"
      }`}
      style={{ left: 0, top: 0 }}
      onClick={onClick}
      onPointerDown={onPointerDown}
      initial={{
        x: Array.isArray(xValues) ? xValues[0] : xValues,
        y: Array.isArray(yValues) ? yValues[0] : yValues,
        opacity: 1,
      }}
      animate={{ x: xValues, y: yValues, opacity: 1 }}
      transition={
        isAnimating
          ? { duration, times, ease: "linear" }
          : { type: "spring", stiffness: 80, damping: 20 }
      }
      whileHover={{ scale: 1.12, filter: "brightness(1.2)" }}
    >
      <div className="relative flex min-h-[86px] min-w-[78px] flex-col items-center justify-center">
        {isWorking && bubbleText && (
          <motion.div
            className="absolute -top-16 whitespace-nowrap glass-panel text-text text-[10px] font-medium px-3 py-1.5 rounded-lg shadow-lg z-20 max-w-[160px] truncate"
            title={bubbleText}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: [0, 1, 1, 0], y: [8, 0, 0, -4] }}
            transition={{ duration: 5, repeat: Infinity, repeatDelay: 3 }}
          >
            {bubbleText}
            <div className="absolute bottom-[-4px] left-1/2 -translate-x-1/2 w-2 h-2 glass-panel rotate-45" />
          </motion.div>
        )}

        {isCelebrating && (
          <motion.div
            className="absolute -top-12 whitespace-nowrap bg-yellow-400/90 text-black text-[10px] font-bold px-3 py-1 rounded-lg shadow-lg z-20"
            animate={{ y: [0, -3, 0] }}
            transition={{ duration: 0.5, repeat: Infinity }}
          >
            {tStatic("focus.status.completed")}
            <div className="absolute bottom-[-3px] left-1/2 -translate-x-1/2 w-2 h-2 bg-yellow-400/90 rotate-45" />
          </motion.div>
        )}

        {isError && (
          <motion.div
            className="absolute -top-12 whitespace-nowrap bg-error/90 text-white text-[10px] font-bold px-3 py-1 rounded-lg shadow-lg z-20"
            animate={{ y: [0, -2, 0] }}
            transition={{ duration: 0.5, repeat: Infinity }}
          >
            {tStatic("focus.status.failed")}
            <div className="absolute bottom-[-3px] left-1/2 -translate-x-1/2 w-2 h-2 bg-error/90 rotate-45" />
          </motion.div>
        )}

        <div className="relative">
          <motion.div
            className={`w-10 h-9 ${bodyTw} rounded-t-full rounded-b-sm shadow-lg border-2 border-black/20 relative overflow-visible`}
            style={bodyFillStyle}
            animate={
              isError
                ? { x: [-1, 1, -1, 1, 0] }
                : isCelebrating
                  ? { y: [0, -5, 0] }
                  : isAnimating
                    ? { y: [0, -3, 0, -3, 0] }
                    : {}
            }
            transition={
              isError
                ? { duration: 0.3, repeat: Infinity, repeatDelay: 1 }
                : isCelebrating
                  ? { duration: 0.35, repeat: Infinity }
                  : isAnimating
                    ? { duration: 0.4, repeat: Infinity, ease: "easeInOut" }
                    : {}
            }
          >
            <AgentSpriteEyes status={status} />

            {isError ? (
              <div className="absolute top-5 left-1/2 -translate-x-1/2 w-2 h-1 border-b-2 border-white rounded-b-full" />
            ) : isMeeting ? (
              <motion.div
                className="absolute top-5 left-1/2 -translate-x-1/2 w-1.5 h-1 bg-white/60 rounded-full"
                animate={{ scaleY: [1, 0.3, 1] }}
                transition={{ duration: 0.8, repeat: Infinity }}
              />
            ) : isCelebrating ? (
              <div className="absolute top-5 left-1/2 -translate-x-1/2 w-2.5 h-1 border-b-2 border-white/80 rounded-b-full" />
            ) : null}
          </motion.div>

          <motion.div
            className={`absolute top-4 -left-1.5 w-3 h-3 ${bodyTw} rounded-full border border-black/10`}
            style={bodyFillStyle}
            animate={
              isAnimating
                ? { rotate: [25, -25, 25], y: [-1, 1, -1] }
                : isWorking || isCelebrating
                  ? { y: [-1, 1, -1] }
                  : {}
            }
            transition={{ repeat: Infinity, duration: isAnimating ? 0.4 : 0.3 }}
          />

          <motion.div
            className={`absolute top-4 -right-1.5 w-3 h-3 ${bodyTw} rounded-full border border-black/10`}
            style={bodyFillStyle}
            animate={
              isAnimating
                ? { rotate: [-25, 25, -25], y: [1, -1, 1] }
                : isWorking || isCelebrating
                  ? { y: [1, -1, 1] }
                  : {}
            }
            transition={{ repeat: Infinity, duration: isAnimating ? 0.4 : 0.3 }}
          />

          <div className="flex justify-center gap-1.5 -mt-0.5">
            <motion.div
              className={`w-2.5 ${bodyTw} rounded-b-full border border-black/10`}
              style={bodyFillStyle}
              animate={
                isAnimating
                  ? { height: ["12px", "8px", "12px"], y: [0, 2, 0] }
                  : isCelebrating
                    ? { height: ["12px", "16px", "12px"], y: [0, -2, 0] }
                    : { height: "12px", y: 0 }
              }
              transition={{
                repeat: isAnimating || isCelebrating ? Infinity : 0,
                duration: 0.3,
              }}
            />
            <motion.div
              className={`w-2.5 ${bodyTw} rounded-b-full border border-black/10`}
              style={bodyFillStyle}
              animate={
                isAnimating
                  ? { height: ["8px", "12px", "8px"], y: [2, 0, 2] }
                  : isCelebrating
                    ? { height: ["16px", "12px", "16px"], y: [-2, 0, -2] }
                    : { height: "12px", y: 0 }
              }
              transition={{
                repeat: isAnimating || isCelebrating ? Infinity : 0,
                duration: 0.3,
              }}
            />
          </div>

          <motion.div
            className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-1.5 bg-black/20 rounded-full blur-[2px]"
            animate={isAnimating ? { scaleX: [1, 0.7, 1] } : {}}
            transition={{ repeat: Infinity, duration: 0.4 }}
          />

          <AgentRoleAccessory role={role} />
        </div>

        <div className="absolute -bottom-7 whitespace-nowrap pixel-text text-[8px] text-text/90 bg-bg-deep/90 px-2 py-0.5 rounded-full border border-border/50 shadow-sm">
          {meta.name}
        </div>
      </div>
    </motion.div>
  );
}

export type AgentCharacterStaticPreviewProps = {
  role: AgentRole;
  characterFilename?: string | null;
  className?: string;
  overrideBodyClass?: string | null;
  overrideAccessoryId?: string | null;
  accessoryTranslatePx?: { x: number; y: number } | null;
};

export function AgentCharacterStaticPreview({
  role,
  characterFilename,
  className = "",
  overrideBodyClass,
  overrideAccessoryId,
  accessoryTranslatePx,
}: AgentCharacterStaticPreviewProps) {
  const characterVisualRev = useSyncExternalStore(
    subscribeCharacterVisualOverlay,
    getCharacterVisualOverlayRevision,
    () => 0,
  );
  const characterDoc = useMemo(() => {
    void characterVisualRev;
    const file = characterFilename?.trim() ?? "";
    if (file === "") return null;
    return getCharacterDocByFilename(file);
  }, [characterFilename, characterVisualRev]);

  const { bodyTw, bodyFillStyle } = useMemo(() => {
    const o = overrideBodyClass?.trim() ?? "";
    if (o !== "") {
      return { bodyTw: o, bodyFillStyle: undefined as { backgroundColor: string } | undefined };
    }
    const fb = getAgentSpriteFallbackTailwindClass(role);
    const paint = resolveCharacterBodyPaint(characterDoc, fb);
    return {
      bodyTw: paint.tailwindBgClass,
      bodyFillStyle:
        paint.hexFill != null ? { backgroundColor: paint.hexFill } : undefined,
    };
  }, [role, characterDoc, overrideBodyClass]);

  const accessoryKey = useMemo(() => {
    const o = overrideAccessoryId?.trim() ?? "";
    if (o !== "") return o;
    return characterDoc?.accessory_id?.trim() ?? "";
  }, [characterDoc, overrideAccessoryId]);

  const translatePx = useMemo(() => {
    if (accessoryTranslatePx != null) return accessoryTranslatePx;
    const ox = characterDoc?.accessory_offset_x ?? 0;
    const oy = characterDoc?.accessory_offset_y ?? 0;
    if (ox === 0 && oy === 0) return null;
    return { x: ox, y: oy };
  }, [characterDoc, accessoryTranslatePx]);

  return (
    <div
      className={`relative flex min-h-[5.5rem] flex-col items-center justify-start pt-1 ${className}`}
      aria-hidden
    >
      <div className="relative origin-top scale-[1.12]">
        <div
          className={`relative w-10 h-9 ${bodyTw} rounded-t-full rounded-b-sm shadow-lg border-2 border-black/20 overflow-visible`}
          style={bodyFillStyle}
        >
          <AgentSpriteEyes status="idle" />
        </div>
        <div
          className={`absolute top-4 -left-1.5 w-3 h-3 ${bodyTw} rounded-full border border-black/10`}
          style={bodyFillStyle}
        />
        <div
          className={`absolute top-4 -right-1.5 w-3 h-3 ${bodyTw} rounded-full border border-black/10`}
          style={bodyFillStyle}
        />
        <div className="flex justify-center gap-1.5 -mt-0.5">
          <div
            className={`w-2.5 h-3 ${bodyTw} rounded-b-full border border-black/10`}
            style={bodyFillStyle}
          />
          <div
            className={`w-2.5 h-3 ${bodyTw} rounded-b-full border border-black/10`}
            style={bodyFillStyle}
          />
        </div>
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-1.5 bg-black/20 rounded-full blur-[2px]" />
        <AgentCharacterAccessory
          accessoryId={accessoryKey !== "" ? accessoryKey : null}
          fallbackRole={role}
          translatePx={translatePx}
        />
      </div>
    </div>
  );
}
