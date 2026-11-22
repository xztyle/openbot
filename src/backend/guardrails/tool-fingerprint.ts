import { createHash } from "node:crypto";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { redactText } from "@openbot/logging";
import { impactOf, type UntrustedSource, untrustedSourceOf } from "./injection-guard";

/** The part of an untrusted result that the monitor may read. */
const EXCERPT_LIMIT = 1_500;

/** A Claude tool's name as the guardrails read it: `server.tool` for `mcp__server__tool`. */
export function guardrailToolName(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/u.exec(name);
  return mcp?.[1] && mcp[2] ? `${mcp[1]}.${mcp[2]}` : name;
}

function commandOf(input: unknown): string | null {
  return isDynamicRecord(input) && isString(input.command) ? input.command : null;
}

/** What makes two calls of a tool the same, so the stuck watch can count repeats. */
export function toolInputDigest(name: string, input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([name, input ?? null]) ?? "")
    .digest("hex")
    .slice(0, 24);
}

/**
 * The fields a completed tool item carries for the guardrails: a digest of its result, and, for a
 * result from the web, a browser, or an email, its first part with secrets redacted, for the monitor.
 */
export function toolResultFields(
  name: string,
  command: string | null,
  text: string,
): { resultDigest: string; untrustedExcerpt?: string } {
  const resultDigest = createHash("sha256").update(text).digest("hex").slice(0, 24);
  if (!untrustedSourceOf(guardrailToolName(name), command)) return { resultDigest };
  return { resultDigest, untrustedExcerpt: redactText(text.slice(0, EXCERPT_LIMIT)) };
}

/** The source of a Claude tool's untrusted result, for the note in the agent's context. */
export function untrustedClaudeResult(name: string, input: unknown): UntrustedSource | null {
  return untrustedSourceOf(guardrailToolName(name), commandOf(input));
}

/**
 * A Claude tool use as the guardrails check it in the trust hook, or null for a tool of Atelier's own
 * servers: those reach the tool router, which checks them for every provider.
 */
export function guardrailToolCall(name: unknown, input: unknown): { name: string; input: unknown } | null {
  if (typeof name !== "string") return null;
  const normalized = guardrailToolName(name);
  if (/^openbot(_browser)?\./u.test(normalized)) return null;
  return { name: normalized, input };
}

/** Whether a Claude tool use is high impact, so the trust hook asks the host before it runs. */
export function guardedClaudeToolUse(name: string, input: unknown): boolean {
  const call = guardrailToolCall(name, input);
  return call !== null && impactOf(call.name, call.input, null) !== null;
}

export { commandOf as toolCommand };
