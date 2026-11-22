import type { AgentSummary } from "@openbot/contracts/ipc";
import { type DynamicRecord, isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { z } from "zod";
import { BROWSER_DYNAMIC_TOOLS, OPENBOT_BROWSER_NAMESPACE } from "../browser-tools";
import { OPENBOT_DYNAMIC_TOOLS, OPENBOT_TOOL_DEFINITIONS } from "../openbot-tools";
import type { DynamicToolCallParams } from "../protocol";
import { advertisedJsonSchema } from "./advertised-json-schema";
import { toolGuidance } from "./tool-guidance";

/** Discovery changes visibility only. Original definitions and execution owners stay authoritative. */
export const BUILTIN_TOOL_CATALOG = [OPENBOT_DYNAMIC_TOOLS, ...BROWSER_DYNAMIC_TOOLS].flatMap((namespace) =>
  namespace.tools.map((tool) => ({
    namespace: namespace.name,
    tool: tool.name,
    name: `${namespace.name}.${tool.name}`,
    description: tool.description,
    inputSchema: tool.inputSchema,
  })),
);

const DIRECT_NAMES = new Set([
  "ask_user",
  "attach_files_to_response",
  "list_agents",
  "send_message",
  "search_memories",
  "routine_no_update",
  "routine_report_failure",
  "remember",
  "forget_memory",
  "react_to_user_message",
  "request_api_key",
]);

/**
 * The names of all catalog tools, grouped by namespace, such as `openbot.{list_tables, query_data}`. Names
 * give a complete, stable list without schemas; the group form keeps each name qualified and does not
 * repeat the namespace for each tool.
 */
const INITIAL_TOOL_CATALOG = [OPENBOT_DYNAMIC_TOOLS, ...BROWSER_DYNAMIC_TOOLS]
  .map((namespace) => `${namespace.name}.{${namespace.tools.map((tool) => tool.name).join(", ")}}`)
  .join("; ");
const qualifiedName = z.string().trim().min(1).max(160);
const searchQuery = z.string().trim().min(1).max(200);
// Models often send one query string, so search accepts `query` as well as `queries`.
const searchShape = {
  queries: z.array(searchQuery).min(1).max(10).optional(),
  query: searchQuery.optional(),
  limit: z.number().int().min(1).max(10).optional(),
};
// Models often send one name as `name`, or `names` as one string or a JSON-encoded array, so describe
// accepts each of them. Claude's MCP layer checks the shape before Atelier sees the call.
const describeShape = {
  names: z
    .union([z.array(qualifiedName).min(1).max(10), qualifiedName.max(2_000)])
    .describe('Qualified tool names, such as ["openbot.create_agent", "openbot_browser.open"].')
    .optional(),
  name: qualifiedName.describe("One qualified tool name, instead of names.").optional(),
};
// Claude's bundled schema converter does not support the current Zod record processor, and Muse
// rejects recursive schemas. Arguments arrive as JSON, and the target tool validates them. A model
// sometimes sends them as a JSON-encoded string, which the call decodes.
const callShape = {
  name: qualifiedName.describe('The qualified tool name, such as "openbot.create_agent".'),
  arguments: z
    .union([z.object({}).catchall(z.unknown()), z.string().max(1_000_000)])
    .describe('The tool\'s arguments as a JSON object, such as {"tabId":"…"}. Omit for a tool without arguments.')
    .optional(),
};
const searchSchema = z
  .strictObject(searchShape)
  .refine((input) => input.queries !== undefined || input.query !== undefined);
const describeSchema = z.strictObject(describeShape);
const callSchema = z.strictObject(callShape);
const DISCOVERY_TOOLS = new Set(["tool_search", "tool_describe"]);

export const VISIBLE_TOOL_DEFINITIONS = [
  ...OPENBOT_TOOL_DEFINITIONS.filter((tool) => DIRECT_NAMES.has(tool.name)),
  {
    name: "tool_search",
    description: `Find built-in tools by keywords or qualified name. Pass queries (an array) or query (one string). Returns names and short descriptions, default 5, maximum 10. The strongest matches also include inputSchema and guidance, ready for tool_call. Describe other results before first use. Catalog: ${INITIAL_TOOL_CATALOG}`,
    shape: searchShape,
  },
  {
    name: "tool_describe",
    description:
      'Load exact input schemas and operating guidance for up to ten qualified built-in tool names, such as {"names":["openbot.create_agent","openbot_browser.open"]}.',
    shape: describeShape,
  },
  {
    name: "tool_call",
    description:
      'Call one original built-in tool by its qualified name and JSON arguments, such as {"name":"openbot_browser.list_tabs","arguments":{}}. Uses normal permissions and approvals.',
    shape: callShape,
  },
];

export const VISIBLE_DYNAMIC_TOOLS = [
  {
    type: "namespace" as const,
    name: "openbot",
    description:
      "openbot tools. Search, then call other built-in and browser capabilities. Describe a result that has no inputSchema.",
    tools: VISIBLE_TOOL_DEFINITIONS.map((definition) => ({
      type: "function" as const,
      name: definition.name,
      description: definition.description,
      inputSchema: advertisedJsonSchema(z.strictObject(definition.shape)),
    })),
  },
];

/**
 * Claude names a bridge call `mcp__openbot__tool_call`. Readers of its items get the name of the tool it
 * calls, in the form Claude gives a direct tool. A name outside the catalog is model text and stays out.
 */
export function claudeBridgedToolName(name: string, input: unknown): string {
  if (name !== "mcp__openbot__tool_call" || typeof input !== "object" || input === null || !("name" in input))
    return name;
  const entry = isString(input.name) ? findTool(input.name) : undefined;
  return entry ? `mcp__${entry.namespace}__${entry.tool}` : name;
}

/**
 * Search matches whole words, so a query that names a web service, such as "gmail" or "read mail",
 * finds no browser tool. Without this note the agent reports that it has no tool for that service.
 */
const BROWSER_SEARCH_NOTE =
  "No browser tool is in these results. A website or web app with no dedicated tool, such as mail or a calendar, is reached through openbot_browser. Call openbot_browser.list_tabs first: your signed-in tabs stay open across sessions.";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Each step to describe a tool sends the full context again, so search includes the schemas of its best matches. */
const READY_SEARCH_RESULTS = 3;

/** A tool-call failure whose message tells the calling agent how to correct its call. */
export class ToolDiscoveryError extends Error {}

type CatalogEntry = (typeof BUILTIN_TOOL_CATALOG)[number];

const NAMESPACES = [...new Set(BUILTIN_TOOL_CATALOG.map((entry) => entry.namespace))];

/**
 * Finds a catalog tool by its qualified name, or by a form models also write: a bare tool name that only
 * one namespace has, such as `create_agent`, or Claude's `mcp__openbot__create_agent`.
 */
export function findTool(name: string): CatalogEntry | undefined {
  const exact = BUILTIN_TOOL_CATALOG.find((entry) => entry.name === name);
  if (exact) return exact;
  const claude = /^mcp__([a-z0-9_]+?)__([a-z0-9_]+)$/i.exec(name);
  if (claude) return BUILTIN_TOOL_CATALOG.find((entry) => entry.namespace === claude[1] && entry.tool === claude[2]);
  const bare = BUILTIN_TOOL_CATALOG.filter((entry) => entry.tool === name);
  return bare.length === 1 ? bare[0] : undefined;
}

/** A name is model text: only a plain tool-name shape goes back into the error. */
function shownName(name: string): string {
  return /^[\w.-]{1,80}$/.test(name) ? `"${name}"` : "That name";
}

/** The catalog tools that share the most words with an unknown name, such as `open` for `open_tab`. */
function similarTools(name: string): string[] {
  const asked = new Set(words(name).filter((word) => !NAMESPACES.includes(word)));
  return BUILTIN_TOOL_CATALOG.map((entry) => ({
    entry,
    score: words(entry.tool).filter((word) => asked.has(word)).length,
  }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map(({ entry }) => entry.name);
}

function unknownToolError(name: string): ToolDiscoveryError {
  const similar = similarTools(name);
  return new ToolDiscoveryError(
    `${shownName(name)} is not a built-in tool. ${
      similar.length > 0 ? `Similar tools: ${similar.join(", ")}. ` : ""
    }Use a qualified name from tool_search, such as "openbot.send_message" or "openbot_browser.open".`,
  );
}

function requireTool(name: string): CatalogEntry {
  const tool = findTool(name);
  if (!tool) throw unknownToolError(name);
  return tool;
}

/** `names` as an array, one string, a JSON-encoded array, or names separated by commas or spaces. */
function describeNames(input: { names?: string | string[] | undefined; name?: string | undefined }): string[] {
  const listed =
    input.names === undefined ? [] : typeof input.names === "string" ? splitNames(input.names) : input.names;
  const names = [...listed, ...(input.name === undefined ? [] : [input.name])]
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0)
    throw new ToolDiscoveryError(
      'tool_describe needs names, an array of qualified tool names, such as {"names":["openbot.create_agent"]}.',
    );
  if (names.length > 10) throw new ToolDiscoveryError("tool_describe takes at most ten names. Split the request.");
  return names;
}

const nameList = z.array(z.string());

function splitNames(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = nameList.safeParse(JSON.parse(trimmed));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: read it as a list of names.
    }
  }
  return trimmed.split(/[\s,]+/);
}

