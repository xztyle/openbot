import { RemoteTeamDirectoryClient } from "@openbot/team-client/remote-directory";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

function directory(keys: Map<string, string>, advertised: { key: string }) {
  return new RemoteTeamDirectoryClient({
    apiUrl: "https://account.example",
    token: "token",
    fetch: async () =>
      new Response(
        JSON.stringify({
          hosts: [
            {
              hostId: "host-1",
              name: "Server",
              logoKey: null,
              devicePublicKey: advertised.key,
              membershipId: "membership-1",
              role: "member",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    hostKeys: {
      get: async (hostId) => keys.get(hostId) ?? null,
      set: async (hostId, key) => {
        keys.set(hostId, key);
      },
    },
    verifyHostKeySignature: () => Effect.succeed(false),
  });
}

describe("the host key pin of a joined server", () => {
  it("pins the first key it sees and keeps it when the key changes without a signed handover", async () => {
    const keys = new Map<string, string>();
    const advertised = { key: "first-key" };
    const client = directory(keys, advertised);
    const [first] = await Effect.runPromise(client.listHosts());
    expect(first?.devicePublicKey).toBe("first-key");
    expect(keys.get("host-1")).toBe("first-key");

    advertised.key = "attacker-key";
    const [second] = await Effect.runPromise(client.listHosts());
    // The list still loads; the connection to this host uses the pinned key and fails there.
    expect(second?.devicePublicKey).toBe("first-key");
    expect(keys.get("host-1")).toBe("first-key");
  });
});
