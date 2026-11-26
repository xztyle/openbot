import { isSupportedAttachmentName } from "@openbot/contracts/attachment-files";
import { ATTACHMENT_LIMITS, INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type ConversationSnapshot, latestTurnAnswer } from "@openbot/contracts/ipc";
import { OWNER_MESSAGE_ITEM_TYPE } from "@openbot/contracts/owner-conversation";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Result } from "effect";
import { FileReferenceResolver, fileMentions } from "../file-references";
import type { GeneratedAttachmentSource, MailboxStore } from "../mailbox-store";
import type { AttachmentGateway } from "./attachment-gateway";
import type { ConversationRuntime } from "./conversation-runtime";

const logger = createOpenBotLogger("mentioned-files");

export interface MentionedFilesOptions {
  attachments: Pick<AttachmentGateway, "openSources">;
  mailbox: Pick<
    MailboxStore,
    "stageGeneratedAttachments" | "persistGeneratedAttachmentsWithConversation" | "discardStagedGeneratedAttachments"
  >;
  conversation: Pick<ConversationRuntime, "requireKnownAgent" | "rememberConversationSignature">;
  /** The folder name and the shared folder of the agent's space. */
  space: (agentId: string) => { slug: string; sharedDirectory: string };
  /** The files that the agent's tools wrote lately, newest last. */
  recentFiles: (agentId: string) => readonly string[];
}

const closeAll = (sources: readonly GeneratedAttachmentSource[]) =>
  Effect.promise(() => Promise.allSettled(sources.map((source) => source.handle.close())));

/**
 * The files that an agent names in what it tells the owner, attached by the host. An agent often writes
 * "it is in the shared folder as copy-a.txt" and attaches nothing, and the owner cannot reach a path.
 * The host finds each named file in the agent's workspace or its space's shared folder (the folders
 * that the agent's jail can read), and attaches it to the message, as `attach_files_to_response`
 * would. At most ten files and the attachment size limits; never a secret or a file outside those
 * folders. A file that it cannot read is left out: the message goes as it is.
 */
export class MentionedFiles {
  readonly #options: MentionedFilesOptions;

  constructor(options: MentionedFilesOptions) {
    this.#options = options;
  }

  /**
   * The opened files that the texts name, at most `limit`, none with a name in `skip`. The caller
   * closes each handle. Never fails: a file that cannot be found or read is left out.
   */
  readonly sources = Effect.fn("MentionedFiles.sources")(function* (
    this: MentionedFiles,
    agentId: string,
    texts: readonly string[],
    skip: ReadonlySet<string>,
    limit: number = INPUT_LIMITS.attachments,
  ): Effect.fn.Return<GeneratedAttachmentSource[]> {
    const paths = yield* this.paths(agentId, texts, skip, limit);
    // One at a time: the gateway refuses the whole list when one file fails its checks.
    const opened = yield* Effect.forEach(paths, (path) =>
      Effect.result(this.#options.attachments.openSources(agentId, [path], { allowAnyReadablePath: false })),
    );
    return opened.flatMap((result) => (Result.isSuccess(result) ? result.success : []));
  }).bind(this);

  /** The real paths of the files that `sources` opens. */
  readonly paths = Effect.fn("MentionedFiles.paths")(function* (
    this: MentionedFiles,
    agentId: string,
    texts: readonly string[],
    skip: ReadonlySet<string>,
    limit: number = INPUT_LIMITS.attachments,
  ): Effect.fn.Return<string[]> {
    const mentions = [...new Set(texts.flatMap(fileMentions))];
    if (mentions.length === 0 || limit <= 0) return [];
    const agent = yield* Effect.try(() => this.#options.conversation.requireKnownAgent(agentId)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!agent) return [];
    const space = this.#options.space(agentId);
    const resolver = new FileReferenceResolver({
      agent: { id: agent.id, workspacePath: agent.workspacePath, sharedDirectory: space.sharedDirectory },
      spaces: new Map([[space.slug, space.sharedDirectory]]),
      workspaces: new Map([[agent.id, agent.workspacePath]]),
      legacyShared: null,
      recentFiles: this.#options.recentFiles(agentId),
    });
    const paths: string[] = [];
    const names = new Set(skip);
    let total = 0;
    for (const mention of mentions) {
      if (paths.length >= limit) break;
      const found = yield* resolver.resolve(mention);
      if (found.kind !== "file" || names.has(found.name) || !isSupportedAttachmentName(found.name)) continue;
      if (paths.includes(found.path) || total + found.size > ATTACHMENT_LIMITS.totalBytes) continue;
      paths.push(found.path);
      names.add(found.name);
      total += found.size;
    }
    return paths;
  }).bind(this);

  /**
   * Attaches to the answer of a turn the files that it names and that the turn did not attach yet, and
   * saves them with it. For a turn of the owner's conversation; a failure leaves the answer as it was.
   */
  readonly attachToAnswer = Effect.fn("MentionedFiles.attachToAnswer")(function* (
    this: MentionedFiles,
    agentId: string,
    snapshot: ConversationSnapshot,
    turnId: string,
  ) {
    const answer = latestTurnAnswer(snapshot.messages, turnId);
    // A message to the owner took its files when it was sent.
    if (!answer || answer.itemType === OWNER_MESSAGE_ITEM_TYPE) return;
    const attached = new Set(
      snapshot.messages
        .filter((message) => message.turnId === turnId)
        .flatMap((message) => (message.attachments ?? []).map(({ name }) => name)),
    );
    const room = INPUT_LIMITS.attachments - (answer.attachments?.length ?? 0);
    const sources = yield* this.sources(agentId, [answer.text], attached, room);
    if (sources.length === 0) return;
    const { mailbox, conversation } = this.#options;
    const staged = yield* mailbox
      .stageGeneratedAttachments({ sources, ownerAgentId: agentId, ownerThreadId: snapshot.threadId })
      .pipe(Effect.ensuring(closeAll(sources)), Effect.result);
    if (Result.isFailure(staged)) {
      logger.warn("The files that an answer names could not be attached.", { cause: String(staged.failure.cause) });
      return;
    }
    const attachments = staged.success;
    const before = answer.attachments;
    answer.attachments = [...(before ?? []), ...attachments];
    const ids = attachments.map(({ id }) => id);
    try {
      const persisted = mailbox.persistGeneratedAttachmentsWithConversation(
        snapshot,
        "response.mentioned-files-attached",
        { turnId, messageId: answer.id, attachmentCount: attachments.length },
        ids,
      );
      snapshot.revision = persisted.revision;
      conversation.rememberConversationSignature(snapshot);
    } catch (error) {
      if (before) answer.attachments = before;
      else delete answer.attachments;
      logger.warn("The files that an answer names could not be saved.", { cause: String(error) });
      yield* mailbox.discardStagedGeneratedAttachments(ids).pipe(Effect.ignore);
    }
  }).bind(this);
}
