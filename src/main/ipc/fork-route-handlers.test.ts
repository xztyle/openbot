// @vitest-environment node

import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import { GUARDRAILS_ROUTES } from "@openbot/contracts/team-protocol/guardrails-v1";
import { OWNER_AWAY_ROUTES } from "@openbot/contracts/team-protocol/owner-away-v1";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { forkRouteIpcHandlers } from "./fork-route-handlers";

// Same reason as define-ipc-group.test.ts: electron cannot be imported outside an Electron process, so
// registrations are captured.
const { registrations } = vi.hoisted(() => ({
  registrations: new Map<string, (event: unknown, payload?: unknown) => unknown>(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, listener: (event: unknown, payload?: unknown) => unknown) {
      registrations.set(channel, listener);
    },
  },
}));

const event = { senderFrame: { url: "openbot-app://app/index.html" }, sender: { id: 1 } };

function register(forkHost = true) {
  const sent: { serverId: string; path: string; init: unknown }[] = [];
  const { forkRoutes } = forkRouteIpcHandlers({
    remoteServers: {
      supportsCapability: () => forkHost,
      request: <T>(serverId: string, path: string, decode: (value: unknown) => T, init?: unknown) => {
        sent.push({ serverId, path, init });
        return Effect.succeed(decode({ entries: [] }));
      },
    },
  });
  forkRoutes.request("fork-routes:request");
  const call = async (serverId: string, payload: unknown) => {
    const listener = registrations.get("fork-routes:request");
    if (!listener) throw new Error("No handler.");
    return listener(event, { serverId, payload });
  };
  return { sent, call };
}

beforeEach(() => registrations.clear());

describe("fork route handler", () => {
  it("sends an owner route of a joined fork host on, with its body", async () => {
    const { sent, call } = register();
    await expect(call("remote-1", { path: AGENT_LEARNING_ROUTES.queue, body: {} })).resolves.toEqual({ entries: [] });
    await call("remote-1", { path: GUARDRAILS_ROUTES.resume, body: { scope: "agent", id: "a1" } });
    await call("remote-1", { path: OWNER_AWAY_ROUTES.active });
    await call("remote-1", { path: AGENT_LEARNING_ROUTES.dream, body: { agentId: "a1" } });
    expect(sent).toEqual([
      { serverId: "remote-1", path: AGENT_LEARNING_ROUTES.queue, init: { method: "POST", body: {} } },
      {
        serverId: "remote-1",
        path: GUARDRAILS_ROUTES.resume,
        init: { method: "POST", body: { scope: "agent", id: "a1" } },
      },
      // A request without a body sends an empty one.
      { serverId: "remote-1", path: OWNER_AWAY_ROUTES.active, init: { method: "POST", body: {} } },
      // A route that runs a model waits as long as the browser client does.
      {
        serverId: "remote-1",
        path: AGENT_LEARNING_ROUTES.dream,
        init: { method: "POST", body: { agentId: "a1" }, timeoutMs: 630_000 },
      },
    ]);
  });

  it("refuses any other path, this computer's host, and a server without the fork routes", async () => {
    const { sent, call } = register();
    await expect(call("remote-1", { path: "/v1/host/admin/reset", body: {} })).rejects.toThrow();
    await expect(call("local", { path: AGENT_LEARNING_ROUTES.queue, body: {} })).rejects.toThrow();
    const old = register(false);
    await expect(old.call("remote-1", { path: AGENT_LEARNING_ROUTES.queue, body: {} })).rejects.toThrow();
    expect(sent).toEqual([]);
    expect(old.sent).toEqual([]);
  });
});
