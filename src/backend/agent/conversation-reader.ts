import type {
  AgentEvent,
  AgentSummary,
  ConversationFileSearchPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
} from "@openbot/contracts/ipc";
import { Deferred, Effect, Schema } from "effect";
import type { AgentStore } from "../agent-store";
import { type ConversationMarkerExclusions, ConversationReadStore } from "../conversation-read-store";
import { mergeConversationSnapshots } from "../conversation-snapshots";
import type { EncodedResponseRoute } from "../database/database-read-protocol";
import { causeHelpers } from "../effect-boundary";
import type { ConversationRuntime } from "./conversation-runtime";
import type { MailboxSync } from "./mailbox-sync";

export interface ConversationReaderHooks {
  emit(event: AgentEvent): void;
  listAgents(): AgentSummary[];
}

export interface ConversationReaderOptions {
  store: AgentStore;
  conversation: ConversationRuntime;
  mailboxSync: MailboxSync;
  hooks: ConversationReaderHooks;
}

/**
 * Owns the reads of a conversation and each member's read cursor: the snapshot, the page, the
 * search, and the read and unread marks.
 *
 * It never imports the agent service facade.
 */
export class ConversationReader {
  readonly #store: AgentStore;
  readonly #conversation: ConversationRuntime;
  readonly #mailboxSync: MailboxSync;
  readonly #reads: ConversationReadStore;
  readonly #hooks: ConversationReaderHooks;
  /** The page responses that a read worker reads now, by request (`readPageResponseFor`). */
  readonly #pageResponses = new Map<string, { token: string; answer: Deferred.Deferred<PageResponse | null> }>();

  constructor(options: ConversationReaderOptions) {
    this.#store = options.store;
    this.#conversation = options.conversation;
    this.#mailboxSync = options.mailboxSync;
    this.#reads = new ConversationReadStore(options.store.database);
    this.#hooks = options.hooks;
  }

