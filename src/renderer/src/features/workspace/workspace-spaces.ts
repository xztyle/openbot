import {
  type AgentEvent,
  GENERAL_SPACE_ID,
  type TeamRealtimeEvent,
  type WorkspaceSpace,
  type WorkspaceSpaceAction,
  type WorkspaceSpaces,
} from "@openbot/contracts/ipc";
import { currentText } from "@openbot/ui/text";
import { createEffect, createMemo, createStore, onCleanup, untrack } from "solid-js";
import type { ChannelsPort } from "../channels/channels-port";

export interface WorkspaceSpacesOptions {
  port: () => ChannelsPort;
  /** The host answers and has the workspace. */
  ready: () => boolean;
  /** Per reader and server: a change reads the spaces of the other server. */
  key: () => string;
  onHostEvent: (listener: (event: AgentEvent | TeamRealtimeEvent) => void) => () => void;
  /** Every channel id the reader has, so a new one that the spaces do not name yet reads them again. */
  channelIds: () => readonly string[];
  /** Every agent id, for the same reason. */
  agentIds: () => readonly string[];
  /** The space that the reader looked at last, from their synced sidebar. */
  saved: () => string | undefined;
  /** Keeps the space that the reader looks at in their synced sidebar. */
  save: (spaceId: string) => void;
}

interface SpacesState {
  data: WorkspaceSpaces | null;
  /** Channels this client put in a space before it made them, until the host's answer names them. */
  placed: Record<string, string>;
  /** False until the host answered, and on a host without spaces: then only General shows. */
  available: boolean;
  /** The first read for this reader and server ended, or the host has no spaces to read. */
  settled: boolean;
}

export type WorkspaceSpacesController = ReturnType<typeof createWorkspaceSpaces>;

/**
 * The spaces of the host, the space of each agent and channel, and the space that the reader looks
 * at. The sidebar and the views show only that space. A host without spaces has one, General.
 */
export function createWorkspaceSpaces(options: WorkspaceSpacesOptions) {
  const [state, setState] = createStore<SpacesState>({ data: null, placed: {}, available: false, settled: false });
  let run = 0;
  let loading = false;
  let again = false;

  async function load(): Promise<void> {
    const read = options.port().agent.workspaceSpaces;
    if (!options.ready()) return;
    if (!read) {
      if (!state.settled)
        setState((draft) => {
          draft.settled = true;
        });
      return;
    }
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    const current = ++run;
    try {
      const data = await read();
      if (current === run)
        setState((draft) => {
          draft.data = data;
          draft.available = true;
        });
    } catch {
      // A host without spaces: everything is in General. A host that has them and failed to answer
      // once, such as during a reconnect, keeps the spaces it gave: the reader stays where they are.
      if (current === run && state.data === null)
        setState((draft) => {
          draft.available = false;
        });
    } finally {
      if (current === run && !state.settled)
        setState((draft) => {
          draft.settled = true;
        });
      loading = false;
      if (again) {
        again = false;
        void load();
      }
    }
  }

  createEffect(
    () => ({ ready: options.ready(), key: options.key() }),
    (now, before) => {
      if (before && now.key !== before.key) {
        run += 1;
        setState((draft) => {
          draft.data = null;
          draft.placed = {};
          draft.available = false;
          draft.settled = false;
        });
      }
      if (now.ready && (!before?.ready || now.key !== before.key)) void load();
    },
  );
  onCleanup(
    options.onHostEvent((event) => {
      if (event.type === "workspace-spaces-changed") void load();
    }),
  );

  const agentSpaces = createMemo(() => new Map((state.data?.agents ?? []).map((item) => [item.id, item.spaceId])));
  const channelSpaces = createMemo(() => new Map((state.data?.channels ?? []).map((item) => [item.id, item.spaceId])));
  // A channel or an agent that the last answer did not name is new: read the spaces again, once for each.
  const askedFor = new Set<string>();
  createEffect(
    () => {
      if (!state.available) return [];
      const agents = agentSpaces();
      const channels = channelSpaces();
      return [
        ...options.agentIds().filter((id) => !agents.has(id)),
        ...options.channelIds().filter((id) => !channels.has(id)),
      ];
    },
    (unknown) => {
      const fresh = unknown.filter((id) => !askedFor.has(id));
      if (fresh.length === 0) return;
      for (const id of fresh) askedFor.add(id);
      void untrack(load);
    },
  );

  const list = createMemo((): WorkspaceSpace[] =>
    state.data?.spaces.length
      ? state.data.spaces
      : [
          {
            id: GENERAL_SPACE_ID,
            name: currentText().t("workspace.spaces.general"),
            slug: GENERAL_SPACE_ID,
            icon: null,
            hue: null,
            position: 0,
          },
        ],
  );
  const known = (spaceId: string | undefined) =>
    spaceId !== undefined && list().some((space) => space.id === spaceId) ? spaceId : GENERAL_SPACE_ID;
  /** The space that shows. A space that is gone, or a host without spaces, shows General. */
  const current = createMemo(() => (state.available ? known(options.saved()) : GENERAL_SPACE_ID));
  const agentSpace = (agentId: string) => known(agentSpaces().get(agentId));
  const channelSpace = (channelId: string) => known(channelSpaces().get(channelId) ?? state.placed[channelId]);

  /**
   * Sends a change and shows its answer. A read that started before the change answers an older
   * value, so it is dropped, and one more read follows the answer.
   */
  async function act(action: WorkspaceSpaceAction) {
    const send = options.port().agent.workspaceSpaceAction;
    if (!send) throw new Error(currentText().t("error.team.workspaceUnsupported"));
    run += 1;
    const result = await send(action);
    run += 1;
    setState((draft) => {
      draft.data = result;
      draft.available = true;
      if (action.kind === "place-channel") draft.placed[action.channelId] = action.spaceId;
    });
    void load();
    return result;
  }

  return {
    available: () => state.available,
    /** The space list is in, or there is none to wait for: a place in a space can open now. */
    settled: () => state.settled,
    list,
    current,
    space: (spaceId: string) => list().find((space) => space.id === spaceId),
    /** The space of a slug, else of an id, as an address names it. */
    find: (slugOrId: string) =>
      list().find((space) => space.slug === slugOrId) ?? list().find((space) => space.id === slugOrId),
    select: (spaceId: string) => options.save(spaceId),
    agentSpace,
    channelSpace,
    /** Whether the host named the space of the item, so a move to it is not a guess. */
    knowsAgent: (agentId: string) => agentSpaces().has(agentId),
    knowsChannel: (channelId: string) => channelSpaces().has(channelId) || channelId in state.placed,
    /** Whether an agent or a channel shows in the space that the reader looks at. */
    agentInCurrent: (agentId: string) => agentSpace(agentId) === current(),
    channelInCurrent: (channelId: string) => channelSpace(channelId) === current(),
    refresh: load,
    act,
  };
}
