import {
  CHAT_VISUAL_CONTEXT_LIMIT,
  CHAT_VISUAL_HTML_LIMIT,
  CHAT_VISUAL_MAX_HEIGHT,
  CHAT_VISUAL_MIN_HEIGHT,
  CHAT_VISUAL_TITLE_LIMIT,
} from "@openbot/contracts/chat-visual";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { type DynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { isUiBlockId, UI_BLOCK_LIMITS } from "@openbot/contracts/ui-blocks";
import { z } from "zod";
import { advertisedJsonSchema } from "./agent/advertised-json-schema";
import { interruptAgentToolSchema } from "./agent/agent-interrupt-tool";
import { CHANNEL_ADMIN_TOOL_DEFINITIONS } from "./agent/channel-admin-tools";
import { DATA_TOOL_DEFINITIONS } from "./agent/data-tools";
import { EVENT_CHECK_TOOL_DEFINITIONS } from "./agent/event-check-tools";
import { HISTORY_TOOL_DEFINITIONS } from "./agent/history-tools";
import { LOOP_TOOL_DEFINITIONS } from "./agent/loop-tools";
import { MAIL_TOOL_DEFINITIONS } from "./agent/mail-tools";
import { MCP_SERVER_TOOL_DEFINITIONS } from "./agent/mcp-tools";
import { MEMORY_RECALL_TOOL_DEFINITIONS } from "./agent/memory-tool-inputs";
import { ORDER_TOOL_DEFINITIONS, orderCardSchema } from "./agent/order-tools";
import {
  createAgentToolSchema,
  listModelsToolSchema,
  readAgentToolSchema,
  updateAgentsToolSchema,
  updateProfileToolSchema,
} from "./agent/profile-tools";
import { ROUTINE_NO_UPDATE_TOOL, ROUTINE_REPORT_FAILURE_TOOL } from "./agent/routine-quiet-runs";
import { captureScreenToolShape } from "./agent/screen-capture";
import {
  assignAgentSectionToolSchema,
  createSectionToolSchema,
  deleteSectionToolSchema,
  renameSectionToolSchema,
} from "./agent/sidebar-tools";
import { LOCAL_SKILL_TOOL_DEFINITIONS } from "./agent/skill-tools";
import { CREATE_WEBHOOK_ROUTINE_TOOL, UPDATE_WEBHOOK_ROUTINE_TOOL } from "./agent/webhook-routine-tool";
import { WIDE_RESEARCH_TOOL_DEFINITION } from "./agent/wide-research";
import { API_KEY_NAME_PATTERN } from "./agent-api-keys";
import { START_TASK_TOOL, startTaskToolSchema } from "./agent-tasks/agent-tasks";
import {
  AWAIT_EVENT_TOOL,
  awaitEventToolSchema,
  CLOSE_WAIT_TOOL,
  closeWaitToolSchema,
  LIST_WAITS_TOOL,
  listWaitsToolSchema,
} from "./agent-waits/agent-waits";
import { CHANNEL_TOOL_DEFINITIONS } from "./channel-tools";
import { MESSAGING_TOOL_DEFINITIONS } from "./messaging/messaging-tools";
import { ROUTINE_FLOW_TOOL_DEFINITIONS } from "./routine-flows/routine-flow-tools";
import {
  ROUTINE_INSTRUCTION_RULE,
  routineInstructionZodSchema,
  routineLimitPolicyZodSchema,
  routineMissedPolicyZodSchema,
  routineScheduleZodSchema,
  webhookEventTypeZodSchema,
  webhookFiltersZodSchema,
} from "./routine-tool-schema";

interface OpenBotToolDefinition {
  name: string;
  description: string;
  shape: z.ZodRawShape;
}

/** The page rules for `html_render` and `html_preview`. The names match the variables that `ChatVisual` sends. */
const VISUAL_PAGE_RULES = [
  "Write one self-contained HTML document with inline <style> and <script>. Remote http(s) files, such as a chart library from a CDN, load as they are; local file paths do not load.",
  "The page runs in a sandbox: it cannot use cookies, storage or pop-up windows. A click on an http(s) link opens the link in the user's browser.",
  "The frame has no border and sits on the chat background, as wide as the reply column (about 360px on phones). Leave html and body with no background, use a fluid width and no outer card or banner title: the page is part of your reply.",
  "Give charts fixed pixel heights. Let the content set the page height; do not use 100vh or height:100% on html or body. The frame cuts what is outside the page box, so highlight a box with its border, not an outline or an outer shadow.",
  "Atelier sets these CSS variables on :root from the app theme, which is dark on the desktop: --background (transparent), --foreground, --muted-foreground, --muted, --card, --card-foreground, --border, --accent, --destructive, --success, --chart-1 to --chart-6, --radius, --font-sans, --font-mono. The base style sets the body font and color from them.",
].join(" ");

/** What an `html_render` page can ask of the app. The names match `window.openbotPage` in the frame bootstrap. */
const VISUAL_PAGE_ACTIONS = [
  "For a choice, a form or a game, call openbotPage.sendMessage(text) from a click: Atelier puts the text in the user's message box, and the user sends it.",
  `openbotPage.setContext(text) from a click keeps the page state as a quote in the user's message box, so you read it with the next message; up to ${CHAT_VISUAL_CONTEXT_LIMIT} characters, and empty text removes it.`,
  "Atelier gives each page a full-screen button and opens a clicked image large, so do not build them. The mobile app runs page scripts but has no openbotPage, so check that window.openbotPage exists before you call it.",
].join(" ");

export const htmlRenderToolSchema = z.object({
  html: z.string().min(1).max(CHAT_VISUAL_HTML_LIMIT).describe("A complete, self-contained HTML document."),
  title: z.string().trim().min(1).max(CHAT_VISUAL_TITLE_LIMIT).describe("A short name for the page."),
  height: z
    .number()
    .int()
    .min(CHAT_VISUAL_MIN_HEIGHT)
    .max(CHAT_VISUAL_MAX_HEIGHT)
    .optional()
    .describe(
      `The highest frame height in CSS pixels, ${CHAT_VISUAL_MIN_HEIGHT}-${CHAT_VISUAL_MAX_HEIGHT}. Omit it to fit the whole page.`,
    ),
});

const CHAT_VISUAL_PREVIEW_MIN_WIDTH = 240;
const CHAT_VISUAL_PREVIEW_MAX_WIDTH = 1_600;
/** The width of the reply column in a desktop chat. */
export const CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH = 728;

export const htmlPreviewToolSchema = z.object({
  html: z.string().min(1).max(CHAT_VISUAL_HTML_LIMIT).describe("A complete, self-contained HTML document."),
  width: z
    .number()
    .int()
    .min(CHAT_VISUAL_PREVIEW_MIN_WIDTH)
    .max(CHAT_VISUAL_PREVIEW_MAX_WIDTH)
    .optional()
    .describe(
      `The page width in CSS pixels, ${CHAT_VISUAL_PREVIEW_MIN_WIDTH}-${CHAT_VISUAL_PREVIEW_MAX_WIDTH}. The default is ${CHAT_VISUAL_PREVIEW_DEFAULT_WIDTH}, the desktop reply column; use 360 to check a phone.`,
    ),
  appearance: z.enum(["dark", "light"]).optional().describe("The app theme to draw with. The default is dark."),
});

// `ask_ui` input. The limits are the contract's; `normalizeUiBlockSpec` then checks the rules a schema
// cannot say, such as unique ids and option labels. An id passes the same check as a stored block id.
const uiBlockIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9.:-][A-Za-z0-9_.:-]{0,63}$/)
  .refine(isUiBlockId, "Use another id: botId, recipientBotId, recipientBotIds and senderBotId are reserved.")
  .describe("Letters, digits and _ . : -, up to 64 characters, not starting with _.");
