import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentSummary } from "@openbot/contracts/ipc";
import type { WebPushRegistration } from "@openbot/contracts/team-protocol/web-push-v1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isPushServiceEndpoint, WebPushRefusal, WebPushService } from "./web-push";
import { WebPushStore } from "./web-push-store";

const agent: AgentSummary = {
  id: "agent-chief",
  name: "Chief",
  title: "",
  description: "",
  notifications: true,
  provider: "codex",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  threadId: "thread-chief",
  workspacePath: "/tmp/chief",
  preview: "",
  updatedAt: null,
  avatarSeed: "chief",
  avatarHue: 215,
  avatarUrl: null,
};
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/secret-token";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openbot-web-push-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

/** A browser: it holds the private key that opens a message. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = Buffer.from("0123456789abcdef");
  return {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: auth.toString("base64url"),
    open(body: Buffer): unknown {
      const salt = body.subarray(0, 16);
      const idLength = body.readUInt8(20);
      const serverPublic = body.subarray(21, 21 + idLength);
      const record = body.subarray(21 + idLength);
      const info = Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", ecdh.computeSecret(serverPublic), auth, info, 32));
      const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const decipher = createDecipheriv("aes-128-gcm", key, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      return JSON.parse(plain.subarray(0, -1).toString("utf8"));
    },
  };
}

function setup(options: { status?: number; memberActive?: boolean; hidden?: string[] } = {}) {
  let listener: ((event: AgentEvent) => void) | undefined;
  const sent: Array<{ url: string; init: RequestInit }> = [];
  const store = new WebPushStore(join(directory, "web-push.json"));
  const service = new WebPushService({
    agents: {
      on: (_event, next) => {
        listener = next;
      },
      off: () => {
        listener = undefined;
      },
      listAgents: () => [agent],
    },
    store,
    hostId: () => "host-1",
    memberActive: () => options.memberActive ?? true,
    hiddenAgentIds: () => new Set(options.hidden ?? []),
    fetch: vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: options.status ?? 201 });
    }),
    now: () => 1_000_000,
  });
  return { service, store, sent, emit: (event: AgentEvent) => listener?.(event) };
}

const registration = (keys: { p256dh: string; auth: string }, extra: Partial<WebPushRegistration> = {}) => ({
  endpoint: ENDPOINT,
  ...keys,
  level: "all" as const,
  mutedUntil: null,
  locale: "en-US",
  ...extra,
});
const finished: AgentEvent = {
  type: "turn-completed",
  agentId: "agent-chief",
  threadId: "thread-chief",
  turnId: "turn-1",
  status: "completed",
};

describe("web push subscriptions", () => {
  it("accepts the address of a push service and refuses any other, so a member cannot aim the host elsewhere", () => {
    for (const endpoint of [
      ENDPOINT,
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ])
      expect(isPushServiceEndpoint(endpoint)).toBe(true);
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://storage.googleapis.com/x",
      "https://127.0.0.1/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://user:pass@fcm.googleapis.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://evilpush.apple.com.example/x",
      "not a url",
    ])
      expect(isPushServiceEndpoint(endpoint)).toBe(false);
    const app = setup();
    expect(() =>
      app.service.register("member", 3, registration(browser(), { endpoint: "https://127.0.0.1/x" })),
    ).toThrow(WebPushRefusal);
  });

  it("keeps the key pair and the subscriptions in a file that only the host's user reads, and the same key after a restart", () => {
    const app = setup();
    const key = app.service.publicKey();
    app.service.register("member", 3, registration(browser()));
    expect(statSync(join(directory, "web-push.json")).mode & 0o777).toBe(0o600);
    const again = new WebPushStore(join(directory, "web-push.json"));
    expect(again.vapidKeys().publicKey).toBe(key);
    expect(again.list().map((item) => item.endpoint)).toEqual([ENDPOINT]);
  });

  it("gives up the oldest browser of a member that has too many, and lets only its member remove one", () => {
    const app = setup();
    for (let index = 0; index < 11; index++)
      app.service.register(
        "member",
        3,
        registration(browser(), { endpoint: `https://fcm.googleapis.com/fcm/send/${index}` }),
      );
    const endpoints = app.store.list().map((item) => item.endpoint);
    expect(endpoints).toHaveLength(10);
    expect(endpoints).not.toContain("https://fcm.googleapis.com/fcm/send/0");
    app.service.remove("another", "https://fcm.googleapis.com/fcm/send/10");
    expect(app.store.list()).toHaveLength(10);
    app.service.remove("member", "https://fcm.googleapis.com/fcm/send/10");
    expect(app.store.list()).toHaveLength(9);
  });
});

describe("web push messages", () => {
  it("sends a signed message that only the browser opens, with the agent's name and no chat text", async () => {
    const app = setup();
    const keys = browser();
    app.service.register("member", 3, registration(keys));
    app.emit(finished);
    await app.service.dispose();
    expect(app.sent).toHaveLength(1);
    const [request] = app.sent;
    expect(request?.url).toBe(ENDPOINT);
    const headers = new Headers(request?.init.headers);
    expect(headers.get("Authorization")).toMatch(/^vapid t=.+, k=.+$/u);
    expect(headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(request?.init.redirect).toBe("manual");
    const body = Buffer.from(request?.init.body instanceof Uint8Array ? request.init.body : new Uint8Array());
    expect(keys.open(body)).toEqual({
      v: 1,
      kind: "finished",
      title: "Chief",
      body: "Finished working.",
      agentId: "agent-chief",
      threadId: "thread-chief",
      hostId: "host-1",
    });
  });

  it("follows the level and the mute of the browser, the agent's own switch, and the agents a browser cannot see", async () => {
    const quiet = setup();
    quiet.service.register("member", 3, registration(browser(), { level: "needs-me" }));
    quiet.emit(finished);
    quiet.service.register("member", 3, registration(browser(), { mutedUntil: 2_000_000 }));
    quiet.emit(finished);
    await quiet.service.dispose();
    expect(quiet.sent).toHaveLength(0);

    const hidden = setup({ hidden: ["agent-chief"] });
    hidden.service.register("member", 3, registration(browser()));
    hidden.emit(finished);
    await hidden.service.dispose();
    expect(hidden.sent).toHaveLength(0);

    const needsMe = setup();
    const keys = browser();
    needsMe.service.register("member", 3, registration(keys, { level: "needs-me" }));
    needsMe.emit({
      type: "approval",
      approval: {
        requestId: "r1",
        agentId: "agent-chief",
        threadId: "thread-chief",
        turnId: "turn-1",
        kind: "command",
        command: "rm -rf /secret",
        cwd: null,
        reason: "Delete the secret folder",
        grantRoot: null,
        permissions: null,
      },
    });
    await needsMe.service.dispose();
    expect(needsMe.sent).toHaveLength(1);
    const body = Buffer.from(
      needsMe.sent[0]?.init.body instanceof Uint8Array ? needsMe.sent[0].init.body : new Uint8Array(),
    );
    const message = JSON.stringify(keys.open(body));
    expect(message).toContain("Needs your approval.");
    expect(message).not.toContain("secret");
  });

  it("forgets a subscription that the push service ended, and one of a member who left", async () => {
    const gone = setup({ status: 410 });
    gone.service.register("member", 3, registration(browser()));
    gone.emit(finished);
    await gone.service.dispose();
    expect(gone.store.list()).toHaveLength(0);

    const left = setup({ memberActive: false });
    left.service.register("member", 3, registration(browser()));
    left.emit(finished);
    await left.service.dispose();
    expect(left.sent).toHaveLength(0);
    expect(left.store.list()).toHaveLength(0);
  });
});
