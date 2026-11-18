import { createOpenBotLogger } from "@openbot/logging";
import type {
  DatabaseReadRequest,
  DatabaseReadRequestOf,
  DatabaseReadResultReply,
  DatabaseReadResults,
  DatabaseReadWorkerMessage,
  DatabaseReadWorkerReply,
} from "./database-read-protocol";

const logger = createOpenBotLogger("database-reader");

/** A worker thread as the reader uses it; `node:worker_threads` `Worker` is one. */
export interface DatabaseReadWorkerHandle {
  postMessage(message: DatabaseReadWorkerMessage): void;
  on(event: "message", listener: (message: DatabaseReadWorkerReply) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  terminate(): unknown;
  unref?(): void;
}

export interface DatabaseReaderOptions {
  /** Starts one worker. The app starts its bundled entry; a test or script starts the source. */
  spawn: () => DatabaseReadWorkerHandle;
  /** The most workers at a time: a long search on one leaves another for the reads of open chats. */
  workers?: number;
  /** A read that takes longer fails, and its worker is replaced. Input, so a test can reach it. */
  deadlineMs?: number;
  /** How long `close` waits for each worker to close its connection. */
  closeWaitMs?: number;
}

const DEFAULT_WORKERS = 2;
const DEFAULT_DEADLINE_MS = 15_000;
const DEFAULT_CLOSE_WAIT_MS = 2_000;
/** This many workers that fail within `FAILURE_WINDOW_MS` turn the reader off until the app restarts. */
const FAILURE_LIMIT = 3;
const FAILURE_WINDOW_MS = 60_000;

interface Pending {
  accept: (reply: DatabaseReadResultReply) => void;
  reject: (error: Error) => void;
  deadline: NodeJS.Timeout;
}

interface ReadWorker {
  handle: DatabaseReadWorkerHandle;
  pending: Map<number, Pending>;
  retired: boolean;
}

/** Why a read did not come from a worker. The caller then reads on the main connection. */
export class DatabaseReaderUnavailable extends Error {}

/**
 * Owns the database read workers of the main process and sends each read to one of them.
 *
 * A read that a worker cannot answer is rejected, never answered from somewhere else: the caller
 * then makes the same read on the main connection, so a worker that fails, is slow or is missing
 * changes when a read runs, not what it returns. A worker that crashes or passes the deadline is
 * replaced; several failures in a short time turn the reader off and every read stays on the main
 * thread, as before workers existed.
 *
 * `close` must run before the main connection closes (see `DatabaseReadWorkerMessage`). Knows
 * nothing about agents and never imports the facade.
 */
export class DatabaseReader {
  readonly #spawn: () => DatabaseReadWorkerHandle;
  readonly #size: number;
  readonly #deadlineMs: number;
  readonly #closeWaitMs: number;
  readonly #workers: ReadWorker[] = [];
  readonly #failures: number[] = [];
  #nextId = 1;
  #answered = 0;
  #off = false;
  #closed = false;

  constructor(options: DatabaseReaderOptions) {
    this.#spawn = options.spawn;
    this.#size = Math.max(1, options.workers ?? DEFAULT_WORKERS);
    this.#deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.#closeWaitMs = options.closeWaitMs ?? DEFAULT_CLOSE_WAIT_MS;
  }

  /** How many reads a worker answered, for diagnostics and checks. */
  get answered(): number {
    return this.#answered;
  }

  /** False after `close`, or after workers failed too often: every read then stays on the main thread. */
  get available(): boolean {
    return !this.#off && !this.#closed;
  }

  /** A page of a chat, with the member's read state when `readStateFor` names one. */
  conversationPage(
    request: DatabaseReadRequestOf<"conversation-page">,
  ): Promise<DatabaseReadResults["conversation-page"]> {
    return this.#send(request, (reply) => (reply.kind === "conversation-page" ? reply.result : null));
  }

  /** A page with its read state, encoded as the body of a Team API response. */
  conversationPageResponse(
    request: DatabaseReadRequestOf<"conversation-page-response">,
  ): Promise<DatabaseReadResults["conversation-page-response"]> {
    return this.#send(request, (reply) => (reply.kind === "conversation-page-response" ? reply.result : null));
  }

  /** The read states of chats, by agent. */
  readStates(request: DatabaseReadRequestOf<"read-states">): Promise<DatabaseReadResults["read-states"]> {
    return this.#send(request, (reply) => (reply.kind === "read-states" ? reply.result : null));
  }

  searchMessages(request: DatabaseReadRequestOf<"search-messages">): Promise<DatabaseReadResults["search-messages"]> {
    return this.#send(request, (reply) => (reply.kind === "search-messages" ? reply.result : null));
  }

  searchFiles(request: DatabaseReadRequestOf<"search-files">): Promise<DatabaseReadResults["search-files"]> {
    return this.#send(request, (reply) => (reply.kind === "search-files" ? reply.result : null));
  }
  searchChannelMessages(
    request: DatabaseReadRequestOf<"search-channel-messages">,
  ): Promise<DatabaseReadResults["search-channel-messages"]> {
    return this.#send(request, (reply) => (reply.kind === "search-channel-messages" ? reply.result : null));
  }

