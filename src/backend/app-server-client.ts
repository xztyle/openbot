import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { type DynamicRecord, isNumber, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Fiber } from "effect";
import { type AgentProvider, ProviderSessionBusyError, RequestTimeoutError } from "./agent-client";
import { agentInheritedEnvironment } from "./agent-inherited-environment";
import { cliSpawnTarget } from "./cli";
import { JsonLineDecoder, LineTooLongError } from "./jsonl";
import type { SpawnTarget } from "./process-confinement";
import {
  type AppServerNotification,
  type AppServerRequest,
  decodeRecordResponse,
  isRecord,
  type RequestId,
  type ResponseDecoder,
  type RpcError,
  type RpcMessage,
  type ThreadItem,
} from "./protocol";
import { ProviderClientOperationError } from "./provider-client-effects";
import {
  PROVIDER_HISTORY_PAGE_SIZE,
  type ProviderHistoryConsumer,
  type ProviderHistoryFragment,
  type ProviderHistoryRequest,
} from "./provider-history";
import { registerProviderProcess } from "./provider-processes";
import { createDiagnosticStream } from "./stderr-diagnostics";
import { endProcessTree } from "./windows-process-tree";

/**
 * How long a turn may send nothing before OpenBot ends it, as for Claude and ACP. Codex retries a
 * stopped model stream after 5 minutes and reports each retry, so a turn that works sends something
 * sooner. A turn that stopped held the agent on "working" and its queue until a Stop.
 */
const CODEX_TURN_STALL_MS = 15 * 60_000;
/**
 * The limit while a tool call, a command or a compaction is open. Codex can reason for minutes with no
 * event after a large tool result, and a long command or MCP tool must not be ended.
 */
const CODEX_TOOL_STALL_MS = 60 * 60_000;
/** How often the open turns are checked against the stall limits. */
const CODEX_STALL_CHECK_MS = 60_000;
/** Items that show model output. An open one does not raise the stall limit as a tool does. */
const OUTPUT_ITEM_TYPES: ReadonlySet<unknown> = new Set(["agentMessage", "reasoning", "userMessage", "plan"]);
/**
 * How long Codex may take to end a stopped turn before OpenBot ends it, as for ACP and Claude. Codex
 * answers `turn/interrupt` only when the turn ends, and a command that hangs keeps it from ending
 * (upstream be190a7c0).
 */
const CODEX_STOP_GRACE_MS = 10_000;
/** The requests that start or continue work on a thread. A process replaced during one would cut it. */
const THREAD_WORK_METHODS: ReadonlySet<string> = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "thread/compact/start",
  "turn/start",
  "turn/steer",
]);

const logger = createOpenBotLogger("codex-app-server");

/** The clock of a turn that the stall limits watch. */
interface TurnClock {
  threadId: string;
  turnId: string;
  lastActivityAt: number;
  /** The tool, command and compaction items that started and did not complete. */
  openItems: Set<string>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface ClientEvents {
  notification: [notification: AppServerNotification];
  request: [request: AppServerRequest];
  exit: [error: Error];
  diagnostic: [message: string];
}

export class AppServerError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}

export class CodexAppServerClient extends EventEmitter<ClientEvents> {
  readonly contextCompaction = "events";
  readonly provider: AgentProvider = "codex";
  readonly #executable: string;
  readonly #requestTimeoutMs: number;
  #decoder = new JsonLineDecoder();
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #toolRequests = new Map<RequestId, { threadId: string; turnId: string; controller: AbortController }>();
  /**
   * The Codex id of each server request, by the id OpenBot gives it. Each process numbers its requests
   * from 0, so its ids are not unique among the processes of other accounts or after a restart (#5465).
   */
  readonly #serverRequestIds = new Map<string, RequestId>();
  readonly #interruptedTurns = new Set<string>();
  /** The running turns, by `[threadId, turnId]`, for the stall limits. */
  readonly #turnClocks = new Map<string, TurnClock>();
  /**
   * The requests of Codex that OpenBot answers, such as an OpenBot tool, an approval or a question to
   * the user, with their thread. The stall limit waits for them, also for those of a subagent.
   */
  readonly #hostRequests = new Map<RequestId, string>();
  /** The thread that started each subagent thread, so a subagent's events count for its parent's turn. */
  readonly #subagentParents = new Map<string, string>();
  /**
   * Turns that OpenBot ended for a stall, or after a Stop that Codex did not answer in
   * `CODEX_STOP_GRACE_MS`, with their thread. Their late events and requests are dropped. This process
   * may still run them, and Codex adds a new turn of that thread to the turn that runs there.
   */
  readonly #abandonedTurns = new Map<string, { threadId: string }>();
  /** The turns that run in this process, by `[threadId, turnId]`, from `turn/started` to `turn/completed`. */
  readonly #liveTurns = new Set<string>();
  /** The stop deadline of each stopped turn, and the `turn/interrupt` requests that wait for its end. */
  readonly #stopWatches = new Map<string, { timer: ReturnType<typeof setTimeout>; requests: RequestId[] }>();
  /**
   * The threads with a stopped turn whose subagents must stop too, until the thread starts a new turn.
   * Codex stops only the thread that `turn/interrupt` names, and its subagents worked on and used the
   * plan's usage for hours, while the chat showed them as stopped (upstream 717d77fcc).
   */
  readonly #stoppedParents = new Set<string>();
  /** The `THREAD_WORK_METHODS` requests that wait for an answer. */
  #threadWork = 0;
  #stallCheck: { timer: ReturnType<typeof setInterval>; at: number } | null = null;
  #process: ChildProcessWithoutNullStreams | null = null;
  /** The end of a process that failed. `stop` waits for it, because `#process` no longer holds it. */
  #ending: Fiber.Fiber<void> | null = null;
  #nextId = 1;
  #stopping = false;
  #probing = false;

