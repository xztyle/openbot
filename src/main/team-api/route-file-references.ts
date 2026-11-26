import {
  FILE_REFERENCES_CAPABILITY,
  FILE_REFERENCES_ROUTES,
} from "@openbot/contracts/team-protocol/file-references-v1";
import { sourceText } from "@openbot/i18n/source";
import { runCauseEffect } from "../../backend/effect-boundary";
import { FileReferenceRefused } from "../../backend/file-references";
import type { TeamApiAgents } from "./dependencies";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, stringField } from "./request-helpers";

/**
 * A file or folder that a message names, for a member who opens its chip (`file-references-v1`). The
 * member opens only what the agents they see can reach: those agents' workspaces and the shared folders
 * of their spaces. Everything else answers as missing, so a member cannot test which host paths exist.
 */
export async function routeFileReferences(
  context: TeamApiRequestContext,
  agents: Pick<TeamApiAgents, "openFileReference">,
  hiddenAgentIds: ReadonlySet<string>,
): Promise<RouteOutcome> {
  const { method, url, capabilities, request, json } = context;
  if (method !== "POST" || url.pathname !== FILE_REFERENCES_ROUTES.open) return "unmatched";
  if (!capabilities.has(FILE_REFERENCES_CAPABILITY))
    throw new HttpError(404, sourceText("error.backend.fileReferenceUnavailable"));
  // `readJson` has already run the body through the file-references wire codec.
  const body = await readJson(request);
  const agentId = body.agentId === null ? null : stringField(body, "agentId");
  const path = stringField(body, "path", false, 4_096);
  const canSee = (id: string) => !hiddenAgentIds.has(id) && context.agentLevel(id) !== "none";
  try {
    return json(200, await runCauseEffect(agents.openFileReference({ agentId, path }, canSee)));
  } catch (error) {
    if (error instanceof FileReferenceRefused)
      throw new HttpError(error.reason === "too-large" ? 413 : 404, error.message);
    throw error;
  }
}
