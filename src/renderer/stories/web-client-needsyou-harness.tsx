/*
 * The web client on a mock host for `scripts/needs-you-ui-e2e.ts`. Chief asked Sales Outbound for
 * work; the reader wrote only to Chief lately, so Sales Outbound has no DM row. The script acts as the
 * host with `needs-you-harness` window events: `detail` "request" makes Sales Outbound ask the reader
 * to sign in on accounts.google.com in a browser tab (the takeover event, the escalation to Chief and
 * the host's attention list), and "resolve" ends it as the host does after an answer anywhere. The
 * page sets `data-needs-you-ready` on the root element once it takes events, and writes the number of
 * takeover answers it sent to `data-needs-you-answered`. "ticket-review" makes a Motion ticket whose
 * review the grader escalated. "ticket" makes a Motion ticket that asks the
 * reader for an approval wait on Sales Outbound; the page writes the messages it sent to an agent to
 * `data-needs-you-sent` and the ticket answers to `data-needs-you-ticket`. "money-approval" makes Sales
 * Outbound wait for the owner's OK of a Meta ads call, with the trust card that a real host sends: its
 * purpose, the fixed action line, the amount and the raw call; the page writes the answer to
 * `data-needs-you-approval`.
 */
import {
  type AgentAttentionItem,
  type AgentEvent,
  type BrowserTab,
  MOTION_TICKET_TURN,
  type RespondToBrowserTakeoverInput,
} from "@openbot/contracts/ipc";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_BROWSER_TABS } from "../src/preview/fixtures";
import { createMockOpenBot } from "../src/preview/mock-openbot";
import { mockWebRuntimeFor, WEB_PREVIEW_MEMBER_ID } from "../src/preview/mock-web-runtime";
import { seeds } from "./workspace/workspace-app-seeds";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

const SALES_TAB: BrowserTab = {
  id: "browser-tab-google",
  title: "Create a Google Account",
  url: "https://accounts.google.com/lifecycle/steps/signup/birthdaygender",
  loading: false,
  ownerThreadId: "thread-sales",
  ownerAgentId: "sales",
};

const REQUEST = {
  requestId: "takeover-google",
  agentId: "sales",
  threadId: "thread-sales",
  turnId: "turn-sales-google",
  tabId: SALES_TAB.id,
} as const;

const ITEM: AgentAttentionItem = {
  kind: "browser-takeover",
  requestId: REQUEST.requestId,
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: REQUEST.turnId,
  createdAt: new Date().toISOString(),
  summary: SALES_TAB.title,
  origin: "accounts.google.com",
};

const TICKET: AgentAttentionItem = {
  kind: "question",
  requestId: "motion:issue-man-5",
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: MOTION_TICKET_TURN,
  createdAt: new Date().toISOString(),
  summary: "MAN-5 · Approve affiliation: Christmas decorations",
  url: "https://motion.example.com/p/man-5",
  asks: "approval",
  reason: "Approve the affiliation to Christmas decorations before the 10th",
};

/** A ticket whose title asks nothing: the independent grader sent it back three times. */
const REVIEW_TICKET: AgentAttentionItem = {
  kind: "question",
  requestId: "motion:issue-coc-44",
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: MOTION_TICKET_TURN,
  createdAt: new Date().toISOString(),
  summary: "COC-44 · Meta ad library: which courses advertise",
  url: "https://motion.example.com/p/coc-44",
  asks: "review-escalated",
  reason: "Courses advertised with evidence; texts and days active of the longest ads",
  plain: {
    asks: "Do you accept the ad research as it is?",
    why: "It decides which courses we advertise first.",
    ifYes: "The team closes it and starts the ads plan.",
    ifNo: "The agent adds what is missing first.",
  },
  escalatedBy: "Lead",
  escalationReason: "The owner set the course list.",
};

/** The purpose that the agent wrote for the call, which the card shows first. */
const MONEY_PURPOSE = "Quiero aprobación para revisar los topes de la campaña y modificarlos si superan los 7 USD.";

