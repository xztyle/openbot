import type {
  AgentAttentionItem,
  InsightSlowSegment,
  WorkspaceWhySlow,
  WorkspaceWhySlowInput,
} from "@openbot/contracts/ipc";
import { INSIGHT_SLOW_SEGMENT_LIMIT } from "@openbot/contracts/ipc";
import type { InsightDeliveryRow, InsightQueries } from "../database/insight-queries";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled"]);

function time(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function short(text: string, limit = 160): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

export interface WhySlowSources {
  queries: Pick<InsightQueries, "agentDeliveries" | "channelRequestDeliveries" | "queuedBefore" | "turn" | "waits">;
  attention: () => readonly AgentAttentionItem[];
  /** The plan limit that holds the agent now, as the usage gate answers. */
  usageLimit: (agentId: string) => { resetsAt: number | null } | null;
  agentName: (agentId: string) => string | null;
  now: () => number;
}

/** The deliveries of the request: the attempts of a channel request, or the agent's current work. */
function attempts(sources: WhySlowSources, input: WorkspaceWhySlowInput): InsightDeliveryRow[] {
  if (input.channelId && input.messageId) {
    const rows = sources.queries
      .channelRequestDeliveries(input.channelId, input.messageId)
      .filter((row) => row.agentId === input.agentId);
    if (rows.length > 0) return rows;
  }
  const latest = sources.queries.agentDeliveries(input.agentId, 20);
  // The work that runs now, else the oldest that waits, else the last one.
  const open =
    latest.find((row) => row.status === "running" || row.status === "starting") ??
    latest.filter((row) => row.status === "queued").at(-1) ??
    latest[0];
  return open ? [open] : [];
}

/**
 * Where the time of one request went: how long it waited in the agent's queue, how long it ran, when
 * it waited for a teammate or for the owner, a plan limit that holds it, and each attempt that failed.
 * It reads stored rows only and calls no model.
 */
export function whySlow(sources: WhySlowSources, input: WorkspaceWhySlowInput): WorkspaceWhySlow {
  const now = sources.now();
  const rows = attempts(sources, input);
  const segments: InsightSlowSegment[] = [];
  let endedAt: number | null = null;
  let open = false;
  for (const row of rows) {
    const created = time(row.createdAt) ?? now;
    const turn = row.turnId ? sources.queries.turn(row.turnId) : null;
    const started = time(turn?.startedAt);
    const sender = row.senderAgentId ? sources.agentName(row.senderAgentId) : null;
    segments.push({
      kind: "queued",
      startAt: created,
      endAt: started ?? (TERMINAL.has(row.status) ? created : null),
      detail: sender ? `from ${sender}` : null,
    });
    if (started === null) {
      if (!TERMINAL.has(row.status)) open = true;
      continue;
    }
    const completed = time(turn?.completedAt);
    segments.push({ kind: "running", startAt: started, endAt: completed, detail: null });
    if (completed === null) open = true;
    for (const wait of sources.queries.waits(row.deliveryId)) {
      const from = time(wait.createdAt);
      if (from === null) continue;
      const until = time(wait.wokenAt);
      if (until === null) open = true;
      segments.push({ kind: "teammate", startAt: from, endAt: until, detail: short(wait.note) || null });
    }
    if (row.turnId) {
      for (const item of sources.attention()) {
        if (item.agentId !== input.agentId || item.turnId !== row.turnId) continue;
        open = true;
        segments.push({
          kind: "owner",
          startAt: time(item.createdAt) ?? now,
          endAt: null,
          detail: item.summary ? short(item.summary) : item.kind,
        });
      }
    }
    if (row.status === "failed" || row.status === "interrupted") {
      const at = completed ?? started;
      segments.push({ kind: "failed", startAt: at, endAt: at, detail: row.status });
    }
    if (completed !== null) endedAt = Math.max(endedAt ?? 0, completed);
  }
  const limit = sources.usageLimit(input.agentId);
  if (limit && open)
    segments.push({
      kind: "blocked",
      startAt: now,
      endAt: null,
      detail: limit.resetsAt ? `plan limit until ${new Date(limit.resetsAt).toISOString()}` : "plan limit",
    });
  const last = rows.at(-1);
  const queueAhead = last && last.status === "queued" ? sources.queries.queuedBefore(input.agentId, last.createdAt) : 0;
  segments.sort((a, b) => a.startAt - b.startAt);
  return {
    agentId: input.agentId,
    startedAt: rows[0] ? (time(rows[0].createdAt) ?? null) : null,
    endedAt: open ? null : endedAt,
    queueAhead,
    segments: segments.slice(-INSIGHT_SLOW_SEGMENT_LIMIT).map((segment) => ({
      ...segment,
      startAt: Math.max(0, Math.round(segment.startAt)),
      endAt: segment.endAt === null ? null : Math.max(0, Math.round(segment.endAt)),
    })),
  };
}
