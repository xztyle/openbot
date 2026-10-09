import { agentProviderName, COMPUTER_USE_MCP_SERVER_NAME } from "@openbot/contracts/ipc";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { sourceText } from "@openbot/i18n/source";
import { redactText } from "@openbot/logging";
import { type AgentProvider, RequestTimeoutError } from "../agent-client";
import { AppServerError } from "../app-server-client";
import { type DynamicToolCallParams, getString, isRecord, reasoningText, type ThreadItem } from "../protocol";

export function isNonActionableCodexWarning(message: string): boolean {
  return message.startsWith("Skill descriptions were shortened to fit");
}

export function isArchivedThreadError(error: unknown): boolean {
  return error instanceof AppServerError && /\bis archived\b/i.test(error.message);
}

/**
 * The provider refused the session's own history. Grok keeps the `encrypted_content` of each
 * reasoning item in its session and sends it back on every request, and xAI accepts it only from
 * the caller it was issued to. After a sign-in to another account or a new API key, each turn of
 * that session fails the same way, so only a new session, given the OpenBot transcript, recovers.
 */
export function isForeignReasoningError(message: string): boolean {
  return /\bencrypted_content\b.*\bnot issued to this caller\b/i.test(message);
}

export function isMissingProviderSessionError(error: unknown, provider: AgentProvider): boolean {
  if (
    (provider !== "grok" &&
      provider !== "opencode" &&
      provider !== "antigravity" &&
      provider !== "cursor" &&
      provider !== "cline" &&
      provider !== "acp") ||
    !(error instanceof Error)
  ) {
    return false;
  }
  return (
    /\bunknown grok session\b/i.test(error.message) ||
    /\bsession\b.*\b(?:not found|does not exist|unknown)\b/i.test(error.message) ||
    /\b(?:not found|unknown)\b.*\bsession\b/i.test(error.message)
  );
}

export function isRequestTimeout(error: unknown, method: string): error is RequestTimeoutError {
  return error instanceof RequestTimeoutError && error.method === method;
}

export function isDynamicToolCall(value: unknown): value is DynamicToolCallParams {
  return (
    isRecord(value) &&
    isString(value.threadId) &&
    isString(value.turnId) &&
    isString(value.callId) &&
    (isString(value.namespace) || value.namespace === null) &&
    isString(value.tool) &&
    "arguments" in value
  );
}

export function toThreadItem(value: DynamicRecord): ThreadItem | null {
  const type = getString(value, "type");
  if (type === "reasoning") {
    return {
      type: "agentMessage",
      id: getString(value, "id") ?? undefined,
      phase: "commentary",
      text: reasoningText(value),
    };
  }
  return type ? { ...value, type } : null;
}

/** What a tool step was, in the closed set product analytics reports. */
type ToolUsageKind =
  | "command"
  | "file_change"
  | "file_read"
  | "web_search"
  | "web_fetch"
  | "mcp"
  | "image_generation"
  | "subagent"
  | "other";

/**
 * One finished tool step. `server` and `tool` are the provider's raw names, not yet safe to send:
 * the main process keeps them only for OpenBot's own servers and catalog plugins.
 */
export interface ToolUsage {
  kind: ToolUsageKind;
  server?: string;
  tool?: string;
  failed: boolean;
}

/** A tool step and the turn it ran in. */
export interface ToolUsageSignal extends ToolUsage {
  agentId: string;
  turnId: string;
}

const CODEX_ITEM_KINDS = new Map<string, ToolUsageKind>([
  ["commandExecution", "command"],
  ["fileChange", "file_change"],
  ["imageView", "file_read"],
  ["webSearch", "web_search"],
  ["imageGeneration", "image_generation"],
  ["image_generation_call", "image_generation"],
  ["collabAgentToolCall", "subagent"],
]);

