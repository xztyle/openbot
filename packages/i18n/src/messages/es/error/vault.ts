import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/vault";

export const messages = {
  "error.vault.unavailable":
    "Este computador no tiene almacenamiento de secretos, así que la Bóveda no puede guardar elementos.",
  "error.vault.unreadable": "No se puede leer el archivo de la Bóveda. Restablece la Bóveda para volver a usarla.",
  "error.vault.tooLarge": "La Bóveda está llena. Borra algunos elementos e intenta de nuevo.",
  "error.vault.itemMissing": "Este elemento ya no está en la Bóveda.",
  "error.vault.valueTooLong": "Un valor es demasiado largo.",
  "error.vault.websiteInvalid": "Escribe una dirección de sitio web HTTPS.",
  "error.vault.passwordRequired": "Escribe una contraseña.",
  "error.vault.twoStepKeyInvalid":
    "Esto no es una clave de verificación en dos pasos. Pega la clave que el sitio muestra bajo su código QR (al menos 16 letras y números) o su enlace otpauth://totp/.",
  "error.vault.cardNumberInvalid": "Escribe un número de tarjeta válido.",
  "error.vault.securityCodeInvalid": "Escribe un código de seguridad de 3 o 4 dígitos.",
  "error.vault.expiryInvalid": "Escribe un mes y año de vencimiento válidos.",
  "error.vault.contactEmpty": "Escribe un nombre, una dirección, un teléfono o un correo.",
  "error.vault.contactMissing": "El contacto de facturación ya no está en la Bóveda.",
  "error.vault.csvInvalid": "Este archivo no es una exportación de contraseñas en formato CSV.",
  "error.vault.csvTooLarge": "El archivo CSV es demasiado grande.",
} as const satisfies PartialTranslation<typeof source>;