const uiTextSchema = (max: number) => z.string().min(1).max(max);
const uiLabelSchema = uiTextSchema(UI_BLOCK_LIMITS.label);
const uiActionSchema = z.strictObject({
  id: uiBlockIdSchema,
  label: uiLabelSchema,
  style: z.enum(["primary", "secondary", "ghost", "danger"]).optional().describe("The default is secondary."),
  confirm: z
    .boolean()
    .optional()
    .describe(
      "The desktop and web apps ask the user again before they send this action. An app that shows only the plain question does not.",
    ),
});
const uiOptionSchema = z.strictObject({ id: uiBlockIdSchema, label: uiLabelSchema });
const uiStringOptionsSchema = (max: number) => z.array(uiLabelSchema).min(1).max(max);
const uiFormFieldBase = { id: uiBlockIdSchema, required: z.boolean().optional() };
const uiFormTextField = (kind: "text" | "textarea") =>
  z.strictObject({
    ...uiFormFieldBase,
    kind: z.literal(kind),
    label: uiLabelSchema,
    placeholder: uiLabelSchema.optional(),
    value: z.string().max(UI_BLOCK_LIMITS.fieldValue).optional(),
    ...(kind === "text"
      ? {
          secret: z
            .boolean()
            .optional()
            .describe("A password or a key: the app hides it and does not store it. Do not give a value."),
        }
      : {}),
  });
const uiFormOptionsField = (kind: "select" | "segmented", max: number) =>
  z.strictObject({
    ...uiFormFieldBase,
    kind: z.literal(kind),
    label: uiLabelSchema.optional(),
    options: uiStringOptionsSchema(max),
    value: uiLabelSchema.optional().describe("One of options."),
  });

export const routineReportFailureToolSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1)
    .max(INPUT_LIMITS.routineFailureReason)
    .describe("Why the task could not be done, in one short sentence."),
});

/** `acknowledge_request`: the action ids of its plan card. */
export const ACKNOWLEDGE_REQUEST_ACTIONS = { start: "start", alternative: "alternative", cancel: "cancel" } as const;

export const acknowledgeRequestToolSchema = z.object({
  message: uiTextSchema(UI_BLOCK_LIMITS.title).describe(
    "One short sentence: you are on it, and what the work is. Such as: On it. This is my plan for the 502 on staging.",
  ),
  steps: z
    .array(
      z.strictObject({
        label: uiLabelSchema.describe("Such as First or Then."),
        step: uiTextSchema(UI_BLOCK_LIMITS.text).describe("What you will do, in one line."),
      }),
    )
    .min(1)
    .max(4),
  startLabel: uiLabelSchema.describe("The start button, such as Start."),
  cancelLabel: uiLabelSchema.describe("The cancel button, such as Cancel."),
  alternativeLabel: uiLabelSchema
    .optional()
    .describe("A smaller option that the user may prefer, such as Only find the cause."),
});

const privateQuestionSchema = z
  .boolean()
  .optional()
  .describe(
    "Only for work of a team channel: true keeps the question in your own chat with the person, for something private to them. Otherwise Atelier posts it in the team channel and you do not wait for the answer.",
  );

export const logDecisionToolSchema = z.strictObject({
  decision: z.string().trim().min(1).max(400).describe("What you decided, in one plain sentence."),
  why: z.string().trim().min(1).max(600).describe("Why this is the recommended path, in one or two sentences."),
  alternatives: z.string().trim().max(400).optional().describe("The options you rejected, in a few words each."),
});

export const spaceMemoryToolSchema = z.strictObject({
  action: z
    .enum(["remember", "recall", "forget", "decisions", "outcome"])
    .describe(
      "remember: save a fact about a customer, product or supplier of your space. recall: find what the space knows about a name or topic, with past decisions. forget: remove a wrong fact or a whole entity. decisions: the latest decisions of the space. outcome: record what came of a past decision.",
    ),
  type: z.enum(["customer", "product", "supplier", "other"]).optional().describe("For remember: what the entity is."),
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .optional()
    .describe("For remember: the name of the customer, product or supplier."),
  fact: z
    .string()
    .trim()
    .min(1)
    .max(400)
    .optional()
    .describe("For remember: one short fact, such as a preference, a price or a problem."),
  query: z.string().trim().min(1).max(200).optional().describe("For recall and decisions: names or words to look for."),
  entityId: z.string().trim().min(1).max(128).optional().describe("For forget: the entity id that recall gives."),
  factId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("For forget: one fact of the entity; without it the whole entity goes."),
  decisionId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe("For outcome: the decision id that decisions or recall gives."),
  outcome: z.string().trim().min(1).max(400).optional().describe("For outcome: what happened, in one sentence."),
});

export const goalsToolSchema = z.strictObject({
  action: z
    .enum(["list", "progress"])
    .describe("list: the goals of your space with their progress. progress: set a manual goal's current value."),
  goalId: z.string().trim().min(1).max(128).optional().describe("For progress: the goal id that list gives."),
  value: z.number().finite().optional().describe("For progress: the new current value, in the goal's metric."),
  note: z.string().trim().max(200).optional().describe("For progress: what moved it, in a few words."),
});

const cardText = (max: number) => z.string().trim().min(1).max(max);
const cardId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/)
  .describe("Letters, digits and _ . : -, up to 64 characters.");

