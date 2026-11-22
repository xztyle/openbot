/*
 * The messages the reader sent that the host has not taken yet. Send never waits for the connection:
 * the message goes here, shows under the conversation as sending, and leaves for the host in the
 * order it was written as soon as the connection is up. A page that reloads or a phone that drops
 * its connection keeps them, as this computer stores them per reader and server.
 *
 * Each message keeps the operation id it got when the reader sent it, so a send whose answer was
 * lost and that goes again is stored once: the host answers the second one with the first receipt.
 */
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createSignal } from "solid-js";

const OUTBOX_KEY = "openbot.workspace.outbox.v1";
/** Older messages than this many go: a box that never reconnects must not fill the disk. */
const OUTBOX_LIMIT = 100;

export interface OutboxMessage {
  /** The operation id of the send, the same for every attempt. */
  id: string;
  /** The draft key of the conversation or the thread. */
  key: string;
  channelId: string;
  threadRootId: string | null;
  text: string;
  attachmentDraftIds: string[];
  alsoToChannel: boolean;
  createdAt: number;
  /** `waiting` for the connection, `sending` to the host, `failed` with the host's answer. */
  state: "waiting" | "sending" | "failed";
  error?: string | undefined;
}

export type OutboxInput = Omit<OutboxMessage, "id" | "state" | "createdAt" | "error"> & { id?: string };

export interface OutboxOptions {
  storageKey: () => string;
  /** The connection is up and the workspace loaded. */
  ready: () => boolean;
  /** Sends one message with its operation id. Throws when the host did not take it. */
  deliver: (message: OutboxMessage) => Promise<void>;
  /** What a failure says to the reader. */
  describe: (error: unknown) => string;
  now?: () => number;
}

function isOutboxMessage(value: unknown): value is OutboxMessage {
  return (
    isDynamicRecord(value) &&
    typeof value.id === "string" &&
    typeof value.key === "string" &&
    typeof value.channelId === "string" &&
    (value.threadRootId === null || typeof value.threadRootId === "string") &&
    typeof value.text === "string" &&
    Array.isArray(value.attachmentDraftIds) &&
    value.attachmentDraftIds.every((id) => typeof id === "string") &&
    typeof value.alsoToChannel === "boolean" &&
    typeof value.createdAt === "number"
  );
}

export function readOutbox(storageKey: string): OutboxMessage[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${OUTBOX_KEY}:${storageKey}`) ?? "[]");
    if (!Array.isArray(value)) return [];
    // A message that was on its way when the page closed may not have reached the host: it goes
    // again with its operation id, so the host keeps one copy.
    return value
      .filter(isOutboxMessage)
      .map((message) => ({ ...message, state: message.state === "failed" ? "failed" : "waiting" }));
  } catch {
    return [];
  }
}

/**
 * False when this computer could not store them. `known` holds every message this tab has had: a
 * stored one that it does not know is another tab's, which has not sent it yet, so it stays.
 */
function writeOutbox(storageKey: string, messages: readonly OutboxMessage[], known: ReadonlySet<string>): boolean {
  try {
    const key = `${OUTBOX_KEY}:${storageKey}`;
    const others = readOutbox(storageKey).filter((message) => !known.has(message.id));
    if (others.length) messages = [...messages, ...others].sort((left, right) => left.createdAt - right.createdAt);
    if (messages.length === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(messages.slice(-OUTBOX_LIMIT)));
    return true;
  } catch {
    // A private window or a full disk keeps the messages in memory only.
    return false;
  }
}

export function createWorkspaceOutbox(options: OutboxOptions) {
  const now = options.now ?? Date.now;
  let storageKey = options.storageKey();
  /*
   * The list itself. The signal shows it to the page; it is not read back here, because a signal
   * written in Solid 2 gives its new value only after the next flush.
   */
  let list: readonly OutboxMessage[] = readOutbox(storageKey);
  /** Every message this tab has had for this storage key, sent ones too. */
  let known = new Set(list.map((message) => message.id));
  // Written from the composer's handlers and the connection's effects alike.
  const [messages, setMessages] = createSignal<readonly OutboxMessage[]>(list, { ownedWrite: true });
  let flushing = false;
  let disposed = false;
  /** Whether the stored copy is current, so another tab's sends can be read from it. */
  let stored = true;

  const show = (next: readonly OutboxMessage[]) => {
    list = next;
    for (const message of next) known.add(message.id);
    setMessages(next);
  };
  const save = (next: readonly OutboxMessage[]) => {
    show(next);
    stored = writeOutbox(storageKey, next, known);
  };
  const update = (id: string, patch: Partial<OutboxMessage>) =>
    save(list.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  const remove = (id: string) => save(list.filter((message) => message.id !== id));

  /** The next message that may go: the oldest waiting one of a conversation with no failed one before it. */
  function next(): OutboxMessage | undefined {
    const blocked = new Set<string>();
    for (const message of list) {
      if (message.state === "failed") blocked.add(message.key);
      else if (!blocked.has(message.key)) return message;
    }
    return undefined;
  }

  async function flush(): Promise<void> {
    if (flushing || disposed) return;
    flushing = true;
    try {
      for (;;) {
        if (disposed || !options.ready()) return;
        const message = next();
        if (!message) return;
        // Another tab of this reader may have sent it already.
        if (stored && !readOutbox(storageKey).some((item) => item.id === message.id)) {
          show(list.filter((item) => item.id !== message.id));
          continue;
        }
        const key = storageKey;
        update(message.id, { state: "sending", error: undefined });
        try {
          await options.deliver({ ...message, state: "sending" });
          if (key === storageKey) remove(message.id);
        } catch (error) {
          if (key !== storageKey) return;
          // A send that failed because the connection went waits for it; any other failure asks the reader.
          if (!options.ready()) {
            update(message.id, { state: "waiting" });
            return;
          }
          update(message.id, { state: "failed", error: options.describe(error) });
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    /** The messages of one conversation or thread, oldest first. */
    of: (key: string) => messages().filter((message) => message.key === key),
    all: messages,
    /** Takes a message and sends it as soon as the connection allows. */
    add(input: OutboxInput): OutboxMessage {
      const { id, ...rest } = input;
      const message: OutboxMessage = { ...rest, id: id ?? crypto.randomUUID(), createdAt: now(), state: "waiting" };
      save([...list, message]);
      void flush();
      return message;
    },
    retry(id: string) {
      update(id, { state: "waiting", error: undefined });
      void flush();
    },
    discard: remove,
    /**
     * The connection is up again. A failure that came with a lost connection may not be the
     * message's own, so the failed ones go again too, still with their operation ids.
     */
    connected() {
      if (list.some((message) => message.state === "failed"))
        save(list.map((message) => (message.state === "failed" ? { ...message, state: "waiting" } : message)));
      void flush();
    },
    /** The reader or the server changed: their own messages show and wait. */
    reload() {
      storageKey = options.storageKey();
      known = new Set();
      show(readOutbox(storageKey));
      void flush();
    },
    flush,
    dispose() {
      disposed = true;
    },
  };
}

export type WorkspaceOutbox = ReturnType<typeof createWorkspaceOutbox>;
