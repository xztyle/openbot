import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureOAuthFetch } from "./mcp-oauth-provider";
import { mcpHandoffHeaders, mcpLaunchEnvironment, type ResolvedMcpServer } from "./mcp-provider-shapes";

export function createMcpTransport(
  server: ResolvedMcpServer,
  authProvider?: OAuthClientProvider,
  fetchFn?: FetchLike,
): Transport {
  const { config } = server;
  if (config.transport === "http") {
    /*
     * The `authProvider` is what turns a 401 into a sign-in instead of a sentence. Without one the
     * transport reports the refusal, which is what a server with a pasted key should do.
     *
     * With one, the stored token is left out of `requestInit`: a header written there wins over the
     * one the provider adds, so a token the provider has just refreshed would lose to the value this
     * probe read a moment before the refusal.
     */
    const headers = authProvider
      ? Object.fromEntries(config.headers.map(({ key, value }) => [key, value]))
      : mcpHandoffHeaders(server);
    const transportFetch = authProvider ? secureOAuthFetch() : fetchFn;
    /*
     * The transport does OAuth of its own: a 401 on a token this probe believed was still valid
     * makes it call `auth()` through its own fetch, which spends the refresh token and the client
     * secret at the discovered endpoint. That is the same exchange the explicit paths guard, so it
     * gets the same fetch - without it a discovery document could name a plain-text token endpoint
     * and this one request would still honour it. A provider is only attached to a URL that already
     * passed `normalizeResource`, so the guard refuses nothing this probe could otherwise reach.
     */
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(authProvider ? { authProvider } : {}),
      ...(transportFetch ? { fetch: transportFetch } : {}),
      requestInit: { headers },
    });
  }
  return new StdioClientTransport({
    command: server.command ?? config.command,
    args: config.args,
    // The resolved directory, not the stored one: process creation does not expand a leading `~`,
    // which the form's own example uses.
    ...(server.workingDirectory ? { cwd: server.workingDirectory } : {}),
    // The SDK default first, then this user's own `PATH`, the names the user asked to pass through,
    // and the user's own pairs. `envPassthrough` has no other meaning anywhere in OpenBot; this is
    // where it is spent. The launch environment is the providers' as well, so what the panel tests
    // is what an agent starts.
    env: {
      ...getDefaultEnvironment(),
      ...mcpLaunchEnvironment(server),
    },
    // Discarded, not piped. Nothing here reads that pipe, so a server that writes its startup log to
    // stderr - which a Rust or Python server does with a blocking write - fills the 64 KB buffer and
    // stops before it answers the handshake. The probe would report a timeout for a working server.
    stderr: "ignore",
  });
}
