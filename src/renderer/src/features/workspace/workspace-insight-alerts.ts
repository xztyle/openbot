/*
 * The insight alerts ("spent X, 0 sales in N days", a goal behind, a source that fails) for Needs you.
 * They come with the Insights report; while that view is closed, Needs you reads the report again
 * every ten minutes for an owner or an admin. The report is computed on the host from stored rows.
 */
import type { InsightAlert } from "@openbot/contracts/ipc";
import { createSignal, onCleanup } from "solid-js";

const POLL_MS = 10 * 60_000;
const [alerts, setAlerts] = createSignal<readonly InsightAlert[]>([]);

export function setInsightAlerts(next: readonly InsightAlert[]): void {
  setAlerts(next);
}

export function insightAlerts(): readonly InsightAlert[] {
  return alerts();
}

let readers: (() => (() => Promise<readonly InsightAlert[]>) | undefined)[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

function load(): void {
  const get = readers.at(-1)?.();
  if (!get) {
    setAlerts([]);
    return;
  }
  void get()
    .then((next) => setAlerts(next))
    .catch(() => undefined);
}

/**
 * Keeps the alerts fresh while a component that calls it lives; several callers share one timer.
 * `read` is absent for a reader who may not see the report: the list then stays empty.
 */
export function pollInsightAlerts(read: () => (() => Promise<readonly InsightAlert[]>) | undefined): void {
  readers = [...readers, read];
  if (readers.length === 1) {
    load();
    timer = setInterval(load, POLL_MS);
  }
  onCleanup(() => {
    readers = readers.filter((item) => item !== read);
    if (readers.length === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  });
}
