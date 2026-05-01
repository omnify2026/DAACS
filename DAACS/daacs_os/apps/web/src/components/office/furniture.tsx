/**
 * DAACS OS — Office Furniture Components
 * Ported from GUI Prototype Furniture.tsx
 */
import { motion } from "framer-motion";

// ─── Desk ───

export const Desk = ({ type = "standard", rotate = 0 }: { type?: "standard" | "ceo" | "corner"; rotate?: number }) => (
    <div className="relative w-28 h-16 select-none" style={{ rotate: `${rotate}deg` }}>
        <div className={`absolute inset-0 rounded-lg shadow-lg border-b-4 ${type === 'ceo' ? 'bg-purple-900/60 border-purple-950' : 'bg-bg-elevated border-border'}`} />
        <div className="absolute top-[-12px] left-1/2 -translate-x-1/2 w-14 h-9 bg-bg-deep rounded-sm border-2 border-border-light overflow-hidden">
            <div className="w-full h-full relative">
                <div className="absolute inset-0.5 bg-bg-deep overflow-hidden">
                    <div className="w-full h-[2px] bg-neon-blue/30 animate-[scanline_3s_linear_infinite]" />
                    <div className="space-y-0.5 p-0.5">
                        <div className="h-[1px] w-8 bg-neon-blue/40" />
                        <div className="h-[1px] w-6 bg-neon-green/30" />
                        <div className="h-[1px] w-10 bg-primary-light/30" />
                    </div>
                </div>
                <div className="absolute inset-0 bg-neon-blue/5 animate-[monitor-flicker_4s_ease-in-out_infinite]" />
            </div>
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-3 h-1 bg-border-light" />
            <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 w-6 h-0.5 bg-border-light rounded" />
        </div>
        <div className="absolute top-6 left-1/2 -translate-x-1/2 w-10 h-3 bg-bg-deep/60 rounded-sm border border-border/50">
            <div className="grid grid-cols-5 gap-[1px] p-[1px]">
                {[...Array(10)].map((_, i) => (
                    <div key={i} className="h-[1px] bg-border-light/50" />
                ))}
            </div>
        </div>
        {type === 'ceo' && (
            <div className="absolute top-5 right-2 w-2.5 h-3 bg-amber-800 rounded-b-sm border border-amber-900">
                <div className="absolute -right-1 top-0.5 w-1.5 h-1.5 border border-amber-900 rounded-full" />
            </div>
        )}
        <div className="absolute -bottom-5 left-1/2 -translate-x-1/2 w-10 h-10 bg-bg-elevated rounded-full border-2 border-border shadow-md">
            <div className="absolute inset-1 rounded-full bg-bg-surface" />
        </div>
    </div>
);

// ─── Server Rack ───

export const ServerRack = () => (
    <div className="relative w-14 h-28 bg-bg-deep rounded border border-border flex flex-col p-0.5 shadow-[0_0_15px_rgba(16,185,129,0.08)]">
        <div className="absolute top-0 left-0 w-full h-0.5 bg-success/40 blur-[1px] animate-[pulse-glow_2s_ease-in-out_infinite]" />
        {[...Array(6)].map((_, i) => (
            <div key={i} className="flex-1 bg-bg-surface my-[1px] rounded-sm flex items-center px-1 gap-0.5">
                <motion.div className="w-1 h-1 bg-success rounded-full"
                    animate={{ opacity: [0.4, 1, 0.4] }}
                    transition={{ repeat: Infinity, duration: 1.5, delay: (i * 0.37) % 2 }} />
                <motion.div className="w-1 h-1 bg-neon-blue rounded-full"
                    animate={{ opacity: [1, 0.3, 1] }}
                    transition={{ repeat: Infinity, duration: 0.8, delay: (i * 0.19) % 1 }} />
                <div className="flex-1 h-[1px] bg-border/50" />
            </div>
        ))}
        <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-[2px]">
            <div className="w-[2px] h-3 bg-neon-blue/30 rounded" />
            <div className="w-[2px] h-3 bg-success/30 rounded" />
            <div className="w-[2px] h-3 bg-warning/30 rounded" />
        </div>
    </div>
);

// ─── Meeting Table ───

export const MeetingTable = () => (
    <div className="relative w-56 h-28">
        <div className="absolute inset-4 bg-bg-surface/80 rounded-full border-2 border-border backdrop-blur-sm shadow-xl">
            <div className="w-full h-full rounded-full flex items-center justify-center">
                <div className="pixel-text text-text-muted/30 text-[8px] uppercase tracking-widest">회의실</div>
            </div>
            <motion.div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 bg-primary rounded-full"
                animate={{ opacity: [0.3, 0.8, 0.3], boxShadow: ['0 0 4px rgba(124,58,237,0.3)', '0 0 12px rgba(124,58,237,0.6)', '0 0 4px rgba(124,58,237,0.3)'] }}
                transition={{ repeat: Infinity, duration: 2 }}
            />
        </div>
        {[0, 45, 90, 135, 180, 225, 270, 315].map((angle) => {
            const rad = (angle * Math.PI) / 180;
            const cx = 112 + Math.cos(rad) * 65;
            const cy = 56 + Math.sin(rad) * 40;
            return (
                <div key={angle} className="absolute w-7 h-7 bg-bg-elevated rounded-full border border-border shadow-sm"
                    style={{ left: cx - 14, top: cy - 14 }}>
                    <div className="absolute inset-1 rounded-full bg-bg-surface" />
                </div>
            );
        })}
    </div>
);

