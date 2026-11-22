import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Chamadas auxiliares",
  "insight.costs.idle": "Trabalho sem resposta",
  "insight.costs.sortBy.idle": "Trabalho sem resposta",
  "insight.costs.sortBy.side": "Chamadas auxiliares",
  "insight.costs.note":
    "Preços de tabela da API do trabalho dos agentes, não as cobranças do seu plano. Chamadas auxiliares são as pequenas verificações em volta do trabalho: quem deve responder, resumos curtos e revisões de memória. Trabalho sem resposta: turnos que custaram algo e não deixaram mensagem (podem ter mudado arquivos ou tickets).",
  "insight.costs.line": "{turns} turnos · {tokens} tokens · auxiliares {side}",
  "insight.briefing.alertRule": "Me avise quando um agente gastar e nada vender",
  "insight.briefing.alertMinSpend": "Mais de (US$)",
  "insight.briefing.alertDays": "Por estes dias",
} as const satisfies PartialTranslation<typeof source>;
