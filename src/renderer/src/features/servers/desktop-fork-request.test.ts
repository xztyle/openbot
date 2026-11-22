import type { ServerSummary } from "@openbot/contracts/ipc";
import { AGENT_LEARNING_ROUTES } from "@openbot/contracts/team-protocol/agent-learning-v1";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STORY_SERVERS } from "../../preview/fixtures";
import { hostEfficiencyCalls } from "../efficiency/efficiency-port";
import { desktopForkRequest, serverHasForkOwnerRoutes } from "./desktop-fork-request";

const [local, team] = STORY_SERVERS;
function joined(role: ServerSummary["role"], capabilities: string[]): ServerSummary {
  if (team?.kind !== "remote") throw new Error("The fixtures have no joined server.");
  return {
    ...team,
    role,
    compatibility: {
      localAppVersion: "1.0.0",
      hostAppVersion: "1.0.0",
      localProtocol: { minimum: 1, maximum: 2 },
      hostProtocol: { minimum: 1, maximum: 2 },
      negotiatedProtocol: 2,
      capabilities,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("desktop fork routes", () => {
  it("are for an owner or an admin of a joined fork host only", () => {
    expect(serverHasForkOwnerRoutes(joined("owner", ["fork-host-v1"]))).toBe(true);
    expect(serverHasForkOwnerRoutes(joined("admin", ["fork-host-v1"]))).toBe(true);
    expect(serverHasForkOwnerRoutes(joined("member", ["fork-host-v1"]))).toBe(false);
    expect(serverHasForkOwnerRoutes(joined("owner", []))).toBe(false);
    expect(serverHasForkOwnerRoutes(local)).toBe(false);
    expect(serverHasForkOwnerRoutes(undefined)).toBe(false);
  });

  it("send the web client's call through main and decode the host's answer with the route's codec", async () => {
    const request = vi.fn(async () => ({ entries: [{ id: "q1" }] }));
    vi.stubGlobal("window", { openbot: { forkRoutes: { request } } });
    const calls = hostEfficiencyCalls(() => desktopForkRequest(() => "team"));
    await expect(calls.decisionQueue()).resolves.toEqual([{ id: "q1" }]);
    await calls.decideQueue("q1", "approve");
    expect(request).toHaveBeenNthCalledWith(1, { path: AGENT_LEARNING_ROUTES.queue, body: {} }, "team");
    expect(request).toHaveBeenNthCalledWith(
      2,
      { path: AGENT_LEARNING_ROUTES.decideQueue, body: { id: "q1", decision: "approve" } },
      "team",
    );
  });
});
