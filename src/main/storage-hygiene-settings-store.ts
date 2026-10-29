import {
  DEFAULT_STORAGE_HYGIENE_SETTINGS,
  decodeStorageHygieneSettings,
  type StorageHygieneSettings,
} from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * The storage hygiene settings of this server: the automatic cleanup rules, both off by default,
 * and the thresholds of the plan. A file that is missing or that names an invalid value reads as
 * the defaults.
 */
export type StorageHygieneSettingsStore = PreferenceStore<StorageHygieneSettings>;

export function createStorageHygieneSettingsStore(path: string): StorageHygieneSettingsStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_STORAGE_HYGIENE_SETTINGS,
    decode: (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
      try {
        return decodeStorageHygieneSettings(parsed);
      } catch {
        return null;
      }
    },
  });
}
