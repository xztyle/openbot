import {
  type ChannelCommand,
  type ChannelMessage,
  type ChannelPage,
  type ChannelSummary,
  isChannelThreadReply,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { AgentProfile } from "@openbot/ui/data";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore, flush, onSettled, reconcile, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { type DesktopAnalyticsProperties, desktopAnalytics } from "../../analytics";
import { mergeChannelPage } from "./channel-page-merge";

/**
 * Takes the older edge of a page: its cursor, and the unloaded length that belongs to that cursor. A
 * page with no length removes the old one, so the scroll rail never draws a length for another window.
 */
function takeOlderWindow(target: ChannelPage, source: ChannelPage): void {
  target.olderCursor = source.olderCursor;
  if (source.olderCount === undefined) delete target.olderCount;
  else target.olderCount = source.olderCount;
  if (source.oldestAt === undefined) delete target.oldestAt;
  else target.oldestAt = source.oldestAt;
}

import type { ChannelsPort } from "./channels-port";

/**
 * What was unread when the reader opened a channel. The read pointer moves as the channel is read
 * while it is in front, so the live count is zero a moment after the first page arrives. The
 * divider follows this record instead, until the reader leaves the channel, jumps to the latest
 * message, or marks the channel read.
 */
export interface HeldUnread {
  channelId: string;
  /** The unread count of the channel summary at the time the first page arrived. */
  count: number;
  /** The newest sequence of that first page. Messages after it arrived while the reader was here. */
  throughSequence: number;
}

interface ChannelsState {
  channels: ChannelSummary[];
  selectedId: string | null;
  page: ChannelPage | null;
  /** Null when nothing was unread at the opening, or after the reader released it. */
  unread: HeldUnread | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  /** The code of the failure in `error`. It shows only while `error` is set. */
  errorReference: string | null;
  editing: "create" | "settings" | null;
  archived: boolean;
  collapsed: boolean;
}

/**
 * What the channels domain needs from the app around it. The desktop builds it from its contexts;
 * the browser client builds it from its host connection. The domain itself is the same code.
 */
export interface ChannelsEnvironment {
  /** Read on each call, so a test can replace the runtime per case. */
  port: () => ChannelsPort;
  agents: () => AgentProfile[];
  /** Who reads. A change drops the list, the selection, and every command still pending. */
  scopeKey: () => string;
  /** The channel this reader had open, if they are known and had one. */
  readSelection: (scope: string) => string | null;
  writeSelection: (channelId: string | null) => void;
  supported: () => boolean;
  /** Whether this reader may delete a channel; `supported()` is checked as well. */
  deletionSupported: () => boolean;
  /** Clears whatever else covers the workspace, because a channel is about to cover it. */
  beforeOpen: () => void;
  /** Whether a message that arrives now is in front of the reader. */
  canMarkRead: () => boolean;
  /** Each channel list that the reader of `scope` gets, before the read marks the open channel read. */
  onList?: (channels: ChannelSummary[], scope: string) => void;
}

export type ChannelsController = ReturnType<typeof createChannelsController>;

/** The localized and redacted sentence for a failure, and its code. */
function failure(error: unknown, fallback: AppTextKey): Pick<ChannelsState, "error" | "errorReference"> {
  const details = currentText().errorDetails(error, currentText().t(fallback));
  return { error: details.message, errorReference: details.reference };
}

type ChannelAction = DesktopAnalyticsProperties<"channel_action">["action"];

/** The tracked action of a command, or `null` for one that is not tracked, such as a settings edit. */
function channelAction(input: ChannelCommand, creating: boolean, page: ChannelPage | null): ChannelAction | null {
  if (input.type === "archive") return "archived";
  if (input.type !== "save") return null;
  if (creating) return "created";
  if (page?.channel.id !== input.channelId) return null;
  const members = new Set(page.channel.members.map((member) => member.agentId));
  return input.draft.members.some((member) => !members.has(member.agentId)) ? "member_added" : null;
}

export function createChannelsController(env: ChannelsEnvironment) {
  const [state, setState] = createStore<ChannelsState>({
    channels: [],
    selectedId: null,
    page: null,
    unread: null,
    loading: false,
    pending: false,
    error: null,
    errorReference: null,
    editing: null,
    archived: false,
    collapsed: false,
  });
  let disposed = false;
  let pendingCommands = 0;
  let refreshId = 0;
  let failedCommand: ChannelCommand | null = null;
  const readThrough = new Map<string, number>();
  /**
   * The newest revision of each channel whose messages this controller applied from the live
   * `channel-message` events. The host sends them before `channels-changed` with the same revision,
   * so a change that the events already carried needs only the list, not the page.
   */
  const liveRevisions = new Map<string, number>();
  /** The channel whose unread part was kept for this opening, so a refresh does not keep it again. */
  let unreadKeptFor: string | null = null;

  const supported = env.supported;
  /**
   * One read at a time, and at most one more behind it.
   *
   * A channel publishes on every streamed chunk, and a read is two calls: a read for each event,
   * of which only the newest may write, threw away every answer while a member was writing. The
   * transcript then stood still until the turn ended, and an opening channel stayed on Loading.
   * Waiting for the newest answer instead of the newest request keeps the reads bounded and each
   * one lands.
   */
  let reading: Promise<void> | null = null;
  let readAgain = false;
  let readToken = 0;
  let laterRead: Promise<void> | null = null;
  let settleLaterRead: (() => void) | null = null;
  function refresh(selectedOverride?: string | null, listOnly = false): Promise<void> {
    // Navigation carries the selection it wants, so it never waits behind the read it replaces.
    if (reading && selectedOverride === undefined) {
      readAgain = true;
      return reading;
    }
    const token = ++readToken;
    const run = read(selectedOverride, listOnly).finally(() => {
      if (token !== readToken) return;
      reading = null;
      const settle = settleLaterRead;
      laterRead = null;
      settleLaterRead = null;
      if (readAgain && !disposed) {
        readAgain = false;
        void refresh().finally(() => settle?.());
      } else settle?.();
    });
    reading = run;
    return run;
  }
  /**
   * A read that starts after this call.
   *
   * The read in flight started before the write, so its answer can hold the state the write
   * replaced. A settings panel that saves each field builds the next save from the page it holds,
   * and two removals in a row put the first member back.
   */
  function refreshAfter(): Promise<void> {
    if (!reading) return refresh();
    readAgain = true;
    laterRead ??= new Promise<void>((resolve) => {
      settleLaterRead = resolve;
    });
    return laterRead;
  }
  async function read(selectedOverride?: string | null, listOnly = false) {
    if (!supported()) return;
    const id = ++refreshId;
    const account = env.scopeKey();
    const selected = selectedOverride === undefined ? state.selectedId : selectedOverride;
    try {
      const channels = await env.port().agent.listChannels();
      const selectedExists = selected !== null && channels.some((channel) => channel.id === selected);
      // A list-only read keeps the page that the live events keep current.
      const keepPage = listOnly && selectedExists && state.page?.channel.id === selected;
      const page = keepPage
        ? state.page
        : selectedExists
          ? await env.port().agent.readChannel({ channelId: selected })
          : null;
      if (disposed || account !== env.scopeKey() || id !== refreshId || selected !== state.selectedId) return;
      env.onList?.(channels, account);
      setState((state) => {
        // Keep each summary object, so the sidebar, which keys its rows by object, does not remount
        // every channel row (and close an open menu) on each refresh.
        reconcile(channels, "id")(state.channels);
        if (selected && !selectedExists) {
          state.selectedId = null;
          state.editing = null;
          state.unread = null;
          unreadKeptFor = null;
          readThrough.delete(selected);
          if (failedCommand?.channelId === selected) failedCommand = null;
        }
        if (keepPage) {
          // The page in the store is current; only the channel record can be newer.
          const summary = channels.find((channel) => channel.id === selected);
          if (summary && state.page && summary.revision > state.page.channel.revision) {
            const {
              unreadCount: _unread,
              activeTasks: _active,
              openTasks: _open,
              lastMessage: _last,
              threads: _threads,
              ...channel
            } = summary;
            state.page.channel = channel;
          }
        } else if (page && state.page?.channel.id === page.channel.id) {
          const merged = mergeChannelPage(state.page.messages, page.messages);
          reconcile(merged.messages, "id")(state.page.messages);
          reconcile(page.tasks, "id")(state.page.tasks);
          Object.assign(state.page, { channel: page.channel, throughSequence: page.throughSequence });
          if (merged.takeFetchedCursor) takeOlderWindow(state.page, page);
        } else state.page = page;
        // The first page of an opening holds the unread part; every later read has already marked
        // the channel read, so only this one can say where it started.
        if (page && selected && unreadKeptFor !== selected) {
          unreadKeptFor = selected;
          const count = channels.find((channel) => channel.id === selected)?.unreadCount ?? 0;
          state.unread = count > 0 ? { channelId: selected, count, throughSequence: page.throughSequence } : null;
        }
        state.loading = false;
        if (!failedCommand) state.error = null;
      });
      if (selected && !selectedExists) env.writeSelection(null);
      if (selected && page && env.canMarkRead() && page.throughSequence > (readThrough.get(selected) ?? 0)) {
        readThrough.set(selected, page.throughSequence);
        try {
          await env.port().agent.channelCommand({
            type: "read",
            channelId: selected,
            throughSequence: page.throughSequence,
            operationId: crypto.randomUUID(),
          });
        } catch (error) {
          readThrough.delete(selected);
          throw error;
        }
      }
    } catch (error) {
      if (!disposed && account === env.scopeKey() && id === refreshId)
        setState((state) => {
          Object.assign(state, {
            ...failure(error, "channel.error.load"),
            loading: false,
          });
        });
    }
  }
  async function open(channelId: string) {
    // A saved selection, a search result or a notification can name a channel on a server that has
    // no channels.
    if (!supported()) return;
    env.beforeOpen();
    env.writeSelection(channelId);
    unreadKeptFor = null;
    flush(() =>
      setState((state) => {
        Object.assign(state, { selectedId: channelId, page: null, unread: null, editing: null, loading: true });
      }),
    );
    await refreshAfter();
  }
  async function perform(action: () => Promise<void>): Promise<boolean> {
    const account = env.scopeKey();
    try {
      await action();
      if (!disposed && account === env.scopeKey()) await refreshAfter();
      return !disposed && account === env.scopeKey();
    } catch (error) {
      if (!disposed && account === env.scopeKey())
        setState((state) => {
          Object.assign(state, failure(error, "channel.error.action"));
        });
      return false;
    }
  }
  /**
   * `onAccepted` runs after the service accepts the command and the channel refreshes. When the
   * reader leaves the scope during the request, it runs at once and the result is `false`: a sent
   * message must still leave the composer, or it comes back as a draft.
   */
  async function command(input: ChannelCommand, onAccepted?: (accepted: ChannelCommand) => void): Promise<boolean> {
    const account = env.scopeKey();
    // Only the save that creates a channel opens it, and only while the reader has stayed where
    // the save started. The sidebar takes a click through a save of the settings, and settings
    // save on every field, so a save that selected its own channel on arrival would pull the
    // reader back out of the channel they opened and drop the draft they began there.
    const creating = input.type === "save" && state.editing === "create";
    const selectedBefore = state.selectedId;
    const action = channelAction(input, creating, state.page);
    let accepted = false;
    // A `save` is never dropped: settings commit each field as it is left, and a silently
    // discarded autosave is lost work. The service serializes saves per channel and every
    // command is idempotent on its `operationId`, so letting them queue is safe.
    if (
      state.pending &&
      input.type !== "stop" &&
      input.type !== "archive" &&
      input.type !== "restore" &&
      input.type !== "save"
    )
      return false;
    pendingCommands += 1;
    const attempt =
      failedCommand &&
      JSON.stringify({ ...failedCommand, operationId: null }) === JSON.stringify({ ...input, operationId: null })
        ? failedCommand
        : input;
    flush(() =>
      setState((state) => {
        Object.assign(state, { pending: true, error: null });
      }),
    );
    try {
      await env.port().agent.channelCommand(attempt);
      accepted = true;
      if (action) desktopAnalytics.track("channel_action", { action, result: "succeeded" });
      if (disposed || account !== env.scopeKey()) {
        onAccepted?.(attempt);
        return false;
      }
      failedCommand = null;
      // Only creation closes the editor. Settings save on every field, so closing on a save
      // would shut the panel under the user between two edits.
      if (creating && state.selectedId === selectedBefore) {
        env.beforeOpen();
        env.writeSelection(input.channelId);
        flush(() =>
          setState((state) => {
            state.selectedId = input.channelId;
            if (state.editing === "create") state.editing = null;
          }),
        );
      }
      await refreshAfter();
      onAccepted?.(attempt);
      return true;
    } catch (error) {
      // A refresh that fails after the service accepted the command is not a failed action.
      if (action && !accepted) desktopAnalytics.track("channel_action", { action, result: "failed" });
      if (!disposed && account === env.scopeKey()) {
        failedCommand = attempt;
        setState((state) => {
          Object.assign(state, failure(error, "channel.error.update"));
        });
      }
      return false;
    } finally {
      if (!disposed && account === env.scopeKey())
        setState((state) => {
          pendingCommands -= 1;
          state.pending = pendingCommands > 0;
        });
    }
  }
  /**
   * Sends a message and gives back a page that holds it. Unlike `command`, a failure throws and
   * leaves the channel error alone: the conversation shows the message as not sent, with its own
   * Retry, and the retry sends the same `operationId` again.
   */
  async function send(input: Extract<ChannelCommand, { type: "send" }>): Promise<ChannelPage> {
    const account = env.scopeKey();
    // The host that stored the message gives the page, also when the reader changes scope meanwhile.
    const port = env.port();
    const before = state.page?.channel.id === input.channelId ? state.page.throughSequence : null;
    await port.agent.channelCommand(input);
    if (disposed || account !== env.scopeKey()) return port.agent.readChannel({ channelId: input.channelId });
    await refreshAfter();
    // A refresh that fails keeps the earlier page, which does not hold the message.
    const page = state.page;
    return page?.channel.id === input.channelId && (before === null || page.throughSequence > before)
      ? page
      : port.agent.readChannel({ channelId: input.channelId });
  }
  async function loadOlder() {
    const channelId = state.selectedId;
    const beforeSequence = state.page?.olderCursor;
    const account = env.scopeKey();
    if (!channelId || !beforeSequence) return;
    try {
      const older = await env.port().agent.readChannel({ channelId, beforeSequence });
      if (!disposed && account === env.scopeKey() && state.selectedId === channelId)
        setState((state) => {
          const page = state.page;
          if (!page || page.olderCursor !== beforeSequence) return;
          const ids = new Set(page.messages.map((item) => item.id));
          // The older page goes in front. A diff of the whole transcript would compare every
          // loaded message again, and a long channel grows by a page each time.
          const fresh = older.messages.filter((item) => !ids.has(item.id));
          if (fresh.length) page.messages.unshift(...fresh);
          takeOlderWindow(page, older);
        });
    } catch (error) {
      if (!disposed && account === env.scopeKey() && state.selectedId === channelId)
        setState((state) => {
          Object.assign(state, failure(error, "channel.error.loadOlder"));
        });
    }
  }
  createEffect(
    () => ({ scope: env.scopeKey(), supported: supported() }),
    (next, previous) => {
      if (next.scope !== previous?.scope) {
        const selected = next.supported ? env.readSelection(next.scope) : null;
        refreshId += 1;
        readThrough.clear();
        liveRevisions.clear();
        unreadKeptFor = null;
        failedCommand = null;
        pendingCommands = 0;
        flush(() =>
          setState((state) => {
            Object.assign(state, {
              channels: [],
              selectedId: selected,
              page: null,
              unread: null,
              pending: false,
              error: null,
              editing: null,
            });
          }),
        );
        if (next.supported) void untrack(() => refresh(selected));
        return;
      }
      // A capability change does not reset the open channel. Support can arrive after the scope starts:
      // a remote host reports its capabilities after it connects, and again after each reconnect.
      if (!next.supported || previous.supported) return;
      const saved = state.selectedId === null ? env.readSelection(next.scope) : null;
      if (saved === null) {
        void refresh();
        return;
      }
      // As `open`, but the read gets the channel as an argument: a store write in an effect shows only
      // after the flush, so a read that takes the selection from the store reads the old one.
      env.beforeOpen();
      unreadKeptFor = null;
      flush(() =>
        setState((state) => {
          Object.assign(state, { selectedId: saved, page: null, unread: null, editing: null, loading: true });
        }),
      );
      void refresh(saved);
    },
  );
  onSettled(() => {
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => {
      disposed = true;
      window.removeEventListener("focus", focus);
    };
  });
  /** Marks the open channel read through a message that arrived while the reader looks at it. */
  function readLive(channelId: string, sequence: number) {
    if (!env.canMarkRead() || sequence <= (readThrough.get(channelId) ?? 0)) return;
    readThrough.set(channelId, sequence);
    void env
      .port()
      .agent.channelCommand({ type: "read", channelId, throughSequence: sequence, operationId: crypto.randomUUID() })
      .catch(() => readThrough.delete(channelId));
  }

  /**
   * Puts a message from a `channel-message` event into the open page: a new one at its place in the
   * sequence, a changed one in place. A thread reply that stays in its thread is not in the
   * transcript; its root carries the new summary in an event of its own.
   */
  function applyMessage(message: ChannelMessage, revision: number) {
    const page = state.page;
    if (!page || page.channel.id !== message.channelId) return;
    liveRevisions.set(message.channelId, Math.max(revision, liveRevisions.get(message.channelId) ?? 0));
    if (isChannelThreadReply(message)) return;
    setState((draft) => {
      const target = draft.page;
      if (!target) return;
      const index = target.messages.findIndex((entry) => entry.id === message.id);
      if (index >= 0) target.messages[index] = message;
      else {
        // An event older than the loaded window belongs to history that "load earlier" brings.
        const first = target.messages[0];
        if (first && message.sequence < first.sequence && target.olderCursor !== null) return;
        let at = target.messages.length;
        while (at > 0 && (target.messages[at - 1]?.sequence ?? 0) > message.sequence) at -= 1;
        target.messages.splice(at, 0, message);
      }
      if (message.sequence > target.throughSequence) target.throughSequence = message.sequence;
    });
    if (state.selectedId === message.channelId) readLive(message.channelId, state.page?.throughSequence ?? 0);
  }

  function removeMessage(channelId: string, messageId: string, revision: number) {
    const page = state.page;
    if (!page || page.channel.id !== channelId) return;
    liveRevisions.set(channelId, Math.max(revision, liveRevisions.get(channelId) ?? 0));
    setState((draft) => {
      const target = draft.page;
      if (!target) return;
      const index = target.messages.findIndex((entry) => entry.id === messageId);
      if (index >= 0) target.messages.splice(index, 1);
    });
  }

  /**
   * A `channels-changed` event. When the live events already brought this revision of the open
   * channel, only the list is read again; otherwise the open page is read too.
   */
  function changed(channelId: string, revision: number): Promise<void> {
    const live = state.selectedId === channelId && (liveRevisions.get(channelId) ?? -1) >= revision;
    return refresh(undefined, live);
  }

  /** Reads each unread channel's latest page for its boundary, since a summary has no sequence. */
  function markAllRead(): Promise<boolean> {
    const unread = state.channels.filter((channel) => channel.unreadCount > 0).map((channel) => channel.id);
    const account = env.scopeKey();
    return perform(async () => {
      const results = await Promise.allSettled(
        unread.map(async (channelId) => {
          const page = await env.port().agent.readChannel({ channelId });
          // The port follows the current server, so a read for the previous one must not reach it.
          if (disposed || account !== env.scopeKey()) return;
          await env.port().agent.channelCommand({
            type: "read",
            channelId,
            throughSequence: page.throughSequence,
            operationId: crypto.randomUUID(),
          });
        }),
      );
      // The other channels are read, so the list shows them before the first failure is reported.
      const failure = results.find((result) => result.status === "rejected");
      if (failure) {
        await refreshAfter();
        throw failure.reason;
      }
      // Reading every channel is also reading the one that is open.
      setState((state) => {
        state.unread = null;
      });
    });
  }
  return {
    state,
    port: env.port,
    hasUnread: () => state.channels.some((channel) => channel.unreadCount > 0),
    markAllRead,
    agents: env.agents,
    supported,
    deletionSupported: () => supported() && env.deletionSupported(),
    refresh,
    changed,
    applyMessage,
    removeMessage,
    retry: async (onAccepted?: (accepted: ChannelCommand) => void) => {
      const previous = failedCommand;
      if (previous) return (await command(previous, onAccepted)) ? previous : null;
      await refresh();
      return null;
    },
    open,
    editChannel: async (channelId: string) => {
      if (!supported()) return;
      if (state.selectedId !== channelId) await open(channelId);
      if (state.page?.channel.id !== channelId || state.page.channel.archived) return;
      setState((state) => {
        state.editing = "settings";
      });
    },
    remove: async (channelId: string) => {
      if (!(await command({ type: "archive", channelId, operationId: crypto.randomUUID() }))) {
        throw new Error(state.error ?? currentText().t("channel.error.delete"));
      }
    },
    /**
     * A deleted channel comes back with its history. Its stopped tasks stay stopped. The sidebar menu
     * shows no channel error, so a failure is a toast, and it does not stay for the next channel.
     */
    restore: async (channelId: string) => {
      if (await command({ type: "restore", channelId, operationId: crypto.randomUUID() })) return;
      if (failedCommand?.type !== "restore" || failedCommand.channelId !== channelId) return;
      const message = state.error ?? currentText().t("channel.error.update");
      failedCommand = null;
      setState((state) => {
        Object.assign(state, { error: null, errorReference: null });
      });
      actionToast.error(message, { report: { operation: "other", source: "action", cause_code: "unknown" } });
    },
    command,
    send,
    perform,
    loadOlder,
    close: () => {
      env.writeSelection(null);
      unreadKeptFor = null;
      setState((state) => {
        Object.assign(state, { selectedId: null, page: null, unread: null, editing: null });
      });
    },
    /** The reader jumped to the latest message or marked the channel read: the divider has done its job. */
    releaseUnread: () =>
      setState((state) => {
        state.unread = null;
      }),
    edit: () =>
      setState((state) => {
        if (!state.page?.channel.archived) Object.assign(state, { editing: "settings" });
      }),
    closeEditor: () =>
      setState((state) => {
        state.editing = null;
      }),
    create: () => {
      if (!supported()) return;
      setState((state) => {
        state.editing = "create";
        state.error = null;
      });
    },
    toggleArchived: () =>
      setState((state) => {
        Object.assign(state, { archived: !state.archived });
      }),
    toggleCollapsed: () =>
      setState((state) => {
        Object.assign(state, { collapsed: !state.collapsed });
      }),
  };
}
