import { sortConversationMessages } from "@openbot/contracts/conversation-order";
import type { AgentProviderId, ConversationMessage, ConversationSnapshot } from "@openbot/contracts/ipc";
import {
  isImageGenerationAspectRatio,
  ROUTINE_QUIET_ANSWER_ITEM_TYPE,
  SYSTEM_NOTICE_ITEM_TYPE_PREFIX,
  systemNoticeFields,
} from "@openbot/contracts/ipc";
import { atelierPromptNotice } from "@openbot/contracts/owner-conversation";
import { isString } from "@openbot/contracts/runtime-values";
import { displayMessageReferences, type TeammatePrompt, teammatePrompts } from "./agent/delivery-content";
import { imageGenerationFailure, isImageGenerationItem } from "./agent/image-generation";
import { eventCheckMarker } from "./event-check-marker";
import type { DeliveryContext } from "./mailbox-store";
import type { ThreadItem } from "./protocol";
import { boundedReasoningText } from "./reasoning-text";

export interface ThreadTurnMessageContext {
  id: string;
  status?: string;
  startedAt?: number;
  baseTime?: number;
}

/**
 * Converts one bounded provider item page into OpenBot messages.
 *
 * `itemOffset` keeps timestamps stable when a provider splits one turn over several pages. The
 * caller must release the item page after this function returns; this function keeps no provider
 * item state between calls.
 */
export function messagesFromThreadItems(
  agentId: string,
  turn: ThreadTurnMessageContext,
  items: readonly ThreadItem[],
  itemOffset: number,
  findDelivery: (deliveryId: string) => DeliveryContext | null,
  findMessageDelivery: (messageId: string) => DeliveryContext | null,
): ConversationMessage[] {
  const baseTime = turn.baseTime ?? threadTurnBaseTime(turn, items, findDelivery);
  const messages: ConversationMessage[] = [];
  for (const [pageIndex, item] of items.entries()) {
    const itemIndex = itemOffset + pageIndex;
    const createdAt = new Date(baseTime + itemIndex).toISOString();
    if (item.type === "userMessage" && isString(item.id)) {
      const text = (item.content ?? [])
        .filter((part) => part.type === "text" && isString(part.text))
        .map((part) => part.text)
        .join("\n");
      const delivery = item.clientId ? findDelivery(item.clientId) : null;
      if (!text) continue;
      /* Claude Code joins the prompts that waited during a turn into one entry under a new ID: Motion
         notes, teammates' messages, Atelier's notes and the owner's messages alike. Each was stored
         under its own delivery when it was sent, with its own author, so the joined text is only a
         copy. It is never one message of the owner. */
      const merged = mergedClientIds(item);
      if (!delivery && merged.length > 0 && merged.every((id) => findDelivery(id) !== null)) continue;
      const row = { id: item.id, turnId: turn.id, text, createdAt };
      if (delivery) messages.push(promptMessage(delivery, row));
      else {
        /* The provider can keep a prompt under an ID that names no delivery. A teammate's message
           still names its sender and its mailbox message in the prompt, so it is not shown as one
           the user wrote. */
        const teammates = teammatePrompts(text).map((teammate) => ({
          teammate,
          found: findMessageDelivery(teammate.messageId),
        }));
        const fromTeammates =
          teammates.length > 0 &&
          teammates.every(({ teammate, found }) => !found || isTeammatePromptOf(teammate, promptMessage(found, row)));
        if (!fromTeammates) messages.push(undeliveredPrompt(row));
        else
          for (const [index, { teammate, found }] of teammates.entries())
            messages.push(
              found
                ? promptMessage(found, row)
                : teammateMessage(agentId, teammate, {
                    id: index === 0 ? item.id : `${item.id}:${teammate.messageId}`,
                    turnId: turn.id,
                    createdAt,
                  }),
            );
      }
    }
    if (item.type === "agentMessage" && isString(item.id) && item.text) {
      messages.push({
        id: item.id,
        turnId: turn.id,
        author: "assistant",
        text: item.phase === "commentary" ? boundedReasoningText(item.text) : item.text,
        createdAt,
        status: normalizeCompletionStatus(turn.status ?? "completed"),
        itemType: isString(item.phase) ? item.phase : "agentMessage",
      });
    }
    if (isImageGenerationItem(item) && isString(item.id)) {
      const providerStatus = isString(item.status) ? item.status : turn.status;
      const failed = providerStatus === "failed";
      const failure = imageGenerationFailure(item);
      messages.push({
        id: item.id,
        turnId: turn.id,
        author: "assistant",
        text: "",
        createdAt,
        status: failed ? "failed" : providerStatus === "interrupted" ? "interrupted" : "completed",
        itemType: "image_generation",
        imageGeneration: {
          ...(isString(item.revised_prompt) ? { prompt: item.revised_prompt } : {}),
          resolution: isString(item.resolution) ? item.resolution : "1024 × 1024",
          aspectRatio: isImageGenerationAspectRatio(item.aspectRatio) ? item.aspectRatio : "square",
          ...(failure ? { error: failure } : {}),
        },
      });
    }
  }
  return messages;
}