const CLAUDE_TOOL_KINDS = new Map<string, ToolUsageKind>([
  ["Bash", "command"],
  ["BashOutput", "command"],
  ["KillShell", "command"],
  ["Read", "file_read"],
  ["Glob", "file_read"],
  ["Grep", "file_read"],
  ["LS", "file_read"],
  ["NotebookRead", "file_read"],
  ["Edit", "file_change"],
  ["MultiEdit", "file_change"],
  ["Write", "file_change"],
  ["NotebookEdit", "file_change"],
  ["WebSearch", "web_search"],
  ["WebFetch", "web_fetch"],
  ["Task", "subagent"],
  ["Agent", "subagent"],
]);

const ACP_TOOL_KINDS = new Map<string, ToolUsageKind>([
  ["execute", "command"],
  ["read", "file_read"],
  ["search", "file_read"],
  ["edit", "file_change"],
  ["delete", "file_change"],
  ["move", "file_change"],
  ["fetch", "web_fetch"],
]);

/**
 * Classifies a completed tool item for analytics, or answers `null` for an item that is not a tool.
 *
 * Codex names its item types; Claude names a built-in tool or `mcp__<server>__<tool>`; an ACP agent
 * sends a free-text title, so only its `toolKind` enum is read and the title never is.
 */
export function toolUsage(item: ThreadItem): ToolUsage | null {
  const status = getString(item, "status");
  const failed = status === "failed" || status === "declined";
  const codexKind = CODEX_ITEM_KINDS.get(item.type);
  if (codexKind) return { kind: codexKind, failed };
  if (item.type === "mcpToolCall") {
    const server = getString(item, "server");
    const tool = getString(item, "tool");
    return { kind: "mcp", ...(server ? { server } : {}), ...(tool ? { tool } : {}), failed };
  }
  if (item.type === "dynamicToolCall") {
    const namespace = getString(item, "namespace");
    const tool = getString(item, "tool");
    return namespace
      ? { kind: "mcp", server: namespace, ...(tool ? { tool } : {}), failed }
      : { kind: "other", failed };
  }
  if (item.type !== "toolCall") return null;
  const acpKind = getString(item, "toolKind");
  if (acpKind !== null) return { kind: ACP_TOOL_KINDS.get(acpKind) ?? "other", failed };
  const name = getString(item, "name") ?? "";
  const claudeKind = CLAUDE_TOOL_KINDS.get(name);
  if (claudeKind) return { kind: claudeKind, failed };
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  if (!mcp?.[1] || !mcp[2]) return { kind: "other", failed };
  // A server name can contain `__`, so `mcp__openbot__acme__list` does not show where the server
  // name stops. Such a step keeps no names: a user's server must never pass as a built-in one.
  if (mcp[2].includes("__")) return { kind: "mcp", failed };
  return { kind: "mcp", server: mcp[1], tool: mcp[2], failed };
}

/** The longest reason the activity line and the log keep. The full text stays with the provider. */
const TOOL_FAILURE_REASON_LIMIT = 240;

/** A failed tool step: the tool that failed and why, as one redacted line each. */
export interface ToolFailure {
  tool: string;
  reason: string | null;
}

function firstLine(text: string, last = false): string {
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (last ? lines.at(-1) : lines[0]) ?? "";
}

function oneLine(text: string): string {
  const line = redactText(text).replace(/\s+/gu, " ").trim();
  return line.length > TOOL_FAILURE_REASON_LIMIT ? `${line.slice(0, TOOL_FAILURE_REASON_LIMIT).trimEnd()}…` : line;
}

/** The text a provider put in a failed step: an `error`, a `result`, or the content a tool returned. */
function failureText(item: ThreadItem): string {
  for (const key of ["error", "failure", "result"] as const) {
    const value = item[key];
    if (isString(value) && value.trim()) return firstLine(value);
    if (isRecord(value)) {
      const message = getString(value, "message") ?? getString(value, "error") ?? getString(value, "text");
      if (message?.trim()) return firstLine(message);
    }
  }
  const contentItems = item.contentItems;
  if (Array.isArray(contentItems)) {
    const text = contentItems
      .filter(isRecord)
      .map((content) => getString(content, "text") ?? "")
      .find((value) => value.trim());
    if (text) return firstLine(text);
  }
  // A shell step has no error text; the last line of its output is usually the failure.
  const output = getString(item, "aggregatedOutput");
  const exitCode = item.exitCode;
  const code = typeof exitCode === "number" ? `exit code ${exitCode}` : "";
  return [code, output ? firstLine(output, true) : ""].filter(Boolean).join(": ");
}

