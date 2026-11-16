// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { claudeHistoryReader } from "./claude-history";
import type { ProviderHistoryFragment } from "./provider-history";

// Failure mode: a provider history import stores a second copy of what a live turn already showed.
// Claude Code writes its own entries in the user role (a skill's instructions) and in the assistant
// role ("No response requested."). The reader took the first as the start of a new turn, so the rest
// of the live turn was imported again under another turn, and it took the second as an answer.
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const SESSION = "5f0c8b8e-6a43-4c47-9f39-0d1f5c1f4a10";
const CWD = "/data/OpenBot/Agents/agent-test";

/** One line of a Claude Code transcript, with the fields that the reader uses. */
interface TranscriptRecord {
  type: "user" | "assistant";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  isMeta?: boolean;
  message: { role: "user" | "assistant"; model?: string; content: unknown };
}

function record(fields: TranscriptRecord): string {
  return JSON.stringify({ isSidechain: false, sessionId: SESSION, ...fields });
}

async function readFragments(lines: readonly string[]): Promise<ProviderHistoryFragment[]> {
  const root = await mkdtemp(join(tmpdir(), "openbot-claude-history-test-"));
  directories.push(root);
  const project = join(root, "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(project, { recursive: true });
  await writeFile(join(project, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
  const fragments: ProviderHistoryFragment[] = [];
  await Effect.runPromise(
    claudeHistoryReader({ configDirectory: root, indexDirectory: join(root, "index") })(
      { threadId: SESSION, cwd: CWD, items: "full", providerOnly: true },
      (fragment) =>
        Effect.sync(() => {
          fragments.push(fragment);
          return true;
        }),
    ),
  );
  return fragments;
}

describe("Claude history reader", () => {
  it("keeps a turn whole across Claude Code's own entries and leaves out its synthetic replies", async () => {
    const fragments = await readFragments([
      record({
        type: "user",
        uuid: "turn-1",
        parentUuid: null,
        timestamp: "2026-11-16T10:53:47.653Z",
        message: { role: "user", content: "Write the checklist." },
      }),
      record({
        type: "assistant",
        uuid: "call-skill",
        parentUuid: "turn-1",
        timestamp: "2026-11-16T10:53:48.614Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "tool_use", id: "toolu_skill", name: "Skill", input: {} }],
        },
      }),
      record({
        type: "user",
        uuid: "skill-result",
        parentUuid: "call-skill",
        timestamp: "2026-11-16T10:53:48.630Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_skill", content: "ok" }] },
      }),
      record({
        type: "user",
        uuid: "skill-text",
        parentUuid: "skill-result",
        isMeta: true,
        timestamp: "2026-11-16T10:53:48.633Z",
        message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /skills/qa" }] },
      }),
      record({
        type: "assistant",
        uuid: "narration",
        parentUuid: "skill-text",
        timestamp: "2026-11-16T10:53:49.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [
            { type: "text", text: "Reading the golden rules, then writing the checklist." },
            { type: "tool_use", id: "toolu_read", name: "Read", input: {} },
          ],
        },
      }),
      record({
        type: "user",
        uuid: "read-result",
        parentUuid: "narration",
        timestamp: "2026-11-16T10:53:50.000Z",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_read", content: "rules" }] },
      }),
      record({
        type: "assistant",
        uuid: "answer",
        parentUuid: "read-result",
        timestamp: "2026-11-16T10:53:59.000Z",
        message: {
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "The checklist is done." }],
        },
      }),
      record({
        type: "user",
        uuid: "turn-2",
        parentUuid: "answer",
        timestamp: "2026-11-16T10:55:16.000Z",
        message: { role: "user", content: "FYI, no reply needed." },
      }),
      record({
        type: "assistant",
        uuid: "synthetic",
        parentUuid: "turn-2",
        timestamp: "2026-11-16T10:55:16.339Z",
        message: {
          role: "assistant",
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
      }),
    ]);

    expect(fragments.map((fragment) => fragment.turnId).sort()).toEqual(["turn-1", "turn-2"]);
    const firstTurn = fragments.filter((fragment) => fragment.turnId === "turn-1").flatMap((part) => part.items);
    const texts = (items: typeof firstTurn) =>
      items.flatMap((item) => (item.type === "agentMessage" && typeof item.text === "string" ? [item.text] : []));
    expect(texts(firstTurn)).toEqual([
      "Reading the golden rules, then writing the checklist.",
      "The checklist is done.",
    ]);
    expect(firstTurn.find((item) => item.id === "answer")?.phase).toBeUndefined();
    const secondTurn = fragments.filter((fragment) => fragment.turnId === "turn-2").flatMap((part) => part.items);
    expect(texts(secondTurn)).toEqual([]);
  });
});