export function threadTurnBaseTime(
  turn: ThreadTurnMessageContext,
  items: readonly ThreadItem[],
  findDelivery: (deliveryId: string) => DeliveryContext | null,
): number {
  const firstUserItem = items.find((item) => item.type === "userMessage" && isString(item.clientId));
  const firstDelivery = firstUserItem?.clientId ? findDelivery(firstUserItem.clientId) : null;
  const deliveryTime = firstDelivery ? Date.parse(firstDelivery.delivery.createdAt) : Number.NaN;
  const turnStartedAt = typeof turn.startedAt === "number" ? turn.startedAt * 1_000 : Number.NaN;
  return Number.isFinite(deliveryTime) ? deliveryTime : Number.isFinite(turnStartedAt) ? turnStartedAt : Date.now();
}

/** Merges a partial page while keeping rows omitted by that page. */
export function mergeProviderHistoryMessages(
  stored: readonly ConversationMessage[],
  imported: readonly ConversationMessage[],
  provider?: AgentProviderId,
): ConversationMessage[] {
  if (provider === "claude") {
    const kept = stored.filter((message) => !isStoredClaudeNotice(message));
    return mergeConversationMessages(kept, reconcileClaudeHistoryMessages(kept, imported));
  }
  const importedIds = new Set(imported.map((message) => message.id));
  const importedAssistantMessages = new Set(imported.filter(isProviderAssistantMessage).map(providerMessageIdentity));
  // A condensed answer is the provider's message under a short text: the import carries the agent's
  // own text, so the answer is matched by that, and the import's copy under another ID is the repeat.
  const condensedStored = new Map(
    stored.flatMap((message) =>
      message.condensed && isProviderAssistantMessage(message)
        ? [[providerMessageIdentity({ ...message, text: message.condensed.original }), message.id] as const]
        : [],
    ),
  );
  const reconciledStored = stored.filter(
    (message) =>
      importedIds.has(message.id) ||
      !isProviderAssistantMessage(message) ||
      message.condensed !== undefined ||
      !importedAssistantMessages.has(providerMessageIdentity(message)),
  );
  const reconciledImported = imported.filter((message) => {
    if (!isProviderAssistantMessage(message)) return true;
    const condensedId = condensedStored.get(providerMessageIdentity(message));
    return condensedId === undefined || condensedId === message.id;
  });
  return mergeConversationMessages(reconciledStored, reconciledImported);
}

/** A user prompt from provider history, or the mailbox delivery that the prompt came from. */
function promptMessage(
  context: DeliveryContext | null,
  row: Pick<ConversationMessage, "id" | "turnId" | "text" | "createdAt">,
): ConversationMessage {
  const delivery = context?.delivery;
  return {
    id: delivery?.id ?? row.id,
    turnId: row.turnId,
    author: delivery?.sender.kind === "agent" ? "agent" : "user",
    source: delivery?.sender.kind === "agent" ? "agent" : "user",
    senderAgentId: delivery?.sender.kind === "agent" ? delivery.sender.agentId : undefined,
    replyToMessageId: delivery?.replyToMessageId,
    attachments: delivery?.attachments,
    delivery: delivery ? { id: delivery.id, status: delivery.status, position: delivery.position } : undefined,
    text: delivery?.text ?? row.text,
    createdAt: delivery?.createdAt ?? row.createdAt,
    status: "completed",
    ...eventCheckMarker(context?.eventCheck),
    ...systemNoticeFields(context?.notice),
  };
}

