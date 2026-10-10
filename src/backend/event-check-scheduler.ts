import { createHash, randomUUID } from "node:crypto";
import {
  decodeEventCheckPickerOptions,
  type EventCheckDiscoverCheckInput,
  type EventCheckPickerOptions,
  type EventCheckTemplate,
  type EventCheckTemplateDiscoverInput,
  type EventCheckTemplateInstallInput,
} from "@openbot/contracts/event-check-templates";
import type {
  EventCheck,
  EventCheckEnvironmentInput,
  EventCheckExecution,
  EventCheckInput,
  EventCheckOrigin,
} from "@openbot/contracts/event-checks";
import { decodeTeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { sourceText } from "@openbot/i18n/source";
import { containsCredential, registerSecretValue } from "@openbot/logging";
import { nextEventCheckOccurrence } from "@openbot/team-client/event-check-schedule";
import { Cause, Effect, type Scope, Semaphore } from "effect";
import type { EventCheckApiReader } from "./event-check-api-reader";
import { eventCheckDestination } from "./event-check-approval";
import { eventCheckProgramError } from "./event-check-program";
import type {
  EventCheckArguments,
  EventCheckData,
  EventCheckReader,
  EventCheckReadSession,
} from "./event-check-reader";
import { EventCheckRefusal, refusalMessage } from "./event-check-refusal";
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
import { type McpOperationError, mcpFailure, mcpSync } from "./mcp-effects";
import type { RoutineDueSource, RoutineTimer } from "./routine-timer";
import { authorOf, plainName, type SecurityActor } from "./security-actor";
import { auditActor, NO_SECURITY_AUDIT, type SecurityAuditSink } from "./security-audit-log";

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
  audit?: SecurityAuditSink;
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
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckSchedule"));
    previous = next;
  }
}
/**
 * An agent's save tool cannot carry the link to a template. A save that leaves the program as it was
 * keeps the link the check had, so a re-save does not turn a template check into one nobody can update.
 */
