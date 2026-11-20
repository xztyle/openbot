import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Necesita tu respuesta.",
  "notification.needsApproval": "Necesita tu aprobación.",
  "notification.needsBrowserStep": "Necesita que completes un paso en el navegador.",
  "notification.needsPassword": "Necesita tu contraseña de {site}.",
  "notification.needsCode": "Necesita un código de acceso de {site}.",
  "notification.needsSignIn": "Necesita que inicies sesión en el navegador.",
  "notification.needsApprovalFor": "Necesita tu aprobación: {action}",
  "notification.finished": "Ha terminado de trabajar.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Un paso espera tu aprobación.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Un flujo de trabajo tiene un resultado nuevo.",
  "notification.failed": "Se detuvo con un error.",
  "notification.channelTitle": "{agent} en {channel}",
  "notification.teammateTitle": "{agent}: {teammate} te necesita",
  "notification.channelMessage": "Envió un mensaje.",
  "notification.conversationTitle": "{author} en {conversation}",
  "notification.mentionedYou": "Te mencionó.",
  "notification.directMessage": "Te envió un mensaje.",
  "notification.threadReply": "Respondió en un hilo que sigues.",
  "notification.newMessages": { one: "{count} mensaje nuevo.", other: "{count} mensajes nuevos." },
  "notification.usageLimit.title": "La cuenta de {provider} alcanzó su límite",
  "notification.usageLimit.body": {
    one: "{count} agente espera. Atelier lo intentará de nuevo más tarde.",
    other: "{count} agentes esperan. Atelier lo intentará de nuevo más tarde.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agente espera. Se restablece {reset}.",
    other: "{count} agentes esperan. Se restablece {reset}.",
  },
  "notification.test": "Las notificaciones funcionan.",
  "notification.welcome": "Atelier te avisará aquí cuando un agente te necesite.",
  "notification.toast.region": "Notificaciones",
  "notification.toast.close": "Cerrar notificación",
} as const satisfies PartialTranslation<typeof source>;