  /** Added to the inherited environment, such as the `CODEX_HOME` of an account after the first. */
  readonly #extraEnv: Readonly<Record<string, string>> | undefined;
  readonly #configOverrides: readonly string[];
  readonly #confine: ((target: SpawnTarget) => SpawnTarget) | undefined;

  constructor(
    executable: string,
    requestTimeoutMs = 30_000,
    extraEnv?: Readonly<Record<string, string>>,
    /** `key=value` config overrides, each given to the app-server as one `-c`. */
    configOverrides: readonly string[] = [],
    /** Wraps the command of an agent's own process, such as one in the agent's jail (`agent-jail.ts`). */
    confine?: (target: SpawnTarget) => SpawnTarget,
  ) {
    super();
    this.#confine = confine;
    this.#executable = executable;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#extraEnv = extraEnv;
    this.#configOverrides = configOverrides;
  }

  get running(): boolean {
    return this.#process !== null && this.#process.exitCode === null;
  }

  start(): void {
    if (this.running) return;

    this.#stopping = false;
    this.#decoder = new JsonLineDecoder();
    // An answer to a request of the previous process must not reach a request of this one.
    this.#serverRequestIds.clear();
    const plain = cliSpawnTarget(this.#executable, [
      "app-server",
      ...this.#configOverrides.flatMap((override) => ["-c", override]),
      "--listen",
      "stdio://",
    ]);
    const target = this.#confine ? this.#confine(plain) : plain;
    const child = spawn(target.command, target.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...agentInheritedEnvironment(), ...this.#extraEnv },
      windowsVerbatimArguments: target.windowsVerbatimArguments,
      windowsHide: true,
    });
    this.#process = child;
    registerProviderProcess(child, "codex");

    child.stdin.on("error", (error) => this.#fail(error, child));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#handleMessage(message);
      } catch (error) {
        // Not wrapped: the screen translates this text only when no prefix is in front of it.
        this.#fail(
          error instanceof LineTooLongError ? error : new Error(`Codex protocol error: ${String(error)}`),
          child,
        );
      }
    });

    // Whole records only. A chunk ends wherever the pipe filled up, and half a record is neither
    // readable nor reliably redactable.
    const diagnostics = createDiagnosticStream({
      redact: redactDiagnostic,
      emit: (message) => this.emit("diagnostic", message),
    });
    child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk.toString("utf8")));
    child.once("close", () => diagnostics.flush());

    child.once("error", (error) => this.#fail(error, child));
    child.once("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.#fail(new Error(`Codex App Server exited with ${suffix}.`), child);
    });
  }

  readonly stop = Effect.fn("CodexAppServer.stop")(function* (this: CodexAppServerClient) {
    const child = this.#process;
    if (!child) {
      if (this.#ending) yield* Fiber.join(this.#ending);
      return;
    }
    this.#stopping = true;
    this.#cancelToolRequests();
    this.#process = null;
    for (const pending of this.#pending.values()) pending.reject(new Error("Codex App Server stopped."));
    this.#pending.clear();
    child.stdin.end();
    yield* endProcessTree(child).pipe(Effect.orDie);
  }, Effect.uninterruptible);

  /**
   * Drops this connection's hold on one thread and keeps the app server for the others.
   *
   * `thread/unsubscribe` is the non-destructive end of a thread: the app server keeps the thread and
   * its history, stops the thread's MCP event streams at once, and unloads the thread - with the
   * MCP servers it started - once nothing is subscribed to it and it is idle. It does not archive
   * or delete. A refresh after an MCP change starts a replacement session for the same public
   * thread, so without this the old session stays loaded there with the servers the user turned off.
   *
   * A thread this connection never subscribed to answers `NotSubscribed`, which is not an error
   * here: either way this side has stopped using it.
   */
  readonly releaseThread = Effect.fn("CodexAppServer.releaseThread")(function* (
    this: CodexAppServerClient,
    threadId: string,
  ) {
    if (!this.running) return;
    yield* this.request("thread/unsubscribe", { threadId }, decodeRecordResponse);
  });

  /**
   * True when this process still runs a turn that OpenBot ended, and nothing else uses it: no other
   * turn and no session start. The runtime then replaces the process before the next turn, and the
   * next turn resumes the thread on the new process (upstream be190a7c0). Codex 0.160 cannot list
   * background terminals, so a background command of another thread does not keep the process, as
   * it does not keep it from an idle release either.
   */
  replaceForNextTurn(): boolean {
    return this.running && this.#abandonedTurns.size > 0 && this.#liveTurns.size === 0 && this.#threadWork === 0;
  }

  #abandonedThreads(): ReadonlySet<string> {
    return new Set([...this.#abandonedTurns.values()].map(({ threadId }) => threadId));
  }

  /**
   * Moves a replaced thread out of the list that the Codex app and ChatGPT show. Without this, each
   * replacement session adds a row that starts with the OpenBot handoff to the user's own Codex
   * history.
   *
   * `thread/archive` moves the rollout to `archived_sessions` and unloads the thread when it is
   * loaded. `thread/turns/list` and `thread/items/list` still read it, so a history import works,
   * and a resume unarchives it first (`ThreadLifecycle.resumeThread`). A thread that is already
   * archived, or that has no rollout, answers `no rollout found`.
   */
  readonly archiveThread = Effect.fn("CodexAppServer.archiveThread")(function* (
    this: CodexAppServerClient,
    threadId: string,
  ) {
    if (!this.running) return;
    yield* this.request("thread/archive", { threadId }, decodeRecordResponse);
  });

  /**
   * Reads Codex history without asking the app server for the legacy full thread snapshot.
   *
   * The app server returns turns newest first. Items are read one turn at a time in ascending
   * order, so consumers can persist each fragment and stop without retaining the transcript.
   * Cursors belong to this adapter and never cross the provider-history boundary.
   */
  readonly readHistory = Effect.fn("CodexAppServer.readHistory")(function* (
    this: CodexAppServerClient,
    request: ProviderHistoryRequest,
    consume: ProviderHistoryConsumer,
  ) {
    // These endpoints read the persisted rollout directly. Do not resume here: a resume applies
    // runtime settings and can reopen an archived thread while this operation only needs history.
    let cursor: string | undefined;
    const seenTurnCursors = new Set<string>();
    while (true) {
      const page = yield* this.request(
        "thread/turns/list",
        {
          threadId: request.threadId,
          limit: PROVIDER_HISTORY_PAGE_SIZE,
          sortDirection: "desc",
          itemsView: "notLoaded",
          ...(cursor === undefined ? {} : { cursor }),
        },
        decodeTurnHistoryPage,
      );

      for (const turn of page.data) {
        if (request.items === "none") {
          if (!(yield* consume(toHistoryFragment(turn, [], true)))) return;
          continue;
        }

        let itemCursor: string | undefined;
        const seenItemCursors = new Set<string>();
        let itemOffset = 0;
        while (true) {
          const itemPage = yield* this.request(
            "thread/items/list",
            {
              threadId: request.threadId,
              turnId: turn.id,
              limit: PROVIDER_HISTORY_PAGE_SIZE,
              sortDirection: "asc",
              ...(itemCursor === undefined ? {} : { cursor: itemCursor }),
            },
            decodeItemHistoryPage,
          );
          if (itemPage.data.some((entry) => entry.turnId !== turn.id)) {
            return yield* new ProviderClientOperationError({
              cause: new Error("Codex returned an item for the wrong turn."),
            });
          }
          const complete = itemPage.nextCursor === null;
          if (
            !(yield* consume(
              toHistoryFragment(
                turn,
                itemPage.data.map((entry) => entry.item),
                complete,
                itemOffset,
              ),
            ))
          )
            return;
          itemOffset += itemPage.data.length;
          if (complete) break;
          const nextItemCursor = freshCursor(itemPage.nextCursor, itemCursor, seenItemCursors, "item");
          if (nextItemCursor instanceof ProviderClientOperationError) return yield* nextItemCursor;
          itemCursor = nextItemCursor;
        }
      }

      if (page.nextCursor === null) return;
      const nextTurnCursor = freshCursor(page.nextCursor, cursor, seenTurnCursors, "turn");
      if (nextTurnCursor instanceof ProviderClientOperationError) return yield* nextTurnCursor;
      cursor = nextTurnCursor;
    }
  });

  readonly request = Effect.fn("CodexAppServer.request")(function* <T>(
    this: CodexAppServerClient,
    method: string,
    params: unknown,
    decoder: ResponseDecoder<T>,
    timeoutMs = this.#requestTimeoutMs,
  ) {
    const id = this.#nextId++;
    const child = this.#process;
    if ((method === "turn/start" || method === "turn/steer") && isRecord(params) && isString(params.threadId)) {
      // Codex would add this turn to the ended turn that still runs in the thread. The drain tries the
      // message again, and a later try starts it on a new process.
      if (this.#abandonedThreads().has(params.threadId))
        return yield* Effect.fail(new ProviderClientOperationError({ cause: new ProviderSessionBusyError("Codex") }));
    }
    let counted = false;
    return yield* Effect.callback<T, ProviderClientOperationError>((resume) => {
      if (THREAD_WORK_METHODS.has(method)) {
        this.#threadWork += 1;
        counted = true;
      }
      this.#pending.set(id, {
        resolve: (value) => {
          // A Stop can come before `turn/started`; the stop deadline then still knows the turn.
          if (method === "turn/start" && isRecord(params) && isString(params.threadId) && isRecord(value)) {
            const turn = value.turn;
            if (isRecord(turn) && isString(turn.id)) this.#liveTurns.add(JSON.stringify([params.threadId, turn.id]));
          }
          resume(
            Effect.try({
              try: () => decoder(value),
              catch: (cause) => new ProviderClientOperationError({ cause }),
            }),
          );
        },
        reject: (cause) => resume(Effect.fail(new ProviderClientOperationError({ cause }))),
      });
      try {
        this.#write({ method, id, params: method === "thread/resume" ? metadataOnlyResumeParams(params) : params });
        if (method === "turn/interrupt" && isRecord(params) && isString(params.threadId) && isString(params.turnId)) {
          this.#interruptedTurns.add(JSON.stringify([params.threadId, params.turnId]));
          this.#cancelToolRequests(params.threadId, params.turnId, "the turn was interrupted");
          this.#watchStop(params.threadId, params.turnId, id, child);
          this.#stopSubagentsOf(params.threadId);
        }
      } catch (cause) {
        resume(Effect.fail(new ProviderClientOperationError({ cause })));
      }
      return Effect.sync(() => this.#pending.delete(id));
    }).pipe(
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.sync(() => this.#checkAnswering(child, timeoutMs)).pipe(
            Effect.andThen(
              Effect.fail(new ProviderClientOperationError({ cause: new RequestTimeoutError("Codex", method) })),
            ),
          ),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          this.#pending.delete(id);
          if (counted) this.#threadWork -= 1;
        }),
      ),
    );
  });

  notify(method: string, params: unknown = {}): void {
    this.#write({ method, params });
  }

  respond(id: RequestId, result: unknown): void {
    const codexId = this.#takeServerRequestId(id);
    if (codexId !== undefined) this.#write({ id: codexId, result });
  }

  respondError(id: RequestId, error: RpcError): void {
    const codexId = this.#takeServerRequestId(id);
    if (codexId !== undefined) this.#write({ id: codexId, error });
  }

  #takeServerRequestId(id: RequestId): RequestId | undefined {
    this.#toolRequests.delete(id);
    this.#answeredHostRequest(id);
    if (!isString(id)) return undefined;
    const codexId = this.#serverRequestIds.get(id);
    this.#serverRequestIds.delete(id);
    return codexId;
  }

  #write(message: unknown): void {
    if (!this.running || !this.#process) {
      throw new Error("Codex App Server is not running.");
    }
    this.#process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleMessage(message: RpcMessage): void {
    if ("method" in message) {
      if ("id" in message) {
        const requestTurn = turnKeyOf(message.params);
        if (requestTurn !== null && this.#abandonedTurns.has(requestTurn)) {
          // OpenBot ended this turn: nobody answers its approvals or tool calls any more.
          this.#write({ id: message.id, error: { code: -32_000, message: "OpenBot stopped this turn." } });
          return;
        }
        // Each Codex process numbers its requests from 0, so its ids are not unique among the processes
        // of other accounts or after a restart (upstream 0875ae916). OpenBot gives each its own id.
        const id = randomUUID();
        this.#serverRequestIds.set(id, message.id);
        if (isRecord(message.params) && isString(message.params.threadId))
          this.#hostRequests.set(id, message.params.threadId);
        let signal: AbortSignal | undefined;
        if (
          message.method === "item/tool/call" &&
          isRecord(message.params) &&
          isString(message.params.threadId) &&
          isString(message.params.turnId)
        ) {
          const controller = new AbortController();
          this.#toolRequests.set(id, {
            threadId: message.params.threadId,
            turnId: message.params.turnId,
            controller,
          });
          signal = controller.signal;
          if (this.#interruptedTurns.has(JSON.stringify([message.params.threadId, message.params.turnId]))) {
            this.#toolRequests.delete(id);
            controller.abort("the turn was interrupted");
          }
        }
        this.emit("request", {
          ...(signal ? { signal } : {}),
          method: message.method,
          id,
          params: message.params,
        });
      } else {
        const turnKey = turnKeyOf(message.params);
        if (turnKey !== null && this.#abandonedTurns.has(turnKey)) {
          // The late events of a turn that OpenBot already ended; its end only shows that it no longer runs.
          if (message.method === "turn/completed") this.#abandonedTurns.delete(turnKey);
          return;
        }
        if (turnKey !== null && message.method === "turn/started") this.#liveTurns.add(turnKey);
        if (turnKey !== null && message.method === "turn/completed") this.#endStopWatch(turnKey);
        this.#observeSubagents(message.method, message.params);
        this.#observeTurnClock(message.method, message.params, turnKey);
        if (
          message.method === "turn/completed" &&
          isRecord(message.params) &&
          isString(message.params.threadId) &&
          isRecord(message.params.turn) &&
          isString(message.params.turn.id)
        ) {
          this.#cancelToolRequests(message.params.threadId, message.params.turn.id);
          this.#interruptedTurns.delete(JSON.stringify([message.params.threadId, message.params.turn.id]));
        }
        this.emit("notification", { method: message.method, params: message.params });
      }
      return;
    }

    const pending = this.#pending.get(message.id);
    if (!pending) return;

    this.#pending.delete(message.id);

    if (message.error && isRecord(message.error)) {
      const code = isNumber(message.error.code) ? message.error.code : -1;
      const text = isString(message.error.message) ? message.error.message : "Unknown error";
      pending.reject(new AppServerError(text, code, message.error.data));
      return;
    }

    pending.resolve(message.result);
  }

  #answeredHostRequest(id: RequestId): void {
    const threadId = this.#hostRequests.get(id);
    this.#hostRequests.delete(id);
    // The stall limit counts again from the answer.
    if (threadId !== undefined) this.#noteTurnActivity(threadId);
  }

  /** Keeps the clock of each running turn for the stall limits. An event of the thread or of its subagents counts. */
  #observeTurnClock(method: string, params: unknown, turnKey: string | null): void {
    if (!isRecord(params) || !isString(params.threadId)) return;
    if (method === "turn/completed") {
      if (turnKey !== null) this.#forgetTurnClock(turnKey);
      return;
    }
    if (method === "turn/started" && turnKey !== null && isRecord(params.turn) && isString(params.turn.id)) {
      this.#turnClocks.set(turnKey, {
        threadId: params.threadId,
        turnId: params.turn.id,
        lastActivityAt: Date.now(),
        openItems: new Set(),
      });
      this.#startStallCheck();
    }
    const clock = turnKey === null ? undefined : this.#turnClocks.get(turnKey);
    const item = params.item;
    if (clock && isRecord(item) && isString(item.id) && !OUTPUT_ITEM_TYPES.has(item.type)) {
      if (method === "item/started") clock.openItems.add(item.id);
      else if (method === "item/completed") clock.openItems.delete(item.id);
    }
    this.#noteTurnActivity(params.threadId);
  }

  /**
   * Links each subagent thread to the thread that started it. A turn that a subagent of a stopped
   * thread starts is stopped too; a new turn of any other thread lets its own subagents work again.
   */
  #observeSubagents(method: string, params: unknown): void {
    if (!isRecord(params) || !isString(params.threadId)) return;
    const threadId = params.threadId;
    if (method === "turn/started") {
      const turnId = isRecord(params.turn) ? params.turn.id : undefined;
      if (!isString(turnId)) return;
      const parent = this.#subagentParents.get(threadId);
      if (parent !== undefined && this.#stoppedParents.has(parent)) this.#stopSubagentTurn(threadId, turnId);
      // A Stop can come before `turn/started` of the turn that it stops.
      else if (!this.#interruptedTurns.has(JSON.stringify([threadId, turnId]))) this.#stoppedParents.delete(threadId);
      return;
    }
    if (method === "turn/completed") {
      // Codex does not stop a subagent when the turn that started it ends, and no later `wait` of that
      // turn reads its result. The chat shows it as stopped then, so it stops (upstream 372d739e4 keeps
      // it running with a Stop; the workspace has no Stop for an idle agent).
      if ([...this.#subagentParents.values()].includes(threadId)) this.#stopSubagentsOf(threadId);
      return;
    }
    const item = params.item;
    if ((method !== "item/started" && method !== "item/completed") || !isRecord(item)) return;
    const children =
      item.type === "collabAgentToolCall" && Array.isArray(item.receiverThreadIds)
        ? item.receiverThreadIds.filter(isString)
        : item.type === "subAgentActivity" && isString(item.agentThreadId)
          ? [item.agentThreadId]
          : [];
    for (const child of children) {
      if (this.#subagentParents.get(child) === threadId || this.#isSubagentOf(threadId, child)) continue;
      this.#subagentParents.set(child, threadId);
      // A subagent that the stopped turn started just before its end.
      if (this.#stoppedParents.has(threadId)) this.#stopSubagent(child);
    }
  }

  /** Stops the subagents of a stopped thread, and their own subagents. A second Stop sends their Stops again. */
  #stopSubagentsOf(threadId: string): void {
    this.#stoppedParents.add(threadId);
    for (const [child, parent] of this.#subagentParents) if (parent === threadId) this.#stopSubagent(child);
  }

  #stopSubagent(threadId: string): void {
    for (const clock of this.#turnClocks.values())
      if (clock.threadId === threadId) this.#stopSubagentTurn(threadId, clock.turnId);
    this.#stopSubagentsOf(threadId);
  }

  /** Sends the Stop of a subagent's turn. It has the same deadline as a Stop of the person's turn. */
  #stopSubagentTurn(threadId: string, turnId: string): void {
    if (this.#interruptedTurns.has(JSON.stringify([threadId, turnId]))) return;
    Effect.runFork(this.request("turn/interrupt", { threadId, turnId }, decodeRecordResponse).pipe(Effect.ignore));
  }

  /** Starts the deadline of a stopped turn, or adds a second Stop of it to that deadline. */
  #watchStop(threadId: string, turnId: string, requestId: RequestId, child: ChildProcessWithoutNullStreams | null) {
    const key = JSON.stringify([threadId, turnId]);
    const watch = this.#stopWatches.get(key);
    if (watch) {
      watch.requests.push(requestId);
      return;
    }
    const timer = setTimeout(() => this.#abandonStoppedTurn(threadId, turnId, child), CODEX_STOP_GRACE_MS);
    timer.unref?.();
    this.#stopWatches.set(key, { timer, requests: [requestId] });
  }

  #endStopWatch(key: string): void {
    this.#liveTurns.delete(key);
    const watch = this.#stopWatches.get(key);
    if (watch) clearTimeout(watch.timer);
    this.#stopWatches.delete(key);
  }

  /**
   * Ends a stopped turn that Codex did not end in `CODEX_STOP_GRACE_MS`, as a Stop that Codex
   * confirmed does: the Stop succeeds, and the turn completes as interrupted. Without this, a command
   * that hangs kept the chat busy, and the agent's queue waited until OpenBot restarted.
   */
  #abandonStoppedTurn(threadId: string, turnId: string, child: ChildProcessWithoutNullStreams | null): void {
    const key = JSON.stringify([threadId, turnId]);
    const requests = this.#stopWatches.get(key)?.requests ?? [];
    this.#stopWatches.delete(key);
    if (this.#process !== child || !this.#liveTurns.has(key)) return;
    logger.warn("Ended a stopped Codex turn that Codex did not end.", { threadId });
    this.#handleMessage({
      method: "turn/completed",
      params: { threadId, turn: { id: turnId, status: "interrupted" } },
    });
    this.#abandonedTurns.set(key, { threadId });
    for (const id of requests) {
      const pending = this.#pending.get(id);
      this.#pending.delete(id);
      pending?.resolve({});
    }
  }

  /** Whether `threadId` is the thread `ancestor` or one of its subagents. Keeps the links free of loops. */
  #isSubagentOf(threadId: string, ancestor: string): boolean {
    for (
      let current: string | undefined = threadId;
      current !== undefined;
      current = this.#subagentParents.get(current)
    )
      if (current === ancestor) return true;
    return false;
  }

  /** Starts the stall limits again for the turns of this thread and of the threads whose subagent it is. */
  #noteTurnActivity(threadId: string): void {
    const now = Date.now();
    for (const clock of this.#turnClocks.values())
      if (this.#isSubagentOf(threadId, clock.threadId)) clock.lastActivityAt = now;
  }

  #forgetTurnClock(turnKey: string): void {
    this.#turnClocks.delete(turnKey);
    if (this.#turnClocks.size === 0 && this.#stallCheck) {
      clearInterval(this.#stallCheck.timer);
      this.#stallCheck = null;
    }
  }

  #startStallCheck(): void {
    if (this.#stallCheck) return;
    const timer = setInterval(() => this.#checkStalls(), CODEX_STALL_CHECK_MS);
    timer.unref?.();
    this.#stallCheck = { timer, at: Date.now() };
  }

  /**
   * Ends each turn that sent nothing past its stall limit. A wait for OpenBot, such as an OpenBot tool
   * or a question to the user, does not count, nor does the time the computer sleeps. A subagent's
   * turn ends with the turn that started it.
   */
  #checkStalls(): void {
    const check = this.#stallCheck;
    if (!check) return;
    const now = Date.now();
    // A timer does not run while the computer sleeps, but the clock does.
    const asleep = now - check.at - CODEX_STALL_CHECK_MS;
    check.at = now;
    for (const [key, clock] of this.#turnClocks) {
      if (asleep > CODEX_STALL_CHECK_MS) clock.lastActivityAt = Math.min(now, clock.lastActivityAt + asleep);
      const silentFor = now - clock.lastActivityAt;
      const limit = clock.openItems.size > 0 ? CODEX_TOOL_STALL_MS : CODEX_TURN_STALL_MS;
      if (
        silentFor < limit ||
        this.#subagentParents.has(clock.threadId) ||
        this.#interruptedTurns.has(key) ||
        [...this.#hostRequests.values()].some((threadId) => this.#isSubagentOf(threadId, clock.threadId))
      )
        continue;
      this.#endStalledTurn(key, clock, silentFor);
    }
  }

  /**
   * Ends a turn past its stall limit as failed, with the text that says what to do, so the agent's
   * queue goes on. Codex gets a Stop: a process that does not answer it is ended by the request
   * timeout probe, and the next turn resumes the thread on a new process.
   */
  #endStalledTurn(key: string, clock: TurnClock, silentFor: number): void {
    const { threadId, turnId } = clock;
    logger.warn("Ended a Codex turn that sent nothing past the stall limit.", {
      threadId,
      silentForMinutes: Math.floor(silentFor / 60_000),
      openItems: clock.openItems.size,
    });
    Effect.runFork(this.request("turn/interrupt", { threadId, turnId }, decodeRecordResponse).pipe(Effect.ignore));
    this.#handleMessage({
      method: "error",
      params: { threadId, turnId, message: sourceText("error.agent.turnStalled", { provider: "ChatGPT" }) },
    });
    this.#handleMessage({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "failed" } } });
    this.#abandonedTurns.set(key, { threadId });
  }

  #cancelToolRequests(threadId?: string, turnId?: string, interruption?: string): void {
    if (threadId === undefined) {
      this.#interruptedTurns.clear();
      this.#turnClocks.clear();
      this.#hostRequests.clear();
      this.#subagentParents.clear();
      this.#abandonedTurns.clear();
      this.#liveTurns.clear();
      this.#stoppedParents.clear();
      for (const watch of this.#stopWatches.values()) clearTimeout(watch.timer);
      this.#stopWatches.clear();
      if (this.#stallCheck) clearInterval(this.#stallCheck.timer);
      this.#stallCheck = null;
    }
    for (const [id, request] of this.#toolRequests) {
      if (threadId !== undefined && (request.threadId !== threadId || request.turnId !== turnId)) continue;
      this.#toolRequests.delete(id);
      // The reason reaches the tool router's log: a call that ends this way is what the model reports
      // as a tool that disconnected.
      request.controller.abort(
        interruption ?? (threadId === undefined ? "the provider process stopped" : "the turn ended"),
      );
    }
  }

  /**
   * Ends a process that stopped answering, so the runtime starts a new one as it does after an exit.
   * Without this a hung app server stays the shared client, and the requests of every agent time out
   * until the user kills it.
   *
   * One request that timed out is not enough: `account/rateLimits/read` waits on the network. So one
   * `config/read` probes the process. That request is local, and every thread start needs it. A
   * process that does not answer it in the request timeout is ended, also when it still sends events:
   * it takes no new work. A request with a shorter timeout, such as a `model/list` that may be slow,
   * starts no probe.
   */
  #checkAnswering(child: ChildProcessWithoutNullStreams | null, timeoutMs: number): void {
    if (this.#probing || !child || this.#process !== child || timeoutMs < this.#requestTimeoutMs) return;
    this.#probing = true;
    Effect.runFork(
      this.request("config/read", { includeLayers: false }, decodeRecordResponse).pipe(
        Effect.catch((failure) =>
          Effect.sync(() => {
            if (this.#process !== child || !(failure.cause instanceof RequestTimeoutError)) return;
            this.#fail(new Error(sourceText("error.provider.codexUnresponsive")), child);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            this.#probing = false;
          }),
        ),
      ),
    );
  }

  #fail(error: Error, child: ChildProcessWithoutNullStreams): void {
    if (this.#process !== child) return;
    this.#cancelToolRequests();
    this.#process = null;

    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();

    this.#ending = Effect.runFork(endProcessTree(child).pipe(Effect.orDie));
    if (!this.#stopping) this.emit("exit", error);
  }
}

interface HistoryTurn {
  id: string;
  status?: string;
  startedAt?: number;
}

interface HistoryTurnPage {
  data: HistoryTurn[];
  nextCursor: string | null;
}

interface HistoryItemPage {
  data: Array<{ turnId: string; item: ThreadItem }>;
  nextCursor: string | null;
}

function metadataOnlyResumeParams(params: unknown): DynamicRecord {
  return { ...(isRecord(params) ? params : {}), excludeTurns: true };
}

function decodeTurnHistoryPage(value: unknown): HistoryTurnPage {
  const record = decodeRecordResponse(value);
  if (!Array.isArray(record.data)) throw new Error("Invalid Codex turn history page.");
  return {
    // Do not retain `items` from the response. `itemsView: notLoaded` is the memory boundary, and
    // the item endpoint below is the only path that materializes item records.
    data: record.data.map(decodeHistoryTurn),
    nextCursor: nullableString(record.nextCursor, "turn history cursor"),
  };
}

function decodeHistoryTurn(value: unknown): HistoryTurn {
  if (!isRecord(value) || !isString(value.id)) throw new Error("Invalid Codex history turn.");
  const status = value.status;
  const startedAt = value.startedAt;
  return {
    id: value.id,
    ...(isString(status) ? { status } : {}),
    ...(typeof startedAt === "number" && Number.isFinite(startedAt) ? { startedAt } : {}),
  };
}

function decodeItemHistoryPage(value: unknown): HistoryItemPage {
  const record = decodeRecordResponse(value);
  if (!Array.isArray(record.data)) throw new Error("Invalid Codex item history page.");
  return {
    data: record.data.map(decodeHistoryItemEntry),
    nextCursor: nullableString(record.nextCursor, "item history cursor"),
  };
}

function decodeHistoryItemEntry(value: unknown): { turnId: string; item: ThreadItem } {
  if (!isRecord(value) || !isString(value.turnId) || !isRecord(value.item) || !isString(value.item.type)) {
    throw new Error("Invalid Codex history item.");
  }
  // Preserve provider item fields (tool output, image metadata, command status, and so on) while
  // validating the discriminator at the untrusted app-server boundary.
  return { turnId: value.turnId, item: { ...value.item, type: value.item.type } };
}

function nullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isString(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function toHistoryFragment(
  turn: HistoryTurn,
  items: ThreadItem[],
  complete: boolean,
  itemOffset?: number,
): ProviderHistoryFragment {
  return {
    turnId: turn.id,
    ...(turn.status === undefined ? {} : { status: turn.status }),
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(itemOffset === undefined ? {} : { itemOffset }),
    items,
    complete,
  };
}

function freshCursor(
  nextCursor: string | null,
  currentCursor: string | undefined,
  seenCursors: Set<string>,
  kind: "turn" | "item",
): string | ProviderClientOperationError {
  if (nextCursor === null || nextCursor === currentCursor || seenCursors.has(nextCursor)) {
    return new ProviderClientOperationError({ cause: new Error(`Codex returned a repeated ${kind} history cursor.`) });
  }
  seenCursors.add(nextCursor);
  return nextCursor;
}

/**
 * The record as it leaves this client. It is not shortened here: the reader redacts the MCP
 * credentials this process handed the CLI, and a value cut in half by a bound applied first is a
 * value that redactor no longer recognises. `shortenDiagnostic` is applied there instead.
 */
function redactDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|sess|Bearer|token)[-_a-zA-Z0-9.=]{8,}/gi, "[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
}

/** Kept inside the adapter; public callers still receive the native protocol error. */

/** The `[threadId, turnId]` key of a notification or request that names its turn, or null. */
function turnKeyOf(params: unknown): string | null {
  if (!isRecord(params) || !isString(params.threadId)) return null;
  const turnId = isString(params.turnId) ? params.turnId : isRecord(params.turn) ? params.turn.id : undefined;
  return isString(turnId) ? JSON.stringify([params.threadId, turnId]) : null;
}
