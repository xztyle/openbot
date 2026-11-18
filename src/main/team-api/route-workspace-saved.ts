import {
  parseWorkspacePinsInput,
  parseWorkspaceSavedInput,
  parseWorkspaceSetPinnedInput,
  parseWorkspaceSetSavedInput,
} from "@openbot/contracts/ipc";
import {
  WORKSPACE_SAVED_CAPABILITY,
  WORKSPACE_SAVED_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-saved-v1";
import { sourceText } from "@openbot/i18n/source";
import type { ChannelService } from "../../backend/channel-service";
import { runCauseEffect } from "../../backend/effect-boundary";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson } from "./request-helpers";
import { requestChannelViewer } from "./route-workspace";
import { found, rethrowNotFound } from "./route-workspace-read-state";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid workspace request.");
  }
}

/** A refusal that the person can act on, such as a full pin list or an archived channel. */
const REFUSALS = ["error.backend.channelPinLimit", "error.backend.channelArchived"] as const;

async function refused<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (REFUSALS.some((key) => message === sourceText(key))) throw new HttpError(409, message);
    return rethrowNotFound(error);
  }
}

/**
 * The saved items and pins routes of this fork (`workspace-saved-v1.ts`, under `fork-host-v1`). The
 * member reads and changes only their own saved items, and the pins of channels they can see; the id
 * comes from the session, never the body.
 */
export async function routeWorkspaceSaved(
  context: TeamApiRequestContext,
  channels: ChannelService | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_SAVED_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_SAVED_CAPABILITY))
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  if (!channels) throw new HttpError(400, sourceText("error.team.channelsUnsupported"));
  const viewer = requestChannelViewer(context);
  const actor = { id: member.id };
  // `readJson` has already run the body through the saved items wire codec.
  const body = await readJson(request);
  switch (url.pathname) {
    case WORKSPACE_SAVED_ROUTES.saved: {
      const input = parsed(parseWorkspaceSavedInput, body);
      return json(
        200,
        found(() => channels.savedItems(input, actor, viewer)),
      );
    }
    case WORKSPACE_SAVED_ROUTES.setSaved: {
      const input = parsed(parseWorkspaceSetSavedInput, body);
      return json(
        200,
        found(() => channels.setSaved(input, actor, viewer)),
      );
    }
    case WORKSPACE_SAVED_ROUTES.pins: {
      const input = parsed(parseWorkspacePinsInput, body);
      return json(
        200,
        found(() => channels.pins(input.channelId, viewer)),
      );
    }
    default: {
      const input = parsed(parseWorkspaceSetPinnedInput, body);
      return json(200, await refused(() => runCauseEffect(channels.setPinned(input, actor, viewer))));
    }
  }
}
