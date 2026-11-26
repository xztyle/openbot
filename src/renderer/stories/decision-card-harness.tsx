/*
 * The web client on a mock host, in Spanish, for `scripts/decision-card-phone-e2e.ts`. Chief's chat
 * ends with the owner decision card of 2026-11-26 (the Christmas campaign budget), whose agent call
 * ended before an answer. The script serves it at every address under `/app`, as the site does, and
 * reads the answers the card sends from the root element's `data-decision-answers`.
 */
import type { RespondToPromptInput } from "@openbot/contracts/ipc";
import {
  normalizeConversationUiBlock,
  OWNER_DECISION_BLOCK_PREFIX,
  OWNER_DECISION_FIELD,
  pastDecisionRequestId,
  UI_BLOCK_VERSION,
  uiBlockFallbackQuestions,
} from "@openbot/contracts/ui-blocks";
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

const BLOCK_ID = `${OWNER_DECISION_BLOCK_PREFIX}9a1d6c0e-1d1c-4bb0-9a43-1e7c1f3e0a25`;
const block = normalizeConversationUiBlock({
  version: UI_BLOCK_VERSION,
  blockId: BLOCK_ID,
  spec: {
    type: "confirm",
    title: "Campaña navideña del 1 al 23 de diciembre: ¿cuánto gastamos como máximo en total?",
    fields: [
      {
        label: "125 USD: 3/día y luego 7",
        value: "3 USD al día del 1 al 9 para calentar y 7 USD al día del 10 al 23.",
      },
      { label: "161 USD: 7/día siempre", value: "Mismo gasto diario los 23 días." },
      { label: "98 USD: unos 4,25/día", value: "No sube el total aprobado; cada día se anuncia con menos." },
      { label: OWNER_DECISION_FIELD.askedBy, value: "CSO - Director de Ventas" },
      { label: OWNER_DECISION_FIELD.amount, value: "125 USD" },
      {
        label: OWNER_DECISION_FIELD.link,
        value:
          "https://adsmanager.facebook.com/adsmanager/manage/ads?act=1666106438553775&business_id=1481729350719112&selected_campaign_ids=120254934512590249",
      },
      { label: OWNER_DECISION_FIELD.ticket, value: "COC-25" },
    ],
    preview:
      "Ya está puesta para empezar el 1 de diciembre y terminar el 23, en pausa y sin gasto.\n\n- Países: Colombia, México y Ecuador.\n\nElegir una opción no activa los anuncios: antes de encenderlos te pido el sí final.",
    actions: [
      { id: "option1", label: "125 USD: 3/día y luego 7", style: "primary" },
      { id: "option2", label: "161 USD: 7/día siempre" },
      { id: "option3", label: "98 USD: unos 4,25/día" },
      { id: "no", label: "No", style: "ghost" },
    ],
  },
  state: { status: "expired" },
});

/** The answers the page sent, for the script: on the root element, as JSON. */
const answers: RespondToPromptInput[] = [];

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({ channels: seeds(WEB_PREVIEW_MEMBER_ID), channelMemberId: WEB_PREVIEW_MEMBER_ID });
  if (block) {
    const turnId = "turn-christmas";
    const questions = uiBlockFallbackQuestions(block.spec);
    mock.updateConversationSnapshot("chief", (snapshot) => {
      snapshot.messages.push({
        id: `${turnId}:reply`,
        turnId,
        author: "assistant",
        source: "assistant",
        text: "Cambié el inicio de la campaña; ahora te pregunto por el presupuesto.",
        createdAt: new Date(Date.now() - 1_000).toISOString(),
        status: "completed",
      });
      snapshot.messages.push({
        id: `question-prompt:${turnId}:req-1`,
        turnId,
        author: "assistant",
        source: "assistant",
        text: "Question",
        createdAt: new Date().toISOString(),
        status: "completed",
        itemType: "question_prompt",
        questionPrompt: { requestId: "req-1", questions, resolution: { status: "expired" } },
        uiBlock: block,
      });
    });
  }
  // As the host does: the answer freezes the card with the chosen option.
  mock.onPromptResponse((input) => {
    answers.push(input);
    document.documentElement.dataset.decisionAnswers = JSON.stringify(answers);
    const chosen =
      block?.spec.type === "confirm"
        ? block.spec.actions.find((action) => action.label === input.answers.action?.[0])
        : undefined;
    if (!block || !chosen || input.requestId !== pastDecisionRequestId(BLOCK_ID)) return;
    mock.updateConversationSnapshot("chief", (snapshot) => {
      for (const message of snapshot.messages)
        if (message.uiBlock?.blockId === BLOCK_ID)
          message.uiBlock = {
            ...message.uiBlock,
            state: { status: "answered", response: { actionId: chosen.id }, outcome: chosen.label },
          };
    });
  });
  return mockWebRuntimeFor(mock, events);
};

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="es">
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
            language="es"
            onChangeLanguage={() => {}}
            appearance="dark"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
