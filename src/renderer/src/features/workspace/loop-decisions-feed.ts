import type { LoopDecision } from "@openbot/contracts/ipc";
import { createSignal, getOwner, onCleanup } from "solid-js";
import type { useWorkspace } from "./workspace-context";

/** How often "Needs you" reads the loop decisions of the space that shows, while the window is visible. */
const POLL_MS = 60_000;

type Workspace = ReturnType<typeof useWorkspace>;

interface Feed {
  decisions: () => readonly LoopDecision[];
  refresh: () => void;
  users: number;
  stop: () => void;
}

const feeds = new WeakMap<Workspace, Feed>();

/**
 * The loop decisions that wait for the reader in the space that shows, read with `decisionsOnly`, so a
 * count costs no board. One feed per workspace, shared by the top bar and Activity, and stopped when the
 * last of them goes. A host without loops gives none.
 */
export function useLoopDecisions(ws: Workspace): Pick<Feed, "decisions" | "refresh"> {
  let feed = feeds.get(ws);
  if (!feed) {
    // The first read starts in the component that asked for the feed, and a new space empties it there.
    const [decisions, setDecisions] = createSignal<readonly LoopDecision[]>([], { ownedWrite: true });
    let space = "";
    const refresh = () => {
      const read = ws.channels.port().agent.workspaceLoops;
      const spaceId = ws.spaces.current();
      if (!read) return;
      if (spaceId !== space) {
        space = spaceId;
        setDecisions([]);
      }
      void read({ spaceId, decisionsOnly: true })
        .then((board) => {
          if (board.spaceId === ws.spaces.current())
            setDecisions(board.decisions.filter((decision) => decision.status === "pending"));
        })
        .catch(() => undefined);
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const created: Feed = { decisions, refresh, users: 0, stop: () => window.clearInterval(timer) };
    feeds.set(ws, created);
    feed = created;
    refresh();
  }
  const current = feed;
  current.users += 1;
  if (getOwner())
    onCleanup(() => {
      current.users -= 1;
      if (current.users > 0) return;
      current.stop();
      feeds.delete(ws);
    });
  return { decisions: current.decisions, refresh: current.refresh };
}
