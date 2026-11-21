import type { WorkspaceLoopAction, WorkspaceLoops } from "@openbot/contracts/ipc";
import { LoopsView } from "@openbot/ui/features/workspace/LoopsView";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal } from "solid-js";
import { useLoopDecisions } from "./loop-decisions-feed";
import { useWorkspace } from "./workspace-context";
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

  async function load(spaceId: string) {
    const read = agentApi().workspaceLoops;
    if (!read) return;
    try {
      const next = await read({ spaceId });
      if (spaceId === ws.spaces.current()) {
        setBoard(next);
        setLoadError(null);
      }
    } catch (error) {
      if (board() === null) setLoadError(errorMessage(error, t("workspace.loops.loadFailed")));
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
  const agents = createMemo(() => ws.spaceAgents().map((agent) => memberById(ws.directory(), agent.id, agent.name)));

  async function act(action: WorkspaceLoopAction) {
    const run = agentApi().workspaceLoopAction;
    if (!run) throw new Error(t("workspace.loops.failed"));
    const result = await run(action);
    if (result.spaceId === ws.spaces.current()) setBoard(result);
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
      canEdit={ws.env.secrets?.() === true}
      onAction={act}
      onOpenAgent={(agentId) => ws.openAgent(agentId)}
      onBack={() => ws.back()}
    />
  );
}
