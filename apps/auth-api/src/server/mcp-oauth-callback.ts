import { MCP_OAUTH_CHANNEL_PREFIX } from "@openbot/contracts/team-protocol/mcp-oauth-callback";
import { createTranslate, en } from "@openbot/i18n";

/** No request values reach server text, logs, storage or HTML. Only the browser reads the grant. */
export function mcpOAuthCallbackResponse(): Response {
  const nonce = crypto.randomUUID();
  const t = createTranslate({ source: en, locale: "en", sourceLocale: "en" });
  const message = t("mcp.remote.returned");
  const prefix = JSON.stringify(MCP_OAUTH_CHANNEL_PREFIX);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>OpenBot</title></head><body><p>${message}</p><script nonce="${nonce}">
    const params = new URL(location.href).searchParams;
    history.replaceState(null, '', location.pathname);
    const state = params.get('state') || '';
    const code = params.get('code') || '';
    const error = params.get('error') || '';
    if (state && state.length <= 128 && code.length <= 4096 && error.length <= 128) {
      const channel = new BroadcastChannel(${prefix} + state);
      channel.postMessage({state, code, error});
      channel.close();
    }
  </script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    },
  });
}