export const postCardToolSchema = z.strictObject({
  action: z
    .enum(["post", "status", "close"])
    .optional()
    .describe(
      "post (the default): show a new card. status: read a card's answer. close: close a card you no longer need.",
    ),
  cardId: z.string().max(36).optional().describe("For status and close: the cardId that post gave."),
  card: z
    .strictObject({
      type: z
        .enum(["choice", "approve", "form", "table"])
        .describe(
          "choice: pick one option (or several with multiple). approve: approve or reject one thing. form: a few fields. table: rows of options with columns, such as ad variants, to approve or reject each row (mode approve-each) or to pick one (pick-one) or several (pick-many).",
        ),
      title: cardText(200).describe("The question, such as Approve these 5 ad variants?"),
      detail: z.string().trim().max(1_200).optional().describe("One or two lines of context."),
      options: z
        .array(z.strictObject({ id: cardId, label: cardText(80), detail: z.string().trim().max(200).optional() }))
        .min(2)
        .max(12)
        .optional()
        .describe("For choice."),
      multiple: z.boolean().optional().describe("For choice: several options may be picked."),
      approveLabel: z.string().trim().max(80).optional().describe("For approve: the approve button."),
      rejectLabel: z.string().trim().max(80).optional().describe("For approve: the reject button."),
      fields: z
        .array(
          z.strictObject({
            id: cardId,
            label: cardText(80),
            kind: z.enum(["text", "number", "select"]),
            options: z.array(cardText(80)).max(12).optional().describe("For select."),
            required: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(8)
        .optional()
        .describe("For form."),
      submitLabel: z.string().trim().max(80).optional().describe("For form: the submit button."),
      columns: z.array(cardText(80)).min(1).max(6).optional().describe("For table: the column names."),
      rows: z
        .array(
          z.strictObject({
            id: cardId,
            cells: z
              .array(z.union([z.string().max(200), z.number()]))
              .min(1)
              .max(6),
          }),
        )
        .min(1)
        .max(20)
        .optional()
        .describe("For table: one cell per column; the first cell names the row."),
      mode: z
        .enum(["approve-each", "pick-one", "pick-many"])
        .optional()
        .describe("For table. The default is approve-each."),
    })
    .optional()
    .describe("For post: the card."),
});

export const reportValidationToolSchema = z.strictObject({
  score: z.number().min(0).max(100).describe("0 to 100: how likely the business earns money soon with little spend."),
  verdict: z.enum(["go", "test", "stop"]).describe("go: build it. test: a small cheap test first. stop: do not build."),
  demand: z.string().trim().min(1).max(800).describe("Who pays and why, with the evidence you found."),
  competition: z.string().trim().min(1).max(800).describe("Who already sells this, and at what price."),
  risks: z.string().trim().min(1).max(800).describe("What can go wrong: legal, money, platform rules."),
  summary: z.string().trim().min(1).max(1_200).describe("Two or three sentences for the owner."),
});

/** `request_decision`: the action ids of its card besides the options (`option1`…`option3`). */
export const REQUEST_DECISION_ACTIONS = { change: "change", no: "no" } as const;

export const requestDecisionToolSchema = z.strictObject({
  title: uiTextSchema(UI_BLOCK_LIMITS.title).describe(
    "The decision in one short question, such as Launch the Black Friday ad set at 7 USD a day?",
  ),
  options: z
    .array(
      z.strictObject({
        label: uiLabelSchema.describe("The button, such as Approve, or Launch at 7 USD/day."),
        consequence: z.string().max(400).optional().describe("What happens if the person picks it, in one line."),
      }),
    )
    .min(1)
    .max(3)
    .describe("One option for a yes/no decision (its button approves), or up to three alternatives."),
  defaultOption: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("The option (1 to 3, or 4 for No) that Atelier picks when nobody answers in timeoutMinutes."),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60)
    .optional()
    .describe(
      "Wait at most this long, then take defaultOption. Without it the card waits for the answer. A timed-out answer never approves money or a go-live.",
    ),
  amount: z
    .strictObject({
      value: z.number().min(0),
      currency: z
        .string()
        .regex(/^[A-Za-z]{3}$/u)
        .optional(),
      platform: z.string().max(32).optional().describe("Such as meta, google, hotmart."),
      perDay: z.boolean().optional().describe("True when the amount is per day, as an ad budget."),
    })
    .optional(),
  previewUrl: z
    .string()
    .max(2_048)
    .regex(/^https?:\/\/\S+$/u)
    .optional()
    .describe("The staged preview the person checks before it goes live."),
  preview: z
    .string()
    .max(UI_BLOCK_LIMITS.preview)
    .optional()
    .describe("The text that goes out, such as the email body. Markdown."),
  goLive: z
    .enum(["landings", "ads", "emails"])
    .optional()
    .describe("Sandbox first: approving lets you publish this staged landing, ad or email for the policy's pass time."),
  ticket: z.string().max(64).optional().describe("The Motion ticket of the work, such as UO-123."),
  changeLabel: uiLabelSchema.optional().describe("The button that asks for changes. Default: Change…"),
  noLabel: uiLabelSchema.optional().describe("The button that says no. Default: No"),
});

export const askUiToolSchema = z.object({
  private: privateQuestionSchema,
  blockId: uiBlockIdSchema.optional().describe("Your id for this block. Atelier makes one when you omit it."),
  block: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("confirm"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      danger: z.boolean().optional().describe("Draw the block as dangerous; its primary button is held to press."),
      confirmHold: z.number().int().min(UI_BLOCK_LIMITS.holdMinMs).max(UI_BLOCK_LIMITS.holdMaxMs).optional(),
      fields: z
        .array(
          z.union([
            z.strictObject({ label: uiLabelSchema, value: z.string().max(UI_BLOCK_LIMITS.text) }),
            z.strictObject({
              label: uiLabelSchema,
              select: uiBlockIdSchema.describe("The key of the chosen option in values. Not action."),
              options: uiStringOptionsSchema(UI_BLOCK_LIMITS.selectOptions).describe("The first one is the default."),
            }),
          ]),
        )
        .max(UI_BLOCK_LIMITS.confirmFields)
        .optional(),
      preview: uiTextSchema(UI_BLOCK_LIMITS.preview).optional().describe("Markdown, such as the body of a letter."),
      actions: z.array(uiActionSchema).min(1).max(UI_BLOCK_LIMITS.actions),
    }),
    z.strictObject({
      type: z.literal("quick_replies"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title).optional(),
      options: z.array(uiOptionSchema).min(1).max(UI_BLOCK_LIMITS.quickReplies),
      allowText: z.boolean().optional().describe("Show a text box for a reply in the user's own words."),
    }),
    z.strictObject({
      type: z.literal("choice"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      multiple: z.boolean().optional(),
      options: z
        .array(
          z.strictObject({
            id: uiBlockIdSchema,
            label: uiLabelSchema,
            meta: uiTextSchema(UI_BLOCK_LIMITS.meta).optional(),
            selected: z.boolean().optional(),
          }),
        )
        .min(1)
        .max(UI_BLOCK_LIMITS.choiceOptions),
      submit: uiLabelSchema.optional().describe("The submit button label."),
    }),
    z.strictObject({
      type: z.literal("form"),
      title: uiTextSchema(UI_BLOCK_LIMITS.title),
      fields: z
        .array(
          z.discriminatedUnion("kind", [
            uiFormTextField("text"),
            uiFormTextField("textarea"),
            uiFormOptionsField("select", UI_BLOCK_LIMITS.selectOptions),
            uiFormOptionsField("segmented", UI_BLOCK_LIMITS.segmentedOptions),
            z.strictObject({
              ...uiFormFieldBase,
              kind: z.literal("date"),
              label: uiLabelSchema,
              value: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .describe("YYYY-MM-DD."),
            }),
          ]),
        )
        .min(1)
        .max(UI_BLOCK_LIMITS.formFields),
      submit: uiLabelSchema.optional().describe("The submit button label."),
    }),
  ]),
});

const apiKeyNameSchema = z
  .string()
  .regex(API_KEY_NAME_PATTERN)
  .describe("The environment variable name of the key, such as OPENAI_API_KEY: A-Z, 0-9 and _, up to 64 characters.");

const sharedApiKeySchema = z
  .boolean()
  .describe(
    "True: the key is shared, and every agent of this server reads it, such as a key the whole team uses. False or absent: only you read it.",
  );

export const requestApiKeyToolSchema = z.strictObject({
  name: apiKeyNameSchema,
  title: uiTextSchema(UI_BLOCK_LIMITS.title).describe(
    "What the key is for, in the user's language, such as OpenAI API key for the image script.",
  ),
  placeholder: uiLabelSchema.optional().describe("A hint for the field, such as sk-…. Never a real key."),
  submit: uiLabelSchema.optional().describe("The submit button label."),
  shared: sharedApiKeySchema.optional(),
});

export const removeApiKeyToolSchema = z.strictObject({ name: apiKeyNameSchema, shared: sharedApiKeySchema.optional() });