/** A trust card as the host's gate writes it (`trust-tool-gate.ts`), in its English source text. */
const MONEY_APPROVAL = {
  requestId: "approval-meta-ads",
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: "turn-sales-meta",
  kind: "permissions",
  command: [
    `Purpose: ${MONEY_PURPOSE}`,
    "Action: Meta ads · meta-ads create-campaign",
    "Amount: 7 USD",
    "Technical details:",
    'meta-ads create-campaign: create-campaign --name "Prueba" --objective OUTCOME_SALES --daily-budget 7',
  ].join("\n"),
  cwd: null,
  reason: "Sales Outbound wants to launch or fund ads. The trust policy asks you first.",
  grantRoot: null,
  permissions: null,
} as const;

const MONEY_ITEM: AgentAttentionItem = {
  kind: "approval",
  requestId: MONEY_APPROVAL.requestId,
  agentId: MONEY_APPROVAL.agentId,
  threadId: MONEY_APPROVAL.threadId,
  turnId: MONEY_APPROVAL.turnId,
  createdAt: new Date().toISOString(),
};

/** A decision card of Sales Outbound that waits for the owner, as the host lists it: a decision, not a form. */
const DECISION_ITEM: AgentAttentionItem = {
  kind: "form",
  requestId: "decision-christmas",
  agentId: REQUEST.agentId,
  threadId: REQUEST.threadId,
  turnId: "turn-sales-decision",
  createdAt: new Date().toISOString(),
  summary: "Campaña navideña: ¿cuánto gastamos como máximo en total?",
  decision: true,
};

const CONDENSED_MESSAGE = "message-agent-2";
const CONDENSED_ORIGINAL =
  "I paused: the page is not made and the cap is not set.\n\nSo far I only read the account through the API.\n\nAlejandro signs in when the browser view works, so I do not ask again.\n\nI sent the CSO the result in three lines.";
const CONDENSED_TEXT =
  "Paused: no page and no cap yet. Alejandro signs in when the view works; the CSO has the result.";

const SECRET = { method: "otp", origin: "https://accounts.google.com", digits: 6 } as const;

