import { decodeEventCheckInput } from "@openbot/contracts/event-checks";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import type { EventCheckScheduler } from "../event-check-scheduler";
import { mcpSync } from "../mcp-effects";
import type { DynamicToolCallParams } from "../protocol";
import { routineScheduleZodSchema } from "../routine-tool-schema";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

const agentId = z.string().min(1).max(128).optional();
const id = z.string().min(1).max(128);
const source = z.object({
  kind: z.literal("mcp"),
  connectionId: id,
  toolName: z.string().min(1).max(256),
  argumentsJson: z.string().min(1).max(16000),
  cursorArgument: z.string().max(128),
  nextCursorPointer: z.string().max(512),
});
const selection = z.object({
  itemsPointer: z.string().max(512),
  idPointer: z.string().max(512),
  revisionPointer: z.string().max(512),
});
export const EVENT_CHECK_TOOL_DEFINITIONS = [
  {
    name: "list_event_checks",
    description:
      "List saved deterministic event checks. They run ordinary programs, not AI. Use this before creating or changing one. Omit agentId to target yourself.",
    shape: { agentId },
  },
  {
    name: "list_event_check_apps",
    description:
      "List app accounts already allowed in the target chat. A check cannot add permissions or use other accounts.",
    shape: { agentId },
  },
  {
    name: "list_event_check_tools",
    description:
      "List read-only MCP tools and their schemas for exactly one allowed app account. Use these schemas to build a deterministic query.",
    shape: { agentId, connectionId: id },
  },
  {
    name: "save_event_check",
    description:
      "Create or replace an event check. Use a read-only MCP query, never a provider or AI tool. Empty checks are silent. First success saves a baseline. New IDs or changed revisions wake the target with instruction and untrusted event data. Default and minimum interval is 30 seconds. Follow openbot-event-checks. Self-events are excluded by default: configure the connected account actor IDs and actual change-author path. Never substitute creator or assignee for change author. Include self-events only when the user explicitly asks, such as testing. Provide complete source and selection. JSON Pointer paths locate the result list and item ID/revision; blank revision compares the item. Configure pagination for complete results. Exact argument string values $lastSuccessAt and $now expand to timestamps. Do not put credentials in arguments. Inspect the actual tool result shape before saving.",
    shape: {
      agentId,
      id: id.optional(),
      name: z.string().min(1).max(256),
      instruction: z.string().min(1).max(16000),
      active: z.boolean(),
      timezone: z.string().min(1).max(128),
      schedule: z
        .union([
          routineScheduleZodSchema,
          z
            .object({
              kind: z.literal("interval"),
              amount: z.number().int().min(30).max(8_640_000_000),
              unit: z.literal("seconds"),
              anchorAt: z.string(),
            })
            .strict(),
        ])
        .optional(),
      selfEvents: z
        .object({
          mode: z.enum(["exclude", "include"]),
          connectionId: id.optional(),
          actorPointer: z.string().max(512),
          accountActorIds: z.array(z.string().min(1).max(512)).max(20),
        })
        .optional(),
      source,
      selection,
    },
  },
  {
    name: "delete_event_check",
    description: "Remove a saved check and its pending events/logs.",
    shape: { agentId, id },
  },
  {
    name: "run_event_check",
    description:
      "Run the saved check now. This reads the app without inference; a real matching event may wake the agent. Unsaved edits are not used.",
    shape: { agentId, id },
  },
  {
    name: "event_check_history",
    description: "Read the last ten program executions, including errors, without adding empty checks to chat.",
    shape: { agentId, id },
  },
] as const;
const NAMES = new Set<string>(EVENT_CHECK_TOOL_DEFINITIONS.map((definition) => definition.name));
export function handleEventCheckTool(
  params: DynamicToolCallParams,
  senderAgentId: string,
  checks: EventCheckScheduler,
) {
  if (!NAMES.has(params.tool)) return Effect.succeed(null);
  return Effect.gen(function* () {
    const args = yield* mcpSync(() => {
      if (!isDynamicRecord(params.arguments)) throw new Error("Invalid event check tool request.");
      return params.arguments;
    });
    const target = typeof args.agentId === "string" ? args.agentId : senderAgentId;
    const identifier = typeof args.id === "string" ? args.id : "";
    let result: unknown;
    switch (params.tool) {
      case "list_event_checks":
        result = yield* checks.list({ agentId: target });
        break;
      case "list_event_check_apps":
        result = yield* checks.accounts({ agentId: target });
        break;
      case "list_event_check_tools":
        result = yield* checks.tools({
          agentId: target,
          connectionId: typeof args.connectionId === "string" ? args.connectionId : "",
        });
        break;
      case "save_event_check":
        result = yield* checks.save(yield* mcpSync(() => decodeEventCheckInput({ ...args, agentId: target })));
        break;
      case "delete_event_check":
        result = yield* checks.remove({ agentId: target, id: identifier });
        break;
      case "run_event_check":
        result = yield* checks.checkNow({ agentId: target, id: identifier });
        break;
      case "event_check_history":
        result = yield* checks.history({ agentId: target, id: identifier });
        break;
    }
    return openBotToolResult(result ?? { removed: true });
  }).pipe(Effect.catchCause(() => Effect.succeed(openBotToolFailure(sourceText("error.backend.eventCheckFailed")))));
}
