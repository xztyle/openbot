import { DEFAULT_REMOTE_CONTROL_POLICY, isRemoteControlAccess, type RemoteControlPolicy } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import { PreferenceStore } from "./preference-file";

/**
 * Who may control this computer through remote desktop. The Team API reads it at each remote desktop
 * request. A missing or unknown file reads as the owner and the admins. The file has upstream's
 * shape (`version`, `access`, and `askOnHost`, which Atelier does not read), so the owner can set
 * `"access": "members"` or `"owner"` in it.
 */
export type RemoteControlPolicyStore = PreferenceStore<RemoteControlPolicy>;

export function createRemoteControlPolicyStore(path: string): RemoteControlPolicyStore {
  return new PreferenceStore({
    path,
    defaultValue: DEFAULT_REMOTE_CONTROL_POLICY,
    decode: (parsed) =>
      isDynamicRecord(parsed) && parsed.version === 1 && isRemoteControlAccess(parsed.access)
        ? { access: parsed.access }
        : null,
  });
}
