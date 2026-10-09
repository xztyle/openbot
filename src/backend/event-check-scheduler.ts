import { createHash, randomUUID } from "node:crypto";
import type { EventCheckTemplate, EventCheckTemplateInstallInput } from "@openbot/contracts/event-check-templates";
import type {
  EventCheck,
  EventCheckEnvironmentInput,
  EventCheckExecution,
  EventCheckInput,
  EventCheckOrigin,
} from "@openbot/contracts/event-checks";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { nextEventCheckOccurrence } from "@openbot/team-client/event-check-schedule";
import { Cause, Effect, type Scope, Semaphore } from "effect";
import type { EventCheckApiReader } from "./event-check-api-reader";
import { eventCheckProgramError } from "./event-check-program";
import type {
  EventCheckArguments,
  EventCheckData,
  EventCheckReader,
  EventCheckReadSession,
} from "./event-check-reader";
import {
  CHECK_MAX_BYTES,
  CHECK_MAX_ITEMS,
  checkPointer,
  checkResultData,
  eventCheckPrompt,
  observeCheck,
} from "./event-check-result";
import { type CheckOutbox, EVENT_CHECK_FAILURE_NOTICE_STREAK, type EventCheckStore } from "./event-check-store";
import type { EventCheckTemplates } from "./event-check-templates";
import { mcpFailure, mcpSync } from "./mcp-effects";
import type { RoutineDueSource, RoutineTimer } from "./routine-timer";

/**
 * Deliveries to the agent per check in one hour. The cap is soft: it lives in memory, so a restart
 * starts a new hour. Over the cap, events wait in the outbox and go out as one digest.
 */