/** Decodes arguments that a model sent as a JSON-encoded object. */
function callArguments(value: string | DynamicRecord | undefined): DynamicRecord {
  if (value === undefined) return {};
  if (!isString(value)) return value;
  const text = value.trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    if (isDynamicRecord(parsed)) return parsed;
  } catch {
    // Reported below.
  }
  throw new ToolDiscoveryError(
    'tool_call arguments must be a JSON object, such as {"name":"openbot_browser.list_tabs","arguments":{}}.',
  );
}

export type DeferredTool =
  | { kind: "call"; params: DynamicToolCallParams }
  | { kind: "discovery"; params: DynamicToolCallParams }
  | { kind: "invalid"; message: string };

/**
 * Resolves a tool_call envelope. A call of tool_search or tool_describe through tool_call runs it, and an
 * invalid envelope gets a message that says how to correct it. No argument values are echoed into errors.
 */
export function resolveDeferredTool(params: DynamicToolCallParams): DeferredTool {
  const parsed = callSchema.safeParse(params.arguments);
  if (!parsed.success)
    return {
      kind: "invalid",
      message:
        'tool_call needs name, a qualified tool name, and arguments, a JSON object, such as {"name":"openbot_browser.list_tabs","arguments":{}}.',
    };
  try {
    const args = callArguments(parsed.data.arguments);
    const bare = parsed.data.name.replace(/^openbot\./, "");
    if (DISCOVERY_TOOLS.has(bare)) return { kind: "discovery", params: { ...params, tool: bare, arguments: args } };
    const entry = requireTool(parsed.data.name);
    return { kind: "call", params: { ...params, namespace: entry.namespace, tool: entry.tool, arguments: args } };
  } catch (error) {
    return { kind: "invalid", message: error instanceof ToolDiscoveryError ? error.message : String(error) };
  }
}

