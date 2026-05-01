import type { AgentDashboardTab } from "../services/agentApi";
import {
  DASHBOARD_SECTION_CONTEXT,
  DASHBOARD_SECTION_PRIMARY,
  DASHBOARD_SECTION_PRIORITY,
  DASHBOARD_SECTION_SECONDARY,
  DASHBOARD_WIDGET_APPROVAL_QUEUE,
  DASHBOARD_WIDGET_EXECUTION_GRAPH,
  DASHBOARD_WIDGET_MEETING_BRIEF,
  DASHBOARD_WIDGET_ORG_CHART,
} from "../constants";
import type { Agent } from "../types/agent";
import type { RuntimePlanView } from "./runtimePlan";

export type DashboardSection = {
  id: string;
  title: string;
  widget_ids: string[];
};

const WIDGET_ALIASES: Record<string, string> = {
  approval: DASHBOARD_WIDGET_APPROVAL_QUEUE,
  approvals: DASHBOARD_WIDGET_APPROVAL_QUEUE,
  graph: DASHBOARD_WIDGET_EXECUTION_GRAPH,
  execution_dag: DASHBOARD_WIDGET_EXECUTION_GRAPH,
  meeting: DASHBOARD_WIDGET_MEETING_BRIEF,
  org: DASHBOARD_WIDGET_ORG_CHART,
  logs: "deploy_log",
};

function normalizeWidgetId(widgetId: string): string {
  const normalized = widgetId.trim().toLowerCase();
  return WIDGET_ALIASES[normalized] ?? normalized;
}

function humanize(value: string): string {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function hasWidget(tabs: AgentDashboardTab[], widgetId: string): boolean {
  return tabs.some((tab) => tab.id === widgetId);
}

function placeholderTab(widgetId: string): AgentDashboardTab {
  return {
    id: widgetId,
    label: humanize(widgetId),
    data: {},
  };
}

function runtimeTab(
  widgetId: string,
  planView: RuntimePlanView,
): AgentDashboardTab | null {
  if (widgetId === DASHBOARD_WIDGET_EXECUTION_GRAPH) {
    if (!planView.activePlan) return null;
    return {
      id: widgetId,
      label: "Execution Graph",
      data: {
        goal: planView.activePlan.goal,
        plan_status: planView.activePlan.status,
        lanes: planView.execution.lanes,
        nodes: planView.execution.nodes,
        edges: planView.execution.edges,
      },
    };
  }

  if (widgetId === DASHBOARD_WIDGET_APPROVAL_QUEUE) {
    if (planView.approvalQueue.length === 0) return null;
    return {
      id: widgetId,
      label: "Approval Queue",
      data: {
        items: planView.approvalQueue,
      },
    };
  }

  if (widgetId === DASHBOARD_WIDGET_MEETING_BRIEF) {
    if (planView.meeting.participants.length === 0) return null;
    return {
      id: widgetId,
      label: "Meeting Brief",
      data: {
        layout: planView.meeting.layout,
        participants: planView.meeting.participants,
      },
    };
  }

  if (widgetId === DASHBOARD_WIDGET_ORG_CHART) {
    if (planView.org.clusters.length === 0) return null;
    return {
      id: widgetId,
      label: "Org Chart",
      data: {
        clusters: planView.org.clusters,
        edges: planView.org.edges,
      },
    };
  }

  return null;
}

export function mergeRuntimeDashboardTabs(
  baseTabs: AgentDashboardTab[],
  agent: Agent,
  planView: RuntimePlanView | null,
): AgentDashboardTab[] {
  const nextTabs = [...baseTabs];
  const desiredWidgets = [
    ...(agent.uiProfile?.primary_widgets ?? []),
    ...(agent.uiProfile?.secondary_widgets ?? []),
  ]
    .map(normalizeWidgetId)
    .filter(Boolean);

  for (const widgetId of desiredWidgets) {
    if (!hasWidget(nextTabs, widgetId)) {
      nextTabs.push(placeholderTab(widgetId));
    }
  }

  if (planView) {
    for (const widgetId of [
      DASHBOARD_WIDGET_EXECUTION_GRAPH,
      DASHBOARD_WIDGET_APPROVAL_QUEUE,
      DASHBOARD_WIDGET_MEETING_BRIEF,
      DASHBOARD_WIDGET_ORG_CHART,
    ]) {
      const tab = runtimeTab(widgetId, planView);
      if (!tab) continue;
      const existingIndex = nextTabs.findIndex((row) => row.id === widgetId);
      if (existingIndex >= 0) {
        nextTabs[existingIndex] = tab;
      } else {
        nextTabs.push(tab);
      }
    }
  }

  return [...new Map(nextTabs.map((tab) => [tab.id, tab])).values()];
}

function pickExistingWidgets(
  tabs: AgentDashboardTab[],
  requestedWidgetIds: string[],
  seen: Set<string>,
): string[] {
  const available = new Set(tabs.map((tab) => tab.id));
  const picked: string[] = [];
  for (const widgetId of requestedWidgetIds.map(normalizeWidgetId)) {
    if (!available.has(widgetId) || seen.has(widgetId)) continue;
    picked.push(widgetId);
    seen.add(widgetId);
  }
  return picked;
}

export function buildDashboardSections(
  tabs: AgentDashboardTab[],
  agent: Agent,
  planView: RuntimePlanView | null,
): DashboardSection[] {
  const seen = new Set<string>();
  const sections: DashboardSection[] = [];

  const priorityWidgetIds = pickExistingWidgets(
    tabs,
    [
      planView?.approvalQueue.length ? DASHBOARD_WIDGET_APPROVAL_QUEUE : "",
      planView?.activePlan ? DASHBOARD_WIDGET_EXECUTION_GRAPH : "",
      planView?.meeting.participants.length ? DASHBOARD_WIDGET_MEETING_BRIEF : "",
    ].filter(Boolean),
    seen,
  );
  if (priorityWidgetIds.length > 0) {
    sections.push({
      id: DASHBOARD_SECTION_PRIORITY,
      title: "Priority",
      widget_ids: priorityWidgetIds,
    });
  }

  const primaryWidgetIds = pickExistingWidgets(
    tabs,
    agent.uiProfile?.primary_widgets ?? [],
    seen,
  );
  if (primaryWidgetIds.length > 0) {
    sections.push({
      id: DASHBOARD_SECTION_PRIMARY,
      title: "Primary",
      widget_ids: primaryWidgetIds,
    });
  }

  const secondaryWidgetIds = pickExistingWidgets(
    tabs,
    agent.uiProfile?.secondary_widgets ?? [],
    seen,
  );
  if (secondaryWidgetIds.length > 0) {
    sections.push({
      id: DASHBOARD_SECTION_SECONDARY,
      title: "Secondary",
      widget_ids: secondaryWidgetIds,
    });
  }

  const contextWidgetIds = pickExistingWidgets(
    tabs,
    [DASHBOARD_WIDGET_ORG_CHART, "alerts", "deploy_log", "logs"],
    seen,
  );
  if (contextWidgetIds.length > 0) {
    sections.push({
      id: DASHBOARD_SECTION_CONTEXT,
      title: "Context",
      widget_ids: contextWidgetIds,
    });
  }

  return sections;
}
