// Frozen optional claude-context-v1 wire contract.
//
// What it grants, recorded here because freezing it makes it permanent: an owner or admin of a
// server can read and set what that server's Claude agents load into each request. `userSetup`
// says whether they load the Claude Code setup of the host user's `~/.claude`; `compactWindow` is
// the size in tokens, from 100,000 to 1,000,000, at which Claude Code compacts a chat, or null for
// Claude Code's own size. The host applies both to the Claude processes that start after the change.
// A member cannot use either route; `requireAdmin` on the host is the only gate. Widening any of it
// needs a second capability string.
import { adminRoute, boolean, empty, fields, nullable, type OptionalRouteCodec } from "./admin-wire";

export const CLAUDE_CONTEXT_CAPABILITY = "claude-context-v1";

export const CLAUDE_CONTEXT_ROUTES = {
  settings: "/v1/admin/host/claude-context",
  update: "/v1/admin/host/claude-context/update",
} as const;

const compactWindow = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100_000 || value > 1_000_000)
    throw new Error("Invalid Claude compaction size.");
  return value;
};

const snapshot = fields({ userSetup: boolean, compactWindow: nullable(compactWindow) });

export const CLAUDE_CONTEXT_CODECS: ReadonlyMap<string, OptionalRouteCodec> = new Map([
  [CLAUDE_CONTEXT_ROUTES.settings, adminRoute(empty, snapshot)],
  [CLAUDE_CONTEXT_ROUTES.update, adminRoute(snapshot, snapshot)],
]);
