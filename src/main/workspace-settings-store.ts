import { DEFAULT_WORKSPACE_SETTINGS, decodeWorkspaceSettings, type WorkspaceSettings } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * The workspace settings of this server: the model of the answer gate and the answer mode that an
 * agent takes when it joins a workspace channel. A file that is missing or that names an invalid
 * value reads as the defaults.
 */
export type WorkspaceSettingsStore = PreferenceStore<WorkspaceSettings>;

export function createWorkspaceSettingsStore(path: string): WorkspaceSettingsStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_WORKSPACE_SETTINGS,
    decode: (parsed) => {
      if (!isDynamicRecord(parsed) || parsed.version !== 1) return null;
      try {
        return decodeWorkspaceSettings(parsed);
      } catch {
        return null;
      }
    },
  });
}
