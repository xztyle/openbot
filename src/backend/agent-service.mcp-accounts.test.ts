// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { McpServerConfig } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentService } from "./agent-service";
import { startAgentTestFixture, startService, stopAgentTestFixture } from "./agent-service-test-harness";
import { runCauseEffect } from "./effect-boundary";
import type { McpOAuthAuthority } from "./mcp-oauth-provider";
import { NO_PROVIDER_CREDENTIALS } from "./provider-drivers";

let root: string;
let service: AgentService | null = null;

beforeEach(async () => {
  ({ root } = await startAgentTestFixture());
});

afterEach(async () => {
  await stopAgentTestFixture(root, service);
  service = null;
});

function accountAuthority(tokens: Map<string, string>, cancelled: string[], id = "legacy"): McpOAuthAuthority {
  return {
    forConnection: (accountId) => accountAuthority(tokens, cancelled, accountId),
    accessToken: () => Effect.succeed(tokens.get(id) ?? null),
    signIn: () => null,
    cancelSignIn: () => {
      cancelled.push(id);
      return false;
    },
    signedIn: () => tokens.has(id),
    forget: () =>
      Effect.sync(() => {
        tokens.delete(id);
      }),
  };
}

function accountConfig(id: string, name: string): McpServerConfig {
  return {
    id,
    name,
    transport: "http",
    enabled: true,
    command: "",
    args: [],
    env: [],
    envPassthrough: [],
    workingDirectory: "",
    url: "https://mcp.example.com/mcp",
    headers: [],
  };
}

describe.sequential("AgentService: MCP account sign-out", () => {
  it("clears only the chosen account and keeps the other account signed in on the same URL", async () => {
    const one = `mcpacct-${randomUUID()}`;
    const two = `mcpacct-${randomUUID()}`;
    const tokens = new Map([
      [one, "account-one-token"],
      [two, "account-two-token"],
    ]);
    const cancelled: string[] = [];
    const started = await startService(root, {
      provider: "codex",
      credentials: { ...NO_PROVIDER_CREDENTIALS, mcpOAuth: accountAuthority(tokens, cancelled) },
    });
    service = started.service;
    for (const config of [accountConfig(one, "Account one"), accountConfig(two, "Account two")])
      await runCauseEffect(service.saveMcpServer({ config }));
    expect(service.listMcpSignIns()).toEqual([
      { mcpServerId: one, signedIn: true },
      { mcpServerId: two, signedIn: true },
    ]);

    const result = await runCauseEffect(service.signOutMcpServer({ mcpServerId: one }));

    expect(result).toEqual([
      { mcpServerId: one, signedIn: false },
      { mcpServerId: two, signedIn: true },
    ]);
    expect(service.listMcpSignIns()).toEqual(result);
    expect([...tokens]).toEqual([[two, "account-two-token"]]);
    expect(cancelled).toEqual([one]);
  });
});
