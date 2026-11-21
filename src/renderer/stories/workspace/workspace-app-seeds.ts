import type { AttachmentSummary, Channel, ChannelMessage, ChannelTask } from "@openbot/contracts/ipc";
import type { MockChannelSeed, MockChannelWork } from "../../src/preview/mock-channels";

/** The sample workspace of the workspace stories: #general with a thread, a private channel of 2,000 messages, a DM. */
/** The member id the preview writes as. `seeds` sets it. */
let READER = "local";
const START = Date.parse("2026-10-27T09:00:00Z");

function channel(input: Partial<Channel> & Pick<Channel, "id" | "name">): Channel {
  return {
    title: "",
    instructions: "",
    members: [],
    leadAgentId: null,
    archived: false,
    revision: 1,
    createdAt: new Date(START - 86_400_000 * 3).toISOString(),
    kind: "channel",
    visibility: "public",
    humanMemberIds: [READER],
    createdBy: { kind: "member", id: READER },
    ...input,
  };
}

const sequences = new Map<string, number>();
let serial = 0;
function message(
  channelId: string,
  minutes: number,
  author: { kind: "member" | "agent"; id: string; name: string },
  text: string,
  extra: Partial<ChannelMessage> & { itemType?: string; turnId?: string } = {},
): ChannelMessage {
  const sequence = (sequences.get(channelId) ?? 0) + 1;
  sequences.set(channelId, sequence);
  serial += 1;
  const { itemType, turnId, ...rest } = extra;
  return {
    id: `${channelId}-m${serial}`,
    channelId,
    sequence,
    author,
    taskId: null,
    superseded: false,
    message: {
      id: `${channelId}-c${serial}`,
      author: author.kind === "member" ? "user" : "assistant",
      text,
      createdAt: new Date(START + minutes * 60_000).toISOString(),
      status: "completed",
      ...(itemType ? { itemType } : {}),
      ...(turnId ? { turnId } : {}),
    },
    ...rest,
  };
}

const ana = { kind: "member" as const, id: "ana", name: "Ana" };
const chief = { kind: "agent" as const, id: "chief", name: "Chief" };
const research = { kind: "agent" as const, id: "research", name: "Research" };

function runningTask(channelId: string, id: string, ownerAgentId: string, requestMessageId: string): ChannelTask {
  return {
    id,
    channelId,
    parentTaskId: null,
    rootTaskId: id,
    ownerAgentId,
    requestMessageId,
    instruction: "Answer the request.",
    attachmentDraftIds: [],
    expectedResult: "Complete the requested work and report the result.",
    sourceMessageIds: [requestMessageId],
    dependencies: [],
    resources: [],
    state: "running",
    revision: 1,
    assignmentCount: 1,
    error: null,
  };
}

/**
 * `reader` is the member id the preview writes as: `local` on the desktop, `preview` on the web.
 * `working`: Chief works on the checklist in #general, and Research works in the pricing thread,
 * which holds 30 progress replies and gets one more every 2 s until someone stops it.
 * `unread`: the reader read #general up to their own request, the last five lines of #cakemaker and
 * nothing of the DM with Ana, so Unreads, the sidebar and Activity have unread messages.
 */
/** A file of a message in the media seeds. The browser client has no `previewUrl`; the runtime reads the bytes. */
function file(id: string, name: string, mimeType: string, size: number): AttachmentSummary {
  const previewKind = mimeType.startsWith("image/")
    ? "image"
    : mimeType === "application/pdf"
      ? "pdf"
      : mimeType.startsWith("text/")
        ? "text"
        : "none";
  return { id, name, size, kind: previewKind === "image" ? "image" : "file", mimeType, previewKind, previewUrl: null };
}

/** The files of `media`: two ad mockups, a tall phone screen, a PDF and a CSV. */
export const MEDIA_FILES = {
  a1: file("media-a1", "maqueta-A1-pavo-al-horno.webp", "image/webp", 93_184),
  a3: file("media-a3", "maqueta-A3-que-cubre.png", "image/png", 104_448),
  phone: file("media-phone", "landing-mobile.png", "image/png", 2_310_000),
  brief: file("media-brief", "brief-campana.pdf", "application/pdf", 182_000),
  budget: file("media-budget", "presupuesto.csv", "text/csv", 1_200),
} as const;

/**
 * `reader` is the member id the preview writes as. `media`: #general also has a reply with two images,
 * one with a single tall image and one with a PDF and a CSV.
 */
