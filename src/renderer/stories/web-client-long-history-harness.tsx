/*
 * The web client on a mock host with two long histories, for `scripts/timeline-flow-e2e.ts`:
 * #historia holds 330 messages and the DM with Chief 330 (or `?count=<n>`), of mixed heights (long
 * Spanish paragraphs with mention chips, lists, code blocks, tables), over several days, each read up
 * to 30 messages before the end. The scripts drive it through `globalThis.openbotFlow`: it grows the
 * reader's last message in #historia, as an edit does, streams a reply into the DM, posts new
 * messages to #historia and adds new messages to the DM, as host events do. `?progress=1` puts a run
 * of an agent's short progress lines in #historia (`historia-step-1` to `-7`, after message 40), and
 * `openbotFlow.postProgress` posts more of them live, for `scripts/workspace-progress-fold-e2e.ts`.
 */
import type { ChannelMessage, ConversationMessage } from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

/**
 * `?count=<n>` sets the length of both histories (the perf bench uses 300, 1,500 and 5,000). It
 * stays for the session, so a link that opens another route keeps it.
 */
function historyLength(): number {
  const asked = new URLSearchParams(location.search).get("count");
  try {
    if (asked) sessionStorage.setItem("openbot-flow-count", asked);
    const value = Number(asked ?? sessionStorage.getItem("openbot-flow-count"));
    return Number.isInteger(value) && value >= 40 ? value : 330;
  } catch {
    return Number(asked) >= 40 ? Number(asked) : 330;
  }
}
const COUNT = historyLength();
/** A run of an agent's progress lines after message 40, one a minute: `?progress=1`. */
const PROGRESS_RUN = new URLSearchParams(location.search).get("progress") === "1" ? 7 : 0;
const PROGRESS_AT = 40;
const READ_THROUGH = COUNT - 30;
const START = Date.parse("2026-11-10T07:00:00Z");

const PARAGRAPHS = [
  "Buenos días, he revisado la propuesta de la landing de la cena navideña y creo que hay que reducir el texto de la cabecera, porque en el móvil ocupa casi toda la pantalla.",
  "Lo único que falta es confirmar el precio final con @[Chief](agent:chief) y avisar a @[Research](agent:research) para que compare con las dos marcas que más venden en diciembre.",
  "He dejado los datos en la hoja compartida: ventas por semana, devoluciones y el margen de cada producto, con una nota en las filas que cambiaron desde ayer.",
  "Por cierto, el formulario de reservas sigue fallando cuando el cliente pone un teléfono con prefijo internacional; lo he reproducido tres veces seguidas.",
  "Si os parece bien, mañana a primera hora publico la versión nueva y dejo la anterior guardada por si hay que volver atrás.",
];

/** A message of 1 to 12 lines, a list, a code block or a table, by its index. */
function text(index: number): string {
  const parts: string[] = [];
  const paragraphs = 1 + (index % 4);
  for (let line = 0; line < paragraphs; line++) parts.push(PARAGRAPHS[(index + line) % PARAGRAPHS.length] ?? "");
  if (index % 7 === 3) parts.push(["- Revisar el precio", "- Cambiar la foto", "- Publicar el viernes"].join("\n"));
  if (index % 13 === 5)
    parts.push(["```ts", `export const pedido${index} = { id: ${index}, listo: true };`, "```"].join("\n"));
  if (index % 29 === 11)
    parts.push(
      [
        "| Producto | Precio | Ventas |",
        "| --- | --- | --- |",
        "| Turrón | 12 € | 340 |",
        "| Roscón | 18 € | 125 |",
      ].join("\n"),
    );
  if (index % 5 === 4) return `Mensaje ${index}: vale.`;
  return `Mensaje ${index}: ${parts.join("\n\n")}`;
}

/** Each message 47 minutes after the one before: a new day about every 30 messages. */
const createdAt = (index: number) => new Date(START + index * 47 * 60_000).toISOString();

const ana = { kind: "member" as const, id: "ana", name: "Ana" };
const you = { kind: "member" as const, id: WEB_PREVIEW_MEMBER_ID, name: "You" };
const chief = { kind: "agent" as const, id: "chief", name: "CSO - Director de Ventas" };

function channelMessages(): ChannelMessage[] {
  const messages = Array.from({ length: COUNT }, (_, index): ChannelMessage => {
    // The last message is the reader's, so the script can grow it with edits.
    const author = index === COUNT - 1 ? you : index % 3 === 0 ? chief : index % 3 === 1 ? ana : you;
    const id = index === COUNT - 1 ? "historia-grow" : `historia-${index}`;
    return {
      id,
      channelId: "historia",
      sequence: index + 1,
      author,
      taskId: null,
      superseded: false,
      message: {
        id: `${id}-c`,
        author: author.kind === "member" ? "user" : "assistant",
        text: text(index),
        createdAt: createdAt(index),
        status: "completed",
      },
    };
  });
  const steps = Array.from({ length: PROGRESS_RUN }, (_, step): ChannelMessage => {
    const id = `historia-step-${step + 1}`;
    return {
      id,
      channelId: "historia",
      sequence: 0,
      author: chief,
      taskId: null,
      superseded: false,
      message: {
        id: `${id}-c`,
        author: "assistant",
        text: `Paso ${step + 1}: revisé la tabla de precios ${step + 1}.`,
        createdAt: new Date(Date.parse(createdAt(PROGRESS_AT)) + (step + 1) * 60_000).toISOString(),
        status: "completed",
      },
    };
  });
  messages.splice(PROGRESS_AT + 1, 0, ...steps);
  return messages.map((message, index) => ({ ...message, sequence: index + 1 }));
}

