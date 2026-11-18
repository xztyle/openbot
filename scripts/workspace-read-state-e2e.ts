// Checks the per-thread read state of the workspace (`workspace-read-state-v1`, under `fork-host-v1`)
// on a real Team API host (`workspace-e2e-host.ts`), as the web client and a remote desktop reach it:
//
// - Reading a channel does not read its threads; reading a thread does, forward only.
// - A person follows a thread they started, replied to or were mentioned in; a choice to stop wins
//   over a later mention, and their own reply follows it again. The Threads view of the activity lists
//   the followed threads with the unread count of the thread position.
// - Mark unread moves the channel or the thread position to just before a message, also back; the
//   channel `read` command still moves it forward only.
// - Each change reaches only the person's own sessions (`workspace-read-state-changed`).
// - A channel the person cannot see answers 404; a client without `fork-host-v1` gets 400.
// - The state survives a rebuild of the channel from its events and a host restart, and the thread
//   query uses the thread index.
//
// `bun scripts/workspace-read-state-e2e.ts`. Writes .openbot-build/workspace-read-state-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  WORKSPACE_READ_STATE_CODECS,
  WORKSPACE_READ_STATE_ROUTES,
  workspaceReadStateEvent,
} from "@openbot/contracts/team-protocol/workspace-read-state-v1";
import { WORKSPACE_CODECS, WORKSPACE_ROUTES } from "@openbot/contracts/team-protocol/workspace-v1";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const e2e = await startWorkspaceE2e("workspace-read-state-e2e", [
  "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
  "The desktop IPC handlers and the preview mock. `typecheck:node` and `typecheck:renderer` check their shapes; no window runs here.",
]);
const { owner, member, step } = e2e;

interface ThreadState {
  channelId: string;
  rootId: string;
  followed: boolean;
  throughSequence: number;
  unreadCount: number;
}

function threadState(value: unknown): ThreadState {
  const entry = record(value, "thread state");
  assert.equal(typeof entry.followed, "boolean");
  return {
    channelId: String(entry.channelId),
    rootId: String(entry.rootId),
    followed: entry.followed === true,
    throughSequence: Number(entry.throughSequence),
    unreadCount: Number(entry.unreadCount),
  };
}

async function readState(path: string, person: Person, body: JsonObject): Promise<{ status: number; body: unknown }> {
  return e2e.optional(WORKSPACE_READ_STATE_CODECS, path, person.token, body);
}

async function states(person: Person, channelId: string, rootIds?: string[]): Promise<ThreadState[]> {
  const response = await readState(WORKSPACE_READ_STATE_ROUTES.threadStates, person, {
    channelId,
    ...(rootIds ? { rootIds } : {}),
  });
  assert.equal(response.status, 200, `Thread states returned ${response.status}: ${JSON.stringify(response.body)}`);
  const body = record(response.body, "thread states");
  assert.equal(body.channelId, channelId);
  assert.ok(Array.isArray(body.threads));
  return body.threads.map(threadState);
}

async function stateOf(person: Person, channelId: string, rootId: string): Promise<ThreadState> {
  const [state] = await states(person, channelId, [rootId]);
  assert.ok(state, `No state for thread ${rootId}.`);
  return state;
}

async function readThread(person: Person, channelId: string, rootId: string, through: number): Promise<ThreadState> {
  const response = await readState(WORKSPACE_READ_STATE_ROUTES.readThread, person, {
    operationId: randomUUID(),
    channelId,
    threadRootId: rootId,
    throughSequence: through,
  });
  assert.equal(response.status, 200, `Read thread returned ${response.status}: ${JSON.stringify(response.body)}`);
  return threadState(response.body);
}

async function follow(person: Person, channelId: string, rootId: string, followed: boolean): Promise<ThreadState> {
  const response = await readState(WORKSPACE_READ_STATE_ROUTES.followThread, person, {
    operationId: randomUUID(),
    channelId,
    threadRootId: rootId,
    followed,
  });
  assert.equal(response.status, 200, `Follow returned ${response.status}: ${JSON.stringify(response.body)}`);
  return threadState(response.body);
}

async function markUnread(
  person: Person,
  channelId: string,
  messageId: string,
  threadRootId?: string,
): Promise<{ status: number; body: unknown }> {
  return readState(WORKSPACE_READ_STATE_ROUTES.markUnread, person, {
    operationId: randomUUID(),
    channelId,
    messageId,
    ...(threadRootId ? { threadRootId } : {}),
  });
}

