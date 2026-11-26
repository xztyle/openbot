import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/status/agent";

export const messages = {
  "status.agent.claudeWriteOutside":
    "Scrittura di {path}, fuori dal workspace dell'agente, dalla cartella condivisa e dalle cartelle temporanee.",
  "status.agent.contextCleared": "Contesto cancellato. Da qui inizia una nuova chat.",
  "status.agent.modelSwitchedForLimit": "Limite di utilizzo raggiunto. Passato a {model}.",
  "status.agent.modelReturnedAfterLimit": "Limite di utilizzo terminato. Tornato a {model}.",
  "status.agent.modelSwitchedForError": "Errore del provider. Passato a {model}.",
  "status.agent.modelReturnedAfterError": "Tornato a {model} dopo l’errore del provider.",
  "status.agent.marketplaceSuggested": "Ha suggerito un'app del Marketplace: {app}.",
  "status.agent.channelMemberAdded": "{agent} ha aggiunto {member} al canale. Lo ha chiesto {person}.",
  "status.agent.channelMemberRemoved": "{agent} ha rimosso {member} dal canale. Lo ha chiesto {person}.",
  "status.agent.channelInstructionsChanged": "{agent} ha modificato le istruzioni del canale. Lo ha chiesto {person}.",
  "status.agent.channelRoutineCreated": "{agent} ha creato la routine {routine}. Lo ha chiesto {person}.",
  "status.agent.channelRoutineUpdated": "{agent} ha modificato la routine {routine}. Lo ha chiesto {person}.",
  "status.agent.channelRoutineDeleted": "{agent} ha eliminato la routine {routine}. Lo ha chiesto {person}.",
  "status.agent.screenCaptureScreen":
    "Acquisizione dello schermo principale e invio dell'immagine al modello dell'agente.",
  "status.agent.screenCaptureChannel":
    "L'immagine appare nel canale {channel} e ogni membro di questo server che legge il canale può vederla.",
  "status.agent.screenCaptureDisplay":
    "Acquisizione dello schermo {name} e invio dell'immagine al modello dell'agente.",
  "status.agent.screenCaptureWindow":
    "Acquisizione della finestra {name} e invio dell'immagine al modello dell'agente.",
  "status.agent.screenCaptureRegion":
    "Acquisizione dell'area dello schermo a {x}, {y}, {width} × {height} punti e invio dell'immagine al modello dell'agente.",
  "status.agent.screenCaptureProgress": "Richiesta di acquisizione dello schermo…",
  "status.agent.screenCaptureReviewing": "Analisi dell'acquisizione dello schermo…",
  "status.agent.memoriesSearching": "Ricerca nelle sue memorie…",
  "status.agent.memoriesSearched": {
    one: "Ha cercato nelle sue memorie: {count} trovata",
    other: "Ha cercato nelle sue memorie: {count} trovate",
  },
  "status.agent.memoriesUpdating": "Aggiornamento delle sue memorie…",
  "status.agent.skillUsing": "Uso della skill {name}…",
  "status.agent.skillReading": "Lettura di una skill…",
  "status.agent.memoryChanges": "Memorie: {saved} salvate, {updated} aggiornate, {forgotten} dimenticate.",
  "status.agent.moneyApprovalExpires": "Scade tra {hours} h se nessuno risponde, e l’azione non viene eseguita.",
  "status.agent.trustAskAfterUntrusted":
    "{agent} ha letto contenuti esterni (una pagina web, un’email o un webhook) in questo turno e il controllo di sicurezza non ha potuto approvare questo pagamento. Decidi tu.",
  "status.agent.mailFirstRecipient":
    "Prima email a {address}. Approvala per inviarla; le successive a questa persona non richiedono il tuo OK.",
  "status.agent.mailOwnerApprovesEverySend":
    "{from} vuole inviare questa email a {address}. Ogni email da questo indirizzo attende il tuo OK: non parte nulla senza la tua approvazione.",
} as const satisfies PartialTranslation<typeof source>;
