import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { describe, expect, it } from "vitest";
import { createAgentMailboxesStore } from "./agent-mailboxes-store";
import { createConnectorAccessStore } from "./connector-access-store";

const AWAY = "The server connection is not available.";

function host() {
  const sent: string[] = [];
  const request: TeamApiRequest = async (_method, path) => {
    sent.push(path);
    throw new Error("not reached");
  };
  return { request: () => request, enabled: () => false, sent };
}

describe("workspace stores while the host is away", () => {
  it("refuse a revoke or a sender change, so the dialog does not say it worked", async () => {
    const away = host();
    const store = createConnectorAccessStore(away);
    await expect(store.revokeToken("token-1")).rejects.toThrow(AWAY);
    await expect(store.setSender({ routeId: "route-1", scheme: "openbot" })).rejects.toThrow(AWAY);
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(away.sent).toEqual([]);
  });

  it("refuse a mailbox change", async () => {
    const away = host();
    const store = createAgentMailboxesStore(away);
    await expect(store.remove("m1")).rejects.toThrow(AWAY);
    await expect(store.setWorker("https://mail.example.com")).rejects.toThrow(AWAY);
    await expect(store.newSecret()).rejects.toThrow(AWAY);
    await expect(store.refresh()).resolves.toBeUndefined();
    expect(away.sent).toEqual([]);
  });
});
