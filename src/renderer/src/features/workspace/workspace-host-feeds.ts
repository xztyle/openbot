/*
 * Host lists that the decision queue and Money read while a view that needs them lives: the learning
 * decision queue (agent-learning-v1: memory, playbook and instruction proposals) and the guardrails
 * view (guardrails-v1: pauses, the subscription meter, today's use, failovers and events). One feed per
 * workspace and list, shared by its readers and stopped when the last one goes. A host without the
 * route answers 404, and the feed stays empty.
 */
import type { DecisionQueueEntry } from "@openbot/contracts/agent-learning";
import type { GuardrailsView } from "@openbot/contracts/guardrails";
import { createSignal, getOwner, onCleanup } from "solid-js";
import type { useWorkspace } from "./workspace-context";

/** How often a feed reads its list again, while the window is visible. */
const POLL_MS = 60_000;

type Workspace = ReturnType<typeof useWorkspace>;

interface Feed<T> {
  value: () => T;
  refresh: () => void;
  /** Puts an answer of an action in place, as the host sends the new list back. */
  set: (value: T) => void;
  users: number;
  stop: () => void;
}

function sharedFeed<T>(
  feeds: WeakMap<Workspace, Feed<T>>,
  ws: Workspace,
  empty: T,
  read: () => Promise<T> | undefined,
): Feed<T> {
  let feed = feeds.get(ws);
  if (!feed) {
    // The first read starts in the component that asked for the feed, so it may write there.
    // In a box: a list or a view of the host, never read as a signal's compute function.
    const [box, setBox] = createSignal<{ value: T }>({ value: empty }, { ownedWrite: true });
    const value = () => box().value;
    const setValue = (next: T) => setBox({ value: next });
    const refresh = () => {
      const pending = read();
      if (!pending) return;
      void pending.then(
        (next) => setValue(next),
        // A failed read keeps what showed; a host without the route keeps the list empty.
        () => undefined,
      );
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, POLL_MS);
    const created: Feed<T> = {
      value,
      refresh,
      set: setValue,
      users: 0,
      stop: () => window.clearInterval(timer),
    };
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
  return current;
}

const learningFeeds = new WeakMap<Workspace, Feed<readonly DecisionQueueEntry[]>>();
const guardrailFeeds = new WeakMap<Workspace, Feed<GuardrailsView | null>>();

/** The learning decision queue of the host, for an owner or an admin of a fork host. */
export function useLearningQueue(ws: Workspace) {
  return sharedFeed(learningFeeds, ws, [], () => ws.env.efficiency?.()?.decisionQueue());
}

/** The guardrails view of the host, or null where the reader may not read it or the host has none. */
export function useGuardrails(ws: Workspace) {
  return sharedFeed(guardrailFeeds, ws, null, () => ws.env.trust?.()?.guardrails.view());
}
