/*
 * Host lists that the decision queue and Money read while a view that needs them lives: the learning
 * decision queue (agent-learning-v1: memory, playbook and instruction proposals) and the guardrails
 * view (guardrails-v1: pauses, the subscription meter, today's use, failovers and events). One feed per
 * workspace and list, shared by its readers and stopped when the last one goes. A host without the
 * route answers 404, and the feed stays empty. Each feed reads again when the reader comes back to the
 * host (`refreshOnReturn`), not only on its timer.
 */
import type { DecisionQueueEntry } from "@openbot/contracts/agent-learning";
import type { GuardrailsView } from "@openbot/contracts/guardrails";
import { createEffect, createSignal, getOwner, onCleanup, untrack } from "solid-js";
import type { useWorkspace } from "./workspace-context";

/** How often a feed reads its list again, while the window is visible. */
const POLL_MS = 60_000;

type Workspace = ReturnType<typeof useWorkspace>;

/**
 * Calls `refresh` when the reader comes back to the host: the read becomes possible (the connection is
 * up and the reader's role allows it, which the host says only after it connects), the connection
 * returns, or the window shows again. A feed's timer reads a minute or more later, and a phone stops
 * the timers while the app is in the background: without this, a decision that waits shows late.
 */
export function refreshOnReturn(ws: Workspace, available: () => boolean, refresh: () => void): void {
  if (!getOwner()) {
    refresh();
    return;
  }
  createEffect(
    () => ws.env.connectionReady() && available(),
    (ready, previous) => {
      if (ready && !previous) refresh();
    },
  );
  if (typeof document === "undefined") return;
  const visible = () => {
    if (document.visibilityState === "visible" && ws.env.connectionReady() && available()) refresh();
  };
  document.addEventListener("visibilitychange", visible);
  onCleanup(() => document.removeEventListener("visibilitychange", visible));
}

/**
 * One read at a time: a refresh asked while a read runs reads once more after it, so an answer that
 * changed the list (an Apply, a Resume) is never lost to an older read, and several readers that ask
 * at once cost one read.
 */
export function singleFlight(run: () => Promise<unknown> | undefined): () => void {
  let running = false;
  let again = false;
  const start = (): void => {
    let pending: Promise<unknown> | undefined;
    try {
      // It runs from effects and timers: what it reads is the state now, not a dependency.
      pending = untrack(run);
    } catch {
      // A call that cannot start (no connection to the server yet) reads at the next chance.
      return;
    }
    if (!pending) return;
    running = true;
    void pending.finally(() => {
      running = false;
      if (!again) return;
      again = false;
      start();
    });
  };
  return () => {
    if (running) again = true;
    else start();
  };
}

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
  available: () => boolean,
): Feed<T> {
  let feed = feeds.get(ws);
  if (!feed) {
    // The first read starts in the component that asked for the feed, so it may write there.
    // In a box: a list or a view of the host, never read as a signal's compute function.
    const [box, setBox] = createSignal<{ value: T }>({ value: empty }, { ownedWrite: true });
    const value = () => box().value;
    const setValue = (next: T) => setBox({ value: next });
    const refresh = singleFlight(() =>
      read()?.then(
        (next) => setValue(next),
        // A failed read keeps what showed; a host without the route keeps the list empty.
        () => undefined,
      ),
    );
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
  }
  const current = feed;
  current.users += 1;
  // Each reader asks for a read when it starts and when the host comes back; one read runs at a time.
  refreshOnReturn(ws, available, current.refresh);
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
  return sharedFeed(
    learningFeeds,
    ws,
    [],
    () => ws.env.efficiency?.()?.decisionQueue(),
    () => Boolean(ws.env.efficiency?.()),
  );
}

/** The guardrails view of the host, or null where the reader may not read it or the host has none. */
export function useGuardrails(ws: Workspace) {
  return sharedFeed(
    guardrailFeeds,
    ws,
    null,
    () => ws.env.trust?.()?.guardrails.view(),
    () => Boolean(ws.env.trust?.()),
  );
}
