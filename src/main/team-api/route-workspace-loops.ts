import { parseWorkspaceLoopAction, parseWorkspaceLoopsInput } from "@openbot/contracts/ipc";
import {
  WORKSPACE_LOOPS_CAPABILITY,
  WORKSPACE_LOOPS_ROUTES,
} from "@openbot/contracts/team-protocol/workspace-loops-v1";
import { sourceText } from "@openbot/i18n/source";
import { LoopRejected, type LoopService } from "../../backend/loops/loop-service";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";

function parsed<T>(parse: (value: unknown) => T, value: unknown): T {
  try {
    return parse(value);
  } catch {
    throw new HttpError(400, "Invalid loop request.");
  }
}

/**
 * The loops routes of this fork (`workspace-loops-v1.ts`, under `fork-host-v1`). Every member reads the
 * loops of a space. Only an owner or an admin changes them or decides a gate: a gate guards money and
 * publishing, so it is the owner's.
 */
export async function routeWorkspaceLoops(
  context: TeamApiRequestContext,
  loops: Pick<LoopService, "board" | "apply"> | undefined,
): Promise<RouteOutcome> {
  const { method, url, capabilities, member, request, json } = context;
  if (method !== "POST" || !Object.values(WORKSPACE_LOOPS_ROUTES).some((route) => route === url.pathname))
    return "unmatched";
  if (!capabilities.has(WORKSPACE_LOOPS_CAPABILITY) || !loops)
    throw new HttpError(400, sourceText("error.team.workspaceUnsupported"));
  // `readJson` has already run the body through the workspace-loops wire codec.
  const body = await readJson(request);
  if (url.pathname === WORKSPACE_LOOPS_ROUTES.board) {
    const input = parsed(parseWorkspaceLoopsInput, body);
    return json(200, loops.board(input.spaceId, input));
  }
  requireAdmin(member);
  const action = parsed(parseWorkspaceLoopAction, body);
  try {
    return json(200, loops.apply(action, { kind: "person", id: member.id }));
  } catch (error) {
    if (error instanceof LoopRejected) throw new HttpError(409, error.message);
    throw error;
  }
}
