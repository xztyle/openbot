import type { ChannelMessage, ChannelTask, ConversationMessage } from "@openbot/contracts/ipc";
import { scanForSecrets } from "@openbot/contracts/secret-hygiene";
import { maskRegisteredSecrets } from "@openbot/logging";

/*
 * The last stop before a channel message is stored. The composers hide a pasted key before it
 * leaves, but text also comes from a Discord bridge, an access link, an edit from an older client
 * and an agent that read a saved key and wrote it back. Whatever is stored is read again by the
 * agents, the search, the previews, the push text and the bridge to Discord, so a key is hidden
 * here once, before any of them reads it.
 */

/** The marker of the English composer, so a message reads the same whichever side hid the key. */
const marker = (label: string) => `[hidden: ${label}]`;
const SAVED_SECRET = marker("saved secret");

/**
 * `text` without the keys and passwords in it. Text that a person wrote gets every rule of the
 * composer. Text that an agent wrote keeps the labeled rule out: its code says `password = …`.
 * Either way a value saved in Secrets goes by its exact text.
 */
export function hideChannelSecrets(text: string, writer: "person" | "agent"): string {
  if (!text) return text;
  const masked = maskRegisteredSecrets(text, SAVED_SECRET);
  return scanForSecrets(masked, (secret) => marker(secret.label), { labeled: writer === "person" }).text;
}

export function writerOf(message: ChannelMessage): "person" | "agent" {
  return message.author.kind === "member" || message.externalAuthor ? "person" : "agent";
}

/** The text and the condensed original of one message without secrets. The same object when none. */
function conversationWithoutSecrets(message: ConversationMessage, writer: "person" | "agent"): ConversationMessage {
  const text = hideChannelSecrets(message.text, writer);
  const original = message.condensed ? hideChannelSecrets(message.condensed.original, writer) : undefined;
  if (text === message.text && original === message.condensed?.original) return message;
  return { ...message, text, ...(message.condensed && original !== undefined ? { condensed: { original } } : {}) };
}

/** The message with its text, its condensed original and its line for the people without secrets. */
export function channelMessageWithoutSecrets(message: ChannelMessage): ChannelMessage {
  const writer = writerOf(message);
  const inner = conversationWithoutSecrets(message.message, writer);
  const original = message.condensed ? hideChannelSecrets(message.condensed.original, writer) : undefined;
  const summary = message.agentNote ? hideChannelSecrets(message.agentNote.summary, writer) : undefined;
  if (inner === message.message && original === message.condensed?.original && summary === message.agentNote?.summary)
    return message;
  return {
    ...message,
    message: inner,
    ...(message.condensed && original !== undefined ? { condensed: { original } } : {}),
    ...(message.agentNote && summary !== undefined ? { agentNote: { ...message.agentNote, summary } } : {}),
  };
}

/**
 * A task's instruction is the text of the message that asked for it, which the agent reads. The
 * writer is that message's: a person's request loses what its message lost.
 */
export function channelTaskWithoutSecrets(task: ChannelTask, writer: "person" | "agent"): ChannelTask {
  const instruction = hideChannelSecrets(task.instruction, writer);
  const expectedResult = hideChannelSecrets(task.expectedResult, writer);
  return instruction === task.instruction && expectedResult === task.expectedResult
    ? task
    : { ...task, instruction, expectedResult };
}

/**
 * An agent's thread message with its text as the channel stores it, for a caller that compares the
 * two. The same object when nothing is hidden.
 */
export function storedAgentText(message: ConversationMessage): ConversationMessage {
  return conversationWithoutSecrets(message, "agent");
}
