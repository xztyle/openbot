import type { McpServerConfig } from "@openbot/contracts/ipc";
import { MCP_OAUTH_CAPABILITY, MCP_OAUTH_ROUTES } from "@openbot/contracts/team-protocol/mcp-oauth-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { afterEach, expect, it, vi } from "vitest";
import { createWebMarketplaceCalls } from "./web-marketplace";

const config: McpServerConfig = {
  id: `mcpacct-${crypto.randomUUID()}`,
  name: "Account one",
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

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "closed");
});

function signInFixture(cancel = false) {
  const signal = new AbortController();
  const sent: { path: string; body: Parameters<TeamApiRequest>[3] }[] = [];
  const close = vi.spyOn(window, "close").mockImplementation(() => undefined);
  vi.spyOn(window, "open").mockReturnValue(window);
  const request: TeamApiRequest = async (_method, path, decode, body) => {
    sent.push({ path, body });
    if (path === MCP_OAUTH_ROUTES.start) return decode({ attemptId: "attempt-one", expiresAt: Date.now() + 60_000 });
    if (path === MCP_OAUTH_ROUTES.status) {
      if (cancel) signal.abort();
      return decode({ kind: "complete", toolCount: 4, error: null });
    }
    if (path === MCP_OAUTH_ROUTES.cancel) return decode(undefined);
    throw new Error("Unexpected request");
  };
  const host = vi.fn(() => request);
  const calls = createWebMarketplaceCalls(fetch, host, () => [MCP_OAUTH_CAPABILITY]);
  return { calls, signal, sent, close, host };
}

it("signs in with the desktop input shape and returns the host's tool count", async () => {
  const f = signInFixture();
  await expect(f.calls.mcp.signInMcpServer({ config }, "host-one", f.signal.signal)).resolves.toEqual({
    toolCount: 4,
    error: null,
  });
  expect(f.host).toHaveBeenCalledWith("host-one");
  expect(f.sent[0]).toEqual({
    path: MCP_OAUTH_ROUTES.start,
    body: { url: config.url, accountId: config.id, redirectUrl: new URL("/mcp-auth", window.location.origin).href },
  });
  expect(f.close).toHaveBeenCalled();
});

it("cancels the host attempt and closes the sign-in window", async () => {
  const f = signInFixture(true);
  await expect(f.calls.mcp.signInMcpServer({ config }, "host-one", f.signal.signal)).rejects.toThrow();
  expect(f.sent.at(-1)).toEqual({ path: MCP_OAUTH_ROUTES.cancel, body: { attemptId: "attempt-one" } });
  expect(f.close).toHaveBeenCalled();
});

/** A sign-in window that the page opened, and a host that keeps waiting for the provider. */
function waitingFixture(options: { closed: boolean; expiresIn: number }) {
  // The page that opened the window stands in for it, as in the fixture above.
  vi.spyOn(window, "close").mockImplementation(() => undefined);
  vi.spyOn(window, "open").mockReturnValue(window);
  Object.defineProperty(window, "closed", { configurable: true, get: () => options.closed });
  const request: TeamApiRequest = async (_method, path, decode) => {
    if (path === MCP_OAUTH_ROUTES.start)
      return decode({ attemptId: "attempt-one", expiresAt: Date.now() + options.expiresIn });
    if (path === MCP_OAUTH_ROUTES.status)
      return decode({ kind: "waiting", authorizationUrl: null, state: null, expiresAt: Date.now() + 60_000 });
    return decode(undefined);
  };
  return createWebMarketplaceCalls(
    fetch,
    () => request,
    () => [MCP_OAUTH_CAPABILITY],
  );
}

it("fails at once when the user closed the sign-in window, not when the attempt expires", async () => {
  vi.useFakeTimers();
  try {
    const calls = waitingFixture({ closed: true, expiresIn: 5 * 60_000 });
    const result = expect(
      calls.mcp.signInMcpServer({ config }, "host-one", new AbortController().signal),
    ).rejects.toThrow("Sign-in window closed. Try again.");
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
  } finally {
    vi.useRealTimers();
  }
});

it("says that the sign-in timed out, not that it was cancelled", async () => {
  const calls = waitingFixture({ closed: false, expiresIn: -1 });
  await expect(calls.mcp.signInMcpServer({ config }, "host-one", new AbortController().signal)).rejects.toThrow(
    "The app sign-in took too long. Try again.",
  );
});
