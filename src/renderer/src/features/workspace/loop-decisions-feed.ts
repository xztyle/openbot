import type { LoopDecision } from "@openbot/contracts/ipc";
import { createEffect, createSignal, getOwner, onCleanup } from "solid-js";
import type { useWorkspace } from "./workspace-context";

/** How often "Needs you" reads the loop decisions of every space, while the window is visible. */
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
 * The loop decisions that wait for the reader in every space, read with `decisionsOnly`, so a count
 * costs no board. A decision of a space that does not show still waits for the owner: Today, the top
 * bar and the phone's badge count it, so none goes unseen. One feed per workspace, shared by its
 * readers, and stopped when the last of them goes. A host without loops gives none.
 */
export function useLoopDecisions(ws: Workspace): Pick<Feed, "decisions" | "refresh"> {
  let feed = feeds.get(ws);
  if (!feed) {
    // The first read starts in the component that asked for the feed.
    const [decisions, setDecisions] = createSignal<readonly LoopDecision[]>([], { ownedWrite: true });
    let generation = 0;
    const refresh = () => {
      const read = ws.channels.port().agent.workspaceLoops;
      if (!read) return;
      const spaceIds = ws.spaces.available() ? ws.spaces.list().map((space) => space.id) : [ws.spaces.current()];
      const run = ++generation;
      void Promise.all(
        spaceIds.map((spaceId) =>
          read({ spaceId, decisionsOnly: true }).then(
            (board) => board.decisions.filter((decision) => decision.status === "pending"),
            // One space that fails keeps the others.
            (): LoopDecision[] => [],
          ),
        ),
      ).then((lists) => {
        if (run === generation) setDecisions(lists.flat());
      });
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const created: Feed = { decisions, refresh, users: 0, stop: () => window.clearInterval(timer) };
    feeds.set(ws, created);
    feed = created;
    // The spaces come after the first read: a new space is read at once, not a minute later.
    if (getOwner())
      createEffect(
        () => (ws.spaces.available() ? ws.spaces.list().map((space) => space.id) : [ws.spaces.current()]).join(" "),
        () => refresh(),
      );
    else refresh();
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
