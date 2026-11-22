import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/host";

export const messages = {
  "status.host.registered": "Se registró este Atelier para el acceso WebRTC.",
  "status.host.keyRotated": "Clave del servidor cambiada. Los dispositivos vinculados siguen vinculados.",
  "status.host.identityUpdated": "Identidad del servidor actualizada.",
  "status.host.starting": "Iniciando el host WebRTC…",
  "status.host.ready": "Este Atelier está listo para conexiones WebRTC.",
  "status.host.signalLost": "Otros dispositivos no pueden llegar a este Atelier ahora. Se vuelve a conectar.",
  "status.host.stopping": "Haciendo privado este Atelier…",
  "status.host.private": "Este Atelier es privado.",
} as const satisfies PartialTranslation<typeof source>;
