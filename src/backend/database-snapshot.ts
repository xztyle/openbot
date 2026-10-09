import { randomUUID } from "node:crypto";
import { chmod, link, lstat, open, stat, statfs, unlink } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { Effect, Schema } from "effect";

/**
 * An operator-initiated copy of `openbot.db`, written while OpenBot runs. Nothing here runs by
 * itself: the full database has no automatic backup, because its time and disk cost is unbounded.
 * The control socket (`openbot backup <path>`) is the only caller.
 *
 * The copy uses the SQLite online backup API, so it is a consistent point in time even while the
 * WAL holds uncheckpointed writes. The result is one self-contained file: the copy leaves WAL mode,
 * so no `-wal` or `-shm` file has to travel with it. The file is private (mode 0600), it never
 * replaces an existing file, and it appears at its final name only after `PRAGMA integrity_check`
 * passed on it. The module has no Electron import and never imports the database facade.
 */

/** Pages per backup step. Each step returns to the event loop, so a large copy does not freeze OpenBot. */
const PAGES_PER_STEP = 256;
/** The copy is never larger than the live files, so this margin covers file system overhead. */
const FREE_SPACE_MARGIN = 1.1;
const MIN_FREE_SPACE_BYTES = 1024 * 1024;

export class DatabaseSnapshotError extends Schema.TaggedError<DatabaseSnapshotError>()("DatabaseSnapshotError", {
  code: Schema.Literals([
    "invalid_path",
    "no_directory",
    "exists",
    "no_space",
    "backup_failed",
    "verify_failed",
    "write_failed",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface DatabaseSnapshot {
  path: string;
  bytes: number;
  /** The newest applied migration of the copy. */
  schemaVersion: number | null;
}

export interface DatabaseSnapshotOptions {
  /** Tests only. The free bytes of the file system that holds the directory. */
  freeBytes?: (directory: string) => Promise<number>;
}

/** The newest applied migration, or null when the database has none (a database that is not OpenBot's). */
export function readSchemaVersion(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  const version = row?.version;
  return typeof version === "number" ? version : null;
}

function fail(code: DatabaseSnapshotError["code"], cause?: unknown): DatabaseSnapshotError {
  return new DatabaseSnapshotError({ code, cause });
}

function io<A>(code: DatabaseSnapshotError["code"], operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (cause) => fail(code, cause) });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function liveDatabasePath(source: DatabaseSync): string | null {
  const row = source
    .prepare("PRAGMA database_list")
    .all()
    .find((entry) => entry.name === "main");
  return typeof row?.file === "string" && row.file !== "" ? row.file : null;
}

/** Throws unless the whole database passes `PRAGMA integrity_check`. Leaves WAL mode, so the copy is one file. */
function verifyCopy(path: string): number | null {
  const copy = new DatabaseSync(path);
  try {
    copy.exec("PRAGMA journal_mode = DELETE");
    const rows = copy.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") throw new Error("integrity_check reported a problem.");
    return readSchemaVersion(copy);
  } finally {
    copy.close();
  }
}

export const writeDatabaseSnapshot = Effect.fn("DatabaseSnapshot.write")(function* (
  source: DatabaseSync,
  destination: string,
  options: DatabaseSnapshotOptions = {},
): Effect.fn.Return<DatabaseSnapshot, DatabaseSnapshotError> {
  if (!isAbsolute(destination)) return yield* fail("invalid_path");
  const directory = dirname(destination);
  const directoryStat = yield* io("no_directory", () => stat(directory));
  if (!directoryStat.isDirectory()) return yield* fail("no_directory");
  // Any file counts, including a dangling link. The final step is a link that fails on an existing name.
  const existing = yield* io("write_failed", () =>
    lstat(destination).then(
      () => true,
      (error: unknown) => {
        if (isMissing(error)) return false;
        throw error;
      },
    ),
  );
  if (existing) return yield* fail("exists");

  const livePath = liveDatabasePath(source);
  if (livePath) {
    const liveBytes = yield* io(
      "write_failed",
      async () => (await sizeOf(livePath)) + (await sizeOf(`${livePath}-wal`)),
    );
    const free = yield* io("write_failed", () =>
      options.freeBytes ? options.freeBytes(directory) : statfs(directory).then((s) => s.bavail * s.bsize),
    );
    if (free < liveBytes * FREE_SPACE_MARGIN + MIN_FREE_SPACE_BYTES) return yield* fail("no_space");
  }

  const partial = `${destination}.partial-${randomUUID().slice(0, 8)}`;
  const removePartial = io("write_failed", () =>
    Promise.all(
      [partial, `${partial}-journal`, `${partial}-wal`, `${partial}-shm`].map((p) => unlink(p).catch(() => {})),
    ),
  ).pipe(Effect.ignore);

  return yield* Effect.gen(function* () {
    // An empty file is a valid target for both copy methods, and it is private from its first byte.
    yield* io("write_failed", async () => (await open(partial, "wx", 0o600)).close());
    if (typeof backup === "function") {
      yield* io("backup_failed", () => backup(source, partial, { rate: PAGES_PER_STEP }));
    } else {
      yield* io("backup_failed", async () => source.exec(`VACUUM INTO '${partial.replaceAll("'", "''")}'`));
    }
    const schemaVersion = yield* Effect.try({
      try: () => verifyCopy(partial),
      catch: (cause) => fail("verify_failed", cause),
    });
    yield* io("write_failed", async () => {
      await chmod(partial, 0o600);
      const handle = await open(partial, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // `link` fails when the name exists, so a file that appeared during the copy is never replaced.
      await link(partial, destination);
    }).pipe(
      Effect.mapError((error) =>
        error.cause instanceof Error && "code" in error.cause && error.cause.code === "EEXIST"
          ? fail("exists", error.cause)
          : error,
      ),
    );
    yield* removePartial;
    const bytes = yield* io("write_failed", async () => (await stat(destination)).size);
    return { path: destination, bytes, schemaVersion };
  }).pipe(Effect.tapError(() => removePartial));
});
