// Checks the saved items ("Later") and pins of the workspace (`workspace-saved-v1`, under
// `fork-host-v1`) on a real Team API host (`workspace-e2e-host.ts`), as the web client and a remote
// desktop reach them:
//
// - A person saves a message, marks it done and removes it; only they see their items, and only
//   their sessions hear of a change. A deleted message shows as deleted; an item of a channel the
//   person can no longer see leaves the list.
// - A pin is on the message for everyone who can see the channel, and reaches them as a
//   `channel-message` event; each channel lists its pins, newest first, at most 100.
// - A hidden channel answers 404; an archived channel and a full pin list answer 409; a client
//   without `fork-host-v1` gets 400.
// - Saved items and pins survive a rebuild of the channel from its events and a host restart.
//
// `bun scripts/workspace-saved-e2e.ts`. Writes .openbot-build/workspace-saved-e2e/report.json.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  WORKSPACE_SAVED_CODECS,
  WORKSPACE_SAVED_ROUTES,
  workspaceSavedEvent,
} from "@openbot/contracts/team-protocol/workspace-saved-v1";
import { workspaceChannelEvent } from "@openbot/contracts/team-protocol/workspace-v1";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const e2e = await startWorkspaceE2e("workspace-saved-e2e", [
  "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
]);
const { owner, member, step, send, createChannel } = e2e;

async function savedRoute(path: string, person: Person, body: JsonObject): Promise<{ status: number; body: unknown }> {
  return e2e.optional(WORKSPACE_SAVED_CODECS, path, person.token, body);
}

async function list(person: Person, body: JsonObject = {}): Promise<JsonObject[]> {
  const response = await savedRoute(WORKSPACE_SAVED_ROUTES.saved, person, body);
  assert.equal(response.status, 200, `Saved items returned ${response.status}: ${JSON.stringify(response.body)}`);
  const page = record(response.body, "saved page");
  assert.ok(Array.isArray(page.items));
  assert.equal(page.total, page.items.length);
  return page.items.map((entry) => record(entry, "saved item"));
}

async function save(
  person: Person,
  channelId: string,
  messageId: string,
  state: "saved" | "done" | null,
): Promise<{ status: number; body: unknown }> {
  return savedRoute(WORKSPACE_SAVED_ROUTES.setSaved, person, {
    operationId: randomUUID(),
    channelId,
    messageId,
    state,
  });
}

async function pins(person: Person, channelId: string): Promise<JsonObject[]> {
  const response = await savedRoute(WORKSPACE_SAVED_ROUTES.pins, person, { channelId });
  assert.equal(response.status, 200, `Pins returned ${response.status}: ${JSON.stringify(response.body)}`);
  const body = record(response.body, "pins");
  assert.ok(Array.isArray(body.pins));
  return body.pins.map((entry) => record(entry, "pin"));
}

async function pin(
  person: Person,
  channelId: string,
  messageId: string,
  pinned: boolean,
): Promise<{ status: number; body: unknown }> {
  return savedRoute(WORKSPACE_SAVED_ROUTES.setPinned, person, {
    operationId: randomUUID(),
    channelId,
    messageId,
    pinned,
  });
}

const pinnedEvent = (messageId: string, pinned: boolean) => (value: unknown) => {
  const event = workspaceChannelEvent(value);
  return event?.type === "channel-message" &&
    event.message.id === messageId &&
    (event.message.pinned !== undefined) === pinned
    ? event
    : null;
};

