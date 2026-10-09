import { createDecipheriv, createECDH, createPublicKey, createVerify, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  encryptWebPushMessage,
  generateVapidKeys,
  vapidAuthorization,
  WEB_PUSH_MAX_PAYLOAD_BYTES,
} from "./web-push-crypto";

const b64 = (text: string) => Buffer.from(text, "base64url");

/** What a browser does with a push message (RFC 8291 section 3.4 and RFC 8188), written apart from the sender. */
function decrypt(body: Buffer, userAgent: ReturnType<typeof createECDH>, authSecret: Buffer): string {
  const salt = body.subarray(0, 16);
  const idLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const secret = userAgent.computeSecret(serverPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), userAgent.getPublicKey(), serverPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, info, 32));
  const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1).toString("utf8");
}

describe("web push message encryption (RFC 8291)", () => {
  // Appendix A of RFC 8291.
  const vector = {
    plaintext: "When I grow up, I want to be a watermelon",
    serverPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
    userAgentPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    auth: "BTBZMqHH6r4Tts7J_aSIgg",
    salt: "DGv6ra1nlYgDCS1FRnbzlw",
    body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  };

  it("makes the body of the RFC example", () => {
    const body = encryptWebPushMessage(
      Buffer.from(vector.plaintext),
      { p256dh: vector.userAgentPublic, auth: vector.auth },
      { serverPrivateKey: b64(vector.serverPrivate), salt: b64(vector.salt) },
    );
    expect(body.toString("base64url")).toBe(vector.body);
  });

  it("gives a browser the message back, with a new key and salt each time", () => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = Buffer.from("0123456789abcdef");
    const subscription = { p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
    const message = JSON.stringify({ title: "Chief", body: "Finished working." });
    const first = encryptWebPushMessage(Buffer.from(message), subscription);
    const second = encryptWebPushMessage(Buffer.from(message), subscription);
    expect(first.equals(second)).toBe(false);
    expect(decrypt(first, browser, auth)).toBe(message);
    expect(decrypt(second, browser, auth)).toBe(message);
  });

  it("refuses keys of the wrong size and a message that does not fit one record", () => {
    expect(() => encryptWebPushMessage(Buffer.from("x"), { p256dh: "AAAA", auth: vector.auth })).toThrow();
    expect(() =>
      encryptWebPushMessage(Buffer.alloc(WEB_PUSH_MAX_PAYLOAD_BYTES + 1), {
        p256dh: vector.userAgentPublic,
        auth: vector.auth,
      }),
    ).toThrow();
    expect(base64UrlDecode("AAAA", 3)).not.toBeNull();
    expect(base64UrlDecode("AAAA=", 3)).toBeNull();
  });
});

describe("VAPID identification (RFC 8292)", () => {
  /** An ES256 token is `header.claims.signature`, with the 64 bytes of `r` and `s` as the signature. */
  function verify(token: string, publicKey: string): boolean {
    const [header, claims, signature] = token.split(".");
    const key = createPublicKey({
      key: {
        kty: "EC",
        crv: "P-256",
        x: b64(publicKey).subarray(1, 33).toString("base64url"),
        y: b64(publicKey).subarray(33).toString("base64url"),
      },
      format: "jwk",
    });
    return createVerify("SHA256")
      .update(`${header}.${claims}`)
      .verify({ key, dsaEncoding: "ieee-p1363" }, b64(signature ?? ""));
  }

  it("signs a token for the origin of the endpoint that its public key verifies", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({
      endpoint: "https://fcm.googleapis.com/fcm/send/abc",
      subject: "https://openbot.run",
      keys,
      nowSeconds: 1_000_000,
    });
    const match = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
    expect(match?.[2]).toBe(keys.publicKey);
    const token = match?.[1] ?? "";
    expect(JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: 1_000_000 + 12 * 60 * 60,
      sub: "https://openbot.run",
    });
    expect(verify(token, keys.publicKey)).toBe(true);
    expect(verify(token, generateVapidKeys().publicKey)).toBe(false);
    // A changed claim breaks the signature.
    const [head, , signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ aud: "https://example.com", exp: 1, sub: "https://openbot.run" }));
    expect(verify(`${head}.${forged.toString("base64url")}.${signature}`, keys.publicKey)).toBe(false);
  });
});
