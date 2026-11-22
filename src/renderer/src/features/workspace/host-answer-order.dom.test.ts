import type { DecisionQueueEntry } from "@openbot/contracts/agent-learning";
import type { InsightAlert } from "@openbot/contracts/ipc";
import type { AgentMailboxesState } from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { DEFAULT_OWNER_AWAY_SETTINGS, type OwnerAwayState } from "@openbot/contracts/team-protocol/owner-away-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { createRoot, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createAgentMailboxesStore } from "./agent-mailboxes-store";
import { createOwnerAwayStore } from "./owner-away-store";
import { type FeedWorkspace, useLearningQueue } from "./workspace-host-feeds";
import { insightAlerts, pollInsightAlerts, setInsightAlerts } from "./workspace-insight-alerts";

// Failure mode: a read that began before an action answers after it, and the list from before the
// action shows again: an applied proposal, a dismissed alert, a Focus or a saved mailbox.

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

/** The answers of a host that answer when the test says so, decoded as the real client decodes them. */
function controlledHost() {
  const answers: { path: string; answer: ReturnType<typeof deferred<unknown>> }[] = [];
  const request: TeamApiRequest = (_method, path, decode) => {
    const answer = deferred<unknown>();
    answers.push({ path, answer });
    return answer.promise.then(decode);
  };
  return { answers, request };
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
  flush();
};

const entry = (id: string): DecisionQueueEntry => ({
  id,
  source: "learning",
  kind: "memory",
  agentId: null,
  spaceId: null,
  title: id,
  detail: "",
  risk: "low",
  createdAt: "2026-11-22T10:00:00.000Z",
});

const awayState = (focusUntil: number | null): OwnerAwayState => ({
  settings: DEFAULT_OWNER_AWAY_SETTINGS,
  systemTimezone: "UTC",
  focusUntil,
  quiet: focusUntil === null ? null : { kind: "focus", until: focusUntil },
  held: [],
  suppressed: { count: 0, since: null },
});

const mailboxes = (ids: readonly string[]): AgentMailboxesState => ({
  gateway: { listening: true, publicUrl: "https://connect.example.com" },
  inboxUrl: null,
  workerUrl: null,
  hasSecret: false,
  lastMailAt: null,
  lastStatus: null,
  mailboxes: ids.map((id) => ({
    id,
    address: `${id}@example.com`,
    displayName: "",
    agentId: "lucia",
    agentName: "Lucía",
    spaceId: "s1",
    mode: "reply",
    createdAt: 1,
    lastMailAt: null,
    received: 0,
    sentToday: 0,
  })),
});

describe("host answers in order", () => {
  it("keeps an applied learning proposal out when an older read answers later", async () => {
    const reads: ReturnType<typeof deferred<DecisionQueueEntry[]>>[] = [];
    const ws: FeedWorkspace = {
      env: {
        connectionReady: () => true,
        efficiency: () => ({
          decisionQueue: () => {
            const read = deferred<DecisionQueueEntry[]>();
            reads.push(read);
            return read.promise;
          },
        }),
      },
    };
    const { feed, dispose } = createRoot((dispose) => ({ feed: useLearningQueue(ws), dispose }));
    await settle();
    reads[0]?.resolve([entry("a"), entry("b")]);
    await settle();
    expect(feed.value().map((item) => item.id)).toEqual(["a", "b"]);

    // The window shows again and reads; the owner applies "a" before that read answers.
    feed.refresh();
    expect(reads).toHaveLength(2);
    feed.update((list) => list.filter((item) => item.id !== "a"));
    reads[1]?.resolve([entry("a"), entry("b")]);
    await settle();
    expect(feed.value().map((item) => item.id)).toEqual(["b"]);
    dispose();
  });

  it("keeps a dismissed insight alert out when an older read answers later", async () => {
    const alert: InsightAlert = {
      id: "alert-1",
      spaceId: "s1",
      kind: "spend-no-sales",
      text: "Spent $40 on ads in 3 days with 0 sales.",
      createdAt: "2026-11-22T10:00:00.000Z",
    };
    const reads: ReturnType<typeof deferred<readonly InsightAlert[]>>[] = [];
    const dispose = createRoot((dispose) => {
      pollInsightAlerts({ env: { connectionReady: () => true } }, () => () => {
        const read = deferred<readonly InsightAlert[]>();
        reads.push(read);
        return read.promise;
      });
      return dispose;
    });
    await settle();
    expect(reads).toHaveLength(1);
    // The owner dismisses the alert on Today; the host answers the alerts without it.
    setInsightAlerts([]);
    reads[0]?.resolve([alert]);
    await settle();
    expect(insightAlerts()).toEqual([]);
    dispose();
  });

  it("shows the Focus that the owner set when the minute's read answers after it", async () => {
    const host = controlledHost();
    const { store, dispose } = createRoot((dispose) => ({
      store: createOwnerAwayStore({ request: () => host.request, enabled: () => true, hostId: () => "host" }),
      dispose,
    }));
    await settle();
    expect(host.answers).toHaveLength(1);
    const focus = store.setFocus(123);
    host.answers[1]?.answer.resolve(awayState(123));
    await focus;
    host.answers[0]?.answer.resolve(awayState(null));
    await settle();
    expect(store.state()?.focusUntil).toBe(123);
    dispose();
  });

  it("shows a saved mailbox when the opening read answers after the save", async () => {
    const host = controlledHost();
    const store = createAgentMailboxesStore({ request: () => host.request, enabled: () => true });
    const refresh = store.refresh();
    const save = store.save({ address: "m1@example.com", agentId: "lucia", mode: "reply" });
    host.answers[1]?.answer.resolve(mailboxes(["m1"]));
    await save;
    host.answers[0]?.answer.resolve(mailboxes([]));
    await refresh;
    await settle();
    expect(store.state()?.mailboxes.map((mailbox) => mailbox.id)).toEqual(["m1"]);
  });
});
