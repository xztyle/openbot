import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import {
  decodeMcpChatPolicy,
  decodeMcpChatTarget,
  MCP_CHAT_CAPABILITY,
  MCP_CHAT_CODECS,
  MCP_CHAT_ROUTES,
} from "@openbot/contracts/team-protocol/mcp-chat-v1";
import { runCauseEffect } from "../../backend/effect-boundary";
import type { ChatMcpService } from "../chat-mcp-service";
import { HttpError } from "./http-error";
import type { RouteOutcome, TeamApiRequestContext } from "./request-context";
import { readJson, requireAdmin } from "./request-helpers";
export async function routeMcpChat(context: TeamApiRequestContext, apps?: ChatMcpService): Promise<RouteOutcome> {
  const codec = MCP_CHAT_CODECS.get(context.url.pathname);
  if (context.method !== "POST" || !codec) return "unmatched";
  if (!apps || !context.capabilities.has(MCP_CHAT_CAPABILITY))
    throw new HttpError(400, "Chat app permissions are unsupported.");
  requireAdmin(context.member);
  const body = codec.request(await readJson(context.request));
  if (!isDynamicRecord(body)) throw new HttpError(400, "Invalid chat app request.");
  const target = decodeMcpChatTarget(body.target);
  const snapshot =
    context.url.pathname === MCP_CHAT_ROUTES.get
      ? apps.snapshot(target)
      : await runCauseEffect(apps.save(target, decodeMcpChatPolicy(body)));
  return context.json(200, snapshot);
}
