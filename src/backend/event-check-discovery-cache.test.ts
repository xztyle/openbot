// @vitest-environment node
// Failure modes: a list that outlives a change of private values, an unbounded memory, an old list
// answering for a failure that waiting cannot fix, and one slow call run twice for two callers.
import type { EventCheckPickerOptions } from "@openbot/contracts/event-check-templates";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  DISCOVERY_CACHE_ENTRIES,
  DISCOVERY_FRESH_MS,
  DISCOVERY_STALE_MS,
  EventCheckDiscoveryCache,
} from "./event-check-discovery-cache";

const options = (label: string): EventCheckPickerOptions => ({
  options: [{ id: "C1AAA", label, group: "channel" }],
});
const parts = (checkId: string, ids: string[] = []) => ({
  agentId: "chief",
  checkId,
  field: "rules",
  digest: "d".repeat(64),
  settings: { userId: "U1AAA" },
  ids,
});
const standIn = (failure: unknown) => failure === "limited";

function setup() {
  let clock = 1_000_000;
  const cache = new EventCheckDiscoveryCache<string>(() => clock);
  let calls = 0;
  const load = (label: string) =>
    Effect.sync(() => {
      calls++;
      return options(label);
    });
  return {
    cache,
    load,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

it("answers from memory while the list is fresh and reads again after that or when asked", async () => {
  const { cache, load, calls, advance } = setup();
  const key = cache.key(parts("a"));
  const first = await Effect.runPromise(cache.read(key, load("one"), { refresh: false, standIn }));
  await Effect.runPromise(cache.read(key, load("two"), { refresh: false, standIn }));
  expect(calls()).toBe(1);
  expect(first.options[0]?.label).toBe("one");
  await Effect.runPromise(cache.read(key, load("three"), { refresh: true, standIn }));
  expect(calls()).toBe(2);
  advance(DISCOVERY_FRESH_MS + 1);
  const later = await Effect.runPromise(cache.read(key, load("four"), { refresh: false, standIn }));
  expect(later.options[0]?.label).toBe("four");
});

it("keeps at most a fixed number of lists and forgets the one used longest ago", async () => {
  const { cache, load, calls } = setup();
  for (let index = 0; index < DISCOVERY_CACHE_ENTRIES + 1; index++)
    await Effect.runPromise(cache.read(cache.key(parts(`check-${index}`)), load("x"), { refresh: false, standIn }));
  expect(calls()).toBe(DISCOVERY_CACHE_ENTRIES + 1);
  // The newest is still held. The first one left and is read again.
  await Effect.runPromise(
    cache.read(cache.key(parts(`check-${DISCOVERY_CACHE_ENTRIES}`)), load("x"), { refresh: false, standIn }),
  );
  expect(calls()).toBe(DISCOVERY_CACHE_ENTRIES + 1);
  await Effect.runPromise(cache.read(cache.key(parts("check-0")), load("x"), { refresh: false, standIn }));
  expect(calls()).toBe(DISCOVERY_CACHE_ENTRIES + 2);
});

it("forgets every list when something it depends on changes", async () => {
  const { cache, load, calls } = setup();
  const before = cache.key(parts("a"));
  await Effect.runPromise(cache.read(before, load("one"), { refresh: false, standIn }));
  cache.invalidate();
  expect(cache.key(parts("a"))).not.toBe(before);
  await Effect.runPromise(cache.read(cache.key(parts("a")), load("two"), { refresh: false, standIn }));
  expect(calls()).toBe(2);
  // A call that was already running when the change came is answered, but its list is not kept.
  const slow = cache.key(parts("b"));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Effect.runPromise(
    cache.read(
      slow,
      Effect.promise(async () => {
        await gate;
        return options("old state");
      }),
      { refresh: false, standIn },
    ),
  );
  cache.invalidate();
  release();
  await running;
  await Effect.runPromise(cache.read(cache.key(parts("b")), load("new state"), { refresh: false, standIn }));
  expect(calls()).toBe(3);
});

it("runs one call for callers that ask for the same list at once", async () => {
  const { cache } = setup();
  let runs = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow = Effect.promise(async () => {
    runs++;
    await gate;
    return options("one");
  });
  const key = cache.key(parts("a"));
  const callers = [1, 2, 3].map(() => Effect.runPromise(cache.read(key, slow, { refresh: false, standIn })));
  release();
  const answers = await Promise.all(callers);
  expect(runs).toBe(1);
  expect(new Set(answers.map((answer) => answer.readAt)).size).toBe(1);
});

it("stands in with an older list for a failure that waiting can fix, and only for one day", async () => {
  const { cache, load, advance } = setup();
  const key = cache.key(parts("a"));
  await Effect.runPromise(cache.read(key, load("one"), { refresh: false, standIn }));
  advance(DISCOVERY_FRESH_MS + 1);
  const stale = await Effect.runPromise(cache.read(key, Effect.fail("limited"), { refresh: false, standIn }));
  expect(stale).toMatchObject({ stale: true, options: [{ label: "one" }] });
  // A failure that waiting does not fix is not hidden by an older list.
  await expect(
    Effect.runPromise(cache.read(key, Effect.fail("refused"), { refresh: false, standIn })),
  ).rejects.toThrow();
  advance(DISCOVERY_STALE_MS);
  await expect(
    Effect.runPromise(cache.read(key, Effect.fail("limited"), { refresh: false, standIn })),
  ).rejects.toThrow();
});

it("names a few IDs from a current whole list only when it holds all of them", async () => {
  const { cache, load } = setup();
  const whole = cache.key(parts("a"));
  expect(cache.named(whole, ["C1AAA"])).toBeNull();
  await Effect.runPromise(cache.read(whole, load("one"), { refresh: false, standIn }));
  expect(cache.named(whole, ["C1AAA"])?.options.map((option) => option.label)).toEqual(["one"]);
  expect(cache.named(whole, ["C1AAA", "C9ZZZ"])).toBeNull();
});
