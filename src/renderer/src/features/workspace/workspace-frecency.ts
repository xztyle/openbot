/*
 * The visits of the reader to each conversation, as Slack's Jump to keeps them: the last visits of
 * each one, scored by how recent they are and how many there are ("frecency"). Jump to puts the
 * recent and frequent conversations first. The visits stay on this computer, per reader and server.
 */

import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { createEffect, createSignal } from "solid-js";

const VISITS_KEY = "openbot.workspace.visits.v1";
/** The visits that one conversation keeps, newest first. */
const VISITS_PER_TARGET = 10;
/** The conversations that the store keeps; the least recent ones go first. */
const TARGET_LIMIT = 300;
/** A visit closer than this to the one before it is the same visit, such as a quick switch back. */
const SAME_VISIT_MS = 60_000;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Slack's recency buckets: a visit in the last 4 hours counts most, one older than 90 days not at all. */
const BUCKETS: readonly (readonly [number, number])[] = [
  [4 * HOUR, 100],
  [DAY, 80],
  [3 * DAY, 60],
  [7 * DAY, 40],
  [30 * DAY, 20],
  [90 * DAY, 10],
];

type Visits = Readonly<Record<string, readonly number[]>>;

function readVisits(key: string): Visits {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${VISITS_KEY}:${key}`) ?? "{}");
    if (!isDynamicRecord(value)) return {};
    const visits: Record<string, number[]> = {};
    for (const [id, times] of Object.entries(value))
      if (Array.isArray(times))
        visits[id] = times
          .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
          .slice(0, VISITS_PER_TARGET);
    return visits;
  } catch {
    return {};
  }
}

function writeVisits(key: string, visits: Visits): void {
  try {
    window.localStorage.setItem(`${VISITS_KEY}:${key}`, JSON.stringify(visits));
  } catch {
    // A private window or a full disk keeps no visits.
  }
}

function bucket(age: number): number {
  for (const [limit, points] of BUCKETS) if (age <= limit) return points;
  return 0;
}

export interface WorkspaceFrecency {
  /** The score of a conversation: 0 when the reader never opened it. */
  score: (id: string, now?: number) => number;
  /** The conversations of the last visits, newest first. */
  recent: () => string[];
  /** Notes a visit now. */
  note: (id: string) => void;
}

/**
 * Keeps the visits per reader and server (`storageKey`). Each conversation that becomes `active`
 * counts as a visit.
 */
export function createWorkspaceFrecency(input: {
  storageKey: () => string;
  active: () => string | undefined;
}): WorkspaceFrecency {
  const [visits, setVisits] = createSignal<Visits>({});
  /*
   * The visits as last written. A visit is noted from them, not from the signal: the signal shows a
   * write only after its flush, and the first visit of a page, noted in the same flush as the read
   * of the stored visits, replaced them all with itself.
   */
  let latest: Visits = {};
  const show = (next: Visits) => {
    latest = next;
    setVisits(next);
  };
  createEffect(input.storageKey, (key) => {
    show(readVisits(key));
  });

  function note(id: string) {
    const now = Date.now();
    const current = latest;
    const times = current[id] ?? [];
    if (times[0] !== undefined && now - times[0] < SAME_VISIT_MS) return;
    const next: Record<string, readonly number[]> = { ...current, [id]: [now, ...times].slice(0, VISITS_PER_TARGET) };
    const ids = Object.keys(next);
    if (ids.length > TARGET_LIMIT)
      for (const old of ids
        .sort((left, right) => (next[left]?.[0] ?? 0) - (next[right]?.[0] ?? 0))
        .slice(0, ids.length - TARGET_LIMIT))
        delete next[old];
    show(next);
    writeVisits(input.storageKey(), next);
  }

  createEffect(input.active, (id) => {
    if (id) note(id);
  });

  return {
    note,
    score: (id, now = Date.now()) => {
      const times = visits()[id];
      if (!times?.length) return 0;
      // Slack: the count of visits times the mean of their bucket points, which is their sum here,
      // since the store keeps every visit it counts.
      return times.reduce((sum, time) => sum + bucket(now - time), 0);
    },
    recent: () =>
      Object.entries(visits())
        .sort((left, right) => (right[1][0] ?? 0) - (left[1][0] ?? 0))
        .map(([id]) => id),
  };
}
