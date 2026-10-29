// Checks the workspace limits that this branch closes, on the real services of a temporary profile:
//
// - The Discord channel bridge (`src/backend/channel-bridge.ts`): reactions in both directions,
//   Discord threads as workspace threads, and a workspace post that someone deletes in Discord. A
//   Gateway event goes through Signal's normalizer (`remote/api/src/discord-events.ts`), a JSON round
//   trip and the host's decoder, into the real Discord driver, messaging service, channel service
//   and bridge. Signal's API (`makeDiscordApi`) runs over a fake Discord REST client, and the webhook
//   calls go to a fake `fetch`.
// - The artifact index (`src/backend/workspace-artifacts.ts`) on the real channel store: it is stored
//   in a file, and a new instance catches up from the stored sequence instead of reading the
//   channel again. The thumbnails (`src/backend/workspace-thumbnails.ts`) with a fake capture port:
//   a failed capture leaves the drawing and is not tried again soon, a good one sets a version, and
//   a private address is never loaded.
//
// `bun scripts/workspace-limits-e2e.ts`. Writes .openbot-build/workspace-limits-e2e/report.json.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentEvent, ChannelMessage } from "@openbot/contracts/ipc";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { decodeDiscordApiError, decodeDiscordDelivery } from "@openbot/contracts/signal-protocol/discord-api";
import { Effect } from "effect";
import { type DiscordRestRequest, DiscordTransportError, makeDiscordApi } from "../remote/api/src/discord-api";
import { type DiscordAction, DiscordState } from "../remote/api/src/discord-events";
import type { AgentBrowserHost } from "../src/backend/agent/turn-lifecycle";
import { AgentService } from "../src/backend/agent-service";
import { AgentStore } from "../src/backend/agent-store";
import { ChannelBridge } from "../src/backend/channel-bridge";
import { ChannelStore } from "../src/backend/channel-store";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { MailboxStore } from "../src/backend/mailbox-store";
import { discordDriver } from "../src/backend/messaging/discord/discord-driver";
import { type MessagingCredentials, MessagingService } from "../src/backend/messaging/messaging-service";
import { MessagingThreads } from "../src/backend/messaging/messaging-threads";
import {
  DiscordApiError,
  type IngressHandler,
  MessagingAdapterError,
  type MessagingIngress,
} from "../src/backend/messaging/messaging-types";
import { OpenBotDatabase } from "../src/backend/openbot-database";
import { SidebarLayoutStore } from "../src/backend/sidebar-layout-store";
import { WorkspaceArtifactIndex } from "../src/backend/workspace-artifacts";
import { WorkspaceThumbnailCaptureFailed, WorkspaceThumbnails } from "../src/backend/workspace-thumbnails";
import { WorkspaceSidebarStore } from "../src/main/workspace-sidebar-store";

const OUT = resolve(import.meta.dirname, "../.openbot-build/workspace-limits-e2e");
const REPORT = join(OUT, "report.json");
const root = await mkdtemp(join(tmpdir(), "openbot-workspace-limits-"));
const userData = join(root, "user-data");
const home = join(root, "home");
const APP = "300000000000000001";
const GUILD = "100000000000000001";
const DISCORD_CHANNEL = "110000000000000001";
const WEBHOOK_ID = "120000000000000001";
const WEBHOOK_TOKEN = "webhook-token";
const ANA = "500000000000000001";
const BOB = "500000000000000002";
const OWNER = { id: "owner", name: "Owner" };

interface Step {
  name: string;
  passed: boolean;
  detail?: unknown;
  error?: string;
}

const report: { steps: Step[]; passed: boolean; unverified: string[] } = {
  steps: [],
  passed: false,
  unverified: [
    "The Discord Gateway and REST API: a fake REST client and a fake webhook `fetch` stand in for Discord.",
    "The Signal ingress socket: the fake ingress takes `discord-listen` with `changes`, `reactions` and `threads`, as `src/main/signal-ingress.ts` sends them, and Signal's normalizer runs in this process.",
    "Whether Discord sends MESSAGE_CREATE of a public thread to a bot that did not join it: Signal joins each new thread of a listened channel, so this check does not depend on it.",
  ],
};

