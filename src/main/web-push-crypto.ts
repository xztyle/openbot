import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * Web Push for a browser, made with `node:crypto` only: the message encryption of RFC 8291
 * (`aes128gcm`, RFC 8188) and the server identification of RFC 8292 (VAPID, ES256). The `web-push`
 * package does the same, but this build adds no dependency and cannot fetch one.
 */

const P256_POINT_BYTES = 65;
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
/** RFC 8188 record size. One record carries the whole message, which is far smaller. */
const RECORD_SIZE = 4096;
/** The most plain text one record holds: the size, less the GCM tag and the delimiter byte. */
export const WEB_PUSH_MAX_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1;

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Decodes base64url text that must be exactly `length` bytes long, or returns null. */
export function base64UrlDecode(text: string, length: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.length === length && bytes.toString("base64url") === text ? bytes : null;
}

export interface WebPushSubscriptionKeys {
  /** The browser's public key, as base64url of an uncompressed P-256 point. */
  p256dh: string;
  /** The browser's authentication secret, as base64url of 16 bytes. */
  auth: string;
}

/** Test inputs. A real send leaves them out, so each message has a new key and salt. */
export interface WebPushEncryptionOverrides {
  serverPrivateKey?: Buffer;
  salt?: Buffer;
}

/**
 * Encrypts one push message for one subscription (RFC 8291 section 3.4) and returns the request body
 * of RFC 8188: the header with the salt, the record size and the sender's public key, then the record.
 * Only the browser holds the key that opens it. The push service sees the size and the time.
 */
export function encryptWebPushMessage(
  message: Uint8Array,
  subscription: WebPushSubscriptionKeys,
  overrides: WebPushEncryptionOverrides = {},
): Buffer {
  if (message.length > WEB_PUSH_MAX_PAYLOAD_BYTES) throw new Error("The push message is too large.");
  const userAgentPublic = base64UrlDecode(subscription.p256dh, P256_POINT_BYTES);
  const authSecret = base64UrlDecode(subscription.auth, AUTH_SECRET_BYTES);
  if (!userAgentPublic || !authSecret) throw new Error("The push subscription keys are not valid.");

  const server = createECDH("prime256v1");
  if (overrides.serverPrivateKey) server.setPrivateKey(overrides.serverPrivateKey);
  else server.generateKeys();
  const serverPublic = server.getPublicKey();
  const salt = overrides.salt ?? randomBytes(SALT_BYTES);

  const sharedSecret = server.computeSecret(userAgentPublic);
  // node's `hkdfSync` is extract and expand in one call: salt, input key, info, length.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), userAgentPublic, serverPublic]);
  const inputKey = Buffer.from(hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32));
  const contentKey = Buffer.from(
    hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16),
  );
  const nonce = Buffer.from(hkdfSync("sha256", inputKey, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12));

  // 0x02 ends the last record, as RFC 8188 section 2 says.
  const cipher = createCipheriv("aes-128-gcm", contentKey, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(message), Buffer.from([2])])),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header.writeUInt8(serverPublic.length, SALT_BYTES + 4);
  return Buffer.concat([header, serverPublic, record, tag]);
}

export interface VapidKeys {
  /** The public key as base64url of an uncompressed P-256 point: the `applicationServerKey` of the browser. */
  publicKey: string;
  /** The private key as a JWK with `d`. Stored in a file that only the host's user can read. */
  privateJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; d: string };
}

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d)
    throw new Error("The push key pair could not be made.");
  return {
    publicKey: vapidPublicKey(jwk.x, jwk.y),
    privateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
  };
}

export function vapidPublicKey(x: string, y: string): string {
  return base64UrlEncode(Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]));
}

/** The longest a VAPID token may live is 24 hours (RFC 8292 section 2). A shorter one costs nothing. */
const VAPID_TOKEN_SECONDS = 12 * 60 * 60;

/**
 * The `Authorization` header of RFC 8292: a signed token that names the push service of the endpoint
 * and who sends, and the public key that checks it. The push service ties the subscription to this key.
 */
export function vapidAuthorization(options: {
  endpoint: string;
  /** A `mailto:` or `https:` URL that the push service can use to reach the sender. */
  subject: string;
  keys: VapidKeys;
  nowSeconds: number;
}): string {
  const audience = new URL(options.endpoint).origin;
  const header = base64UrlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    Buffer.from(JSON.stringify({ aud: audience, exp: options.nowSeconds + VAPID_TOKEN_SECONDS, sub: options.subject })),
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: createPrivateKey({ key: options.keys.privateJwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${base64UrlEncode(signature)}, k=${options.keys.publicKey}`;
}
