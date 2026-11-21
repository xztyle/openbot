/**
 * What the Claude agents of a server load into each request (`claude-context-v1`), as the desktop main
 * process, the preload and the browser client read it.
 *
 * - `userSetup`: whether the agents load the user's own Claude Code setup, the settings, CLAUDE.md,
 *   skills, agents, hooks, plugins and output style of `~/.claude`, and the skills of `~/.agents/skills`.
 *   Off, each turn sends a shorter prompt. The files of an agent's workspace load in both cases, and
 *   the sign-in keys of `~/.claude/settings.json` still apply.
 * - `compactWindow`: the size in tokens at which Claude Code compacts a chat, or `null` for Claude
 *   Code's own size for each model. A model with a smaller context window compacts at its own limit.
 */

import { isBoolean, isDynamicRecord } from "./runtime-values";

/** The smallest and the largest size that Claude Code accepts. */
export const CLAUDE_COMPACT_WINDOW_MIN_TOKENS = 100_000;
export const CLAUDE_COMPACT_WINDOW_MAX_TOKENS = 1_000_000;

/** The sizes that Settings offers. `null` is first: it leaves Claude Code's own size for each model. */
export const CLAUDE_COMPACT_WINDOW_CHOICES = [
  null,
  100_000,
  150_000,
  200_000,
  250_000,
  300_000,
  400_000,
  600_000,
  800_000,
  1_000_000,
] as const;

export interface ClaudeContextSetting {
  userSetup: boolean;
  compactWindow: number | null;
}

/**
 * The user's setup is off, so each turn sends the shorter prompt; an upgrade turns it off too, because
 * the file exists only after a change. Chats compact at 250,000 tokens: Claude Code's own size is the
 * model's whole window (1M for Sonnet and Opus), and every step of a long-lived agent re-reads it.
 */
export const DEFAULT_CLAUDE_COMPACT_WINDOW = 250_000;
export const DEFAULT_CLAUDE_CONTEXT: ClaudeContextSetting = {
  userSetup: false,
  compactWindow: DEFAULT_CLAUDE_COMPACT_WINDOW,
};

/** A whole number of tokens that Claude Code accepts, or `null` for its own size. */
export function isClaudeCompactWindow(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= CLAUDE_COMPACT_WINDOW_MIN_TOKENS &&
      value <= CLAUDE_COMPACT_WINDOW_MAX_TOKENS)
  );
}

/**
 * The sizes to offer when `saved` is the saved size: `null` first, then the sizes from small to large.
 * A size that another client saved and that is not a choice is added, so it still shows.
 */
export function claudeCompactWindowSizes(saved: number | null): (number | null)[] {
  const sizes = new Set<number>();
  for (const size of [...CLAUDE_COMPACT_WINDOW_CHOICES, saved]) if (size !== null) sizes.add(size);
  return [null, ...[...sizes].sort((a, b) => a - b)];
}

export function decodeClaudeContextSetting(value: unknown): ClaudeContextSetting {
  if (!isDynamicRecord(value) || !isBoolean(value.userSetup) || !isClaudeCompactWindow(value.compactWindow))
    throw new Error("Invalid Claude context setting.");
  return { userSetup: value.userSetup, compactWindow: value.compactWindow };
}
