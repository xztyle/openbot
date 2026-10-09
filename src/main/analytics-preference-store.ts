import type { AnalyticsPreference } from "@openbot/contracts/ipc";
import { isBoolean, isDynamicRecord } from "@openbot/contracts/runtime-values";
import { Effect } from "effect";
import { isMissingFileError } from "../backend/file-errors";
import { type PreferenceFileFailure, readPreferenceFile, writePreferenceFile } from "./preference-file";

const DEFAULT_PREFERENCE: AnalyticsPreference = { enabled: true };

const OFF_VALUES = new Set(["0", "off", "false", "no"]);

/**
 * `OPENBOT_ANALYTICS=off` (or `0`, `false`, `no`) and `DO_NOT_TRACK=1` turn product analytics off for
 * the whole run, with no window to click. The saved preference stays as it is. The variable can only
 * turn analytics off: it never turns on what the owner turned off.
 */
export function analyticsDisabledByEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const analytics = environment.OPENBOT_ANALYTICS?.trim().toLowerCase();
  if (analytics !== undefined && OFF_VALUES.has(analytics)) return true;
  const doNotTrack = environment.DO_NOT_TRACK?.trim().toLowerCase();
  return doNotTrack === "1" || doNotTrack === "true";
}

export const readAnalyticsPreference = Effect.fn("readAnalyticsPreference")((path: string) =>
  readPreferenceFile(path, (parsed): AnalyticsPreference => {
    if (!isDynamicRecord(parsed) || parsed.version !== 1 || !isBoolean(parsed.enabled)) {
      return { enabled: false };
    }
    return { enabled: parsed.enabled };
  }).pipe(
    Effect.catch((failure) => {
      const error = failure.cause;
      if (isMissingFileError(error)) return Effect.succeed({ ...DEFAULT_PREFERENCE });
      if (error instanceof SyntaxError) return Effect.succeed({ enabled: false });
      return Effect.fail(failure);
    }),
  ),
);

export function writeAnalyticsPreference(
  path: string,
  enabled: boolean,
): Effect.Effect<AnalyticsPreference, PreferenceFileFailure> {
  return Effect.gen(function* () {
    const preference = { enabled };
    yield* writePreferenceFile(path, { version: 1, enabled });
    return preference;
  });
}
