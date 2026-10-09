import { randomUUID } from "node:crypto";
import type {
  EventCheck,
  EventCheckExecution,
  EventCheckInput,
  EventCheckOrigin,
} from "@openbot/contracts/event-checks";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { nextEventCheckOccurrence } from "@openbot/team-client/event-check-schedule";
import { Effect, type Scope } from "effect";
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
import type { CheckOutbox, EventCheckStore } from "./event-check-store";
import { mcpFailure, mcpSync } from "./mcp-effects";
import type { RoutineDueSource, RoutineTimer } from "./routine-timer";

interface Options {
  store: EventCheckStore;
  reader?: EventCheckReader;
  scope(): Scope.Scope;
  timer: RoutineTimer;
  agentExists(id: string): boolean;
  running(): boolean;
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
  readonly #running = new Set<string>();
  readonly #delivering = new Set<string>();
  constructor(readonly options: Options) {}
  get supported(): boolean {
    return this.options.reader !== undefined;
  }
  list = (input: { agentId: string }) =>
    mcpSync(() => {
      this.#agent(input.agentId);
      return this.options.store.list(input.agentId);
    });
  history = (input: { agentId: string; id: string }) =>
    mcpSync(() => this.options.store.history(input.agentId, input.id));
  accounts = (input: { agentId: string }) =>
    mcpSync(() => {
      this.#agent(input.agentId);
      return this.#reader().accounts(input.agentId);
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
    mcpSync(() => {
      this.options.store.remove(input.agentId, input.id);
      this.options.timer.arm();
    });
  checkNow = (input: { agentId: string; id: string }) =>
    Effect.suspend(() => {
      const check = this.options.store.get(input.agentId, input.id);
      if (this.#running.has(check.id))
        return mcpSync(() => {
          throw new Error(sourceText("error.backend.eventCheckBusy"));
        });
      this.#running.add(check.id);
      return this.#execute(check).pipe(Effect.ensuring(Effect.sync(() => this.#running.delete(check.id))));
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
  readonly #execute = Effect.fn("EventCheck.execute")(function* (this: EventCheckScheduler, check: EventCheck) {
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    let committed: EventCheckExecution | null = null;
    return yield* this.#reader()
      .read(check.agentId, check.source.connectionId, (session) =>
        Effect.gen({ self: this }, function* () {
          yield* this.#flush(check, session);
          const state = yield* mcpSync(() => this.options.store.state(check.id));
          const items = yield* this.#collect(check, session, state.lastSuccessAt);
          const observation = yield* mcpSync(() =>
            observeCheck(items, check.selection, state.baseline, check.selfEvents),
          );
          const current = this.#valid(check, session);
          const status = !current
            ? "cancelled"
            : !state.baseline
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
            current ? observation.changed.length : 0,
            null,
            observation.skippedSelfCount,
          );
          yield* mcpSync(() => this.options.store.finish(check, execution, current ? observation : undefined));
          committed = execution;
          if (!current) return execution;
          return yield* this.#flush(check, session).pipe(
            Effect.as(execution),
            Effect.catchCause(() =>
              mcpSync(() =>
                this.options.store.deliveryError(execution, sourceText("error.backend.eventCheckDelivery")),
              ),
            ),
          );
        }),
      )
      .pipe(
        Effect.timeout("45 seconds"),
        Effect.catchCause(() =>
          mcpSync(() => {
            if (committed)
              return this.options.store.deliveryError(committed, sourceText("error.backend.eventCheckDelivery"));
            const execution = this.#execution(
              id,
              check.id,
              startedAt,
              "error",
              0,
              0,
              sourceText("error.backend.eventCheckFailed"),
            );
            this.options.store.finish(check, execution);
            return execution;
          }),
        ),
      );
  });
  #execution(
    id: string,
    checkId: string,
    startedAt: string,
    status: EventCheckExecution["status"],
    itemCount: number,
    eventCount: number,
    error: string | null,
    skippedSelfCount = 0,
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
      const data: EventCheckData = yield* mcpSync(() => checkResultData(result));
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
    if (!check.source.nextCursorPointer) return null;
    const next = checkPointer(data, check.source.nextCursorPointer);
    if (next === null || next === "" || next === false) return null;
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
      yield* this.#reader()
        .read(check.agentId, check.source.connectionId, (session) => this.#flush(check, session))
        .pipe(Effect.catchCause(() => Effect.void));
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
    for (const event of events) {
      if (this.#delivering.has(event.id) || !this.#valid(check, session)) continue;
      this.#delivering.add(event.id);
      yield* this.options
        .deliver(
          check,
          { ...event, text: eventCheckPrompt(check, event.items) },
          { checkId: check.id, executionId: event.executionId, name: check.name },
          () => this.#valid(check, session),
        )
        .pipe(
          Effect.mapError(mcpFailure),
          Effect.flatMap((deliveryId) => mcpSync(() => this.options.store.delivered(event, deliveryId))),
          Effect.ensuring(Effect.sync(() => this.#delivering.delete(event.id))),
        );
    }
  });
  #agent(id: string): void {
    if (!this.options.agentExists(id)) throw new Error(sourceText("error.agent.unknown", { id }));
  }
  #reader(): EventCheckReader {
    if (!this.options.reader) throw new Error(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.reader;
  }
}
