/**
 * What `openbot status` and `openbot health` say about the running server, besides the account and
 * the host. Everything here is a number, a state word, a time or a reason code from a fixed list.
 * It holds no path, no name, no message of a provider and no secret, so the control socket can
 * send it as it is. A failure of the agent start is shown as one redacted, short sentence.
 *
 * This file does not import Electron or the services. The entry point passes in read-only getters.
 */

import { redactText } from "@openbot/logging";
import type { HostMemoryLevel } from "../backend/host-memory";
import type { LastShutdown } from "./run-marker";
import type { TurnActivityReport } from "./silent-turn-monitor";

export type AgentInitState = "idle" | "pending" | "ok" | "failed";

export interface ServerHealthSources {
  agentInit: () => { state: AgentInitState; failure: unknown };
  /** The newest applied migration, or null when the database cannot be read. */
  schemaVersion: () => number | null;
  restartReadiness: () => { safeToRestart: boolean; reasons: readonly string[] };
  providers: () => readonly { id: string; state: string }[];
  providerRestarts: () => readonly { provider: string; attempts: number; nextAttemptAt: number }[];
  /** Null when this server has no memory guard. */
  memoryLevel: () => HostMemoryLevel | null;
  startedAt: number;
  runState: () => { lastShutdown: LastShutdown; startsLast24Hours: number } | null;
  turns: () => TurnActivityReport;
  analyticsEnabled: () => boolean;
  now?: () => number;
}

export type ServerHealthLines = Record<string, string | number | null>;

export interface ServerHealth {
  /** The extra lines of `status`. */
  lines: ServerHealthLines;
  healthy: boolean;
  /** Reason codes, empty when healthy. */
  problems: string[];
}

const MAX_FAILURE_LENGTH = 200;
const MAX_ID_LENGTH = 40;

/** A value that is safe on one `key=value` line: no line break, no unusual character. */
function token(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, MAX_ID_LENGTH);
}

function safeFailure(failure: unknown): string | null {
  if (failure === null || failure === undefined) return null;
  const text = failure instanceof Error ? failure.message : String(failure);
  // `AgentLifecycleFailed` and similar errors keep the native error in `cause`.
  const cause =
    failure instanceof Error && failure.cause instanceof Error && failure.cause.message ? failure.cause.message : "";
  const sentence = redactText(`${text}${cause && cause !== text ? `: ${cause}` : ""}`)
    .replace(/\s+/gu, " ")
    .trim();
  return sentence.length > MAX_FAILURE_LENGTH ? `${sentence.slice(0, MAX_FAILURE_LENGTH)}…` : sentence;
}

export function describeServerHealth(sources: ServerHealthSources): ServerHealth {
  const now = sources.now?.() ?? Date.now();
  const init = sources.agentInit();
  const schemaVersion = sources.schemaVersion();
  const readiness = sources.restartReadiness();
  const turns = sources.turns();
  const runState = sources.runState();
  const memory = sources.memoryLevel();

  const problems: string[] = [];
  if (init.state === "failed") problems.push("agent_init_failed");
  else if (init.state !== "ok") problems.push("agent_init_not_ready");
  if (schemaVersion === null) problems.push("database_unreadable");

  const providers = sources.providers().filter((row) => row.state !== "not-installed");
  const restarts = sources.providerRestarts();

  return {
    healthy: problems.length === 0,
    problems,
    lines: {
      health: problems.length === 0 ? "ok" : "unhealthy",
      health_problems: problems.length > 0 ? problems.join(",") : null,
      agent_init: init.state === "idle" ? "pending" : init.state,
      agent_init_message: init.state === "failed" ? safeFailure(init.failure) : null,
      schema_version: schemaVersion,
      safe_to_restart: readiness.safeToRestart ? "yes" : "no",
      busy: readiness.safeToRestart ? null : readiness.reasons.map(token).join(","),
      providers: providers.length > 0 ? providers.map((row) => `${token(row.id)}:${token(row.state)}`).join(",") : null,
      provider_retry:
        restarts.length > 0
          ? restarts
              .map(
                (restart) =>
                  `${token(restart.provider)} attempt=${restart.attempts} next_in_s=${Math.max(0, Math.round((restart.nextAttemptAt - now) / 1000))}`,
              )
              .join("; ")
          : null,
      memory,
      uptime_s: Math.max(0, Math.floor((now - sources.startedAt) / 1000)),
      last_shutdown: runState?.lastShutdown ?? "unknown",
      starts_24h: runState?.startsLast24Hours ?? null,
      running_turns: turns.running,
      longest_turn_s: turns.longestTurnSeconds,
      longest_turn_idle_s: turns.longestIdleSeconds,
      silent_turns: turns.silent,
      analytics: sources.analyticsEnabled() ? "on" : "off",
    },
  };
}
