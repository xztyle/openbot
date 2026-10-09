// Failure mode: a route that a server's durable sign-in must not use is moved back to plain
// `requestUser`, and nothing fails until somebody reads a token off a server. The routes cannot run
// here (they import the Worker runtime), so this reads the sources. The behavior itself is tested in
// `private-access.test.ts`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROUTES = [
  // [file, text that must be there]
  ["v1/mobile-auth/ticket.ts", "issueMobileAuthTicket"],
  ["v1/team-auth/ticket.ts", "issueTeamAuthTicket"],
  ["v1/mobile-auth/devices.ts", "listMobileAuthDevices"],
  ["v1/mobile-auth/devices/$sessionId.ts", "revoke"],
  ["v1/me/billing/index.ts", "requestInteractiveUser"],
  ["v1/me/billing/portal.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/index.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/$serverId/index.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/$serverId/checkout.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/$serverId/lifecycle.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/$serverId/status.ts", "requestInteractiveUser"],
  ["v2/hosting/servers/$serverId/wake.ts", "requestInteractiveUser"],
  ["v2/remote/sessions/index.ts", "requestInteractiveUser"],
  ["v2/remote/sessions/$sessionId/ticket.ts", "requestInteractiveUser"],
  ["v2/remote/hosts/$hostId/invites.ts", 'body.role === "admin" || body.permanent === true'],
  ["v2/remote/hosts/$hostId/members/$membershipId.ts", 'body.role === "admin" || body.reactivate === true'],
] as const;
// What a server needs, and so must keep working with its own sign-in.
const HOST_ROUTES = [
  "v2/remote/hosts/register.ts",
  "v2/remote/hosts/$hostId/ticket.ts",
  "v2/remote/hosts/$hostId/webhook-route.ts",
  "v2/remote/hosts/$hostId/slack-route.ts",
  "v2/remote/hosts/$hostId/discord-route.ts",
  "v2/remote/hosts/$hostId/live-activity.ts",
  "v2/remote/sessions/$sessionId/end.ts",
  "v2/hosting/servers/$serverId/activity.ts",
  "v1/auth/logout.ts",
];
const source = (file: string) => readFileSync(new URL(`../src/routes/${file}`, import.meta.url), "utf8");

describe("routes a server's durable sign-in must not reach", () => {
  it.each(ROUTES)("%s refuses a server's sign-in", (file, marker) => {
    const text = source(file);
    expect(text).toContain(marker);
    // A route that asks for the interactive user must not also ask for the plain one for the same step.
    if (marker === "requestInteractiveUser") expect(text).not.toContain("yield* requestUser(");
  });
  it.each(HOST_ROUTES)("%s stays open to a server", (file) => {
    expect(source(file)).not.toContain("requestInteractiveUser");
  });
});
