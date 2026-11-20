import type { AgentMessage } from "@openbot/ui/data";

/*
 * A real-looking agent DM in Spanish, as the owner reads it on a phone: long paragraphs, inline code
 * that must wrap, a long path and a long link, a heading, lists, a wide table, a code block, a note
 * to two agents, a restart notice and the step trail of a turn. The phone stories of `Workspace/Agent
 * DM` draw it at 393 px to check wrapping, type size and that nothing scrolls the page sideways.
 */

function at(time: string): string {
  return `2026-11-20T${time}:00.000Z`;
}

export const SPANISH_DM_MESSAGES: AgentMessage[] = [
  {
    id: "es-user-1",
    author: "you",
    body: [
      'ok mira quiero retomar el trabajo de esto. Yo creo que va siendo hora de hacer la landing de cena navideña, bueno, ya la tenemos, es la de "la noche del 24", no?',
      "",
      "lo unico seria renombrar la landing para que use el nombre del curso, y bueno, finalizar lo de revisar las partes importantes. Por cierto, necesitamos reducir la cadena de comando, si yo te pido algo a ti se activan muchisimos agentes, quiero reducir eso, como recomendarias que hicieramos esas cosas? Aunque de momento, escribele, a quien toque",
    ].join("\n"),
    time: "20:56",
    createdAt: at("20:56"),
    kind: "text",
  },
  {
    id: "es-exchange",
    author: "agent",
    body: "Renombrad la landing `la-noche-del-24` al nombre del curso y no aviséis a nadie más.",
    time: "20:57",
    createdAt: at("20:57"),
    kind: "exchange",
    exchange: {
      direction: "outgoing",
      messageId: "es-exchange",
      senderAgentId: "chief",
      recipientAgentIds: ["research", "sales"],
      replyToMessageId: null,
      deliveries: [],
    },
    actionMarker: {
      kind: "agent-message",
      direction: "outgoing",
      sourceAgentId: "chief",
      targetDeliveries: [
        { agentId: "research", status: "completed" },
        { agentId: "sales", status: "completed" },
      ],
      status: "completed",
      timestamp: at("20:57"),
      messageId: "es-exchange",
      replyToMessageId: null,
      expectsReply: true,
    },
  },
  {
    id: "es-steps",
    author: "agent",
    body: "",
    time: "20:57",
    createdAt: at("20:57"),
    kind: "thinking",
    items: [
      "Leí el brief de la campaña de Navidad",
      "Busqué la landing en /srv/sites/la-noche-del-24/index.html",
      "Comparé la oferta iv7x7e4d con el curso V108528865Y",
      "Escribí al Líder de Producto y a Infra de Marketing",
    ],
  },
  {
    id: "es-agent-1",
    author: "agent",
    body: [
      "Sí, la landing de Cena Navideña es `la-noche-del-24`: usa la oferta `iv7x7e4d` y tu código `V108528865Y`, que son los del curso «Lúcete en tu Cena Navideña y de Año Nuevo».",
      "",
      "Escribí solo a dos agentes y les pedí que no avisen a nadie más: el Líder de Producto de Cena Navideña, que es el responsable, e Infra de Marketing, que es quien ejecuta.",
      "",
      "- **Renombrar:** que cambien el slug al nombre del curso (por ejemplo `lucete-en-tu-cena-navidena-y-de-ano-nuevo`) y dejen una redirección 301 desde la URL anterior.",
      "- **Revisar las partes importantes:** precio, fecha de cierre, botón de compra y el píxel de Meta.",
      "- **Los anuncios** siguen en 0 USD hasta que confirmes el presupuesto.",
      "",
      "### Cadena de mando",
      "",
      "Hoy, cuando me pides algo, despierto a los directores y cada uno despierta a su equipo. Te recomiendo tres cambios:",
      "",
      "1. Que yo escriba solo al responsable de cada proyecto, nunca a todo el departamento.",
      "2. Que los agentes de ejecución no reenvíen la tarea si ya tienen lo necesario para hacerla.",
      "3. Que las revisiones vayan a un único canal, #revisiones-navidad, en lugar de a cada DM.",
      "",
      "El borrador del cambio está en /home/delynith/agents/cso/notes/2026-11-20-cadena-de-mando-propuesta-final-v3.md y la vista previa en https://bots.delynith.com/app/general/artifacts/la-noche-del-24-preview?version=7&compare=6&highlight=precio",
    ].join("\n"),
    time: "20:57",
    createdAt: at("20:57"),
    kind: "text",
    reaction: "👍",
    reactionSummary: { emojis: ["👍", "🎄"], overflowCount: 1 },
  },
  {
    id: "es-agent-2",
    author: "agent",
    body: [
      "Estado de las landings de Navidad:",
      "",
      "| Landing | Curso | Oferta | Precio | Cierre | Responsable |",
      "| --- | --- | --- | ---: | --- | --- |",
      "| la-noche-del-24 | Lúcete en tu Cena Navideña | iv7x7e4d | 47 USD | 24/12 23:59 | Líder de Producto |",
      "| ano-nuevo-brillante | Brilla en Año Nuevo | k2p9w1zz | 37 USD | 31/12 23:59 | Infra de Marketing |",
      "",
      "Para comprobarlo tú mismo:",
      "",
      "```bash",
      "curl -sI https://lucete.delynith.com/la-noche-del-24 | grep -i '^location'",
      "```",
    ].join("\n"),
    time: "20:58",
    createdAt: at("20:58"),
    kind: "text",
  },
  {
    id: "es-notice",
    author: "agent",
    body: "",
    time: "21:04",
    createdAt: at("21:04"),
    kind: "action-marker",
    actionMarker: { kind: "system-notice", notice: "restart-resume", agentId: "chief", timestamp: at("21:04") },
  },
  {
    id: "es-agent-3",
    author: "agent",
    body: "Ya está: PUO-9 y PUO-17 están cerrados en Motion. Los anuncios siguen en 0 USD.",
    time: "21:05",
    createdAt: at("21:05"),
    kind: "text",
  },
];
