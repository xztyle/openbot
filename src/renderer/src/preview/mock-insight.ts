// The insight views of the preview: one report with a goal of each kind, a week of money and costs,
// and the briefing settings, kept in memory so the actions change what the view shows.
import {
  DEFAULT_INSIGHT_BRIEFING,
  type WorkspaceInsight,
  type WorkspaceInsightAction,
  type WorkspaceWhySlow,
  type WorkspaceWhySlowInput,
} from "@openbot/contracts/ipc";

const DAY = 86_400_000;

function day(offset: number): string {
  return new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
}

function sampleReport(): WorkspaceInsight {
  const now = Date.now();
  const days = Array.from({ length: 7 }, (_, index) => day(6 - index));
  return {
    at: now,
    days: 7,
    timeZone: "UTC",
    goals: [
      {
        id: "goal-sales",
        spaceId: "general",
        title: "Course sales this month",
        metric: "sales",
        target: 30,
        current: 9,
        deadline: day(-12),
        source: "hotmart-sales",
        product: null,
        agentIds: [],
        note: null,
        createdAt: new Date(now - 18 * DAY).toISOString(),
        updatedAt: new Date(now).toISOString(),
        history: days.map((date, index) => ({ date, value: 3 + index })),
        costUsd: 41.2,
      },
    ],
    costs: {
      days,
      totalUsd: 88.4,
      sideUsd: 1.2,
      idleUsd: 9.6,
      weekUsd: 88.4,
      previousWeekUsd: 70.1,
      agents: [],
    },
    money: days.flatMap((date, index) => [
      {
        id: `meta-general-${date}-USD`,
        spaceId: "general",
        date,
        kind: "spend" as const,
        amount: 18 + index,
        currency: "USD",
        sales: null,
        product: null,
        source: "meta" as const,
        note: null,
        updatedAt: new Date(now).toISOString(),
      },
      {
        id: `hotmart-general-${date}-USD`,
        spaceId: "general",
        date,
        kind: "revenue" as const,
        amount: index % 2 ? 27 : 0,
        currency: "USD",
        sales: index % 2,
        product: null,
        source: "hotmart" as const,
        note: null,
        updatedAt: new Date(now).toISOString(),
      },
    ]),
    sources: [
      { spaceId: "general", kind: "meta", state: "ready", detail: null, syncedAt: new Date(now).toISOString() },
      { spaceId: "general", kind: "hotmart", state: "ready", detail: null, syncedAt: new Date(now).toISOString() },
    ],
    alerts: [],
    briefing: {
      settings: { ...DEFAULT_INSIGHT_BRIEFING, timeZone: "UTC" },
      channelId: null,
      lastSentAt: null,
      lastText: null,
      routines: [],
    },
  };
}

export function createMockInsight() {
  let report = sampleReport();
  return {
    workspaceInsight: async (): Promise<WorkspaceInsight> => structuredClone(report),
    workspaceInsightAction: async (action: WorkspaceInsightAction): Promise<WorkspaceInsight> => {
      if (action.kind === "briefing-save")
        report = { ...report, briefing: { ...report.briefing, settings: action.settings } };
      if (action.kind === "goal-remove")
        report = { ...report, goals: report.goals.filter((goal) => goal.id !== action.goalId) };
      return structuredClone(report);
    },
    workspaceWhySlow: async (input: WorkspaceWhySlowInput): Promise<WorkspaceWhySlow> => {
      const now = Date.now();
      return {
        agentId: input.agentId,
        startedAt: now - 25 * 60_000,
        endedAt: null,
        queueAhead: 0,
        segments: [
          { kind: "queued", startAt: now - 25 * 60_000, endAt: now - 22 * 60_000, detail: null },
          { kind: "running", startAt: now - 22 * 60_000, endAt: null, detail: null },
          { kind: "teammate", startAt: now - 15 * 60_000, endAt: null, detail: "Waiting for the designer's mockups" },
        ],
      };
    },
  };
}
