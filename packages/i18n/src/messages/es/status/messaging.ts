import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/messaging";

export const messages = {
  "status.messaging.working": "Trabajando en ello…",
  "status.messaging.queued": "En espera: Atelier está trabajando en otra solicitud. La respuesta llegará aquí.",
  "status.messaging.busy": "Hay demasiadas solicitudes en espera. Inténtalo más tarde.",
  "status.messaging.failed": "Atelier no pudo completar esta solicitud. El host de Atelier tiene los detalles.",
  "status.messaging.noAnswer": "Atelier terminó sin una respuesta escrita.",
  "status.messaging.noAgent": "Aún no puede responder ningún agente aquí. Agrega el Orquestador de Slack en Atelier.",
  "status.messaging.delegated": "Un compañero está trabajando en ello. La respuesta llegará aquí.",
  "status.messaging.stopped": "Detenido.",
  "status.messaging.stop": "Detener",
  "status.messaging.approvalTitle": "Atelier pide aprobación para continuar.",
  "status.messaging.approvalCommand": "Ejecutar un comando",
  "status.messaging.approvalFileChange": "Cambiar archivos",
  "status.messaging.approvalPermissions": "Obtener más permisos",
  "status.messaging.approve": "Aprobar",
  "status.messaging.deny": "Rechazar",
  "status.messaging.approvedBy": "Aprobado por {user}.",
  "status.messaging.deniedBy": "Rechazado por {user}.",
  "status.messaging.answeredOnHost": "Respondido en el host de Atelier.",
  "status.messaging.requestInactive": "Esta solicitud ya no está activa.",
  "status.messaging.onlyRequester": "Solo {user} puede hacerlo. El host de Atelier también puede responder.",
  "status.messaging.hostOnly": "Solo el host de Atelier puede responder a esta solicitud.",
  "status.messaging.filesSkipped": "Algunos archivos no se enviaron: {names}.",
  "status.messaging.orchestratorName": "Orquestador de Slack",
  "status.messaging.orchestratorTitle": "Responde en Slack y consulta al equipo",
  "status.messaging.discordNoAgent":
    "Aún no puede responder ningún agente aquí. Agrega el Orquestador de Discord en Atelier.",
  "status.messaging.discordOrchestratorName": "Orquestador de Discord",
  "status.messaging.discordOrchestratorTitle": "Responde en Discord y consulta al equipo",
  "status.messaging.integrationsSection": "Integraciones",
  "status.messaging.signInReceived": "Atelier recibió la instalación de Slack. Puedes cerrar esta pestaña.",
  "status.messaging.signInUnknown": "Atelier no inició esta instalación de Slack. Iníciala de nuevo en Atelier.",
  "status.messaging.telegramNoAgent":
    "Aún no hay ningún agente que pueda responder aquí. Agrega el Orquestador de Telegram en Atelier.",
  "status.messaging.telegramLinked":
    "Atelier está conectado a este chat. Menciona a {bot} o responde a un mensaje de Atelier para consultar a los agentes.",
  "status.messaging.telegramOrchestratorName": "Orquestador de Telegram",
  "status.messaging.telegramOrchestratorTitle": "Responde en Telegram y consulta al equipo",
} as const satisfies PartialTranslation<typeof source>;
