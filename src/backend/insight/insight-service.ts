import { randomUUID } from "node:crypto";
import type { SpaceDecision } from "@openbot/contracts/agent-learning";
import {
  type AgentAttentionItem,
  type AgentSummary,
  analyticsDate,
  CHANNEL_DECISION_PREFIX,
  type Channel,
  type ChannelMessage,
  GENERAL_SPACE_ID,
  INSIGHT_GOAL_HISTORY_LIMIT,
  INSIGHT_GOAL_LIMIT,
  INSIGHT_MONEY_ENTRY_LIMIT,
  type InsightAlertKind,
  type InsightBriefingSettings,
  type InsightDataSource,
  type InsightGoal,
  type InsightMoneyEntry,
  type InsightRoutineReport,
  insightGoalPace,
  type Routine,
  type WorkspaceArtifactRecord,
  type WorkspaceInsight,
  type WorkspaceInsightAction,
  type WorkspaceInsightInput,
  type WorkspaceSpace,
  type WorkspaceWhySlow,
  type WorkspaceWhySlowInput,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result, Schema } from "effect";
import type { InsightQueries } from "../database/insight-queries";
import {
  type BriefingFacts,
  briefingPrompt,
  checkedBriefing,
  goalFact,
  moneyText,
  plainBriefing,
} from "./insight-briefing";
import { computeCosts, goalTeam, reportDays, usageWindow } from "./insight-costs";
import {
  helperHome,
  hotmartMissing,
  type MoneyDay,
  type MoneyHelpers,
  metaMissing,
  readHotmartDay,
  readMetaSpend,
} from "./insight-money";
import type { InsightStore, StoredInsight, StoredInsightAlert } from "./insight-store";
import { whySlow } from "./insight-why-slow";

const logger = createOpenBotLogger("insight");

const DAY_MS = 86_400_000;
/** How often the host checks whether a briefing or a sync is due. */
const TICK_MS = 5 * 60_000;
/** The days a sync reads again: late conversions and refunds change the last days. */
const SYNC_DAYS = 7;
/** How late after its time a briefing still goes out, after the host was down. */
const BRIEFING_LATE_MINUTES = 4 * 60;
/** The deadline of the model that writes a briefing. The plain text goes out after it. */
const BRIEFING_MODEL_MS = 30_000;
/** A routine whose name says it reports. The briefing can replace it. */
const REPORT_ROUTINE =
  /\b(report|reporte|informe|resumen|summary|digest|briefing|status|estado|daily|diario|morning|ma[nñ]ana)\b/iu;

/** A change the owner can correct: its message is safe to show. */
export class InsightRefused extends Schema.TaggedError<InsightRefused>()("InsightRefused", {
  message: Schema.String,
}) {}

/** Runs an insight operation at a Promise boundary. A refused change rejects with its safe reason. */
export async function runInsightLocally<A>(operation: Effect.Effect<A, unknown>): Promise<A> {
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return result.success;
  if (result.failure instanceof InsightRefused) throw new Error(result.failure.message);
  throw result.failure instanceof Error ? result.failure : new Error("The insight operation failed.");
}

/** What the insight service reads and changes in the rest of the host. */
/** What the service needs of an agent. */
export type InsightAgent = Pick<AgentSummary, "id" | "name" | "reportsToAgentId" | "createdBy">;
/** What the service needs of a channel. */
export type InsightChannel = Pick<Channel, "id" | "name" | "archived">;

export interface InsightServiceOptions {
  store: InsightStore;
  queries: Pick<
    InsightQueries,
    | "usage"
    | "answeredTurns"
    | "deliveriesSince"
    | "agentDeliveries"
    | "channelRequestDeliveries"
    | "queuedBefore"
    | "turn"
    | "waits"
  >;
  agents: () => readonly InsightAgent[];
  spaces: () => readonly WorkspaceSpace[];
  agentSpaceId: (agentId: string) => string;
  channelSpaceId: (channelId: string) => string;
  sharedDirectory: (space: WorkspaceSpace) => string;
  placeChannel: (channelId: string, spaceId: string) => void;
  channels: {
    exists: (channelId: string) => boolean;
    get: (channelId: string) => InsightChannel;
    ids: () => readonly string[];
    decisions: (channelId: string) => readonly ChannelMessage[];
    /** Makes a private channel with the owner as its only person. */
    createPrivate: (input: {
      channelId: string;
      name: string;
      description: string;
      owner: { id: string; name: string };
    }) => Effect.Effect<unknown, unknown>;
    /** False when the channel is gone or archived. */
    postNotice: (channelId: string, name: string, text: string) => boolean;
  };
  attention: () => readonly AgentAttentionItem[];
  usageLimit: (agentId: string) => { resetsAt: number | null } | null;
  routines: {
    list: (agentId: string) => readonly Routine[];
    setActive: (agentId: string, routineId: string, active: boolean) => void;
  };
  artifacts: () => readonly WorkspaceArtifactRecord[];
  /** The owner of this host: the person the briefing is for. */
  owner: () => { id: string; name: string } | null;
  /** The cheap model (the workspace gate model) writes the briefing. */
  generate: (prompt: string, deadline: number) => Effect.Effect<string, unknown>;
  helpers: MoneyHelpers | null;
  /** Motion, the team's work board, for the tickets of the briefing. Null when it is not connected. */
  motion: (() => { baseUrl: string; token: string } | null) | null;
  /** The zone of the host, until the owner's zone is saved. */
  hostTimeZone: () => string;
  /** The loop decisions that wait for the owner (`LoopService.pendingDecisions`). */
  loopDecisions?: () => readonly { spaceId: string; title: string; amountUsd?: number | undefined }[];
  /** The pushes that quiet hours or focus held back (`OwnerAwayService.state().suppressed`). */
  heldNotifications?: () => number;
  /**
   * The newest entries of a space's decision log (`SpaceKnowledgeStore.recentDecisions`): what agents
   * decided with `log_decision`, also where no channel shows it.
   */
  loggedDecisions?: (spaceId: string) => Effect.Effect<readonly SpaceDecision[], unknown>;
}

