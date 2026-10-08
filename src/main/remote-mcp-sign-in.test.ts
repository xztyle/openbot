// @vitest-environment node
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { runCauseEffect } from "../backend/effect-boundary";

import { McpOAuth } from "../backend/mcp-oauth-provider";
import type { testMcpServer } from "../backend/mcp-probe";
import { RemoteMcpSignIn } from "./remote-mcp-sign-in";

const callback = "https://bots.example.com/mcp-auth";
function fixture(timeoutMs?: number, success = false) {
  const cleared: string[] = [];
  let saved = false;
  const oauth = new McpOAuth({
    storage: {
      read: () => null,
      write: () => Effect.void,
      clear: (key) =>
        Effect.sync(() => {
          cleared.push(key);
        }),
    },
    redirectUrl: "openbot://mcp-auth",
    openExternal: async () => {},
  });
  const probe: typeof testMcpServer = (config, _timeout, _tools, authority) =>
    Effect.gen(function* () {
      const signIn = authority?.signIn(config.url);
      const state = yield* Effect.promise(async () => signIn?.provider.state?.());
      if (!signIn || !state) throw new Error("No sign-in state.");
      const address = new URL("https://provider.example.com/authorize");
      address.searchParams.set("state", state);
      address.searchParams.set("redirect_uri", callback);
      yield* Effect.promise(async () => signIn.provider.redirectToAuthorization(address));
      if (success) return { toolCount: 3, error: null };
      return yield* Effect.never;
    });
  const manager = new RemoteMcpSignIn({ oauth, redirectUrl: callback, probe, timeoutMs, isSaved: () => saved });
  const input = {
    url: "https://mcp.example.com/mcp",
    redirectUrl: callback,
    accountId: `mcpacct-${crypto.randomUUID()}`,
  };
  return {
    oauth,
    manager,
    input,
    cleared,
    save: () => {
      saved = true;
    },
    close: async () => {
      await runCauseEffect(manager.close());
      await runCauseEffect(oauth.close());
    },
  };
}
it("pins callbacks, binds attempts to the initiating session, consumes state once and cancels safely", async () => {
  const f = fixture();
  try {
    await expect(
      runCauseEffect(
        f.manager.start(
          "owner:session",
          { ...f.input, redirectUrl: "https://evil.example/mcp-auth" },
          new Date(Date.now() + 60_000).toISOString(),
        ),
      ),
    ).rejects.toThrow();
    const started = await runCauseEffect(
      f.manager.start("owner:session", f.input, new Date(Date.now() + 60_000).toISOString()),
    );
    await vi.waitFor(() =>
      expect(f.manager.status("owner:session", started.attemptId)).toMatchObject({
        kind: "waiting",
        state: expect.any(String),
      }),
    );
    const status = f.manager.status("owner:session", started.attemptId);
    if (status.kind !== "waiting" || !status.state) throw new Error("No state.");
    expect(() => f.manager.status("owner:another-session", started.attemptId)).toThrow();
    expect(() =>
      f.manager.complete("owner:another-session", {
        attemptId: started.attemptId,
        state: status.state ?? "",
        code: "grant",
      }),
    ).toThrow();
    expect(() =>
      f.manager.complete("owner:session", { attemptId: started.attemptId, state: "forged", code: "grant" }),
    ).toThrow();
    f.manager.complete("owner:session", { attemptId: started.attemptId, state: status.state, code: "grant" });
    expect(() =>
      f.manager.complete("owner:session", { attemptId: started.attemptId, state: status.state ?? "", code: "grant" }),
    ).toThrow();
    await runCauseEffect(f.manager.cancel("owner:session", started.attemptId));
    expect(() => f.manager.status("owner:session", started.attemptId)).toThrow();
    expect(f.oauth.receiveAuthorizationCode(status.state, "late-grant")).toBe(false);
    expect(f.cleared).toContain(`${f.input.accountId}:${f.input.url}`);
  } finally {
    await f.close();
  }
});
it("expires attempts and abandons their grants", async () => {
  vi.useFakeTimers();
  const f = fixture(1000);
  try {
    const started = await runCauseEffect(
      f.manager.start("owner:session", f.input, new Date(Date.now() + 60_000).toISOString()),
    );
    vi.advanceTimersByTime(1001);
    expect(() => f.manager.status("owner:session", started.attemptId)).toThrow();
  } finally {
    await f.close();
    vi.useRealTimers();
  }
});

it("clears unsaved successful drafts at expiry and keeps saved accounts", async () => {
  vi.useFakeTimers();
  for (const saved of [false, true]) {
    const f = fixture(1000, true);
    try {
      const started = await runCauseEffect(
        f.manager.start("owner:session", f.input, new Date(Date.now() + 60_000).toISOString()),
      );
      await vi.waitFor(() =>
        expect(f.manager.status("owner:session", started.attemptId)).toMatchObject({ kind: "complete" }),
      );
      await runCauseEffect(f.manager.cancel("owner:session", started.attemptId));
      expect(f.cleared).toEqual([]);
      if (saved) f.save();
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.cleared).toHaveLength(saved ? 0 : 1);
    } finally {
      await f.close();
    }
  }
  vi.useRealTimers();
});
