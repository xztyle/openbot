import type { McpServerConfig, McpTestResult } from "@openbot/contracts/ipc";
import {
  isMcpOAuthReturn,
  MCP_OAUTH_CHANNEL_PREFIX,
  type McpOAuthReturn,
} from "@openbot/contracts/team-protocol/mcp-oauth-callback";
import {
  decodeMcpOAuthStart,
  decodeMcpOAuthStatus,
  MCP_OAUTH_ROUTES,
} from "@openbot/contracts/team-protocol/mcp-oauth-v1";
import type { TeamApiRequest } from "@openbot/team-client/team-api-requests";
import { currentText } from "@openbot/ui/text";

function cancelled(): Error {
  return new Error(currentText().t("mcp.remote.cancelled"));
}
function timedOut(): Error {
  return new Error(currentText().t("mcp.remote.timedOut"));
}
function windowClosed(): Error {
  return new Error(currentText().t("mcp.remote.windowClosed"));
}
/**
 * How long a closed pop-up may stay closed before the sign-in fails. The page that the provider
 * returns to posts its answer and closes itself, and the answer reaches this window a moment later.
 */
const CLOSED_WINDOW_GRACE_MS = 1500;

function checkActive(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}
function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 500);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

/** The popup has no opener. A private same-origin channel survives provider opener isolation. */
export async function signInWebMcp(
  config: McpServerConfig,
  request: TeamApiRequest,
  signal: AbortSignal,
): Promise<McpTestResult> {
  checkActive(signal);
  const popup = window.open("about:blank", "_blank");
  if (!popup) throw new Error(currentText().t("mcp.remote.popupBlocked"));
  popup.opener = null;
  let attemptId: string | null = null;
  let channel: BroadcastChannel | null = null;
  const callback: { value: McpOAuthReturn | null } = { value: null };
  let sent = false;
  let closedSince: number | null = null;
  try {
    const started = await request("POST", MCP_OAUTH_ROUTES.start, decodeMcpOAuthStart, {
      url: config.url,
      redirectUrl: new URL("/mcp-auth", window.location.origin).href,
      accountId: config.id,
    });
    attemptId = started.attemptId;
    for (;;) {
      checkActive(signal);
      if (Date.now() >= started.expiresAt) throw timedOut();
      const status = await request("POST", MCP_OAUTH_ROUTES.status, decodeMcpOAuthStatus, { attemptId });
      checkActive(signal);
      if (status.kind === "complete") return { toolCount: status.toolCount, error: status.error };
      if (status.authorizationUrl && status.state && !channel) {
        const address = new URL(status.authorizationUrl);
        if (address.protocol !== "https:" || address.searchParams.get("state") !== status.state)
          throw new Error(currentText().t("mcp.remote.denied"));
        const expected = status.state;
        channel = new BroadcastChannel(MCP_OAUTH_CHANNEL_PREFIX + expected);
        channel.onmessage = (event: MessageEvent<unknown>) => {
          if (isMcpOAuthReturn(event.data, expected) && !callback.value) callback.value = event.data;
        };
        popup.location.href = address.href;
      }
      const returned = callback.value;
      if (returned && !sent) {
        if (returned.error || !returned.code) throw new Error(currentText().t("mcp.remote.denied"));
        sent = true;
        await request("POST", MCP_OAUTH_ROUTES.complete, () => undefined, {
          attemptId,
          state: returned.state,
          code: returned.code,
        });
        callback.value = null;
      }
      // A window that the user closed before the provider answered never answers: say so now, not
      // after the host's attempt expires.
      if (popup.closed && !callback.value && !sent) {
        closedSince ??= Date.now();
        if (Date.now() - closedSince >= CLOSED_WINDOW_GRACE_MS) throw windowClosed();
      } else closedSince = null;
      await pollDelay(signal);
    }
  } finally {
    channel?.close();
    popup.close();
    if (attemptId)
      await request("POST", MCP_OAUTH_ROUTES.cancel, () => undefined, { attemptId }).catch(() => undefined);
  }
}
