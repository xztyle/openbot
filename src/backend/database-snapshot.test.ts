import { mkdtemp, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSnapshotError, readSchemaVersion, writeDatabaseSnapshot } from "./database-snapshot";

describe("writeDatabaseSnapshot", () => {
  let directory: string;
  let live: DatabaseSync;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "openbot-snapshot-"));
    live = new DatabaseSync(join(directory, "openbot.db"));
    live.exec("PRAGMA journal_mode = WAL");
    // Keep the WAL: the snapshot has to include writes that no checkpoint has moved yet.
    live.exec("PRAGMA wal_autocheckpoint = 0");
    live.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    live.exec("INSERT INTO schema_migrations VALUES (8, 'a'), (9, 'b')");
    live.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    live.exec("INSERT INTO notes (body) VALUES ('first'), ('second')");
  });

  afterEach(async () => {
    live.close();
    await rm(directory, { recursive: true, force: true });
  });

  const run = (destination: string, options?: Parameters<typeof writeDatabaseSnapshot>[2]) =>
    Effect.runPromise(Effect.result(writeDatabaseSnapshot(live, destination, options)));

  async function failureCode(destination: string, options?: Parameters<typeof writeDatabaseSnapshot>[2]) {
    const result = await run(destination, options);
    if (Result.isSuccess(result)) throw new Error("The snapshot should have failed.");
    expect(result.failure).toBeInstanceOf(DatabaseSnapshotError);
    return result.failure.code;
  }

  it("copies the data, including the WAL, into one private file that opens on its own", async () => {
    const destination = join(directory, "snapshot.db");
    const result = await run(destination);
    if (Result.isFailure(result)) throw result.failure;

    expect(result.success).toMatchObject({ path: destination, schemaVersion: 9 });
    expect(result.success.bytes).toBe((await stat(destination)).size);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    // No partial file and no WAL file stay beside the snapshot.
    expect((await readdir(directory)).filter((name) => name.startsWith("snapshot.db"))).toEqual(["snapshot.db"]);

    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      expect(copy.prepare("SELECT body FROM notes ORDER BY id").all()).toEqual([{ body: "first" }, { body: "second" }]);
      expect(readSchemaVersion(copy)).toBe(9);
    } finally {
      copy.close();
    }
  });

  it("does not change the live database", async () => {
    await run(join(directory, "snapshot.db"));
    live.exec("INSERT INTO notes (body) VALUES ('third')");
    expect(live.prepare("SELECT COUNT(*) AS count FROM notes").get()).toEqual({ count: 3 });
  });

  it("refuses to replace an existing file or link", async () => {
    const existing = join(directory, "existing.db");
    await writeFile(existing, "keep me");
    expect(await failureCode(existing)).toBe("exists");
    await symlink(join(directory, "missing-target"), join(directory, "dangling.db"));
    expect(await failureCode(join(directory, "dangling.db"))).toBe("exists");
    // The live database is an existing file too.
    expect(await failureCode(join(directory, "openbot.db"))).toBe("exists");
    expect(await readdir(directory)).not.toContainEqual(expect.stringContaining(".partial-"));
  });

  it("refuses a relative path and a missing directory", async () => {
    expect(await failureCode("snapshot.db")).toBe("invalid_path");
    expect(await failureCode(join(directory, "missing", "snapshot.db"))).toBe("no_directory");
  });

  it("stops before it writes when the disk is too small", async () => {
    expect(await failureCode(join(directory, "snapshot.db"), { freeBytes: async () => 0 })).toBe("no_space");
    expect(await readdir(directory)).not.toContain("snapshot.db");
  });
});