/**
 * A prompt that names no delivery. Text that Atelier wrote for the agent (`atelierPromptNotice`) is a
 * note in the agent's own activity; any other text stays the person's.
 */
function undeliveredPrompt(
  row: Pick<ConversationMessage, "id" | "turnId" | "text" | "createdAt">,
): ConversationMessage {
  const notice = atelierPromptNotice(row.text);
  return notice ? { ...promptMessage(null, row), ...systemNoticeFields(notice) } : promptMessage(null, row);
}

function mergedClientIds(item: ThreadItem): string[] {
  const ids = item.mergedClientIds;
  return Array.isArray(ids) ? ids.filter(isString) : [];
}

/**
 * A message that Atelier wrote for the agent but that is stored as one of the owner's (`author:
 * "user"`): a prompt that a provider kept with no sign of its delivery, imported before
 * `undeliveredPrompt`. It comes back as the note it is, with its text and ID, or null when it is not one.
 * A row with a delivery is the person's, except the old restart note that Atelier sent as the owner.
 */
export function reattributedAtelierPrompt(message: ConversationMessage): ConversationMessage | null {
  if (message.author !== "user") return null;
  // A note whose first write was a person's message kept that author (`mergedMessageAuthor`).
  if (message.itemType?.startsWith(SYSTEM_NOTICE_ITEM_TYPE_PREFIX))
    return message.source === "system" ? withoutSenderMember({ ...message, author: "system" }) : null;
  const notice = atelierPromptNotice(message.text);
  if (!notice || (message.delivery && notice !== "restart-resume")) return null;
  return withoutSenderMember({ ...message, ...systemNoticeFields(notice) });
}

/** A note has no person who sent it. */
function withoutSenderMember(message: ConversationMessage): ConversationMessage {
  const { senderMember: _senderMember, ...rest } = message;
  return rest;
}

/** A teammate's message whose mailbox delivery is gone, rebuilt from its provider prompt. */
function teammateMessage(
  recipientAgentId: string,
  teammate: TeammatePrompt,
  row: Pick<ConversationMessage, "id" | "turnId" | "createdAt">,
): ConversationMessage {
  return {
    ...row,
    author: "agent",
    source: "agent",
    senderAgentId: teammate.senderAgentId,
    replyToMessageId: teammate.replyToMessageId,
    exchange: {
      direction: "incoming",
      messageId: teammate.messageId,
      senderAgentId: teammate.senderAgentId,
      recipientAgentIds: [recipientAgentId],
      replyToMessageId: teammate.replyToMessageId,
      deliveries: [],
      ...(teammate.expectsReply ? {} : { expectsReply: false }),
    },
    text: teammate.text,
    status: "completed",
  };
}

/**
 * A copy of a teammate message that the mailbox holds too. An import that did not find the delivery
 * kept the message under the provider's ID: as one the user wrote, in builds before this check, or
 * rebuilt from its prompt. The mailbox row carries the same message, so the copy only repeats it.
 * A row the user wrote is a copy only when its text is the mailbox text, so no words of theirs go.
 */
export function isMailboxMessageCopy(
  message: ConversationMessage,
  mailboxMessages: ReadonlyMap<string, ConversationMessage>,
): boolean {
  if (message.delivery) return false;
  if (message.exchange?.direction === "incoming") return mailboxMessages.has(message.exchange.messageId);
  if (message.author !== "user") return false;
  const teammates = teammatePrompts(message.text);
  return (
    teammates.length > 0 &&
    teammates.every((teammate) => {
      const original = mailboxMessages.get(teammate.messageId);
      return original !== undefined && isTeammatePromptOf(teammate, original);
    })
  );
}

