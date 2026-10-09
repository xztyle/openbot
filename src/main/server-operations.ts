/**
 * The operator actions of a self-hosted server, as the control socket calls them: the state for
 * `status` and `health`, a database snapshot, the diagnostics report and the analytics switch.
 *
 * `application-services.ts` only passes in the services. Nothing here runs by itself: a snapshot
 * starts only when the operator asks for one, because a full copy of the database has an unbounded
 * time and disk cost.
 */

import type { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { readSchemaVersion, writeDatabaseSnapshot } from "../backend/database-snapshot";
import type { HostMemory } from "../backend/host-memory";
import type { AgentInitializationGate } from "./agent-initialization";
import { writeAnalyticsPreference } from "./analytics-preference-store";
import type { RunMarker } from "./run-marker";
import { describeServerHealth, type ServerHealth } from "./server-health";
import type { ServerModeOptions } from "./server-mode";
import type { SilentTurnMonitor } from "./silent-turn-monitor";
import type { RestartReadiness } from "./update-readiness";

export interface ServerOperationsDependencies {
  startedAt: number;
  agentInitialization: Pick<AgentInitializationGate<unknown>, "state" | "failure">;
  /** The open `openbot.db` connection. It throws while the database is closed. */
  database: () => DatabaseSync;
  describeRestartReadiness: () => RestartReadiness;
  service: {
    getStatus(): { providers?: readonly { id: string; state: string }[] };
    providerRestarts(): readonly { provider: string; attempts: number; nextAttemptAt: number }[];
  };
  /** Null when the server has no memory guard. */
  hostMemory: HostMemory | null;
  runMarker: RunMarker;
  silentTurns: SilentTurnMonitor;
  analytics: { readonly trackingEnabled: boolean; setTrackingEnabled(enabled: boolean): void };
  analyticsPreferenceFile: string;
  /** True when `OPENBOT_ANALYTICS` turns analytics off for this run. */
  analyticsLockedOff: boolean;
  renderDiagnostics: () => Effect.Effect<string, { readonly cause: unknown }>;
}

export type ServerOperations = Required<Pick<ServerModeOptions, "health" | "snapshot" | "diagnostics" | "analytics">>;

export function createServerOperations(dependencies: ServerOperationsDependencies): ServerOperations {
  // The schema version changes only at a start, so it is read once. A closed database is not cached.
  let schemaVersion: number | null = null;
  const readVersion = (): number | null => {
    if (schemaVersion !== null) return schemaVersion;
    try {
      schemaVersion = readSchemaVersion(dependencies.database());
    } catch {
      return null;
    }
    return schemaVersion;
  };

  return {
    health: (): ServerHealth =>
      describeServerHealth({
        agentInit: () => ({
          state: dependencies.agentInitialization.state,
          failure: dependencies.agentInitialization.failure,
        }),
        schemaVersion: readVersion,
        restartReadiness: () => {
          const readiness = dependencies.describeRestartReadiness();
          return { safeToRestart: readiness.safeToRestart, reasons: readiness.reasons };
        },
        providers: () => dependencies.service.getStatus().providers ?? [],
        providerRestarts: () => dependencies.service.providerRestarts(),
        memoryLevel: () => dependencies.hostMemory?.level() ?? null,
        startedAt: dependencies.startedAt,
        runState: () => dependencies.runMarker.state,
        turns: () => dependencies.silentTurns.report(),
        analyticsEnabled: () => dependencies.analytics.trackingEnabled,
      }),
    snapshot: (destination) => Effect.suspend(() => writeDatabaseSnapshot(dependencies.database(), destination)),
    diagnostics: dependencies.renderDiagnostics,
    analytics: {
      lockedOff: dependencies.analyticsLockedOff,
      set: (enabled) =>
        writeAnalyticsPreference(dependencies.analyticsPreferenceFile, enabled).pipe(
          Effect.tap(() => Effect.sync(() => dependencies.analytics.setTrackingEnabled(enabled))),
        ),
    },
  };
}
