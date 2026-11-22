// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import { registerSecretValue } from "@openbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { hideChannelSecrets, storedAgentText } from "./channel-secrets";
import { ChannelStore } from "./channel-store";
import { runCauseEffect } from "./effect-boundary";
import { OpenBotDatabase } from "./openbot-database";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function channelStore() {
  const root = await mkdtemp(join(tmpdir(), "openbot-channel-secrets-"));
  roots.push(root);
  const database = new OpenBotDatabase(root);
  await runCauseEffect(database.initialize());
  const store = new ChannelStore(database);
  const channel = store.create("channel-1", {
    name: "ops",
    title: "Ops",
    instructions: "",
    members: [{ agentId: "agent-a" }],
    leadAgentId: "agent-a",
  });
  store.commit("create", { channel, messages: [], tasks: [], assignments: [] });
  return { store, database };
}

const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4)}`;

function message(
  id: string,
  text: string,
  author: ChannelMessage["author"],
  extra: Partial<ChannelMessage> = {},
  status: "streaming" | "completed" = "completed",
): ChannelMessage {
  return {
    id,
    channelId: "channel-1",
    sequence: 0,
    author,
    taskId: null,
    superseded: false,
    ...extra,
    message: { id, author: "user", text, createdAt: "2026-11-22T10:00:00.000Z", status },
  };
}

const person = { kind: "member" as const, id: "discord:42", name: "Ana" };
const agent = { kind: "agent" as const, id: "agent-a", name: "A" };

function task(requestMessageId: string, instruction: string): ChannelTask {
  return {
    id: `task-${requestMessageId}`,
    channelId: "channel-1",
    parentTaskId: null,
    rootTaskId: `task-${requestMessageId}`,
    ownerAgentId: "agent-a",
    requestMessageId,
    instruction,
    attachmentDraftIds: [],
    expectedResult: "",
    sourceMessageIds: [],
    dependencies: [],
    resources: [],
    state: "queued",
    revision: 1,
    assignmentCount: 0,
    error: null,
  };
}

const storedJson = (database: OpenBotDatabase) =>
  [
    ...database.connection.prepare("SELECT message_json AS json FROM projection_channel_messages").all(),
    ...database.connection.prepare("SELECT task_json AS json FROM projection_channel_tasks").all(),
    ...database.connection.prepare("SELECT payload_json AS json FROM orchestration_events").all(),
  ]
    .map((row) => String(row.json))
    .join("\n");

// Failure mode: only the composers hid a pasted key. A message that a Discord bridge, an access link
// or an older client sent, and an agent's answer that quoted a saved key, were stored as written:
// the agents, the search, the previews, the push text and the Discord mirror all read the key.
describe("channel secrets", () => {
  it("stores a bridged person's message, and the task it asks for, without the key", async () => {
    const { store, database } = await channelStore();
    const sent = message("m-1", `here is the deploy key ${GITHUB} and password: Hunter22!`, person, {
      externalAuthor: { kind: "external", platform: "discord", id: "42", name: "Ana" },
    });
    store.update(store.get("channel-1"), { messages: [sent], tasks: [task("m-1", sent.message.text)] });

    const stored = store.message("channel-1", "m-1");
    expect(stored?.message.text).toBe("here is the deploy key [hidden: GitHub token] and password: [hidden: password]");
    expect(store.tasks("channel-1")[0]?.instruction).toBe(stored?.message.text);
    expect(storedJson(database)).not.toContain(GITHUB);
    expect(storedJson(database)).not.toContain("Hunter22!");
  });

  it("hides a key in an edit", async () => {
    const { store } = await channelStore();
    store.update(store.get("channel-1"), { messages: [message("m-1", "draft", person)] });
    store.update(store.get("channel-1"), { messages: [message("m-1", `token=${GITHUB}`, person)] });
    expect(store.message("channel-1", "m-1")?.message.text).toBe("token=[hidden: GitHub token]");
  });

  it("hides a saved secret and a key shape in an agent's answer, its condensed original and its note", async () => {
    const { store, database } = await channelStore();
    const saved = "Zq8vLmN3pR7tWx2K";
    registerSecretValue(saved);
    const answer = message("m-2", `The key is ${saved}.`, agent, {
      condensed: { original: `Long answer with ${GITHUB}` },
      agentNote: { to: ["agent-b"], summary: `use ${saved}` },
    });
    store.update(store.get("channel-1"), {
      messages: [{ ...answer, message: { ...answer.message, condensed: { original: `Long answer with ${GITHUB}` } } }],
    });

    const stored = store.message("channel-1", "m-2");
    expect(stored?.message.condensed?.original).toBe("Long answer with [hidden: GitHub token]");
    expect(stored?.message.text).toBe("The key is [hidden: saved secret].");
    expect(stored?.condensed?.original).toBe("Long answer with [hidden: GitHub token]");
    expect(stored?.agentNote?.summary).toBe("use [hidden: saved secret]");
    expect(storedJson(database)).not.toContain(saved);
  });

  it("hides a key in a streaming part of an answer", async () => {
    const { store, database } = await channelStore();
    store.update(store.get("channel-1"), { messages: [message("m-3", "Here", agent, {}, "streaming")] });
    expect(store.updateStreaming("channel-1", [message("m-3", `Here: ${GITHUB}`, agent, {}, "streaming")])).toBe(true);
    expect(store.message("channel-1", "m-3")?.message.text).toBe("Here: [hidden: GitHub token]");
    expect(storedJson(database)).not.toContain(GITHUB);
  });

  it("keeps an agent's code that names a password, and a person's plain talk", () => {
    expect(hideChannelSecrets('password = os.getenv("DB_PASSWORD")', "agent")).toBe(
      'password = os.getenv("DB_PASSWORD")',
    );
    expect(hideChannelSecrets("The password is correct.", "person")).toBe("The password is correct.");
  });

  // Failure mode: the channel compared an agent's raw thread text with the row the store had hidden,
  // so a reply that held a key was written again on each event and its result showed twice.
  it("gives an agent's thread text as the store keeps it", async () => {
    const { store } = await channelStore();
    const thread = {
      id: "m-4",
      author: "assistant" as const,
      text: `Key: ${GITHUB}`,
      createdAt: "",
      status: "completed" as const,
    };
    store.update(store.get("channel-1"), { messages: [message("m-4", thread.text, agent)] });
    expect(storedAgentText(thread).text).toBe(store.message("channel-1", "m-4")?.message.text);
    const plain = { ...thread, text: "No key here." };
    expect(storedAgentText(plain)).toBe(plain);
  });

  it("leaves a message that the composer already hid as it is", () => {
    const text = "token: [hidden: GitHub token]";
    expect(hideChannelSecrets(text, "person")).toBe(text);
  });
});
