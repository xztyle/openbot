import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebhookInbox } from "./webhook-inbox";

let folder: string;
let http: Server;
let base: string;
let inbox: WebhookInbox;
const received: { routeId: string; deliveryId: string; eventType: string }[] = [];

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "webhook-inbox-"));
  received.length = 0;
  inbox = new WebhookInbox({
    file: join(folder, "inboxes.json"),
    cipher: { encrypt: (value) => Buffer.from(`enc:${value}`), decrypt: (value) => value.toString().slice(4) },
    events: {
      inboxRoutes: () => [{ routeId: "r1", owner: { kind: "agent", id: "a1" }, routineId: "ro1", name: "Sales" }],
      receive: () => Effect.succeed({ status: 401 as const }),
      receiveVerified: (routeId, event) =>
        Effect.sync(() => {
          received.push({ routeId, deliveryId: event.deliveryId, eventType: event.eventType });
          return { status: 202 as const };
        }),
    },
  });
  http = createServer((request, response) => void inbox.handle(request, response));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${portOf(http)}`;
});

afterEach(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
  await rm(folder, { recursive: true, force: true });
});

function stripePost(secret: string) {
  const body = JSON.stringify({ id: "evt_9", type: "invoice.paid", created: 1, data: { object: { id: "in_1" } } });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return fetch(`${base}/hooks/r1`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${t},v1=${v1}` },
    body,
  });
}

describe("WebhookInbox", () => {
  it("starts the routine with a Stripe event signed with the saved secret", async () => {
    await Effect.runPromise(inbox.configure({ routeId: "r1", scheme: "stripe", secret: "whsec_s" }));
    expect((await stripePost("whsec_s")).status).toBe(202);
    expect(received).toEqual([{ routeId: "r1", deliveryId: "evt_9", eventType: "invoice.paid" }]);
    expect((await stripePost("whsec_wrong")).status).toBe(401);
    expect(received).toHaveLength(1);
    // The file holds the secret only encrypted.
    expect(await readFile(join(folder, "inboxes.json"), "utf8")).not.toContain('"whsec_s"');
    expect(inbox.list()).toMatchObject([{ routeId: "r1", scheme: "stripe", hasSecret: true }]);
  });

  it("needs a secret for a provider and knows only live routes", async () => {
    await expect(Effect.runPromise(inbox.configure({ routeId: "r1", scheme: "hotmart" }))).rejects.toThrow();
    expect((await fetch(`${base}/hooks/unknown`, { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("answers a YouTube subscription check with the challenge", async () => {
    await Effect.runPromise(inbox.configure({ routeId: "r1", scheme: "youtube", secret: "hub" }));
    const topic = encodeURIComponent("https://www.youtube.com/xml/feeds/videos.xml?channel_id=UC1");
    const response = await fetch(`${base}/hooks/r1?hub.mode=subscribe&hub.challenge=xyz&hub.topic=${topic}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("xyz");
  });
});

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The test server has no port.");
  return address.port;
}