/** Whether a prompt holds this message and nothing more, so the message can take the prompt's place. */
function isTeammatePromptOf(teammate: TeammatePrompt, message: ConversationMessage): boolean {
  // A chat tag keeps its name, so the prompt text comes back without the agent list.
  return (
    message.senderAgentId === teammate.senderAgentId &&
    displayMessageReferences(message.text, message.attachments ?? [], new Map()).trimEnd() === teammate.text
  );
}

export function mergeConversationSnapshots(
  stored: ConversationSnapshot,
  live: ConversationSnapshot,
): ConversationSnapshot {
  const messages = mergeConversationMessages(stored.messages, live.messages);
  const merged: ConversationSnapshot = {
    agentId: live.agentId,
    threadId: live.threadId ?? stored.threadId,
    activeTurnId: live.activeTurnId,
    revision: live.revision,
    messages,
  };
  return merged;
}

function mergeConversationMessages(
  stored: readonly ConversationMessage[],
  live: readonly ConversationMessage[],
): ConversationMessage[] {
  const messages = new Map(stored.map((message) => [message.id, message]));
  for (const message of live) {
    const previous = messages.get(message.id);
    messages.set(
      message.id,
      previous
        ? {
            ...previous,
            ...message,
            // The reply condenser shortened this answer after its turn. The provider still has the
            // agent's own text, which the message keeps as its original.
            ...(previous.condensed && repeatsCondensedOriginal(previous, message.text)
              ? { text: previous.text, condensed: previous.condensed }
              : {}),
            attachments: message.attachments ?? previous.attachments,
            imageGeneration: message.imageGeneration ?? previous.imageGeneration,
          }
        : message,
    );
  }
  const merged = [...messages.values()];
  sortConversationMessages(merged);
  return merged;
}

