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
  "status.agent.messageDuplicate":
    "Un mensaje idéntico para este agente todavía está en cola o en curso. Atelier no lo volvió a enviar.",
  "status.agent.messageHeld":
    "Enviado como fyi: no despierta a los destinatarios, que lo leen en su siguiente turno. Si alguien debe actuar ya, envíalo de nuevo sin fyi.",
  "status.agent.toolFailed": "Falló un paso de herramienta: {tool}. {reason}",
  "status.agent.toolFailedNoReason": "Falló un paso de herramienta ({tool}). Decidiendo qué intentar ahora…",
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
  "status.agent.vaultCardFill":
    "Llenar la tarjeta guardada {card} en {site}. Si lo apruebas, los agentes podrán llenar esta tarjeta en este sitio sin aprobación. Quita el sitio en Ajustes del servidor > Bóveda.",
  "status.agent.vaultCardFillFrames": "Los campos de la tarjeta están en marcos de {origins}.",
  "status.agent.secretKeyFill":
    "Llenar la clave guardada {name} en el campo de contraseña de {site}. Si lo apruebas, los agentes podrán llenar esta clave en este sitio sin aprobación. Quita la clave en Secretos para retirar la aprobación.",
  "status.agent.secretKeyCodeFill":
    "Llenar un código de verificación en dos pasos de la clave guardada {name} en el campo de código de {site}. Si lo apruebas, los agentes podrán llenar códigos de esta clave en este sitio sin aprobación. Elimina la clave en Secretos para quitar la aprobación.",
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
  "status.agent.mcpServerAdd":
    "Agregar el servidor MCP {name}: {target}. Todos los agentes de este servidor reciben sus herramientas. Atelier se conecta para probarlo.",
  "status.agent.mcpServerChange":
    "Cambiar el servidor MCP {name} a {target}. Todos los agentes de este servidor reciben sus herramientas. Atelier se conecta para probarlo.",
  "status.agent.mcpServerEnable": "Activar el servidor MCP {name} para todos los agentes de este servidor.",
  "status.agent.mcpServerDisable": "Desactivar el servidor MCP {name} para todos los agentes de este servidor.",
  "status.agent.mcpServerRemove":
    "Quitar el servidor MCP {name} y su inicio de sesión de todos los agentes de este servidor.",
  "status.agent.mcpSignInRequested":
    "El servidor MCP {name} necesita que inicies sesión. Hazlo en Ajustes del servidor, MCP.",
  "status.agent.vaultAdded": "Guardado en la Bóveda: {name}",
  "status.agent.vaultUpdated": "Cambiado en la Bóveda: {name}",
  "status.agent.vaultDeleted": "Borrado de la Bóveda: {name}",
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
  "status.agent.trustAskCheckout":
    "{agent} quiere actuar en una página de pago ({site}): {what}. La política de confianza te pregunta primero.",
  "status.agent.trustAskCheckoutSurface":
    "{agent} quiere actuar en una página de pago ({site}): {what}. Si lo permites, no te volverá a preguntar en ese sitio durante {minutes} minutos, mientras sigue con esta tarea.",
  "status.agent.moneyCard.checkout": "Actúa en una página de pago ({site}), monto desconocido: {what}",
  "status.agent.moneyCard.checkoutAmount": "Paga {amount} en una página de pago ({site}): {what}",
  "status.agent.moneyCard.payUnknown": "{platform} · pagar un monto desconocido",
  "status.agent.moneyCard.payByHand": "Después de aprobar: paga {amount} a mano en {where}.",
  "status.agent.moneyCard.payByHandUnknown": "Después de aprobar: paga a mano en {where}. Monto desconocido.",
  "status.agent.moneyApprovalExpires": "Caduca en {hours} h si nadie responde, y la acción no se ejecuta.",
  "status.agent.approvalCard.purpose": "Para qué: {purpose}",
  "status.agent.approvalCard.summary": "Resumen de Atelier: {purpose}",
  "status.agent.approvalCard.action": "Acción: {action}",
  "status.agent.approvalCard.amount": "Monto: {amount}",
  "status.agent.approvalCard.details": "Detalles técnicos:",
  "status.agent.trustAskAfterUntrusted":
    "{agent} leyó contenido externo (una web, un email o un webhook) en este turno y el control de seguridad no pudo validar este pago. Decides tú.",
  "status.agent.escalatedBy": "{by} te lo pasa a ti: {reason}",
  "status.agent.unansweredByManagers": "Ningún agente de arriba respondió a tiempo, así que te llega a ti.",
  "status.agent.mailFirstRecipient":
    "Primer correo a {address}. Apruébalo para enviarlo; los siguientes a esta persona no necesitan tu OK.",
} as const satisfies PartialTranslation<typeof source>;