export const saveApiKeyToolSchema = z.strictObject({
  name: apiKeyNameSchema,
  file: z
    .string()
    .trim()
    .min(1)
    .max(4096)
    .describe(
      "The absolute path of a file in your workspace or the system temp folder that holds only the key, such as the output of a command that created it. Atelier moves it into the key store and deletes this file.",
    ),
  shared: sharedApiKeySchema.optional(),
});

export const holdForOwnerToolSchema = z.strictObject({
  kind: z
    .enum(["question", "approval", "takeover", "fyi"])
    .describe(
      "question: a choice or answer; approval: an action that waits for a yes; takeover: a step the owner does in a page (url); fyi: news that needs no answer.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "One line the owner reads in the list: the question, the action to approve, the step, or the news, with your default (“ok to launch at €20/day?”).",
    ),
  detail: z.string().trim().max(2000).optional().describe("What the owner needs to decide, in a few short lines."),
  options: z
    .array(z.string().trim().min(1).max(80))
    .max(4)
    .optional()
    .describe("Up to 4 answers for a question, as buttons. The owner can always write another answer."),
  url: z
    .string()
    .trim()
    .max(2048)
    .regex(/^https?:\/\//iu)
    .optional()
    .describe("The page for a takeover, or the thing to review."),
});

export const alertOwnerToolSchema = z.strictObject({
  category: z
    .enum(["money", "outage", "security"])
    .describe(
      "money: a loss or spend at stake; outage: a live site, app or ad account is down; security: a breach or a leaked key.",
    ),
  summary: z.string().trim().min(1).max(200).describe("One line: what happened and what you need from the owner."),
  amountUsd: z
    .number()
    .finite()
    .optional()
    .describe("For money: the amount at stake, in US dollars. Below the owner's limit it waits in quiet hours."),
});

export const sharePreviewToolSchema = z
  .strictObject({
    url: z
      .string()
      .trim()
      .max(2048)
      .regex(/^https?:\/\//iu)
      .optional()
      .describe("A public page you published or changed: Atelier draws it and shows a card with its picture."),
    paths: z
      .array(z.string().min(1).max(INPUT_LIMITS.path))
      .min(1)
      .max(8)
      .optional()
      .describe(
        "Local files in your workspace or Shared: images (shown as a grid), a CSV file (drawn as a chart with its first rows), or an HTML page (drawn as a picture).",
      ),
    caption: z.string().trim().min(1).max(300).describe("One line under the preview: what it is and what changed."),
    revision: z
      .string()
      .trim()
      .max(64)
      .optional()
      .describe("A version of the page, such as a deploy id. The same url and revision is drawn only once."),
  })
  .refine((value) => (value.url === undefined) !== (value.paths === undefined), {
    message: "Pass either url or paths.",
  });

/** Shared declarations for Codex, Grok, and Claude. Service handlers enforce execution rules. */
export const OPENBOT_TOOL_DEFINITIONS: readonly OpenBotToolDefinition[] = [
  ...EVENT_CHECK_TOOL_DEFINITIONS,
  ...CHANNEL_ADMIN_TOOL_DEFINITIONS,
  ...CHANNEL_TOOL_DEFINITIONS,
  ...MESSAGING_TOOL_DEFINITIONS,
  ...HISTORY_TOOL_DEFINITIONS,
  ...DATA_TOOL_DEFINITIONS,
  ...LOCAL_SKILL_TOOL_DEFINITIONS,
  ...ROUTINE_FLOW_TOOL_DEFINITIONS,
  ...LOOP_TOOL_DEFINITIONS,
  ...MAIL_TOOL_DEFINITIONS,
  ...MCP_SERVER_TOOL_DEFINITIONS,
  {
    name: "list_sites",
    description:
      "List the static sites of this Atelier server, with its site limit and the slots in use. Use this before retrying a hosting mutation.",
    shape: {},
  },
  {
    name: "publish_site",
    description:
      "Publish a new static site after the user explicitly asks to publish it. The source must be inside this agent's workspace or OpenBot Shared.",
    shape: {
      sourcePath: z.string().min(1).max(INPUT_LIMITS.path),
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      spaFallback: z.boolean().optional(),
    },
  },
  {
    name: "replace_site",
    description:
      "Replace an owned static site after the user explicitly asks to replace it. This keeps the URL and resets expiry to 30 days.",
    shape: {
      siteId: z.string().min(1).max(INPUT_LIMITS.identifier),
      sourcePath: z.string().min(1).max(INPUT_LIMITS.path),
      title: z.string().min(1).max(120),
      description: z.string().min(1).max(500),
      spaFallback: z.boolean().optional(),
    },
  },
  {
    name: "delete_site",
    description: "Delete an owned static site after the user explicitly asks to delete it.",
    shape: { siteId: z.string().min(1).max(INPUT_LIMITS.identifier) },
  },
  {
    name: "attach_files_to_response",
    description:
      "Attach existing local files to the current response for the user. Use this after creating screenshots, charts, diagrams, reports, ZIP archives, or other files that the user should receive. Atelier copies each file and shows image previews in the conversation.",
    shape: { paths: z.array(z.string().min(1).max(INPUT_LIMITS.path)).min(1).max(INPUT_LIMITS.attachments) },
  },
  {
    name: "share_preview",
    description:
      "Show the owner a deliverable instead of describing it: a page you published or updated (url), images, a CSV file as a chart, or an HTML page, as a preview card with your caption in this conversation. Use it whenever you deliver a landing page, a site, a design, images, a chart or a data file, then keep your text to what the card does not show. Each url and revision is drawn once. In a channel, each member who reads the channel sees it.",
    shape: sharePreviewToolSchema.shape,
  },
  {
    name: "html_preview",
    description: `Draw an HTML page out of view and get a screenshot, the content height and the console output. The user does not see it. Use it to check a page before you call html_render, and correct what the screenshot or the console shows. ${VISUAL_PAGE_RULES}`,
    shape: htmlPreviewToolSchema.shape,
  },
  {
    name: "html_render",
    description: `Show a finished HTML page (chart, table, diagram, collage, mockup) in this conversation, above your final text reply; call it before you write that reply. The user already sees the page, so the reply must not announce it or restate it: add only what the page does not say. In a channel, each member who reads the channel sees it. Atelier fits the frame to the page height. A height lower than the page caps the frame, and the rest scrolls in it. ${VISUAL_PAGE_RULES} ${VISUAL_PAGE_ACTIONS}`,
    shape: htmlRenderToolSchema.shape,
  },
  {
    name: "list_capture_sources",
    description:
      "List the displays and windows of this computer that capture_screen can capture: display ids, desktop bounds in points, scale factors, and window ids and titles.",
    shape: {},
  },
  {
    name: "capture_screen",
    description:
      "Capture one display, one window, or a region of one display of this computer, and get the image. The user approves each capture first, and sees the image in this conversation. In a channel, each member who reads the channel sees it. Call list_capture_sources first to get ids and bounds. A region uses desktop points.",
    shape: captureScreenToolShape,
  },
  {
    name: "list_sections",
    description:
      "List sidebar sections (folders), their stable ids, and agent assignments before choosing message recipients or grouping agents.",
    shape: {},
  },
  {
    name: "create_section",
    description:
      "Create a sidebar section (folder) to group existing agents. List sections first and reuse an existing matching section.",
    shape: createSectionToolSchema.shape,
  },
  {
    name: "rename_section",
    description: "Rename an existing custom sidebar section.",
    shape: renameSectionToolSchema.shape,
  },
  {
    name: "delete_section",
    description: "Delete a custom sidebar section without deleting its agents; its agents become ungrouped.",
    shape: deleteSectionToolSchema.shape,
  },
  {
    name: "assign_agent_section",
    description: "Move an existing agent into a sidebar section. Pass null for sectionId to ungroup it.",
    shape: assignAgentSectionToolSchema.shape,
  },
  {
    name: "list_agents",
    description:
      "List local Atelier agents with their name, title, description, background (true for a teammate hidden from the user's lists), reportsTo (the id of the agent's manager in the org chart, or null at the top level), and progress: status (working, queued, or ready), queuedMessages, turnStartedAt while working, lastActivityAt, and openWaits when it has open waits. Call it to find the teammate for work outside your remit: match the work to titles and descriptions. Atelier does not track which files an agent changed.",
    shape: {},
  },
  {
    name: "list_models",
    description:
      "List the models each provider offers for a new agent: id, name, reasoning efforts, and the default model that create_agent uses when you give only a provider. A provider that can hold more than one account also lists its accounts: id, label, and state, with the provider's own sign-in (id default) first. Read-only.",
    shape: listModelsToolSchema.shape,
  },
  {
    name: "interrupt_agent",
    description:
      "Stop another agent's current turn when that turn works on your message, and cancel your requests still queued for it. The agent receives a notice from you with the reason. You cannot stop work that the user, a routine, a channel, or another agent started. To give new work, call send_message after this tool.",
    shape: interruptAgentToolSchema.shape,
  },
  {
    name: "read_agent",
    description:
      "Read the setup of one local Atelier agent, or your own when you omit agentId: profile, provider, model, reasoning effort, account, backup models, the model it returns to after a usage limit or a provider error, access, Computer Use, notifications, auto-approve, installed skills, routines, and the MCP servers it gets. Read-only. Call it before you change another agent.",
    shape: readAgentToolSchema.shape,
  },
  {
    name: "create_agent",
    description:
      "Create a persistent local Atelier agent when the user asks for a new teammate. Choose its profile from the user's request and supply its first task. The new agent gets your provider, model, and reasoning effort. Set provider, model, or reasoningEffort only when the user asks for different ones; call list_models first. Use update_profile for an existing agent. After it exists, add skills with install_local_skill and routines with create_routine as needed. A new agent gets your own access and Computer Use limits. Set background to true for a helper the user does not talk to directly.",
    shape: createAgentToolSchema.shape,
  },
  {
    name: "update_profile",
    description:
      "Update a local Atelier agent’s name, title, instructions, avatar, provider, model, reasoning effort, account, backup models, access, Computer Use, notifications, background, or manager in the org chart (reportsToAgentId) from the user’s request. You can restrict access to workspace and turn Computer Use off; only the user can widen them again. For an uploaded or local image, use avatarPath. Prepare a PNG, JPEG, or WebP copy up to 512 KB with your available tools if needed. Call list_models before you change a model, an account, or the backup models. A new model applies from the agent's next turn. A provider or account change fails while the agent has a turn or queued messages; try again when it is ready. backupModels replaces the whole list. To give several agents the same settings, use update_agents.",
    shape: updateProfileToolSchema.shape,
  },
  {
    name: "update_agents",
    description:
      "Give several local Atelier agents the same provider, model, reasoning effort, access, Computer Use, or notifications setting in one call, from the user's request. Each agent gets the checks of update_profile and its own change, one after the other. A failure for one agent does not stop the others and does not undo the earlier changes. The result has updated and failed counts and, for each agent id, ok with its new settings or the error. A provider or model that list_models does not list fails the whole call. Tell the user which agents failed and why. You can restrict access to workspace and turn Computer Use off; only the user can widen them again. Call list_models before you change a model.",
    shape: updateAgentsToolSchema.shape,
  },
  {
    name: "start_new_chat",
    description:
      "Start a new chat for yourself when this chat is long and its earlier messages no longer matter, or when a routine asks for it. Each message then sends less context. Before you call it, keep what you need: use remember, or write notes to a file in your workspace. The user still sees the earlier messages; you do not. The new chat starts when this turn ends and your queue is empty. When a queued message runs in this chat first, the request ends; call it again if you still need it. It works only in your own chat, and only when the user allows it in your settings.",
    shape: {},
  },
  {
    name: "escalate_model",
    description:
      "Ask for a stronger model for your next turn when you are stuck: an attempt failed, the work is harder than it looked, or a plan needs more thought. It works only when your model policy is Automatic; your next turn then runs on the largest model, and later turns go back down by themselves. Say why in reason. Do not call it for routine work.",
    shape: { reason: z.string().min(1).max(300) },
  },
  {
    name: "set_team_sleep",
    description:
      'Put agents of your own team (the agents under you in the org chart) to sleep, or wake them, when the user asks, such as "put the Abogados team to sleep". A sleeping agent runs no routines or event checks and starts no turn, so it costs nothing; messages to it wait until it wakes. agentId names one agent under you; with team true it also covers every agent under that agent. You cannot put yourself to sleep. The result lists the agents that changed.',
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier),
      team: z.boolean().optional(),
      sleeping: z.boolean(),
    },
  },
  {
    name: "propose_playbook_update",
    description:
      "Propose a better version of a role playbook skill that you have (a skill that Atelier installed for your role, listed in Settings → Playbooks). Send the whole new SKILL.md in content, with its front matter, and say in note what changed and why. The owner approves or dismisses it; until then nothing changes. Use it when the work showed that the playbook is wrong or missing a rule.",
    shape: {
      slug: z.string().min(1).max(64),
      content: z.string().min(1).max(64_000),
      note: z.string().min(1).max(600),
    },
  },
  {
    name: "list_routines",
    description:
      "List routines for this agent, or for another local agent when agentId is provided. Use this before updating or deleting a routine. routines has the schedule routines; webhookRoutines has the webhook routines with their event type, filters and URL.",
    shape: { agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional() },
  },
  {
    name: "create_routine",
    description:
      "Create a scheduled routine for this agent, or for another local agent when agentId is provided. It is active by default. Without a timezone, it uses the timezone of the person whose message this turn answers, or the server timezone when that is unknown. Interval, advanced-every, and custom schedules must not run more often than every 3 minutes. For a one-time reminder or task, use a once schedule: it runs one time and then pauses the routine. When watching a folder for new files and no interval was requested, use a 15 minute interval and keep the folder path plus handling instructions in the routine instruction.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      name: z.string().min(1).max(INPUT_LIMITS.routineName),
      instruction: routineInstructionZodSchema,
      schedule: routineScheduleZodSchema.describe(
        "Routine schedule. Interval, advanced-every, and custom schedules must not run more often than every 3 minutes.",
      ),
      active: z.boolean().optional(),
      timezone: z.string().min(1).max(128).describe("IANA timezone such as Europe/Warsaw.").optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
      missedPolicy: routineMissedPolicyZodSchema.optional(),
      precheck: z
        .string()
        .max(2_000)
        .nullable()
        .optional()
        .describe(
          "A cheap shell check that runs in your workspace before each scheduled run, with a plain environment and 60 seconds: exit 1 means nothing to do, so the run is skipped and costs no turn; exit 0 starts the run with its output; another exit starts the run anyway. Use one for a routine that polls and is usually quiet, such as curl and jq on an API. null removes it.",
        ),
    },
  },
  {
    name: CREATE_WEBHOOK_ROUTINE_TOOL,
    description:
      "Create a routine that a signed HTTP request starts, for this agent or for another local agent when agentId is provided. Use it when the user wants work to start when something happens in another system. It works only in a turn that a person's message started, not in a routine run or for an agent's message. It is active by default. The result has the webhook URL and the request format. The signing secret is not in the result; the result says where the user gets it. Never ask the user for the secret. A null url means the URL is not ready yet; the Routines settings show it when it is.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      name: z.string().min(1).max(INPUT_LIMITS.routineName),
      instruction: z
        .string()
        .min(1)
        .max(INPUT_LIMITS.routineInstruction)
        .describe(
          `What to do with each request. Atelier adds the request body to the run as untrusted data. ${ROUTINE_INSTRUCTION_RULE}`,
        ),
      eventType: webhookEventTypeZodSchema.optional(),
      filters: webhookFiltersZodSchema.optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
    },
  },
  {
    name: UPDATE_WEBHOOK_ROUTINE_TOOL,
    description:
      "Change a webhook routine of this agent, or of another local agent when agentId is provided: its event type, filters, name, instruction, or pause and resume it. Get its routineId from webhookRoutines of list_routines. Fields you leave out keep their saved values; filters replaces the whole list, and an empty list removes all filters. The URL and the signing secret stay the same. It works only in a turn that a person's message started.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
      name: z.string().min(1).max(INPUT_LIMITS.routineName).optional(),
      instruction: z.string().min(1).max(INPUT_LIMITS.routineInstruction).optional(),
      eventType: webhookEventTypeZodSchema.optional(),
      filters: webhookFiltersZodSchema.optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
    },
  },
  {
    name: "update_routine",
    description:
      "Update, pause, or resume an existing routine for this agent, or for another local agent when agentId is provided. Fields you leave out keep their saved values. Replacement schedules must not run more often than every 3 minutes. A one-time routine that already ran resumes only with a new once schedule in the future. The result is the saved routine. For a webhook routine, use update_webhook_routine.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
      name: z.string().min(1).max(INPUT_LIMITS.routineName).optional(),
      instruction: routineInstructionZodSchema.optional(),
      schedule: routineScheduleZodSchema
        .describe("Routine schedule. Must not run more often than every 3 minutes.")
        .optional(),
      active: z.boolean().optional(),
      limitPolicy: routineLimitPolicyZodSchema.optional(),
      missedPolicy: routineMissedPolicyZodSchema.optional(),
      precheck: z
        .string()
        .max(2_000)
        .nullable()
        .optional()
        .describe(
          "A cheap shell check that runs in your workspace before each scheduled run, with a plain environment and 60 seconds: exit 1 means nothing to do, so the run is skipped and costs no turn; exit 0 starts the run with its output; another exit starts the run anyway. Use one for a routine that polls and is usually quiet, such as curl and jq on an API. null removes it.",
        ),
    },
  },
  {
    name: "delete_routine",
    description: "Delete an existing routine for this agent, or for another local agent when agentId is provided.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
    },
  },
  {
    name: "test_routine",
    description:
      "Queue one manual test run of an existing routine for this agent, or for another local agent when agentId is provided.",
    shape: {
      agentId: z.string().min(1).max(INPUT_LIMITS.identifier).optional(),
      routineId: z.string().min(1).max(INPUT_LIMITS.identifier),
    },
  },
  {
    name: ROUTINE_NO_UPDATE_TOOL,
    description:
      "Use only in a scheduled, script or webhook routine run, when the routine task gives nothing to report. Atelier then collapses your text answers of this run into the run in the chat and sends no notification; the run history still shows the run. Do not call it when you report anything. A requested reminder or message is a report. Write it in your final answer. Do not call this tool for it unless the notification conditions of the task say to send nothing. In a manual Test run, the user sees your answer.",
    shape: {},
  },
  {
    name: ROUTINE_REPORT_FAILURE_TOOL,
    description:
      "Use only in a routine run, when the routine task could not be done: for example a server, file or service it needs is not available. Atelier then ends the run as failed with your reason, and the run history shows it. Still give your answer as usual. Do not call it when the task was done, also when its result is bad news.",
    shape: routineReportFailureToolSchema.shape,
  },
  {
    name: AWAIT_EVENT_TOOL,
    description:
      "Open a wait when you cannot finish the current request in this turn because you wait for something outside it: a build, a deploy, a later check. Atelier shows the wait to the user until you close it. The next run of one of your routines wakes the wait, or a local script event that names its waitId. The run that wakes it repeats the request and your note. Give routineId to let only that routine wake it. After this call, tell the user what you wait for and end your turn.",
    shape: awaitEventToolSchema.shape,
  },
  {
    name: CLOSE_WAIT_TOOL,
    description:
      "Close an open wait when its request is done, or when it can no longer be done. Leave it open to wait for the next run again. Give agentId to close a finished wait of another local agent.",
    shape: closeWaitToolSchema.shape,
  },
  {
    name: LIST_WAITS_TOOL,
    description:
      "List your open waits, or another local agent's when you give agentId: waitId, note, openedAt, routineId (null: any of its routines wakes it), and wokenAt. Use it to find and close waits whose request is done. Read-only.",
    shape: listWaitsToolSchema.shape,
  },
  {
    name: START_TASK_TOOL,
    description:
      "Start a task: a separate conversation of yours that runs beside this chat, with its own context, progress and stop. Use it only for long, independent work that the user asked for and that need not block this chat. The brief is the task's first message: write everything the task needs, because it does not see this chat. The task result stays in the task; you do not receive it. Only your own chat can start a task.",
    shape: startTaskToolSchema.shape,
  },
  ...MEMORY_RECALL_TOOL_DEFINITIONS,
  {
    name: "remember",
    description:
      "Stage one short, durable memory for this agent. Use memoryId to correct or consolidate an existing memory. New entries are searchable unless inclusion is essential. Essential requests that do not fit stay searchable. At the storage limit, consolidate related entries or forget facts that are no longer true first; if the user lowered the limit below the saved count, keep all entries and report that the new one could not be saved. The change commits only if the current turn completes.",
    shape: {
      text: z.string().min(1).max(INPUT_LIMITS.agentMemoryText),
      memoryId: z.string().optional(),
      inclusion: z.enum(["essential", "searchable"]).optional(),
    },
  },
  {
    name: "forget_memory",
    description:
      "Stage deletion of one saved memory when the user asks you to forget it, or when it is stale or merged into another memory and you need room under the memory limit. The change commits only if the current turn completes.",
    shape: { memoryId: z.string().min(1) },
  },
  {
    name: "ask_user",
    description:
      "Ask the user 1–3 short questions and wait for structured answers. Use this instead of asking questions in a normal assistant message whenever clarification or a choice is needed.",
    shape: {
      questions: z
        .array(
          z.strictObject({
            id: z.string().max(INPUT_LIMITS.identifier).optional(),
            header: z.string().max(INPUT_LIMITS.promptHeader).optional(),
            question: z.string().min(1).max(INPUT_LIMITS.promptQuestion),
            isSecret: z
              .boolean()
              .optional()
              .describe(
                "Masks a private answer, such as a one-time code. Never use it for an API key or a token: use request_api_key, which keeps the key out of your context.",
              ),
            options: z
              .array(
                z.strictObject({
                  label: z.string().min(1).max(INPUT_LIMITS.promptOptionLabel),
                  description: z.string().max(INPUT_LIMITS.promptOptionDescription).optional(),
                }),
              )
              .max(INPUT_LIMITS.promptOptions)
              .optional(),
          }),
        )
        .min(1)
        .max(3),
      private: privateQuestionSchema,
    },
  },
  {
    name: "hold_for_owner",
    description:
      "Put a request for the owner that can wait in their “When you're back” list instead of asking now: a question, an approval, a step in a page (takeover) or an FYI. It does not wait: continue other work or end your turn. The owner sees the list when they come back, or at a time they chose, as one bundle; their answer comes to you later as a message from them. Use it for anything that is not urgent, and always while the owner is in quiet hours or focus. Ask with ask_user only when you cannot continue any work without the answer and it matters now.",
    shape: holdForOwnerToolSchema.shape,
  },
  {
    name: "alert_owner",
    description:
      "Push an urgent alert to the owner's phone, also in quiet hours and focus: money at stake at or over the owner's limit, an outage of a live site, app or ad account, or a security event. Anything else waits in quiet hours: hold it with hold_for_owner. One alert of each kind per 15 minutes. Then tell the owner the details in your answer.",
    shape: alertOwnerToolSchema.shape,
  },
  {
    name: "log_decision",
    description:
      "Record a decision in your space's decision log: what you decided, why, and what else was on the table. Use it for a decision that a person would normally have made, or one your teammates should know later. In a hands-off team channel, where nobody answers questions, the channel shows it too, and the people review the list of decisions made without them. Call it once per decision, then continue the work.",
    shape: logDecisionToolSchema.shape,
  },
  {
    name: "space_memory",
    description:
      "The shared memory of your space, which every agent of the space reads: its customers, products and suppliers with their facts, and its decision log. Remember a lasting fact about one of them here instead of in your own memory, so your teammates know it too. Recall before you work for a customer or on a product. Record what came of a decision with outcome.",
    shape: spaceMemoryToolSchema.shape,
  },
  {
    name: "post_card",
    description: [
      "Post a small card in this chat that the owner answers with taps: a choice, an approve or reject, a short form, or a table of options (such as 5 ad variants to approve or reject one by one).",
      "You do not wait: end your turn after you post it. The answer comes back to you later as a message that starts with Card answer, with the card id, and your work continues from there.",
      "Use it instead of a long question in words when taps make the answer easier. For spending money use request_decision, which also shows in Needs you.",
      'Write every label in the owner\'s language. The result is JSON {"status":"posted","cardId"}. status gives {"status":"open"|"answered"|"closed","answer"}.',
      'Example: {"card":{"type":"table","title":"Approve these ad variants?","columns":["Variant","Hook","Budget/day"],"rows":[{"id":"v1","cells":["A","Before Christmas…","5 USD"]},{"id":"v2","cells":["B","Your first cake…","5 USD"]}],"mode":"approve-each"}}.',
    ].join(" "),
    shape: postCardToolSchema.shape,
  },
  {
    name: "report_validation",
    description:
      "Report the result of the validation stage of a new business that you were asked to research: a score, a verdict and short notes. The owner sees it and decides whether the team starts building. Call it once, after the research.",
    shape: reportValidationToolSchema.shape,
  },
  {
    name: "goals",
    description:
      "Read the goals of your space (title, metric, target, deadline, current value, pace) or set the progress of a manual goal when your work moved it. Goals fed by Hotmart, Meta or Motion update by themselves each day.",
    shape: goalsToolSchema.shape,
  },
  {
    name: "acknowledge_request",
    description: [
      "Before a long task, show the user a short acknowledgement and your plan in one card, and wait for the answer.",
      "Call it first, before other tools, when the work takes more than about a minute: a fix, a build, research, or a change in many files.",
      "Do not call it for a quick answer, a question, a small change, a routine run, or work that the user already approved in this chat.",
      "The card has your start button, an optional alternative and a cancel button. When nobody answers in 10 s, Atelier presses start.",
      'The result is JSON {"status":"answered","actionId":…}: "start" means do the plan; "alternative" means do only the alternative; "cancel" means do not start and ask in one sentence what the user wants;',
      '"_text" with "text" means follow the user\'s words. {"status":"skipped"} or {"status":"expired"} means do not start; answer briefly.',
      "Write in the user's language. It works only when the user turned it on in your settings, and not in a Slack, Discord or Telegram chat. In a channel, each member who reads the channel sees it.",
    ].join(" "),
    shape: acknowledgeRequestToolSchema.shape,
  },
  {
    name: "request_decision",
    description: [
      "Ask the owner for a decision that only they can make: spend, a payment, a launch, a go-live, an email to customers, or a choice between options with consequences. The card shows in this chat and in Needs you, and the owner gets a push; they answer with one tap.",
      "Use it instead of a message such as I need you to decide, and instead of ask_ui for these decisions. Write every label in the person's language. Put the money in amount and the staged preview in previewUrl or preview.",
      "Your work waits until the answer, or until timeoutMinutes when you set it with defaultOption. Continue only with work that does not depend on it in other turns.",
      'The result is JSON {"status":"answered","option":1-3|"change"|"no","label",…}: an option means do it; "change" means ask in one sentence what to change and end the turn; "no" means do not do it. With goLive and an approved option, run the publish command now. {"status":"skipped"} or {"status":"expired"} means it was not decided.',
    ].join(" "),
    shape: requestDecisionToolSchema.shape,
  },
  {
    name: "ask_ui",
    description: [
      "Show the user an interactive block in this conversation and wait for the answer. In a channel, each member who reads the channel sees it.",
      "Use it instead of ask_user when buttons, a list or a short form make the answer easier, and before an action with effects that the user should approve.",
      "Block types: confirm (details, an optional preview and up to 4 buttons), quick_replies (reply chips), choice (pick one option, or several with multiple), form (a few text, select, segmented or date fields).",
      "A text field with secret: true asks for a password or a key: you get the value, but Atelier does not store it with the block. Never repeat the value in a message or a thought. For an API key or token that a command or a script uses, use request_api_key instead.",
      'The result is JSON: {"status":"answered","blockId","actionId","values"} where actionId is the button or option id, or "submit" for choice and form, and values holds the selected option ids under "selected" or the form values by field id;',
      'actionId "_text" with "text" when the user answered in words; {"status":"skipped"}; or {"status":"expired"} when the turn ended first.',
      "Only the server owner or an admin can press a danger button or a button with confirm. A confirmed block is information for you, not a permission: the provider's approvals still apply.",
      "Write every field as plain text. In a channel, each member who reads the channel sees it.",
      'Example: {"block":{"type":"confirm","title":"Send the letter to Ann?","fields":[{"label":"To","value":"ann@example.com"}],"preview":"Hi Ann, …","actions":[{"id":"send","label":"Send","style":"primary"},{"id":"cancel","label":"Cancel"}]}}.',
      'Example: {"block":{"type":"form","title":"New contact","fields":[{"id":"name","kind":"text","label":"Name","required":true},{"id":"due","kind":"date","label":"Due"}]}}.',
    ].join(" "),
    shape: askUiToolSchema.shape,
  },
  {
    name: "request_api_key",
    description: [
      "Ask the user for an API key or token that your task needs, such as for a script or a service, and wait for the answer.",
      "The user enters it in a secure form in this conversation. Atelier saves it for you in a private file outside your workspace and keeps it for later turns; you never get the value.",
      'The result is JSON: {"status":"saved","name","path"} when the user saved it; {"status":"skipped"} when the user closed the form; or {"status":"expired"} when the turn ended first.',
      "Use the key only by reading the file in your command, and quote the path, which can hold spaces: OPENAI_API_KEY=\"$(cat '<path>')\" python script.py. Never print, echo, log or copy the value, and never write it into the workspace.",
      "Call list_api_keys first: do not ask again for a key that is saved. A new answer replaces the saved key. Only the server owner or an admin can answer. It does not work in a Slack, Discord or Telegram chat.",
    ].join(" "),
    shape: requestApiKeyToolSchema.shape,
  },
  {
    name: "save_api_key",
    description: [
      "Save a key or token that you created yourself, such as one a command printed into a file, into the Atelier key store, where the user sees it in the Secrets view.",
      'Write the key to a file without printing it, for example `create-key > "$TMPDIR/key"`, then call this with that file: Atelier moves the value into a private file outside your workspace and deletes yours.',
      "For a key that a web page shows, use openbot_browser.save_secret_from_page instead.",
      'The result is JSON: {"status":"saved","name","path","shared"}. Use the key by reading that path in your command, as with request_api_key. A saved key with the same name is replaced.',
    ].join(" "),
    shape: saveApiKeyToolSchema.shape,
  },
  {
    name: "list_api_keys",
    description:
      "List the keys that you read: yours, and the shared keys of the server (shared: true), with the name and the file path of each. Your own key wins over a shared one with the same name. Values are never shown.",
    shape: {},
  },
  {
    name: "remove_api_key",
    description:
      "Delete one saved key: yours, or with shared true a shared key. Use it only when the user asks, or when the key was replaced in another way.",
    shape: removeApiKeyToolSchema.shape,
  },
  {
    name: "suggest_marketplace_app",
    description:
      "Show the user a card in this conversation for one Marketplace app that the task needs and that is not in your tools. The user connects it, opens its listing, or dismisses the card; nothing connects without the user. Keep your normal answer. Returns not_found and the known apps, with no card, when no Marketplace app has that slug.",
    shape: {
      app: z
        .string()
        .min(1)
        .max(63)
        .describe(
          "The plugin slug: its name in lower case with hyphens, such as notion or linear. Use github for GitHub.",
        ),
    },
  },
  {
    name: "react_to_user_message",
    description:
      "Add one emoji reaction to the current user message for an obvious positive or negative emotional moment, including wins, affection, gratitude, humor, sadness, disappointment, frustration, empathy, or strong approval. An emoji in the written answer does not count as a reaction. Skip neutral messages and never use the reaction instead of the normal answer.",
    shape: { emoji: z.string().min(1).max(64).describe("Exactly one complete Unicode emoji.") },
  },
  {
    name: "send_message",
    description:
      "Queue an asynchronous message and optional local files for one or more Atelier agents. Send it only to agents that must act or decide. When replying, pass the original message id as replyToMessageId. Never send acknowledgements or thanks.",
    shape: {
      // Optional in the schema so that a call with a guessed name, such as `message` or `to`, reaches
      // the tool, which reads the aliases and names what is missing. See `normalizeSendMessageArguments`.
      // One id as a string, and "true" or "false" for a boolean, also reach the tool, which reads them.
      recipientAgentIds: z
        .union([z.array(z.string()).min(1).max(32), z.string()])
        .describe('Required: the agent ids, such as ["agent-…"].')
        .optional(),
      text: z.string().min(1).max(100_000).describe("Required: the message.").optional(),
      to: z
        .union([z.string(), z.array(z.string()).max(32)])
        .describe("Same as recipientAgentIds.")
        .optional(),
      message: z.string().max(100_000).describe("Same as text.").optional(),
      summary: z
        .string()
        .max(240)
        .describe(
          'One short sentence, at most 25 words, that the people of your team channel see instead of the full text, in the first person, such as "Sent you the data plan: Alpaca SIP covers daily bars." or "Can you rerun the backtest with doubled costs?". Never a key, a token or a path.',
        )
        .optional(),
      paths: z.array(z.string()).max(10).optional(),
      replyToMessageId: z.string().nullable().optional(),
      expectsReply: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .describe(
          "True, the default, for a request, question, or task: Atelier sends the result back. False for your reply, or when you need no answer; it still wakes the recipient. False ends the exchange.",
        )
        .optional(),
      fyi: z
        .union([z.boolean(), z.enum(["true", "false"])])
        .describe(
          "True only for information nobody acts on now, such as a status update: it does not wake the recipient and joins its next turn. Never for an order or review request.",
        )
        .optional(),
      card: orderCardSchema
        .describe(
          "For a real order (work the one recipient must do): Atelier makes a Motion card for it, assigned to the recipient, and names it in the message, so the order is tracked and nudged when it stalls. Give criteria and a dedupeKey. A big order (estimateHours 4+, a budget, or planFirst) starts with a plan the recipient's manager approves.",
        )
        .optional(),
    },
  },
  ...ORDER_TOOL_DEFINITIONS,
  WIDE_RESEARCH_TOOL_DEFINITION,
];