try {
  const setup = await step("setup: #launch with a message, a thread reply and a note", async () => {
    const launch = await createChannel(owner, "launch", "public");
    await e2e.command(member.token, { type: "join", operationId: randomUUID(), channelId: launch });
    const plan = await send(owner, launch, "Launch plan: ship on Friday");
    const reply = await send(owner, launch, "Copy is final", String(plan.id));
    const note = await send(owner, launch, "Remember the press kit");
    return { launch, plan: String(plan.id), reply: String(reply.id), note: String(note.id) };
  });
  const ownerSocket = await e2e.openEvents(owner.token);
  const memberSocket = await e2e.openEvents(member.token);

  await step("a person saves a message; only they see it, and only their sessions hear of it", async () => {
    const heard = e2e.nextMessage(memberSocket, workspaceSavedEvent);
    const quiet = e2e.noMessage(ownerSocket, (value) => workspaceSavedEvent(value) !== null);
    const saved = await save(member, setup.launch, setup.plan, "saved");
    assert.equal(saved.status, 200, `Save returned ${saved.status}: ${JSON.stringify(saved.body)}`);
    const item = record(record(saved.body, "result").item, "item");
    assert.equal(item.state, "saved");
    assert.equal(item.deleted, false);
    assert.equal(item.preview, "Launch plan: ship on Friday");
    await heard;
    await quiet;
    assert.deepEqual(
      (await list(member)).map((entry) => entry.messageId),
      [setup.plan],
    );
    assert.deepEqual(await list(owner), [], "Another person's saved item shows.");
    return item;
  });

  await step("done, the state filter, a thread reply, the channel filter and removal", async () => {
    await save(member, setup.launch, setup.reply, "saved");
    const done = await save(member, setup.launch, setup.plan, "done");
    assert.equal(record(record(done.body, "result").item, "item").state, "done");
    assert.deepEqual(
      (await list(member, { state: "saved" })).map((entry) => entry.messageId),
      [setup.reply],
    );
    assert.deepEqual(
      (await list(member, { state: "done" })).map((entry) => entry.messageId),
      [setup.plan],
    );
    const reply = (await list(member)).find((entry) => entry.messageId === setup.reply);
    assert.equal(reply?.threadRootId, setup.plan, "A saved reply has no thread.");
    assert.equal((await list(member, { channelId: setup.launch })).length, 2);
    const removed = await save(member, setup.launch, setup.reply, null);
    assert.equal(record(removed.body, "result").item, null);
    assert.deepEqual(
      (await list(member)).map((entry) => entry.messageId),
      [setup.plan],
    );
    const paged = await savedRoute(WORKSPACE_SAVED_ROUTES.saved, member, { limit: 1, cursor: "1" });
    assert.deepEqual(record(paged.body, "page").items, []);
    return { ok: true };
  });

  await step("a message deleted after it was saved shows as deleted; a deleted message cannot be saved", async () => {
    await save(member, setup.launch, setup.note, "saved");
    await e2e.command(owner.token, {
      type: "delete",
      operationId: randomUUID(),
      channelId: setup.launch,
      messageId: setup.note,
    });
    const note = (await list(member)).find((entry) => entry.messageId === setup.note);
    assert.equal(note?.deleted, true);
    assert.equal(note?.preview, "");
    const refused = await save(owner, setup.launch, setup.note, "saved");
    assert.equal(refused.status, 404, `Saving a deleted message returned ${refused.status}.`);
    await save(member, setup.launch, setup.note, null);
    return { deleted: true };
  });

  await step("an item of a channel the person can no longer see leaves the list; a hidden channel is 404", async () => {
    const board = await createChannel(owner, "board", "private");
    await e2e.command(owner.token, {
      type: "invite",
      operationId: randomUUID(),
      channelId: board,
      humanMemberIds: [member.id],
      members: [],
    });
    const agenda = await send(owner, board, "Board agenda");
    assert.equal((await save(member, board, String(agenda.id), "saved")).status, 200);
    assert.ok((await list(member)).some((entry) => entry.channelId === board));
    await e2e.command(owner.token, {
      type: "remove",
      operationId: randomUUID(),
      channelId: board,
      humanMemberIds: [member.id],
      agentIds: [],
    });
    assert.ok(!(await list(member)).some((entry) => entry.channelId === board), "A hidden channel's item shows.");
    assert.equal((await save(member, board, String(agenda.id), "saved")).status, 404);
    assert.equal((await savedRoute(WORKSPACE_SAVED_ROUTES.pins, member, { channelId: board })).status, 404);
    assert.equal((await pin(member, board, String(agenda.id), true)).status, 404);
    return { board };
  });

  await step(
    "a pin is on the message for everyone, as a channel-message event, and in the channel's pins",
    async () => {
      const heard = e2e.nextMessage(memberSocket, pinnedEvent(setup.plan, true));
      const pinned = await pin(owner, setup.launch, setup.plan, true);
      assert.equal(pinned.status, 200, `Pin returned ${pinned.status}: ${JSON.stringify(pinned.body)}`);
      const event = await heard;
      assert.equal(event.type === "channel-message" ? event.message.pinned?.by.id : null, owner.id);
      const listed = await pins(member, setup.launch);
      assert.deepEqual(
        listed.map((entry) => entry.messageId),
        [setup.plan],
      );
      assert.equal(record(listed[0]?.pinnedBy, "pinned by").id, owner.id);
      const page = await e2e.page(member.token, setup.launch);
      assert.ok(Array.isArray(page.messages));
      const message = page.messages.map((entry) => record(entry, "message")).find((entry) => entry.id === setup.plan);
      assert.ok(message?.pinned, "The page does not carry the pin.");
      const replyPin = await pin(member, setup.launch, setup.reply, true);
      assert.equal(replyPin.status, 200);
      assert.deepEqual(
        (await pins(owner, setup.launch)).map((entry) => entry.messageId),
        [setup.reply, setup.plan],
        "The pins are not newest first.",
      );
      const unheard = e2e.nextMessage(ownerSocket, pinnedEvent(setup.reply, false));
      assert.equal((await pin(owner, setup.launch, setup.reply, false)).status, 200);
      await unheard;
      assert.deepEqual(
        (await pins(owner, setup.launch)).map((entry) => entry.messageId),
        [setup.plan],
      );
      return { pins: 1 };
    },
  );

  const before = await step("a rebuild of the channel from its events keeps saved items and pins", async () => {
    const saved = await list(member);
    const pinned = await pins(owner, setup.launch);
    e2e.host().agents.channels.store.rebuild(setup.launch);
    assert.deepEqual(await list(member), saved);
    assert.deepEqual(await pins(owner, setup.launch), pinned);
    return { saved, pinned };
  });

  await step("a restart of the host keeps saved items and pins", async () => {
    await e2e.restart();
    assert.deepEqual(await list(member), before.saved);
    assert.deepEqual(await pins(owner, setup.launch), before.pinned);
    return { kept: true };
  });

  await step("a channel holds at most 100 pins; an archived channel takes none", async () => {
    const full = await createChannel(owner, "full", "public");
    const ids: string[] = [];
    for (let index = 0; index < 101; index += 1) ids.push(String((await send(owner, full, `Pin me ${index}`)).id));
    for (const id of ids.slice(0, 100)) assert.equal((await pin(owner, full, id, true)).status, 200);
    const refused = await pin(owner, full, String(ids[100]), true);
    assert.equal(refused.status, 409, `The 101st pin returned ${refused.status}.`);
    assert.equal((await pins(owner, full)).length, 100);
    await e2e.releasedCommand(owner.token, { type: "archive", operationId: randomUUID(), channelId: full });
    const archived = await pin(owner, full, String(ids[0]), false);
    assert.equal(archived.status, 409, `Unpinning in an archived channel returned ${archived.status}.`);
    return { limit: refused.status, archived: archived.status };
  });

  await step("a client without fork-host-v1 gets 400; a malformed body gets 400", async () => {
    const old = await e2e.call("POST", WORKSPACE_SAVED_ROUTES.saved, {
      token: member.token,
      body: {},
      capabilities: ["channel-chats-v1"],
    });
    assert.equal(old.status, 400);
    const malformed = await e2e.call("POST", WORKSPACE_SAVED_ROUTES.setSaved, {
      token: member.token,
      body: { operationId: "x", channelId: setup.launch, messageId: setup.plan, state: "later" },
    });
    assert.equal(malformed.status, 400);
    return { old: old.status, malformed: malformed.status };
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
