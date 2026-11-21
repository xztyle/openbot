import type { DatabaseSync } from "node:sqlite";
import type { AgentSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { modelTier } from "../agent/model-policy";
import { estimateUsageCost } from "../agent/usage-pricing";
import { databaseRows, optionalNumberColumn, requiredStringColumn } from "../database/database-rows";

const DAYS = 7;

/** What the automatic model policy did in the last week, from the usage records. */
export interface ModelSavings {
  days: number;
  /** The turns of the agents' own work. */
  turns: number;
  /** Those of agents on the automatic policy now. */
  autoTurns: number;
  /** The turns of those agents that ran on the small model. */
  smallTurns: number;
  costUsd: number;
  /** What the turns of the automatic agents would have cost on each agent's own model. */
  fixedCostUsd: number;
}

interface Row {
  agent_id: string;
  turn_id: string;
  session_id: string;
  provider: string;
  model: string;
  tokens_json: string;
  estimated_cost_usd: number | null;
}

/** The background work of an agent (gate, condensing, reviews) is not a turn of its own work. */
const BACKGROUND = /^(gate|condense|memory-review|profile|side):/u;

export function modelSavings(db: DatabaseSync, agents: readonly AgentSummary[], now = Date.now()): ModelSavings {
  const since = new Date(now - DAYS * 24 * 60 * 60_000).toISOString();
  const rawRows = db
    .prepare(
      `SELECT agent_id, turn_id, session_id, provider, model, tokens_json, estimated_cost_usd
         FROM agent_usage_records WHERE occurred_at >= ?`,
    )
    .all(since);
  const rows: Row[] = databaseRows(rawRows).map((row) => ({
    agent_id: requiredStringColumn(row, "agent_id"),
    turn_id: requiredStringColumn(row, "turn_id"),
    session_id: requiredStringColumn(row, "session_id"),
    provider: requiredStringColumn(row, "provider"),
    model: requiredStringColumn(row, "model"),
    tokens_json: requiredStringColumn(row, "tokens_json"),
    estimated_cost_usd: optionalNumberColumn(row, "estimated_cost_usd"),
  }));
  const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
  const turns = new Map<string, { auto: boolean; small: boolean }>();
  let costUsd = 0;
  let fixedCostUsd = 0;
  for (const row of rows) {
    if (BACKGROUND.test(row.session_id)) continue;
    const agent = byId.get(row.agent_id);
    const auto = agent?.modelPolicy === "auto";
    const cost = row.estimated_cost_usd ?? 0;
    costUsd += cost;
    if (auto && agent && row.model !== agent.model) {
      try {
        const parsed = readJson(row.tokens_json);
        const tokens = isDynamicRecord(parsed) ? parsed : {};
        const number = (key: string) => (typeof tokens[key] === "number" ? tokens[key] : 0);
        const priced = estimateUsageCost(
          row.provider,
          agent.model,
          {
            uncachedInput: number("uncachedInput"),
            cachedInput: number("cachedInput"),
            cacheCreation: number("cacheCreation"),
            output: number("output"),
          },
          null,
        ).cost;
        fixedCostUsd += priced ?? cost;
      } catch {
        fixedCostUsd += cost;
      }
    } else if (auto) fixedCostUsd += cost;
    const key = `${row.agent_id}:${row.turn_id}`;
    const turn = turns.get(key) ?? { auto, small: true };
    // A turn is small only when each of its records is: Claude reports a small model beside a large one.
    turn.small = turn.small && modelTier(row.model) === "small";
    turns.set(key, turn);
  }
  const all = [...turns.values()];
  const automatic = all.filter((turn) => turn.auto);
  return {
    days: DAYS,
    turns: all.length,
    autoTurns: automatic.length,
    smallTurns: automatic.filter((turn) => turn.small).length,
    costUsd: Math.round(costUsd * 100) / 100,
    fixedCostUsd: Math.round(fixedCostUsd * 100) / 100,
  };
}

/** The JSON object of `text`, or an empty record for any other value. */
function readJson(text: string): DynamicRecord {
  const value = JSON.parse(text);
  return isDynamicRecord(value) ? value : {};
}
