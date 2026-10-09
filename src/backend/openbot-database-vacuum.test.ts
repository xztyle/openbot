// @vitest-environment node

// Failure mode: a VACUUM on a nearly full disk fills it, and then every later write of the
// application fails. The compaction is only an optimization after a committed migration, so it is skipped.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vacuumWhenDiskAllows } from "./openbot-database-schema";

describe("vacuumWhenDiskAllows", () => {
  let directory: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openbot-vacuum-"));
    db = new DatabaseSync(join(directory, "openbot.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE rows (body TEXT)");
    const insert = db.prepare("INSERT INTO rows VALUES (?)");
    for (let index = 0; index < 400; index += 1) insert.run("x".repeat(2000));
    db.exec("DELETE FROM rows");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  });

  afterEach(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  it("skips the compaction and says why when the disk is too full", async () => {
    const before = (await stat(join(directory, "openbot.db"))).size;
    const warn = vi.fn();
    vacuumWhenDiskAllows(db, 13, { warn, freeBytes: () => 1024 });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("not enough free disk space");
    expect((await stat(join(directory, "openbot.db"))).size).toBe(before);
  });

  it("compacts the database when the disk has room", async () => {
    const before = (await stat(join(directory, "openbot.db"))).size;
    const warn = vi.fn();
    vacuumWhenDiskAllows(db, 13, { warn, freeBytes: () => 10 * 1024 ** 3 });
    expect(warn).not.toHaveBeenCalled();
    expect((await stat(join(directory, "openbot.db"))).size).toBeLessThan(before);
  });
});
