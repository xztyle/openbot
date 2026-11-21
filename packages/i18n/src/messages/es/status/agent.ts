import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.claudeWriteOutside":
    "Escribir en {path}, fuera del espacio de trabajo del agente, la carpeta compartida y las carpetas temporales.",
  "status.agent.contextCleared": "Contexto borrado. Aquí empieza un nuevo chat.",
  "status.agent.modelSwitchedForLimit": "Límite de uso alcanzado. Se cambió a {model}.",
  "status.agent.modelReturnedAfterLimit": "El límite de uso terminó. Se volvió a {model}.",
  "status.agent.modelSwitchedForError": "Error del proveedor. Se cambió a {model}.",
  "status.agent.modelReturnedAfterError": "Se volvió a {model} tras el error del proveedor.",
  "status.agent.marketplaceSuggested": "Se sugirió una aplicación de Marketplace: {app}.",
  "status.agent.channelMemberAdded": "{agent} agregó a {member} al canal. {person} lo pidió.",
  "status.agent.channelMemberRemoved": "{agent} quitó a {member} del canal. {person} lo pidió.",
  "status.agent.channelInstructionsChanged": "{agent} cambió las instrucciones del canal. {person} lo pidió.",
  "status.agent.channelRoutineCreated": "{agent} creó la rutina {routine}. {person} lo pidió.",
  "status.agent.channelRoutineUpdated": "{agent} cambió la rutina {routine}. {person} lo pidió.",
  "status.agent.channelRoutineDeleted": "{agent} eliminó la rutina {routine}. {person} lo pidió.",
  "status.agent.channelCreatedByAgent": "{agent} creó este canal.",
  "status.agent.channelSettingsChangedByAgent": "{agent} cambió la configuración del canal.",
  "status.agent.channelArchivedByAgent": "{agent} archivó este canal.",
  "status.agent.channelRestoredByAgent": "{agent} restauró este canal.",
  "status.agent.channelMembersAddedByAgent": "{agent} agregó a {members} al canal.",
  "status.agent.channelMembersRemovedByAgent": "{agent} quitó a {members} del canal.",
  "status.agent.channelMembersChangedByAgent": "{agent} cambió cómo responden {members} en el canal.",
  "status.agent.screenCaptureScreen": "Capturar la pantalla principal y enviar la imagen al modelo del agente.",
  "status.agent.screenCaptureChannel":
    "La imagen aparece en el canal {channel}, y cada miembro de este servidor que lee el canal puede verla.",
  "status.agent.screenCaptureDisplay": "Capturar la pantalla {name} y enviar la imagen al modelo del agente.",
  "status.agent.screenCaptureWindow": "Capturar la ventana {name} y enviar la imagen al modelo del agente.",
  "status.agent.screenCaptureRegion":
    "Capturar el área de la pantalla en {x}, {y}, de {width} × {height} puntos, y enviar la imagen al modelo del agente.",
  "status.agent.secretKeyCodeFill":
    "Rellenar un código de verificación en dos pasos de la clave guardada {name} en el campo de código de {site}. Si lo apruebas, los agentes podrán rellenar códigos de esta clave en este sitio sin aprobación. Elimina la clave en Secretos para quitar la aprobación.",
  "status.agent.screenCaptureProgress": "Pidiendo permiso para capturar la pantalla…",
  "status.agent.screenCaptureReviewing": "Revisando la captura de pantalla…",
  "status.agent.memoriesSearching": "Buscando en sus recuerdos…",
  "status.agent.memoriesSearched": {
    one: "Buscó en sus recuerdos: {count} encontrado",
    other: "Buscó en sus recuerdos: {count} encontrados",
  },
  "status.agent.memoriesUpdating": "Actualizando sus recuerdos…",
  "status.agent.skillUsing": "Usando la habilidad {name}…",
  "status.agent.skillReading": "Leyendo una habilidad…",
  "status.agent.memoryChanges": "Recuerdos: {saved} guardados, {updated} actualizados, {forgotten} olvidados.",
  "status.agent.trustAsk.pay": "{agent} quiere hacer un pago. La política de confianza te pregunta primero.",
  "status.agent.trustAsk.launchAds":
    "{agent} quiere lanzar o financiar anuncios. La política de confianza te pregunta primero.",
  "status.agent.trustAsk.publish": "{agent} quiere publicar. La política de confianza te pregunta primero.",
  "status.agent.trustAsk.email":
    "{agent} quiere enviar correos a personas. La política de confianza te pregunta primero.",
  "status.agent.trustAsk.createAgent": "{agent} quiere crear un agente. La política de confianza te pregunta primero.",
  "status.agent.trustAsk.delete": "{agent} quiere borrar algo. La política de confianza te pregunta primero.",
  "status.agent.trustAskSurface":
    "{agent} quiere actuar en {site}, donde un clic puede gastar dinero o publicar. Si lo permites, {agent} puede actuar allí durante {minutes} minutos.",
  "status.agent.trustAskDaily":
    "{agent} quiere gastar {amount} en {platform}. Supera el presupuesto diario: {spent} de {limit} gastados hoy.",
  "status.agent.trustAskTotal":
    "{agent} quiere gastar {amount} en {platform}. Supera el presupuesto total: {spent} de {limit} gastados.",
  "status.agent.trustAskUnknown":
    "{agent} quiere gastar en {platform} y no se sabe el importe. Un presupuesto cubre {platform}.",
} as const satisfies PartialTranslation<typeof source>;
