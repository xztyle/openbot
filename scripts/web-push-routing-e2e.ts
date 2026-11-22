// Checks which web push messages a host sends, and the address that each one opens, on a real Team API
// host (`workspace-e2e-host.ts`) with the real web push sender, sidebar store, channel and read state
// stores. Only the push service is replaced: `fetch` records each request, and the script decrypts the
// body with the browser keys it registered, as a browser does (RFC 8291).
//
// - A mention of the member in a channel sends one message with the address of the message
//   (`/app/s/<host>/<space>/c/<channel>/m/<message>`), the author and channel names and no chat text.
//   The author's own browser gets nothing.
// - A message without a mention sends nothing; a reply in a followed thread sends the thread address,
//   and nothing after the member stops following it; a DM sends the DM address.
// - The bell: a conversation set to Nothing, or muted, sends nothing; Just mentions sends a mention and
//   not a thread reply.
// - Bursts: a second notice of one conversation within the burst time comes at its end as one notice
//   that counts both and replaces the first quietly.
// - Agent events: a finished turn opens the agent's chat (`/dm/<agent>`); Just mentions lets a question
//   through and not a finished turn; Nothing lets nothing through; a turn between agents sends nothing.
// - The decision function itself on the same channels: each kind, own messages, and the level table.
//
// A check that nothing came sends a later notice that must come next: no step waits for time.
// `bun scripts/web-push-routing-e2e.ts`. Writes .openbot-build/web-push-routing-e2e/report.json.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AgentEvent, ChannelMessage, WorkspaceNotifyLevel } from "@openbot/contracts/ipc";
import { WEB_PUSH_CODECS, WEB_PUSH_ROUTES, type WebPushLevel } from "@openbot/contracts/team-protocol/web-push-v1";
import {
  WORKSPACE_READ_STATE_CODECS,
  WORKSPACE_READ_STATE_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-read-state-v1";
import {
  WORKSPACE_SIDEBAR_CODECS,
  WORKSPACE_SIDEBAR_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-sidebar-v1";
import { channelViewer } from "../src/backend/channel-visibility";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { WebPushService } from "../src/main/web-push";
import { type WebPushKind, webPushAllowed, webPushChannelKind, webPushChannelPath } from "../src/main/web-push-routing";
import { WebPushStore } from "../src/main/web-push-store";
import { webPushWorkspace } from "../src/main/web-push-workspace";
import { WorkspaceSidebarStore } from "../src/main/workspace-sidebar-store";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const BURST_MS = 400;
/** The wait of a digest here: long enough for a marker to come first. */
const DIGEST_MS = 2_000;

/** One browser of the script: its keys, as `PushManager.subscribe` makes them. */
interface Browser {
  endpoint: string;
  ecdh: ReturnType<typeof createECDH>;
  auth: Buffer;
}

interface Push {
  endpoint: string;
  urgency: string;
  message: JsonObject;
  /** The decrypted text, to check that no chat text is in it. */
  text: string;
}

function browser(name: string): Browser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/e2e-${name}-${randomUUID()}`, ecdh, auth: randomBytes(16) };
}

/** Opens an `aes128gcm` push body (RFC 8188, RFC 8291) with the browser's private key. */
function decrypt(body: Buffer, target: Browser): string {
  const salt = body.subarray(0, 16);
  const keyLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + keyLength);
  const record = body.subarray(21 + keyLength);
  const shared = target.ecdh.computeSecret(serverPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), target.ecdh.getPublicKey(), serverPublic]);
  const inputKey = Buffer.from(hkdfSync("sha256", shared, target.auth, info, 32));
  const key = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, "The record does not end with the last-record delimiter.");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

const browsers = new Map<string, Browser>();
const received: Push[] = [];
const waiters: { endpoint: string; resolve: (push: Push) => void }[] = [];

/** The push service: it records each message and answers 201, as FCM does. */
const recordPush = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const endpoint = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = browsers.get(endpoint);
  assert.ok(target, `A message went to an unknown address ${endpoint}.`);
  const body = init?.body;
  assert.ok(body instanceof Uint8Array, "The push body is not bytes.");
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("content-encoding"), "aes128gcm");
  assert.match(headers.get("authorization") ?? "", /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/u);
  const text = decrypt(Buffer.from(body), target);
  const push: Push = {
    endpoint,
    urgency: headers.get("urgency") ?? "",
    message: record(JSON.parse(text), "push"),
    text,
  };
  const waiter = waiters.findIndex((entry) => entry.endpoint === endpoint);
  if (waiter >= 0) waiters.splice(waiter, 1)[0]?.resolve(push);
  else received.push(push);
  return new Response(null, { status: 201 });
};
const pushService: typeof fetch = Object.assign(recordPush, { preconnect: fetch.preconnect });

/** The next message to a browser, in the order the host sent them. */
function nextPush(target: Browser): Promise<Push> {
  const index = received.findIndex((entry) => entry.endpoint === target.endpoint);
  const [waiting] = index >= 0 ? received.splice(index, 1) : [];
  if (waiting) return Promise.resolve(waiting);
  return new Promise((resolve) => waiters.push({ endpoint: target.endpoint, resolve }));
}

/** The sender of the running host, made with the server options. */
const made: { sender: WebPushService | null } = { sender: null };
let fixtureAgentId = "";
let fixtureThreadId = "";

const e2e = await startWorkspaceE2e(
  "web-push-routing-e2e",
  [
    "A real push service and a browser's service worker: the script is the push service and decrypts as a browser does.",
    "The WebRTC transport of the web client; it carries the same requests to the same route handlers.",
    "Agent events come from the script on the agent service's event emitter: no provider CLI runs.",
  ],
  {
    server: async ({ agents, agentStore, team, userData }) => {
      const sidebar = new WorkspaceSidebarStore(join(userData, "workspace-sidebar.json"));
      await runCauseEffect(sidebar.load());
      sidebar.onChanged((memberId) => agents.emit("event", { type: "workspace-sidebar-changed", memberId }));
      const agent = await runCauseEffect(
        agentStore.createAgent({
          name: "Push fixture",
          description: "Synthetic agent for the web push check",
          avatarSeed: "web-push-routing",
          avatarHue: null,
        }),
      );
      fixtureAgentId = agent.id;
      // A new agent has no chat thread until its first turn; the events name one that no channel owns.
      fixtureThreadId = agent.threadId ?? randomUUID();
      made.sender = new WebPushService({
        agents,
        store: new WebPushStore(join(userData, "web-push.json")),
        hostId: () => team.getIdentity()?.serverId ?? null,
        memberActive: (memberId) => {
          const member = team.getMember(memberId);
          return member !== null && !member.disabled;
        },
        hiddenAgentIds: () => new Set(),
        workspace: webPushWorkspace({
          channels: agents.channels,
          spaces: agents.spaces,
          sidebar,
          memberRole: (memberId) => team.getMember(memberId)?.role ?? null,
          hostViewer: () => null,
        }),
        burstMs: BURST_MS,
        digestMs: DIGEST_MS,
        fetch: pushService,
      });
      return { webPush: made.sender, workspaceSidebar: sidebar };
    },
  },
);
const { owner, member, step } = e2e;
const hostId = e2e.host().team.getIdentity()?.serverId ?? null;
const ownerBrowser = browser("owner");
const memberBrowser = browser("member");

function mention(person: Person, name: string): string {
  return `@[${name}](member:${person.id})`;
}

async function register(person: Person, target: Browser, level: WebPushLevel): Promise<void> {
  browsers.set(target.endpoint, target);
  const response = await e2e.optional(WEB_PUSH_CODECS, WEB_PUSH_ROUTES.register, person.token, {
    endpoint: target.endpoint,
    p256dh: target.ecdh.getPublicKey().toString("base64url"),
    auth: target.auth.toString("base64url"),
    level,
    mutedUntil: null,
    locale: "en",
  });
  assert.equal(response.status, 200, `Register returned ${response.status}.`);
}

/** Sets the member's sidebar through the route, as the web client's bell does. */
async function bell(
  person: Person,
  value: {
    muted?: string[];
    notifyMentions?: string[];
    notifyNothing?: string[];
    agentNoiseImportant?: string[];
    agentNoiseDigest?: string[];
  },
) {
  const response = await e2e.optional(WORKSPACE_SIDEBAR_CODECS, WORKSPACE_SIDEBAR_ROUTES.save, person.token, {
    order: { channels: [], direct: [] },
    muted: value.muted ?? [],
    notifyMentions: value.notifyMentions ?? [],
    notifyNothing: value.notifyNothing ?? [],
    agentNoiseImportant: value.agentNoiseImportant ?? [],
    agentNoiseDigest: value.agentNoiseDigest ?? [],
  });
  assert.equal(response.status, 200, `The sidebar save returned ${response.status}.`);
}

function messageId(entry: JsonObject): string {
  return String(entry.id);
}

function expectPath(channelId: string, threadRootId: string | null, id: string | null): string {
  return webPushChannelPath(hostId, "general", channelId, threadRootId, id);
}

function summary(push: Push) {
  const { kind, title, body, path, tag, update } = push.message;
  return { kind, title, body, path, tag, update: update ?? false };
}

try {
  await step("Both browsers register with level all", async () => {
    await register(owner, ownerBrowser, "all");
    await register(member, memberBrowser, "all");
    return { hostId };
  });

  const general = await e2e.createChannel(owner, "push-mentions", "public");
  const quietChannel = await e2e.createChannel(owner, "push-quiet", "public");
  const mutedChannel = await e2e.createChannel(owner, "push-muted", "public");
  const mentionsChannel = await e2e.createChannel(owner, "push-just-mentions", "public");
  const threadChannel = await e2e.createChannel(owner, "push-threads", "public");
  const markerChannel = await e2e.createChannel(owner, "push-markers", "public");

  let markerCount = 0;
  const nextMarker = async (label: string) => {
    markerCount += 1;
    // The burst of the marker channel ends after BURST_MS; a burst notice would come between markers.
    const channelId = await e2e.createChannel(owner, `push-marker-${markerCount}`, "public");
    const sent = await e2e.send(owner, channelId, `${mention(member, "member-user")} marker ${label}`);
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.path, expectPath(channelId, null, messageId(sent)), `A message came before ${label}.`);
  };

  await step(
    "A mention sends the member the address of the message, without the text",
    async () => {
      const sent = await e2e.send(owner, general, `${mention(member, "member-user")} secret-chat-words`);
      const push = await nextPush(memberBrowser);
      assert.equal(push.message.v, 1);
      assert.equal(push.message.kind, "mention");
      assert.equal(push.message.path, expectPath(general, null, messageId(sent)));
      assert.ok(String(push.message.path).startsWith(hostId ? `/app/s/${hostId}/general/c/` : "/app/general/c/"));
      assert.match(String(push.message.path), /^\/app(?:\/[\w%.~-]+)*$/u, "The service worker would drop this path.");
      assert.equal(push.message.tag, general);
      assert.equal(push.message.body, "Mentioned you.");
      assert.match(String(push.message.title), /push-mentions/u);
      assert.equal(push.urgency, "high");
      assert.ok(!push.text.includes("secret-chat-words"), "The message holds chat text.");
      return summary(push);
    },
    (value) => value,
  );

  await step("The author's own browser gets nothing for their message", async () => {
    // The member mentions the owner: the owner's next message is this one, not the owner's own mention.
    const sent = await e2e.send(member, quietChannel, `${mention(owner, "owner-user")} for the owner`);
    const push = await nextPush(ownerBrowser);
    assert.equal(push.message.path, expectPath(quietChannel, null, messageId(sent)));
    return summary(push);
  });

  await step("A message without a mention sends nothing", async () => {
    await e2e.send(owner, general, "no mention here");
    await nextMarker("after a plain message");
    return { marker: "next" };
  });

  await step("A second mention within the burst time comes as one notice that counts both", async () => {
    const first = await e2e.send(owner, markerChannel, `${mention(member, "member-user")} one`);
    const firstPush = await nextPush(memberBrowser);
    assert.equal(firstPush.message.path, expectPath(markerChannel, null, messageId(first)));
    assert.equal(firstPush.message.update, undefined);
    const second = await e2e.send(owner, markerChannel, `${mention(member, "member-user")} two`);
    const counted = await nextPush(memberBrowser);
    assert.equal(counted.message.update, true);
    assert.equal(counted.message.tag, markerChannel);
    assert.equal(counted.message.body, "2 new messages.");
    assert.equal(counted.message.title, "push-markers");
    assert.equal(counted.message.path, expectPath(markerChannel, null, messageId(second)));
    return { first: summary(firstPush), counted: summary(counted) };
  });

  await step("A conversation set to Nothing sends nothing, also for a mention", async () => {
    await bell(member, { notifyNothing: [quietChannel] });
    await e2e.send(owner, quietChannel, `${mention(member, "member-user")} quiet please`);
    await nextMarker("after a mention in a Nothing conversation");
    return { level: "nothing" };
  });

  await step("A muted conversation sends nothing", async () => {
    await bell(member, { muted: [mutedChannel] });
    await e2e.send(owner, mutedChannel, `${mention(member, "member-user")} muted`);
    await nextMarker("after a mention in a muted conversation");
    return { muted: true };
  });

  const root = await step("A reply in a thread the member follows sends the thread address", async () => {
    await bell(member, {});
    const rootMessage = await e2e.send(member, threadChannel, "member's thread root");
    const reply = await e2e.send(owner, threadChannel, "a reply", messageId(rootMessage));
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "reply");
    assert.equal(push.message.body, "Replied in a thread you follow.");
    assert.equal(push.message.path, expectPath(threadChannel, messageId(rootMessage), messageId(reply)));
    return { root: messageId(rootMessage), push: summary(push) };
  });

  await step("Just mentions sends a mention and not a thread reply", async () => {
    await bell(member, { notifyMentions: [mentionsChannel] });
    const rootMessage = await e2e.send(member, mentionsChannel, "root in a just-mentions channel");
    await e2e.send(owner, mentionsChannel, "a reply that is no mention", messageId(rootMessage));
    await nextMarker("after a reply in a Just mentions conversation");
    const mentioned = await e2e.send(owner, mentionsChannel, `${mention(member, "member-user")} a mention`);
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.path, expectPath(mentionsChannel, null, messageId(mentioned)));
    await bell(member, {});
    return summary(push);
  });

  await step("A thread the member stopped following sends nothing", async () => {
    const response = await e2e.optional(
      WORKSPACE_READ_STATE_CODECS,
      WORKSPACE_READ_STATE_ROUTES.followThread,
      member.token,
      { operationId: randomUUID(), channelId: threadChannel, threadRootId: root.root, followed: false },
    );
    assert.equal(response.status, 200);
    await e2e.send(owner, threadChannel, "another reply", root.root);
    await nextMarker("after a reply in an unfollowed thread");
    return { followed: false };
  });

  await step("A DM sends the DM address with the author as the title", async () => {
    const dm = randomUUID();
    await e2e.command(owner.token, {
      type: "create",
      operationId: randomUUID(),
      channelId: dm,
      kind: "dm",
      visibility: "private",
      name: "owner-user, member-user",
      humanMemberIds: [member.id],
      members: [],
    });
    const sent = await e2e.send(owner, dm, "hello in a DM");
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "dm");
    assert.equal(push.message.body, "Sent you a message.");
    assert.equal(push.message.path, expectPath(dm, null, messageId(sent)));
    assert.equal(push.message.title, String(record(sent.author, "author").name));
    return summary(push);
  });

  const agents = e2e.host().agents;
  const emit = (event: AgentEvent) => agents.emit("event", event);
  const turn = (extra: Partial<Extract<AgentEvent, { type: "turn-completed" }>> = {}): AgentEvent => ({
    type: "turn-completed",
    agentId: fixtureAgentId,
    threadId: fixtureThreadId,
    turnId: randomUUID(),
    status: "completed",
    origin: "user",
    ...extra,
  });
  const agentPath = `${hostId ? `/app/s/${hostId}` : "/app"}/general/dm/${fixtureAgentId}`;

  await step("A turn between agents sends nothing", async () => {
    assert.ok(fixtureAgentId, "The fixture agent was not made.");
    emit(turn({ agentTalk: true }));
    await nextMarker("after a turn between agents");
    return { agentTalk: true };
  });

  await step("Just mentions on the agent's chat lets a question through and not a finished turn", async () => {
    await bell(member, { notifyMentions: [`agent:${fixtureAgentId}`] });
    // The finished turn sends the member nothing, so the question is the member's next message.
    emit(turn());
    emit({
      type: "prompt",
      requestId: randomUUID(),
      agentId: fixtureAgentId,
      threadId: fixtureThreadId,
      turnId: randomUUID(),
      questions: [{ id: "q", header: "Q", question: "Which one?", options: null, isSecret: false }],
    });
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "needs-input");
    assert.equal(push.message.tag, `request:${fixtureAgentId}`);
    assert.equal(push.message.path, agentPath);
    return summary(push);
  });

  await step("Nothing on the agent's chat lets a question through no more", async () => {
    await bell(member, { notifyNothing: [`agent:${fixtureAgentId}`] });
    emit({
      type: "approval",
      approval: {
        requestId: randomUUID(),
        agentId: fixtureAgentId,
        threadId: fixtureThreadId,
        turnId: randomUUID(),
        kind: "command",
        command: "ls",
        cwd: null,
        reason: null,
        grantRoot: null,
        permissions: null,
      },
    });
    await nextMarker("after an approval in a Nothing chat");
    await bell(member, {});
    return { level: "nothing" };
  });

  await step("A finished agent turn opens the agent's chat", async () => {
    // The member's browser got no finished turn above, so no repeat check of the sender hides this one.
    emit(turn());
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "finished");
    assert.equal(push.message.path, agentPath);
    assert.equal(push.message.tag, `agent:${fixtureAgentId}`);
    assert.equal(push.message.agentId, fixtureAgentId);
    return summary(push);
  });

  // An agent's update in a thread the member follows, as the agent's turn posts it.
  const agentReply = async (rootId: string, text: string) => {
    const base = agents.channels.store.messages(threadChannel).find((entry) => entry.id === rootId);
    assert.ok(base, "The thread root is not in the store.");
    const message: ChannelMessage = {
      ...base,
      id: randomUUID(),
      author: { kind: "agent", id: fixtureAgentId, name: "Web Push Agent" },
      threadRootId: rootId,
      mentions: [],
      message: { ...base.message, text, createdAt: new Date().toISOString() },
    };
    emit({ type: "channel-message", channelId: threadChannel, message, revision: 0 });
  };

  await step("Important only drops an agent's update in a followed thread", async () => {
    // The coordinator may still answer the DM of an earlier step; its burst ends before this starts.
    await new Promise((done) => setTimeout(done, BURST_MS * 4));
    received.splice(0, received.length);
    const rootMessage = await e2e.send(member, threadChannel, "member's root for agent updates");
    const rootId = messageId(rootMessage);
    // A stored reply makes the thread one the member follows.
    await e2e.send(owner, threadChannel, "a reply that starts the thread", rootId);
    assert.equal((await nextPush(memberBrowser)).message.kind, "reply");
    await new Promise((done) => setTimeout(done, BURST_MS * 2));
    await agentReply(rootId, "progress 1 (everything)");
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "reply", "With Everything, an agent's update pushes.");
    await bell(member, { agentNoiseImportant: [fixtureAgentId] });
    await agentReply(rootId, "progress 2");
    await nextMarker("after an agent update with Important only");
    return { rootId };
  });

  await step("Digest holds an agent's updates and sends one notice that counts them", async () => {
    await bell(member, { agentNoiseDigest: [fixtureAgentId] });
    const rootMessage = await e2e.send(member, threadChannel, "member's root for a digest");
    const rootId = messageId(rootMessage);
    await e2e.send(owner, threadChannel, "a reply that starts the thread", rootId);
    assert.equal((await nextPush(memberBrowser)).message.kind, "reply");
    await new Promise((done) => setTimeout(done, BURST_MS * 2));
    await agentReply(rootId, "progress 3");
    await agentReply(rootId, "progress 4");
    await nextMarker("after two agent updates with Digest");
    const push = await nextPush(memberBrowser);
    assert.equal(push.message.kind, "summary");
    assert.equal(push.message.tag, "digest");
    assert.equal(push.message.title, "2 updates from your agents");
    assert.equal(push.message.body, "From Web Push Agent.");
    assert.equal(push.message.path, `${hostId ? `/app/s/${hostId}` : "/app"}/general/activity`);
    assert.ok(!push.text.includes("progress"), "The digest holds no chat text.");
    await bell(member, {});
    return summary(push);
  });

  await step("A digest that waits sends nothing to a browser set to Nothing meanwhile", async () => {
    await bell(member, { agentNoiseDigest: [fixtureAgentId] });
    const rootMessage = await e2e.send(member, threadChannel, "member's root for a dropped digest");
    const rootId = messageId(rootMessage);
    await e2e.send(owner, threadChannel, "a reply that starts the thread", rootId);
    assert.equal((await nextPush(memberBrowser)).message.kind, "reply");
    await new Promise((done) => setTimeout(done, BURST_MS * 2));
    await agentReply(rootId, "progress 5");
    await register(member, memberBrowser, "nothing");
    await new Promise((done) => setTimeout(done, DIGEST_MS + 500));
    await register(member, memberBrowser, "all");
    await bell(member, {});
    await nextMarker("after a digest of a browser that chose Nothing");
    return { dropped: true };
  });

  await step("The decision function sorts the host's own channels as the Activity view does", async () => {
    const store = agents.channels.store;
    const channel = store.get(threadChannel);
    const dmChannel = store
      .list(member.id, true, channelViewer(member.id, "member"))
      .find((entry) => entry.kind === "dm");
    assert.ok(dmChannel, "The DM is not in the member's list.");
    const base = store.messages(threadChannel).find((entry) => entry.id === root.root);
    assert.ok(base, "The thread root is not in the store.");
    const viewer = channelViewer(member.id, "member");
    const outsider = channelViewer("someone-else", "member");
    const message = (change: Partial<ChannelMessage>): ChannelMessage => ({
      ...base,
      author: { kind: "member", id: owner.id, name: "owner-user" },
      ...change,
    });
    const follows = (followed: boolean) => () => followed;
    const kinds = {
      mention: webPushChannelKind(
        message({ mentions: [{ kind: "member", id: member.id }] }),
        channel,
        viewer,
        follows(false),
      ),
      own: webPushChannelKind(
        message({
          author: { kind: "member", id: member.id, name: "m" },
          mentions: [{ kind: "member", id: member.id }],
        }),
        channel,
        viewer,
        follows(true),
      ),
      hereAsNonPerson: webPushChannelKind(message({ mentions: [{ kind: "here" }] }), channel, viewer, follows(false)),
      reply: webPushChannelKind(message({ threadRootId: root.root }), channel, viewer, follows(true)),
      unfollowedReply: webPushChannelKind(message({ threadRootId: root.root }), channel, viewer, follows(false)),
      plain: webPushChannelKind(message({}), channel, viewer, follows(false)),
      streaming: webPushChannelKind(
        message({ mentions: [{ kind: "member", id: member.id }], message: { ...base.message, status: "streaming" } }),
        channel,
        viewer,
        follows(false),
      ),
      dm: webPushChannelKind(message({ channelId: dmChannel.id }), dmChannel, viewer, follows(false)),
      dmOutsider: webPushChannelKind(message({ channelId: dmChannel.id }), dmChannel, outsider, follows(false)),
    };
    assert.deepEqual(kinds, {
      mention: "mention",
      own: null,
      hereAsNonPerson: null,
      reply: "reply",
      unfollowedReply: null,
      plain: null,
      streaming: null,
      dm: "dm",
      dmOutsider: null,
    });
    const table: Record<string, boolean> = {};
    const kindsToCheck: WebPushKind[] = ["mention", "dm", "reply", "needs-input", "finished"];
    const levels: WebPushLevel[] = ["all", "needs-me", "nothing"];
    const bells: (WorkspaceNotifyLevel | null)[] = [null, "mentions", "nothing"];
    for (const kind of kindsToCheck)
      for (const level of levels)
        for (const conversation of bells)
          table[`${kind}/${level}/${conversation ?? "server"}`] = webPushAllowed(kind, level, conversation);
    const expected = (kind: WebPushKind, level: WebPushLevel, conversation: WorkspaceNotifyLevel | null) => {
      if (level === "nothing" || conversation === "nothing") return false;
      if (conversation === "mentions") return kind === "mention" || kind === "needs-input";
      return kind !== "reply" || level === "all";
    };
    for (const kind of kindsToCheck)
      for (const level of levels)
        for (const conversation of bells)
          assert.equal(table[`${kind}/${level}/${conversation ?? "server"}`], expected(kind, level, conversation));
    assert.equal(
      webPushChannelPath("h/1", "my space", "c(1)", "r!1", "m*1"),
      "/app/s/h%2F1/my%20space/c/c%281%29/t/r%211/m/m%2a1",
    );
    return { kinds, table };
  });

  e2e.report.passed = true;
} finally {
  await made.sender?.dispose();
  await e2e.finish();
}
