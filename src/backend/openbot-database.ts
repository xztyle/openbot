import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgentProviderId,
  AgentSummary,
  ConversationFileSearchPage,
  ConversationMessage,
  ConversationPage,
  ConversationPageAnchor,
  ConversationSearchPage,
  ConversationSnapshot,
  HostedSiteConversationEventStatus,
} from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { AgentHistoryQueries, type AgentHistorySelection } from "./database/agent-history-queries";
import { type AgentModelChange, AgentRoster } from "./database/agent-roster";
import { AgentUsage } from "./database/agent-usage";
import { type ConversationMarkerExclusions, ConversationQueries } from "./database/conversation-queries";
import { ConversationWriter } from "./database/conversation-writer";
import { DatabaseCore, type OrchestrationEventInput } from "./database/database-core";
import type { DatabaseReadWorkerData } from "./database/database-read-protocol";
import { DatabaseReader, type DatabaseReaderOptions, type DatabaseReadWorkerHandle } from "./database/database-reader";
import {
  type ActiveHostedSiteConversationEvent,
  HostedSiteEventLog,
  type PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";
import { InsightQueries } from "./database/insight-queries";
import {
  MailboxProjection,
  type MailboxProjectionChanges,
  type MailboxProjectionState,
} from "./database/mailbox-projection";
import {
  type ProviderHistoryImportState,
  type ProviderHistorySessionInput,
  type ProviderHistoryStagedItem,
  type ProviderHistoryStagedTurn,
  type ProviderHistoryStagedTurnPage,
  type ProviderHistoryStageResult,
  ProviderHistoryStore,
  type ProviderHistoryTurnCursor,
} from "./database/provider-history-store";
import { type ProviderSession, ProviderSessions } from "./database/provider-sessions";
import { ThreadReplay } from "./database/thread-replay";
import { type StoredThreadSummary, ThreadSummaries } from "./database/thread-summaries";
import { WorkspaceQueries } from "./database/workspace-queries";

// Declared in this module before the split and part of the frozen public surface, so it stays
// reachable from here rather than only from the controller that owns it now. Structural `Pick<...>`
// types over this class do not cover exported types.
export type { OrchestrationEventInput } from "./database/database-core";
export type {
  ActiveHostedSiteConversationEvent,
  PendingHostedSiteTerminalEvent,
} from "./database/hosted-site-event-log";
export type {
  ProviderHistoryImportState,
  ProviderHistorySessionInput,
  ProviderHistoryStagedItem,
  ProviderHistoryStagedTurn,
  ProviderHistoryStagedTurnPage,
  ProviderHistoryStageResult,
  ProviderHistoryTurnCursor,
} from "./database/provider-history-store";
export type { ProviderSession } from "./database/provider-sessions";
export type { StoredThreadSummary } from "./database/thread-summaries";

/**
 * The local OpenBot event log and its read projections.
 *
 * A command appends events, changes projections, and stores its receipt in one
 * SQLite transaction. Providers never receive direct access to this database.
 */
export class OpenBotDatabase {
  readonly #core: DatabaseCore;
  readonly usage: AgentUsage;
  /** The reads of the workspace fleet, step trail and artifact views. */
  readonly workspace: WorkspaceQueries;
  /** The reads of the goals, money, costs and briefing views. */
  readonly insight: InsightQueries;
  readonly #conversations: ConversationQueries;
  readonly #roster: AgentRoster;
  readonly #conversationWrites: ConversationWriter;
  readonly #replay: ThreadReplay;
  readonly #hostedSiteEvents: HostedSiteEventLog;
  readonly #mailbox: MailboxProjection;
  readonly #sessions: ProviderSessions;
  readonly #agentHistory: AgentHistoryQueries;
  readonly #providerHistory: ProviderHistoryStore;
  readonly #summaries: ThreadSummaries;
  #reader: DatabaseReader | null = null;

  constructor(readonly userDataPath: string) {
    this.#core = new DatabaseCore({ userDataPath });
    this.usage = new AgentUsage(this.#core);
    this.workspace = new WorkspaceQueries({ core: this.#core });
    this.insight = new InsightQueries(this.#core);
    this.#conversations = new ConversationQueries({ core: this.#core });
    this.#roster = new AgentRoster({ core: this.#core });
    this.#conversationWrites = new ConversationWriter({ core: this.#core, roster: this.#roster });
    this.#replay = new ThreadReplay({ core: this.#core, conversations: this.#conversations });
    this.#hostedSiteEvents = new HostedSiteEventLog({ core: this.#core });
    this.#mailbox = new MailboxProjection({ core: this.#core });
    this.#agentHistory = new AgentHistoryQueries(this.#core);
    this.#sessions = new ProviderSessions({ core: this.#core });
    this.#providerHistory = new ProviderHistoryStore({ core: this.#core });
    this.#summaries = new ThreadSummaries({ core: this.#core });
  }

  get path(): string {
    return this.#core.path;
  }

  initialize() {
    return this.#core.initialize();
  }

  close(): void {
    // The workers' connections close first: the last connection to close removes the write-ahead log.
    this.#reader?.close();
    this.#reader = null;
    this.#core.close();
  }

  /**
   * Lets worker threads answer the heavy reads (`readOffMain`). The app starts its bundled worker; a
   * test or script starts the source. Without this, every read runs on the main connection.
   */
  useReadWorkers(
    spawn: (data: DatabaseReadWorkerData) => DatabaseReadWorkerHandle,
    options: Omit<DatabaseReaderOptions, "spawn"> = {},
  ): void {
    this.#reader?.close();
    this.#reader = new DatabaseReader({ ...options, spawn: () => spawn({ databasePath: this.path }) });
  }

  /**
   * One read answered by a read worker, so the main thread's event loop runs on while SQLite reads.
   * Succeeds with null when the read must run on the main connection: no worker runs, the main
   * connection is inside a transaction whose rows a worker cannot see, or the worker failed. The
   * caller then makes the same read here, so the answer does not depend on where it ran.
   */
  /** How many reads the read workers answered since `useReadWorkers`. */
  get readsOffMain(): number {
    return this.#reader?.answered ?? 0;
  }

  readOffMain<T>(read: (reader: DatabaseReader) => Promise<T>): Effect.Effect<T | null> {
    const reader = this.#reader;
    if (!reader?.available || !this.#core.open || this.#core.connection.isTransaction) return Effect.succeed(null);
    return Effect.promise(() => read(reader).catch(() => null));
  }

  get connection(): DatabaseSync {
    return this.#core.connection;
  }

  dispatch<T>(
    commandId: string,
    events: OrchestrationEventInput[],
    project: (db: DatabaseSync, sequences: number[]) => T,
  ): T {
    return this.#core.dispatch(commandId, events, project);
  }

  commandResult(commandId: string): unknown | undefined {
    return this.#core.commandResult(commandId);
  }

  hasAggregateEvents(aggregateType: string, aggregateId: string): boolean {
    return this.#core.hasAggregateEvents(aggregateType, aggregateId);
  }

  backupLegacyFile(path: string) {
    return this.#core.backupLegacyFile(path);
  }

  recordPendingHostedSiteTerminalEvent(event: PendingHostedSiteTerminalEvent): void {
    this.#hostedSiteEvents.recordPendingHostedSiteTerminalEvent(event);
  }

  pendingHostedSiteTerminalEvents(): PendingHostedSiteTerminalEvent[] {
    return this.#hostedSiteEvents.pendingHostedSiteTerminalEvents();
  }

  deletePendingHostedSiteTerminalEvent(
    agentId: string,
    operationId: string,
    status: Exclude<HostedSiteConversationEventStatus, "running">,
  ): void {
    this.#hostedSiteEvents.deletePendingHostedSiteTerminalEvent(agentId, operationId, status);
  }

  recordActiveHostedSiteConversationEvent(event: ActiveHostedSiteConversationEvent): void {
    this.#hostedSiteEvents.recordActiveHostedSiteConversationEvent(event);
  }

  deleteActiveHostedSiteConversationEvent(agentId: string, operationId: string): void {
    this.#hostedSiteEvents.deleteActiveHostedSiteConversationEvent(agentId, operationId);
  }

  activeHostedSiteConversationEvents(): ActiveHostedSiteConversationEvent[] {
    return this.#hostedSiteEvents.activeHostedSiteConversationEvents();
  }

  listAgents(): AgentSummary[] {
    return this.#roster.listAgents();
  }

  unclaimedThreads(): { threadId: string; agentId: string }[] {
    return this.#roster.unclaimedThreads();
  }

  latestRosterAgents(): unknown[] {
    return this.#roster.latestRosterAgents();
  }

  replaceAgents(commandId: string, agents: AgentSummary[], eventType: string, modelChange?: AgentModelChange): void {
    this.#roster.replaceAgents(commandId, agents, eventType, modelChange);
  }

  hardDeleteAgent(commandId: string, agentId: string, threadId: string | null, remainingAgents: AgentSummary[]): void {
    this.#roster.hardDeleteAgent(commandId, agentId, threadId, remainingAgents);
  }

  readConversation(agentId: string, threadId: string | null): ConversationSnapshot {
    return this.#conversations.readConversation(agentId, threadId);
  }

  readTurnAssistantMessages(agentId: string, threadId: string, turnId: string): ConversationMessage[] {
    return this.#conversations.readTurnAssistantMessages(agentId, threadId, turnId);
  }

  readActiveTurnId(agentId: string, threadId: string | null): string | null {
    return this.#conversations.readActiveTurnId(agentId, threadId);
  }

  readRunningTurnIds(): Map<string, string[]> {
    return this.#conversations.readRunningTurnIds();
  }

  readConversationRevision(agentId: string, threadId: string | null): number {
    return this.#conversations.readConversationRevision(agentId, threadId);
  }

  readConversationRuntime(
    agentId: string,
    threadId: string | null,
  ): { activeTurnId: string | null; latestMessage: ConversationMessage | null } {
    return this.#conversations.readConversationRuntime(agentId, threadId);
  }

  readAgentHistory(agentId: string, threadId: string, selection: AgentHistorySelection) {
    return this.#agentHistory.read(agentId, threadId, selection);
  }

  readConversationMessages(
    agentId: string,
    threadId: string | null,
    messageIds: readonly string[],
  ): ConversationMessage[] {
    return this.#conversations.readConversationMessages(agentId, threadId, messageIds);
  }

  readConversationRecoveryMessages(
    agentId: string,
    threadId: string | null,
    activeTurnId: string | null,
  ): ConversationMessage[] {
    return this.#conversations.readConversationRecoveryMessages(agentId, threadId, activeTurnId);
  }

  readConversationPage(
    agentId: string,
    threadId: string | null,
    anchor: ConversationPageAnchor = { type: "latest" },
    requestedLimit = 50,
    options: ConversationMarkerExclusions = {},
  ): ConversationPage {
    return this.#conversations.readConversationPage(agentId, threadId, anchor, requestedLimit, options);
  }

  /** The ids of every turn that has a message in the thread, for the forget of what a chat taught. */
  threadTurnIds(threadId: string): string[] {
    return this.connection
      .prepare(
        "SELECT DISTINCT turn_id FROM projection_thread_messages WHERE thread_id = ? AND turn_id IS NOT NULL LIMIT 20000",
      )
      .all(threadId)
      .flatMap((row) => (typeof row.turn_id === "string" ? [row.turn_id] : []));
  }

  supportedConversationCursor(
    threadId: string,
    throughMessageId: string | null,
    options: ConversationMarkerExclusions = {},
  ): string | null {
    return this.#conversations.supportedConversationCursor(threadId, throughMessageId, options);
  }

  searchConversationMessages(
    query: string,
    agentId?: string,
    cursor?: string,
    requestedLimit = 100,
  ): ConversationSearchPage {
    return this.#conversations.searchConversationMessages(query, agentId, cursor, requestedLimit);
  }

  searchConversationFiles(query: string, cursor?: string, requestedLimit = 50): ConversationFileSearchPage {
    return this.#conversations.searchConversationFiles(query, cursor, requestedLimit);
  }

  persistConversation(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown = {},
    commandId = `conversation:${eventType}:${randomUUID()}`,
  ): ConversationSnapshot {
    return this.#conversationWrites.persistConversation(snapshot, eventType, payload, commandId);
  }

  /** Writes one message of a thread, for a caller that knows only that message changed. */
  persistStreamingMessage(input: {
    snapshot: ConversationSnapshot;
    messageId: string;
    eventType: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    return this.#conversationWrites.persistStreamingMessage(input);
  }

  appendConversationMessage(input: {
    agentId: string;
    threadId: string;
    activeTurnId: string | null;
    message: ConversationMessage;
    eventType: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    return this.#conversationWrites.appendConversationMessage(input);
  }

  changedConversationMessages(threadId: string, messages: readonly ConversationMessage[]): ConversationMessage[] {
    return this.#conversationWrites.changedConversationMessages(threadId, messages);
  }

  persistConversationChanges(input: {
    agentId: string;
    threadId: string;
    activeTurnId: string | null;
    changedMessages: readonly ConversationMessage[];
    removedMessageIds?: readonly string[];
    eventType: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    return this.#conversationWrites.persistConversationChanges(input);
  }

  upsertProviderHistoryMessage(input: {
    agentId: string;
    threadId: string;
    activeTurnId?: string | null;
    message: ConversationMessage;
    eventType?: string;
    detail?: unknown;
    commandId?: string;
  }): number {
    return this.#conversationWrites.upsertProviderHistoryMessage(input);
  }

  /** Commits one normalized provider-history page and its staging marker as one transaction. */
  importProviderHistoryMessages(input: {
    sessionId: string;
    turnId: string;
    agentId: string;
    threadId: string;
    messages: readonly ConversationMessage[];
    throughItemIndex?: number;
    complete: boolean;
    detail?: unknown;
  }): void {
    const db = this.connection;
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      for (const message of input.messages) {
        this.upsertProviderHistoryMessage({
          agentId: input.agentId,
          threadId: input.threadId,
          message,
          eventType: "provider-history.message-imported",
          detail: input.detail,
        });
      }
      if (input.throughItemIndex !== undefined) {
        this.#providerHistory.markItemsImportedThrough(input.sessionId, input.turnId, input.throughItemIndex);
      }
      if (input.complete) this.#providerHistory.markTurnImported(input.sessionId, input.turnId);
      if (ownsTransaction) db.exec("COMMIT");
    } catch (error) {
      if (ownsTransaction && db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  persistConversationAndMailbox(
    snapshot: ConversationSnapshot,
    eventType: string,
    payload: unknown,
    mailboxState: MailboxProjectionState,
    mailboxEventType: string,
  ): ConversationSnapshot {
    const db = this.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.replaceMailboxState(`mailbox:${mailboxEventType}:${randomUUID()}`, mailboxState, mailboxEventType);
      const persisted = this.#conversationWrites.persistConversation(
        snapshot,
        eventType,
        payload,
        `conversation:${eventType}:${randomUUID()}`,
      );
      db.exec("COMMIT");
      return persisted;
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  persistConversationChangesAndMailbox(
    snapshot: ConversationSnapshot,
    changedMessages: readonly ConversationMessage[],
    eventType: string,
    payload: unknown,
    mailboxState: MailboxProjectionState,
    mailboxChanges: MailboxProjectionChanges,
    mailboxEventType: string,
  ): ConversationSnapshot {
    const db = this.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.applyMailboxChanges(
        `mailbox:${mailboxEventType}:${randomUUID()}`,
        mailboxState,
        mailboxChanges,
        mailboxEventType,
      );
      if (!snapshot.threadId) {
        db.exec("COMMIT");
        return structuredClone(snapshot);
      }
      const revision = this.#conversationWrites.persistConversationChanges({
        agentId: snapshot.agentId,
        threadId: snapshot.threadId,
        activeTurnId: snapshot.activeTurnId,
        changedMessages,
        eventType,
        detail: payload,
        commandId: `conversation:${eventType}:${randomUUID()}`,
      });
      db.exec("COMMIT");
      return { ...structuredClone(snapshot), revision };
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }

  activeProviderSession(threadId: string, provider: AgentProviderId): ProviderSession | null {
    return this.#sessions.activeProviderSession(threadId, provider);
  }

  listProviderSessions(threadId: string): ProviderSession[] {
    return this.#sessions.listProviderSessions(threadId);
  }

  listProviderSessionIds(externalSessionId?: string): string[] {
    return this.#sessions.listProviderSessionIds(externalSessionId);
  }

  listExternalSessionIds(): string[] {
    return this.#sessions.listExternalSessionIds();
  }

  publicThreadForSession(agentId: string, provider: AgentProviderId, externalSessionId: string): string | null {
    return this.#sessions.publicThreadForSession(agentId, provider, externalSessionId);
  }

  /** Each thread's active session of each provider, keyed by `activeSessionKey(threadId, provider)`. */
  activeProviderSessions(): Map<string, ProviderSession> {
    return this.#sessions.activeProviderSessions();
  }

  activeProviderSessionThreads(agentId: string): string[] {
    return this.#sessions.activeProviderSessionThreads(agentId);
  }

  bindProviderSession(input: {
    threadId: string;
    provider: AgentProviderId;
    externalSessionId: string;
    model: string;
    effort: string;
    resumeCursor?: string | null;
  }): ProviderSession {
    return this.#sessions.bindProviderSession(input);
  }

  deactivateProviderSessions(threadId: string): void {
    this.#sessions.deactivateProviderSessions(threadId);
  }

  updateProviderSessionConfig(sessionId: string, threadId: string, model: string, effort: string): void {
    this.#sessions.updateProviderSessionConfig(sessionId, threadId, model, effort);
  }

  ensureProviderHistoryImport(input: ProviderHistorySessionInput): ProviderHistoryImportState {
    return this.#providerHistory.ensureImport(input);
  }

  stageProviderHistoryFragment(input: {
    sessionId: string;
    fragment: import("./provider-history").ProviderHistoryFragment;
    cursor?: unknown;
    exact?: boolean;
  }): ProviderHistoryStageResult {
    return this.#providerHistory.stageProviderHistoryFragment(input);
  }

  providerHistoryImport(sessionId: string): ProviderHistoryImportState | null {
    return this.#providerHistory.readImport(sessionId);
  }

  stagedProviderHistoryTurns(sessionId: string, limit = 50): ProviderHistoryStagedTurn[] {
    return this.#providerHistory.readStagedTurns(sessionId, limit);
  }

  stagedProviderHistoryTurnPage(
    sessionId: string,
    input: { after?: ProviderHistoryTurnCursor; limit?: number } = {},
  ): ProviderHistoryStagedTurnPage {
    return this.#providerHistory.readStagedTurnPage(sessionId, input);
  }

  stagedProviderHistoryItems(input: {
    sessionId: string;
    turnId: string;
    afterIndex?: number;
    limit?: number;
    pendingOnly?: boolean;
  }): ProviderHistoryStagedItem[] {
    return this.#providerHistory.readStagedItems(input);
  }

  markProviderHistoryTurnImported(sessionId: string, turnId: string): void {
    this.#providerHistory.markTurnImported(sessionId, turnId);
  }

  markProviderHistoryImportState(
    sessionId: string,
    state: ProviderHistoryImportState["state"],
    cursor?: unknown,
  ): void {
    this.#providerHistory.markImportState(sessionId, state, cursor);
  }

  saveThreadSummary(
    threadId: string,
    throughMessageId: string | null,
    text: string,
    estimatedTokens: number,
  ): StoredThreadSummary {
    return this.#summaries.saveThreadSummary(threadId, throughMessageId, text, estimatedTokens);
  }

  latestThreadSummary(threadId: string): StoredThreadSummary | null {
    return this.#summaries.latestThreadSummary(threadId);
  }

  rebuildThreadProjection(threadId: string): ConversationSnapshot {
    return this.#replay.rebuildThreadProjection(threadId);
  }

  replaceMailboxState(
    commandId: string,
    state: MailboxProjectionState,
    eventType: string,
    fileDeletions: string[] = [],
    rebaseHistory = false,
  ): boolean {
    return this.#mailbox.replaceMailboxState(commandId, state, eventType, fileDeletions, rebaseHistory);
  }

  applyMailboxChanges(
    commandId: string,
    state: MailboxProjectionState,
    changes: MailboxProjectionChanges,
    eventType: string,
    fileDeletions: string[] = [],
  ): boolean {
    return this.#mailbox.applyMailboxChanges(commandId, state, changes, eventType, fileDeletions);
  }

  pendingFileDeletions(): Array<{ id: string; path: string }> {
    return this.#mailbox.pendingFileDeletions();
  }

  completeFileDeletion(id: string): void {
    this.#mailbox.completeFileDeletion(id);
  }

  failFileDeletion(id: string, error: string): void {
    this.#mailbox.failFileDeletion(id, error);
  }

  readMailboxState(): unknown | null {
    return this.#mailbox.readMailboxState();
  }
}

export function stableThreadId(agentId: string): string {
  return `openbot-thread-${agentId}`;
}