/** Sends a message and answers it as the channel page has it. */
async function send(person: Person, channelId: string, text: string, threadRootId?: string): Promise<JsonObject> {
  const body: JsonObject = {
    type: "send",
    operationId: randomUUID(),
    channelId,
    text,
    recipientAgentId: null,
    replyToMessageId: null,
    attachmentDraftIds: [],
  };
  // A reply in a thread is a workspace command; a top-level message takes the released route.
  if (threadRootId) await e2e.command(person.token, { ...body, threadRootId });
  else await e2e.releasedCommand(person.token, body);
  const page = await e2e.page(person.token, channelId, threadRootId);
  assert.ok(Array.isArray(page.messages));
  const found = page.messages
    .map((entry) => record(entry, "message"))
    .find((entry) => record(entry.message, "message body").text === text);
  assert.ok(found, `The message "${text}" is not on the page.`);
  return found;
}

async function createChannel(person: Person, name: string, visibility: "public" | "private"): Promise<string> {
  const channelId = randomUUID();
  await e2e.command(person.token, {
    type: "create",
    operationId: randomUUID(),
    channelId,
    kind: "channel",
    visibility,
    name,
    humanMemberIds: [],
    members: [],
  });
  // Members answer for themselves, so a message in a channel with no agent asks no lead to route it.
  await e2e.command(person.token, {
    type: "set-routing",
    operationId: randomUUID(),
    channelId,
    routing: "responders",
  });
  return channelId;
}

async function activityThreads(person: Person): Promise<JsonObject[]> {
  const codec = WORKSPACE_CODECS.get(WORKSPACE_ROUTES.activity);
  assert.ok(codec);
  const response = await e2e.call("POST", WORKSPACE_ROUTES.activity, { token: person.token, body: codec.request({}) });
  assert.equal(response.status, 200);
  const body = record(codec.response(response.status, response.body), "activity");
  assert.ok(Array.isArray(body.threads));
  return body.threads.map((entry) => record(entry, "activity thread"));
}

const readStateEvent = (channelId: string, threadRootId?: string) => (value: unknown) => {
  const event = workspaceReadStateEvent(value);
  return event && event.channelId === channelId && event.threadRootId === threadRootId ? event : null;
};

