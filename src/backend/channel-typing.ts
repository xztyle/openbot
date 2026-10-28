import { CHANNEL_TYPING_LIMIT, CHANNEL_TYPING_TIMEOUT_MS, type ChannelTypingEntry } from "@openbot/contracts/ipc";

/** A repeated typing signal of the same person in the same place inside this time changes nothing. */
const TYPING_REPEAT_MS = 1_000;

export interface ChannelTypingOptions {
  /** Sends the whole list of a channel after it changed. */
  emit(channelId: string, typing: ChannelTypingEntry[]): void;
  /** The agents that run a task of the channel now, with the thread each one answers in. */
  working(channelId: string): readonly { agentId: string; threadRootId: string | null }[];
}

interface PersonTyping {
  memberId: string;
  threadRootId: string | undefined;
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns who types, thinks or works in each channel now, in memory: the people that sent a typing
 * signal in the last `CHANNEL_TYPING_TIMEOUT_MS`, the agents that the answer gate considers, and
 * the agents that run a task. It sends the whole list of a channel when it changes, so every client
 * can show "Ana is typing" and "Atlas is thinking". It reads no store: `ChannelService` gives it the
 * running work and tells it about each gate.
 */
export class ChannelTyping {
  readonly #options: ChannelTypingOptions;
  /** By channel, by `memberId:threadRootId`. */
  readonly #people = new Map<string, Map<string, PersonTyping>>();
  /** By channel, by message: the agents its gate considers now. */
  readonly #gates = new Map<string, Map<string, { agentIds: readonly string[]; threadRootId: string | undefined }>>();
  /** The last list sent for each channel, so an unchanged list is not sent again. */
  readonly #sent = new Map<string, string>();

  constructor(options: ChannelTypingOptions) {
    this.#options = options;
  }

  /** A person types in a channel, or in a thread of it, or stopped. */
  person(channelId: string, memberId: string, threadRootId: string | undefined, typing: boolean): void {
    const people = this.#people.get(channelId) ?? new Map<string, PersonTyping>();
    const key = `${memberId}:${threadRootId ?? ""}`;
    const existing = people.get(key);
    const now = Date.now();
    if (!typing) {
      if (!existing) return;
      clearTimeout(existing.timer);
      people.delete(key);
    } else {
      if (existing && now - existing.at < TYPING_REPEAT_MS) return;
      if (existing) clearTimeout(existing.timer);
      const timer = setTimeout(() => this.person(channelId, memberId, threadRootId, false), CHANNEL_TYPING_TIMEOUT_MS);
      timer.unref?.();
      people.set(key, { memberId, threadRootId, at: now, timer });
    }
    if (people.size) this.#people.set(channelId, people);
    else this.#people.delete(channelId);
    this.changed(channelId);
  }

  /** A person sent a message in the channel: they no longer type there. */
  personSent(channelId: string, memberId: string): void {
    const people = this.#people.get(channelId);
    if (!people) return;
    let removed = false;
    for (const [key, entry] of people)
      if (entry.memberId === memberId) {
        clearTimeout(entry.timer);
        people.delete(key);
        removed = true;
      }
    if (!people.size) this.#people.delete(channelId);
    if (removed) this.changed(channelId);
  }

  gateStarted(channelId: string, messageId: string, agentIds: readonly string[], threadRootId?: string): void {
    const gates = this.#gates.get(channelId) ?? new Map();
    gates.set(messageId, { agentIds, threadRootId });
    this.#gates.set(channelId, gates);
    this.changed(channelId);
  }

  gateSettled(channelId: string, messageId: string): void {
    const gates = this.#gates.get(channelId);
    if (!gates?.delete(messageId)) return;
    if (!gates.size) this.#gates.delete(channelId);
    this.changed(channelId);
  }

  /** The list of a channel now. */
  list(channelId: string): ChannelTypingEntry[] {
    const entries: ChannelTypingEntry[] = [];
    const seen = new Set<string>();
    const add = (entry: ChannelTypingEntry) => {
      const key = `${entry.kind}:${entry.id}:${entry.threadRootId ?? ""}`;
      if (seen.has(key) || entries.length >= CHANNEL_TYPING_LIMIT) return;
      seen.add(key);
      entries.push(entry);
    };
    for (const entry of this.#people.get(channelId)?.values() ?? [])
      add({
        kind: "member",
        id: entry.memberId,
        state: "typing",
        ...(entry.threadRootId ? { threadRootId: entry.threadRootId } : {}),
      });
    // An agent that works and is also considered for a message shows as working.
    for (const work of this.#options.working(channelId))
      add({
        kind: "agent",
        id: work.agentId,
        state: "working",
        ...(work.threadRootId ? { threadRootId: work.threadRootId } : {}),
      });
    const working = new Set(entries.filter((entry) => entry.state === "working").map((entry) => entry.id));
    for (const gate of this.#gates.get(channelId)?.values() ?? [])
      for (const agentId of gate.agentIds)
        if (!working.has(agentId))
          add({
            kind: "agent",
            id: agentId,
            state: "thinking",
            ...(gate.threadRootId ? { threadRootId: gate.threadRootId } : {}),
          });
    return entries;
  }

  /** Sends the list of a channel if it is not the one sent last. */
  changed(channelId: string): void {
    let list: ChannelTypingEntry[];
    try {
      list = this.list(channelId);
    } catch {
      // A channel that was deleted has no running work.
      list = [];
    }
    const key = JSON.stringify(list);
    if ((this.#sent.get(channelId) ?? "[]") === key) return;
    if (list.length) this.#sent.set(channelId, key);
    else this.#sent.delete(channelId);
    this.#options.emit(channelId, list);
  }

  /** Forgets a deleted channel. */
  forget(channelId: string): void {
    for (const entry of this.#people.get(channelId)?.values() ?? []) clearTimeout(entry.timer);
    this.#people.delete(channelId);
    this.#gates.delete(channelId);
    this.#sent.delete(channelId);
  }

  dispose(): void {
    for (const people of this.#people.values()) for (const entry of people.values()) clearTimeout(entry.timer);
    this.#people.clear();
    this.#gates.clear();
    this.#sent.clear();
  }
}
