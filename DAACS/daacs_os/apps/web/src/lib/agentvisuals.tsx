/* eslint-disable react-refresh/only-export-components */
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Calculator,
  ClipboardList,
  Code,
  Crown,
  Megaphone,
  Palette,
  Search,
  ShieldCheck,
  Terminal,
} from "lucide-react";

import {
  getCharacterVisualForOfficeRole,
  resolveCharacterBodyPaint,
} from "./characterVisuals";
import { getAgentMeta, isBuiltinAgentRole, type AgentMeta, type AgentRole } from "../types/agent";

export type AccentClasses = {
  avatar: string;
  name: string;
  dot: string;
};

const DEFAULT_ACCENT: AccentClasses = {
  avatar: "bg-cyan-500/20 border-cyan-500/40 text-cyan-300",
  name: "text-cyan-300",
  dot: "bg-cyan-400",
};

const FALLBACK_ROLE_ACCENTS: Record<string, AccentClasses> = {
  ceo: {
    avatar: "bg-violet-500/20 border-violet-500/40 text-violet-300",
    name: "text-violet-300",
    dot: "bg-violet-400",
  },
  pm: {
    avatar: "bg-emerald-500/20 border-emerald-500/40 text-emerald-300",
    name: "text-emerald-300",
    dot: "bg-emerald-400",
  },
  developer: {
    avatar: "bg-sky-500/20 border-sky-500/40 text-sky-300",
    name: "text-sky-300",
    dot: "bg-sky-400",
  },
  developer_front: {
    avatar: "bg-sky-500/20 border-sky-500/40 text-sky-300",
    name: "text-sky-300",
    dot: "bg-sky-400",
  },
  developer_back: {
    avatar: "bg-indigo-500/20 border-indigo-500/40 text-indigo-300",
    name: "text-indigo-300",
    dot: "bg-indigo-400",
  },
  reviewer: {
    avatar: "bg-amber-500/20 border-amber-500/40 text-amber-300",
    name: "text-amber-300",
    dot: "bg-amber-400",
  },
  verifier: {
    avatar: "bg-orange-500/20 border-orange-500/40 text-orange-300",
    name: "text-orange-300",
    dot: "bg-orange-400",
  },
  devops: {
    avatar: "bg-teal-500/20 border-teal-500/40 text-teal-300",
    name: "text-teal-300",
    dot: "bg-teal-400",
  },
  marketer: {
    avatar: "bg-pink-500/20 border-pink-500/40 text-pink-300",
    name: "text-pink-300",
    dot: "bg-pink-400",
  },
  designer: {
    avatar: "bg-orange-500/20 border-orange-500/40 text-orange-300",
    name: "text-orange-300",
    dot: "bg-orange-400",
  },
  cfo: {
    avatar: "bg-yellow-500/20 border-yellow-500/40 text-yellow-300",
    name: "text-yellow-300",
    dot: "bg-yellow-400",
  },
  user: {
    avatar: "bg-indigo-600/30 border-indigo-500/40 text-indigo-200",
    name: "text-indigo-200",
    dot: "bg-indigo-400",
  },
  system: {
    avatar: "bg-slate-500/20 border-slate-500/40 text-slate-300",
    name: "text-slate-300",
    dot: "bg-slate-400",
  },
};

const ICON_COMPONENTS: Record<string, LucideIcon> = {
  Bot,
  Calculator,
  ClipboardList,
  Code,
  Crown,
  Megaphone,
  Palette,
  Search,
  ShieldCheck,
  Terminal,
};

const FALLBACK_ROLE_BODY_CLASS: Record<string, string> = {
  ceo: "bg-agent-ceo",
  pm: "bg-agent-pm",
  developer: "bg-agent-developer",
  developer_front: "bg-agent-developer",
  developer_back: "bg-agent-reviewer",
  reviewer: "bg-agent-reviewer",
  verifier: "bg-agent-verifier",
  devops: "bg-agent-devops",
  marketer: "bg-agent-marketer",
  designer: "bg-agent-designer",
  cfo: "bg-agent-cfo",
};