function localClock(now: number, timeZone: string): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const part = (type: string) => Number(parts.find((value) => value.type === type)?.value ?? 0);
  return { date: analyticsDate(new Date(now), timeZone), minutes: part("hour") * 60 + part("minute") };
}

function safeZone(zone: string, fallback: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return fallback;
  }
}

function dayOffset(date: string, days: number): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Goals, money, costs and the daily briefing of the host (`ipc-workspace-insight.ts`). It reads what
 * the host stores and the two money helpers; it never wakes an agent. One cheap-model call writes
 * each briefing, and the plain text goes out when that call fails.
 */
export class InsightService {
  readonly #options: InsightServiceOptions;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;
  #syncing: Promise<void> | null = null;

  constructor(options: InsightServiceOptions) {
    this.#options = options;
  }

  get #state(): Readonly<StoredInsight> {
    return this.#options.store.state;
  }

  /** Loads the file and starts the clock of the briefing and the daily sync. */
  readonly start = Effect.fn("InsightService.start")(function* (this: InsightService) {
    yield* this.#options.store.load();
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tickLater(), TICK_MS);
    this.#timer.unref?.();
    // The first check waits a little, so a restart does not race the agents' own start.
    setTimeout(() => this.#tickLater(), 60_000).unref?.();
  });

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  #tickLater(): void {
    if (this.#busy) return;
    this.#busy = true;
    void Effect.runPromise(
      this.tick().pipe(
        Effect.catchCause((cause) => Effect.sync(() => logger.warn("The insight check failed.", { cause }))),
      ),
    ).finally(() => {
      this.#busy = false;
    });
  }

  #zone(): string {
    const host = safeZone(this.#options.hostTimeZone(), "UTC");
    if (this.#state.briefing.timeZone) return safeZone(this.#state.briefing.timeZone, host);
    // No reader saved a zone yet: the zone most of the owner's routines use is theirs, more often
    // than the server's own, which is UTC on most servers.
    const zones = new Map<string, number>();
    for (const agent of this.#options.agents())
      for (const routine of this.#options.routines.list(agent.id))
        if (routine.timezone && routine.timezone !== "UTC")
          zones.set(routine.timezone, (zones.get(routine.timezone) ?? 0) + 1);
    const common = [...zones].sort((a, b) => b[1] - a[1])[0]?.[0];
    return common ? safeZone(common, host) : host;
  }

  /** The daily work: the money sync after 06:00, the goals and alerts, and the briefings that are due. */
  readonly tick = Effect.fn("InsightService.tick")(function* (this: InsightService) {
    const now = Date.now();
    const settings = this.#state.briefing;
    const clock = localClock(now, this.#zone());
    const [hour = 8, minute = 0] = settings.time.split(":").map(Number);
    const due = hour * 60 + minute;
    if (this.#state.syncedDay !== clock.date && clock.minutes >= Math.min(due - 30, 6 * 60)) {
      yield* this.#sync(undefined);
      yield* this.#options.store.change((draft) => {
        draft.syncedDay = clock.date;
      });
    }
    yield* this.#refreshGoalsAndAlerts(now);
    // A host that was down at the time sends the briefing when it comes back, but not after noon of a
    // morning briefing: an old summary late in the day is noise. The next day's goes out as usual.
    if (!settings.enabled || clock.minutes < due || clock.minutes > due + BRIEFING_LATE_MINUTES) return;
    for (const scope of this.#scopes(settings)) {
      if (this.#state.sentDays[scope] === clock.date) continue;
      yield* this.#sendBriefing(scope === "all" ? null : scope, clock.date);
    }
  });

  #scopes(settings: InsightBriefingSettings): string[] {
    const known = new Set(this.#options.spaces().map((space) => space.id));
    return [...(settings.allSpaces ? ["all"] : []), ...settings.spaceIds.filter((id) => known.has(id))];
  }

  // ---------- reading ----------

  readonly read = Effect.fn("InsightService.read")(function* (this: InsightService, input: WorkspaceInsightInput) {
    yield* this.#options.store.load();
    // The first reader of the view is the owner or an admin: their zone and language become the
    // briefing's until someone saves the settings.
    const briefing = this.#state.briefing;
    if (!briefing.timeZone && input.timeZone) {
      const zone = safeZone(input.timeZone, "");
      const language = input.language?.toLowerCase().startsWith("en") ? "en" : "es";
      if (zone)
        yield* this.#options.store.change((draft) => {
          draft.briefing = { ...draft.briefing, timeZone: zone, language };
        });
    }
    return this.#report(input);
  });

  #report(input: WorkspaceInsightInput): WorkspaceInsight {
    const now = Date.now();
    const timeZone = safeZone(input.timeZone ?? this.#zone(), "UTC");
    const days = input.days ?? 7;
    const costs = this.#costs(days, timeZone, now);
    const agents = this.#options.agents();
    const org = agents.map((agent) => ({
      id: agent.id,
      reportsTo: agent.reportsToAgentId ?? agent.createdBy?.agentId ?? null,
      spaceId: this.#options.agentSpaceId(agent.id),
    }));
    const costOf = new Map(costs.agents.map((agent) => [agent.agentId, agent.costUsd]));
    const goals = this.#state.goals.map((goal) => {
      let cost = 0;
      for (const agentId of goalTeam(goal, org)) cost += costOf.get(agentId) ?? 0;
      return { ...goal, costUsd: round(cost) };
    });
    const first = costs.days[0] ?? analyticsDate(new Date(now), timeZone);
    // A week before the first day too, so the alerts' days are always there.
    const since = dayOffset(first, -7);
    return {
      at: now,
      days,
      timeZone,
      goals,
      costs,
      money: this.#state.money.filter((entry) => entry.date >= since),
      sources: this.#state.sources,
      alerts: this.#openAlerts(),
      briefing: {
        settings: this.#state.briefing,
        channelId: this.#state.channels.all ?? Object.values(this.#state.channels)[0] ?? null,
        lastSentAt: this.#state.lastSentAt,
        lastText: this.#state.lastText,
        routines: this.#reportRoutines(),
      },
    };
  }

  #costs(days: number, timeZone: string, now: number) {
    const list = reportDays(days, timeZone, now);
    const window = usageWindow(reportDays(Math.max(days, 15), timeZone, now));
    return computeCosts({
      rows: this.#options.queries.usage(window.since, window.until),
      answered: this.#options.queries.answeredTurns(window.since),
      days: list,
      timeZone,
      now,
      spaceOf: (agentId) => this.#options.agentSpaceId(agentId),
    });
  }

  #openAlerts() {
    return this.#state.alerts
      .filter((alert) => alert.dismissedAt === null)
      .map(({ id, spaceId, kind, text, createdAt }) => ({ id, spaceId, kind, text, createdAt }));
  }

  /** The routines that look like reports, and those the settings name. */
  #reportRoutines(): InsightRoutineReport[] {
    const named = new Set(this.#state.briefing.replaceRoutineIds);
    const paused = new Set(this.#state.pausedRoutineIds);
    return this.#options
      .agents()
      .flatMap((agent) => this.#options.routines.list(agent.id))
      .filter((routine) => named.has(routine.id) || paused.has(routine.id) || REPORT_ROUTINE.test(routine.name))
      .slice(0, 200)
      .map((routine) => ({
        routineId: routine.id,
        agentId: routine.agentId,
        name: routine.name.slice(0, 200) || routine.id,
        active: routine.active,
      }));
  }

  whySlow(input: WorkspaceWhySlowInput): WorkspaceWhySlow {
    return whySlow(
      {
        queries: this.#options.queries,
        attention: this.#options.attention,
        usageLimit: this.#options.usageLimit,
        agentName: (agentId) => this.#options.agents().find((agent) => agent.id === agentId)?.name ?? null,
        now: () => Date.now(),
      },
      input,
    );
  }

  // ---------- changes ----------

  readonly apply = Effect.fn("InsightService.apply")(function* (this: InsightService, action: WorkspaceInsightAction) {
    yield* this.#options.store.load();
    const now = new Date().toISOString();
    const today = analyticsDate(new Date(), this.#zone());
    const store = this.#options.store;
    switch (action.kind) {
      case "goal-save": {
        const draft = action.goal;
        if (!this.#options.spaces().some((space) => space.id === draft.spaceId))
          return yield* new InsightRefused({ message: "That space does not exist." });
        const existing = draft.id ? this.#state.goals.find((goal) => goal.id === draft.id) : undefined;
        if (draft.id && !existing) return yield* new InsightRefused({ message: "That goal does not exist." });
        if (!existing && this.#state.goals.length >= INSIGHT_GOAL_LIMIT)
          return yield* new InsightRefused({ message: `A host keeps at most ${INSIGHT_GOAL_LIMIT} goals.` });
        const current = draft.current ?? existing?.current ?? 0;
        const goal: InsightGoal = {
          id: existing?.id ?? `goal-${randomUUID()}`,
          spaceId: draft.spaceId,
          title: draft.title,
          metric: draft.metric,
          target: draft.target,
          current,
          deadline: draft.deadline,
          source: draft.source,
          product: draft.product ?? null,
          agentIds: draft.agentIds ?? [],
          note: existing?.note ?? null,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          history: withPoint(existing?.history ?? [], today, current),
        };
        yield* store.change((state) => {
          state.goals = existing
            ? state.goals.map((item) => (item.id === goal.id ? goal : item))
            : [...state.goals, goal];
        });
        if (goal.source !== "manual") yield* this.#refreshGoalsAndAlerts(Date.now());
        break;
      }
      case "goal-remove":
        yield* store.change((state) => {
          state.goals = state.goals.filter((goal) => goal.id !== action.goalId);
          state.alerts = state.alerts.filter((alert) => alert.key !== `goal-behind:${action.goalId}`);
        });
        break;
      case "goal-progress":
        yield* this.#setProgress(action.goalId, action.value, action.note ?? null);
        break;
      case "money-add": {
        const entry: InsightMoneyEntry = {
          id: `money-${randomUUID()}`,
          ...action.entry,
          sales: action.entry.sales ?? null,
          product: action.entry.product ?? null,
          note: action.entry.note ?? null,
          source: "manual",
          updatedAt: now,
        };
        yield* store.change((state) => {
          state.money = [...state.money, entry].slice(-INSIGHT_MONEY_ENTRY_LIMIT);
        });
        yield* this.#refreshGoalsAndAlerts(Date.now());
        break;
      }
      case "money-remove": {
        const entry = this.#state.money.find((item) => item.id === action.entryId);
        if (entry && entry.source !== "manual")
          return yield* new InsightRefused({
            message: "A synced row comes back with the next sync; it cannot be removed.",
          });
        yield* store.change((state) => {
          state.money = state.money.filter((item) => item.id !== action.entryId);
        });
        break;
      }
      case "money-sync":
        yield* this.#sync(action.spaceId);
        yield* this.#refreshGoalsAndAlerts(Date.now());
        break;
      case "alert-dismiss":
        yield* store.change((state) => {
          state.alerts = state.alerts.map((alert) =>
            alert.id === action.alertId ? { ...alert, dismissedAt: now } : alert,
          );
        });
        break;
      case "briefing-save":
        yield* this.#saveBriefing(action.settings);
        break;
      case "briefing-send":
        yield* this.#sendBriefing(action.spaceId ?? null, today);
        break;
    }
    return this.#report({ timeZone: this.#zone() });
  });

  readonly #setProgress = Effect.fn("InsightService.setProgress")(function* (
    this: InsightService,
    goalId: string,
    value: number,
    note: string | null,
  ) {
    const goal = this.#state.goals.find((item) => item.id === goalId);
    if (!goal) return yield* new InsightRefused({ message: "That goal does not exist." });
    const today = analyticsDate(new Date(), this.#zone());
    yield* this.#options.store.change((state) => {
      state.goals = state.goals.map((item) =>
        item.id === goalId
          ? {
              ...item,
              current: value,
              note: note ?? item.note,
              updatedAt: new Date().toISOString(),
              history: withPoint(item.history, today, value),
            }
          : item,
      );
    });
  });

  /**
   * Saves the briefing settings, and pauses the routine reports it replaces while it is on. A routine
   * it paused and no longer replaces is resumed; a routine someone else paused stays as it is.
   */
  readonly #saveBriefing = Effect.fn("InsightService.saveBriefing")(function* (
    this: InsightService,
    settings: InsightBriefingSettings,
  ) {
    const replace = new Set(settings.enabled ? settings.replaceRoutineIds : []);
    const paused = new Set(this.#state.pausedRoutineIds);
    const routines = this.#options.agents().flatMap((agent) => this.#options.routines.list(agent.id));
    for (const routine of routines) {
      if (replace.has(routine.id) && routine.active) {
        this.#options.routines.setActive(routine.agentId, routine.id, false);
        paused.add(routine.id);
      } else if (!replace.has(routine.id) && paused.has(routine.id)) {
        if (!routine.active) this.#options.routines.setActive(routine.agentId, routine.id, true);
        paused.delete(routine.id);
      }
    }
    yield* this.#options.store.change((state) => {
      state.briefing = { ...settings, timeZone: settings.timeZone ? safeZone(settings.timeZone, "") : "" };
      state.pausedRoutineIds = [...paused].filter((id) => routines.some((routine) => routine.id === id));
    });
  });

  // ---------- agents ----------

  /**
   * One compact line per goal of the agent's space, for its instructions. Only what changes rarely:
   * the progress is read with the goals tool, so a new number does not change the cached prompt.
   */
  goalLines(agentId: string): string[] {
    const spaceId = this.#options.agentSpaceId(agentId);
    return this.#state.goals
      .filter((goal) => goal.spaceId === spaceId)
      .slice(0, 8)
      .map(
        (goal) =>
          `${goal.title}: ${goal.target} ${goal.metric}${goal.deadline ? ` by ${goal.deadline}` : ""} (${goal.id}${goal.source === "manual" ? "" : `, ${goal.source}`})`,
      );
  }

  /** The goals tool: `list` the goals of the agent's space with their progress, or set one's `progress`. */
  readonly goalTool = Effect.fn("InsightService.goalTool")(function* (
    this: InsightService,
    agentId: string,
    input: {
      action: "list" | "progress";
      goalId?: string | undefined;
      value?: number | undefined;
      note?: string | undefined;
    },
  ) {
    yield* this.#options.store.load();
    const spaceId = this.#options.agentSpaceId(agentId);
    const now = Date.now();
    if (input.action === "progress") {
      const goal = this.#state.goals.find((item) => item.id === input.goalId && item.spaceId === spaceId);
      if (!goal || input.value === undefined)
        return yield* new InsightRefused({ message: "Name a goal of your space (goalId from list) and a value." });
      if (goal.source !== "manual")
        return yield* new InsightRefused({
          message: `This goal is read from ${goal.source} every day; its progress cannot be set by hand.`,
        });
      yield* this.#setProgress(goal.id, input.value, input.note?.slice(0, 200) ?? null);
    }
    return {
      goals: this.#state.goals
        .filter((goal) => goal.spaceId === spaceId)
        .map((goal) => ({
          id: goal.id,
          title: goal.title,
          metric: goal.metric,
          target: goal.target,
          current: goal.current,
          deadline: goal.deadline,
          source: goal.source,
          pace: insightGoalPace(goal, now),
          note: goal.note,
          updatedAt: goal.updatedAt,
        })),
    };
  });

  // ---------- money ----------

  #sync(spaceId: string | undefined): Effect.Effect<void> {
    // One sync at a time; a second request waits for the first and reads its result.
    return Effect.promise(() => {
      this.#syncing ??= Effect.runPromise(this.#syncNow(spaceId)).finally(() => {
        this.#syncing = null;
      });
      return this.#syncing;
    });
  }

  readonly #syncNow = Effect.fn("InsightService.syncNow")(function* (this: InsightService, only: string | undefined) {
    const helpers = this.#options.helpers;
    const spaces = this.#options.spaces().filter((space) => !only || space.id === only);
    const sources: InsightDataSource[] = [];
    const rows: InsightMoneyEntry[] = [];
    const today = analyticsDate(new Date(), this.#zone());
    const since = dayOffset(today, -(SYNC_DAYS - 1));
    const at = new Date().toISOString();
    for (const space of spaces) {
      const shared = this.#options.sharedDirectory(space);
      const metaHome = helperHome(shared, "meta-ads");
      const hotmartHome = helperHome(shared, "hotmart");
      if (!helpers) continue;
      // A space whose agents never set a helper up has no source, and no row says it is missing.
      if (metaHome) {
        const missing = metaMissing(helpers, metaHome);
        if (missing)
          sources.push({ spaceId: space.id, kind: "meta", state: "missing", detail: missing, syncedAt: null });
        else {
          const read = yield* Effect.result(readMetaSpend(helpers, metaHome, since, today));
          if (Result.isSuccess(read)) {
            sources.push({ spaceId: space.id, kind: "meta", state: "ready", detail: null, syncedAt: at });
            rows.push(...read.success.map((day) => synced(space.id, "spend", "meta", day, at)));
          } else
            sources.push({
              spaceId: space.id,
              kind: "meta",
              state: "error",
              detail: read.failure.detail,
              syncedAt: null,
            });
        }
      }
      if (hotmartHome) {
        const missing = hotmartMissing(helpers, hotmartHome);
        if (missing)
          sources.push({ spaceId: space.id, kind: "hotmart", state: "missing", detail: missing, syncedAt: null });
        else {
          let failure: string | null = null;
          for (let offset = SYNC_DAYS - 1; offset >= 0 && failure === null; offset -= 1) {
            const date = dayOffset(today, -offset);
            const read = yield* Effect.result(readHotmartDay(helpers, hotmartHome, date));
            if (Result.isSuccess(read)) {
              const days = read.success.length ? read.success : [{ date, amount: 0, currency: "USD", sales: 0 }];
              rows.push(...days.map((day) => synced(space.id, "revenue", "hotmart", day, at)));
            } else failure = read.failure.detail;
          }
          sources.push({
            spaceId: space.id,
            kind: "hotmart",
            state: failure ? "error" : "ready",
            detail: failure,
            syncedAt: failure ? null : at,
          });
        }
      }
    }
    yield* this.#options.store.change((state) => {
      const replaced = new Set(rows.map((row) => row.id));
      // A day that a source read again replaces its rows; a currency that day no longer has goes.
      const reread = new Set(rows.map((row) => `${row.source}:${row.spaceId}:${row.date}`));
      state.money = [
        ...state.money.filter(
          (entry) => !replaced.has(entry.id) && !reread.has(`${entry.source}:${entry.spaceId}:${entry.date}`),
        ),
        ...rows,
      ].slice(-INSIGHT_MONEY_ENTRY_LIMIT);
      const kept = state.sources.filter(
        (source) => !sources.some((next) => next.spaceId === source.spaceId && next.kind === source.kind),
      );
      state.sources = [...kept, ...sources].map((source) => {
        const previous = state.sources.find((item) => item.spaceId === source.spaceId && item.kind === source.kind);
        return source.state === "error" && previous?.syncedAt ? { ...source, syncedAt: previous.syncedAt } : source;
      });
    });
  });

  /**
   * Sets the goals that a source feeds from the synced rows, and raises or clears the alerts: spend
   * with no sale for the set days, a goal that falls behind, a source that fails.
   */
  readonly #refreshGoalsAndAlerts = Effect.fn("InsightService.refreshGoalsAndAlerts")(function* (
    this: InsightService,
    now: number,
  ) {
    const state = this.#state;
    const today = analyticsDate(new Date(now), this.#zone());
    const spaceName = (id: string) => this.#options.spaces().find((space) => space.id === id)?.name ?? id;
    const language = state.briefing.language;
    const goals = state.goals.map((goal) => {
      if (goal.source === "manual" || goal.source === "motion-closed") return goal;
      const from = goal.createdAt.slice(0, 10);
      const until = goal.deadline ?? today;
      const rows = state.money.filter(
        (entry) => entry.spaceId === goal.spaceId && entry.date >= from && entry.date <= until,
      );
      const value =
        goal.source === "hotmart-sales"
          ? rows.filter((row) => row.kind === "revenue").reduce((sum, row) => sum + (row.sales ?? 0), 0)
          : goal.source === "hotmart-revenue"
            ? rows.filter((row) => row.kind === "revenue").reduce((sum, row) => sum + row.amount, 0)
            : rows.filter((row) => row.kind === "spend").reduce((sum, row) => sum + row.amount, 0);
      const current = round(value);
      return current === goal.current ? goal : { ...goal, current, history: withPoint(goal.history, today, current) };
    });
    const wanted: Omit<StoredInsightAlert, "id" | "createdAt" | "dismissedAt">[] = [];
    const settings = state.briefing;
    const windowStart = dayOffset(today, -(settings.alertDays - 1));
    for (const space of this.#options.spaces()) {
      const recent = state.money.filter((entry) => entry.spaceId === space.id && entry.date >= windowStart);
      const spend = new Map<string, number>();
      for (const entry of recent)
        if (entry.kind === "spend") spend.set(entry.currency, (spend.get(entry.currency) ?? 0) + entry.amount);
      const spent = [...spend.values()].reduce((sum, value) => sum + value, 0);
      const revenueKnown =
        state.sources.some((source) => source.spaceId === space.id && source.kind === "hotmart" && source.syncedAt) ||
        state.money.some((entry) => entry.spaceId === space.id && entry.kind === "revenue");
      const sold = recent.some((entry) => entry.kind === "revenue" && (entry.amount > 0 || (entry.sales ?? 0) > 0));
      if (revenueKnown && spent >= settings.alertMinSpend && !sold)
        wanted.push({
          key: `spend-no-sales:${space.id}`,
          spaceId: space.id,
          kind: "spend-no-sales",
          text: alertText(language, "spend-no-sales", {
            space: space.name,
            amount: moneyText(spend, language) ?? "0",
            days: String(settings.alertDays),
          }),
        });
    }
    for (const goal of goals)
      if (insightGoalPace(goal, now) === "behind")
        wanted.push({
          key: `goal-behind:${goal.id}`,
          spaceId: goal.spaceId,
          kind: "goal-behind",
          text: alertText(language, "goal-behind", {
            goal: goal.title,
            progress: goalFact(goal, now, language).progress,
            space: spaceName(goal.spaceId),
          }),
        });
    for (const source of state.sources)
      if (source.state === "error")
        wanted.push({
          key: `sync-failed:${source.spaceId}:${source.kind}`,
          spaceId: source.spaceId,
          kind: "sync-failed",
          text: alertText(language, "sync-failed", {
            space: spaceName(source.spaceId),
            source: source.kind === "meta" ? "Meta Ads" : source.kind === "hotmart" ? "Hotmart" : "Motion",
            detail: source.detail ?? "",
          }),
        });
    const keys = new Set(wanted.map((alert) => alert.key));
    const alerts: StoredInsightAlert[] = [
      // An alert whose condition ended goes, also a dismissed one: the next time it is new again.
      ...state.alerts.filter((alert) => keys.has(alert.key)),
      ...wanted
        .filter((alert) => !state.alerts.some((existing) => existing.key === alert.key))
        .map((alert) => ({
          ...alert,
          id: `alert-${randomUUID()}`,
          createdAt: new Date(now).toISOString(),
          dismissedAt: null,
        })),
    ].map((alert) => {
      const next = wanted.find((item) => item.key === alert.key);
      return next ? { ...alert, text: next.text } : alert;
    });
    const changed =
      JSON.stringify(goals) !== JSON.stringify(state.goals) || JSON.stringify(alerts) !== JSON.stringify(state.alerts);
    if (changed)
      yield* this.#options.store.change((draft) => {
        draft.goals = goals;
        draft.alerts = alerts;
      });
  });

  // ---------- briefing ----------

  readonly #sendBriefing = Effect.fn("InsightService.sendBriefing")(function* (
    this: InsightService,
    spaceId: string | null,
    today: string,
  ) {
    const owner = this.#options.owner();
    if (!owner) return yield* new InsightRefused({ message: "This host has no owner to brief yet." });
    const scope = spaceId ?? "all";
    const channelId = yield* this.#briefingChannel(scope, owner);
    const facts = yield* this.#facts(spaceId, today);
    const name = owner.name.split(/\s+/u)[0] || owner.name;
    const written = yield* this.#options.generate(briefingPrompt(facts, name), Date.now() + BRIEFING_MODEL_MS).pipe(
      Effect.map((text) => checkedBriefing(text, facts)),
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          logger.warn("The briefing model failed; the plain briefing goes out.", { cause });
          return null;
        }),
      ),
    );
    const body = written ?? plainBriefing(facts);
    const text = `@[${owner.name}](member:${owner.id}) ${body}`.slice(0, 3_900);
    const posted = this.#options.channels.postNotice(channelId, facts.language === "es" ? "Resumen" : "Briefing", text);
    if (!posted) return yield* new InsightRefused({ message: "The briefing channel is archived or gone." });
    yield* this.#options.store.change((state) => {
      state.sentDays = { ...state.sentDays, [scope]: today };
      state.lastSentAt = new Date().toISOString();
      state.lastText = body.slice(0, 4_000);
    });
    logger.info("Sent the daily briefing.", { scope, model: written !== null, length: body.length });
  });

  /** The private channel of a scope's briefings, made the first time with the owner as its only person. */
  readonly #briefingChannel = Effect.fn("InsightService.briefingChannel")(function* (
    this: InsightService,
    scope: string,
    owner: { id: string; name: string },
  ) {
    const channels = this.#options.channels;
    const saved = this.#state.channels[scope];
    if (saved && channels.exists(saved) && !channels.get(saved).archived) return saved;
    const space = scope === "all" ? null : this.#options.spaces().find((item) => item.id === scope);
    const channelId = `briefing-${randomUUID()}`;
    this.#options.placeChannel(channelId, space?.id ?? GENERAL_SPACE_ID);
    const language = this.#state.briefing.language;
    yield* channels
      .createPrivate({
        channelId,
        name: space ? `briefing-${space.slug}`.slice(0, 80) : "briefing",
        description:
          language === "es"
            ? "El resumen de cada mañana: lo que avanzó, lo que espera por ti, el dinero y las metas."
            : "The morning briefing: what moved, what waits for you, money and goals.",
        owner,
      })
      .pipe(Effect.mapError(() => new InsightRefused({ message: "Could not make the briefing channel." })));
    yield* this.#options.store.change((state) => {
      state.channels = { ...state.channels, [scope]: channelId };
    });
    return channelId;
  });

  /** The facts of one briefing: the last 24 hours of the scope's agents and channels. */
  readonly #facts = Effect.fn("InsightService.facts")(function* (
    this: InsightService,
    spaceId: string | null,
    today: string,
  ) {
    const now = Date.now();
    const since = new Date(now - DAY_MS).toISOString();
    const agents = this.#options.agents();
    const inScope = (agentId: string) => !spaceId || this.#options.agentSpaceId(agentId) === spaceId;
    const name = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
    const deliveries = this.#options.queries.deliveriesSince(since).filter((row) => inScope(row.agentId));
    const spaces = this.#options.spaces().filter((space) => !spaceId || space.id === spaceId);
    const language = this.#state.briefing.language;
    const tickets = yield* this.#motionTickets(spaces, since);
    const landings = this.#options
      .artifacts()
      .filter(
        (artifact) =>
          artifact.kind === "website" &&
          artifact.updatedAt >= now - DAY_MS &&
          artifact.url &&
          (!artifact.agentId || inScope(artifact.agentId)),
      )
      .slice(0, 5)
      .map((artifact) => ({ title: artifact.title, url: artifact.url ?? "" }));
    const needsYou = this.#options
      .attention()
      .filter((item) => inScope(item.agentId))
      .slice(0, 5)
      .map((item) => ({
        agent: name(item.agentId),
        what: item.summary ?? item.kind,
        link: item.channelId ? `[#${this.#channelName(item.channelId)}](channel:${item.channelId})` : null,
      }));
    const yesterday = dayOffset(today, -1);
    const weekStart = dayOffset(today, -7);
    const money = spaces.flatMap((space) => {
      const rows = this.#state.money.filter((entry) => entry.spaceId === space.id);
      if (rows.length === 0) return [];
      const sum = (from: string, until: string) => {
        const spend = new Map<string, number>();
        const revenue = new Map<string, number>();
        let sales: number | null = null;
        for (const row of rows) {
          if (row.date < from || row.date > until) continue;
          const target = row.kind === "spend" ? spend : revenue;
          target.set(row.currency, round((target.get(row.currency) ?? 0) + row.amount));
          if (row.kind === "revenue" && row.sales !== null) sales = (sales ?? 0) + row.sales;
        }
        const net =
          spend.size === 1 && revenue.size === 1 && [...spend.keys()][0] === [...revenue.keys()][0]
            ? moneyText(
                new Map([
                  [[...spend.keys()][0] ?? "", round(([...revenue.values()][0] ?? 0) - ([...spend.values()][0] ?? 0))],
                ]),
                language,
              )
            : null;
        return { spend: moneyText(spend, language), revenue: moneyText(revenue, language), sales, net };
      };
      return [{ space: space.name, yesterday: sum(yesterday, yesterday), week: sum(weekStart, yesterday) }];
    });
    const goals = this.#state.goals
      .filter((goal) => !spaceId || goal.spaceId === spaceId)
      .slice(0, 6)
      .map((goal) => goalFact(goal, now, language));
    const decisions = this.#options.channels
      .ids()
      .filter((channelId) => {
        if (!this.#options.channels.exists(channelId)) return false;
        const channel = this.#options.channels.get(channelId);
        return !channel.archived && (!spaceId || this.#options.channelSpaceId(channelId) === spaceId);
      })
      .flatMap((channelId) =>
        this.#options.channels
          .decisions(channelId)
          .filter((message) => message.message.createdAt >= since)
          .map((message) => ({ channelId, message })),
      )
      .sort((a, b) => b.message.message.createdAt.localeCompare(a.message.message.createdAt))
      .slice(0, 3)
      .map(({ channelId, message }) => ({
        agent: message.author.name,
        text: message.message.text.replace(CHANNEL_DECISION_PREFIX, "").trim().slice(0, 240),
        link: `[#${this.#channelName(channelId)}](channel:${channelId})`,
      }));
    // The decision log of each space: what agents decided outside a hands-off channel too. A logged
    // decision that a channel already showed is said once.
    const logged = this.#options.loggedDecisions;
    if (logged) {
      const said = decisions.map((decision) => decision.text.toLowerCase());
      const entries: SpaceDecision[] = [];
      for (const space of spaces) {
        const recent = yield* logged(space.id).pipe(Effect.orElseSucceed((): readonly SpaceDecision[] => []));
        entries.push(...recent.filter((entry) => entry.createdAt >= since));
      }
      for (const entry of entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt))) {
        if (decisions.length >= 5) break;
        const text = `${entry.decision} (${entry.why})`.slice(0, 240);
        if (said.some((line) => line.includes(entry.decision.toLowerCase()))) continue;
        said.push(entry.decision.toLowerCase());
        decisions.push({
          agent: entry.agentId ? name(entry.agentId) : (this.#options.owner()?.name ?? ""),
          text,
          link:
            entry.channelId && this.#options.channels.exists(entry.channelId)
              ? `[#${this.#channelName(entry.channelId)}](channel:${entry.channelId})`
              : "",
        });
      }
    }
    const costs = this.#costs(7, this.#zone(), now);
    const scopedCosts = costs.agents.filter((agent) => inScope(agent.agentId));
    const facts: BriefingFacts = {
      scope: spaceId ? (spaces[0]?.name ?? spaceId) : language === "es" ? "todos los espacios" : "all spaces",
      language,
      date: today,
      moved: {
        tasksDone: deliveries.filter((row) => row.status === "completed").length,
        tasksFailed: deliveries.filter((row) => row.status === "failed").length,
        ticketsCreated: tickets?.created ?? null,
        ticketsClosed: tickets?.closed ?? null,
        landings,
      },
      needsYou,
      loopDecisions: (this.#options.loopDecisions?.() ?? [])
        .filter((decision) => !spaceId || decision.spaceId === spaceId)
        .slice(0, 5)
        .map((decision) => ({ title: decision.title.slice(0, 200), amountUsd: decision.amountUsd ?? null })),
      heldNotifications: this.#options.heldNotifications?.() ?? 0,
      money,
      goals,
      decisions,
      costs: {
        weekUsd: round(scopedCosts.reduce((sum, agent) => sum + agent.costUsd, 0)),
        previousWeekUsd: spaceId ? 0 : costs.previousWeekUsd,
        idleUsd: round(scopedCosts.reduce((sum, agent) => sum + agent.idleCostUsd, 0)),
        top: scopedCosts.slice(0, 3).map((agent) => ({ agent: name(agent.agentId), usd: round(agent.costUsd) })),
      },
      alerts: this.#openAlerts()
        .filter((alert) => !spaceId || alert.spaceId === spaceId)
        .map((alert) => alert.text)
        .slice(0, 3),
    };
    return facts;
  });

  #channelName(channelId: string): string {
    const channels = this.#options.channels;
    return channels.exists(channelId) ? channels.get(channelId).name || "dm" : "channel";
  }

  /**
   * The Motion issues of the scope that were created, and that were done, in the last day: one
   * search per space, as one of the space's agents (Motion knows each agent, and scopes it to its
   * space's workspace). Null when Motion is not connected or does not answer.
   */
  #motionTickets(
    spaces: readonly WorkspaceSpace[],
    since: string,
  ): Effect.Effect<{ created: number; closed: number } | null> {
    const motion = this.#options.motion?.();
    if (!motion) return Effect.succeed(null);
    const agents = this.#options.agents();
    return Effect.promise(async () => {
      let created = 0;
      let closed = 0;
      let answered = false;
      const cutoff = Date.parse(since);
      for (const space of spaces) {
        const agent = agents.find((item) => this.#options.agentSpaceId(item.id) === space.id);
        if (!agent) continue;
        const call = async (op: string, body: unknown) => {
          const response = await fetch(`${motion.baseUrl}/api/v1/${op}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${motion.token}`,
              "x-motion-agent": agent.id,
              "x-motion-agent-name": encodeURIComponent(agent.name),
              "x-motion-workspace-key": space.id,
              "x-motion-workspace-name": encodeURIComponent(space.name),
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`Motion ${op} ${response.status}`);
          const answer = await response.json();
          return answer;
        };
        try {
          const me = await call("auth.me", {});
          const workspaces = isDynamicRecord(me) && Array.isArray(me.workspaces) ? me.workspaces : [];
          const first = workspaces[0];
          const workspace = isDynamicRecord(first) && typeof first.id === "string" ? first.id : null;
          if (!workspace) continue;
          const issues = await call("issues.search", { workspace_id: workspace, limit: 500 });
          if (!Array.isArray(issues)) continue;
          answered = true;
          for (const issue of issues) {
            if (!isDynamicRecord(issue)) continue;
            if (motionTime(issue.created_at) >= cutoff) created += 1;
            if (issue.status_category === "done" && motionTime(issue.updated_at) >= cutoff) closed += 1;
          }
        } catch (error) {
          logger.info("Motion did not answer the briefing's ticket count.", { space: space.id, error });
        }
      }
      return answered ? { created, closed } : null;
    });
  }
}