// ─── Plant ───

export const Plant = () => (
    <div className="relative w-10 h-10 flex items-center justify-center">
        <div className="absolute bottom-0 w-6 h-5 bg-amber-800/80 rounded-b-lg rounded-t-sm border border-amber-900/50 overflow-hidden">
            <div className="absolute top-0 w-full h-1 bg-amber-700/50" />
            <div className="absolute bottom-0 w-full h-2 bg-amber-950/30" />
        </div>
        <motion.div className="absolute -top-2 w-8 h-8 bg-success/70 rounded-full"
            animate={{ scale: [1, 1.05, 1] }} transition={{ duration: 4, repeat: Infinity }} />
        <div className="absolute -top-4 left-0 w-4 h-5 bg-emerald-400/60 rounded-full rotate-[-20deg]" />
        <div className="absolute -top-3 right-0 w-4 h-6 bg-emerald-600/60 rounded-full rotate-[15deg]" />
    </div>
);

// ─── Whiteboard ───

export const Whiteboard = () => (
    <div className="relative w-32 h-20 bg-white/90 rounded border-2 border-border shadow-lg">
        <div className="absolute inset-1 border border-border-light/30 rounded-sm overflow-hidden">
            <div className="p-1 space-y-1">
                <div className="h-[1px] w-16 bg-blue-400/40" />
                <div className="h-[1px] w-12 bg-red-400/30 ml-2" />
                <div className="h-[1px] w-20 bg-blue-400/40" />
                <div className="h-[1px] w-8 bg-green-400/30 ml-4" />
                <div className="flex gap-1 mt-1">
                    <div className="w-3 h-3 border border-blue-400/40" />
                    <div className="w-1 h-[1px] bg-blue-400/30 self-center" />
                    <div className="w-3 h-3 border border-red-400/30" />
                </div>
            </div>
        </div>
        <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-16 h-2 bg-border rounded-b flex items-center justify-center gap-1 px-1">
            <div className="w-4 h-1 bg-blue-500 rounded-full" />
            <div className="w-4 h-1 bg-red-500 rounded-full" />
            <div className="w-4 h-1 bg-green-500 rounded-full" />
        </div>
    </div>
);

// ─── Vending Machine ───

export const VendingMachine = () => (
    <div className="relative w-12 h-20 bg-bg-elevated rounded-lg border border-border shadow-lg overflow-hidden">
        <motion.div className="absolute top-0 w-full h-3 bg-cta/20 flex items-center justify-center"
            animate={{ opacity: [0.6, 1, 0.6] }} transition={{ repeat: Infinity, duration: 3 }}>
            <div className="text-[4px] text-cta font-bold pixel-text">음료</div>
        </motion.div>
        <div className="absolute top-4 inset-x-1 grid grid-cols-2 gap-[2px]">
            {[...Array(6)].map((_, i) => (
                <div key={i} className={`h-3 rounded-sm ${['bg-red-500/40', 'bg-blue-500/40', 'bg-green-500/40', 'bg-yellow-500/40', 'bg-purple-500/40', 'bg-orange-500/40'][i]}`} />
            ))}
        </div>
        <div className="absolute bottom-1 inset-x-1 h-4 bg-bg-deep rounded border border-border" />
    </div>
);

// ─── Safe Box ───

export const SafeBox = () => (
    <div className="relative w-14 h-14 bg-bg-elevated rounded border-2 border-border shadow-lg">
        <div className="absolute inset-1 bg-bg-surface rounded-sm border border-border-light">
            <motion.div
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 border-2 border-cfo rounded-full"
                animate={{ rotate: [0, 90, 180, 270, 360] }}
                transition={{ repeat: Infinity, duration: 8, ease: "linear" }}>
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0.5 h-2 bg-cfo" />
            </motion.div>
        </div>
        <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1.5 h-4 bg-border-light rounded-r" />
    </div>
);

// ─── Empty Slot ───

export const EmptySlot = () => (
    <div className="relative w-24 h-16 border-2 border-dashed border-border/50 rounded-lg flex items-center justify-center">
        <div className="text-center">
            <div className="text-text-muted/30 text-lg">+</div>
            <div className="pixel-text text-text-muted/20 text-[6px] mt-0.5">채용</div>
        </div>
    </div>
);

// ─── Bulletin Board ───

export const BulletinBoard = () => (
    <div className="relative w-20 h-14 bg-amber-900/40 rounded border border-border shadow">
        <div className="absolute top-1 left-1 w-6 h-5 bg-yellow-200/80 rounded-sm rotate-[-3deg] shadow-sm">
            <div className="p-0.5">
                <div className="h-[1px] w-4 bg-black/20" />
                <div className="h-[1px] w-3 bg-black/20 mt-0.5" />
            </div>
        </div>
        <div className="absolute top-2 right-2 w-5 h-5 bg-blue-200/70 rounded-sm rotate-[5deg] shadow-sm">
            <div className="p-0.5">
                <div className="h-[1px] w-3 bg-black/20" />
            </div>
        </div>
        <div className="absolute bottom-1 left-3 w-7 h-4 bg-pink-200/60 rounded-sm rotate-[2deg] shadow-sm" />
        <div className="absolute top-0.5 left-3 w-1 h-1 bg-red-500 rounded-full" />
        <div className="absolute top-1.5 right-3.5 w-1 h-1 bg-blue-500 rounded-full" />
    </div>
);
