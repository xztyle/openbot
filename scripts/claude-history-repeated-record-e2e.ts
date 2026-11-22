// Checks that a Claude Code transcript that writes one record two times still imports (upstream
// 0e3cfcbb4). Runs the real Claude history reader and its disk index on a temporary transcript: one
// turn whose user record is written twice. Before, the index failed with "UNIQUE constraint failed:
// entries.uuid", nothing was saved, and each start showed the error.
// Run: `bun scripts/claude-history-repeated-record-e2e.ts`. Writes
// .openbot-build/claude-history-repeated-record-e2e/report.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { claudeHistoryReader } from "../src/backend/claude-history";
import type { ProviderHistoryFragment } from "../src/backend/provider-history";

const OUT = resolve(import.meta.dirname, "../.openbot-build/claude-history-repeated-record-e2e");
const root = await mkdtemp(join(tmpdir(), "openbot-claude-history-"));
const threadId = "11111111-2222-3333-4444-555555555555";
const projectDirectoryName = "project";
const report: { passed: boolean; fragments?: number; userItems?: number; error?: string } = { passed: false };
try {
  await mkdir(join(root, "config", "projects", projectDirectoryName), { recursive: true });
  const at = "2026-11-22T10:00:00.000Z";
  const user = {
    type: "user",
    uuid: "aaaaaaaa-0000-0000-0000-000000000001",
    parentUuid: null,
    sessionId: threadId,
    timestamp: at,
    message: { role: "user", content: "Hello." },
  };
  const assistant = {
    type: "assistant",
    uuid: "aaaaaaaa-0000-0000-0000-000000000002",
    parentUuid: user.uuid,
    sessionId: threadId,
    timestamp: at,
    message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Hi." }] },
  };
  const lines = [user, user, assistant].map((record) => JSON.stringify(record)).join("\n");
  await writeFile(join(root, "config", "projects", projectDirectoryName, `${threadId}.jsonl`), `${lines}\n`);
  const fragments: ProviderHistoryFragment[] = [];
  await Effect.runPromise(
    claudeHistoryReader({
      configDirectory: join(root, "config"),
      projectDirectoryName,
      indexDirectory: join(root, "index"),
    })({ threadId, items: "full" }, (fragment) =>
      Effect.sync(() => {
        fragments.push(fragment);
        return true;
      }),
    ),
  );
  report.fragments = fragments.length;
  report.userItems = fragments
    .flatMap((fragment) => fragment.items)
    .filter((item) => item.type === "userMessage").length;
  report.passed = report.fragments === 1 && report.userItems === 1;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  await rm(root, { recursive: true, force: true });
}
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(report.passed ? 0 : 1);