  readonly read = Effect.fn("ConversationReader.read")(function* (this: ConversationReader, agentId: string) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    return yield* readerStep(() => {
      // The legacy read endpoint still returns the complete durable conversation. `setSnapshot`
      // keeps only a bounded recent view after this transient response is built, so this read does
      // not turn a large chat into a long-lived process cache.
      const persisted = this.#store.database.readConversation(agentId, agent.threadId);
      const live = this.#conversation.snapshot(agentId);
      const snapshot = live?.activeTurnId ? mergeConversationSnapshots(persisted, live) : persisted;
      this.#mailboxSync.syncMailboxMessages(snapshot);
      this.#conversation.setSnapshot(agentId, snapshot);
      return structuredClone(snapshot);
    });
  }, Effect.uninterruptible);

  readonly readFor = Effect.fn("ConversationReader.readFor")(function* (
    this: ConversationReader,
    agentId: string,
    memberId: string,
  ) {
    const snapshot = yield* this.read(agentId);
    return yield* readerStep(() => {
      return {
        ...snapshot,
        readState: this.#reads.readState(memberId, snapshot),
      };
    });
  }, Effect.uninterruptible);

  readonly readPageFor = Effect.fn("ConversationReader.readPageFor")(function* (
    this: ConversationReader,
    agentId: string,
    memberId: string,
    anchor: ConversationPageAnchor = { type: "latest" },
    limit = 50,
    options: ConversationMarkerExclusions = {},
  ) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    const threadId = agent.threadId;
    yield* readerStep(() => this.#mailboxSync.reconcilePersistedMailboxMessages(agent));
    // After the reconcile: its writes are committed, so the worker's read sees them.
    const offMain = threadId
      ? yield* this.#store.database.readOffMain((reader) =>
          reader.conversationPage({
            kind: "conversation-page",
            agentId,
            threadId,
            anchor,
            limit,
            options,
            readStateFor: memberId,
          }),
        )
      : null;
    return yield* readerStep(() => {
      if (offMain)
        return {
          ...offMain.page,
          // A member with no cursor yet, or one that the thread lost, gets it written here first.
          readState: offMain.readState ?? this.#reads.readStateForThread(memberId, threadId, options),
        };
      const page = this.#store.database.readConversationPage(agentId, threadId, anchor, limit, options);
      return {
        ...page,
        readState: this.#reads.readStateForThread(memberId, threadId, options),
      };
    });
  }, Effect.uninterruptible);

  /**
   * `readPageFor` as the body of a Team API response, read and encoded by a read worker. Null when the
   * main thread must answer: no worker, a read state that needs a cursor write first, or a failure.
   */
  readonly readPageResponseFor = Effect.fn("ConversationReader.readPageResponseFor")(function* (
    this: ConversationReader,
    agentId: string,
    memberId: string,
    anchor: ConversationPageAnchor,
    limit: number,
    options: ConversationMarkerExclusions,
    route: EncodedResponseRoute,
    maxBytes: number,
  ) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    const threadId = agent.threadId;
    if (!threadId) return null;
    // Each app of a member reads the open chat after each change of it: the same answer, two or three
    // times. A request joins a read in flight that it would repeat exactly: the same page for the
    // same member and response, and no write to the database or the mailbox since that read began, so
    // its answer is at least as new as this request.
    const key = JSON.stringify([agentId, memberId, anchor, limit, options, route, maxBytes]);
    const shared = this.#pageResponses.get(key);
    if (shared && shared.token === this.#writeToken()) return yield* Deferred.await(shared.answer);
    yield* readerStep(() => this.#mailboxSync.reconcilePersistedMailboxMessages(agent));
    const entry = { token: this.#writeToken(), answer: yield* Deferred.make<PageResponse | null>() };
    this.#pageResponses.set(key, entry);
    const result = yield* this.#store.database
      .readOffMain((reader) =>
        reader.conversationPageResponse({
          kind: "conversation-page-response",
          agentId,
          threadId,
          anchor,
          limit,
          options,
          memberId,
          route,
          maxBytes,
        }),
      )
      .pipe(
        Effect.map((answer) => (answer && !("needsMain" in answer) ? answer : null)),
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#pageResponses.get(key) === entry) this.#pageResponses.delete(key);
          }),
        ),
      );
    yield* Deferred.succeed(entry.answer, result);
    return result;
  }, Effect.uninterruptible);

  /** Moves with each write of the main connection and each committed change of the mailbox. */
  #writeToken(): string {
    const row = this.#store.database.connection.prepare("SELECT total_changes() AS changes").get();
    return `${String(row?.changes)}:${this.#mailboxSync.mailboxRevision}`;
  }

  /** `search`, read by a read worker when one runs. */
  readonly searchOffMain = Effect.fn("ConversationReader.searchOffMain")(function* (
    this: ConversationReader,
    query: string,
    agentId?: string,
    cursor?: string,
    limit = 100,
  ) {
    const offMain = yield* this.#store.database.readOffMain((reader) =>
      reader.searchMessages({ kind: "search-messages", query, agentId, cursor, limit }),
    );
    return offMain ?? (yield* readerStep(() => this.search(query, agentId, cursor, limit)));
  });

  /** `searchFiles`, read by a read worker when one runs. */
  readonly searchFilesOffMain = Effect.fn("ConversationReader.searchFilesOffMain")(function* (
    this: ConversationReader,
    query: string,
    cursor?: string,
    limit = 50,
  ) {
    const offMain = yield* this.#store.database.readOffMain((reader) =>
      reader.searchFiles({ kind: "search-files", query, cursor, limit }),
    );
    return offMain ?? (yield* readerStep(() => this.searchFiles(query, cursor, limit)));
  });

  /** `listReads`, with each read state that needs no cursor write computed by a read worker when one runs. */
  readonly listReadsOffMain = Effect.fn("ConversationReader.listReadsOffMain")(function* (
    this: ConversationReader,
    memberId: string,
    options: ConversationMarkerExclusions = {},
  ) {
    const agents = this.#hooks.listAgents();
    const offMain = yield* this.#store.database.readOffMain((reader) =>
      reader.readStates({
        kind: "read-states",
        memberId,
        threads: agents.flatMap((agent) => (agent.threadId ? [{ agentId: agent.id, threadId: agent.threadId }] : [])),
        options,
      }),
    );
    return yield* readerStep(() => {
      if (!offMain) return this.#reads.listStates(memberId, agents, options);
      return Object.fromEntries(
        agents.map((agent) => [
          agent.id,
          offMain[agent.id] ?? this.#reads.readStateForThread(memberId, agent.threadId, options),
        ]),
      );
    });
  });

  search(query: string, agentId?: string, cursor?: string, limit = 100): ConversationSearchPage {
    return this.#store.database.searchConversationMessages(query, agentId, cursor, limit);
  }

  searchFiles(query: string, cursor?: string, limit = 50): ConversationFileSearchPage {
    return this.#store.database.searchConversationFiles(query, cursor, limit);
  }

  listReads(memberId: string, options: ConversationMarkerExclusions = {}): Record<string, ConversationReadState> {
    return this.#reads.listStates(memberId, this.#hooks.listAgents(), options);
  }

  adoptReads(sourceMemberId: string, targetMemberId: string): void {
    this.#reads.adoptMemberState(sourceMemberId, targetMemberId);
  }

  readonly markRead = Effect.fn("ConversationReader.markRead")(function* (
    this: ConversationReader,
    agentId: string,
    memberId: string,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    return yield* readerStep(() => {
      const previous = this.#reads.readStateForThread(memberId, agent.threadId, options).throughMessageId;
      const state = this.#reads.markReadForThread(memberId, agent.threadId, throughMessageId, options);
      if (state.throughMessageId !== previous) {
        // Read cursors are shared by a member's devices, not by every team member.
        // Invalidate without broadcasting a reader's cursor; each client reloads its own state.
        this.#hooks.emit({
          type: "conversation-invalidated",
          agentId,
          revision: this.#store.database.readConversationRevision(agentId, agent.threadId),
        });
      }
      return state;
    });
  }, Effect.uninterruptible);

  readonly markUnread = Effect.fn("ConversationReader.markUnread")(function* (
    this: ConversationReader,
    agentId: string,
    memberId: string,
  ) {
    const agent = yield* this.#store.existing(agentId).pipe(toConversationReadFailed);
    return yield* readerStep(() => {
      const state = this.#reads.markUnreadForThread(memberId, agent.threadId);
      this.#hooks.emit({
        type: "conversation-invalidated",
        agentId,
        revision: this.#store.database.readConversationRevision(agentId, agent.threadId),
      });
      return state;
    });
  }, Effect.uninterruptible);
}

/** A page encoded by a read worker, or a page too large for one frame. */
type PageResponse = { body: string } | { tooLarge: true };

class ConversationReadFailed extends Schema.TaggedError<ConversationReadFailed>()("ConversationReadFailed", {
  cause: Schema.Defect(),
}) {}

const { sync: readerStep, rewrap: toConversationReadFailed } = causeHelpers(ConversationReadFailed);