function accessoryNodeForRole(role: AgentRole): ReactNode {
  switch (role) {
    case "ceo":
      return (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2 flex">
          <div className="w-1 h-2 bg-yellow-400 rounded-t" />
          <div className="w-1 h-3 bg-yellow-400 rounded-t mx-[1px]" />
          <div className="w-1 h-2 bg-yellow-400 rounded-t" />
          <div className="absolute bottom-0 -left-0.5 w-[calc(100%+4px)] h-1 bg-yellow-500 rounded-sm" />
        </div>
      );
    case "pm":
      return (
        <div className="absolute -top-2 -right-3 w-3 h-4 bg-amber-100 rounded-sm border border-amber-300 rotate-[10deg]">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 w-2 h-0.5 bg-amber-400 rounded-t" />
          <div className="p-0.5 space-y-[1px] mt-1">
            <div className="h-[0.5px] w-1.5 bg-amber-400/50" />
            <div className="h-[0.5px] w-1 bg-amber-400/50" />
          </div>
        </div>
      );
    case "developer":
    case "developer_front":
      return (
        <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-10 h-3">
          <div className="absolute top-0 left-1 right-1 h-1.5 border-t-2 border-l-2 border-r-2 border-blue-400 rounded-t-full" />
          <div className="absolute bottom-0 left-0 w-2 h-2 bg-blue-400 rounded-full" />
          <div className="absolute bottom-0 right-0 w-2 h-2 bg-blue-400 rounded-full" />
        </div>
      );
    case "reviewer":
    case "developer_back":
      return (
        <div className="absolute top-2.5 left-1/2 -translate-x-1/2 flex gap-[1px] z-10">
          <div className="w-2.5 h-1.5 border border-white/60 rounded-sm" />
          <div className="w-1 h-[1px] bg-white/40 self-center" />
          <div className="w-2.5 h-1.5 border border-white/60 rounded-sm" />
        </div>
      );
    case "verifier":
      return (
        <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-6 h-5 border-2 border-teal-400 rounded-md bg-teal-950/80">
          <div className="absolute inset-x-1 top-1 h-2 border border-teal-300/60 rounded-sm" />
        </div>
      );
    case "devops":
      return (
        <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-10 h-3">
          <div className="w-full h-full bg-emerald-800 rounded-t-lg" />
          <div className="absolute bottom-0 w-full h-1 bg-emerald-600" />
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-emerald-400 rounded-full" />
        </div>
      );
    case "marketer":
      return (
        <div className="absolute top-3 -right-4 rotate-[-15deg]">
          <div className="w-4 h-2 bg-pink-400 rounded-r-lg rounded-l-sm" />
          <div className="absolute left-0 top-0 w-1 h-2 bg-pink-500 rounded-l" />
        </div>
      );
    case "designer":
      return (
        <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-11 h-3">
          <div className="w-full h-full bg-orange-600 rounded-full rounded-b-none" />
          <div className="absolute -top-1 left-2 w-2 h-2 bg-orange-500 rounded-full" />
        </div>
      );
    case "cfo":
      return (
        <div className="absolute top-3 -left-4 w-3 h-4 bg-bg-elevated rounded-sm border border-border rotate-[-10deg]">
          <div className="m-0.5 h-1 bg-success/60 rounded-sm" />
          <div className="grid grid-cols-2 gap-[1px] m-0.5">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className="h-0.5 bg-border-light rounded-sm" />
            ))}
          </div>
        </div>
      );
    default:
      return null;
  }
}