async function step(name: string, run: () => Promise<unknown>): Promise<void> {
  const entry: Step = { name, passed: false };
  report.steps.push(entry);
  try {
    entry.detail = await run();
    entry.passed = true;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

/** Waits for a state, at most 15 seconds, so a change that never comes fails the check. */
async function waitFor<T>(what: string, read: () => T | null | undefined | false): Promise<T> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}.`);
    await new Promise((done) => setTimeout(done, 25));
  }
}

const unused = () => Effect.die(new Error("Not used by this check."));
const browser: AgentBrowserHost = {
  listTabs: () => [],
  beginTakeover: unused,
  endTakeover: () => {},
  userControlTabFor: () => null,
  awaitUserControlRelease: unused,
  resolveUploadTarget: unused,
  handleDynamicTool: unused,
  onChanged: () => () => {},
  onControlChanged: () => () => {},
  onDocumentChanged: () => () => {},
  clearControls: () => {},
  endControl: () => {},
  close: () => Effect.void,
  clearAgentSession: () => Effect.void,
};

/** A Gateway event as Discord sends it. JSON, as on the wire. */
function gateway(t: string, d: unknown): Parameters<DiscordState["handle"]>[0] {
  return JSON.parse(JSON.stringify({ op: 0, s: 1, t, d }));
}

// --- The fake Discord ---

const calls: DiscordRestRequest[] = [];
const webhookCalls: Array<{ method: string; url: string; content: string }> = [];
let nextDiscordId = 600000000000000000n;
const discordId = () => {
  nextDiscordId += 1n;
  return nextDiscordId.toString();
};

const rest = {
  request: (input: DiscordRestRequest) =>
    Effect.suspend(() => {
      calls.push(input);
      const route = input.route;
      if (route.includes("/reactions/")) return Effect.succeed({});
      if (route.includes("/thread-members/")) return Effect.succeed({});
      if (input.method === "POST" && /^\/channels\/[0-9]+\/messages$/u.test(route))
        return Effect.succeed({ id: discordId() });
      if (input.method === "POST" && route === `/channels/${DISCORD_CHANNEL}/webhooks`)
        return Effect.succeed({ id: WEBHOOK_ID, token: WEBHOOK_TOKEN });
      if (route === `/guilds/${GUILD}/roles`) return Effect.succeed([{ id: GUILD, permissions: "8" }]);
      if (route === `/guilds/${GUILD}/members/${APP}`) return Effect.succeed({ roles: [] });
      if (route === `/guilds/${GUILD}/channels`)
        return Effect.succeed([{ id: DISCORD_CHANNEL, type: 0, name: "general", permission_overwrites: [] }]);
      if (route === `/guilds/${GUILD}/threads/active`) return Effect.succeed({ threads: [], members: [] });
      return Effect.fail(new DiscordTransportError({ status: 404 }));
    }),
};

/** The webhook calls of the bridge, straight to Discord. A deleted post answers 404. */
const deletedPosts = new Set<string>();
const fakeWebhook = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  webhookCalls.push({ method, url, content: isDynamicRecord(body) && isString(body.content) ? body.content : "" });
  const edited = /\/messages\/([0-9]+)/u.exec(url)?.[1];
  if (edited && deletedPosts.has(edited)) return new Response(JSON.stringify({ code: 10008 }), { status: 404 });
  if (method === "POST") return Response.json({ id: discordId() });
  if (method === "DELETE") return new Response(null, { status: 204 });
  return Response.json({ id: edited ?? "0" });
};
const fakeFetch: typeof fetch = Object.assign(fakeWebhook, { preconnect: fetch.preconnect });

// What the host asked Signal to listen to, as `signal-service.ts` keeps it for its socket.
const listened = new Set<string>();
const signal = new DiscordState(
  APP,
  (_guildId, channelId) => listened.has(channelId),
  (_guildId, channelId) => listened.has(channelId),
  {
    reactions: (_guildId, channelId) => listened.has(channelId),
    threads: (_guildId, parentChannelId) => listened.has(parentChannelId),
  },
);
signal.handle(
  gateway("READY", {
    v: 10,
    user: { id: APP, username: "OpenBot", bot: true },
    application: { id: APP, flags: 0 },
    guilds: [{ id: GUILD, unavailable: true }],
    session_id: "session",
    resume_gateway_url: "wss://gateway.discord.gg",
    shard: [0, 1],
  }),
);
signal.handle(
  gateway("GUILD_CREATE", {
    id: GUILD,
    name: "Nightly",
    channels: [{ id: DISCORD_CHANNEL, type: 0, name: "general" }],
  }),
);
const signalApi = makeDiscordApi(rest, signal);

let relayHandler: IngressHandler | null = null;
const ingress: MessagingIngress = {
  acquire: () => () => {},
  state: () => "online",
  onState: () => () => {},
  handle: (handler) => {
    relayHandler = handler;
  },
  telegram: { available: () => false, call: unused, download: unused, upload: unused },
  reconnect: () => {},
  onDiscordRoutes: () => () => {},
  setDiscordListen: (_guildId, channelIds) => {
    listened.clear();
    for (const channelId of channelIds) listened.add(channelId);
  },
  discord: (request, decode) =>
    signalApi.call(request, null).pipe(
      Effect.map((result) => decode(JSON.parse(JSON.stringify(result)))),
      Effect.mapError((failure) => {
        const body = decodeDiscordApiError({ error: { code: failure.code } });
        return new MessagingAdapterError({ cause: new DiscordApiError(request.op, body?.code ?? "discord_failed") });
      }),
    ),
};

/** Gives a Gateway event to Signal, and each delivery that Signal makes to the host. */
async function discordEvent(t: string, d: unknown): Promise<DiscordAction[]> {
  const actions = signal.handle(gateway(t, d));
  for (const action of actions) {
    if (action.type !== "deliver") continue;
    const delivery = decodeDiscordDelivery(JSON.parse(JSON.stringify(action.delivery)));
    const handler = relayHandler;
    assert.ok(handler, "The messaging service has no relay handler.");
    const answer = await runCauseEffect(handler(action.guildId, { platform: "discord", delivery }));
    assert.equal(answer.status, 200);
  }
  return actions;
}

function personMessage(id: string, authorId: string, content: string, channelId = DISCORD_CHANNEL) {
  return {
    id,
    channel_id: channelId,
    guild_id: GUILD,
    type: 0,
    content,
    timestamp: new Date().toISOString(),
    author: { id: authorId, username: authorId === ANA ? "Ana" : "Bob" },
    mentions: [],
    attachments: [],
  };
}

function reaction(messageId: string, userId: string, emoji: { id: string | null; name: string }, channelId?: string) {
  return {
    user_id: userId,
    channel_id: channelId ?? DISCORD_CHANNEL,
    message_id: messageId,
    guild_id: GUILD,
    emoji,
    burst: false,
    type: 0,
    ...(userId === APP ? {} : { member: { nick: null, user: { id: userId, username: "Ana" } } }),
  };
}

function memoryCredentials(): MessagingCredentials {
  const values = new Map<string, Record<string, string>>();
  return {
    keys: () => [...values.keys()],
    status: (connectionId) => (values.has(connectionId) ? "saved" : "missing"),
    get: (connectionId) => values.get(connectionId) ?? null,
    set: (connectionId, value) => Effect.sync(() => void values.set(connectionId, value)),
    clear: (connectionId) => Effect.sync(() => void values.delete(connectionId)),
    retain: (connectionIds) =>
      Effect.sync(() => {
        for (const key of values.keys()) if (!connectionIds.has(key)) values.delete(key);
      }),
  };
}
const credentials = memoryCredentials();

interface Booted {
  agents: AgentService;
  messaging: MessagingService;
  threads: MessagingThreads;
  bridge: ChannelBridge;
}

async function boot<T>(use: (services: Booted) => Promise<T>): Promise<T> {
  const database = new OpenBotDatabase(userData);
  const store = new AgentStore(userData, home, database);
  const mailbox = new MailboxStore(userData, store.sharedRoot, store.database);
  const sidebar = new SidebarLayoutStore(join(userData, "sidebar-layout.json"));
  await runCauseEffect(sidebar.initialize());
  await runCauseEffect(store.initialize());
  await runCauseEffect(mailbox.initialize());
  const agents = new AgentService({ store, mailbox, browser, sidebarLayout: sidebar });
  const threads = new MessagingThreads(store.database, mailbox, {
    schedule: () => {},
    queueChanged: () => {},
    busy: () => false,
    interrupt: unused,
    forgetThread: () => Effect.void,
    ownChat: () => false,
  });
  const messaging = new MessagingService({
    threads,
    agents: {
      listAgents: () => agents.listAgents(),
      respondToApproval: (input) => agents.respondToApproval(input),
      onEvent: () => () => {},
      createAgentProfile: (input) => agents.createAgentProfile(input),
      createMemory: (input) => agents.createMemory(input),
      ensureDeletable: (agentId) => agents.ensureAgentDeletable(agentId),
      deleteAgent: (agentId) => agents.deleteAgent(agentId),
      sidebarChatIds: () => agents.sidebarChatIds(),
    },
    credentials,
    drivers: [discordDriver({ ingress })],
    downloadsRoot: join(userData, "messaging-downloads"),
    ingress,
    sidebar,
  });
  await runCauseEffect(messaging.start());
  const bridge = new ChannelBridge({
    channels: agents.channels,
    messaging,
    onEvent: (listener: (event: AgentEvent) => void) => {
      agents.on("event", listener);
      return () => agents.off("event", listener);
    },
    path: join(userData, "openbot-channel-bridge-v1.json"),
    fetch: fakeFetch,
  });
  bridge.start();
  try {
    return await use({ agents, messaging, threads, bridge });
  } finally {
    await runCauseEffect(bridge.stop());
    await runCauseEffect(messaging.stop());
    await runCauseEffect(agents.stop());
    database.close();
  }
}

/** The workspace messages of the channel, thread replies too. */
function messagesOf(agents: AgentService, channelId: string): ChannelMessage[] {
  return agents.channels.store.messages(channelId);
}

interface BridgeRecord {
  id: string;
  discordIds: string[];
  threadId?: string;
  postedIn?: string;
  reactions?: string[];
}

/** The bridge's records of a channel, as its host-only file has them. */
function bridgeRecords(channelId: string): BridgeRecord[] {
  const file = JSON.parse(readFileSync(join(userData, "openbot-channel-bridge-v1.json"), "utf8"));
  if (!isDynamicRecord(file) || !isDynamicRecord(file.links)) return [];
  const link = file.links[channelId];
  if (!isDynamicRecord(link) || !Array.isArray(link.messages)) return [];
  return link.messages.flatMap((item: unknown): BridgeRecord[] =>
    isDynamicRecord(item) && isString(item.id) && Array.isArray(item.discordIds)
      ? [
          {
            id: item.id,
            discordIds: item.discordIds.filter(isString),
            ...(isString(item.threadId) ? { threadId: item.threadId } : {}),
            ...(isString(item.postedIn) ? { postedIn: item.postedIn } : {}),
            ...(Array.isArray(item.reactions) ? { reactions: item.reactions.filter(isString) } : {}),
          },
        ]
      : [],
  );
}

function bridged(agents: AgentService, channelId: string, discordMessageId: string): ChannelMessage | undefined {
  const record = bridgeRecords(channelId).find((item) => item.discordIds.includes(discordMessageId));
  return record ? (agents.channels.store.message(channelId, record.id) ?? undefined) : undefined;
}

function bridgeRecord(channelId: string, workspaceMessageId: string): BridgeRecord | undefined {
  return bridgeRecords(channelId).find((item) => item.id === workspaceMessageId);
}

function hasReaction(message: ChannelMessage | null | undefined, emoji: string, actorId: string): boolean {
  return (message?.reactions ?? []).some(
    (item) => item.emoji === emoji && item.actors.some((actor) => actor.id === actorId),
  );
}

const CHANNEL = "ws-limits-general";
let operation = 0;
const op = () => {
  operation += 1;
  return `ws-limits-${operation}`;
};

try {
  await boot(async ({ threads }) => {
    const record = threads.store.ensureConnection("discord", GUILD, "Nightly");
    threads.store.updateConnection(record.connectionId, { enabled: true });
    await runCauseEffect(credentials.set(record.connectionId, { guildId: GUILD, guildName: "Nightly", appId: APP }));
  });

  await boot(async ({ agents }) => {
    const command = (value: Parameters<AgentService["channels"]["command"]>[0]) =>
      runCauseEffect(agents.channels.command(value, OWNER));

    await step("a workspace channel is bridged with a Discord channel, and Signal listens to it", async () => {
      await command({
        type: "create",
        operationId: op(),
        channelId: CHANNEL,
        kind: "channel",
        visibility: "public",
        name: "general",
        humanMemberIds: [OWNER.id],
        members: [],
      });
      await command({
        type: "link-discord",
        operationId: op(),
        channelId: CHANNEL,
        connectionId: GUILD,
        discordChannelId: DISCORD_CHANNEL,
      });
      const link = agents.channels.store.get(CHANNEL).discordLink;
      assert.equal(link?.channelId, DISCORD_CHANNEL);
      assert.equal(link?.webhook, true);
      await waitFor("Signal listens to the channel", () => listened.has(DISCORD_CHANNEL));
      return { webhook: link?.webhook };
    });

    const anaPost = discordId();
    let anaMessage: ChannelMessage | undefined;
    await step("a Discord message of a person becomes a workspace message", async () => {
      await discordEvent("MESSAGE_CREATE", personMessage(anaPost, ANA, "hello from Discord"));
      anaMessage = await waitFor("the bridged message", () => bridged(agents, CHANNEL, anaPost));
      assert.equal(anaMessage.externalAuthor?.id, ANA);
      return { messageId: anaMessage.id };
    });

    await step("a Discord reaction of a person is a workspace reaction of discord-<id>", async () => {
      await discordEvent("MESSAGE_REACTION_ADD", reaction(anaPost, ANA, { id: null, name: "🎉" }));
      const id = anaMessage?.id ?? "";
      await waitFor("the workspace reaction", () =>
        hasReaction(agents.channels.store.message(CHANNEL, id), "🎉", `discord-${ANA}`),
      );
      // OpenBot's own reaction and a custom emoji do not come in.
      const own = signal.handle(gateway("MESSAGE_REACTION_ADD", reaction(anaPost, APP, { id: null, name: "👀" })));
      const custom = signal.handle(
        gateway("MESSAGE_REACTION_ADD", reaction(anaPost, BOB, { id: "130000000000000001", name: "party" })),
      );
      assert.equal(own.length, 0, "Signal passed OpenBot's own reaction on.");
      assert.equal(custom.length, 0, "Signal passed a custom emoji on.");
      await discordEvent("MESSAGE_REACTION_REMOVE", reaction(anaPost, ANA, { id: null, name: "🎉" }));
      await waitFor(
        "the workspace reaction goes",
        () => !hasReaction(agents.channels.store.message(CHANNEL, id), "🎉", `discord-${ANA}`),
      );
      // A Discord person's reaction is not mirrored back as OpenBot's reaction.
      assert.ok(!calls.some((call) => call.route.includes(encodeURIComponent("🎉"))));
      return { emoji: "🎉", actor: `discord-${ANA}` };
    });

    await step("a workspace reaction is OpenBot's reaction on the Discord post, and its removal too", async () => {
      const id = anaMessage?.id ?? "";
      const route = `/channels/${DISCORD_CHANNEL}/messages/${anaPost}/reactions/${encodeURIComponent("👍")}/@me`;
      await command({
        type: "react",
        operationId: op(),
        channelId: CHANNEL,
        messageId: id,
        emoji: "👍",
        action: "add",
      });
      await waitFor("OpenBot reacts in Discord", () =>
        calls.some((call) => call.method === "PUT" && call.route === route),
      );
      // A short code is not a unicode emoji: Discord does not get it.
      await command({
        type: "react",
        operationId: op(),
        channelId: CHANNEL,
        messageId: id,
        emoji: ":custom:",
        action: "add",
      });
      await command({
        type: "react",
        operationId: op(),
        channelId: CHANNEL,
        messageId: id,
        emoji: "👍",
        action: "remove",
      });
      await waitFor("OpenBot removes its reaction in Discord", () =>
        calls.some((call) => call.method === "DELETE" && call.route === route),
      );
      assert.ok(!calls.some((call) => call.route.includes(encodeURIComponent(":custom:"))));
      await waitFor("the bridge forgets its reaction", () => bridgeRecord(CHANNEL, id)?.reactions === undefined);
      return { route: "PUT and DELETE" };
    });

    let threadReply: ChannelMessage | undefined;
    await step("a Discord thread from a bridged message is the workspace thread of that message", async () => {
      // A thread that starts from a message has the id of that message.
      const actions = await discordEvent("THREAD_CREATE", {
        id: anaPost,
        guild_id: GUILD,
        parent_id: DISCORD_CHANNEL,
        type: 11,
        name: "hello thread",
        newly_created: true,
      });
      assert.ok(
        actions.some((action) => action.type === "join-thread" && action.channelId === anaPost),
        "Signal did not join the new thread.",
      );
      const inThread = discordId();
      await discordEvent("MESSAGE_CREATE", personMessage(inThread, BOB, "a reply in the thread", anaPost));
      threadReply = await waitFor("the thread reply", () => bridged(agents, CHANNEL, inThread));
      assert.equal(threadReply.threadRootId, anaMessage?.id);
      assert.equal(bridgeRecord(CHANNEL, anaMessage?.id ?? "")?.threadId, anaPost);
      // A reaction in the thread reaches the reply.
      await discordEvent("MESSAGE_REACTION_ADD", reaction(inThread, ANA, { id: null, name: "✅" }, anaPost));
      const replyId = threadReply.id;
      await waitFor("the reaction in the thread", () =>
        hasReaction(agents.channels.store.message(CHANNEL, replyId), "✅", `discord-${ANA}`),
      );
      return { threadRootId: threadReply.threadRootId };
    });

    await step("a workspace thread reply goes into the Discord thread of its root", async () => {
      const before = webhookCalls.length;
      await command({
        type: "send",
        operationId: op(),
        channelId: CHANNEL,
        text: "an answer from the workspace",
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
        threadRootId: anaMessage?.id ?? null,
      });
      const post = await waitFor("the webhook post", () =>
        webhookCalls.slice(before).find((call) => call.method === "POST"),
      );
      const url = new URL(post.url);
      assert.equal(url.searchParams.get("thread_id"), anaPost);
      // In a thread, no reply line links the root.
      assert.ok(!post.content.includes("↪"));
      const reply = messagesOf(agents, CHANNEL).find((item) => item.message.text === "an answer from the workspace");
      await waitFor("the post is in the thread", () => bridgeRecord(CHANNEL, reply?.id ?? "")?.postedIn === anaPost);
      return { threadId: url.searchParams.get("thread_id") };
    });

    await step("a thread that starts without a bridged message makes its first message the root", async () => {
      const thread = discordId();
      await discordEvent("THREAD_CREATE", {
        id: thread,
        guild_id: GUILD,
        parent_id: DISCORD_CHANNEL,
        type: 11,
        name: "new topic",
        newly_created: true,
      });
      // The "started a thread" line in the channel is a system message: Signal leaves it out.
      const system = signal.handle(
        gateway("MESSAGE_CREATE", { ...personMessage(discordId(), ANA, "new topic"), type: 18 }),
      );
      assert.equal(system.length, 0);
      const first = discordId();
      const second = discordId();
      await discordEvent("MESSAGE_CREATE", personMessage(first, ANA, "first in the new thread", thread));
      const rootMessage = await waitFor("the new root", () => bridged(agents, CHANNEL, first));
      assert.equal(rootMessage.threadRootId, undefined);
      await discordEvent("MESSAGE_CREATE", personMessage(second, BOB, "second in the new thread", thread));
      const reply = await waitFor("the reply", () => bridged(agents, CHANNEL, second));
      assert.equal(reply.threadRootId, rootMessage.id);
      return { root: rootMessage.id };
    });

    await step(
      "a workspace post that someone deletes in Discord stays, and its edit calls Discord no more",
      async () => {
        const before = webhookCalls.length;
        await command({
          type: "send",
          operationId: op(),
          channelId: CHANNEL,
          text: "a post that Discord loses",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        });
        const message = await waitFor("the workspace post", () =>
          messagesOf(agents, CHANNEL).find((item) => item.message.text === "a post that Discord loses"),
        );
        const posted = await waitFor("its Discord id", () => bridgeRecord(CHANNEL, message.id)?.discordIds[0]);
        assert.ok(webhookCalls.length > before);
        deletedPosts.add(posted);
        await discordEvent("MESSAGE_DELETE", { id: posted, channel_id: DISCORD_CHANNEL, guild_id: GUILD });
        await waitFor(
          "the bridge forgets the deleted post",
          () => bridgeRecord(CHANNEL, message.id)?.discordIds.length === 0,
        );
        const kept = agents.channels.store.message(CHANNEL, message.id);
        assert.ok(kept && !kept.deletedAt, "The workspace message was deleted.");
        await command({ type: "edit", operationId: op(), channelId: CHANNEL, messageId: message.id, text: "edited" });
        // A later post in the same settle shows that the edit was handled before it.
        const marker = webhookCalls.length;
        await command({
          type: "send",
          operationId: op(),
          channelId: CHANNEL,
          text: "the next post",
          recipientAgentId: null,
          replyToMessageId: null,
          attachmentDraftIds: [],
        });
        await waitFor("the next post", () => webhookCalls.slice(marker).some((call) => call.method === "POST"));
        assert.ok(
          !webhookCalls.some((call) => call.method === "PATCH" && call.url.includes(`/messages/${posted}`)),
          "The bridge edited a post that is gone.",
        );
        return { kept: true };
      },
    );
  });

  await step("the sidebar order and mutes are kept on the host for each member, across a restart", async () => {
    const path = join(userData, "openbot-workspace-sidebar-v1.json");
    const first = new WorkspaceSidebarStore(path);
    await Effect.runPromise(first.load());
    assert.equal(first.get("member-a"), null);
    await Effect.runPromise(
      first.set("member-a", { order: { channels: ["c2", "c1", "c2"], direct: ["d1"] }, muted: ["c1"] }),
    );
    await Effect.runPromise(first.set("member-b", { order: { channels: [], direct: [] }, muted: ["d9"] }));
    const tooMany = await Effect.runPromise(
      Effect.exit(
        first.set("member-a", {
          order: { channels: Array.from({ length: 501 }, (_, index) => `c${index}`), direct: [] },
          muted: [],
        }),
      ),
    );
    assert.equal(tooMany._tag, "Failure", "The store took more than 500 ids.");
    const second = new WorkspaceSidebarStore(path);
    await Effect.runPromise(second.load());
    // A repeated id keeps its first place; each member has their own value.
    assert.deepEqual(second.get("member-a"), { order: { channels: ["c2", "c1"], direct: ["d1"] }, muted: ["c1"] });
    assert.deepEqual(second.get("member-b")?.muted, ["d9"]);
    return { members: 2 };
  });

  await step("the artifact index is stored, and a new instance reads only the new messages", async () => {
    const database = new OpenBotDatabase(join(root, "artifacts-state"));
    await runCauseEffect(database.initialize());
    try {
      const store = new ChannelStore(database);
      const channel = store.create("artifacts-channel", {
        name: "artifacts",
        title: "artifacts",
        instructions: "",
        members: [],
        leadAgentId: null,
      });
      let sequence = 0;
      const agentMessage = (id: string, text: string): ChannelMessage => {
        sequence += 1;
        return {
          id,
          channelId: channel.id,
          sequence,
          author: { kind: "agent", id: "agent-builder", name: "Builder" },
          taskId: null,
          superseded: false,
          message: {
            id,
            author: "assistant",
            text,
            createdAt: new Date(Date.now() - 60_000 + sequence * 1_000).toISOString(),
            status: "completed",
          },
        };
      };
      store.commit("artifacts-create", {
        channel,
        messages: [agentMessage("m1", "Your app is live: https://cake.delynith.com"), agentMessage("m2", "Done.")],
        tasks: [],
        assignments: [],
      });
      const reads = { whole: 0, after: 0, one: 0 };
      const channels = {
        exists: (id: string) => store.exists(id),
        messages: (id: string, before?: number, limit?: number) => {
          if (limit === undefined) reads.whole += 1;
          return store.messages(id, before, limit);
        },
        messagesAfter: (id: string, after: number) => {
          reads.after += 1;
          return store.messagesAfter(id, after);
        },
        message: (id: string, messageId: string) => {
          reads.one += 1;
          return store.message(id, messageId);
        },
      };
      const path = join(root, "openbot-workspace-artifacts-v1.json");
      const access = { channelIds: [channel.id], agentVisible: () => true };
      const first = new WorkspaceArtifactIndex({ database, channels, path });
      const before = first.list({}, access).artifacts.map((artifact) => artifact.url);
      assert.deepEqual(before, ["https://cake.delynith.com/"]);
      await Effect.runPromise(first.stop());
      const stored = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(stored.version, 1);
      // While OpenBot is off: a new artifact message, and the first one is deleted.
      store.commit("artifacts-more", {
        channel,
        messages: [
          agentMessage("m3", "The site: https://launch.openbot.site"),
          { ...agentMessage("m1", ""), sequence: 1, deletedAt: new Date().toISOString() },
        ],
        tasks: [],
        assignments: [],
      });
      reads.whole = 0;
      reads.after = 0;
      const second = new WorkspaceArtifactIndex({ database, channels, path });
      const after = second.list({}, access).artifacts.map((artifact) => artifact.url);
      await Effect.runPromise(second.stop());
      assert.deepEqual(after, ["https://launch.openbot.site/"]);
      assert.equal(reads.whole, 0, "The new instance read the whole channel again.");
      assert.ok(reads.after >= 1, "The new instance did not read the new messages.");
      return { storedSequence: stored.channels[channel.id]?.sequence, reads };
    } finally {
      database.close();
    }
  });

  await step("a failed thumbnail capture leaves the drawing and is not tried again within the window", async () => {
    let captures = 0;
    const id = `artifact-${"a".repeat(32)}`;
    const failing = new WorkspaceThumbnails({
      directory: join(root, "thumbnails-failing"),
      capture: () => {
        captures += 1;
        return Effect.fail(new WorkspaceThumbnailCaptureFailed({ reason: "timeout" }));
      },
      resolve: () => Effect.succeed(["93.184.216.34"]),
    });
    failing.request(id, "https://example.com/");
    await Effect.runPromise(failing.whenIdle());
    failing.request(id, "https://example.com/");
    await Effect.runPromise(failing.whenIdle());
    await Effect.runPromise(failing.stop());
    assert.equal(captures, 1, "A failed page was captured again at once.");
    assert.equal(failing.version(id) ?? null, null);
    assert.ok(failing.state(id)?.failedAt, "The failure is not kept.");
    // A new instance on the same folder keeps the failure too.
    const again = new WorkspaceThumbnails({
      directory: join(root, "thumbnails-failing"),
      capture: () => {
        captures += 1;
        return Effect.fail(new WorkspaceThumbnailCaptureFailed({ reason: "load" }));
      },
      resolve: () => Effect.succeed(["93.184.216.34"]),
    });
    again.request(id, "https://example.com/");
    await Effect.runPromise(again.whenIdle());
    await Effect.runPromise(again.stop());
    assert.equal(captures, 1, "A restart captured a failed page again at once.");
    return { captures };
  });

  await step("a good capture sets the thumbnail version, and a private address is never loaded", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 1, 2, 3]);
    const loaded: string[] = [];
    const thumbnails = new WorkspaceThumbnails({
      directory: join(root, "thumbnails"),
      capture: (url) => {
        loaded.push(url);
        return Effect.succeed({ bytes: png, mimeType: "image/png" as const });
      },
      resolve: (host) => Effect.succeed(host === "intranet.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
    });
    const id = `artifact-${"b".repeat(32)}`;
    thumbnails.request(id, "https://example.com/");
    thumbnails.request(`artifact-${"c".repeat(32)}`, "https://intranet.example.com/");
    thumbnails.request(`artifact-${"d".repeat(32)}`, "http://127.0.0.1/");
    thumbnails.request(`artifact-${"e".repeat(32)}`, "http://[::ffff:7f00:1]/");
    thumbnails.request(`artifact-${"f".repeat(32)}`, "http://router.local/");
    await Effect.runPromise(thumbnails.whenIdle());
    const version = thumbnails.version(id);
    assert.ok(version, "The good capture has no version.");
    const file = thumbnails.file(id, version);
    assert.ok(file && readFileSync(file.path).length === png.length, "The thumbnail file is missing.");
    assert.equal(file.mimeType, "image/png");
    assert.deepEqual(loaded, ["https://example.com/"], "A private address was loaded.");
    await Effect.runPromise(thumbnails.stop());
    return { version, refused: 4 };
  });

  report.passed = true;
} finally {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
}
// The report names steps and ids only: no message text.
assert.ok(!readFileSync(REPORT, "utf8").includes("hello from Discord"), "The report contains message text.");
process.stdout.write(`Workspace limits check passed. Report: ${REPORT}\n`);