export function seeds(
  reader = "local",
  options: { working?: boolean; unread?: boolean; media?: boolean } = {},
): MockChannelSeed[] {
  READER = reader;
  const you = { kind: "member" as const, id: READER, name: "You" };
  sequences.clear();
  serial = 0;
  const general = channel({
    id: "general",
    name: "general",
    topic: "Launch week: cakemaker v2 ships Friday",
    description: "Everything about the cakemaker launch.",
    members: [
      { agentId: "chief", answerMode: "always" },
      { agentId: "research", answerMode: "mention", focus: "market research" },
    ],
    humanMemberIds: [READER, "ana"],
  });
  const rootId = "general-root";
  const messages: ChannelMessage[] = [
    message("general", 0, ana, "Morning! Who looks at the pricing page today?"),
    message("general", 2, you, "I will. @[Chief](agent:chief) can you draft the launch checklist?"),
    message("general", 3, chief, "Reading the launch notes and the open issues.", {
      itemType: "commentary",
      turnId: "t1",
    }),
    message("general", 4, chief, "Checking the release branch for blockers.", { itemType: "commentary", turnId: "t1" }),
    message(
      "general",
      5,
      chief,
      "Here is the **launch checklist**:\n\n1. Freeze the release branch\n2. Run the bench\n3. Publish the site\n\nThe preview is live at https://cakemaker-web.delynith.com",
      {
        turnId: "t1",
        reactions: [
          {
            emoji: "🎉",
            actors: [
              { kind: "member", id: "ana" },
              { kind: "member", id: READER },
            ],
          },
        ],
      },
    ),
    {
      ...message("general", 40, ana, "Can @[Research](agent:research) compare our prices with the two main rivals?"),
      id: rootId,
      threadSummary: {
        replyCount: 2,
        lastReplyAt: new Date(START + 55 * 60_000).toISOString(),
        participantIds: ["research", READER],
      },
    },
    message("general", 41, you, "@channel standup in 5 minutes", { mentions: [{ kind: "channel" }] }),
    message("general", 60 * 26, ana, "Thanks all, the site looks great 🚀"),
  ];
  if (options.media) {
    const withFiles = (entry: ChannelMessage, attachments: AttachmentSummary[]): ChannelMessage => ({
      ...entry,
      message: { ...entry.message, attachments },
    });
    messages.push(
      withFiles(
        message("general", 60 * 26 + 2, chief, "Así se vería el anuncio en Facebook (las 2 imágenes de abajo)."),
        [MEDIA_FILES.a1, MEDIA_FILES.a3],
      ),
      withFiles(message("general", 60 * 26 + 3, research, "The landing page on a phone:"), [MEDIA_FILES.phone]),
      withFiles(message("general", 60 * 26 + 4, chief, "The brief and the budget:"), [
        MEDIA_FILES.brief,
        MEDIA_FILES.budget,
      ]),
    );
  }
  const replies: ChannelMessage[] = [
    message("general", 50, research, "Started: I compare the plans of both rivals.", { threadRootId: rootId }),
    message("general", 55, you, "Great, add the yearly prices too.", { threadRootId: rootId }),
  ];
  const work: MockChannelWork[] = [];
  if (options.working) {
    const request = replies[1];
    const checklist = messages[1];
    for (let index = 1; index <= 30; index += 1)
      replies.push(
        message("general", 55 + index, research, `Checked the plan table of rival ${index}.`, { threadRootId: rootId }),
      );
    const root = messages.find((entry) => entry.id === rootId);
    if (root?.threadSummary) root.threadSummary.replyCount = replies.length;
    if (checklist) work.push({ task: runningTask("general", "task-chief", "chief", checklist.id) });
    if (request)
      work.push({
        task: runningTask("general", "task-research", "research", request.id),
        threadRootId: rootId,
        replyEveryMs: 2_000,
      });
  }
  const cakemaker = channel({
    id: "cakemaker",
    name: "cakemaker",
    visibility: "private",
    members: [{ agentId: "chief", answerMode: "mention" }],
  });
  const many: ChannelMessage[] = Array.from({ length: 2_000 }, (_, index) =>
    message(
      "cakemaker",
      index * 3,
      index % 3 === 0 ? chief : index % 3 === 1 ? ana : you,
      `Build log line ${index + 1}`,
    ),
  );
  const dm = channel({
    id: "dm-ana",
    name: "dm-ana",
    kind: "dm",
    visibility: "private",
    humanMemberIds: [READER, "ana"],
  });
  const unread = (sequence: number | undefined) =>
    options.unread && sequence !== undefined ? { readThrough: sequence } : {};
  return [
    {
      channel: general,
      messages: [...messages, ...replies],
      ...(work.length ? { work } : {}),
      ...unread(messages[1]?.sequence),
    },
    { channel: cakemaker, messages: many, ...unread(many.length - 5) },
    { channel: channel({ id: "random", name: "random", humanMemberIds: ["ana"] }), messages: [] },
    { channel: dm, messages: [message("dm-ana", 70, ana, "Lunch at 12?")], ...unread(0) },
  ];
}