/**
 * What a completed tool step that failed was, or null when the step did not fail. A provider names
 * the failure differently: Codex puts an `error` on an MCP call and `success: false` on a dynamic one,
 * Claude marks a result `is_error`, and an ACP agent sets the status. A declined step is the user's
 * own choice, so it is not a failure. Both fields are redacted and cut: they reach the log and the
 * activity line, and a tool quotes what it was given.
 */
export function toolFailure(item: ThreadItem): ToolFailure | null {
  const type = item.type.toLowerCase();
  if (!/(tool.*call|commandexecution|filechange|websearch|computeraction)/u.test(type)) return null;
  const dynamicFailed = item.type === "dynamicToolCall" && item.success === false;
  if (getString(item, "status") !== "failed" && !dynamicFailed) return null;
  const server = getString(item, "server") ?? getString(item, "namespace");
  const named = getString(item, "tool") ?? getString(item, "name") ?? getString(item, "title");
  const claude = named ? /^mcp__(.+?)__(.+)$/u.exec(named) : null;
  const tool =
    item.type === "commandExecution"
      ? "command"
      : item.type === "fileChange"
        ? "file change"
        : claude?.[1] && claude[2]
          ? `${claude[1]}.${claude[2]}`
          : server && named
            ? `${server}.${named}`
            : (named ?? item.type);
  return { tool: oneLine(tool), reason: oneLine(failureText(item)) || null };
}

export function toolProgressText(item: ThreadItem, completed: boolean): string | null {
  const type = item.type.toLowerCase();
  if (!/(tool.*call|commandexecution|filechange|websearch|computeraction)/u.test(type)) return null;
  const failure = completed ? toolFailure(item) : null;
  if (failure) {
    return failure.reason
      ? sourceText("status.agent.toolFailed", { tool: failure.tool, reason: failure.reason })
      : sourceText("status.agent.toolFailedNoReason", { tool: failure.tool });
  }

  const descriptor = [item.type, getString(item, "name"), getString(item, "title"), getString(item, "tool")]
    .filter(isString)
    .join(" ")
    .toLowerCase();
  // Before the generic words below, because a driver tool such as `get_window_state` matches them.
  // The completed text is what the user reads while the model decides the next action, so a long
  // wait after it is the model, not the driver.
  if (getString(item, "server") === COMPUTER_USE_MCP_SERVER_NAME || descriptor.includes(COMPUTER_USE_MCP_SERVER_NAME)) {
    return sourceText(completed ? "status.computerUse.progressDeciding" : "status.computerUse.progressActing");
  }
  if (/(search|browser|fetch|navigate|open_url|web)/u.test(descriptor)) {
    return completed ? "Reviewing the sources and information I found…" : "Searching for current information…";
  }
  if (/(read|find|list|get|inspect|snapshot)/u.test(descriptor)) {
    return completed ? "Reviewing the information I gathered…" : "Gathering the relevant information…";
  }
  if (/(test|check|lint|build|verify)/u.test(descriptor)) {
    return completed ? "Reviewing the verification results…" : "Checking the work…";
  }
  if (/(write|edit|patch|create|update|delete|move|filechange)/u.test(descriptor)) {
    return completed ? "Reviewing the changes I made…" : "Making the requested changes…";
  }
  if (/(agent|delegate|message|send)/u.test(descriptor)) {
    return completed ? "Reviewing the other agent’s response…" : "Coordinating with another agent…";
  }
  return completed ? "Reviewing the latest tool result…" : "Working through the next tool-assisted step…";
}

export function providerForAgent(agent: { provider: AgentProvider }): AgentProvider {
  return agent.provider;
}

export function providerLabel(provider: AgentProvider): string {
  return agentProviderName(provider);
}
