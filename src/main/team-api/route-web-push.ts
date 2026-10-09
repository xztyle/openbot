import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import {
  WEB_PUSH_CAPABILITY,
  WEB_PUSH_ROUTES,
  type WebPushRegistration,
} from "@openbot/contracts/team-protocol/web-push-v1";
import { sourceText } from "@openbot/i18n/source";
import type { WebPushService } from "../web-push";
import { WebPushRefusal } from "../web-push";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";

/**
 * The browser of the calling member asks for the host's public key, gives its push subscription, or
 * takes it back. The host keeps the subscription in its profile and sends the member's push messages
 * to it. Frozen by `web-push-v1`.
 */
export async function routeWebPush(
  context: TeamApiRequestContext,
  push: Pick<WebPushService, "publicKey" | "register" | "remove"> | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member, protocol } = context;
  const route = Object.values(WEB_PUSH_ROUTES).find((path) => path === url.pathname);
  if (method !== "POST" || !route) return "unmatched";
  if (!push || !capabilities.has(WEB_PUSH_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.webPushUnsupported"));
  // `readJson` has already run the body through the web-push wire codec.
  const body = await readJson(request);
  if (route === WEB_PUSH_ROUTES.key) return json(200, { publicKey: push.publicKey() });
  const endpoint = body.endpoint;
  if (typeof endpoint !== "string") throw new HttpError(400, sourceText("error.team.webPushEndpointRefused"));
  if (route === WEB_PUSH_ROUTES.remove) {
    push.remove(member.id, endpoint);
    return json(200, {});
  }
  try {
    push.register(member.id, protocol, registration(body));
  } catch (error) {
    if (error instanceof WebPushRefusal)
      throw new HttpError(
        400,
        sourceText(error.reason === "endpoint" ? "error.team.webPushEndpointRefused" : "error.team.webPushLimit"),
      );
    throw error;
  }
  return json(200, {});
}

function registration(body: DynamicRecord): WebPushRegistration {
  const text = (field: string) => {
    const value = body[field];
    if (typeof value !== "string") throw new HttpError(400, `${field} is required.`);
    return value;
  };
  const level = text("level");
  if (level !== "all" && level !== "needs-me" && level !== "nothing") throw new HttpError(400, "level is not valid.");
  const mutedUntil = body.mutedUntil;
  return {
    endpoint: text("endpoint"),
    p256dh: text("p256dh"),
    auth: text("auth"),
    level,
    mutedUntil: typeof mutedUntil === "number" ? mutedUntil : null,
    locale: text("locale"),
  };
}