const runtime: WebRuntimeFactory = (_accountId, events) => {
  const mock = createMockOpenBot({
    channels: seeds(WEB_PREVIEW_MEMBER_ID),
    channelMemberId: WEB_PREVIEW_MEMBER_ID,
    browserTabs: [...STORY_BROWSER_TABS, SALES_TAB],
  });
  const web = mockWebRuntimeFor(mock, events);
  const emit = (event: AgentEvent) => mock.emitAgentEvent(event);
  const answered: RespondToBrowserTakeoverInput[] = [];
  const secrets: string[] = [];
  const resolve = () => {
    emit({ type: "agent-input-escalations-changed", escalations: [] });
    emit({ type: "browser-takeover-resolved", requestId: REQUEST.requestId, agentId: REQUEST.agentId });
    emit({ type: "agent-attention-changed", items: [] });
  };
  const request = () => {
    // As the host: the escalation first, so the request finds its delegator, then the request.
    emit({
      type: "agent-input-escalations-changed",
      escalations: [{ kind: "browser-takeover", ...REQUEST, delegatorAgentIds: ["chief"] }],
    });
    emit({ type: "browser-takeover-requested", request: { ...REQUEST } });
    emit({ type: "agent-attention-changed", items: [ITEM] });
  };
  const secret = () => {
    // As the host for `submit_secret`: a 6-digit SMS code for the tab's site.
    emit({ type: "browser-takeover-requested", request: { ...REQUEST, secret: SECRET } });
    emit({ type: "agent-attention-changed", items: [{ ...ITEM, kind: "secret" }] });
  };
  // As the host when Chief answers and the reply condenser shortens the answer a moment later.
  const answer = (step: "original" | "condensed") =>
    mock.updateConversationSnapshot("chief", (snapshot) => {
      const message = snapshot.messages.find((candidate) => candidate.id === CONDENSED_MESSAGE);
      if (!message) return;
      if (step === "original") {
        message.text = CONDENSED_ORIGINAL;
        delete message.condensed;
      } else {
        message.text = CONDENSED_TEXT;
        message.condensed = { original: CONDENSED_ORIGINAL };
      }
    });
  window.addEventListener("needs-you-harness", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (detail === "answer") answer("original");
    if (detail === "condense") answer("condensed");
    if (detail === "request") request();
    if (detail === "secret") secret();
    if (detail === "resolve") resolve();
    if (detail === "ticket") emit({ type: "agent-attention-changed", items: [TICKET] });
    if (detail === "ticket-review") emit({ type: "agent-attention-changed", items: [REVIEW_TICKET] });
    if (detail === "money-approval") {
      emit({ type: "approval", approval: { ...MONEY_APPROVAL } });
      emit({ type: "agent-attention-changed", items: [MONEY_ITEM] });
    }
    // Everything at once, for the screenshots of Today and the list: a decision, a ticket, a payment, a code.
    if (detail === "everything") {
      emit({ type: "approval", approval: { ...MONEY_APPROVAL } });
      emit({ type: "browser-takeover-requested", request: { ...REQUEST, secret: SECRET } });
      emit({
        type: "agent-attention-changed",
        items: [DECISION_ITEM, TICKET, MONEY_ITEM, { ...ITEM, kind: "secret" }],
      });
    }
  });
  document.documentElement.dataset.needsYouReady = "";
  // The reader wrote to Chief only: the other agents have no DM row until one needs them.
  mock.api.agent.workspaceDmAgents = async () => ({
    agentIds: ["chief", "research", "sales"],
    recentAgentIds: ["chief"],
  });
  // `?stall`: Sales Outbound's turn runs and its event stream stalls while reads still work. The
  // secret request goes out on the stalled stream, so the page never gets it, and the requested
  // runtime snapshot never comes. Only a replaced connection starts a new stream, which brings it.
  const stalled = new URLSearchParams(location.search).has("stall");
  let replaced = 0;
  if (stalled)
    window.setTimeout(() => {
      document.documentElement.dataset.needsYouStalled = "";
    }, 0);
  return {
    ...web,
    ...(stalled
      ? {
          conversation: async (agentId: string, before?: string) => {
            const page = await web.conversation(agentId, before);
            return agentId === REQUEST.agentId ? { ...page, activeTurnId: REQUEST.turnId } : page;
          },
          requestRuntimeSnapshot: () => {
            document.documentElement.dataset.needsYouSnapshotRequests = String(
              Number(document.documentElement.dataset.needsYouSnapshotRequests ?? 0) + 1,
            );
          },
          replaceConnection: () => {
            replaced += 1;
            document.documentElement.dataset.needsYouReplaced = String(replaced);
            events.connection({ hostId: "preview-host", state: "online", message: null, resync: true });
            secret();
          },
        }
      : {}),
    // As the host: the reader's message to an agent, and the answer that takes a ticket off the list.
    send: async (...args: Parameters<typeof web.send>) => {
      const [agentId, text] = args;
      const root = document.documentElement;
      root.dataset.needsYouSent = [root.dataset.needsYouSent, `${agentId}: ${text}`].filter(Boolean).join("\n");
      return web.send(...args);
    },
    answer: async (input: Parameters<typeof web.answer>[0]) => {
      if (String(input.requestId) === TICKET.requestId || String(input.requestId) === REVIEW_TICKET.requestId) {
        document.documentElement.dataset.needsYouTicket = JSON.stringify(input.answers);
        emit({ type: "agent-attention-changed", items: [] });
        return;
      }
      return web.answer(input);
    },
    respondToBrowserSecret: async (input) => {
      secrets.push(input.decision === "submit" ? input.secret : input.decision);
      document.documentElement.dataset.needsYouSecrets = secrets.join(",");
      resolve();
    },
    respondToTakeover: async (input) => {
      answered.push(input);
      document.documentElement.dataset.needsYouAnswered = String(answered.length);
      resolve();
    },
    connect: async (...args: Parameters<typeof web.connect>) => {
      const capabilities = await web.connect(...args);
      return [...capabilities, "browser-control", "browser-view"];
    },
  };
};

/** `?appearance=light` draws the light theme, for the screenshots of both; the dark one is the default. */
const appearance = new URLSearchParams(window.location.search).get("appearance") === "light" ? "light" : "dark";
// The app sets the palette on the root element; the harness does the same for its screenshots.
document.documentElement.setAttribute("data-openbot-color-scheme", appearance);
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
            appearance={appearance}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
