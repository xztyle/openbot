// @vitest-environment node
// Failure modes: a program rewritten while a check runs and still taken for the approved one, a
// rewrite that keeps the size, a link that leaves the programs folder, and a stale check that costs a
// read and a hash of the whole file every 250 ms.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeEventCheckInput, type EventCheck } from "@openbot/contracts/event-checks";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCauseEffect } from "./effect-boundary";
import { EventCheckApiReader } from "./event-check-api-reader";
import { EventCheckEnvironment } from "./event-check-environment";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let root: string;
let programs: string;
let revision = 0;
/**
 * Writes the program with a modification time of its own. The clock of a file system ticks every few
 * milliseconds, so two quick writes could otherwise share one stat and one test would depend on timing.
 */
async function program(content: string): Promise<void> {
  const path = join(programs, "tickets.mjs");
  await writeFile(path, content);
  revision += 1;
  const at = new Date(1_700_000_000_000 + revision * 10_000);
  await utimes(path, at, at);
}
const programReads = () =>
  vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).endsWith("tickets.mjs")).length;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-api-reader-"));
  programs = join(root, "programs");
  await mkdir(programs);
  vi.mocked(readFileSync).mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function reader(now: () => number) {
  const environment = new EventCheckEnvironment(join(root, "private"), {
    encrypt: (value) => Buffer.from(value).toString("base64"),
    decrypt: (value) => Buffer.from(value, "base64").toString("utf8"),
  });
  return new EventCheckApiReader(environment, programs, () => true, process.execPath, now);
}

/** The check that the host approved, with the digest of the program as it is now. */
function approved(api: EventCheckApiReader): EventCheck {
  const input = api.definition(
    decodeEventCheckInput({
      agentId: "chief",
      name: "API tickets",
      instruction: "Review changes quietly.",
      active: false,
      timezone: "UTC",
      selfEvents: { mode: "include", connectionId: "job-one", actorPointer: "", accountActorIds: [] },
      source: {
        kind: "api",
        connectionId: "job-one",
        toolName: "tickets.mjs",
        variables: [],
        configuration: [],
        argumentsJson: "{}",
        cursorArgument: "cursor",
        nextCursorPointer: "/cursor",
      },
      selection: { itemsPointer: "/items", idPointer: "/id", revisionPointer: "/revision" },
    }),
  );
  return {
    ...input,
    id: randomUUID(),
    revision: "revision-1",
    nextCheckAt: "2026-10-10T00:00:00.000Z",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
  };
}

/** The `valid` function a running program polls, from a real read session. */
async function validOf(api: EventCheckApiReader, check: EventCheck): Promise<() => boolean> {
  return runCauseEffect(api.read(check, (session) => Effect.succeed(session.valid)));
}

const OLD = "process.stdout.write('{\"items\":[]}');";
// The same length as `OLD`, so only the bytes, the change time and nothing in the size tells them apart.
const SAME_SIZE = "process.stdout.write('{\"items\":{}}');";

it("reads and hashes the program once while it does not change, and sees a rewrite that keeps the size", async () => {
  await program(OLD);
  expect(SAME_SIZE.length).toBe(OLD.length);
  // A clock far past the change time of the file, as it is for a program that was approved earlier.
  const api = reader(() => Date.now() + 60_000);
  const check = approved(api);
  const valid = await validOf(api, check);
  const readsAfterSetup = programReads();
  expect(readsAfterSetup).toBeGreaterThan(0);

  for (let poll = 0; poll < 20; poll++) expect(valid()).toBe(true);
  expect(programReads()).toBe(readsAfterSetup);

  await program(SAME_SIZE);
  expect(valid()).toBe(false);
  expect(programReads()).toBe(readsAfterSetup + 1);
  // The rewrite is not remembered as the approved one: it stays refused.
  expect(valid()).toBe(false);

  await program(OLD);
  expect(valid()).toBe(true);
});

it("hashes a program again at each poll while its change time is recent", async () => {
  await program(OLD);
  const api = reader(Date.now);
  const check = approved(api);
  const valid = await validOf(api, check);
  const before = programReads();
  for (let poll = 0; poll < 3; poll++) expect(valid()).toBe(true);
  expect(programReads()).toBe(before + 3);
});

it("refuses a program that becomes a link out of the programs folder, whatever the cache holds", async () => {
  await program(OLD);
  const api = reader(() => Date.now() + 60_000);
  const check = approved(api);
  const valid = await validOf(api, check);
  expect(valid()).toBe(true);

  // The same bytes, so a digest alone would still match. The place of the file is what changed.
  const outside = join(root, "outside.mjs");
  await writeFile(outside, OLD);
  await rm(join(programs, "tickets.mjs"));
  await symlink(outside, join(programs, "tickets.mjs"));
  expect(valid()).toBe(false);
});
