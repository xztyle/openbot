/*
 * Later, as Slack's: the messages the reader saved, in progress and completed. The host keeps them
 * per member (`workspaceSaved`); the view and the sidebar badge read them from here, and every
 * session of the reader reads them again when the host says they changed.
 */

import type { AgentEvent, TeamRealtimeEvent, WorkspaceSavedItem, WorkspaceSavedState } from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore, onCleanup } from "solid-js";
import type { ChannelsController } from "../channels/channels-controller";

const PAGE_SIZE = 50;

interface LaterList {
  items: WorkspaceSavedItem[];
  total: number;
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  failed: boolean;
}

function emptyList(): LaterList {
  return { items: [], total: 0, nextCursor: null, loaded: false, loading: false, loadingMore: false, failed: false };
}

interface LaterState {
  /** False when the host has no saved items: the view and the row stay hidden. */
  supported: boolean;
  saved: LaterList;
  done: LaterList;
}

export interface WorkspaceLaterDeps {
  channels: ChannelsController;
  ready: () => boolean;
  storageKey: () => string;
  isReader: (id: string) => boolean;
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
}

export function createWorkspaceLater(deps: WorkspaceLaterDeps) {
  const [state, setState] = createStore<LaterState>({ supported: true, saved: emptyList(), done: emptyList() });
  const runs: Record<WorkspaceSavedState, number> = { saved: 0, done: 0 };

  async function load(kind: WorkspaceSavedState, more = false): Promise<void> {
    const read = deps.channels.port().agent.workspaceSaved;
    if (!read || !deps.ready()) return;
    const list = state[kind];
    if (more && (!list.nextCursor || list.loadingMore)) return;
    const run = more ? runs[kind] : ++runs[kind];
    setState((draft) => {
      if (more) draft[kind].loadingMore = true;
      else draft[kind].loading = true;
    });
    try {
      const page = await read({
        state: kind,
        limit: PAGE_SIZE,
        ...(more && list.nextCursor ? { cursor: list.nextCursor } : {}),
      });
      if (run !== runs[kind]) return;
      setState((draft) => {
        const target = draft[kind];
        if (more) {
          const known = new Set(target.items.map((item) => item.messageId));
          target.items.push(...page.items.filter((item) => !known.has(item.messageId)));
        } else target.items = page.items;
        target.total = page.total;
        target.nextCursor = page.nextCursor;
        target.loaded = true;
        target.loading = false;
        target.loadingMore = false;
        target.failed = false;
        draft.supported = true;
      });
    } catch {
      if (run !== runs[kind]) return;
      setState((draft) => {
        const target = draft[kind];
        target.loading = false;
        target.loadingMore = false;
        // A host without the route has no Later: the first read of the open list says so.
        if (!target.loaded && kind === "saved" && !more) draft.supported = false;
        else target.failed = true;
      });
    }
  }

  /** Reads both lists again, keeping the rows on screen until the answer. */
  function refresh() {
    void load("saved");
    if (state.done.loaded) void load("done");
  }

  // The lists follow the reader and the server.
  createEffect(
    () => (deps.ready() ? deps.storageKey() : null),
    (key) => {
      setState((draft) => {
        draft.supported = true;
        draft.saved = emptyList();
        draft.done = emptyList();
      });
      if (key) void load("saved");
    },
  );
  const unsubscribe = deps.onHostEvent((event) => {
    if (event.type === "workspace-saved-changed" && (!event.memberId || deps.isReader(event.memberId))) refresh();
  });
  onCleanup(unsubscribe);

  /** Saves a message, moves it between the lists, or takes it out (`null`). A failure throws. */
  async function set(channelId: string, messageId: string, next: WorkspaceSavedState | null): Promise<void> {
    const write = deps.channels.port().agent.workspaceSetSaved;
    if (!write) return;
    // The row moves at once; the host's answer and its event read the lists again.
    const before = { saved: [...state.saved.items], done: [...state.done.items] };
    const item = [...before.saved, ...before.done].find(
      (entry) => entry.channelId === channelId && entry.messageId === messageId,
    );
    setState((draft) => {
      for (const kind of ["saved", "done"] as const) {
        const index = draft[kind].items.findIndex(
          (entry) => entry.channelId === channelId && entry.messageId === messageId,
        );
        if (index >= 0) {
          draft[kind].items.splice(index, 1);
          draft[kind].total = Math.max(0, draft[kind].total - 1);
        }
      }
      if (item && next) {
        draft[next].items.unshift({ ...item, state: next });
        draft[next].total += 1;
      }
    });
    try {
      await write({ operationId: crypto.randomUUID(), channelId, messageId, state: next });
    } catch (error) {
      setState((draft) => {
        draft.saved.items = before.saved;
        draft.done.items = before.done;
      });
      const text = currentText();
      throw new Error(text.errorMessage(error, text.t("workspace.later.failed")));
    } finally {
      refresh();
    }
  }

  return {
    state,
    supported: () => state.supported && Boolean(deps.channels.port().agent.workspaceSaved),
    /** The saved items that are not completed: the badge of the Later row. */
    count: () => state.saved.total,
    load,
    refresh,
    set,
  };
}

export type WorkspaceLater = ReturnType<typeof createWorkspaceLater>;
