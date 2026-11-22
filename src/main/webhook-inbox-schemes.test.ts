import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { maskPersonalData, verifyHotmart, verifyStripe, verifyYouTube } from "./webhook-inbox-schemes";

const NOW = 1_800_000_000_000;

describe("verifyStripe", () => {
  const secret = "whsec_test";
  const body = Buffer.from(
    JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      created: 1_800_000_000,
      livemode: true,
      data: { object: { id: "cs_1", amount_total: 4900, customer_details: { email: "a@b.c" } } },
    }),
  );
  const sign = (t: number, payload = body) =>
    `t=${t},v1=${createHmac("sha256", secret).update(`${t}.`).update(payload).digest("hex")}`;
  const request = (signature: string, payload = body) => ({
    headers: { "content-type": "application/json", "stripe-signature": signature },
    body: payload,
    nowMs: NOW,
  });

  it("accepts a fresh signature and names the event by its id", () => {
    const result = verifyStripe(secret, request(sign(NOW / 1000)));
    expect(result).toMatchObject({
      ok: true,
      event: { deliveryId: "evt_1", eventType: "checkout.session.completed", occurredAt: "2027-01-15T08:00:00.000Z" },
    });
    expect(JSON.stringify(result)).not.toContain("a@b.c");
  });

  it("refuses an old, a wrong or a missing signature", () => {
    expect(verifyStripe(secret, request(sign(NOW / 1000 - 600)))).toEqual({ ok: false, status: 401 });
    expect(verifyStripe("whsec_other", request(sign(NOW / 1000)))).toEqual({ ok: false, status: 401 });
    expect(verifyStripe(secret, request(""))).toEqual({ ok: false, status: 401 });
    const tampered = Buffer.from(body.toString().replace("4900", "1"));
    expect(verifyStripe(secret, request(sign(NOW / 1000), tampered))).toEqual({ ok: false, status: 401 });
  });
});

describe("verifyHotmart", () => {
  const body = Buffer.from(
    JSON.stringify({
      id: "a1b2",
      event: "PURCHASE_APPROVED",
      creation_date: NOW,
      data: {
        product: { id: 7, name: "Curso" },
        buyer: { email: "x@y.z", name: "Ana" },
        purchase: { transaction: "HP1" },
      },
    }),
  );
  it("accepts the account's hottok and masks the buyer's contact", () => {
    const result = verifyHotmart("hottok-1", {
      headers: { "content-type": "application/json", "x-hotmart-hottok": "hottok-1" },
      body,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: true, event: { deliveryId: "a1b2", eventType: "PURCHASE_APPROVED" } });
    expect(JSON.stringify(result)).not.toContain("x@y.z");
    expect(JSON.stringify(result)).toContain("Ana");
  });
  it("refuses another token", () => {
    expect(
      verifyHotmart("hottok-1", {
        headers: { "content-type": "application/json", "x-hotmart-hottok": "no" },
        body,
        nowMs: NOW,
      }),
    ).toEqual({ ok: false, status: 401 });
  });
});

describe("verifyYouTube", () => {
  const xml = Buffer.from(
    `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:videoId>abc123</yt:videoId><yt:channelId>UC1</yt:channelId><title>New video</title><published>2026-11-20T10:00:00+00:00</published><updated>2026-11-20T10:05:00+00:00</updated></entry></feed>`,
  );
  it("reads a signed Atom entry", () => {
    const signature = `sha1=${createHmac("sha1", "hub").update(xml).digest("hex")}`;
    const result = verifyYouTube("hub", {
      headers: { "content-type": "application/atom+xml", "x-hub-signature": signature },
      body: xml,
      nowMs: NOW,
    });
    expect(result).toMatchObject({
      ok: true,
      event: { eventType: "youtube.video", data: { videoId: "abc123", channelId: "UC1", title: "New video" } },
    });
  });
  it("refuses an unsigned entry", () => {
    expect(
      verifyYouTube("hub", { headers: { "content-type": "application/atom+xml" }, body: xml, nowMs: NOW }),
    ).toEqual({ ok: false, status: 401 });
  });
});

describe("maskPersonalData", () => {
  it("masks contact fields at any depth and keeps the rest", () => {
    expect(maskPersonalData({ a: [{ email: "e", phone: "" }], value: 3, ok: true })).toEqual({
      a: [{ email: "•••", phone: "" }],
      value: 3,
      ok: true,
    });
  });
});
