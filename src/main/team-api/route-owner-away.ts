import {
  decodeOwnerAwaySettings,
  decodeOwnerHeldAnswer,
  OWNER_AWAY_CAPABILITY,
  OWNER_AWAY_ROUTES,
} from "@openbot/contracts/team-protocol/owner-away-v1";
import { sourceText } from "@openbot/i18n/source";
import { type OwnerAwayService, OwnerHeldMissing, OwnerHoldRefused } from "../../backend/owner-away";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(OWNER_AWAY_ROUTES));

/**
 * The owner's quiet hours, focus and held requests (`owner-away-v1.ts`, under `fork-host-v1`). Only
 * the owner and the admins: the held list is the owner's, and it names what agents wait for.
 */
export async function routeOwnerAway(
  context: TeamApiRequestContext,
  away: OwnerAwayService | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!away || !capabilities.has(OWNER_AWAY_CAPABILITY))
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  requireAdmin(member);
  // `readJson` has already run the body through the owner-away wire codec.
  const body = await readJson(request);
  try {
    if (url.pathname === OWNER_AWAY_ROUTES.state) return json(200, away.state());
    if (url.pathname === OWNER_AWAY_ROUTES.active) return json(200, away.noteActive());
    if (url.pathname === OWNER_AWAY_ROUTES.focus) {
      const until = body.until;
      return json(200, away.setFocus(typeof until === "number" ? until : null));
    }
    if (url.pathname === OWNER_AWAY_ROUTES.settings) {
      let settings: ReturnType<typeof decodeOwnerAwaySettings>;
      try {
        settings = decodeOwnerAwaySettings(body.settings, () => true);
      } catch {
        throw new HttpError(400, sourceText("error.team.requestFailed"));
      }
      return json(200, away.setSettings(settings));
    }
    const answer = decodeOwnerHeldAnswer(body);
    if (!answer) throw new HttpError(400, sourceText("error.team.requestFailed"));
    return json(200, away.answer(answer));
  } catch (error) {
    if (error instanceof OwnerHeldMissing) throw new HttpError(409, error.message);
    if (error instanceof OwnerHoldRefused) throw new HttpError(400, error.message);
    throw error;
  }
}
