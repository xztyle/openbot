import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/vault";

export const messages = {
  "vault.field.twoStepKey": "Clave de dos pasos",
  "vault.twoStepKeyHint":
    "Opcional. La clave de configuración que el sitio muestra bajo su código QR para una app de autenticación. Así los agentes introducen el código actual por ti.",
  "vault.removeTwoStepKey": "Quitar la clave de dos pasos",
  "vault.placeholder.twoStepKey": "Clave de configuración o enlace otpauth://",
} as const satisfies PartialTranslation<typeof source>;