const sales = { kind: "agent" as const, id: "sales", name: "Sales Outbound" };

function task(id: string, ownerAgentId: string, requestMessageId: string, parentTaskId: string | null): ChannelTask {
  return {
    ...runningTask("nicho-cocina", id, ownerAgentId, requestMessageId),
    parentTaskId,
    rootTaskId: parentTaskId ?? id,
  };
}

/**
 * A team thread where the lead hands long Spanish tasks to three members, as #nicho-cocina showed
 * the owner walls of text: two handoffs stored before the one-line summaries (`Name: task`), one
 * with its summary, the long answer of a subtask, the lead's short answer to the person, and three
 * agents still at work in the thread.
 */
export function agentTalkSeeds(reader = "local"): MockChannelSeed[] {
  const base = seeds(reader);
  const you = { kind: "member" as const, id: READER, name: "Alejandro" };
  const members = [chief, research, sales].map((agent) => ({ agentId: agent.id }));
  const room = channel({
    id: "nicho-cocina",
    name: "nicho-cocina",
    topic: "PUO Cena Navideña: anuncios del 10 al 24 dic",
    members,
    leadAgentId: "chief",
    routing: "coordinator",
  });
  const rootId = "cocina-root";
  const root: ChannelMessage = {
    ...message("nicho-cocina", 0, you, "¿El anuncio será imagen o link directo a la página? Quiero lanzarlo el 10."),
    id: rootId,
    taskId: "cocina-task",
  };
  const handoff = (minutes: number, to: typeof research, text: string, taskId: string, extra = {}) => {
    const entry = message("nicho-cocina", minutes, chief, `${to.name}: ${text}`, {
      threadRootId: rootId,
      ...extra,
    });
    return { ...entry, taskId, message: { ...entry.message, author: "system" as const } };
  };
  const replies: ChannelMessage[] = [
    handoff(
      1,
      research,
      "Alejandro pregunta si el anuncio será imagen o link directo a la página. Necesito de ti, para responderle en un solo mensaje en el canal, un inventario corto y concreto (comenta en COC-19 y responde con channel_result, máx. 8 líneas): (1) qué piezas EXISTEN hoy (copys, hooks, guiones, imágenes, videos; IDs de los 11 con OK de Cumplimiento) y en qué estado (borrador/OK); (2) qué FALTA producir para lanzar el 10-dic (p. ej. imagen única 1080×1080/1350, carrusel, video corto 9:16) y quién lo produce; (3) derechos: las 4 fotos de la landing son CC BY con crédito visible; ¿se pueden usar en el anuncio y cómo ponemos el crédito? (4) tu recomendación de formato para una prueba con 98 USD. Plazo: sábado 21-nov. No publicas ni creas nada en Meta.",
      "cocina-task",
    ),
    handoff(
      2,
      sales,
      "Alejandro decidió anuncios del 10 al 24 dic con máx. 7 USD/día. Mi decisión como Líder de Producto: 10–23 dic = 14 días = 98 USD; el tope ACUMULADO de la cuenta Aprendivo Ads (spend_cap) debe quedar en 98 USD (sube a 105 solo si Alejandro responde en COC-34 «incluye el 24»; yo te aviso). Ya lo dice COC-34. Sigue con COC-35: tarjeta de toma de control para que Alejandro entre a Facebook, página «La Noche del 24» conectada, y el usuario de sistema con permisos de anunciante.",
      "cocina-task",
    ),
    {
      ...handoff(
        3,
        sales,
        "Prepara la estructura de la campaña en borrador: un conjunto de anuncios, público Chile 25-55 interesado en cocina y celebraciones, ubicación automática, objetivo tráfico a la landing con parámetros src/sck. Deja todo en borrador y adjunta capturas en COC-36. No publiques nada.",
        "cocina-task",
      ),
      agentNote: {
        to: [sales.id],
        summary: "¿Me dejas la campaña en borrador (tráfico a la landing, Chile 25-55) con capturas en COC-36?",
      },
    },
    {
      ...message(
        "nicho-cocina",
        6,
        research,
        "Inventario: existen 11 copys con OK de Cumplimiento (COC-12 a COC-22) y 4 fotos CC BY de la landing. Falta una imagen 1080×1350 y un carrusel de 3 piezas; los produce el Diseñador de Landing antes del sábado. Las fotos sirven con el crédito en el texto del anuncio. Recomiendo imagen única para la prueba de 98 USD: un carrusel solo si la imagen no rinde en 3 días.",
        { threadRootId: rootId },
      ),
      taskId: "cocina-research",
    },
    // The steps of the lead's turn: a channel shows them only in debug mode.
    message("nicho-cocina", 7, chief, "Leyendo el inventario en COC-19.", {
      threadRootId: rootId,
      itemType: "commentary",
      turnId: "cocina-turn",
    }),
    message("nicho-cocina", 8, chief, "Actualizando COC-34 con el formato.", {
      threadRootId: rootId,
      itemType: "commentary",
      turnId: "cocina-turn",
    }),
    message(
      "nicho-cocina",
      8,
      chief,
      "Será **imagen única** con link directo a la landing. La pieza está lista el sábado 21; te aviso para que la apruebes.",
      { threadRootId: rootId, turnId: "cocina-turn" },
    ),
  ];
  root.threadSummary = {
    replyCount: replies.filter((reply) => reply.message.itemType !== "commentary").length,
    lastReplyAt: replies.at(-1)?.message.createdAt ?? root.message.createdAt,
    participantIds: ["chief", "research", "sales"],
  };
  const work: MockChannelWork[] = [
    { task: task("cocina-task", "chief", rootId, null), threadRootId: rootId },
    { task: task("cocina-research", "research", rootId, "cocina-task"), threadRootId: rootId },
    { task: task("cocina-sales", "sales", rootId, "cocina-task"), threadRootId: rootId },
  ];
  // Ad mockups alone, and a short line with two of them: images never fold.
  const mockups = message("nicho-cocina", 12, research, "");
  mockups.message.attachments = [MEDIA_FILES.a1, MEDIA_FILES.a3, MEDIA_FILES.phone];
  const captioned = message("nicho-cocina", 13, research, "Las dos maquetas para revisar:");
  captioned.message.attachments = [MEDIA_FILES.a1, MEDIA_FILES.a3];
  // Subtask results for the person, not the lead: one stored before `audience`, which opens with the
  // person's name as the lead's brief calls them, and one that the agent marked for the people.
  const copyTask = {
    ...task("cocina-copy", "research", rootId, "cocina-task"),
    state: "completed" as const,
    instruction: "Tarea COC-41. Alejandro dijo el 20-nov: el copy es muy aburrido. Rehaz el copy de A1 y A3.",
  };
  const campaignTask = { ...task("cocina-campaign", "sales", rootId, "cocina-task"), state: "completed" as const };
  const copyResult: ChannelMessage = {
    ...message(
      "nicho-cocina",
      14,
      research,
      [
        "Alejandro, rehice el copy de A1 y A3: ya no arranca con la lista de temas sino con una escena o una decisión. Las maquetas nuevas van arriba; nada publicado, 0 USD.",
        "",
        "- **Hook A1:** «Tres pavos. Una sola mesa. Falta decidir cuál se sirve.»",
        "- **Hook A3:** «La cena de Navidad no se improvisa. Se ordena.»",
      ].join("\n"),
    ),
    taskId: copyTask.id,
  };
  const campaignResult: ChannelMessage = {
    ...message(
      "nicho-cocina",
      15,
      sales,
      "La campaña quedó en borrador con el tope de 98 USD. Entra a Facebook desde la tarjeta de COC-35 cuando puedas.",
    ),
    taskId: campaignTask.id,
    audience: "people",
  };
  // A long report to the people: it folds to its first lines, above the table.
  const report = message(
    "nicho-cocina",
    20,
    research,
    [
      "Resumen de la semana para la Cena Navideña. Los 11 copys tienen OK de Cumplimiento y las cuatro fotos de la landing se pueden usar con el crédito en el texto del anuncio.",
      "La imagen única de 1080×1350 está en revisión; el carrusel de tres piezas queda como plan B si la imagen no rinde en los primeros tres días.",
      "El presupuesto queda en 7 USD por día del 10 al 23 de diciembre, con el tope acumulado de 98 USD en la cuenta publicitaria.",
      "El copy de A1 y A3 ya no arranca con la lista de temas sino con una escena o una decisión, y Cumplimiento lo revisa en COC-39 antes del sábado. Ninguna pieza está publicada todavía y el gasto sigue en 0 USD; el Estratega deja el calendario de publicación en el dossier §5.15 para que lo apruebes junto con la imagen.",
      "",
      "| Pieza | Estado | Responsable |",
      "| --- | --- | --- |",
      "| Imagen 1080×1350 | En revisión | Diseñador de Landing |",
      "| Carrusel | Plan B | Diseñador de Landing |",
      "| Copys | Aprobados | Creativo de Anuncios |",
      "",
      "Pendiente de Alejandro: aprobar la imagen el sábado 21 y confirmar si el anuncio corre también el 24.",
    ].join("\n"),
  );
  work.push({ task: copyTask }, { task: campaignTask });
  return [
    { channel: room, messages: [root, ...replies, mockups, captioned, copyResult, campaignResult, report], work },
    ...base,
  ];
}