function reconcileClaudeHistoryMessages(
  stored: readonly ConversationMessage[],
  imported: readonly ConversationMessage[],
): ConversationMessage[] {
  const storedMessages = new Map(stored.map((message) => [message.id, message]));
  const turns = new Map<string, ConversationMessage[]>();
  /* A turn's narration is imported under the session's own message IDs, which never match the IDs a
     live turn published it under. A turn this app already holds therefore keeps the narration it
     recorded, and the imported copy is dropped rather than stored a second time on every restart. */
  const storedNarrationTurns = new Set<string>();
  for (const message of stored) {
    if (!isClaudeNarration(message) || !message.turnId) continue;
    storedNarrationTurns.add(message.turnId);
  }
  const storedReasoning = new Map<string, ConversationMessage>();
  for (const message of stored) {
    if (!isClaudeReasoning(message) || !message.turnId) continue;
    if (message.id === `${message.turnId}:reasoning`) storedReasoning.set(message.turnId, message);
  }
  const importedNarration = new Map<string, ConversationMessage[]>();
  const importedReasoning = new Map<string, ConversationMessage[]>();
  for (const message of imported) {
    if (isClaudeReasoning(message) && message.turnId) {
      const parts = importedReasoning.get(message.turnId) ?? [];
      parts.push(message);
      importedReasoning.set(message.turnId, parts);
      continue;
    }
    if (!isClaudeNarration(message) || !message.turnId) continue;
    const parts = importedNarration.get(message.turnId) ?? [];
    parts.push(message);
    importedNarration.set(message.turnId, parts);
  }
  for (const message of imported) {
    if (!isClaudeAnswer(message) || !message.turnId) continue;
    const parts = turns.get(message.turnId) ?? [];
    parts.push(message);
    turns.set(message.turnId, parts);
  }
  const replacements = new Map<string, ConversationMessage>();
  const omitted = new Set<string>();
  /** Stored rows this has to rewrite that the import carries no entry of its own for. */
  const appended: ConversationMessage[] = [];
  for (const [turnId, parts] of importedReasoning) {
    const existing = storedReasoning.get(turnId);
    // Fresh imports keep provider IDs. A partial live row must not hide missing provider text.
    if (existing) {
      let canonicalPlaced = false;
      for (const part of parts) {
        if (!existing.text.includes(part.text)) continue;
        if (!canonicalPlaced) {
          replacements.set(part.id, existing);
          canonicalPlaced = true;
        } else omitted.add(part.id);
      }
      if (!canonicalPlaced) appended.push(existing);
    }
  }
  for (const [turnId, parts] of turns) {
    // Live Claude output combines SDK replies under one ID. Keep that ID and its metadata.
    const answer = storedMessages.get(`${turnId}:assistant`);
    if (!answer || !isClaudeAnswer(answer) || answer.turnId !== turnId) continue;
    const text = parts.map((part) => part.text).join("");
    /* The reply condenser shortens an answer after its turn and keeps the agent's own text on it.
       The import carries that own text, so the answer is matched by it, and keeps its short text. */
    const answerText = answer.condensed?.original ?? answer.text;
    const condensed = answer.condensed !== undefined && repeatsCondensedOriginal(answer, text);
    const narration = importedNarration.get(turnId) ?? [];
    /* A turn released before narration rode the thinking disclosure stored the narration and the
       answer together under this one ID. The import now splits the two, so the aggregate matches
       neither half on its own: match it whole, and keep only the answer as its text. Without this
       the backfill leaves the aggregate bubble in place and stores the split copy beside it. */
    const aggregate = narration.length > 0 && answerText === `${narration.map((part) => part.text).join("")}${text}`;
    /* Existing split records can have saved references. Never remove or combine them - but a
       database holding the aggregate and its canonical rows together must still read as one
       answer, so the aggregate keeps only the answer and the rows repeating it stop being
       bubbles. A row already demoted stays demoted, whatever the import calls it. */
    if (parts.some((part) => storedMessages.has(part.id))) {
      // A build before this check stored the import of a condensed answer beside it: that row only
      // repeats the original that the answer keeps, so it stops being a bubble too.
      for (const part of parts) {
        const existing = storedMessages.get(part.id);
        if (!existing || !(aggregate || condensed || existing.itemType === "commentary")) continue;
        replacements.set(part.id, { ...existing, ...part, itemType: "commentary" });
      }
      if (aggregate && !answer.condensed && answer.text) appended.push({ ...answer, text });
      continue;
    }
    if (!answerText || !(aggregate || condensed || text.startsWith(answerText))) continue;
    const first = parts[0];
    const last = parts.at(-1);
    if (!first || !last) continue;
    replacements.set(
      first.id,
      answer.condensed ? { ...answer, status: last.status } : { ...answer, text, status: last.status },
    );
    for (const part of parts.slice(1)) omitted.add(part.id);
    if (!storedNarrationTurns.has(turnId)) continue;
    for (const part of narration) {
      if (!storedMessages.has(part.id)) omitted.add(part.id);
    }
  }
  /* A turn that ended on its tool call said something and then answered nothing, so it imports as
     narration with no `agentMessage` and the loop above never reaches it. Left there, a released
     build's narration keeps the bubble the upgrade was meant to take away, and a turn this app
     recorded itself gains a second copy of its narration on every restart. */
  for (const [turnId, narration] of importedNarration) {
    if (turns.has(turnId)) continue;
    if (storedNarrationTurns.has(turnId)) {
      for (const part of narration) {
        if (!storedMessages.has(part.id)) omitted.add(part.id);
      }
      continue;
    }
    const answer = storedMessages.get(`${turnId}:assistant`);
    if (answer?.author !== "assistant" || answer.itemType !== "agentMessage" || answer.turnId !== turnId) continue;
    if (narration.some((part) => storedMessages.has(part.id))) continue;
    const text = narration.map((part) => part.text).join("");
    if (!answer.text || answer.text !== text) continue;
    const first = narration[0];
    const last = narration.at(-1);
    if (!first || !last) continue;
    // Keep the ID and what is saved against it, and let the narration stop being an answer.
    replacements.set(first.id, { ...answer, itemType: "commentary", text, status: last.status });
    for (const part of narration.slice(1)) omitted.add(part.id);
  }
  return [
    ...imported.filter((message) => !omitted.has(message.id)).map((message) => replacements.get(message.id) ?? message),
    ...appended,
  ];
}

