import { isOneOf, isString } from "@openbot/contracts/runtime-values";
import {
  AGENT_MAILBOX_MODES,
  AGENT_MAILBOXES_CAPABILITY,
  AGENT_MAILBOXES_ROUTES,
} from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { sourceText } from "@openbot/i18n/source";
import { type AgentMail, AgentMailboxRejected } from "../agent-mail/agent-mail";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

const ROUTES: ReadonlySet<string> = new Set(Object.values(AGENT_MAILBOXES_ROUTES));

/**
 * The agent mailboxes and the link to the mail Worker (`agent-mailboxes-v1.ts`, under
 * `fork-host-v1`). Only the owner and the admins: an address speaks for the business.
 */
export async function routeAgentMailboxes(
  context: TeamApiRequestContext,
  mail: AgentMail | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json, member } = context;
  if (method !== "POST" || !ROUTES.has(url.pathname)) return "unmatched";
  if (!mail || !capabilities.has(AGENT_MAILBOXES_CAPABILITY))
    throw new HttpError(404, sourceText("error.team.routeNotFound"));
  requireAdmin(member);
  // `readJson` has already run the body through the agent-mailboxes wire codec.
  const body = await readJson(request);
  try {
    switch (url.pathname) {
      case AGENT_MAILBOXES_ROUTES.state:
        return json(200, mail.state());
      case AGENT_MAILBOXES_ROUTES.save: {
        const { id, address, agentId, mode, displayName } = body;
        if (!isString(address) || !isString(agentId) || !isOneOf(AGENT_MAILBOX_MODES, mode))
          throw new HttpError(400, sourceText("error.team.requestFailed"));
        return json(
          200,
          await mail.saveMailbox({
            address,
            agentId,
            mode,
            ...(isString(id) ? { id } : {}),
            ...(isString(displayName) ? { displayName } : {}),
          }),
        );
      }
      case AGENT_MAILBOXES_ROUTES.remove:
        if (!isString(body.id)) throw new HttpError(400, sourceText("error.team.requestFailed"));
        return json(200, await mail.removeMailbox(body.id));
      case AGENT_MAILBOXES_ROUTES.worker:
        if (!isString(body.workerUrl)) throw new HttpError(400, sourceText("error.team.requestFailed"));
        return json(200, await mail.setWorker(body.workerUrl));
      default:
        return json(200, await mail.newSecret());
    }
  } catch (error) {
    if (error instanceof AgentMailboxRejected) throw new HttpError(409, error.message);
    throw error;
  }
}