try {
  const channelId = await step("setup: the owner makes #launch and the member joins", async () => {
    const id = await createChannel(owner, "launch", "public");
    await e2e.command(member.token, { type: "join", operationId: randomUUID(), channelId: id });
    return id;
  });
  const ownerSocket = await e2e.openEvents(owner.token);
  const memberSocket = await e2e.openEvents(member.token);

  const thread = await step("a reply follows the thread for its author and the root's author", async () => {
    const root = await send(owner, channelId, "Ship the launch page today?");
    const reply = await send(member, channelId, "Yes, after the copy review.", String(root.id));
    const ownerState = await stateOf(owner, channelId, String(root.id));
    const memberState = await stateOf(member, channelId, String(root.id));
    assert.equal(ownerState.followed, true, "The root's author does not follow the thread.");
    assert.equal(
      ownerState.unreadCount,
      1,
      `The reply is not unread for the root's author: ${JSON.stringify((await e2e.page(owner.token, channelId, String(root.id))).messages)}`,
    );
    assert.equal(memberState.followed, true, "The reply's author does not follow the thread.");
    assert.equal(memberState.unreadCount, 0, "The reply's author has their own reply unread.");
    assert.equal(memberState.throughSequence, Number(reply.sequence), "Writing a reply did not read the thread.");
    return { rootId: String(root.id), replySequence: Number(reply.sequence), ownerState, memberState };
  });

  await step("reading the channel does not read its threads", async () => {
    const page = await e2e.page(owner.token, channelId);
    await e2e.releasedCommand(owner.token, {
      type: "read",
      operationId: randomUUID(),
      channelId,
      throughSequence: Number(page.throughSequence),
    });
    const summary = (await e2e.channels(owner.token)).find((entry) => entry.id === channelId);
    assert.equal(summary?.unreadCount, 0, "The channel is still unread.");
    const state = await stateOf(owner, channelId, thread.rootId);
    assert.equal(state.unreadCount, 1, "Reading the channel read the thread.");
    const listed = (await activityThreads(owner)).find((entry) => entry.rootId === thread.rootId);
    assert.equal(listed?.unreadCount, 1, "The Threads view lost the unread reply.");
    return { channelThrough: Number(page.throughSequence), thread: state };
  });

  await step("reading the thread reads it forward only, and only the reader's sessions hear it", async () => {
    const heard = e2e.nextMessage(ownerSocket, readStateEvent(channelId, thread.rootId));
    const quiet = e2e.noMessage(
      memberSocket,
      (value) => workspaceReadStateEvent(value)?.threadRootId === thread.rootId,
    );
    const read = await readThread(owner, channelId, thread.rootId, thread.replySequence);
    assert.equal(read.unreadCount, 0);
    assert.equal(read.throughSequence, thread.replySequence);
    await heard;
    await quiet;
    const back = await readThread(owner, channelId, thread.rootId, 0);
    assert.equal(back.throughSequence, thread.replySequence, "A read moved the position back.");
    const listed = (await activityThreads(owner)).find((entry) => entry.rootId === thread.rootId);
    assert.equal(listed?.unreadCount, 0);
    return read;
  });

  await step("a new reply is unread for the other person until they read the thread", async () => {
    const reply = await send(owner, channelId, "Copy review is done.", thread.rootId);
    const memberState = await stateOf(member, channelId, thread.rootId);
    assert.equal(memberState.unreadCount, 1);
    const ownerState = await stateOf(owner, channelId, thread.rootId);
    assert.equal(ownerState.unreadCount, 0);
    assert.equal(ownerState.throughSequence, Number(reply.sequence));
    return { memberState, ownerState };
  });

  const mentioned = await step("a mention in a reply follows the thread for the person it names", async () => {
    const root = await send(member, channelId, "Who checks the analytics?");
    const before = await stateOf(owner, channelId, String(root.id));
    assert.equal(before.followed, false, "A thread nobody named the owner in is followed.");
    await send(member, channelId, "Draft numbers are ready.", String(root.id));
    assert.equal((await stateOf(owner, channelId, String(root.id))).followed, false);
    await send(member, channelId, `@[Owner](member:${owner.id}) can you check them?`, String(root.id));
    const after = await stateOf(owner, channelId, String(root.id));
    assert.equal(after.followed, true, "The mention did not follow the thread.");
    assert.equal(after.unreadCount, 2);
    return { rootId: String(root.id), after };
  });

  await step("stopping wins over a later mention; the person's own reply follows again", async () => {
    const heard = e2e.nextMessage(ownerSocket, readStateEvent(channelId, mentioned.rootId));
    const stopped = await follow(owner, channelId, mentioned.rootId, false);
    assert.equal(stopped.followed, false);
    await heard;
    await send(member, channelId, `@[Owner](member:${owner.id}) any news?`, mentioned.rootId);
    assert.equal((await stateOf(owner, channelId, mentioned.rootId)).followed, false, "A mention overrode the choice.");
    const followedIds = (await states(owner, channelId)).map((entry) => entry.rootId);
    assert.ok(!followedIds.includes(mentioned.rootId), "The followed list has an unfollowed thread.");
    assert.ok(!(await activityThreads(owner)).some((entry) => entry.rootId === mentioned.rootId));
    await send(owner, channelId, "Checking now.", mentioned.rootId);
    const again = await stateOf(owner, channelId, mentioned.rootId);
    assert.equal(again.followed, true, "The person's own reply did not follow the thread again.");
    const chosen = await follow(owner, channelId, mentioned.rootId, true);
    assert.equal(chosen.followed, true);
    return { stopped, again };
  });

  await step("the followed list names each followed thread, newest reply first", async () => {
    const list = await states(owner, channelId);
    assert.deepEqual(
      list.map((entry) => entry.rootId),
      [mentioned.rootId, thread.rootId],
    );
    return list;
  });

  await step("mark unread moves the channel position back to just before a message", async () => {
    const first = await send(member, channelId, "Status: design done.");
    const second = await send(member, channelId, "Status: build started.");
    const page = await e2e.page(owner.token, channelId);
    await e2e.releasedCommand(owner.token, {
      type: "read",
      operationId: randomUUID(),
      channelId,
      throughSequence: Number(page.throughSequence),
    });
    const memberBefore = (await e2e.channels(member.token)).find((entry) => entry.id === channelId)?.unreadCount;
    const heard = e2e.nextMessage(ownerSocket, readStateEvent(channelId));
    const quiet = e2e.noMessage(memberSocket, (value) => {
      const event = workspaceReadStateEvent(value);
      return event !== null && event.threadRootId === undefined;
    });
    const marked = await markUnread(owner, channelId, String(first.id));
    assert.equal(marked.status, 200, `Mark unread returned ${marked.status}: ${JSON.stringify(marked.body)}`);
    const position = record(marked.body, "read position");
    assert.equal(position.throughSequence, Number(first.sequence) - 1);
    assert.equal(position.unreadCount, 2, "The marked message and the one after it are not unread.");
    await heard;
    await quiet;
    const summary = (await e2e.channels(owner.token)).find((entry) => entry.id === channelId);
    assert.equal(summary?.unreadCount, 2, "The sidebar count does not follow the mark.");
    const memberSummary = (await e2e.channels(member.token)).find((entry) => entry.id === channelId);
    assert.equal(memberSummary?.unreadCount, memberBefore, "Another person's mark changed the member's count.");
    // The released `read` command moves forward only, as before.
    await e2e.releasedCommand(owner.token, {
      type: "read",
      operationId: randomUUID(),
      channelId,
      throughSequence: 0,
    });
    assert.equal((await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount, 2);
    await e2e.releasedCommand(owner.token, {
      type: "read",
      operationId: randomUUID(),
      channelId,
      throughSequence: Number(second.sequence),
    });
    assert.equal((await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount, 0);
    return position;
  });

  await step("mark unread in a thread moves the thread position, and not the channel's", async () => {
    const thread1 = await e2e.page(owner.token, channelId, thread.rootId);
    assert.ok(Array.isArray(thread1.messages));
    const memberReply = record(thread1.messages[1], "member reply");
    const channelBefore = (await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount;
    const heard = e2e.nextMessage(ownerSocket, readStateEvent(channelId, thread.rootId));
    const marked = await markUnread(owner, channelId, String(memberReply.id), thread.rootId);
    assert.equal(marked.status, 200, `Mark unread returned ${marked.status}: ${JSON.stringify(marked.body)}`);
    const position = record(marked.body, "thread position");
    assert.equal(position.threadRootId, thread.rootId);
    assert.equal(position.throughSequence, Number(memberReply.sequence) - 1);
    assert.equal(position.unreadCount, 1, "Only the member's reply is unread: the owner wrote the later one.");
    await heard;
    const state = await stateOf(owner, channelId, thread.rootId);
    assert.equal(state.throughSequence, Number(memberReply.sequence) - 1);
    assert.equal(state.unreadCount, 1);
    assert.equal(
      (await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount,
      channelBefore,
      "A thread mark changed the channel count.",
    );
    const fromRoot = await markUnread(owner, channelId, thread.rootId, thread.rootId);
    assert.equal(fromRoot.status, 200);
    const root = record(thread1.messages[0], "root");
    assert.equal(record(fromRoot.body, "root position").throughSequence, Number(root.sequence) - 1);
    // Read forward again, so the later steps see the thread read.
    await readThread(owner, channelId, thread.rootId, Number(record(thread1.messages.at(-1), "last reply").sequence));
    return position;
  });

  await step(
    "mark unread refuses a reply outside its thread, a deleted message and a message of a hidden channel",
    async () => {
      const thread1 = await e2e.page(owner.token, channelId, thread.rootId);
      assert.ok(Array.isArray(thread1.messages));
      const reply = record(thread1.messages[1], "reply");
      const asChannel = await markUnread(owner, channelId, String(reply.id));
      assert.equal(asChannel.status, 404, `A thread reply marked in the channel answered ${asChannel.status}.`);
      const otherThread = await markUnread(owner, channelId, String(reply.id), mentioned.rootId);
      assert.equal(otherThread.status, 404, `A reply of another thread answered ${otherThread.status}.`);
      const gone = await send(owner, channelId, "A note to delete.");
      await e2e.command(owner.token, {
        type: "delete",
        operationId: randomUUID(),
        channelId,
        messageId: String(gone.id),
      });
      const deleted = await markUnread(owner, channelId, String(gone.id));
      assert.equal(deleted.status, 404, `A deleted message answered ${deleted.status}.`);
      const hidden = await createChannel(owner, "finance", "private");
      const secret = await send(owner, hidden, "Budget");
      const refused = await markUnread(member, hidden, String(secret.id));
      assert.equal(refused.status, 404, `A hidden channel answered ${refused.status}.`);
      return { asChannel: 404, otherThread: 404, deleted: 404, hidden: 404 };
    },
  );

  await step("a channel the person cannot see answers 404; a root that is a reply answers 404", async () => {
    const hidden = await createChannel(owner, "board", "private");
    const root = await send(owner, hidden, "Board notes");
    const refused = await readState(WORKSPACE_READ_STATE_ROUTES.threadStates, member, { channelId: hidden });
    assert.equal(refused.status, 404, `A private channel answered ${refused.status}.`);
    const follows = await readState(WORKSPACE_READ_STATE_ROUTES.followThread, member, {
      operationId: randomUUID(),
      channelId: hidden,
      threadRootId: String(root.id),
      followed: true,
    });
    assert.equal(follows.status, 404);
    const replyId = (await e2e.page(owner.token, channelId, thread.rootId)).messages;
    assert.ok(Array.isArray(replyId));
    const reply = record(replyId[1], "reply");
    const notRoot = await readState(WORKSPACE_READ_STATE_ROUTES.readThread, owner, {
      operationId: randomUUID(),
      channelId,
      threadRootId: String(reply.id),
      throughSequence: 1,
    });
    assert.equal(notRoot.status, 404, `A reply as a root answered ${notRoot.status}.`);
    const named = await states(owner, channelId, [String(reply.id), thread.rootId]);
    assert.deepEqual(
      named.map((entry) => entry.rootId),
      [thread.rootId],
    );
    return { privateChannel: refused.status, notRoot: notRoot.status };
  });

  await step("a client without fork-host-v1 gets 400; a malformed body gets 400", async () => {
    const old = await e2e.call("POST", WORKSPACE_READ_STATE_ROUTES.threadStates, {
      token: owner.token,
      body: { channelId },
      capabilities: ["channel-chats-v1"],
    });
    assert.equal(old.status, 400);
    const malformed = await e2e.call("POST", WORKSPACE_READ_STATE_ROUTES.readThread, {
      token: owner.token,
      body: { channelId, threadRootId: thread.rootId, throughSequence: -1, operationId: "x" },
    });
    assert.equal(malformed.status, 400);
    return { old: old.status, malformed: malformed.status };
  });

  await step("the thread unread query uses the thread index", async () => {
    const plan = e2e
      .host()
      .database.connection.prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM projection_channel_messages reply
          WHERE reply.channel_id = ? AND json_extract(reply.message_json, '$.threadRootId') = ? AND reply.sequence > ?`,
      )
      .all(channelId, thread.rootId, 0)
      .map((row) => String(row.detail));
    assert.ok(plan.join("\n").includes("channel_messages_thread"), plan.join("\n"));
    return plan;
  });

  const before = await step("a rebuild of the channel from its events keeps every thread state", async () => {
    const ownerBefore = await states(owner, channelId, [thread.rootId, mentioned.rootId]);
    const memberBefore = await states(member, channelId, [thread.rootId, mentioned.rootId]);
    // A mark that moved the channel position back, then a read forward: the replay keeps the order.
    const unread = async () => (await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount;
    const page = await e2e.page(owner.token, channelId);
    assert.ok(Array.isArray(page.messages));
    const last = record(page.messages.at(-1), "last message");
    assert.equal((await markUnread(owner, channelId, String(last.id))).status, 200);
    const countBefore = await unread();
    e2e.host().agents.channels.store.rebuild(channelId);
    assert.equal(await unread(), countBefore, "A rebuild changed the channel count.");
    assert.deepEqual(await states(owner, channelId, [thread.rootId, mentioned.rootId]), ownerBefore);
    assert.deepEqual(await states(member, channelId, [thread.rootId, mentioned.rootId]), memberBefore);
    return { ownerBefore, memberBefore, countBefore };
  });

  await step("a restart of the host keeps every thread state", async () => {
    await e2e.restart();
    assert.deepEqual(await states(owner, channelId, [thread.rootId, mentioned.rootId]), before.ownerBefore);
    assert.deepEqual(await states(member, channelId, [thread.rootId, mentioned.rootId]), before.memberBefore);
    const count = (await e2e.channels(owner.token)).find((entry) => entry.id === channelId)?.unreadCount;
    assert.equal(count, before.countBefore, "A restart changed the channel count.");
    return { kept: true };
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