/**
 * The narration of a turn, which is the text it said between its tool calls.
 *
 * Thinking is commentary too, and has been stored under `${turnId}:reasoning` since long before
 * narration was. Counting it as narration breaks this both ways: the reasoning text joins the
 * comparison that recognises a released turn's combined answer, and a turn that only ever had
 * thinking looks like one whose narration is already stored, so the imported narration is dropped
 * as a repeat and the text is lost.
 */
function isClaudeNarration(message: ConversationMessage): boolean {
  return (
    message.author === "assistant" &&
    message.itemType === "commentary" &&
    Boolean(message.turnId) &&
    !isClaudeReasoning(message)
  );
}

/**
 * An answer of a Claude turn. A quiet routine run keeps its answers as quiet answers, live and on
 * import, so the import must match them too or it stores each one a second time.
 */
function isClaudeAnswer(message: ConversationMessage): boolean {
  return (
    message.author === "assistant" &&
    (message.itemType === "agentMessage" || message.itemType === ROUTINE_QUIET_ANSWER_ITEM_TYPE)
  );
}

/**
 * Whether `text`, the provider's text of a condensed answer, is the original that the answer keeps.
 * The kept original is cut at its limit, so a longer provider text that starts with it matches too.
 */
function repeatsCondensedOriginal(answer: ConversationMessage, text: string): boolean {
  const original = answer.condensed?.original;
  return original !== undefined && original.length > 0 && (text === original || text.startsWith(original));
}

function isClaudeReasoning(message: ConversationMessage): boolean {
  return message.author === "assistant" && message.itemType === "commentary" && message.id.endsWith(":reasoning");
}

/**
 * A notice Claude Code adds to its session as a user message, when a background task ends or a
 * restart finds one that did not. Claude answers it in a turn of its own, but the user did not write it.
 */
export function isClaudeTaskNotification(text: string): boolean {
  return text.startsWith("<task-notification>");
}

/** The SDK drops the transcript's `isCompactSummary` flag, so the summary's fixed opening identifies it. */
export function isClaudeCompactionSummary(text: string): boolean {
  return text.startsWith("This session is being continued from a previous conversation that ran out of context.");
}

/** Claude records a slash command that it runs itself, and the command's output, as user entries in these tags. */
export function isClaudeLocalCommand(text: string): boolean {
  return /^<(?:command-name|local-command-stdout|local-command-stderr)>/.test(text.trimStart());
}

/** Claude records a user interrupt as a user entry with this text. */
export function isClaudeInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user[^\]]*\]$/.test(text.trim());
}

/* Earlier builds imported Claude's notices as user messages. Nobody sent those. The reply that
   followed a compaction summary stays: no stored field proves which live answer it repeats.
   A message sent through the mailbox keeps its delivery. An imported notice has none. */
function isStoredClaudeNotice(message: ConversationMessage): boolean {
  return (
    message.author === "user" &&
    !message.delivery &&
    (isClaudeTaskNotification(message.text) ||
      isClaudeLocalCommand(message.text) ||
      isClaudeInterruptMarker(message.text) ||
      isClaudeCompactionSummary(message.text))
  );
}

function isProviderAssistantMessage(message: ConversationMessage): boolean {
  return message.author === "assistant" && Boolean(message.turnId) && Boolean(message.text || message.imageGeneration);
}

function providerMessageIdentity(message: ConversationMessage): string {
  return JSON.stringify([message.turnId, message.itemType ?? null, message.text, message.imageGeneration ?? null]);
}

export function newAssistantMessage(id: string, turnId: string): ConversationMessage {
  return {
    id,
    turnId,
    author: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    status: "streaming",
    itemType: "agentMessage",
  };
}

export function normalizeCompletionStatus(status: string): ConversationMessage["status"] {
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  return "completed";
}
