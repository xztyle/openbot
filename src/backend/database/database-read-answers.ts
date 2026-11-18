import type { DatabaseSync } from "node:sqlite";
import type { ConversationPage, ConversationReadState } from "@openbot/contracts/ipc";
import { ChannelSearchQueries } from "./channel-search-queries";
import { ConversationQueries } from "./conversation-queries";
import type {
  DatabaseReadRequest,
  DatabaseReadResultReply,
  EncodedResponseRoute,
  PageResponseResult,
  WorkerReadState,
} from "./database-read-protocol";
import { ThreadReadStates } from "./thread-read-states";

/**
 * The answers of a database read worker, over its own connection. Each request reads in one read
 * transaction, so a page and its read state, or a list of states and the versions that key their
 * cache, come from one state of the database. It uses the same query classes as the main connection,
 * so an answer equals the one that the main thread would give at the same moment.
 *
 * It only reads: a read state that needs a cursor write first comes back as null. Never imports the
 * facade, Electron or Effect: the worker entry loads this file.
 */
/** Encodes a page with its read state as the body of a response to `route`; given by the main process. */
export type PageEncoder = (
  route: EncodedResponseRoute,
  page: ConversationPage & { readState: ConversationReadState },
) => string;

export class DatabaseReadAnswers {
  readonly #connection: DatabaseSync;
  readonly #encodePage: PageEncoder | null;
  readonly #conversations: ConversationQueries;
  readonly #states: ThreadReadStates;
  readonly #channelSearch: ChannelSearchQueries;

  constructor(connection: DatabaseSync, encodePage: PageEncoder | null = null) {
    this.#connection = connection;
    this.#encodePage = encodePage;
    const core = { connection };
    this.#conversations = new ConversationQueries({ core });
    this.#channelSearch = new ChannelSearchQueries({ core });
    // Committed rows only: no other transaction of this connection can take a version back.
    this.#states = new ThreadReadStates({
      core,
      conversations: this.#conversations,
      versionsAreFinal: () => true,
    });
  }

  /** The reply to one read; `id` is the request's. */
  answer(id: number, request: DatabaseReadRequest): DatabaseReadResultReply {
    const connection = this.#connection;
    connection.exec("BEGIN");
    try {
      const reply = this.#read(id, request);
      connection.exec("COMMIT");
      return reply;
    } catch (error) {
      if (connection.isTransaction) connection.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * The page as the Team API route answers it: a page that is too large for one frame is read again
   * with half the messages (`routeAgentConversation` does the same on the main thread).
   */
  #pageResponse(request: Extract<DatabaseReadRequest, { kind: "conversation-page-response" }>): PageResponseResult {
    const encode = this.#encodePage;
    if (!encode) return { needsMain: true };
    const readState = this.#states.knownState(request.memberId, request.threadId, request.options);
    if (!readState) return { needsMain: true };
    for (let limit = request.limit; ; limit = Math.floor(limit / 2)) {
      const page = {
        ...this.#conversations.readConversationPage(
          request.agentId,
          request.threadId,
          request.anchor,
          limit,
          request.options,
        ),
        readState,
      };
      if (Buffer.byteLength(JSON.stringify(page)) <= request.maxBytes) return { body: encode(request.route, page) };
      if (limit <= 1) return { tooLarge: true };
    }
  }

  #read(id: number, request: DatabaseReadRequest): DatabaseReadResultReply {
    switch (request.kind) {
      case "conversation-page": {
        const page = this.#conversations.readConversationPage(
          request.agentId,
          request.threadId,
          request.anchor,
          request.limit,
          request.options,
        );
        const readState: WorkerReadState =
          request.readStateFor === null
            ? null
            : this.#states.knownState(request.readStateFor, request.threadId, request.options);
        return { type: "result", id, kind: request.kind, result: { page, readState } };
      }
      case "conversation-page-response":
        return { type: "result", id, kind: request.kind, result: this.#pageResponse(request) };
      case "read-states": {
        const lookups = this.#states.lookups(request.memberId);
        const states: Record<string, WorkerReadState> = {};
        for (const { agentId, threadId } of request.threads)
          states[agentId] = this.#states.knownState(request.memberId, threadId, request.options, lookups);
        return { type: "result", id, kind: request.kind, result: states };
      }
      case "search-messages":
        return {
          type: "result",
          id,
          kind: request.kind,
          result: this.#conversations.searchConversationMessages(
            request.query,
            request.agentId,
            request.cursor,
            request.limit,
          ),
        };
      case "search-channel-messages":
        return { type: "result", id, kind: request.kind, result: this.#channelSearch.search(request.request) };
      case "search-files":
        return {
          type: "result",
          id,
          kind: request.kind,
          result: this.#conversations.searchConversationFiles(request.query, request.cursor, request.limit),
        };
    }
  }
}
