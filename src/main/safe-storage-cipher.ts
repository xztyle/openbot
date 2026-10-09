import { sourceText } from "@openbot/i18n/source";
import { safeStorage } from "electron";

export function safeStorageCipher(
  unavailableKey: "error.app.secretStorageUnavailable" | "error.app.macSecureStorageUnavailable",
) {
  return {
    canPersist: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error(sourceText(unavailableKey));
      return safeStorage.encryptString(value);
    },
    decrypt: (value: Buffer) => safeStorage.decryptString(value),
  };
}
