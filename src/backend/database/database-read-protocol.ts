// The messages between the main process and a database read worker. Types only: the worker entry
// loads no part of the main process through this file.

import type {
  ConversationFileSearchPage,
  ConversationPage,
  ConversationPageAnchor,
  ConversationReadState,
  ConversationSearchPage,
} from "@openbot/contracts/ipc";
import type { ChannelSearchRequest, ChannelSearchResult } from "./channel-search-queries";
import type { ConversationMarkerExclusions } from "./conversation-queries";

/** One read that a worker answers whole, in one read transaction of its own connection. */
export type DatabaseReadRequest =
  | {
      kind: "conversation-page";
      agentId: string;
      threadId: string;
      anchor: ConversationPageAnchor;
      limit: number;
      options: ConversationMarkerExclusions;
      /** The member whose read state comes with the page, or null for the page alone. */
      readStateFor: string | null;
    }
  | {
      kind: "read-states";
      memberId: string;
      /** The threads of the chats, by agent. */
      threads: { agentId: string; threadId: string }[];
      options: ConversationMarkerExclusions;
    }
  | {
      kind: "conversation-page-response";
      agentId: string;
      threadId: string;
      anchor: ConversationPageAnchor;
      limit: number;
      options: ConversationMarkerExclusions;
      memberId: string;
      /** The response this page is encoded for. */
      route: EncodedResponseRoute;
      /** A page whose JSON is larger is read again with half the messages, down to one. */
      maxBytes: number;
    }
  | { kind: "search-messages"; query: string; agentId?: string; cursor?: string; limit?: number }
  | { kind: "search-files"; query: string; cursor?: string; limit?: number }
  /** The workspace message search, over the channels that the main process checked. */
  | { kind: "search-channel-messages"; request: ChannelSearchRequest };

/**
 * A read state that a worker could not give, because the member's cursor must be written first (no
 * cursor yet, or one that names a message the thread no longer holds). Only the main connection
 * writes, so the main process computes it.
 */
export type WorkerReadState = ConversationReadState | null;

/**
 * The route, protocol, capabilities and hidden agents that a response is encoded against, as plain
 * data for a worker. The main process says how to encode (`DatabaseReadWorkerOptions.encodePage`).
 */
export interface EncodedResponseRoute {
  method: string;
  path: string;
  protocol: number;
  capabilities: string[];
  hiddenAgentIds: string[] | null;
}

/** A page with its read state, encoded as the response body; or why the main process must answer. */
export type PageResponseResult =
  | { body: string }
  /** Even a page of one message is larger than `maxBytes`. */
  | { tooLarge: true }
  /** The read state needs a cursor write first, or this worker cannot encode. */
  | { needsMain: true };

export interface DatabaseReadResults {
  "conversation-page-response": PageResponseResult;
  "conversation-page": { page: ConversationPage; readState: WorkerReadState };
  /** By agent id; null as in `WorkerReadState`. */
  "read-states": Record<string, WorkerReadState>;
  "search-messages": ConversationSearchPage;
  "search-files": ConversationFileSearchPage;
  "search-channel-messages": ChannelSearchResult;
}

export type DatabaseReadKind = DatabaseReadRequest["kind"];

export type DatabaseReadRequestOf<K extends DatabaseReadKind> = Extract<DatabaseReadRequest, { kind: K }>;

/** From the main process to a worker. */
export type DatabaseReadWorkerMessage =
  | { type: "read"; id: number; request: DatabaseReadRequest }
  /**
   * Closes the worker's connection. The worker then writes 1 into `closed[0]` and wakes the main
   * thread, which waits for it: the main connection must be the last one to close, so that SQLite
   * copies the write-ahead log into the database and removes it. A log left behind makes the next
   * start run the full integrity check.
   */
  | { type: "close"; closed: Int32Array };

/** The answer to one read, with the kind of the request so that the main process can narrow it. */
export type DatabaseReadResultReply = {
  [K in DatabaseReadKind]: { type: "result"; id: number; kind: K; result: DatabaseReadResults[K] };
}[DatabaseReadKind];

/** From a worker to the main process. A failed read carries only the error's message. */
export type DatabaseReadWorkerReply = DatabaseReadResultReply | { type: "failure"; id: number; message: string };

/** What the worker receives as `workerData`. */
export interface DatabaseReadWorkerData {
  /** The path of `openbot.db`. */
  databasePath: string;
}
