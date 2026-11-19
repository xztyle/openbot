// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, BrowserTab } from "@openbot/contracts/ipc";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentApiKeys, SHARED_API_KEY_SCOPE } from "../agent-api-keys";
import type { AgentClient } from "../agent-client";
import type { PreparedBrowserSecret } from "../browser-host";
import type { AppServerRequest, DynamicToolResult } from "../protocol";
import type { ProviderClientOperationError } from "../provider-client-effects";
import { AttentionRegistry } from "./attention-registry";

// `submit_secret` with `secretKey` fills a Secrets key into a password field. The value goes to the
// browser only: never into the agent's tool result or an event, and never where a Vault fill is refused.

const AGENT = "agent-1";
const THREAD = "thread-1";
const ORIGIN = "https://social.example.test";
const KEY = "SITE_PASSWORD";
const VALUE = "correct-horse-battery-staple-7";

interface Setup {
  registry: AttentionRegistry;
  events: AgentEvent[];
  submitted: string[];
  readonly prepared: number;
}

let root: string;
let keys: AgentApiKeys;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "openbot-secret-fill-"));
  keys = new AgentApiKeys(root);
  await Effect.runPromise(keys.save(SHARED_API_KEY_SCOPE, KEY, VALUE));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup(options: { scripted?: boolean; fillable?: boolean; approve?: "accept" | "decline" }): Setup {
  const tab: BrowserTab = {
    id: "tab-1",
    title: "Sign in",
    url: `${ORIGIN}/login`,
    loading: false,
    ownerThreadId: THREAD,
    ownerAgentId: AGENT,
  };
  const events: AgentEvent[] = [];
  const submitted: string[] = [];
  let prepared = 0;
  const prepareSecret = (): Effect.Effect<PreparedBrowserSecret> =>
    Effect.sync(() => {
      prepared += 1;
      return {
        request: { method: "password", origin: ORIGIN, digits: 6 },
        agentScriptedOrigin: options.scripted ?? false,
        vaultFillable: options.fillable ?? true,
        submit: (secret: string) =>
          Effect.sync(() => {
            submitted.push(secret);
            return "submitted" as const;
          }),
        cancel: () => undefined,
      };
    });
  const registry = new AttentionRegistry({
    conversation: {
      agentForThread: () => AGENT,
      publicThreadId: () => THREAD,
      emitConversation: () => undefined,
      ensureSnapshot: () => {
        throw new Error("No conversation in this test.");
      },
    },
    browser: {
      prepareSecret,
      listTabs: () => [tab],
      beginTakeover: () => Effect.void,
      endTakeover: () => undefined,
    },
    hostedSites: { prepareApproval: () => Effect.succeed(null), resolveApproval: () => Effect.void },
    routines: { markNeedsAttention: () => undefined, markRunningForTurn: () => undefined },
    emit: (event) => {
      events.push(event);
      // The owner answers the approval card; the user closes a secure input card.
      if (event.type === "approval")
        queueMicrotask(() =>
          Effect.runFork(
            registry.respondToApproval({
              requestId: event.approval.requestId,
              decision: options.approve ?? "accept",
            }),
          ),
        );
      if (event.type === "browser-takeover-requested")
        queueMicrotask(() =>
          Effect.runFork(registry.respondToBrowserTakeover({ requestId: event.request.requestId, decision: "cancel" })),
        );
    },
    emitError: () => undefined,
    emitRuntimeSnapshot: () => undefined,
    apiKeys: keys,
  });
  return {
    registry,
    events,
    submitted,
    get prepared() {
      return prepared;
    },
  };
}

/** The provider. The fill answers through the tool result, so the client gets no call. */
class SilentClient implements AgentClient {
  readonly provider = "codex";
  readonly running = true;
  start(): void {}
  stop() {
    return Effect.void;
  }
  request<T>(): Effect.Effect<T, ProviderClientOperationError> {
    return Effect.die(new Error("No provider request in this test."));
  }
  notify(): void {}
  respond(): void {}
  respondError(): void {}
  on(): this {
    return this;
  }
  once(): this {
    return this;
  }
  off(): this {
    return this;
  }
}

const client = new SilentClient();
let call = 0;

/** The arguments a test changes; the rest are those of a password step. */
interface SubmitArgs {
  secretKey?: string;
  method?: "password" | "otp";
  digits?: number;
}

function submit(state: Setup, args: SubmitArgs = {}): Promise<DynamicToolResult> {
  call += 1;
  const request: AppServerRequest = {
    method: "item/tool/call",
    id: `call-${call}`,
    params: {
      threadId: "provider-thread",
      turnId: "turn-1",
      callId: `call-${call}`,
      namespace: "openbot_browser",
      tool: "submit_secret",
      arguments: {
        tabId: "tab-1",
        method: "password",
        targets: [{ kind: "ref", ref: "e1", revision: 1 }],
        submission: "enter",
        secretKey: KEY,
        ...args,
      },
    },
  };
  return Effect.runPromise(state.registry.surfaceBrowserTakeover(client, request));
}

function text(result: DynamicToolResult): string {
  return result.contentItems.map((item) => (item.type === "inputText" ? item.text : item.imageUrl)).join("\n");
}

describe("submit_secret with secretKey", () => {
  it("fills the key into the page and keeps the value out of the result and the events", async () => {
    const state = setup({});
    const result = await submit(state);
    expect(state.submitted).toEqual([VALUE]);
    expect(result.success).toBe(true);
    expect(text(result)).toContain(`filled the saved key ${KEY}`);
    expect(text(result)).not.toContain(VALUE);
    expect(JSON.stringify(state.events)).not.toContain(VALUE);
    expect(state.events.filter((event) => event.type === "approval")).toHaveLength(1);
  });

  it("asks the owner only for the first fill of a key on a site", async () => {
    await submit(setup({}));
    const state = setup({});
    await submit(state);
    expect(state.submitted).toEqual([VALUE]);
    expect(state.events.some((event) => event.type === "approval")).toBe(false);
  });

  it("does not fill when the owner declines", async () => {
    const state = setup({ approve: "decline" });
    const result = await submit(state);
    expect(state.submitted).toEqual([]);
    expect(text(result)).toContain("did not let OpenBot fill");
    expect(keys.fillApproved(SHARED_API_KEY_SCOPE, KEY, ORIGIN)).toBe(false);
  });

  it("opens the user's card, not a fill, on a site where the agent ran a script", async () => {
    const state = setup({ scripted: true });
    const result = await submit(state);
    expect(state.submitted).toEqual([]);
    expect(state.events.some((event) => event.type === "browser-takeover-requested")).toBe(true);
    expect(state.events.some((event) => event.type === "approval")).toBe(false);
    expect(text(result)).not.toContain(VALUE);
  });

  it("opens the user's card, not a fill, for a field that is not a password field", async () => {
    const state = setup({ fillable: false });
    const result = await submit(state);
    expect(state.submitted).toEqual([]);
    expect(state.events.some((event) => event.type === "browser-takeover-requested")).toBe(true);
    expect(text(result)).not.toContain(VALUE);
  });

  it("refuses a missing key and names list_api_keys", async () => {
    const state = setup({});
    const result = await submit(state, { secretKey: "OTHER_PASSWORD" });
    expect(result.success).toBe(false);
    expect(text(result)).toContain("openbot.list_api_keys");
    expect(state.prepared).toBe(0);
  });

  it("refuses a key for a code", async () => {
    const state = setup({});
    const result = await submit(state, { method: "otp", digits: 6 });
    expect(result.success).toBe(false);
    expect(state.prepared).toBe(0);
  });
});