  /** Sends one read; `pick` takes the result out of the reply of the same kind. */
  #send<T>(request: DatabaseReadRequest, pick: (reply: DatabaseReadResultReply) => T | null): Promise<T> {
    if (!this.available) return Promise.reject(new DatabaseReaderUnavailable("The database reader is off."));
    let worker: ReadWorker;
    try {
      worker = this.#pick();
    } catch (error) {
      this.#failed(error instanceof Error ? error.message : String(error));
      return Promise.reject(new DatabaseReaderUnavailable("A database read worker did not start."));
    }
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.#retire(worker, `A read (${request.kind}) took longer than ${this.#deadlineMs} ms.`);
      }, this.#deadlineMs);
      deadline.unref();
      const accept = (reply: DatabaseReadResultReply) => {
        const result = pick(reply);
        if (result === null) reject(new Error(`A database read worker answered ${request.kind} with ${reply.kind}.`));
        else {
          this.#answered += 1;
          resolve(result);
        }
      };
      worker.pending.set(id, { accept, reject, deadline });
      try {
        worker.handle.postMessage({ type: "read", id, request });
      } catch (error) {
        this.#retire(worker, error instanceof Error ? error.message : String(error));
      }
    });
  }

  /**
   * Closes every worker's connection and waits a short time for each, so that the main connection
   * closes last. Reads that still wait fail, and their callers read on the main connection.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const worker of this.#workers.splice(0)) {
      worker.retired = true;
      const closed = new Int32Array(new SharedArrayBuffer(4));
      try {
        worker.handle.postMessage({ type: "close", closed });
        // The worker answers between two reads. A read that runs longer than this keeps its connection
        // open; SQLite then keeps the log, and the next start checks the database as after a crash.
        if (Atomics.wait(closed, 0, 0, this.#closeWaitMs) === "timed-out")
          logger.warn("A database read worker did not close its connection in time.");
      } catch (error) {
        logger.warn("A database read worker did not close.", error instanceof Error ? error.message : String(error));
      }
      this.#rejectAll(worker, "The database is closing.");
      void worker.handle.terminate();
    }
  }

  #pick(): ReadWorker {
    let best: ReadWorker | undefined;
    for (const worker of this.#workers) if (!best || worker.pending.size < best.pending.size) best = worker;
    if (best && (best.pending.size === 0 || this.#workers.length >= this.#size)) return best;
    return this.#start();
  }

  #start(): ReadWorker {
    const handle = this.#spawn();
    const worker: ReadWorker = { handle, pending: new Map(), retired: false };
    handle.unref?.();
    handle.on("message", (reply) => this.#receive(worker, reply));
    handle.on("error", (error) => this.#retire(worker, error.message));
    handle.on("exit", (code) => {
      if (!worker.retired) this.#retire(worker, `It stopped with code ${code}.`);
    });
    this.#workers.push(worker);
    return worker;
  }

  #receive(worker: ReadWorker, reply: DatabaseReadWorkerReply): void {
    const pending = worker.pending.get(reply.id);
    if (!pending) return;
    worker.pending.delete(reply.id);
    clearTimeout(pending.deadline);
    if (reply.type === "result") pending.accept(reply);
    // A query that fails is not a failure of the worker: the main connection reads it again and
    // fails in the same way, with the error the caller expects.
    else pending.reject(new Error(reply.message));
  }

  /** Ends a worker that crashed or is stuck, and fails its reads. The next read starts another one. */
  #retire(worker: ReadWorker, reason: string): void {
    if (worker.retired) return;
    worker.retired = true;
    const index = this.#workers.indexOf(worker);
    if (index !== -1) this.#workers.splice(index, 1);
    this.#rejectAll(worker, reason);
    // A worker inside `sqlite3_step` ends when the statement returns; it holds no lock that a writer needs.
    void worker.handle.terminate();
    this.#failed(reason);
  }

  #rejectAll(worker: ReadWorker, reason: string): void {
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.deadline);
      pending.reject(new DatabaseReaderUnavailable(reason));
    }
    worker.pending.clear();
  }

  #failed(reason: string): void {
    if (this.#closed) return;
    const now = Date.now();
    this.#failures.push(now);
    while (this.#failures.length > 0 && now - (this.#failures[0] ?? now) > FAILURE_WINDOW_MS) this.#failures.shift();
    logger.warn("A database read worker failed; its reads run on the main thread.", reason);
    if (this.#failures.length >= FAILURE_LIMIT && !this.#off) {
      this.#off = true;
      logger.warn("The database read workers failed too often; all reads run on the main thread until a restart.");
      for (const worker of this.#workers.splice(0)) {
        worker.retired = true;
        this.#rejectAll(worker, "The database reader is off.");
        void worker.handle.terminate();
      }
    }
  }
}
