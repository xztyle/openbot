import { analyticsDate, type InsightAgentCost, type InsightCosts } from "@openbot/contracts/ipc";
import type { InsightUsageRow } from "../database/insight-queries";

const DAY_MS = 86_400_000;

/** The kind of work a usage record paid for, from the prefix of its session id. */
export type UsageWork = "turn" | "routine" | "side";

/** The side calls: the channel answer gate, the reply condenser and the background memory reviews. */
const SIDE_PREFIXES = ["gate:", "condense:", "memory-review:"];

export function usageWork(sessionId: string): UsageWork {
  if (SIDE_PREFIXES.some((prefix) => sessionId.startsWith(prefix))) return "side";
  return sessionId.startsWith("routine") ? "routine" : "turn";
}

/** The `days` local calendar days that end today in `timeZone`, oldest first. */
export function reportDays(days: number, timeZone: string, now: number): string[] {
  const today = analyticsDate(new Date(now), timeZone);
  const noon = Date.parse(`${today}T12:00:00Z`);
  return Array.from({ length: days }, (_, index) =>
    new Date(noon - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10),
  );
}

/** The usage reads cover these instants: a day early and a day late, so every zone's days are inside. */
export function usageWindow(days: readonly string[]): { since: string; until: string } {
  const first = days[0] ?? new Date().toISOString().slice(0, 10);
  const last = days.at(-1) ?? first;
  return {
    since: new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS).toISOString(),
    until: new Date(Date.parse(`${last}T00:00:00Z`) + 2 * DAY_MS).toISOString(),
  };
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * The cost of each agent over `days` (and the last two weeks, for the weekly line), from the usage
 * records. A turn is idle when its own records cost something and no answer of it was stored: the
 * work left no message for a person or a channel. Side calls never count as turns.
 */
export function computeCosts(input: {
  rows: readonly InsightUsageRow[];
  /** The ids of the turns that left an answer. */
  answered: ReadonlySet<string>;
  days: readonly string[];
  timeZone: string;
  now: number;
  spaceOf: (agentId: string) => string;
}): InsightCosts {
  const index = new Map(input.days.map((day, position) => [day, position]));
  const agents = new Map<string, InsightAgentCost & { turnCosts: Map<string, number> }>();
  const weekStart = input.now - 7 * DAY_MS;
  const previousStart = input.now - 14 * DAY_MS;
  let weekUsd = 0;
  let previousWeekUsd = 0;
  for (const row of input.rows) {
    const cost = row.costUsd ?? 0;
    const at = Date.parse(row.occurredAt);
    if (at >= weekStart) weekUsd += cost;
    else if (at >= previousStart) previousWeekUsd += cost;
    const position = index.get(analyticsDate(new Date(at), input.timeZone));
    if (position === undefined) continue;
    let agent = agents.get(row.agentId);
    if (!agent) {
      agent = {
        agentId: row.agentId,
        spaceId: input.spaceOf(row.agentId),
        costUsd: 0,
        tokens: 0,
        turns: 0,
        idleTurns: 0,
        idleCostUsd: 0,
        sideCostUsd: 0,
        routineCostUsd: 0,
        daily: input.days.map(() => 0),
        turnCosts: new Map(),
      };
      agents.set(row.agentId, agent);
    }
    agent.costUsd += cost;
    agent.tokens += row.tokens;
    agent.daily[position] = (agent.daily[position] ?? 0) + cost;
    const work = usageWork(row.sessionId);
    if (work === "side") {
      agent.sideCostUsd += cost;
      continue;
    }
    if (work === "routine") agent.routineCostUsd += cost;
    agent.turnCosts.set(row.turnId, (agent.turnCosts.get(row.turnId) ?? 0) + cost);
  }
  let totalUsd = 0;
  let sideUsd = 0;
  let idleUsd = 0;
  const list: InsightAgentCost[] = [];
  for (const { turnCosts, ...agent } of agents.values()) {
    agent.turns = turnCosts.size;
    for (const [turnId, cost] of turnCosts) {
      if (cost <= 0 || input.answered.has(turnId)) continue;
      agent.idleTurns += 1;
      agent.idleCostUsd += cost;
    }
    totalUsd += agent.costUsd;
    sideUsd += agent.sideCostUsd;
    idleUsd += agent.idleCostUsd;
    list.push({
      ...agent,
      costUsd: round(agent.costUsd),
      idleCostUsd: round(agent.idleCostUsd),
      sideCostUsd: round(agent.sideCostUsd),
      routineCostUsd: round(agent.routineCostUsd),
      daily: agent.daily.map(round),
    });
  }
  list.sort((a, b) => b.costUsd - a.costUsd || a.agentId.localeCompare(b.agentId));
  return {
    days: [...input.days],
    totalUsd: round(totalUsd),
    sideUsd: round(sideUsd),
    idleUsd: round(idleUsd),
    weekUsd: round(weekUsd),
    previousWeekUsd: round(previousWeekUsd),
    agents: list,
  };
}

/**
 * The cost of a goal's team: the agents it names and every agent that reports to them, or every
 * agent of its space when it names none.
 */
export function goalTeam(
  goal: { spaceId: string; agentIds: readonly string[] },
  agents: readonly { id: string; reportsTo: string | null; spaceId: string }[],
): Set<string> {
  if (goal.agentIds.length === 0)
    return new Set(agents.filter((agent) => agent.spaceId === goal.spaceId).map((agent) => agent.id));
  const team = new Set(goal.agentIds);
  for (let changed = true; changed; ) {
    changed = false;
    for (const agent of agents)
      if (!team.has(agent.id) && agent.reportsTo && team.has(agent.reportsTo)) {
        team.add(agent.id);
        changed = true;
      }
  }
  return team;
}
