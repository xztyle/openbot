import { randomUUID } from "node:crypto";
import type { AgentContextCategoryUsage, AgentContextState } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import type { AgentClient } from "../agent-client";
import type { AgentStore } from "../agent-store";
import { activeSessionKey } from "../database/provider-sessions";
import { causeHelpers } from "../effect-boundary";
import { decodeRecordResponse, getRecord } from "../protocol";
import { finiteNumberOrNull } from "./account-usage";
import type { ProviderPort } from "./provider-runtime";
import type { ThreadOperationFailed } from "./thread-lifecycle";

interface ThreadContextBudget {
  usedTokens: number;
  contextWindow: number;
  pending: boolean;
  /** `stopping`: the deadline asked Codex to stop the compaction turn, and the queue waits for its end. */
  phase: "idle" | "requested" | "running" | "stopping";
  compactionTurnId: string | null;
  lastCompactedTokens: number | null;
  /** Compactions in a row that left the session at `INEFFECTIVE_COMPACTION_SHARE` or more. */
  ineffectiveCompactions: number;
  /** Compactions in a row that failed. */
  failedCompactions: number;
  /** A compaction ended, and the next usage report is its result. */
  awaitingUsage: boolean;
}

const logger = createOpenBotLogger("context-compaction");

const CONTEXT_COMPACTION_THRESHOLD = 0.8;
/**
 * A compaction that leaves the session at 70% or more did not help: tools and instructions fill the
 * window, and each try sends the whole chat to the model again on the user's plan. After two such
 * compactions, or two failed ones in a row, the session stops compacting by itself until it drops
 * below the share again. The user can still compact by hand.
 */
const INEFFECTIVE_COMPACTION_SHARE = CONTEXT_COMPACTION_THRESHOLD - 0.1;
const INEFFECTIVE_COMPACTION_LIMIT = 2;
const FAILED_COMPACTION_LIMIT = 2;

function newBudget(usedTokens: number, contextWindow: number): ThreadContextBudget {
  return {
    usedTokens,
    contextWindow,
    pending: false,
    phase: "idle",
    compactionTurnId: null,
    lastCompactedTokens: null,
    ineffectiveCompactions: 0,
    failedCompactions: 0,
    awaitingUsage: false,
  };
}

function stopped(budget: ThreadContextBudget): boolean {
  return (
    budget.ineffectiveCompactions >= INEFFECTIVE_COMPACTION_LIMIT || budget.failedCompactions >= FAILED_COMPACTION_LIMIT
  );
}
const CONTEXT_COMPACTION_TIMEOUT_MS = 120_000;
/**
 * A started compaction of a long thread can take minutes. Its deadline is this many times the start
 * deadline, so it only ends a compaction that hangs (upstream d71a4eb98).
 */
const CONTEXT_COMPACTION_RUN_FACTOR = 10;
/** Usage arrives after each model step; one runtime snapshot carries the latest value of a burst. */
const USAGE_CHANGE_DELAY_MS = 250;
/**
 * A Claude prompt cache lives one hour at most, so the first request after a longer idle writes the
 * whole session to the cache again. Above `IDLE_HANDOFF_MIN_TOKENS`, a new session that starts from
 * the history handoff writes about 40,000 tokens instead.
 */
export const IDLE_HANDOFF_AFTER_MS = 60 * 60_000;
export const IDLE_HANDOFF_MIN_TOKENS = 120_000;

export interface ContextCompactionOptions {
  /**
   * How long the provider takes to start a compaction before OpenBot stops it. A started compaction
   * runs `CONTEXT_COMPACTION_RUN_FACTOR` times as long. Tests make it short.
   */
  timeoutMs?: number | undefined;
  store: AgentStore;
  providers: ProviderPort;
  emitError(code: string, error: unknown, agentId?: string): void;
  scheduleDrain(agentId: string): void;
  /** Replaces the session for a `handoff` compaction. The new session, or `null` when none replaced it. */
  rotateSession(
    agentId: string,
    client: AgentClient,
    threadId: string,
  ): Effect.Effect<string | null, ThreadOperationFailed>;
  /** Whether `rotateSession` can replace this session. See `ThreadLifecycle.rotatesSession`. */
  rotatesSession(agentId: string, threadId: string): boolean;
  changed?(): void;
  /** A provider session finished a compaction: its summary replaces what it read before. */
  compacted?(threadId: string): void;
}