function motionTime(value: unknown): number {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value === "string") return Date.parse(value) || 0;
  return 0;
}

function synced(
  spaceId: string,
  kind: "spend" | "revenue",
  source: "meta" | "hotmart",
  day: MoneyDay,
  at: string,
): InsightMoneyEntry {
  return {
    id: `${source}-${spaceId}-${day.date}-${day.currency}`.slice(0, 128),
    spaceId,
    date: day.date,
    kind,
    amount: round(day.amount),
    currency: day.currency,
    sales: day.sales,
    product: null,
    source,
    note: null,
    updatedAt: at,
  };
}

/** The history with today's point set: one point a day, the newest last. */
function withPoint(history: readonly { date: string; value: number }[], date: string, value: number) {
  return [...history.filter((point) => point.date !== date), { date, value }]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-INSIGHT_GOAL_HISTORY_LIMIT);
}

function alertText(language: "es" | "en", kind: InsightAlertKind, values: Record<string, string>): string {
  const es = language === "es";
  const text =
    kind === "spend-no-sales"
      ? es
        ? `${values.space}: ${values.amount} en anuncios en ${values.days} ${values.days === "1" ? "día" : "días"} y 0 ventas.`
        : `${values.space}: spent ${values.amount} on ads in ${values.days} ${values.days === "1" ? "day" : "days"} with 0 sales.`
      : kind === "goal-behind"
        ? es
          ? `La meta "${values.goal}" (${values.space}) va atrasada: ${values.progress}.`
          : `Goal "${values.goal}" (${values.space}) is behind: ${values.progress}.`
        : es
          ? `${values.space}: no se pudo leer ${values.source}. ${values.detail}`
          : `${values.space}: ${values.source} could not be read. ${values.detail}`;
  return text.slice(0, 300);
}
