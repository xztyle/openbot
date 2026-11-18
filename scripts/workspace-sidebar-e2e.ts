// Checks the member's workspace sidebar (`workspace-sidebar-v1`, under `fork-host-v1`) on a real Team
// API host (`workspace-e2e-host.ts`) with the real sidebar store, through the frozen wire codecs, as
// the web client and a remote desktop save and read it:
//
// - Mute: the save answers the mute with a revision; the change event reaches only the member's own
//   sessions; the read that the event starts answers the mute. Nothing on the host path puts the
//   old value back.
// - A read sent with a save answers either value with its own revision, so a client can leave out
//   the older answer (`revision` below the one its write got back).
// - Two sessions of one member: a save made from an older revision (`baseRevision`) keeps the mutes,
//   bells and closes that the other session saved since, and applies its own changes on top. A save
//   without a base, as an older client sends, replaces the value.
// - The value and its revision survive a host restart.
//
// `bun scripts/workspace-sidebar-e2e.ts`. Writes .openbot-build/workspace-sidebar-e2e/report.json.
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  WORKSPACE_SIDEBAR_CODECS,
  WORKSPACE_SIDEBAR_ROUTES,
  workspaceSidebarEvent,
} from "@openbot/contracts/team-protocol/workspace-sidebar-v1";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { WorkspaceSidebarStore } from "../src/main/workspace-sidebar-store";
import { type JsonObject, type Person, record, startWorkspaceE2e } from "./workspace-e2e-host";

const e2e = await startWorkspaceE2e(
  "workspace-sidebar-e2e",
  [
    "The window's own sync (workspace-controller.ts: base revision on a write, the answer of a write applied, an older answer left out). `typecheck:renderer` checks it; no window runs here.",
    "The WebRTC transport of the web client. It carries the same requests to the same route handler that this check calls over loopback HTTP.",
  ],
  {
    server: async ({ agents, userData }) => {
      const sidebar = new WorkspaceSidebarStore(join(userData, "workspace-sidebar.json"));
      await runCauseEffect(sidebar.load());
      sidebar.onChanged((memberId) => agents.emit("event", { type: "workspace-sidebar-changed", memberId }));
      return { workspaceSidebar: sidebar };
    },
  },
);
const { owner, member, step } = e2e;

interface Answer {
  sidebar: JsonObject | null;
  revision: number;
}

function answer(value: unknown): Answer {
  const body = record(value, "sidebar answer");
  assert.equal(body.notifyLevels, true);
  assert.equal(typeof body.revision, "number", "The answer has no revision.");
  return { sidebar: body.sidebar === null ? null : record(body.sidebar, "sidebar"), revision: Number(body.revision) };
}

async function read(person: Person): Promise<Answer> {
  const response = await e2e.optional(WORKSPACE_SIDEBAR_CODECS, WORKSPACE_SIDEBAR_ROUTES.read, person.token, {});
  assert.equal(response.status, 200, `The read returned ${response.status}.`);
  return answer(response.body);
}

interface Value {
  channels?: string[];
  muted?: string[];
  closed?: string[];
  notifyMentions?: string[];
  notifyNothing?: string[];
  space?: string;
  baseRevision?: number;
}

async function save(person: Person, value: Value): Promise<Answer> {
  const response = await e2e.optional(WORKSPACE_SIDEBAR_CODECS, WORKSPACE_SIDEBAR_ROUTES.save, person.token, {
    order: { channels: value.channels ?? [], direct: [] },
    muted: value.muted ?? [],
    closed: value.closed ?? [],
    notifyMentions: value.notifyMentions ?? [],
    notifyNothing: value.notifyNothing ?? [],
    ...(value.space === undefined ? {} : { space: value.space }),
    ...(value.baseRevision === undefined ? {} : { baseRevision: value.baseRevision }),
  });
  assert.equal(response.status, 200, `The save returned ${response.status}.`);
  return answer(response.body);
}

/** One id list of a sidebar answer. */
function list(sidebar: JsonObject | null, key: string): string[] | undefined {
  const value = sidebar?.[key];
  if (value === undefined) return undefined;
  assert.ok(Array.isArray(value) && value.every((id) => typeof id === "string"), `${key} is not a list of ids.`);
  return value.map(String);
}

const isSidebarEvent = (value: unknown) => workspaceSidebarEvent(value) !== null;

