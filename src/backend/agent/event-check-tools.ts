import { decodeEventCheckTemplateInstallInput } from "@openbot/contracts/event-check-templates";
import { decodeEventCheckInput } from "@openbot/contracts/event-checks";
import { type AgentSummary, workspaceAccessEnforced } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { z } from "zod";
import { refusalMessage } from "../event-check-refusal";
import type { EventCheckScheduler } from "../event-check-scheduler";
import { mcpSync } from "../mcp-effects";
import type { DynamicToolCallParams } from "../protocol";
import { routineScheduleZodSchema } from "../routine-tool-schema";
import { openBotToolFailure, openBotToolResult } from "./routine-tools";

const agentId = z.string().min(1).max(128).optional();
const id = z.string().min(1).max(128);
const source = z.object({
  kind: z.enum(["api", "mcp"]),
  variables: z.array(z.string().max(128)).max(20).optional(),
  configuration: z
    .array(
      z.object({
        name: z.string().max(128),
        label: z.string().max(256),
        description: z.string().max(2048),
        value: z.string().max(8192),
      }),
    )
    .max(30)
    .optional(),
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
    name: "event_check_environment",
    description:
      "List declared variable names and configured/missing status. Never returns values. Ask the user: Please add NAME to the .env in this watcher’s settings so we can test it.",
    shape: { agentId, id },
  },
  {
    name: "test_event_check",
    description:
      "Test a saved API check without enabling it, committing an observation, delivering events, or starting inference. An edited shared program resets the prior baseline. Result goes only to its own ten-entry history.",
    shape: { agentId, id },
  },
  {
    name: "list_event_checks",
    description:
      "List saved deterministic event checks. They run ordinary programs, not AI. Use this before creating or changing one. Omit agentId to target yourself.",
    shape: { agentId },
  },
  {
    name: "list_event_check_apps",
    description:
      "List legacy MCP app accounts allowed in the target chat. API watchers instead declare their own per-instance private variables and stable account label.",
    shape: { agentId },
  },
  {
    name: "list_event_check_tools",
    description:
      "List legacy read-only MCP tools for an existing MCP check. New API watchers use shared agent-authored programs, not these tools.",
    shape: { agentId, connectionId: id },
  },
  {
    name: "save_event_check",
    description:
      "Create or replace an event check. Use APIs, never MCP for new checks. Write a reusable program under OpenBot/Shared/Watchers and set source kind api, toolName to its relative .mjs/.js/.py/.sh path, connectionId to one stable account label, variables to the required private variable names, and configuration to ordinary named/labeled/described values shown in settings. Never provide secret values. Save paused before credentials exist. Ask the user to fill missing private variables in the watcher settings. Programs receive JSON arguments and configuration on stdin, only declared private values in their environment, and must emit one complete JSON value on stdout. No model/MCP calls. Use selection /items, /id, /revision and pagination cursor + /cursor, plus a boolean hasNextPage in output. Empty checks are silent. First success saves a baseline. New IDs or changed revisions wake the target with instruction and untrusted event data. Default and minimum interval is 30 seconds. Follow openbot-event-checks. Self-events are excluded by default: configure the connected account actor IDs and actual change-author path. Never substitute creator or assignee for change author. Include self-events only when the user explicitly asks, such as testing. Provide complete source and selection. JSON Pointer paths locate the result list and item ID/revision; blank revision compares the item. Configure pagination for complete results. Exact argument string values $lastSuccessAt and $now expand to timestamps. Do not put credentials in arguments. Inspect the actual tool result shape before saving.",
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
    name: "list_event_check_templates",
    description:
      "List the reviewed event check templates this host ships, such as Linear, GitHub, Slack, Gmail, Render or PostHog. Each has settings (configuration) with defaults and a required flag, the names of its private variables, a default interval and a default instruction. Use a template before you write a new program.",
    shape: {},
  },
  {
    name: "install_event_check_template",
    description:
      "Install a template as a PAUSED event check for an agent (omit agentId to target yourself). Pass the settings as a list of {name, value} pairs in `configuration`. Fill every required setting from what the user told you, and ask for what you do not know: never guess IDs. Use one accountLabel per account, and install again for another account. Private variables such as tokens and passwords belong to the user alone: never ask for the value in chat, and never put one in any field or file. After the install, call event_check_environment and tell the user which names to add in agent settings, Event checks, this check, Private variables (.env). Then call test_event_check. Enable it only when the user asks.",
    shape: {
      agentId,
      slug: z.string().min(1).max(64),
      accountLabel: z.string().min(1).max(128),
      name: z.string().max(256).optional(),
      instruction: z.string().max(16000).optional(),
      timezone: z.string().max(128).optional(),
      intervalSeconds: z.number().int().min(30).max(86_400).optional(),
      accountActorIds: z.array(z.string().min(1).max(512)).max(20).optional(),
      // A list, not a record: a record's schema cannot be converted when the Claude SDK and OpenBot load
      // separate copies of zod, and one tool that fails to convert removes every `openbot` tool.
      configuration: z
        .array(z.object({ name: z.string().min(1).max(128), value: z.string().max(8192) }))
        .max(30)
        .optional(),
    },
  },
  {
    name: "update_event_check_template",
    description:
      "Move a check that came from a template to the template's current version. It keeps the settings, schedule and instruction, and it gets a fresh baseline: the first read after the update stays quiet.",
    shape: { agentId, id },
  },
  {
    name: "link_event_check_template",
    description:
      "Link an existing check to a template when its program is exactly the template's program. The baseline stays. It fails when the program differs.",
    shape: { agentId, id, slug: z.string().min(1).max(64) },
  },
  {
    name: "set_event_check_active",
    description:
      "Enable or pause a saved check. Enable only when the user asked you to, after its private variables are set (event_check_environment) and test_event_check succeeded. The first enabled read saves a quiet baseline.",
    shape: { agentId, id, active: z.boolean() },
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
/** The tool takes the settings as a list of name and value pairs. The install input is a record. */
function configurationRecord(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!Array.isArray(value)) return result;
  for (const entry of value) {
    if (!isDynamicRecord(entry) || typeof entry.name !== "string" || typeof entry.value !== "string")
      throw new Error("Invalid configuration setting.");
    result[entry.name] = entry.value;
  }
  return result;
}
const NAMES = new Set<string>(EVENT_CHECK_TOOL_DEFINITIONS.map((definition) => definition.name));
// A program runs unconfined on the host and writes to the shared folder, so a Workspace-only agent
// may read about checks and may not create, change, test, run or enable them.
const WORKSPACE_REFUSED = new Set<string>([
  "save_event_check",
  "test_event_check",
  "run_event_check",
  "install_event_check_template",
  "update_event_check_template",
  "link_event_check_template",
  "set_event_check_active",
  "delete_event_check",
]);
export function handleEventCheckTool(
  params: DynamicToolCallParams,
  senderAgentId: string,
  checks: EventCheckScheduler,
  caller: () => AgentSummary,
) {
  if (!NAMES.has(params.tool)) return Effect.succeed(null);
  return Effect.gen(function* () {
    const sender = caller();
    const actor = { kind: "agent", agentId: senderAgentId, name: sender.name } as const;
    if (WORKSPACE_REFUSED.has(params.tool) && workspaceAccessEnforced(sender)) {
      yield* checks.refused(actor, params.tool, senderAgentId);
      return openBotToolFailure(sourceText("error.backend.eventCheckWorkspaceOnly"));
    }
    const args = yield* mcpSync(() => {
      if (!isDynamicRecord(params.arguments)) throw new Error("Invalid event check tool request.");
      return params.arguments;
    });
    const target = typeof args.agentId === "string" ? args.agentId : senderAgentId;
    const identifier = typeof args.id === "string" ? args.id : "";
    let result: unknown;
    switch (params.tool) {
      case "event_check_environment":
        result = yield* checks.environment({ agentId: target, id: identifier });
        break;
      case "test_event_check":
        result = yield* checks.test({ agentId: target, id: identifier });
        break;
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
        result = yield* checks.save(yield* mcpSync(() => decodeEventCheckInput({ ...args, agentId: target })), actor);
        break;
      case "list_event_check_templates":
        result = yield* checks.templateList();
        break;
      case "install_event_check_template": {
        const slug = typeof args.slug === "string" ? args.slug : "";
        const template = (yield* checks.templateList()).find((entry) => entry.slug === slug);
        if (!template) return openBotToolFailure(sourceText("error.backend.eventCheckTemplateUnknown"));
        const label = typeof args.accountLabel === "string" ? args.accountLabel : "";
        const name = typeof args.name === "string" && args.name.trim() ? args.name : `${template.name} — ${label}`;
        result = yield* checks.templateInstall(
          yield* mcpSync(() =>
            decodeEventCheckTemplateInstallInput({
              ...args,
              agentId: target,
              name,
              instruction: args.instruction ?? template.instruction,
              timezone: args.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
              intervalSeconds: args.intervalSeconds ?? template.intervalSeconds,
              accountActorIds: args.accountActorIds ?? [],
              configuration: configurationRecord(args.configuration),
            }),
          ),
          actor,
        );
        break;
      }
      case "update_event_check_template":
        result = yield* checks.templateUpdate({ agentId: target, id: identifier }, actor);
        break;
      case "link_event_check_template":
        result = yield* checks.templateAdopt(
          { agentId: target, id: identifier, slug: typeof args.slug === "string" ? args.slug : "" },
          actor,
        );
        break;
      case "set_event_check_active": {
        const check = (yield* checks.list({ agentId: target })).find((entry) => entry.id === identifier);
        if (!check || typeof args.active !== "boolean")
          return openBotToolFailure(sourceText("error.backend.eventCheckFailed"));
        result = yield* checks.save({ ...check, active: args.active }, actor);
        break;
      }
      case "delete_event_check":
        result = yield* checks.remove({ agentId: target, id: identifier }, actor);
        break;
      case "run_event_check":
        result = yield* checks.checkNow({ agentId: target, id: identifier });
        break;
      case "event_check_history":
        result = yield* checks.history({ agentId: target, id: identifier });
        break;
    }
    return openBotToolResult(result ?? { removed: true });
  }).pipe(
    // A refusal says what to change. Any other failure stays generic: its cause can hold private detail.
    Effect.catch((failure) => {
      const message = refusalMessage(failure);
      return Effect.succeed(openBotToolFailure(message ?? sourceText("error.backend.eventCheckFailed")));
    }),
    Effect.catchCause(() => Effect.succeed(openBotToolFailure(sourceText("error.backend.eventCheckFailed")))),
  );
}