const EVENT_CHECK_HOURLY_DELIVERY_CAP = 12;
const HOUR_MS = 3_600_000;
/** A prompt must stay under the 100,000 character limit of an event batch. */
const DIGEST_TEXT_LIMIT = 90_000;
/** The codes of the notices a check raises on its own. The agent event `error` carries them to every client. */
type EventCheckNoticeCode = "event_check_failing" | "event_check_delivery_failed";
export interface EventCheckSchedulerOptions {
  store: EventCheckStore;
  reader?: EventCheckReader;
  apiReader?: EventCheckApiReader;
  templates?: EventCheckTemplates;
  scope(): Scope.Scope;
  timer: RoutineTimer;
  agentExists(id: string): boolean;
  running(): boolean;
  /** Deliveries per check per hour. Defaults to EVENT_CHECK_HOURLY_DELIVERY_CAP. */
  deliveryCap?: number;
  /** One notice for a failure streak or a failed delivery. Optional: a host without it stays silent. */
  notify?(agentId: string, code: EventCheckNoticeCode, message: string): void;
  deliver(
    check: EventCheck,
    event: CheckOutbox,
    origin: EventCheckOrigin,
    valid: () => boolean,
  ): Effect.Effect<string, { readonly cause: unknown }>;
}
function scheduleValid(input: EventCheckInput): void {
  new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format();
  let previous = new Date();
  for (let index = 0; index < 200; index++) {
    const next = nextEventCheckOccurrence(input.schedule, input.timezone, previous);
    if (
      !Number.isFinite(next.getTime()) ||
      next <= previous ||
      (index > 0 && next.getTime() - previous.getTime() < 30_000)
    )
      throw new Error(sourceText("error.backend.eventCheckSchedule"));
    previous = next;
  }
}
/** Owns deterministic polls and durable wakeups. Empty checks never enter the agent runtime. */
export class EventCheckScheduler implements RoutineDueSource {
  readonly #mutations = Semaphore.makeUnsafe(1);
  readonly #running = new Set<string>();
  readonly #delivering = new Set<string>();
  /** When each check handed work to its agent in the last hour. Memory only: the cap is soft. */
  readonly #deliveredAt = new Map<string, number[]>();
  /** Checks whose events waited for the hourly cap, so they leave as one digest. */
  readonly #capHeld = new Set<string>();
  /** Checks with a failed delivery that the user already heard about. A good delivery clears it. */
  readonly #deliveryNoticed = new Set<string>();
  constructor(readonly options: EventCheckSchedulerOptions) {}
  get supported(): boolean {
    return this.options.reader !== undefined || this.apiSupported;
  }
  get apiSupported(): boolean {
    return this.options.apiReader !== undefined;
  }
  get templatesSupported(): boolean {
    return this.options.templates !== undefined && this.apiSupported;
  }
  templateList = () => mcpSync((): EventCheckTemplate[] => [...this.#templates().list()]);
  readonly templateInstall = Effect.fn("EventCheck.templateInstall")(function* (
    this: EventCheckScheduler,
    input: EventCheckTemplateInstallInput,
  ) {
    const prepared = yield* mcpSync(() => {
      this.#agent(input.agentId);
      const templates = this.#templates();
      return templates.install(templates.get(input.slug), input, new Date());
    });
    return yield* this.save(prepared);
  });
  readonly templateUpdate = Effect.fn("EventCheck.templateUpdate")(function* (
    this: EventCheckScheduler,
    input: { agentId: string; id: string },
  ) {
    const prepared = yield* mcpSync(() => {
      const templates = this.#templates();
      const check = this.options.store.get(input.agentId, input.id);
      const link = check.source.kind === "api" ? check.source.template : undefined;
      if (!link) throw new Error(sourceText("error.backend.eventCheckTemplateNotLinked"));
      return templates.upgrade(templates.get(link.slug), check);
    });
    return yield* this.save(prepared);
  });
  readonly templateAdopt = Effect.fn("EventCheck.templateAdopt")(function* (
    this: EventCheckScheduler,
    input: { agentId: string; id: string; slug: string },
  ) {
    const prepared = yield* mcpSync(() => {
      const templates = this.#templates();
      return templates.link(templates.get(input.slug), this.options.store.get(input.agentId, input.id));
    });
    return yield* this.save(prepared);
  });
  environment = (input: { agentId: string; id: string }) =>
    mcpSync(() => this.#apiReader().environment.status(this.options.store.get(input.agentId, input.id)));
  setEnvironment = (input: EventCheckEnvironmentInput) => this.#mutations.withPermit(this.#setEnvironment(input));
  readonly #setEnvironment = Effect.fn("EventCheck.setEnvironment")(function* (
    this: EventCheckScheduler,
    input: EventCheckEnvironmentInput,
  ) {
    const check = yield* mcpSync(() => {
      const previous = this.options.store.get(input.agentId, input.id);
      if (previous.source.kind !== "api" || !previous.source.variables.includes(input.name))
        throw new Error("Undeclared variable.");
      return this.options.store.save({ ...previous, active: false }, new Date(), true);
    });
    yield* this.#apiReader().environment.set(check, input.name, input.value);
    this.options.timer.arm();
    return yield* this.environment(input);
  });
  test = (input: { agentId: string; id: string }) => this.#runNow(input, true);
  list = (input: { agentId: string }) =>
    mcpSync(() => {
      this.#agent(input.agentId);
      return this.options.store
        .list(input.agentId)
        .map((check) => ({ ...check, health: this.options.store.health(check.id) }));
    });
  history = (input: { agentId: string; id: string }) =>
    mcpSync(() => this.options.store.history(input.agentId, input.id));
  accounts = (input: { agentId: string }) =>
    mcpSync(() => {
      this.#agent(input.agentId);
      return this.options.reader?.accounts(input.agentId) ?? [];
    });
  tools = (input: { agentId: string; connectionId: string }) =>
    this.#reader().read(input.agentId, input.connectionId, (session) => Effect.succeed(session.tools));
  readonly save = Effect.fn("EventCheck.save")(function* (this: EventCheckScheduler, input: EventCheckInput) {
    yield* mcpSync(() => {
      this.#agent(input.agentId);
      scheduleValid(input);
      if (
        input.active &&
        input.selfEvents.mode === "exclude" &&
        (input.selfEvents.connectionId !== input.source.connectionId ||
          !input.selfEvents.actorPointer ||
          !input.selfEvents.accountActorIds.length)
      )
        throw new Error(sourceText("error.backend.eventCheckSelfEvents"));
    });
    if (input.source.kind === "api")
      return yield* mcpSync(() => {
        const prepared = this.#apiReader().definition(input);
        if (
          input.active &&
          prepared.source.kind === "api" &&
          prepared.source.variables.length > 0 &&
          (!input.id ||
            this.#apiReader()
              .environment.status({ ...this.options.store.get(input.agentId, input.id), source: input.source })
              .some((variable) => !variable.configured))
        )
          throw new Error(sourceText("error.backend.eventCheckMissingVariable"));
        const check = this.options.store.save(prepared, new Date());
        this.options.timer.arm();
        return check;
      });
    if (!input.active && input.id)
      return yield* mcpSync(() => {
        const check = this.options.store.save(input, new Date());
        this.options.timer.arm();
        return check;
      });
    return yield* this.#reader().read(input.agentId, input.source.connectionId, (session) =>
      mcpSync(() => {
        if (!session.valid() || !session.tools.some((tool) => tool.name === input.source.toolName))
          throw new Error(sourceText("error.mcp.chatDenied"));
        const check = this.options.store.save(input, new Date());
        this.options.timer.arm();
        return check;
      }),
    );
  });
  remove = (input: { agentId: string; id: string }) =>
    this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const check = yield* mcpSync(() => this.options.store.get(input.agentId, input.id));
        yield* mcpSync(() => this.options.store.remove(input.agentId, input.id));
        if (check.source.kind === "api") yield* this.#apiReader().environment.remove(check);
        this.options.timer.arm();
      }),
    );
  checkNow = (input: { agentId: string; id: string }) => this.#runNow(input, false);
  #runNow = (input: { agentId: string; id: string }, test: boolean) =>
    Effect.suspend(() => {
      const check = this.options.store.get(input.agentId, input.id);
      if (this.#running.has(check.id))
        return mcpSync(() => {
          throw new Error(sourceText("error.backend.eventCheckBusy"));
        });
      this.#running.add(check.id);
      return this.#execute(check, test).pipe(Effect.ensuring(Effect.sync(() => this.#running.delete(check.id))));
    });
  nextDueAt(): string | null {
    return this.options.store.nextDueAt();
  }
  readonly processDue = Effect.fn("EventCheck.processDue")(function* (
    this: EventCheckScheduler,
    now: Date,
    active: () => boolean,
  ) {
    yield* this.resumePending().pipe(Effect.forkIn(this.options.scope()));
    const checks = yield* mcpSync(() =>
      this.options.store.list().filter((check) => check.active && check.nextCheckAt <= now.toISOString()),
    );
    for (const check of checks) {
      if (!active()) break;
      yield* mcpSync(() => this.options.store.advance(check, now));
      if (this.#running.has(check.id)) continue;
      this.#running.add(check.id);
      yield* this.#execute(check).pipe(
        Effect.ensuring(Effect.sync(() => this.#running.delete(check.id))),
        Effect.forkIn(this.options.scope()),
      );
    }
  });
  readonly #execute = Effect.fn("EventCheck.execute")(function* (
    this: EventCheckScheduler,
    check: EventCheck,
    test = false,
  ) {
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    let committed: EventCheckExecution | null = null;
    return yield* mcpSync(() => {
      if (!this.options.store.current(check.id, check.revision)) throw new Error("Stale check.");
      if (check.source.kind !== "api") return check;
      const prepared = this.#apiReader().definition(check);
      return JSON.stringify(prepared.source) === JSON.stringify(check.source)
        ? check
        : this.options.store.save(prepared, new Date(), true);
    })
      .pipe(
        Effect.flatMap((prepared) => {
          check = prepared;
          return this.#read(check, (session) =>
            Effect.gen({ self: this }, function* () {
              if (!test) yield* this.#flush(check, session);
              const state = yield* mcpSync(() => this.options.store.state(check.id));
              const items = yield* this.#collect(check, session, state.lastSuccessAt);
              const observation = yield* mcpSync(() =>
                observeCheck(items, check.selection, state.baseline, check.selfEvents, check.delivery?.itemFilters),
              );
              const current = test ? session.valid() : this.#valid(check, session);
              const status = !current
                ? "cancelled"
                : test || !state.baseline
                  ? "baseline"
                  : observation.changed.length
                    ? "triggered"
                    : "unchanged";
              const execution = this.#execution(
                id,
                check.id,
                startedAt,
                status,
                observation.itemCount,
                current && !test ? observation.changed.length : 0,
                null,
                observation.skippedSelfCount,
                observation.filteredCount,
              );
              yield* mcpSync(() =>
                this.options.store.finish(check, execution, current && !test ? observation : undefined),
              );
              committed = execution;
              if (!current || test) return execution;
              return yield* this.#flush(check, session).pipe(
                Effect.as(execution),
                Effect.catchCause(() =>
                  mcpSync(() => {
                    this.#noteDeliveryFailure(check);
                    return this.options.store.deliveryError(execution, sourceText("error.backend.eventCheckDelivery"));
                  }),
                ),
              );
            }),
          );
        }),
      )
      .pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause((cause) =>
          mcpSync(() => {
            if (committed) {
              this.#noteDeliveryFailure(check);
              return this.options.store.deliveryError(committed, sourceText("error.backend.eventCheckDelivery"));
            }
            // A program names why it failed with one allow-listed code. Its own text is never shown.
            const programError = eventCheckProgramError(Cause.squash(cause));
            const execution = this.#execution(
              id,
              check.id,
              startedAt,
              "error",
              0,
              0,
              programError?.message ?? sourceText("error.backend.eventCheckFailed"),
            );
            this.options.store.finish(check, execution);
            this.#noteFailureStreak(check, execution);
            return execution;
          }),
        ),
      );
  });
  /** Tells the user once, at the fifth error in a row. A success ends the streak, and the next streak can tell again. */
  #noteFailureStreak(check: EventCheck, execution: EventCheckExecution): void {
    if (this.options.store.consecutiveErrors(check.id) !== EVENT_CHECK_FAILURE_NOTICE_STREAK) return;
    // A paused check that a person runs by hand has told its story in the log already.
    if (this.options.store.current(check.id, check.revision)?.active !== true) return;
    this.options.notify?.(
      check.agentId,
      "event_check_failing",
      sourceText("error.backend.eventCheckStreak", {
        name: check.name,
        count: EVENT_CHECK_FAILURE_NOTICE_STREAK,
        reason: execution.error ?? sourceText("error.backend.eventCheckFailed"),
      }),
    );
  }
  #noteDeliveryFailure(check: EventCheck): void {
    if (this.#deliveryNoticed.has(check.id)) return;
    this.#deliveryNoticed.add(check.id);
    this.options.notify?.(
      check.agentId,
      "event_check_delivery_failed",
      sourceText("error.backend.eventCheckDeliveryFailed", { name: check.name }),
    );
  }
  #execution(
    id: string,
    checkId: string,
    startedAt: string,
    status: EventCheckExecution["status"],
    itemCount: number,
    eventCount: number,
    error: string | null,
    skippedSelfCount = 0,
    filteredCount = 0,
  ): EventCheckExecution {
    const finishedAt = new Date().toISOString();
    return {
      id,
      checkId,
      startedAt,
      finishedAt,
      status,
      itemCount,
      eventCount,
      skippedSelfCount,
      filteredCount,
      error,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
    };
  }
  readonly #collect = Effect.fn("EventCheck.collect")(function* (
    this: EventCheckScheduler,
    check: EventCheck,
    session: EventCheckReadSession,
    lastSuccessAt: string | null,
  ) {
    const args = yield* mcpSync(() => this.#arguments(check.source.argumentsJson, lastSuccessAt));
    const items: EventCheckData[] = [];
    const seen = new Set<string>();
    let cursor: string | number | null = null;
    for (let page = 0; page < 20; page++) {
      const argumentsForPage: EventCheckArguments =
        cursor === null ? args : { ...args, [check.source.cursorArgument]: cursor };
      const result: EventCheckData = yield* session.call(check.source.toolName, argumentsForPage);
      const data: EventCheckData = yield* mcpSync(() =>
        session.dataKind === "api" ? result : checkResultData(result),
      );
      const next: string | number | null = yield* mcpSync(() => this.#page(check, data, items));
      if (next === null) return items;
      if (!check.source.cursorArgument || seen.has(String(next)))
        return yield* mcpSync(() => {
          throw new Error("Incomplete result pagination.");
        });
      seen.add(String(next));
      cursor = next;
    }
    return yield* mcpSync(() => {
      throw new Error("Too many result pages.");
    });
  });
  #page(check: EventCheck, data: EventCheckData, items: EventCheckData[]): string | number | null {
    const selected = checkPointer(data, check.selection.itemsPointer);
    if (!Array.isArray(selected)) throw new Error("Expected a result list.");
    items.push(...selected);
    if (items.length > CHECK_MAX_ITEMS || JSON.stringify(items).length > CHECK_MAX_BYTES)
      throw new Error("Result too large.");
    if (check.source.kind === "api") {
      const more = checkPointer(data, "/hasNextPage");
      if (typeof more !== "boolean") throw new Error("Invalid page state.");
      if (!more) return null;
      if (!check.source.nextCursorPointer || !check.source.cursorArgument)
        throw new Error("Incomplete API pagination.");
    }
    if (!check.source.nextCursorPointer) return null;
    const next = checkPointer(data, check.source.nextCursorPointer);
    if (next === null || next === "" || next === false) {
      if (check.source.kind === "api") throw new Error("Incomplete API pagination.");
      return null;
    }
    if (typeof next !== "string" && typeof next !== "number") throw new Error("Invalid result cursor.");
    return next;
  }
  #arguments(json: string, lastSuccessAt: string | null): EventCheckArguments {
    const now = new Date();
    const since = new Date((lastSuccessAt ? Date.parse(lastSuccessAt) : now.getTime()) - 300_000).toISOString();
    const parsed = decodeTeamProtocolV2Json(
      JSON.parse(json, (_key, value) =>
        value === "$lastSuccessAt" ? since : value === "$now" ? now.toISOString() : value,
      ),
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid app arguments.");
    return parsed;
  }
  #valid(check: EventCheck, session: EventCheckReadSession): boolean {
    return (
      this.options.running() &&
      this.options.agentExists(check.agentId) &&
      session.valid() &&
      this.options.store.current(check.id, check.revision)?.active === true
    );
  }
  readonly resumePending = Effect.fn("EventCheck.resumePending")(function* (this: EventCheckScheduler) {
    const events = yield* mcpSync(() => this.options.store.pending());
    for (const event of events) {
      if (this.#delivering.has(event.id)) continue;
      const check = this.options.store.current(event.checkId, event.revision);
      if (!check?.active) continue;
      yield* this.#read(check, (session) => this.#flush(check, session)).pipe(Effect.catchCause(() => Effect.void));
    }
  });
  readonly #flush = Effect.fn("EventCheck.flush")(function* (
    this: EventCheckScheduler,
    check: EventCheck,
    session: EventCheckReadSession,
  ) {
    const events = yield* mcpSync(() =>
      this.options.store
        .pending(check.id)
        .filter((event) => event.checkId === check.id && event.revision === check.revision),
    );
    for (const batch of this.#batches(check, events, Date.now())) {
      if (batch.sources.some((event) => this.#delivering.has(event.id)) || !this.#valid(check, session)) continue;
      if (this.#deliveriesInLastHour(check.id) >= (this.options.deliveryCap ?? EVENT_CHECK_HOURLY_DELIVERY_CAP)) {
        // Held, not dropped: the events stay in the outbox and leave as one digest when an hour slot frees.
        this.#capHeld.add(check.id);
        break;
      }
      for (const event of batch.sources) this.#delivering.add(event.id);
      yield* this.options
        .deliver(
          check,
          batch.event,
          { checkId: check.id, executionId: batch.event.executionId, name: check.name },
          () => this.#valid(check, session),
        )
        .pipe(
          Effect.mapError(mcpFailure),
          Effect.flatMap((deliveryId) =>
            mcpSync(() => {
              for (const event of batch.sources) this.options.store.delivered(event, deliveryId);
              this.#recordDelivery(check.id);
              this.#deliveryNoticed.delete(check.id);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              for (const event of batch.sources) this.#delivering.delete(event.id);
            }),
          ),
        );
    }
    if (!(yield* mcpSync(() => this.options.store.pending(check.id).length))) this.#capHeld.delete(check.id);
  });
  /**
   * What to hand to the agent now. By default each execution's event goes alone. With a digest window,
   * or after the hourly cap held events back, everything pending merges into prompts of one digest:
   * an item that changed twice appears once, with its newest data.
   */
  #batches(check: EventCheck, events: CheckOutbox[], now: number): { event: CheckOutbox; sources: CheckOutbox[] }[] {
    const windowMs = (check.delivery?.digestSeconds ?? 0) * 1000;
    const [oldest] = events;
    if (!oldest) return [];
    if (windowMs > 0 && now < Date.parse(oldest.createdAt ?? "") + windowMs) return [];
    if (windowMs === 0 && !this.#capHeld.has(check.id))
      return events.map((event) => ({ event: this.#merged(check, [event]), sources: [event] }));
    const batches: { event: CheckOutbox; sources: CheckOutbox[] }[] = [];
    let group: CheckOutbox[] = [];
    for (const event of events) {
      const candidate = this.#merged(check, [...group, event]);
      if (group.length > 0 && candidate.text.length > DIGEST_TEXT_LIMIT) {
        batches.push({ event: this.#merged(check, group), sources: group });
        group = [];
      }
      group.push(event);
    }
    if (group.length > 0) batches.push({ event: this.#merged(check, group), sources: group });
    return batches;
  }
  #merged(check: EventCheck, events: CheckOutbox[]): CheckOutbox {
    const [first] = events;
    const last = events.at(-1);
    if (!first || !last) throw new Error("Missing event.");
    // The text is rebuilt at delivery, so an instruction edited after the event was queued still applies.
    if (events.length === 1) return { ...first, text: eventCheckPrompt(check, first.items) };
    const byId = new Map<string, EventCheckData>();
    for (const event of events)
      for (const item of event.items) {
        let key: string;
        try {
          const id = checkPointer(item, check.selection.idPointer);
          key = `id:${String(id)}`;
        } catch {
          key = `json:${JSON.stringify(item)}`;
        }
        byId.delete(key);
        byId.set(key, item);
      }
    const items = [...byId.values()];
    return {
      id: `check-digest:${createHash("sha256")
        .update(events.map((event) => event.id).join("\n"))
        .digest("hex")
        .slice(0, 32)}`,
      checkId: check.id,
      revision: check.revision,
      executionId: last.executionId,
      items,
      text: eventCheckPrompt(check, items),
    };
  }
  #deliveriesInLastHour(checkId: string): number {
    const cutoff = Date.now() - HOUR_MS;
    const recent = (this.#deliveredAt.get(checkId) ?? []).filter((time) => time > cutoff);
    this.#deliveredAt.set(checkId, recent);
    return recent.length;
  }
  #recordDelivery(checkId: string): void {
    this.#deliveriesInLastHour(checkId);
    this.#deliveredAt.get(checkId)?.push(Date.now());
  }
  #agent(id: string): void {
    if (!this.options.agentExists(id)) throw new Error(sourceText("error.agent.unknown", { id }));
  }
  #read<A>(
    check: EventCheck,
    use: (session: EventCheckReadSession) => Effect.Effect<A, import("./mcp-effects").McpOperationError>,
  ) {
    return check.source.kind === "api"
      ? this.#apiReader().read(check, use)
      : this.#reader().read(check.agentId, check.source.connectionId, use);
  }
  #templates(): EventCheckTemplates {
    if (!this.options.templates || !this.options.apiReader)
      throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.templates;
  }
  #apiReader(): EventCheckApiReader {
    if (!this.options.apiReader) throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.apiReader;
  }
  #reader(): EventCheckReader {
    if (!this.options.reader) throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.reader;
  }
}