/** What a `send_message` call must hold, as its error says. */
export const SEND_MESSAGE_USAGE =
  'send_message needs recipientAgentIds (an array of agent ids) and text (the message), such as {"recipientAgentIds":["agent-…"],"text":"Can you check the build?"}.';

/**
 * The arguments of a `send_message` call with the names that models guess most often: `message`,
 * `content` or `body` for `text`, and `to`, `recipients` or `recipientAgentId` (one id or several)
 * for `recipientAgentIds`. The canonical name wins when both are given.
 */
export function normalizeSendMessageArguments(args: DynamicRecord): DynamicRecord {
  const { to, recipients, recipientAgentId, message, content, body, ...rest } = args;
  const text = rest.text ?? message ?? content ?? body;
  const recipient = rest.recipientAgentIds ?? to ?? recipients ?? recipientAgentId;
  return {
    ...rest,
    ...(text === undefined ? {} : { text }),
    ...(recipient === undefined ? {} : { recipientAgentIds: recipientList(recipient) }),
    ...booleanText(rest, "expectsReply"),
    ...booleanText(rest, "fyi"),
  };
}

const recipientIdList = z.array(z.string());

/** One id or a JSON-encoded array such as `["agent-a"]` becomes an array. Any other value stays as it is. */
function recipientList<T>(value: T): T | string[] {
  if (!isString(value)) return value;
  const text = value.trim();
  if (text.startsWith("[")) {
    try {
      const parsed = recipientIdList.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON: one id.
    }
  }
  return [text];
}

function booleanText(args: DynamicRecord, key: string): DynamicRecord {
  const value = args[key];
  return value === "true" || value === "false" ? { [key]: value === "true" } : {};
}

export const OPENBOT_DYNAMIC_TOOLS = {
  type: "namespace",
  name: "openbot",
  description:
    "Attach files to the current response, keep structured data in the shared SQLite database, and work with persistent Atelier teammates.",
  tools: OPENBOT_TOOL_DEFINITIONS.map((definition) => ({
    type: "function" as const,
    name: definition.name,
    description: definition.description,
    inputSchema: advertisedJsonSchema(z.strictObject(definition.shape)),
  })),
} as const;