function toolGuidanceFor(entries: readonly (typeof BUILTIN_TOOL_CATALOG)[number][], agent: AgentSummary): string[] {
  return [...new Set(entries.map((entry) => toolGuidance(entry.namespace, entry.tool, agent)))].filter(Boolean);
}

export function discoverTools(params: DynamicToolCallParams, agent: AgentSummary) {
  if (params.tool === "tool_search") {
    const parsed = searchSchema.safeParse(params.arguments);
    if (!parsed.success)
      throw new ToolDiscoveryError(
        'tool_search needs queries, an array of keywords, or query, one string, such as {"query":"send email"}.',
      );
    const queries = [...(parsed.data.queries ?? []), ...(parsed.data.query ? [parsed.data.query] : [])].map((query) =>
      query.toLowerCase(),
    );
    const terms = new Set(queries.flatMap(words));
    const matches = BUILTIN_TOOL_CATALOG.map((entry, index) => {
      const nameWords = new Set(words(entry.name));
      const descriptionWords = new Set(words(entry.description));
      const exact = queries.some((query) => query === entry.name || query === entry.tool);
      // A strong result matches each word of its tool name. Namespace words, such as "browser", match a whole
      // namespace, and one shared verb, such as "read", matches many unrelated tools.
      const strong = exact || words(entry.tool).every((word) => terms.has(word));
      const score = [...terms].reduce(
        (sum, term) => sum + (nameWords.has(term) ? 3 : descriptionWords.has(term) ? 1 : 0),
        0,
      );
      return { entry, index, exact, strong, score };
    })
      .filter((result) => result.exact || result.score > 0)
      .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || a.index - b.index);
    const found = matches.slice(0, parsed.data.limit ?? 5);
    const ready = new Set(
      found
        .filter((result) => result.strong)
        .slice(0, READY_SEARCH_RESULTS)
        .map(({ entry }) => entry),
    );
    const tools = found.map(({ entry }) =>
      ready.has(entry)
        ? { name: entry.name, description: entry.description, inputSchema: entry.inputSchema }
        : { name: entry.name, description: entry.description.slice(0, 180) },
    );
    const guidance = toolGuidanceFor([...ready], agent);
    const result = guidance.length > 0 ? { tools, guidance } : { tools };
    return found.some(({ entry }) => entry.namespace === OPENBOT_BROWSER_NAMESPACE)
      ? result
      : { ...result, note: BROWSER_SEARCH_NOTE };
  }
  const parsed = describeSchema.safeParse(params.arguments);
  if (!parsed.success)
    throw new ToolDiscoveryError(
      'tool_describe needs names, up to ten qualified tool names, such as {"names":["openbot.create_agent"]}.',
    );
  const entries = [...new Set(describeNames(parsed.data).map(requireTool))];
  return {
    tools: entries.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    guidance: toolGuidanceFor(entries, agent),
  };
}
