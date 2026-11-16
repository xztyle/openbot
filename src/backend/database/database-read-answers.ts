import type { DatabaseSync } from "node:sqlite";
import { ConversationQueries } from "./conversation-queries";
import type { DatabaseReadRequest, DatabaseReadResultReply, WorkerReadState } from "./database-read-protocol";
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
export class DatabaseReadAnswers {
  readonly #connection: DatabaseSync;
  readonly #conversations: ConversationQueries;
  readonly #states: ThreadReadStates;

  constructor(connection: DatabaseSync) {
    this.#connection = connection;
    const core = { connection };
    this.#conversations = new ConversationQueries({ core });
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
