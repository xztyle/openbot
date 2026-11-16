import type { WorkspaceAgentExchangeMessage, WorkspaceAgentPair } from "@openbot/contracts/ipc";
import { type AgentTalkPair, AgentTalkView } from "@openbot/ui/features/workspace/AgentTalkView";
import { createEffect, createMemo, createStore, onCleanup } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { memberById, mergeLatestExchange } from "./workspace-model";

interface AgentTalkState {
  /** Null while the list loads. */
  pairs: WorkspaceAgentPair[] | null;
  /** The pair that shows, as `first|second`. */
  selected: string | null;
  messages: WorkspaceAgentExchangeMessage[] | null;
  hasOlder: boolean;
  loading: boolean;
}

const pairKey = (pair: WorkspaceAgentPair) => pair.agentIds.join("|");

/** How long the view waits after the agents change before it reads the pairs and the messages again. */
const REFRESH_DELAY_MS = 750;

/** The Between agents view: the pairs of agents that talked, and the messages of one pair. */
export function WorkspaceAgentTalkView() {
  const ws = useWorkspace();
  const [state, setState] = createStore<AgentTalkState>({
    pairs: null,
    selected: null,
    messages: null,
    hasOlder: false,
    loading: false,
  });
  let listRun = 0;
  let readRun = 0;

  createEffect(
    () => ws.state.agentTalkAgentId,
    (agentId) => {
      const read = ws.channels.port().agent.workspaceAgentPairs;
      const run = ++listRun;
      readRun += 1;
      setState((draft) => {
        draft.pairs = read ? null : [];
        draft.selected = null;
        draft.messages = null;
      });
      if (!read) return;
      read(agentId ? { agentId } : {}).then(
        (result) => {
          if (run === listRun)
            setState((draft) => {
              // Only the pairs of the space that shows; an agent of another space is not in this list.
              draft.pairs = result.pairs.filter((pair) =>
                pair.agentIds.every((agentId) => ws.spaces.agentInCurrent(agentId)),
              );
            });
        },
        () => {
          if (run === listRun)
            setState((draft) => {
              draft.pairs = [];
            });
        },
      );
    },
  );

  async function load(agentIds: [string, string], before?: number) {
    const read = ws.channels.port().agent.workspaceAgentExchange;
    if (!read) return;
    const run = before === undefined ? ++readRun : readRun;
    setState((draft) => {
      draft.loading = true;
    });
    try {
      // A plain copy: a store array cannot cross the IPC boundary.
      const result = await read({ agentIds: [agentIds[0], agentIds[1]], ...(before === undefined ? {} : { before }) });
      if (run !== readRun) return;
      setState((draft) => {
        draft.messages = before === undefined ? result.messages : [...result.messages, ...(draft.messages ?? [])];
        draft.hasOlder = result.hasOlder;
      });
    } catch {
      if (run === readRun && before === undefined)
        setState((draft) => {
          draft.messages = [];
        });
    } finally {
      if (run === readRun)
        setState((draft) => {
          draft.loading = false;
        });
    }
  }

  /*
   * The view reads the pairs and the messages once, so a message between two agents that came while it
   * was open did not show. A message changes the preview and time of the agent it reaches, so the view
   * reads both again, after a short wait, when an agent changes.
   */
  const agentActivity = createMemo(() =>
    ws
      .directory()
      .agents.map((agent) => `${agent.id}:${agent.updatedAt ?? ""}:${agent.preview}`)
      .join("\n"),
  );
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(refreshTimer));
  createEffect(agentActivity, (_activity, previous) => {
    if (previous === undefined) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), REFRESH_DELAY_MS);
  });

  async function refresh() {
    const port = ws.channels.port().agent;
    const agentId = ws.state.agentTalkAgentId;
    const run = listRun;
    if (port.workspaceAgentPairs) {
      const result = await port.workspaceAgentPairs(agentId ? { agentId } : {}).catch(() => null);
      if (result && run === listRun)
        setState((draft) => {
          draft.pairs = result.pairs;
        });
    }
    const pair = state.pairs?.find((item) => pairKey(item) === state.selected);
    if (!pair || !state.messages || !port.workspaceAgentExchange) return;
    const read = readRun;
    const selected = state.selected;
    const result = await port
      .workspaceAgentExchange({ agentIds: [pair.agentIds[0], pair.agentIds[1]] })
      .catch(() => null);
    if (!result || read !== readRun || selected !== state.selected) return;
    setState((draft) => {
      draft.messages = mergeLatestExchange(draft.messages ?? [], result.messages);
    });
  }

  const member = (id: string) => memberById(ws.directory(), id);
  const pairs = createMemo((): AgentTalkPair[] | null =>
    state.pairs
      ? state.pairs.map((pair) => ({
          id: pairKey(pair),
          members: [member(pair.agentIds[0]), member(pair.agentIds[1])],
          count: pair.count,
          lastAt: pair.lastAt,
          lastSenderName: member(pair.lastSenderId).name,
          lastText: pair.lastText,
        }))
      : null,
  );
  const selected = () => pairs()?.find((pair) => pair.id === state.selected) ?? null;
  const messages = createMemo(() => {
    const current = state.pairs?.find((pair) => pairKey(pair) === state.selected);
    if (!state.messages || !current) return state.messages ? [] : null;
    return state.messages.map((message) => {
      const others = message.recipientAgentIds.filter((id) => !current.agentIds.includes(id));
      return {
        id: message.id,
        author: member(message.senderAgentId),
        sentAt: message.createdAt,
        text: message.text,
        alsoTo: others.length ? others.map((id) => member(id).name).join(", ") : undefined,
        truncated: message.truncated,
        attachmentCount: message.attachmentCount,
      };
    });
  });
  const filterName = () => {
    const agentId = ws.state.agentTalkAgentId;
    return agentId ? member(agentId).name : undefined;
  };

  return (
    <AgentTalkView
      pairs={pairs()}
      selected={selected()}
      messages={messages()}
      hasOlder={state.hasOlder}
      loading={state.loading}
      filterName={filterName()}
      onClearFilter={() => ws.openAgentTalk(null)}
      onSelect={(id) => {
        const pair = state.pairs?.find((item) => pairKey(item) === id);
        if (!pair) return;
        setState((draft) => {
          draft.selected = id;
          draft.messages = null;
          draft.hasOlder = false;
        });
        void load(pair.agentIds);
      }}
      onCloseConversation={() => {
        readRun += 1;
        setState((draft) => {
          draft.selected = null;
          draft.messages = null;
        });
      }}
      onLoadOlder={() => {
        const pair = state.pairs?.find((item) => pairKey(item) === state.selected);
        const oldest = state.messages?.[0]?.createdAt;
        if (pair && oldest !== undefined) void load(pair.agentIds, oldest);
      }}
      onBack={() => ws.back()}
    />
  );
}
