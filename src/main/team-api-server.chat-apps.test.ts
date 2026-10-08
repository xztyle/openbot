// @vitest-environment node
import { join } from "node:path";
import type { TeamProtocolV2Json } from "@openbot/contracts/team-protocol/v2";
import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";
import { McpOAuth } from "../backend/mcp-oauth-provider";
import { NO_MCP_TOOL_RUNTIMES } from "../backend/mcp-provider-shapes";
import { ChatMcpPolicyStore } from "./chat-mcp-policy-store";
import { ChatMcpProxy } from "./chat-mcp-proxy";
import { ChatMcpService } from "./chat-mcp-service";
import { RemoteMcpSignIn } from "./remote-mcp-sign-in";
import { createTeamApiFixture, stopTeamApiFixtures } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);
it("refuses untrusted sessions and saves only an administrator's negotiated chat choices", async () => {
  const fixture = await createTeamApiFixture("chat-apps", { configure: true });
  const policies = new ChatMcpPolicyStore(join(fixture.root, "apps.json"));
  await runCauseEffect(policies.load());
  const proxy = new ChatMcpProxy({
    policies,
    configs: () => [],
    chatKey: () => null,
    authorization: () => Effect.succeed(null),
    runtimes: () => NO_MCP_TOOL_RUNTIMES,
  });
  const chatMcp = new ChatMcpService({
    policies,
    proxy,
    agents: () => [{ id: "one" }],
    configs: () => [],
    channelExists: () => false,
    changed: () => Effect.void,
  });
  const oauth = new McpOAuth({
    storage: { read: () => null, write: () => Effect.void, clear: () => Effect.void },
    redirectUrl: "openbot://mcp-auth",
    openExternal: async () => {},
  });
  const mcpOAuth = new RemoteMcpSignIn({
    oauth,
    redirectUrl: "https://private.example/mcp-auth",
    probe: () => Effect.succeed({ toolCount: 0, error: "Test refusal" }),
  });
  const { base } = await fixture.start({ chatMcp, mcpOAuth });
  const token = await fixture.signIn();
  const invite = await Effect.runPromise(fixture.store.createInvite("member"));
  const member = await Effect.runPromise(fixture.store.acceptInvite(invite.token, "member", "member password"));
  const headers = {
    Authorization: `Bearer ${token}`,
    "OpenBot-Protocol-Version": "3",
    "OpenBot-Capabilities": "mcp-chat-v1,mcp-oauth-v1",
    "Content-Type": "application/json",
  };
  const send = (path: string, body: TeamProtocolV2Json, overrides: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  try {
    for (const path of ["/v1/mcp-chat/save", "/v1/mcp-oauth/start"]) {
      expect((await send(path, {}, { Authorization: "Bearer invalid" })).status).toBe(401);
      expect((await send(path, {}, { Authorization: `Bearer ${member.sessionToken}` })).status).toBe(403);
      expect((await send(path, {}, { "OpenBot-Capabilities": "" })).status).toBe(400);
    }
    const target = { kind: "agent", id: "one" };
    const saved = await send("/v1/mcp-chat/save", { target, grants: [] });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ grants: [], connections: [] });
    const invalid = await send("/v1/mcp-chat/save", { target, grants: [{ connectionId: "absent", mode: "write" }] });
    expect(invalid.status).toBe(400);
    expect(policies.get("agent:one").grants).toEqual([]);
    const badCallback = await send("/v1/mcp-oauth/start", {
      url: "https://mcp.example/mcp",
      redirectUrl: "https://evil.example/mcp-auth",
      accountId: `mcpacct-${crypto.randomUUID()}`,
    });
    expect(badCallback.status).toBe(400);
  } finally {
    await runCauseEffect(mcpOAuth.close());
    await runCauseEffect(oauth.close());
  }
});
