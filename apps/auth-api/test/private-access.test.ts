import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/server/auth-service";
import { sha256 } from "../src/server/crypto";
import { D1AuthRepository } from "../src/server/d1-auth-repository";
import { disabledObjectStorage } from "../src/server/disabled-object-storage";
import { runApiEffect } from "../src/server/effect-runtime";
import { createEmailCodeDelivery } from "../src/server/email-delivery";
import { RemoteControlPlane } from "../src/server/remote-control-plane";
import { PERSISTENT_SESSION_EXPIRES_AT } from "../src/server/session-policy";
import { sqliteD1 } from "./sqlite-d1";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";

function fixture(allowedEmails: readonly string[] = [OWNER]) {
  const database = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const name of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    database.exec(readFileSync(new URL(name, migrations), "utf8"));
  }
  const repository = new D1AuthRepository(sqliteD1(database));
  let now = 1_000;
  const service = new AuthService({
    repository,
    delivery: null,
    exposeDevelopmentCode: true,
    allowedEmails,
    now: () => now,
  });
  return {
    database,
    repository,
    service,
    time: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

async function signIn(service: AuthService, email: string, sessionLifetimeMs?: number, sourceIp = "203.0.113.1") {
  const challenge = await runApiEffect(service.startEmailSignIn(email, sourceIp));
  if (!challenge.developmentCode) throw new Error("The fixture code is missing.");
  return runApiEffect(
    service.verifyEmailCode({
      challengeId: challenge.challengeId,
      code: challenge.developmentCode,
      sourceIp,
      sessionLifetimeMs,
    }),
  );
}

async function remote(database: DatabaseSync, now: () => number) {
  const keys = await generateKeyPair("ES256", { extractable: true });
  return new RemoteControlPlane(
    {
      DB: sqliteD1(database),
      REMOTE_TICKET_KEY_ID: "private-test",
      REMOTE_TICKET_PRIVATE_JWK: JSON.stringify(await exportJWK(keys.privateKey)),
      REMOTE_TICKET_PUBLIC_JWKS: JSON.stringify({
        keys: [{ ...(await exportJWK(keys.publicKey)), kid: "private-test", alg: "ES256" }],
      }),
    },
    { now },
  );
}

describe("private account boundary", () => {
  it("caps native and mobile credentials outside the trusted VPS addresses", async () => {
    const { database, repository, time, advance } = fixture();
    const service = new AuthService({
      repository,
      delivery: null,
      exposeDevelopmentCode: true,
      allowedEmails: [OWNER],
      now: time,
      defaultSessionLifetimeMs: 3_600_000,
      durableSourceIps: ["203.0.113.1"],
    });
    const client = await signIn(service, OWNER, undefined, "203.0.113.2");
    const clientHash = await runApiEffect(sha256(client.sessionToken));
    expect(database.prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(clientHash)).toEqual({
      expires_at: time() + 3_600_000,
    });
    advance(61_000);
    const host = await signIn(service, OWNER);
    const ticket = await runApiEffect(service.issueMobileAuthTicket(host.sessionToken, "203.0.113.2"));
    const phone = await runApiEffect(
      service.redeemMobileAuthTicket(
        ticket.ticket,
        { id: "dc266424-d342-47ef-a093-3f38c07009e2", name: "Phone", platform: "ios" },
        "203.0.113.2",
      ),
    );
    if (!phone) throw new Error("The phone pairing failed.");
    expect(
      database
        .prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?")
        .get(await runApiEffect(sha256(phone.sessionToken))),
    ).toEqual({ expires_at: time() + 3_600_000 });
    advance(3_600_000);
    expect(await runApiEffect(service.authenticate(host.sessionToken))).toMatchObject({ email: OWNER });
    expect(await runApiEffect(service.authenticateMobileSession(phone.sessionToken))).toBeNull();
    database.close();
  });

  it("refuses unapproved mailboxes before creating a challenge", async () => {
    const { database, service } = fixture();
    await expect(runApiEffect(service.startEmailSignIn(OTHER, "203.0.113.1"))).rejects.toMatchObject({
      code: "account_not_allowed",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM email_login_challenges").get()).toEqual({ count: 0 });
    database.close();
  });

  it("normalizes the configured mailbox and the sign-in address", async () => {
    const { database, service } = fixture([` ${OWNER.toUpperCase()} `]);
    const session = await signIn(service, ` ${OWNER.toUpperCase()} `);
    expect((await runApiEffect(service.authenticate(session.sessionToken)))?.email).toBe(OWNER);
    database.close();
  });

  it("refuses an outstanding code after its mailbox is removed", async () => {
    const { database, service, repository, time } = fixture([OWNER, OTHER]);
    const challenge = await runApiEffect(service.startEmailSignIn(OTHER, "203.0.113.1"));
    const restricted = new AuthService({
      repository,
      delivery: null,
      exposeDevelopmentCode: true,
      allowedEmails: [OWNER],
      now: time,
    });
    await expect(
      runApiEffect(
        restricted.verifyEmailCode({
          challengeId: challenge.challengeId,
          code: challenge.developmentCode ?? "",
          sourceIp: "203.0.113.1",
        }),
      ),
    ).rejects.toMatchObject({ code: "account_not_allowed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
    database.close();
  });

  it("rejects existing credentials when the mailbox is no longer allowed", async () => {
    const { database, service, repository, time } = fixture([OWNER, OTHER]);
    const session = await signIn(service, OTHER);
    const restricted = new AuthService({
      repository,
      delivery: null,
      exposeDevelopmentCode: true,
      allowedEmails: [OWNER],
      now: time,
    });
    expect(await runApiEffect(restricted.authenticate(session.sessionToken))).toBeNull();
    expect(await runApiEffect(restricted.authenticateDesktopSession(session.sessionToken))).toBeNull();
    expect(await runApiEffect(restricted.authenticateMobileSession(session.sessionToken))).toBeNull();
    database.close();
  });

  it("expires browser access and its remote session while keeping the host credential", async () => {
    const { database, service, time, advance } = fixture();
    const machine = await signIn(service, OWNER);
    advance(61_000);
    const browser = await signIn(service, OWNER, 3_600_000);
    const plane = await remote(database, time);
    await runApiEffect(
      plane.registerHost(machine.user, {
        hostId: "host-1",
        name: "Private VPS",
        ownerMembershipId: "owner-membership",
        devicePublicKey: "test-public-key",
      }),
    );
    const sessionHash = await runApiEffect(sha256(browser.sessionToken));
    const connection = await runApiEffect(plane.startSession(browser.user.id, "host-1", sessionHash));
    expect(connection.expiresAt).toBe(time() + 3_600_000);
    expect(await runApiEffect(plane.startSession(browser.user.id, "host-1", sessionHash))).toEqual(connection);
    expect(
      database.prepare("SELECT expires_at FROM remote_sessions WHERE session_id = ?").get(connection.sessionId),
    ).toEqual({ expires_at: connection.expiresAt });
    advance(3_600_000);
    expect(await runApiEffect(service.authenticate(browser.sessionToken))).toBeNull();
    expect(await runApiEffect(service.authenticate(machine.sessionToken))).toMatchObject({ email: OWNER });
    await expect(runApiEffect(plane.startSession(browser.user.id, "host-1", sessionHash))).rejects.toMatchObject({
      code: "auth_session_revoked",
    });
    expect(
      database
        .prepare("SELECT expires_at FROM auth_sessions WHERE token_hash = ?")
        .get(await runApiEffect(sha256(machine.sessionToken))),
    ).toEqual({ expires_at: PERSISTENT_SESSION_EXPIRES_AT });
    database.close();
  });
});

describe("native private email delivery", () => {
  it("sends through the account binding without contacting company servers", async () => {
    const send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => ({ messageId: "test" }));
    const delivery = createEmailCodeDelivery({ EMAIL: { send }, EMAIL_FROM: "login@delynith.com" });
    if (!delivery) throw new Error("The native binding was ignored.");
    await runApiEffect(delivery.send({ email: OWNER, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 }));
    const message = send.mock.calls[0]?.[0];
    expect(message).toMatchObject({ from: "login@delynith.com", to: OWNER, subject: "Your OpenBot sign-in code" });
    expect(message).not.toEqual(expect.objectContaining({ html: expect.stringContaining("openbot.run") }));
  });

  it("keeps email-provider failures and secrets out of public errors", async () => {
    const send = vi.fn(async (_message: EmailMessage | EmailMessageBuilder) => {
      throw new Error("private-provider-secret");
    });
    const delivery = createEmailCodeDelivery({ EMAIL: { send }, EMAIL_FROM: "login@delynith.com" });
    if (!delivery) throw new Error("The native binding was ignored.");
    await expect(
      runApiEffect(delivery.send({ email: OWNER, code: "ABCD-EFGH", expiresAt: Date.now() + 60_000 })),
    ).rejects.toMatchObject({ message: "email_delivery_unknown" });
  });
});

describe("disabled paid object storage", () => {
  it("returns no assets and refuses uploads without an external storage binding", async () => {
    expect(await disabledObjectStorage.get("avatar.png")).toBeNull();
    expect(await disabledObjectStorage.head("avatar.png")).toBeNull();
    expect((await disabledObjectStorage.list()).objects).toEqual([]);
    await expect(disabledObjectStorage.put("avatar.png", "data")).rejects.toMatchObject({
      _tag: "ObjectStorageDisabledError",
    });
    await expect(disabledObjectStorage.createMultipartUpload("archive.zip")).rejects.toMatchObject({
      _tag: "ObjectStorageDisabledError",
    });
  });
});
