import type { WorkspaceLoopAction, WorkspaceLoops } from "@openbot/contracts/ipc";
import { LoopsView } from "@openbot/ui/features/workspace/LoopsView";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { useLoopDecisions } from "./loop-decisions-feed";
import { useWorkspace } from "./workspace-context";
import { loopFocus, setLoopFocus } from "./workspace-decisions";
import { memberById } from "./workspace-model";

/** While the view shows, the board is read again this often, so agents' moves appear. */
const REFRESH_MS = 30_000;

/** The Loops view of the space that shows: its pipelines, items by stage and the decisions for the reader. */
export function WorkspaceLoopsView() {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const agentApi = () => ws.channels.port().agent;
  const [board, setBoard] = createSignal<WorkspaceLoops | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);

  /*
   * Each read and each action counts one. A timed read that began before an action answers the board
   * from before it, so the moved or decided item went back until the next read.
   */
  let asked = 0;
  async function load(spaceId: string) {
    const read = agentApi().workspaceLoops;
    if (!read) return;
    const mine = ++asked;
    try {
      const next = await read({ spaceId });
      if (mine !== asked) return;
      if (spaceId === ws.spaces.current()) {
        setBoard(next);
        setLoadError(null);
      }
    } catch (error) {
      if (mine === asked && board() === null) setLoadError(errorMessage(error, t("workspace.loops.loadFailed")));
    }
  }

  createEffect(
    () => ws.spaces.current(),
    (spaceId) => {
      setBoard(null);
      void load(spaceId);
      const timer = window.setInterval(() => {
        if (document.visibilityState === "visible") void load(spaceId);
      }, REFRESH_MS);
      return () => window.clearInterval(timer);
    },
  );

  const feed = useLoopDecisions(ws);
  // The decision that Today, Needs you or Ctrl+K opened: the board shows its loop and scrolls to it,
  // also when the board already shows. It is forgotten when the view goes, so it does not come back.
  onCleanup(() => setLoopFocus(null));
  /** The space's lead (its first agent), who makes a loop from a description in words. */
  const lead = () => ws.spaceAgents()[0];
  const agents = createMemo(() => ws.spaceAgents().map((agent) => memberById(ws.directory(), agent.id, agent.name)));

  async function act(action: WorkspaceLoopAction) {
    const run = agentApi().workspaceLoopAction;
    if (!run) throw new Error(t("workspace.loops.failed"));
    const spaceId = ws.spaces.current();
    const mine = ++asked;
    const result = await run(action).catch((error: unknown) => {
      // The board can be older than the host's (an agent moved or removed the item): read it again.
      void load(spaceId);
      throw error;
    });
    if (mine === asked && result.spaceId === ws.spaces.current()) setBoard(result);
    if (action.kind === "decide") feed.refresh();
    return result;
  }

  return (
    <LoopsView
      board={board()}
      loadError={loadError()}
      onRetry={() => {
        setLoadError(null);
        void load(ws.spaces.current());
      }}
      agents={agents()}
      // The owner and the admins change loops and decide gates.
      canEdit={ws.isAdmin()}
      initialLoopId={loopFocus()?.loopId}
      focusDecisionId={loopFocus()?.decisionId}
      onAskLead={
        lead()
          ? () => {
              const agent = lead();
              if (agent) ws.openAgent(agent.id);
            }
          : undefined
      }
      onAction={act}
      onOpenAgent={(agentId) => ws.openAgent(agentId)}
      onBack={() => ws.back()}
    />
  );
}
