/*
 * The insight alerts ("spent X, 0 sales in N days", a goal behind, a source that fails) for Needs you.
 * They come with the Insights report; while that view is closed, Needs you reads the report again
 * every ten minutes for an owner or an admin, and at once when the reader comes back to the host. The
 * report is computed on the host from stored rows.
 */
import type { InsightAlert } from "@openbot/contracts/ipc";
import { createEffect, createSignal, getOwner, onCleanup } from "solid-js";
import type { useWorkspace } from "./workspace-context";
import { refreshOnReturn, singleFlight } from "./workspace-host-feeds";

const POLL_MS = 10 * 60_000;
// The first read starts in the component that polls, so it may write there.
const [alerts, setAlerts] = createSignal<readonly InsightAlert[]>([], { ownedWrite: true });

export function setInsightAlerts(next: readonly InsightAlert[]): void {
  setAlerts(next);
}

export function insightAlerts(): readonly InsightAlert[] {
  return alerts();
}

type Reader = () => (() => Promise<readonly InsightAlert[]>) | undefined;

let readers: Reader[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

const load = singleFlight(() => {
  const get = readers.at(-1)?.();
  if (!get) {
    setAlerts([]);
    return undefined;
  }
  return get().then(
    (next) => setAlerts(next),
    () => undefined,
  );
});

/**
 * Keeps the alerts fresh while a component that calls it lives; several callers share one timer.
 * `read` is absent for a reader who may not see the report: the list then stays empty. The host says
 * the reader's role only after it connects, so the first read waits for that, not for the timer.
 */
export function pollInsightAlerts(ws: ReturnType<typeof useWorkspace>, read: Reader): void {
  readers = [...readers, read];
  // Only while the page shows; `refreshOnReturn` reads when it shows again.
  if (readers.length === 1)
    timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, POLL_MS);
  refreshOnReturn(ws, () => Boolean(read()), load);
  if (!getOwner()) return;
  // A reader who may not see the report (another host, another role) sees none of its alerts.
  createEffect(
    () => Boolean(read()),
    (allowed) => {
      if (!allowed) setAlerts([]);
    },
  );
  onCleanup(() => {
    readers = readers.filter((item) => item !== read);
    if (readers.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
