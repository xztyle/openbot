import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { mcpOAuthCallbackResponse } from "../src/server/mcp-oauth-callback";

it("scrubs the grant URL before sending a bounded same-origin return and denies other resource loads", async () => {
  const response = mcpOAuthCallbackResponse();
  const html = await response.text();
  const script = /<script nonce="[^"]+">([\s\S]+)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error("No callback script.");
  const events: unknown[] = [];
  class Channel {
    constructor(name: string) {
      events.push(name);
    }
    postMessage(value: unknown) {
      events.push(value);
    }
    close() {}
  }
  runInNewContext(script, {
    URL,
    location: {
      href: "https://bots.example.com/mcp-auth?state=private-state&code=private-code",
      pathname: "/mcp-auth",
    },
    history: { replaceState: (...args: unknown[]) => events.push(args) },
    BroadcastChannel: Channel,
  });
  expect(events).toEqual([
    [null, "", "/mcp-auth"],
    "openbot-mcp-oauth:private-state",
    { state: "private-state", code: "private-code", error: "" },
  ]);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(html).not.toContain("private-code");
});
