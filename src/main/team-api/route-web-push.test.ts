import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { WEB_PUSH_CAPABILITY, WEB_PUSH_ROUTES } from "@openbot/contracts/team-protocol/web-push-v1";
import { describe, expect, it, vi } from "vitest";
import { WebPushRefusal } from "../web-push";
import { HttpError } from "./http-error";
import type { TeamApiRequestContext } from "./request-context";
import { routeWebPush } from "./route-web-push";

const member: TeamMemberSummary = {
  id: "member-1",
  username: "member",
  email: "member@example.com",
  name: "Member",
  role: "member",
  disabled: false,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const registration = {
  endpoint: "https://fcm.googleapis.com/fcm/send/token",
  p256dh: "B".repeat(87),
  auth: "A".repeat(22),
  level: "all",
  mutedUntil: null,
  locale: "en",
};

function context(path: string, body: unknown, capabilities: string[] = [WEB_PUSH_CAPABILITY]) {
  const responses: Array<{ status: number; value: unknown }> = [];
  const request = new IncomingMessage(new Socket());
  request.method = "POST";
  request.url = path;
  request.push(Buffer.from(JSON.stringify(body)));
  request.push(null);
  const value: TeamApiRequestContext = {
    request,
    response: new ServerResponse(request),
    method: "POST",
    url: new URL(path, "http://openbot.invalid"),
    protocol: 3,
    capabilities: new Set(capabilities),
    member,
    token: "token",
    sessionId: "session",
    sessionExpiresAt: "2099-01-01T00:00:00.000Z",
    json: (status, answer) => {
      responses.push({ status, value: answer });
      return "handled";
    },
    empty: () => "handled",
  };
  return { value, responses };
}

describe("web push route", () => {
  const push = () => ({ publicKey: vi.fn(() => "public-key"), register: vi.fn(), remove: vi.fn() });

  it("gives the public key, stores the subscription of the calling member, and removes it", async () => {
    const service = push();
    const key = context(WEB_PUSH_ROUTES.key, {});
    await expect(routeWebPush(key.value, service)).resolves.toBe("handled");
    expect(key.responses).toEqual([{ status: 200, value: { publicKey: "public-key" } }]);

    await routeWebPush(context(WEB_PUSH_ROUTES.register, registration).value, service);
    expect(service.register).toHaveBeenCalledWith("member-1", 3, registration);

    await routeWebPush(context(WEB_PUSH_ROUTES.remove, { endpoint: registration.endpoint }).value, service);
    expect(service.remove).toHaveBeenCalledWith("member-1", registration.endpoint);
  });

  it("refuses a host without the capability, a malformed subscription, and an address that is not a push service", async () => {
    const service = push();
    await expect(
      routeWebPush(context(WEB_PUSH_ROUTES.register, registration, []).value, service),
    ).rejects.toBeInstanceOf(HttpError);
    await expect(routeWebPush(context(WEB_PUSH_ROUTES.register, registration).value, undefined)).rejects.toBeInstanceOf(
      HttpError,
    );
    await expect(
      routeWebPush(context(WEB_PUSH_ROUTES.register, { ...registration, auth: "short" }).value, service),
    ).rejects.toThrow();
    service.register.mockImplementation(() => {
      throw new WebPushRefusal("endpoint");
    });
    await expect(routeWebPush(context(WEB_PUSH_ROUTES.register, registration).value, service)).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it("leaves other paths and methods to the next route", async () => {
    expect(await routeWebPush(context("/v1/agents", {}).value, push())).toBe("unmatched");
  });
});
