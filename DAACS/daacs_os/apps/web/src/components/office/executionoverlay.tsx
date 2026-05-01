import { useMemo } from "react";

import type { RuntimePlanView } from "../../lib/runtimePlan";
import type { RuntimeOfficeZone } from "../../lib/runtimeUi";
import { useI18n } from "../../i18n";

function zoneCenterMap(officeZones: RuntimeOfficeZone[]): Map<string, { x: number; y: number }> {
  return new Map(officeZones.map((zone) => [zone.id, zone.center]));
}

function edgeColor(state: string): string {
  if (state === "complete") return "#34D399";
  if (state === "active") return "#22D3EE";
  if (state === "ready") return "#F59E0B";
  return "rgba(148,163,184,0.42)";
}

function nodeColor(status: string): string {
  if (status === "completed" || status === "approved" || status === "skipped") return "#34D399";
  if (status === "in_progress") return "#22D3EE";
  if (status === "awaiting_approval") return "#F59E0B";
  if (status === "failed") return "#FB7185";
  return "#64748B";
}

export function ExecutionOverlay({
  officeZones,
  planView,
}: {
  officeZones: RuntimeOfficeZone[];
  planView: RuntimePlanView | null;
}) {
  const { t } = useI18n();
  const zoneCenters = useMemo(() => zoneCenterMap(officeZones), [officeZones]);

  if (!planView) return null;

  const approvalCount = planView.approvalQueue.length;
  const graphWidth = Math.max(
    280,
    ...planView.execution.nodes.map((node) => node.x + 120),
  );
  const graphHeight = Math.max(
    180,
    ...planView.execution.nodes.map((node) => node.y + 72),
  );

  return (
    <>
      <svg className="absolute inset-0 pointer-events-none">
        {planView.org.edges.map((edge) => {
          const fromCluster = planView.org.clusters.find((cluster) => cluster.id === edge.from);
          const toCluster = planView.org.clusters.find((cluster) => cluster.id === edge.to);
          const from = fromCluster ? zoneCenters.get(fromCluster.zone_id) : null;
          const to = toCluster ? zoneCenters.get(toCluster.zone_id) : null;
          if (!from || !to) return null;
          return (
            <g key={`${edge.from}-${edge.to}-${edge.label}`}>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="rgba(34,211,238,0.32)"
                strokeWidth="2"
                strokeDasharray="6 8"
              />
              <text
                x={(from.x + to.x) / 2}
                y={(from.y + to.y) / 2 - 6}
                fill="rgba(226,232,240,0.64)"
                fontSize="10"
                textAnchor="middle"
              >
                {edge.label}
              </text>
            </g>
          );
        })}
      </svg>

      {planView.org.clusters.map((cluster) => {
        const zone = officeZones.find((candidate) => candidate.id === cluster.zone_id);
        if (!zone) return null;
        return (
          <div
            key={cluster.id}
            className="absolute pointer-events-none rounded-xl border border-cyan-400/20 bg-[#08111f]/70 px-3 py-2 shadow-lg shadow-black/30 backdrop-blur-sm"
            style={{
              left: zone.left + 12,
              top: zone.top + zone.height - 58,
              minWidth: 140,
            }}
          >
            <div className="text-[10px] uppercase tracking-[0.24em] text-cyan-300/80">
              {cluster.label}
            </div>
            <div className="mt-1 text-[11px] text-slate-200">
              {cluster.role_labels.join(" • ")}
            </div>
          </div>
        );
      })}

      {planView.activePlan && (
        <div className="absolute top-4 right-4 w-[360px] rounded-2xl border border-cyan-400/20 bg-[#08111f]/86 p-4 shadow-2xl shadow-black/35 backdrop-blur-xl">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-[0.24em] text-cyan-300/80">
                {t("phase3.executionOverlay.title")}
              </div>
              <div className="mt-1 text-sm font-semibold text-slate-100">
                {planView.activePlan.goal}
              </div>
            </div>
            <div className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase text-slate-300">
              {planView.activePlan.status}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-300">
            <span>{t("phase3.executionOverlay.approvals", { count: approvalCount })}</span>
            <span className="h-1 w-1 rounded-full bg-slate-500" />
            <span>{t("phase3.executionOverlay.participants", { count: planView.meeting.participants.length })}</span>
          </div>

          <div className="mt-4 overflow-auto rounded-xl border border-white/6 bg-[#040916] p-3">
            <div
              className="relative"
              style={{
                width: graphWidth,
                height: graphHeight,
              }}
            >
              <svg className="absolute inset-0">
                {planView.execution.edges.map((edge) => {
                  const from = planView.execution.nodes.find((node) => node.step_id === edge.from_step_id);
                  const to = planView.execution.nodes.find((node) => node.step_id === edge.to_step_id);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={`${edge.from_step_id}-${edge.to_step_id}`}
                      d={`M ${from.x + 96} ${from.y + 24} C ${from.x + 132} ${from.y + 24}, ${to.x - 24} ${to.y + 24}, ${to.x} ${to.y + 24}`}
                      fill="none"
                      stroke={edgeColor(edge.state)}
                      strokeWidth="2"
                    />
                  );
                })}
              </svg>

              {planView.execution.nodes.map((node) => (
                <div
                  key={node.step_id}
                  className="absolute w-[112px] rounded-xl border border-white/8 bg-[#0b1220] px-3 py-2 shadow-lg shadow-black/30"
                  style={{
                    left: node.x,
                    top: node.y,
                    boxShadow: `0 0 0 1px ${nodeColor(node.status)}22, 0 14px 24px rgba(2,6,23,0.55)`,
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: nodeColor(node.status) }}
                    />
                    <span className="text-[9px] uppercase tracking-[0.18em] text-slate-400">
                      {node.lane_label}
                    </span>
                  </div>
                  <div className="mt-2 text-[11px] font-semibold leading-snug text-slate-100">
                    {node.label}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400">
                    {node.assigned_role_label ?? t("phase3.executionOverlay.unassigned")}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