function dmMessages(): ConversationMessage[] {
  return Array.from({ length: COUNT }, (_, index): ConversationMessage => {
    const user = index % 3 === 2;
    return {
      id: `dm-${index}`,
      turnId: `dm-turn-${Math.floor(index / 3)}`,
      author: user ? "user" : "assistant",
      source: user ? "user" : "assistant",
      text: text(index),
      createdAt: createdAt(index),
      status: "completed",
    };
  });
}

const nextTask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(null);
  });
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const base = seeds(WEB_PREVIEW_MEMBER_ID, { unread: true });
  const general = base[0]?.channel;
  if (!general) throw new Error("The workspace seeds have no #general.");
  const mock = createMockOpenBot({
    channels: [
      ...base,
      {
        channel: {
          ...general,
          id: "historia",
          name: "historia",
          topic: "Una historia larga",
          description: "",
          humanMemberIds: [WEB_PREVIEW_MEMBER_ID, "ana"],
        },
        messages: channelMessages(),
        // A sequence: the progress run comes before the unread messages.
        readThrough: READ_THROUGH + PROGRESS_RUN,
      },
    ],
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    conversationReads: {
      chief: { unreadCount: 0, firstUnreadMessageId: null, throughMessageId: `dm-${READ_THROUGH - 1}` },
    },
  });
  mock.updateConversationSnapshot("chief", (snapshot) => {
    snapshot.messages = dmMessages();
    snapshot.activeTurnId = null;
  });

  async function growChannel(steps: number): Promise<void> {
    let body = text(COUNT - 1);
    for (let index = 0; index < steps; index++) {
      body += `\n\n${PARAGRAPHS[index % PARAGRAPHS.length]}`;
      await mock.api.agent.channelCommand({
        type: "edit",
        operationId: crypto.randomUUID(),
        channelId: "historia",
        messageId: "historia-grow",
        text: body,
      });
      await wait(60);
    }
  }

  async function streamDm(tokens: number, marker: string): Promise<void> {
    const threadId = mock.readConversationSnapshot("chief").threadId ?? "thread-chief";
    const turnId = `flow-stream-${Date.now()}`;
    const messageId = `${turnId}-reply`;
    const at = new Date().toISOString();
    mock.emitAgentEvent({ type: "turn-started", agentId: "chief", threadId, turnId });
    await wait(50);
    let body = "";
    for (let index = 0; index < tokens; index++) {
      const delta = index === tokens - 1 ? marker : index % 30 === 29 ? "\n\n" : `palabra${index % 53} `;
      body += delta;
      mock.emitConversationDelta({ agentId: "chief", threadId, turnId, messageId, delta, createdAt: at });
      await nextTask();
      if (index % 20 === 0) await wait(16);
    }
    mock.updateConversationSnapshot("chief", (snapshot) => {
      snapshot.activeTurnId = null;
      snapshot.messages = [
        ...snapshot.messages,
        {
          id: messageId,
          turnId,
          author: "assistant",
          source: "assistant",
          text: body,
          createdAt: at,
          status: "completed",
        },
      ];
    });
    mock.emitAgentEvent({ type: "turn-completed", agentId: "chief", threadId, turnId, status: "completed" });
  }

  /** New messages in #historia, each from a host event, `gap` ms apart. */
  async function postChannel(count: number, gap: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      await mock.api.agent.channelCommand({
        type: "send",
        operationId: crypto.randomUUID(),
        channelId: "historia",
        text: `Nuevo ${index}: ${PARAGRAPHS[index % PARAGRAPHS.length]}`,
        recipientAgentId: null,
        replyToMessageId: null,
        attachmentDraftIds: [],
      });
      await wait(gap);
    }
  }

  /** New agent messages in the DM, each announced by the host's `conversation` event, `gap` ms apart. */
  async function postDm(count: number, gap: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      const id = `dm-new-${Date.now()}-${index}`;
      // The update sends the `conversation` event, which asks the client for a read.
      mock.updateConversationSnapshot("chief", (snapshot) => {
        snapshot.messages = [
          ...snapshot.messages,
          {
            id,
            turnId: `${id}-turn`,
            author: "assistant",
            source: "assistant",
            text: `Nuevo ${index}: ${PARAGRAPHS[index % PARAGRAPHS.length]}`,
            createdAt: new Date().toISOString(),
            status: "completed",
          },
        ];
      });
      await wait(gap);
    }
  }

  /** An agent's short progress lines in #historia, each from a host event, `gap` ms apart. */
  let posted = 0;
  async function postProgress(count: number, gap: number): Promise<void> {
    for (let index = 0; index < count; index++) {
      posted += 1;
      const id = `historia-live-${posted}`;
      const sequence = COUNT + PROGRESS_RUN + 1_000 + posted;
      mock.emitAgentEvent({
        type: "channel-message",
        channelId: "historia",
        revision: 1_000_000 + posted,
        message: {
          id,
          channelId: "historia",
          sequence,
          author: chief,
          taskId: null,
          superseded: false,
          message: {
            id: `${id}-c`,
            author: "assistant",
            text: `En vivo ${posted}: revisé otra tabla.`,
            createdAt: new Date().toISOString(),
            status: "completed",
          },
        },
      });
      await wait(gap);
    }
  }

  Object.assign(globalThis, { openbotFlow: { growChannel, streamDm, postChannel, postDm, postProgress } });
  return mockWebRuntimeFor(mock, events);
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
