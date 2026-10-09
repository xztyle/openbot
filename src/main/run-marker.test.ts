// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunMarker } from "./run-marker";

describe("RunMarker", () => {
  let directory: string;
  let path: string;
  const onError = vi.fn();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openbot-run-marker-"));
    path = join(directory, "openbot-run-state-v1.json");
    onError.mockReset();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const marker = (now: number) => new RunMarker({ path, now: () => now, onError });
  const MINUTE = 60_000;

  it("reports an unknown shutdown on the first run", async () => {
    const first = marker(1_000);
    await Effect.runPromise(first.begin());
    expect(first.state).toEqual({ lastShutdown: "unknown", startsLast24Hours: 1, startedAt: 1_000 });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ running: true });
  });

  it("reports a clean shutdown after markClean and an unclean one when the marker stays set", async () => {
    const first = marker(1_000);
    await Effect.runPromise(first.begin());
    await Effect.runPromise(first.markClean());

    const second = marker(1_000 + MINUTE);
    await Effect.runPromise(second.begin());
    expect(second.state?.lastShutdown).toBe("clean");

    // The second run never reaches markClean: a kill or a crash.
    const third = marker(1_000 + 2 * MINUTE);
    await Effect.runPromise(third.begin());
    expect(third.state).toMatchObject({ lastShutdown: "unclean", startsLast24Hours: 3 });
  });

  it("counts only the starts of the last 24 hours", async () => {
    const day = 24 * 60 * MINUTE;
    await Effect.runPromise(marker(0).begin());
    const later = marker(day + MINUTE);
    await Effect.runPromise(later.begin());
    expect(later.state?.startsLast24Hours).toBe(1);
  });

  it("treats an unreadable file as unknown and logs it, without failing the start", async () => {
    await writeFile(path, "{ not json");
    const run = marker(5_000);
    await Effect.runPromise(run.begin());
    expect(run.state?.lastShutdown).toBe("unknown");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("logs a file that cannot be written and still starts", async () => {
    await writeFile(join(directory, "blocked"), "x");
    const blocked = new RunMarker({ path: join(directory, "blocked", "state.json"), now: () => 1, onError });
    await Effect.runPromise(blocked.begin());
    expect(blocked.state?.lastShutdown).toBe("unknown");
    expect(onError).toHaveBeenCalled();
  });
});
