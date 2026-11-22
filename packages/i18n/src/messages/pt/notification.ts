import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Precisa de uma resposta sua.",
  "notification.needsApproval": "Precisa da sua aprovação.",
  "notification.needsBrowserStep": "Precisa que você conclua uma etapa no navegador.",
  "notification.needsApprovalFor": "Precisa da sua aprovação: {action}",
  "notification.finished": "Terminou o trabalho.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Uma etapa aguarda sua aprovação.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "Um fluxo de trabalho tem um novo resultado.",
  "notification.failed": "Parou com um erro.",
  "notification.channelTitle": "{agent} em {channel}",
  "notification.teammateTitle": "{agent}: {teammate} precisa de você",
  "notification.channelMessage": "Enviou uma mensagem.",
  "notification.conversationTitle": "{author} em {conversation}",
  "notification.mentionedYou": "Mencionou você.",
  "notification.directMessage": "Enviou uma mensagem para você.",
  "notification.threadReply": "Respondeu em uma conversa que você segue.",
  "notification.newMessages": { one: "{count} nova mensagem.", other: "{count} novas mensagens." },
  "notification.usageLimit.title": "A conta {provider} atingiu o limite",
  "notification.usageLimit.body": {
    one: "{count} agente aguarda. O Atelier tentará de novo mais tarde.",
    other: "{count} agentes aguardam. O Atelier tentará de novo mais tarde.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agente aguarda. O limite é renovado {reset}.",
    other: "{count} agentes aguardam. O limite é renovado {reset}.",
  },
  "notification.test": "As notificações estão funcionando.",
  "notification.welcome": "O Atelier avisará aqui quando um agente precisar de você.",
  "notification.toast.region": "Notificações",
  "notification.toast.close": "Fechar notificação",
  "notification.digest.title": { one: "{count} atualização dos seus agentes", other: "{count} atualizações dos seus agentes" },
  "notification.digest.fromOne": "De {agent}.",
  "notification.digest.fromMany": { one: "De {agent} e mais {count}.", other: "De {agent} e mais {count}." },
} as const satisfies PartialTranslation<typeof source>;
