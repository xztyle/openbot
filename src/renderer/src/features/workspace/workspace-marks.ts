import type {
  AgentEvent,
  TeamRealtimeEvent,
  WorkspacePin,
  WorkspaceReadPosition,
  WorkspaceSavedState,
  WorkspaceThreadState,
} from "@openbot/contracts/ipc";
import { WORKSPACE_THREAD_STATES_LIMIT } from "@openbot/contracts/ipc";
import { createStore, onCleanup } from "solid-js";
import type { ChannelsPort } from "../channels/channels-port";

interface MarksState {
  /** The reader's state in each thread that a view asked about, by channel and root. */
  threads: Record<string, Record<string, WorkspaceThreadState>>;
  /** The messages the reader saved for later, by channel, for the channels a view asked about. */
  saved: Record<string, Record<string, WorkspaceSavedState>>;
  /** The pins of each channel whose Pins tab opened; null while they load. */
  pins: Record<string, WorkspacePin[] | null>;
  /** Threads that the reader marked unread while they look at them: nothing reads them meanwhile. */
  held: Record<string, true>;
}

export interface WorkspaceMarksInput {
  port: () => ChannelsPort;
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
  isReader: (id: string) => boolean;
  /** The reader marked a message of a channel unread: the open channel keeps it unread. */
  onChannelMarkedUnread: (messageId: string, position: WorkspaceReadPosition) => void;
}

const threadKey = (channelId: string, rootId: string) => `${channelId}\n${rootId}`;

/**
 * The reader's own marks on messages, which the host keeps for each member: the read position and
 * the follow of each thread, the saved items, the pins of a channel, and "Mark unread". Each call
 * that the host does not have (an older host) is absent from the port, and its menu item hides.
 */