/** Whether OpenBot can ask for a compaction of this client, automatically or for the user. */
export function compactsOnRequest(mode: AgentClient["contextCompaction"]): boolean {
  return mode === "events" || mode === "request" || mode === "handoff";
}

/** A queue that Codex refused because a compaction turn runs on `threadId`. */
interface RefusalHold {
  threadId: string;
  client: AgentClient;
  timer: NodeJS.Timeout;
}

/**
 * Decides when a provider thread is close enough to its context window to compact, and drives the
 * compaction turn.
 *
 * A compaction is a real provider turn, so it arrives on the same notification stream as the
 * agent's own work and has to be told apart from it: `claimTurn` swallows the `turn/started` that
 * belongs to the compaction, and `isCompactionTurn` recognizes its completion. The budget is keyed
 * by *external* provider thread id, `compactingAgents` by agent id, because an agent only ever compacts one
 * thread at a time and the drain guard asks the question by agent.
 *
 * Codex refuses input while a compaction turn runs, so the hold lasts until that turn ends: the
 * deadline stops the turn instead of releasing the queue, and a refused `turn/start` puts its
 * messages back to wait for the end of the turn. A hold of a client that ended ends with it.
 */
export class ContextCompaction {
  readonly #store: AgentStore;
  readonly #providers: ProviderPort;
  readonly #emitError: (code: string, error: unknown, agentId?: string) => void;
  readonly #scheduleDrain: (agentId: string) => void;
  readonly #rotateSession: ContextCompactionOptions["rotateSession"];
  readonly #rotatesSession: ContextCompactionOptions["rotatesSession"];
  readonly #budgets = new Map<string, ThreadContextBudget>();
  /**
   * The thread that compacts, and the client that runs it once `request` sends it. `turnId`: the turn
   * whose end made the `reserve` hold, until `request` takes the hold.
   */
  readonly #compactingAgents = new Map<
    string,
    { threadId: string; client: AgentClient | null; turnId: string | null }
  >();
  readonly #refusals = new Map<string, RefusalHold>();
  readonly #timeoutMs: number;
  /** How long a started compaction runs before OpenBot stops it. */
  readonly #runTimeoutMs: number;
  /** How long a stopped compaction, or a refused queue, waits for the turn to end. */
  readonly #graceMs: number;
  readonly #display = new Map<string, Omit<AgentContextState, "agentId" | "threadId">>();
  readonly #awaitingPostCompaction = new Set<string>();
  /**
   * Sessions in a compaction whose usage OpenBot compares: until it ends, Codex can report an
   * estimate of its result, which can be much smaller than the next request (upstream c858f0a42).
   */
  readonly #estimating = new Set<string>();
  readonly #durations = new Map<string, number>();
  readonly #changed: () => void;
  readonly #compacted: (threadId: string) => void;
  readonly #timers = new Map<string, NodeJS.Timeout>();
  /** When each provider thread last reported a model step. */
  readonly #activity = new Map<string, number>();
  /** The threads that `reserveIdleHandoff` reserved, which `request` hands off. */
  readonly #idleHandoffs = new Set<string>();
  #usageTimer: NodeJS.Timeout | null = null;

