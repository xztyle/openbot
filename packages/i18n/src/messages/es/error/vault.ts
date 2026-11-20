import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/vault";

export const messages = {
  "error.vault.twoStepKeyInvalid":
    "Esto no es una clave de verificación en dos pasos. Pega la clave que el sitio muestra bajo su código QR (al menos 16 letras y números) o su enlace otpauth://totp/.",
} as const satisfies PartialTranslation<typeof source>;
