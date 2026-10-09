// @vitest-environment node
// Failure modes: a value in the audit file, an unbounded file, a lost row at rotation, and a damaged
// line that hides the rows after it.
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SecurityAuditLog } from "./security-audit-log";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "openbot-audit-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const entry = (action: string, extra: Partial<Parameters<SecurityAuditLog["append"]>[0]> = {}) => ({
  actor: { kind: "agent" as const, id: "chief", name: "Chief" },
  action,
  target: { kind: "event-check", id: "c1", agentId: "chief", name: "Linear" },
  ...extra,
});

it("appends one JSON row a line, newest first on read, readable by the user only", () => {
  const log = new SecurityAuditLog(join(directory, "audit.jsonl"), { now: () => new Date("2026-01-01T00:00:00Z") });
  log.append(entry("event-check.create"));
  log.append(entry("event-check.delete", { outcome: "refused", names: ["TOKEN"] }));
  expect(log.read(10).map((row) => row.action)).toEqual(["event-check.delete", "event-check.create"]);
  expect(log.read(1)).toHaveLength(1);
  expect(log.read(10)[0]).toMatchObject({ at: "2026-01-01T00:00:00.000Z", outcome: "refused", names: ["TOKEN"] });
  expect(statSync(join(directory, "audit.jsonl")).mode & 0o077).toBe(0);
});

it("redacts a credential that reaches a name and keeps every row on one line", () => {
  const log = new SecurityAuditLog(join(directory, "audit.jsonl"));
  log.append(
    entry("event-check.save", {
      actor: { kind: "member", id: "m1", name: "Ana\nghp_abcdefghijklmnopqrstuvwxyz0123" },
      target: { kind: "event-check", name: "Bearer abcdefghijklmnop12345" },
    }),
  );
  const text = readFileSync(join(directory, "audit.jsonl"), "utf8");
  expect(text.trim().split("\n")).toHaveLength(1);
  expect(text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
  expect(text).not.toContain("abcdefghijklmnop12345");
});

it("rotates at the size cap, keeps a bounded number of files and loses no recent row", () => {
  const path = join(directory, "audit.jsonl");
  const log = new SecurityAuditLog(path, { maxBytes: 600, rotatedFiles: 2 });
  for (let index = 0; index < 40; index++) log.append(entry(`event-check.save-${index}`));
  expect(readdirSync(directory).sort()).toEqual(["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"]);
  for (const file of readdirSync(directory)) expect(statSync(join(directory, file)).size).toBeLessThan(1200);
  const rows = log.read(1000);
  expect(rows[0]?.action).toBe("event-check.save-39");
  expect(new Set(rows.map((row) => row.action)).size).toBe(rows.length);
});

it("skips a damaged line and never throws from a write that fails", () => {
  const path = join(directory, "audit.jsonl");
  const log = new SecurityAuditLog(path);
  log.append(entry("one"));
  appendFileSync(path, "{not json\n");
  log.append(entry("two"));
  expect(log.read(10).map((row) => row.action)).toEqual(["two", "one"]);
  const failures: unknown[] = [];
  const broken = new SecurityAuditLog(join(path, "inside-a-file.jsonl"), { onError: (error) => failures.push(error) });
  expect(() => broken.append(entry("three"))).not.toThrow();
  expect(failures).toHaveLength(1);
});