export function createWorkspaceMarks(input: WorkspaceMarksInput) {
  const [state, setState] = createStore<MarksState>({ threads: {}, saved: {}, pins: {}, held: {} });
  const agent = () => input.port().agent;
  /** Reads in flight or done, so a thread is not read twice through the same reply. */
  const readThrough = new Map<string, number>();

  function storeThreads(channelId: string, threads: readonly WorkspaceThreadState[]) {
    setState((draft) => {
      const known = draft.threads[channelId] ?? {};
      for (const thread of threads) known[thread.rootId] = thread;
      draft.threads[channelId] = known;
    });
  }

  /** Reads the state of these threads of a channel, such as the roots of a loaded page. */
  async function loadThreads(channelId: string, rootIds: readonly string[]): Promise<void> {
    const read = agent().workspaceThreadStates;
    if (!read || rootIds.length === 0) return;
    for (let start = 0; start < rootIds.length; start += WORKSPACE_THREAD_STATES_LIMIT) {
      try {
        const answer = await read({
          channelId,
          rootIds: rootIds.slice(start, start + WORKSPACE_THREAD_STATES_LIMIT),
        });
        storeThreads(channelId, answer.threads);
      } catch {
        // An older host or a channel the reader cannot see: the threads show no unread mark.
        return;
      }
    }
  }

  function thread(channelId: string, rootId: string): WorkspaceThreadState | undefined {
    return state.threads[channelId]?.[rootId];
  }

  /** The reader read the thread through this sequence. The position only moves forward. */
  function readThread(channelId: string, rootId: string, throughSequence: number) {
    const read = agent().workspaceReadThread;
    const key = threadKey(channelId, rootId);
    if (!read || state.held[key]) return;
    const known = thread(channelId, rootId);
    if (known && throughSequence <= known.throughSequence && known.unreadCount === 0) return;
    if (throughSequence <= (readThrough.get(key) ?? 0)) return;
    readThrough.set(key, throughSequence);
    void read({ operationId: crypto.randomUUID(), channelId, threadRootId: rootId, throughSequence }).then(
      (answer) => storeThreads(channelId, [answer]),
      () => readThrough.delete(key),
    );
  }

  async function setFollowed(channelId: string, rootId: string, followed: boolean): Promise<void> {
    const follow = agent().workspaceFollowThread;
    if (!follow) return;
    const answer = await follow({ operationId: crypto.randomUUID(), channelId, threadRootId: rootId, followed });
    storeThreads(channelId, [answer]);
  }

  /** "Mark unread": the reader's position moves to just before the message, in the channel or the thread. */
  async function markUnread(channelId: string, messageId: string, threadRootId: string | null): Promise<void> {
    const mark = agent().workspaceMarkUnread;
    if (!mark) return;
    const position = await mark({
      operationId: crypto.randomUUID(),
      channelId,
      messageId,
      ...(threadRootId ? { threadRootId } : {}),
    });
    if (threadRootId) {
      const key = threadKey(channelId, threadRootId);
      setState((draft) => {
        draft.held[key] = true;
      });
      readThrough.delete(key);
      const known = thread(channelId, threadRootId);
      storeThreads(channelId, [
        {
          channelId,
          rootId: threadRootId,
          followed: known?.followed ?? true,
          throughSequence: position.throughSequence,
          unreadCount: position.unreadCount,
        },
      ]);
      return;
    }
    input.onChannelMarkedUnread(messageId, position);
  }

  /** The thread panel closed: a thread that the reader marked unread may be read again. */
  function releaseThread(channelId: string, rootId: string) {
    setState((draft) => {
      delete draft.held[threadKey(channelId, rootId)];
    });
  }

  /** Whether the reader marked the thread unread while it is open. */
  function heldThread(channelId: string, rootId: string): boolean {
    return state.held[threadKey(channelId, rootId)] === true;
  }

  /** Reads which messages of a channel the reader saved. */
  async function loadSaved(channelId: string): Promise<void> {
    const read = agent().workspaceSaved;
    if (!read) return;
    try {
      const page = await read({ channelId, limit: 100 });
      setState((draft) => {
        draft.saved[channelId] = Object.fromEntries(page.items.map((item) => [item.messageId, item.state]));
      });
    } catch {
      // An older host: no saved marks.
    }
  }

  function saved(channelId: string, messageId: string): WorkspaceSavedState | undefined {
    return state.saved[channelId]?.[messageId];
  }

  async function setSaved(channelId: string, messageId: string, on: boolean): Promise<void> {
    const write = agent().workspaceSetSaved;
    if (!write) return;
    const answer = await write({
      operationId: crypto.randomUUID(),
      channelId,
      messageId,
      state: on ? "saved" : null,
    });
    setState((draft) => {
      const known = draft.saved[channelId] ?? {};
      if (answer.item) known[messageId] = answer.item.state;
      else delete known[messageId];
      draft.saved[channelId] = known;
    });
  }

  async function loadPins(channelId: string): Promise<void> {
    const read = agent().workspacePins;
    if (!read) return;
    if (!(channelId in state.pins))
      setState((draft) => {
        draft.pins[channelId] = null;
      });
    try {
      const answer = await read({ channelId });
      setState((draft) => {
        draft.pins[channelId] = answer.pins;
      });
    } catch {
      setState((draft) => {
        draft.pins[channelId] = [];
      });
    }
  }

  async function setPinned(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    const write = agent().workspaceSetPinned;
    if (!write) return;
    const answer = await write({ operationId: crypto.randomUUID(), channelId, messageId, pinned });
    setState((draft) => {
      draft.pins[channelId] = answer.pins;
    });
  }

  // Another session of the reader read or followed a thread, or saved a message: read them again.
  let pinsTimer: ReturnType<typeof setTimeout> | undefined;
  const pinsToRead = new Set<string>();
  const unsubscribe = input.onHostEvent((event) => {
    if (event.type === "workspace-read-state-changed") {
      if (event.memberId && !input.isReader(event.memberId)) return;
      if (event.threadRootId && state.threads[event.channelId]) void loadThreads(event.channelId, [event.threadRootId]);
      return;
    }
    if (event.type === "workspace-saved-changed") {
      if (event.memberId && !input.isReader(event.memberId)) return;
      for (const channelId of Object.keys(state.saved)) void loadSaved(channelId);
      return;
    }
    // A pin rides on the message: the open Pins tab reads the list again.
    if (event.type === "channel-message" && event.channelId in state.pins) {
      pinsToRead.add(event.channelId);
      clearTimeout(pinsTimer);
      pinsTimer = setTimeout(() => {
        for (const channelId of pinsToRead) void loadPins(channelId);
        pinsToRead.clear();
      }, 400);
    }
  });
  onCleanup(() => {
    unsubscribe();
    clearTimeout(pinsTimer);
  });

  return {
    supports: {
      threads: () => Boolean(agent().workspaceThreadStates),
      follow: () => Boolean(agent().workspaceFollowThread),
      markUnread: () => Boolean(agent().workspaceMarkUnread),
      saved: () => Boolean(agent().workspaceSetSaved),
      pins: () => Boolean(agent().workspaceSetPinned),
    },
    loadThreads,
    thread,
    readThread,
    setFollowed,
    markUnread,
    releaseThread,
    heldThread,
    loadSaved,
    saved,
    setSaved,
    loadPins,
    pins: (channelId: string): WorkspacePin[] | null | undefined => state.pins[channelId],
    setPinned,
  };
}

export type WorkspaceMarks = ReturnType<typeof createWorkspaceMarks>;
