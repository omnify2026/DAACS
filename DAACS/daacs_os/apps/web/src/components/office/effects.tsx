/**
 * DAACS OS - Visual Effects Components
 */
import { motion, AnimatePresence } from "framer-motion";
import type { AgentMeta, CollaborationVisit, Point, PendingTransfer } from "../../types/agent";
import { getAgentMeta } from "../../types/agent";
import { useEffect } from "react";

function deterministicFraction(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function FloatingParticles({ count = 20 }: { count?: number }) {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
      {[...Array(count)].map((_, i) => {
        const size = deterministicFraction(i + 1) * 2 + 1;
        const x = deterministicFraction(i + 101) * 100;
        const delay = deterministicFraction(i + 201) * 10;
        const duration = deterministicFraction(i + 301) * 10 + 15;
        const yDistance = -(deterministicFraction(i + 401) * 600 + 400);
        const driftX = Math.sin(i) * 30;
        return (
          <motion.div
            key={i}
            className="absolute rounded-full bg-white/10"
            style={{ width: size, height: size, left: `${x}%`, bottom: "-5%" }}
            animate={{
              y: [0, yDistance],
              x: [0, driftX],
              opacity: [0, 0.4, 0],
            }}
            transition={{ duration, delay, repeat: Infinity, ease: "linear" }}
          />
        );
      })}
    </div>
  );
}

export function ZoneLabel({ text, position = "top-left" }: { text: string; position?: string }) {
  const posClass =
    {
      "top-left": "top-3 left-3",
      "top-right": "top-3 right-3",
      "bottom-left": "bottom-3 left-3",
      "bottom-right": "bottom-3 right-3",
    }[position] || "top-3 left-3";

  return <div className={`absolute ${posClass} pixel-text text-[10px] text-white/25 uppercase tracking-[0.15em]`}>{text}</div>;
}

interface ToastProps {
  type: "info" | "success" | "warning" | "error";
  message: string;
  actionLabel?: string;
  onAction?: () => void;
  onDismiss: () => void;
}

const toastStyles = {
  info: "border-primary/50 bg-primary/10",
  success: "border-success/50 bg-success/10",
  warning: "border-warning/50 bg-warning/10",
  error: "border-error/50 bg-error/10",
};

export function NotificationToast({ type, message, actionLabel, onAction, onDismiss }: ToastProps) {
  const handleClick = () => {
    if (onAction) {
      onAction();
      return;
    }
    onDismiss();
  };

  return (
    <motion.div
      data-testid="notification-toast"
      initial={{ x: 300, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 300, opacity: 0 }}
      className={`glass-panel-strong rounded-lg px-4 py-3 border ${toastStyles[type]} shadow-xl max-w-xs cursor-pointer`}
      onClick={handleClick}
    >
      <div className="text-xs text-text font-medium">{message}</div>
      {actionLabel != null && onAction != null ? (
        <button
          type="button"
          data-testid="notification-action-button"
          className="mt-2 rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[10px] font-semibold text-text hover:bg-white/20"
          onClick={(event) => {
            event.stopPropagation();
            onAction();
          }}
        >
          {actionLabel}
        </button>
      ) : (
        <div className="text-[9px] text-text-muted mt-1">클릭하여 닫기</div>
      )}
    </motion.div>
  );
}

interface FileTransferEffectProps {
  transfer: PendingTransfer;
  agentPositions: Record<string, Point>;
  agentMeta: Record<string, AgentMeta>;
  onComplete: (id: string) => void;
}

export function FileTransferEffect({ transfer, agentPositions, agentMeta, onComplete }: FileTransferEffectProps) {
  const fromPos = agentPositions[transfer.from];
  const toPos = agentPositions[transfer.to];
  const fromMeta = agentMeta[transfer.from] ?? getAgentMeta(transfer.from);

  useEffect(() => {
    const timer = setTimeout(() => onComplete(transfer.id), 1200);
    return () => clearTimeout(timer);
  }, [transfer.id, onComplete]);

  if (!fromPos || !toPos) return null;

  const dx = toPos.x - fromPos.x;
  const dy = toPos.y - fromPos.y;

  return (
    <motion.div
      initial={{ x: fromPos.x, y: fromPos.y, opacity: 1, scale: 1 }}
      animate={{ x: toPos.x, y: toPos.y, opacity: [1, 1, 0], scale: [1, 1.2, 0.8] }}
      transition={{ duration: 1.0, ease: "easeInOut" }}
      className="absolute z-50 pointer-events-none flex flex-col items-center"
      style={{ left: 0, top: 0 }}
    >
      <div
        className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm shadow-lg border border-white/20"
        style={{ backgroundColor: fromMeta.color }}
      >
        📄
      </div>
      {transfer.summary && (
        <div className="mt-1 px-2 py-0.5 rounded-full text-[9px] text-white/90 bg-black/70 border border-white/10 max-w-[120px] truncate whitespace-nowrap">
          {transfer.summary}
        </div>
      )}
      <svg className="absolute inset-0 pointer-events-none" style={{ overflow: "visible", width: 0, height: 0 }}>
        <line
          x1={0}
          y1={0}
          x2={dx}
          y2={dy}
          stroke={fromMeta.color}
          strokeWidth="1"
          strokeOpacity="0.25"
          strokeDasharray="4 4"
        />
      </svg>
    </motion.div>
  );
}

interface FileTransferLayerProps {
  transfers: PendingTransfer[];
  agentPositions: Record<string, Point>;
  agentMeta: Record<string, AgentMeta>;
  onDismiss: (id: string) => void;
}

export function FileTransferLayer({ transfers, agentPositions, agentMeta, onDismiss }: FileTransferLayerProps) {
  return (
    <AnimatePresence>
      {transfers.map((transfer) => (
        <FileTransferEffect
          key={transfer.id}
          transfer={transfer}
          agentPositions={agentPositions}
          agentMeta={agentMeta}
          onComplete={onDismiss}
        />
      ))}
    </AnimatePresence>
  );
}

interface CollaborationVisitLayerProps {
  visits: CollaborationVisit[];
  agentPositions: Record<string, Point>;
  agentMeta: Record<string, AgentMeta>;
}

export function CollaborationVisitLayer({
  visits,
  agentPositions,
  agentMeta,
}: CollaborationVisitLayerProps) {
  return (
    <AnimatePresence>
      {visits
        .filter((visit) => visit.stage === "speaking")
        .map((visit) => {
          const pos = agentPositions[visit.from];
          const meta = agentMeta[visit.from] ?? getAgentMeta(visit.from);
          if (!pos) return null;

          return (
            <motion.div
              key={visit.id}
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.96 }}
              className="absolute z-50 pointer-events-none"
              style={{ left: pos.x, top: pos.y - 54 }}
            >
              <div
                className="max-w-[180px] rounded-2xl border px-3 py-2 text-[10px] font-medium text-white shadow-xl"
                style={{ backgroundColor: `${meta.color}E6`, borderColor: `${meta.color}` }}
              >
                <div className="truncate whitespace-nowrap">{visit.summary}</div>
              </div>
              <div
                className="absolute left-1/2 top-[calc(100%-4px)] h-3 w-3 -translate-x-1/2 rotate-45 border-r border-b"
                style={{ backgroundColor: `${meta.color}E6`, borderColor: `${meta.color}` }}
              />
            </motion.div>
          );
        })}
    </AnimatePresence>
  );
}