function keepTemplateLink(input: EventCheckInput, previous: EventCheck | null): EventCheckInput {
  if (!previous || input.source.kind !== "api" || previous.source.kind !== "api") return input;
  if (input.source.template || !previous.source.template || previous.source.toolName !== input.source.toolName)
    return input;
  return { ...input, source: { ...input.source, template: previous.source.template } };
}
/** Owns deterministic polls and durable wakeups. Empty checks never enter the agent runtime. */
export class EventCheckScheduler implements RoutineDueSource {
  readonly #mutations = Semaphore.makeUnsafe(1);
  /** Listing choices starts a program each time, so only a few run at once. The others wait. */
  readonly #discoveries = Semaphore.makeUnsafe(2);
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
    actor: SecurityActor,
  ) {
    const prepared = yield* mcpSync(() => {
      this.#agent(input.agentId);
      const templates = this.#templates();
      return templates.install(templates.get(input.slug), input, new Date());
    });
    return yield* this.#save(prepared, actor, "event-check.template-install");
  });
  readonly templateUpdate = Effect.fn("EventCheck.templateUpdate")(function* (
    this: EventCheckScheduler,
    input: { agentId: string; id: string },
    actor: SecurityActor,
  ) {
    const prepared = yield* mcpSync(() => {
      const templates = this.#templates();
      const check = this.options.store.get(input.agentId, input.id);
      const link = check.source.kind === "api" ? check.source.template : undefined;
      if (!link) throw new EventCheckRefusal(sourceText("error.backend.eventCheckTemplateNotLinked"));
      return templates.upgrade(templates.get(link.slug), check);
    });
    return yield* this.#save(prepared, actor, "event-check.template-update");
  });
  readonly templateAdopt = Effect.fn("EventCheck.templateAdopt")(function* (
    this: EventCheckScheduler,
    input: { agentId: string; id: string; slug: string },
    actor: SecurityActor,
  ) {
    const prepared = yield* mcpSync(() => {
      const templates = this.#templates();
      return templates.link(templates.get(input.slug), this.options.store.get(input.agentId, input.id));
    });
    return yield* this.#save(prepared, actor, "event-check.template-link");
  });
  /**
   * The choices of a picker setting, for an install form that has no check yet. The typed private
   * values are used for this one call, in memory. They are not stored, not audited, and not part of
   * any error text. Only a person asks: an agent tool does not reach this method, and it refuses an
   * agent actor besides.
   */
  readonly templateDiscover = Effect.fn("EventCheck.templateDiscover")(function* (
    this: EventCheckScheduler,
    input: EventCheckTemplateDiscoverInput,
    actor: SecurityActor,
  ) {
    const prepared = yield* mcpSync(() => {
      if (actor.kind === "agent")
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckDiscoverUnsupported"));
      const templates = this.#templates();
      const draft = templates.draftDiscovery(templates.get(input.slug), input);
      // A draft value never reaches a log through this path, and a stray copy of it would be masked.
      // A short value is not registered: a typed "x" must not mask every x in every later log line.
      for (const value of Object.values(draft.variables)) registerSecretValue(value);
      return draft;
    });
    return yield* this.#discoveries.withPermit(
      this.#apiReader()
        .discover(prepared.name, prepared.digest, prepared.variables, prepared.configuration)
        .pipe(Effect.flatMap(this.#pickerOptions), Effect.mapError(this.#discoveryFailure)),
    );
  });
  /** The same for an installed check, with the private values that it holds and the user approved. */
  readonly discoverCheck = Effect.fn("EventCheck.discoverCheck")(function* (
    this: EventCheckScheduler,
    input: EventCheckDiscoverCheckInput,
    actor: SecurityActor,
  ) {
    const check = yield* mcpSync(() => {
      if (actor.kind === "agent")
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckDiscoverUnsupported"));
      const check = this.options.store.get(input.agentId, input.id);
      this.#templates().discoverable(check, input.field);
      return check;
    }).pipe(Effect.mapError(this.#discoveryFailure));
    return yield* this.#discoveries.withPermit(
      this.#apiReader()
        .read(check, (session) => session.call("discover", { discover: true }))
        .pipe(Effect.flatMap(this.#pickerOptions), Effect.mapError(this.#discoveryFailure)),
    );
  });
  /** What a program printed, read as untrusted text: a wrong shape fails with the generic text. */
  readonly #pickerOptions = (value: unknown): Effect.Effect<EventCheckPickerOptions, McpOperationError> =>
    mcpSync(() => decodeEventCheckPickerOptions(value));
  /**
   * A failure of a discovery as a refusal with fixed text: the program's code text, a refusal that
   * names a step, or the generic text. Program output and values never reach the message.
   */
  readonly #discoveryFailure = (failure: McpOperationError): McpOperationError => {
    const message =
      refusalMessage(failure) ??
      eventCheckProgramError(failure)?.message ??
      sourceText("error.backend.eventCheckFailed");
    return mcpFailure(new EventCheckRefusal(message));
  };
  environment = (input: { agentId: string; id: string }) =>
    mcpSync(() => this.#apiReader().environment.status(this.options.store.get(input.agentId, input.id)));
  /** Gives program files that earlier releases stored values for the approval of the program they had. */
  readonly adoptLegacyApprovals = Effect.fn("EventCheck.adoptLegacyApprovals")(function* (this: EventCheckScheduler) {
    const reader = this.options.apiReader;
    if (!reader) return;
    const checks = yield* mcpSync(() => this.options.store.list());
    for (const check of checks)
      if (check.source.kind === "api" && check.source.variables.length > 0)
        yield* reader.environment.adoptLegacy(check).pipe(Effect.catchCause(() => Effect.void));
  });
  /** Only a person sets a private value. This is for the app and the team API, never for an agent tool. */
  setEnvironment = (input: EventCheckEnvironmentInput, actor: SecurityActor) =>
    this.#mutations.withPermit(this.#setEnvironment(input, actor));
  readonly #setEnvironment = Effect.fn("EventCheck.setEnvironment")(function* (
    this: EventCheckScheduler,
    input: EventCheckEnvironmentInput,
    actor: SecurityActor,
  ) {
    const check = yield* mcpSync(() => {
      if (actor.kind === "agent") throw new Error("Agents cannot set private variables.");
      const previous = this.options.store.get(input.agentId, input.id);
      if (previous.source.kind !== "api" || !previous.source.variables.includes(input.name))
        throw new Error("Undeclared variable.");
      // The digest of the file as it is now. Setting a value approves exactly this program.
      return this.options.store.save({ ...this.#apiReader().definition(previous), active: false }, new Date(), true);
    });
    yield* this.#apiReader().environment.set(check, input.name, input.value);
    this.options.timer.arm();
    yield* this.#audit(
      actor,
      input.value === null ? "event-check.remove-variable" : "event-check.set-variable",
      check,
      [input.name],
    );
    return yield* this.environment(input);
  });
  /** Records that a tool call was refused before it reached the check. */
  refused = (actor: SecurityActor, tool: string, agentId: string) =>
    (this.options.audit ?? NO_SECURITY_AUDIT).record({
      actor: auditActor(actor),
      action: `event-check.tool-refused`,
      target: { kind: "agent", id: agentId },
      names: [tool],
      outcome: "refused",
    });
  #audit(actor: SecurityActor, action: string, check: EventCheck, names?: string[], refused = false) {
    return (this.options.audit ?? NO_SECURITY_AUDIT).record({
      actor: auditActor(actor),
      action,
      target: { kind: "event-check", id: check.id, agentId: check.agentId, name: plainName(check.name) },
      ...(names ? { names } : {}),
      ...(refused ? { outcome: "refused" as const } : {}),
    });
  }
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
  readonly save = (input: EventCheckInput, actor: SecurityActor) => this.#save(input, actor);
  /**
   * The fields that say what a check reads and tells: an author changes only when these change. The
   * keys are sorted, so the order that a client wrote them in does not look like a change.
   */
  #content(check: EventCheckInput): string {
    const sorted = (record: EventCheckInput["source"] | EventCheckInput["selection"]) =>
      Object.entries(record)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    const source =
      check.source.kind === "api" ? { ...check.source, programDigest: undefined, template: undefined } : check.source;
    return JSON.stringify([check.name, check.instruction, sorted(source), sorted(check.selection)]);
  }
  /**
   * Refuses a field that holds a credential. Only a field the request changes is checked, so a check
   * that already holds one can still be paused or deleted. The message names the field, never the value.
   */
  #screen(input: EventCheckInput, previous: EventCheckInput | null): void {
    const fields: Array<[string, string, string | undefined]> = [
      [sourceText("error.backend.eventCheckFieldName"), input.name, previous?.name],
      [sourceText("error.backend.eventCheckFieldInstruction"), input.instruction, previous?.instruction],
      [
        sourceText("error.backend.eventCheckFieldArguments"),
        input.source.argumentsJson,
        previous?.source.argumentsJson,
      ],
      [sourceText("error.backend.eventCheckFieldAccount"), input.source.connectionId, previous?.source.connectionId],
    ];
    if (input.source.kind === "api") {
      const held = new Map(
        previous?.source.kind === "api" ? previous.source.configuration.map((field) => [field.name, field.value]) : [],
      );
      for (const field of input.source.configuration)
        fields.push([field.label.trim() || field.name, field.value, held.get(field.name)]);
    }
    for (const [label, value, before] of fields)
      if (value !== before && containsCredential(value))
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckCredentialField", { field: label }));
  }
  readonly #save = Effect.fn("EventCheck.save")(function* (
    this: EventCheckScheduler,
    request: EventCheckInput,
    actor: SecurityActor,
    action?: string,
  ) {
    // Only a person approves a program. The flag is never stored, and an agent tool cannot use it.
    const { approveProgram, ...requested } = request;
    const approving = approveProgram === true && actor.kind !== "agent";
    const previous = yield* mcpSync(() =>
      requested.id ? this.options.store.get(requested.agentId, requested.id) : null,
    );
    const input = keepTemplateLink(requested, previous);
    yield* mcpSync(() => {
      this.#agent(input.agentId);
      scheduleValid(input);
      this.#screen(input, previous);
      if (
        input.active &&
        input.selfEvents.mode === "exclude" &&
        (input.selfEvents.connectionId !== input.source.connectionId ||
          !input.selfEvents.actorPointer ||
          !input.selfEvents.accountActorIds.length)
      )
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckSelfEvents"));
    });
    const author =
      previous && this.#content(previous) === this.#content(input) ? previous.lastSavedBy : authorOf(actor);
    const kind =
      action ??
      (!previous
        ? "event-check.create"
        : previous.active !== input.active && this.#content(previous) === this.#content(input)
          ? input.active
            ? "event-check.enable"
            : "event-check.disable"
          : "event-check.save");
    const withAuthor = (check: EventCheckInput): EventCheckInput => {
      const { lastSavedBy: _client, ...rest } = check;
      return author ? { ...rest, lastSavedBy: author } : rest;
    };
    const record = (check: EventCheck) =>
      this.#audit(actor, kind, check, previous ? this.#changed(previous, check) : undefined);
    if (input.source.kind === "api") {
      const saved = yield* Effect.gen({ self: this }, function* () {
        const prepared = yield* mcpSync(() => this.#apiReader().definition(input));
        if (prepared.source.kind !== "api")
          return yield* mcpSync(() => {
            throw new Error("Invalid program source.");
          });
        const source = prepared.source;
        const environment = this.#apiReader().environment;
        if (source.variables.length > 0 && previous?.source.kind === "api") {
          const candidate: EventCheck = { ...previous, source };
          const unchanged: EventCheck = {
            ...previous,
            source: { ...previous.source, programDigest: source.programDigest },
          };
          // A person who edits an address setting of an approved program moves the approval with it.
          // A person who asks for it approves the program too. An agent does neither.
          if (
            actor.kind !== "agent" &&
            (approving ||
              (environment.state(unchanged) === "approved" &&
                eventCheckDestination(source) !== eventCheckDestination(previous.source)))
          )
            yield* environment.approve(candidate);
        }
        if (prepared.active && source.variables.length > 0) {
          const candidate: EventCheck | null = previous ? { ...previous, source } : null;
          const status = candidate ? environment.status(candidate) : [];
          if (!candidate || status.some((variable) => !variable.configured)) {
            const stale = status.some((variable) => variable.reapprove === true);
            if (candidate) yield* this.#audit(actor, "event-check.enable", candidate, undefined, true);
            return yield* mcpSync(() => {
              throw new EventCheckRefusal(
                sourceText(
                  stale ? "error.backend.eventCheckApprovalNeeded" : "error.backend.eventCheckMissingVariable",
                ),
              );
            });
          }
        }
        return yield* mcpSync(() => {
          const check = this.options.store.save(withAuthor(prepared), new Date());
          this.options.timer.arm();
          return check;
        });
      });
      yield* record(saved);
      return saved;
    }
    if (!input.active && input.id) {
      const saved = yield* mcpSync(() => {
        const check = this.options.store.save(withAuthor(input), new Date());
        this.options.timer.arm();
        return check;
      });
      yield* record(saved);
      return saved;
    }
    const saved = yield* this.#reader().read(input.agentId, input.source.connectionId, (session) =>
      mcpSync(() => {
        if (!session.valid() || !session.tools.some((tool) => tool.name === input.source.toolName))
          throw new EventCheckRefusal(sourceText("error.mcp.chatDenied"));
        const check = this.options.store.save(withAuthor(input), new Date());
        this.options.timer.arm();
        return check;
      }),
    );
    yield* record(saved);
    return saved;
  });
  /** Names of the top-level fields that differ, for the audit file. Never values. */
  #changed(previous: EventCheck, next: EventCheck): string[] {
    const names: string[] = [];
    if (previous.name !== next.name) names.push("name");
    if (previous.instruction !== next.instruction) names.push("instruction");
    if (previous.active !== next.active) names.push("active");
    if (JSON.stringify(previous.schedule) !== JSON.stringify(next.schedule) || previous.timezone !== next.timezone)
      names.push("schedule");
    if (JSON.stringify(previous.selection) !== JSON.stringify(next.selection)) names.push("selection");
    if (JSON.stringify(previous.selfEvents) !== JSON.stringify(next.selfEvents)) names.push("selfEvents");
    if (previous.source.kind !== next.source.kind) names.push("source");
    else if (previous.source.kind === "api" && next.source.kind === "api") {
      if (previous.source.toolName !== next.source.toolName) names.push("program");
      else if (previous.source.programDigest !== next.source.programDigest) names.push("programDigest");
      if (previous.source.argumentsJson !== next.source.argumentsJson) names.push("arguments");
      if (JSON.stringify(previous.source.variables) !== JSON.stringify(next.source.variables)) names.push("variables");
      for (const field of next.source.configuration)
        if (previous.source.configuration.find((held) => held.name === field.name)?.value !== field.value)
          names.push(`setting:${field.name}`);
    } else if (JSON.stringify(previous.source) !== JSON.stringify(next.source)) names.push("source");
    return names;
  }
  remove = (input: { agentId: string; id: string }, actor: SecurityActor) =>
    this.#mutations.withPermit(
      Effect.gen({ self: this }, function* () {
        const check = yield* mcpSync(() => this.options.store.get(input.agentId, input.id));
        yield* mcpSync(() => this.options.store.remove(input.agentId, input.id));
        if (check.source.kind === "api") yield* this.#apiReader().environment.remove(check);
        this.options.timer.arm();
        yield* this.#audit(actor, "event-check.delete", check);
      }),
    );
  checkNow = (input: { agentId: string; id: string }) => this.#runNow(input, false);
  #runNow = (input: { agentId: string; id: string }, test: boolean) =>
    Effect.suspend(() => {
      const check = this.options.store.get(input.agentId, input.id);
      if (this.#running.has(check.id))
        return mcpSync(() => {
          throw new EventCheckRefusal(sourceText("error.backend.eventCheckBusy"));
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
    let paused: EventCheck | null = null;
    return yield* mcpSync(() => {
      if (!this.options.store.current(check.id, check.revision)) throw new Error("Stale check.");
      if (check.source.kind !== "api") return check;
      const prepared = this.#apiReader().definition(check);
      if (JSON.stringify(prepared.source) === JSON.stringify(check.source)) return check;
      // The program or an address setting is not what the user approved, and private values exist.
      // The check stops here. It keeps the new digest, so its status says the values need approval.
      if (
        prepared.source.kind === "api" &&
        prepared.source.variables.length > 0 &&
        this.#apiReader().environment.state({ ...check, source: prepared.source }) === "changed"
      ) {
        paused = this.options.store.save({ ...prepared, active: false }, new Date(), true);
        throw new EventCheckRefusal(sourceText("error.backend.eventCheckProgramChanged"));
      }
      return this.options.store.save(prepared, new Date(), true);
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
          Effect.gen({ self: this }, function* () {
            const stopped: EventCheck | null = paused;
            if (stopped) {
              const execution = this.#execution(
                id,
                stopped.id,
                startedAt,
                "error",
                0,
                0,
                sourceText("error.backend.eventCheckProgramChanged"),
              );
              yield* mcpSync(() => this.options.store.finish(stopped, execution));
              yield* this.#audit({ kind: "user" }, "event-check.paused-program-changed", stopped, undefined, true).pipe(
                Effect.catchCause(() => Effect.void),
              );
              return execution;
            }
            return yield* mcpSync(() => {
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
            });
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
    if (!this.options.agentExists(id)) throw new EventCheckRefusal(sourceText("error.agent.unknown", { id }));
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
      throw new EventCheckRefusal(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.templates;
  }
  #apiReader(): EventCheckApiReader {
    if (!this.options.apiReader) throw new EventCheckRefusal(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.apiReader;
  }
  #reader(): EventCheckReader {
    if (!this.options.reader) throw new EventCheckRefusal(sourceText("error.backend.eventCheckUnsupported"));
    return this.options.reader;
  }
}
