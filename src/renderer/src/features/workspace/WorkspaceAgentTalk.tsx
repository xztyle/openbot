import type { WorkspaceAgentExchangeMessage, WorkspaceAgentPair } from "@openbot/contracts/ipc";
import { type AgentTalkPair, AgentTalkView } from "@openbot/ui/features/workspace/AgentTalkView";
import { createEffect, createMemo, createStore } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { memberById } from "./workspace-model";

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
              draft.pairs = result.pairs;
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
      const result = await read({ agentIds, ...(before === undefined ? {} : { before }) });
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