try {
  const memberEvents = await e2e.openEvents(member.token);
  const ownerEvents = await e2e.openEvents(owner.token);

  const muted = await step("Mute: the save, the event of the member and the read that it starts", async () => {
    const before = await read(member);
    assert.equal(before.sidebar, null);
    assert.equal(before.revision, 0);
    const event = e2e.nextMessage(memberEvents, (value) => (isSidebarEvent(value) ? value : null));
    const saved = await save(member, { muted: ["channel-x"] });
    assert.deepEqual(list(saved.sidebar, "muted"), ["channel-x"]);
    assert.equal(saved.revision, 1);
    await event;
    const after = await read(member);
    assert.deepEqual(list(after.sidebar, "muted"), ["channel-x"]);
    assert.equal(after.revision, 1);
    // Another member's sessions hear nothing of it.
    await e2e.noMessage(ownerEvents, isSidebarEvent);
    return { saved: saved.revision, read: after };
  });

  await step("A read sent with a save answers one value with its own revision", async () => {
    const [saved, raced] = await Promise.all([
      save(member, { muted: ["channel-x", "channel-y"], baseRevision: muted.read.revision }),
      read(member),
    ]);
    assert.equal(saved.revision, 2);
    // Whichever value the read saw, its revision names it, so a window that applied the save leaves
    // out a read of revision 1.
    if (raced.revision === 1) assert.deepEqual(list(raced.sidebar, "muted"), ["channel-x"]);
    else {
      assert.equal(raced.revision, 2);
      assert.deepEqual(list(raced.sidebar, "muted"), ["channel-x", "channel-y"]);
    }
    const settled = await read(member);
    assert.equal(settled.revision, 2);
    assert.deepEqual(list(settled.sidebar, "muted"), ["channel-x", "channel-y"]);
    return { racedRevision: raced.revision, settled: settled.revision };
  });

  await step("A save from an older revision keeps what the other session saved since", async () => {
    // Both sessions show revision 2. The phone mutes channel-z and sets channel-n to Nothing.
    const phone = await save(member, {
      muted: ["channel-x", "channel-y", "channel-z"],
      notifyNothing: ["channel-n"],
      space: "space-p",
      baseRevision: 2,
    });
    assert.equal(phone.revision, 3);
    // The desktop still shows revision 2: it unmutes channel-x, sets channel-m to Just mentions,
    // closes a DM and drags the channels. Without the base it would take channel-z's mute back.
    const desktop = await save(member, {
      channels: ["channel-b", "channel-a"],
      muted: ["channel-y"],
      notifyMentions: ["channel-m"],
      closed: ["agent:a1"],
      baseRevision: 2,
    });
    assert.equal(desktop.revision, 4);
    assert.deepEqual(list(desktop.sidebar, "muted"), ["channel-y", "channel-z"]);
    assert.deepEqual(list(desktop.sidebar, "notifyNothing"), ["channel-n"]);
    assert.deepEqual(list(desktop.sidebar, "notifyMentions"), ["channel-m"]);
    assert.deepEqual(list(desktop.sidebar, "closed"), ["agent:a1"]);
    assert.deepEqual(record(desktop.sidebar?.order, "order").channels, ["channel-b", "channel-a"]);
    // The desktop did not change the space, so the phone's stays.
    assert.equal(desktop.sidebar?.space, "space-p");
    const after = await read(member);
    assert.deepEqual(after, desktop);
    return after;
  });

  await step("A save without a base replaces the value, as an older client's does", async () => {
    const replaced = await save(member, { muted: ["channel-q"] });
    assert.equal(replaced.revision, 5);
    assert.deepEqual(list(replaced.sidebar, "muted"), ["channel-q"]);
    assert.deepEqual(list(replaced.sidebar, "notifyNothing"), []);
    return replaced;
  });

  await step("The value and the revision survive a restart; a base from before it replaces", async () => {
    await e2e.restart();
    const after = await read(member);
    assert.equal(after.revision, 5);
    assert.deepEqual(list(after.sidebar, "muted"), ["channel-q"]);
    // The phone saves from revision 5, which the host has; then a session saves from 5 too.
    const phone = await save(member, { muted: ["channel-q", "channel-r"], baseRevision: 5 });
    const desktop = await save(member, { muted: [], notifyNothing: ["channel-s"], baseRevision: 5 });
    assert.equal(desktop.revision, 7);
    assert.deepEqual(list(desktop.sidebar, "muted"), ["channel-r"]);
    assert.deepEqual(list(desktop.sidebar, "notifyNothing"), ["channel-s"]);
    // Revision 3 is from before the restart: the host no longer has its value.
    const stale = await save(member, { muted: ["channel-t"], baseRevision: 3 });
    assert.deepEqual(list(stale.sidebar, "muted"), ["channel-t"]);
    return { phone: phone.revision, desktop: desktop.revision, stale: stale.revision };
  });

  await step("The owner's value is apart from the member's", async () => {
    const ownerValue = await read(owner);
    assert.equal(ownerValue.sidebar, null);
    assert.equal(ownerValue.revision, 0);
    return ownerValue;
  });

  e2e.report.passed = true;
} finally {
  await e2e.finish();
}
