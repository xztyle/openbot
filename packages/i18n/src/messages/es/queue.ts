import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/queue";

export const messages = {
  "queue.othersWaiting": {
    one: "{count} aviso de Motion o de agentes en espera",
    other: "{count} avisos de Motion o de agentes en espera",
  },
  "queue.label": "Cola de mensajes",
  "queue.moved": "Se movió el mensaje en cola a la posición {position} de {total}.",
  "queue.attachment": "Archivo adjunto",
  "queue.hold.named": "En espera: {name} está trabajando en {channel}",
  "queue.hold.unnamed": "En espera: este agente está trabajando en {channel}",
  "queue.item.label": "Mensaje en cola {position}: {preview}",
  "queue.item.labelEditing": "Mensaje en cola {position}, en edición: {preview}",
  "queue.item.editing": "En edición",
  "queue.item.steerLabel": "Orientar con el mensaje en cola {position}",
  "queue.item.steerTooltip": "Orientar con el mensaje",
  "queue.item.steering": "Orientando",
  "queue.item.steer": "Orientar",
  "queue.item.notSteered": "No orientado",
  "queue.item.steerFallback.providerUnsupported":
    "Este proveedor no puede orientar un turno en curso, así que el mensaje espera en la cola.",
  "queue.item.steerFallback.steerFailed": "No se pudo orientar, así que el mensaje espera en la cola.",
  "queue.item.heldNote": "Espera al próximo turno",
  "queue.item.heldNoteReason":
    "Información de un compañero. No inicia ningún turno: el agente la lee con su próximo mensaje.",
  "queue.item.moveUpLabel": "Subir el mensaje en cola {position}",
  "queue.item.moveDownLabel": "Bajar el mensaje en cola {position}",
  "queue.item.runAsTask": "Ejecutar como tarea",
  "queue.item.runAsTaskLabel": "Ejecutar el mensaje en cola {position} como tarea",
  "queue.item.deleteLabel": "Eliminar mensaje en cola {position}",
  "queue.item.deleteTooltip": "Eliminar mensaje",
  "queue.item.editLabel": "Editar mensaje en cola {position}",
  "queue.item.editTooltip": "Editar mensaje",
  "queue.deleteHeld.title": "¿Eliminar mensaje en cola?",
  "queue.deleteHeld.body": "Otro dispositivo está editando este mensaje. El agente no lo recibirá.",
  "queue.deleteHeld.keep": "Conservar",
  "queue.stopAndClear.action": "Detener y vaciar la cola",
  "queue.stopAndClear.title": "¿Detener al agente y vaciar la cola?",
  "queue.stopAndClear.body": {
    one: "El agente deja lo que está haciendo y se cancela el mensaje en cola. Queda en el chat marcado como Cancelado.",
    other:
      "El agente deja lo que está haciendo y se cancelan {count} mensajes en cola. Quedan en el chat marcados como Cancelado.",
  },
  "queue.stopAndClear.confirm": "Detener y vaciar",
  "queue.stopAndClear.keep": "Seguir trabajando",
} as const satisfies PartialTranslation<typeof source>;