  constructor(options: ContextCompactionOptions) {
    this.#changed = options.changed ?? (() => {});
    this.#compacted = options.compacted ?? (() => {});
    this.#timeoutMs = options.timeoutMs ?? CONTEXT_COMPACTION_TIMEOUT_MS;
    this.#runTimeoutMs = this.#timeoutMs * CONTEXT_COMPACTION_RUN_FACTOR;
    this.#graceMs = Math.ceil(this.#timeoutMs / 4);
    this.#store = options.store;
    this.#providers = options.providers;
    this.#emitError = options.emitError;
    this.#scheduleDrain = options.scheduleDrain;
    this.#rotateSession = options.rotateSession;
    this.#rotatesSession = options.rotatesSession;
  }

  /** Only personal sessions appear in the desktop snapshot; execution threads remain separate. */
  snapshot(): AgentContextState[] {
    // Nothing to show before a provider reported a context: no session needs reading.
    if (this.#display.size === 0) return [];
    // One read of the active sessions for every agent, not one for each agent.
    const sessions = this.#store.database.activeProviderSessions();
    return this.#store.list().flatMap((agent) => {
      const session = agent.threadId ? sessions.get(activeSessionKey(agent.threadId, agent.provider)) : undefined;
      const display = session ? this.#display.get(session.externalSessionId) : null;
      return display && agent.threadId ? [{ agentId: agent.id, threadId: agent.threadId, ...display }] : [];
    });
  }

  observeUsage(
    threadId: string,
    usedTokens: number,
    windowTokens: number,
    nativeManaged: boolean,
    autoCompactAt: number | null,
    estimated = false,
    categories?: AgentContextCategoryUsage[],
  ): void {
    if (!Number.isFinite(usedTokens) || usedTokens < 0 || !Number.isFinite(windowTokens) || windowTokens <= 0) return;
    this.#activity.set(threadId, Date.now());
    const display = this.#display.get(threadId) ?? { usage: null, compaction: null };
    const previous = display.usage;
    display.usage = {
      usedTokens,
      windowTokens,
      nativeManaged,
      autoCompactAt,
      estimated,
      ...(categories ? { categories } : {}),
    };
    const after = display.compaction?.status === "completed" && this.#awaitingPostCompaction.delete(threadId);
    if (after && display.compaction) display.compaction.afterTokens = usedTokens;
    this.#display.set(threadId, display);
    if (after || JSON.stringify(previous) !== JSON.stringify(display.usage)) this.#scheduleUsageChange();
  }

  #scheduleUsageChange(): void {
    this.#usageTimer ??= setTimeout(() => {
      this.#usageTimer = null;
      this.#changed();
    }, USAGE_CHANGE_DELAY_MS);
  }

  /** A snapshot sent now also carries any pending usage. */
  #emitChanged(): void {
    if (this.#usageTimer) clearTimeout(this.#usageTimer);
    this.#usageTimer = null;
    this.#changed();
  }

  observeCompaction(
    threadId: string,
    status: "running" | "completed" | "failed",
    tokenComparison: "context" | "none" = "context",
  ): void {
    const display = this.#display.get(threadId) ?? { usage: null, compaction: null };
    if (status === "running" && display.compaction?.status === "running") return;
    const previous =
      status === "running"
        ? display.compaction?.status === "running"
          ? display.compaction
          : null
        : display.compaction;
    const startedAt = previous ? previous.startedAt : Date.now();
    const expectedMs = this.#durations.get(threadId);
    const compaction: NonNullable<typeof display.compaction> = {
      id: previous ? previous.id : randomUUID(),
      startedAt,
      status,
      ...(expectedMs === undefined ? {} : { expectedMs }),
      ...(previous ?? {}),
    };
    compaction.status = status;
    display.compaction = compaction;
    const before = previous ? previous.beforeTokens : display.usage?.usedTokens;
    if (tokenComparison === "none") {
      delete compaction.beforeTokens;
      delete compaction.afterTokens;
    } else if (before !== undefined) compaction.beforeTokens = before;
    this.#awaitingPostCompaction.delete(threadId);
    if (tokenComparison === "context" && status === "running") this.#estimating.add(threadId);
    else this.#estimating.delete(threadId);
    if (tokenComparison === "context" && status === "completed" && compaction.afterTokens === undefined)
      this.#awaitingPostCompaction.add(threadId);
    if (status === "completed" && previous?.status === "running")
      this.#durations.set(threadId, Math.max(1, Date.now() - startedAt));
    this.#display.set(threadId, display);
    this.#emitChanged();
    if (status === "completed") this.#compacted(threadId);
  }

  /** Ends a running compaction whose provider stopped before it reported the result. */
  abandonCompaction(threadId: string): void {
    if (this.#display.get(threadId)?.compaction?.status === "running") this.observeCompaction(threadId, "failed");
  }

  beginTurn(threadId: string): void {
    this.#awaitingPostCompaction.delete(threadId);
  }

  /** The context of a provider thread and when its last model step was, or null before its first one here. */
  cacheState(threadId: string): { usedTokens: number; lastStepAt: number } | null {
    const usage = this.#display.get(threadId)?.usage;
    const at = this.#activity.get(threadId);
    return usage && at !== undefined ? { usedTokens: usage.usedTokens, lastStepAt: at } : null;
  }

  /**
   * Reserves a handoff of a session that compacts by itself (Claude) before the delivery that
   * wakes it: its last model step is older than the prompt cache and its context holds at least
   * `IDLE_HANDOFF_MIN_TOKENS`. The next `request` replaces the session, and the new one starts from
   * the history handoff. A session that no model step reported since this process started is left
   * alone: its age is unknown.
   */
  reserveIdleHandoff(agentId: string, threadId: string, now = Date.now()): boolean {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    if (!agent || this.#providers.clientForAgent(agent)?.contextCompaction !== "native") return false;
    const usage = this.#display.get(threadId)?.usage;
    const at = this.#activity.get(threadId);
    if (!usage || at === undefined || usage.usedTokens < IDLE_HANDOFF_MIN_TOKENS || now - at < IDLE_HANDOFF_AFTER_MS)
      return false;
    if (this.#compactingAgents.has(agentId) || this.#display.get(threadId)?.compaction?.status === "running")
      return false;
    const phase = this.#budgets.get(threadId)?.phase;
    if ((phase !== undefined && phase !== "idle") || !this.#rotatesSession(agentId, threadId)) return false;
    this.#idleHandoffs.add(threadId);
    this.#compactingAgents.set(agentId, { threadId, client: null, turnId: null });
    this.observeCompaction(threadId, "running");
    logger.info("Handing off an idle session before its wake.", {
      agentId,
      contextSize: usage.usedTokens,
      idleMinutes: Math.round((now - at) / 60_000),
    });
    return true;
  }

  /** One clause of the drain guard the queue engine composes. False means "hold this agent's queue". */
  mayDrain(agentId: string): boolean {
    return !this.#compactingAgents.has(agentId) && !this.#refusals.has(agentId);
  }

  updateBudget(threadId: string, params: unknown, agentId?: string): void {
    const usage = getRecord(params, "tokenUsage");
    const last = getRecord(usage, "last");
    const usedTokens = finiteNumberOrNull(last?.totalTokens);
    const contextWindow = finiteNumberOrNull(usage?.modelContextWindow);
    if (usedTokens === null || usedTokens < 0 || contextWindow === null || contextWindow <= 0) return;

    // Only the next request tells whether the compaction helped. The estimate reset the count of
    // compactions that left the session almost full, so each turn compacted again. The display still
    // shows it.
    if (this.#estimating.has(threadId)) return;

    const budget = this.#budgets.get(threadId) ?? newBudget(usedTokens, contextWindow);
    budget.usedTokens = usedTokens;
    budget.contextWindow = contextWindow;
    this.#budgets.set(threadId, budget);
    if (budget.awaitingUsage) {
      budget.awaitingUsage = false;
      this.#checkCompaction(budget, agentId);
    }

    const pressured = usedTokens / contextWindow >= CONTEXT_COMPACTION_THRESHOLD;
    if (!pressured) {
      budget.pending = false;
      budget.lastCompactedTokens = null;
      budget.failedCompactions = 0;
      if (usedTokens / contextWindow < INEFFECTIVE_COMPACTION_SHARE) budget.ineffectiveCompactions = 0;
      return;
    }
    if (budget.phase !== "idle") return;
    if (stopped(budget)) {
      budget.pending = false;
      return;
    }

    const minimumGrowth = Math.max(1_024, Math.floor(contextWindow * 0.05));
    if (budget.lastCompactedTokens !== null && usedTokens < budget.lastCompactedTokens + minimumGrowth) {
      return;
    }
    budget.pending = true;
  }

  /** The first usage report after a compaction: count a compaction that left the session almost full. */
  #checkCompaction(budget: ThreadContextBudget, agentId: string | undefined): void {
    const share = budget.usedTokens / budget.contextWindow;
    if (share < INEFFECTIVE_COMPACTION_SHARE) {
      budget.ineffectiveCompactions = 0;
      return;
    }
    budget.ineffectiveCompactions += 1;
    const percent = Math.round(share * 100);
    logger.warn("A compaction left the session almost full.", {
      usedPercent: percent,
      contextWindow: budget.contextWindow,
      ineffectiveCompactions: budget.ineffectiveCompactions,
    });
    if (budget.ineffectiveCompactions === INEFFECTIVE_COMPACTION_LIMIT)
      this.#emitError(
        "context_compaction_ineffective",
        sourceText("error.backend.contextCompactionIneffective", { percent: String(percent) }),
        agentId,
      );
  }

  #countFailure(threadId: string, agentId: string): void {
    const budget = this.#budgets.get(threadId);
    if (!budget) return;
    budget.failedCompactions += 1;
    logger.warn("A compaction failed.", { failedCompactions: budget.failedCompactions });
    if (budget.failedCompactions === FAILED_COMPACTION_LIMIT)
      this.#emitError("context_compaction_stopped", sourceText("error.backend.contextCompactionStopped"), agentId);
  }

  contextInputCharacters(threadId: string): number {
    const budget = this.#budgets.get(threadId);
    // A session that `#rotate` started holds a window of 1 until its first usage report: no window is
    // known yet, and a budget of 2 characters would summarize the channel one character at a time.
    return budget && budget.contextWindow > 1 ? Math.min(120_000, Math.floor(budget.contextWindow * 2)) : 120_000;
  }

  /**
   * `manual`: the user asked, so the thread compacts below the threshold too. `turnId`: the turn whose
   * end reserves, so that only that turn can drop the hold.
   */
  reserve(agentId: string, threadId: string, manual = false, turnId: string | null = null): boolean {
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    const mode = agent ? this.#providers.clientForAgent(agent)?.contextCompaction : undefined;
    if (!agent || !compactsOnRequest(mode)) return false;
    if (mode === "handoff" && !this.#rotatesSession(agentId, threadId)) return false;
    const budget = this.#budgets.get(threadId);
    if (!(budget?.pending || (manual && budget)) || budget.phase !== "idle" || this.#compactingAgents.has(agentId)) {
      return false;
    }
    budget.phase = "requested";
    this.#compactingAgents.set(agentId, { threadId, client: null, turnId });
    this.observeCompaction(threadId, "running");
    return true;
  }

  /**
   * Ends a hold that `reserve` made at the end of this turn and that `request` did not take: the work
   * between them failed. Only `request` arms a deadline, so the hold stayed until a restart, and each
   * next message waited with the reason "compaction".
   */
  dropReservation(agentId: string, threadId: string, turnId: string): void {
    const compaction = this.#compactingAgents.get(agentId);
    if (compaction?.turnId === turnId && compaction.threadId === threadId) this.#abandon(agentId, threadId);
  }

  readonly request = Effect.fn("ContextCompaction.request")(function* (
    this: ContextCompaction,
    agentId: string,
    threadId: string,
  ) {
    const reservation = this.#compactingAgents.get(agentId);
    if (reservation) reservation.turnId = null;
    const budget = this.#budgets.get(threadId);
    const agent = this.#store.list().find((candidate) => candidate.id === agentId);
    const client = agent ? this.#providers.clientForAgent(agent) : null;
    if (this.#idleHandoffs.delete(threadId)) {
      if (client && this.#providers.isReady()) yield* this.#rotate(agentId, threadId, client);
      else this.#release(agentId, threadId);
      // A session that was not replaced and kept no budget still shows the running compaction.
      this.abandonCompaction(threadId);
      this.#scheduleDrain(agentId);
      return;
    }
    if (
      budget?.phase !== "requested" ||
      !client ||
      !compactsOnRequest(client.contextCompaction) ||
      !this.#providers.isReady()
    ) {
      if (budget?.phase === "requested") this.observeCompaction(threadId, "failed");
      this.#release(agentId, threadId);
      return;
    }
    if (client.contextCompaction === "handoff") {
      yield* this.#rotate(agentId, threadId, client);
      return;
    }

    this.#compactingAgents.set(agentId, { threadId, client, turnId: null });
    // A `request` compaction runs inside the request, so it starts now and the request waits as long.
    const runsInRequest = client.contextCompaction === "request";
    this.#armDeadline(agentId, threadId, client, runsInRequest ? this.#runTimeoutMs : this.#timeoutMs);

    yield* client
      .request(
        "thread/compact/start",
        { threadId },
        decodeRecordResponse,
        runsInRequest ? this.#runTimeoutMs : undefined,
      )
      .pipe(toContextCompactionFailed)
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (client.contextCompaction === "request" && budget.phase === "requested") {
              this.markCompacted(threadId);
              this.finish(agentId, threadId, "completed");
            }
          }),
        ),
        Effect.catch((failure) =>
          Effect.sync(() => {
            // Codex reported the compaction turn, so it runs whatever the answer was. Its end, or
            // the deadline, releases the queue.
            if (budget.phase === "running" || budget.phase === "stopping") return;
            budget.lastCompactedTokens = budget.usedTokens;
            this.#emitError("context_compaction_failed", failure.cause, agentId);
            this.#countFailure(threadId, agentId);
            this.observeCompaction(threadId, "failed");
            this.#release(agentId, threadId);
            this.#scheduleDrain(agentId);
          }),
        ),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            this.observeCompaction(threadId, "failed");
            this.#release(agentId, threadId);
            this.#scheduleDrain(agentId);
          }),
        ),
      );
  });

  /**
   * Takes ownership of a `turn/started` that belongs to a compaction we asked for. True means the
   * router must stop: this turn is not the agent's, so it gets no active turn and no event.
   */
  claimTurn(agentId: string, threadId: string, turnId: string): boolean {
    const budget = this.#budgets.get(threadId);
    if (budget?.phase !== "requested" || !this.#compactingAgents.has(agentId)) return false;
    budget.phase = "running";
    budget.compactionTurnId = turnId;
    const client = this.#compactingAgents.get(agentId)?.client;
    if (client) this.#armDeadline(agentId, threadId, client, this.#runTimeoutMs);
    return true;
  }

  isCompactionTurn(threadId: string, turnId: string): boolean {
    return this.#budgets.get(threadId)?.compactionTurnId === turnId;
  }

  markCompacted(threadId: string): void {
    const budget = this.#budgets.get(threadId);
    if (!budget) return;
    budget.pending = false;
    budget.lastCompactedTokens = budget.usedTokens;
    budget.awaitingUsage = true;
  }

  finish(agentId: string, threadId: string, status: string): void {
    const budget = this.#budgets.get(threadId);
    if (budget && status === "completed") budget.failedCompactions = 0;
    if (budget && status !== "completed") {
      budget.lastCompactedTokens = budget.usedTokens;
      // A compaction that the deadline stopped was already reported as timed out.
      if (budget.phase !== "stopping") {
        this.#emitError("context_compaction_failed", `Codex context compaction ended with status ${status}.`, agentId);
        this.#countFailure(threadId, agentId);
      }
    }
    this.observeCompaction(threadId, status === "completed" ? "completed" : "failed");
    this.#release(agentId, threadId);
    this.#scheduleDrain(agentId);
  }

  /** Drops a retired provider thread's budget. The agent keeps compacting until `forgetAgent`. */
  forgetThread(threadId: string): void {
    this.#budgets.delete(threadId);
    this.#activity.delete(threadId);
    this.#idleHandoffs.delete(threadId);
    const displayed = this.#display.delete(threadId);
    this.#durations.delete(threadId);
    this.#awaitingPostCompaction.delete(threadId);
    this.#estimating.delete(threadId);
    if (displayed) this.#emitChanged();
    this.#clearTimer(threadId);
  }

  forgetAgent(agentId: string): void {
    this.#compactingAgents.delete(agentId);
  }

  /**
   * Codex refused input because a compaction turn runs on `threadId`, such as one that outlived its
   * deadline. The agent's queue waits for a turn of that thread to end, for `graceMs` at most: a
   * refusal proves that nothing ran, so the next start can only be refused again.
   */
  holdForRefusal(agentId: string, threadId: string, client: AgentClient): void {
    this.#endRefusal(agentId, false);
    const timer = setTimeout(() => this.#endRefusal(agentId), this.#graceMs);
    timer.unref?.();
    this.#refusals.set(agentId, { threadId, client, timer });
  }

  /** A turn of this provider thread ended, so a queue that Codex refused for it can start again. */
  threadTurnEnded(threadId: string): void {
    for (const [agentId, hold] of this.#refusals) if (hold.threadId === threadId) this.#endRefusal(agentId);
  }

  /** The client stopped or exited, so the compactions and refusals it held end with it. */
  clientEnded(client: AgentClient): void {
    for (const [agentId, compaction] of this.#compactingAgents) {
      if (compaction.client !== client) continue;
      this.observeCompaction(compaction.threadId, "failed");
      this.#release(agentId, compaction.threadId);
      this.#scheduleDrain(agentId);
    }
    for (const [agentId, hold] of this.#refusals) if (hold.client === client) this.#endRefusal(agentId);
  }

  dispose(): void {
    if (this.#usageTimer) clearTimeout(this.#usageTimer);
    this.#usageTimer = null;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#compactingAgents.clear();
    for (const hold of this.#refusals.values()) clearTimeout(hold.timer);
    this.#refusals.clear();
    this.#budgets.clear();
    this.#activity.clear();
    this.#idleHandoffs.clear();
    this.#display.clear();
    this.#durations.clear();
    this.#awaitingPostCompaction.clear();
    this.#estimating.clear();
  }

  /**
   * The deadline came while Codex runs the compaction turn. Codex refuses input until that turn
   * ends, so the queue waits for its `turn/completed`, and for `graceMs` at most.
   */
  #stop(agentId: string, threadId: string, client: AgentClient, turnId: string): void {
    const budget = this.#budgets.get(threadId);
    if (!budget) return;
    budget.phase = "stopping";
    const timer = setTimeout(() => this.#abandon(agentId, threadId), this.#graceMs);
    timer.unref?.();
    this.#timers.set(threadId, timer);
    Effect.runFork(
      client.request("turn/interrupt", { threadId, turnId }, decodeRecordResponse).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            // After `dispose`, a new compaction of this thread has its own budget.
            const current = this.#budgets.get(threadId) === budget;
            if (current && budget.phase === "stopping" && budget.compactionTurnId === turnId) {
              this.#abandon(agentId, threadId);
            }
          }),
        ),
      ),
    );
  }

  /**
   * A `handoff` compaction. The display moves to the new session: its first model call reports the
   * new usage, and until then the ring has no value to show.
   */
  readonly #rotate = Effect.fn("ContextCompaction.rotate")(function* (
    this: ContextCompaction,
    agentId: string,
    threadId: string,
    client: AgentClient,
  ) {
    // The hold keeps no client: `clientEnded` must not release the queue while the rotation runs.
    // The rotation ends the hold itself, also when the client exits.
    const compaction = this.#display.get(threadId)?.compaction;
    const compactedTokens = this.#budgets.get(threadId)?.usedTokens ?? null;
    const next = yield* this.#rotateSession(agentId, client, threadId).pipe(
      Effect.catch((failure) =>
        Effect.sync(() => {
          this.#emitError("context_compaction_failed", failure.cause, agentId);
          return undefined;
        }),
      ),
    );
    // No token comparison: the new session reports its usage during its first turn.
    if (next && compaction) {
      const { id, startedAt, expectedMs } = compaction;
      this.#display.set(next, {
        usage: null,
        compaction: { id, startedAt, status: "completed", ...(expectedMs === undefined ? {} : { expectedMs }) },
      });
    }
    // The growth rule moves to the new session, as it stays on a Codex thread: a session that starts
    // above the threshold does not rotate again at each turn.
    if (next)
      this.#budgets.set(next, {
        ...newBudget(0, 1),
        lastCompactedTokens: compactedTokens,
        // The first report of the new session is the result of this compaction.
        ineffectiveCompactions: this.#budgets.get(threadId)?.ineffectiveCompactions ?? 0,
        awaitingUsage: true,
      });
    // A session that was not replaced keeps its budget; the growth rule stops an immediate retry.
    const budget = this.#budgets.get(threadId);
    if (budget) {
      budget.lastCompactedTokens = budget.usedTokens;
      this.observeCompaction(threadId, "failed");
    }
    this.#release(agentId, threadId);
    this.#emitChanged();
    this.#scheduleDrain(agentId);
  });

  /** Stops the compaction of `threadId` after `ms`, in place of an earlier deadline. */
  #armDeadline(agentId: string, threadId: string, client: AgentClient, ms: number): void {
    this.#clearTimer(threadId);
    const timer = setTimeout(() => {
      this.#emitError(
        "context_compaction_timeout",
        "Codex context compaction timed out; queued work will continue.",
        agentId,
      );
      const budget = this.#budgets.get(threadId);
      const turnId = budget?.compactionTurnId;
      if (budget?.phase === "running" && turnId) this.#stop(agentId, threadId, client, turnId);
      else this.#abandon(agentId, threadId);
    }, ms);
    timer.unref?.();
    this.#timers.set(threadId, timer);
  }

  /** Ends a compaction that did not end by itself, and lets the queue continue. */
  #abandon(agentId: string, threadId: string): void {
    this.observeCompaction(threadId, "failed");
    this.#release(agentId, threadId);
    this.#scheduleDrain(agentId);
  }

  #endRefusal(agentId: string, drain = true): void {
    const hold = this.#refusals.get(agentId);
    if (!hold) return;
    clearTimeout(hold.timer);
    this.#refusals.delete(agentId);
    if (drain) this.#scheduleDrain(agentId);
  }

  #release(agentId: string, threadId: string): void {
    this.#clearTimer(threadId);
    const budget = this.#budgets.get(threadId);
    if (budget) {
      budget.pending = false;
      budget.phase = "idle";
      budget.compactionTurnId = null;
    }
    this.#compactingAgents.delete(agentId);
  }

  #clearTimer(threadId: string): void {
    const timer = this.#timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(threadId);
  }
}

class ContextCompactionFailed extends Schema.TaggedError<ContextCompactionFailed>()("ContextCompactionFailed", {
  cause: Schema.Defect(),
}) {}

const { rewrap: toContextCompactionFailed } = causeHelpers(ContextCompactionFailed);