const ACCESSORY_CATALOG: Record<string, () => ReactNode> = {
  ceo_crown: () => accessoryNodeForRole("ceo"),
  pm_clipboard: () => accessoryNodeForRole("pm"),
  dev_headset: () => accessoryNodeForRole("developer_front"),
  review_glasses: () => accessoryNodeForRole("reviewer"),
  verifier_shield: () => accessoryNodeForRole("verifier"),
  devops_rack: () => accessoryNodeForRole("devops"),
  marketer_megaphone: () => accessoryNodeForRole("marketer"),
  designer_beret: () => accessoryNodeForRole("designer"),
  cfo_ledger: () => accessoryNodeForRole("cfo"),
};

export const ACCESSORY_CATALOG_IDS: readonly string[] = Object.keys(ACCESSORY_CATALOG).sort();

export const CHARACTER_SPRITE_BODY_CLASS_PRESETS: readonly string[] = Array.from(
  new Set(Object.values(FALLBACK_ROLE_BODY_CLASS)),
).sort();

export const AGENT_ICON_NAME_OPTIONS: readonly string[] = Object.keys(ICON_COMPONENTS).sort();

export function getAgentAccent(role?: string | null): AccentClasses {
  if (!role) return DEFAULT_ACCENT;
  const doc = getCharacterVisualForOfficeRole(role);
  if (doc?.accent) return doc.accent;
  return FALLBACK_ROLE_ACCENTS[role] ?? DEFAULT_ACCENT;
}

export function getAgentIconComponent(
  role: AgentRole,
  overrides?: Partial<AgentMeta> | null,
): LucideIcon {
  const doc = getCharacterVisualForOfficeRole(role);
  const iconFromDoc = doc?.icon?.trim();
  const mergedOverrides: Partial<AgentMeta> = { ...(overrides ?? {}) };
  if (iconFromDoc && !mergedOverrides.icon?.trim()) {
    mergedOverrides.icon = iconFromDoc;
  }
  const iconName = getAgentMeta(role, mergedOverrides).icon;
  return ICON_COMPONENTS[iconName] ?? Bot;
}

export function getAgentSpriteFallbackTailwindClass(role: AgentRole): string {
  if (isBuiltinAgentRole(role)) return FALLBACK_ROLE_BODY_CLASS[role] ?? "bg-agent-developer";
  return "bg-agent-developer";
}

export function getAgentSpriteBodyClass(role: AgentRole): string {
  const doc = getCharacterVisualForOfficeRole(role);
  const fb = getAgentSpriteFallbackTailwindClass(role);
  const paint = resolveCharacterBodyPaint(doc, fb);
  if (paint.hexFill != null) return fb;
  return paint.tailwindBgClass || fb;
}

export function AgentCharacterAccessory({
  accessoryId,
  fallbackRole,
  translatePx,
}: {
  accessoryId?: string | null;
  fallbackRole: AgentRole;
  translatePx?: { x: number; y: number } | null;
}) {
  const key = accessoryId?.trim() ?? "";
  let node: ReactNode;
  if (key !== "") {
    const render = ACCESSORY_CATALOG[key];
    if (render) node = <>{render()}</>;
    else node = accessoryNodeForRole(fallbackRole);
  } else {
    node = accessoryNodeForRole(fallbackRole);
  }
  const tx = translatePx?.x ?? 0;
  const ty = translatePx?.y ?? 0;
  if (tx === 0 && ty === 0) {
    return <div className="pointer-events-none relative z-[35]">{node}</div>;
  }
  return (
    <div
      className="pointer-events-none relative z-[35]"
      style={{ transform: `translate(${tx}px, ${ty}px)` }}
    >
      {node}
    </div>
  );
}

export function AgentRoleAccessory({ role }: { role: AgentRole }) {
  const doc = getCharacterVisualForOfficeRole(role);
  const ox = doc?.accessory_offset_x ?? 0;
  const oy = doc?.accessory_offset_y ?? 0;
  const translatePx = ox !== 0 || oy !== 0 ? { x: ox, y: oy } : null;
  return (
    <AgentCharacterAccessory
      accessoryId={doc?.accessory_id ?? null}
      fallbackRole={role}
      translatePx={translatePx}
    />
  );
}
