// The four chat cards of `post_card` on fake answers, for `scripts/portfolio-cards-e2e.ts`. Each
// answer the page sends lands in the body's `data-card-answers`; `?answered` shows them frozen.
import { type ChatCard, type ChatCardAnswer, parseChatCardSpec } from "@openbot/contracts/portfolio";
import { ChatCardBlock } from "@openbot/ui/features/conversation/ui-blocks/ChatCardBlock";
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { StaticI18nProvider } from "../src/i18n-context";
import "../src/styles.css";

const made: string[] = [];
function record(cardId: string, answer: ChatCardAnswer): void {
  made.push(`${cardId}:${JSON.stringify(answer)}`);
  document.body.dataset.cardAnswers = made.join("\n");
}

const at = "2026-11-22T10:00:00.000Z";
const cards: ChatCard[] = [
  {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "ads",
    channelId: null,
    status: "open",
    createdAt: at,
    spec: parseChatCardSpec({
      type: "table",
      title: "Approve these ad variants?",
      detail: "Each runs at 5 USD a day for 3 days on the Christmas dinner course.",
      columns: ["Variant", "Hook", "Budget"],
      rows: [
        { id: "v1", cells: ["A", "Your Christmas dinner, done in 2 hours", "5 USD"] },
        { id: "v2", cells: ["B", "The 3 sauces chefs never tell you", "5 USD"] },
        { id: "v3", cells: ["C", "From zero to dinner host", "5 USD"] },
      ],
      mode: "approve-each",
    }),
  },
  {
    id: "00000000-0000-4000-8000-000000000002",
    agentId: "lead",
    channelId: null,
    status: "open",
    createdAt: at,
    spec: parseChatCardSpec({
      type: "choice",
      title: "Which course do we push next week?",
      options: [
        { id: "cakes", label: "Cake decorating", detail: "48 USD" },
        { id: "sauces", label: "French sauces", detail: "39 USD" },
      ],
    }),
  },
  {
    id: "00000000-0000-4000-8000-000000000003",
    agentId: "social",
    channelId: null,
    status: "open",
    createdAt: at,
    spec: parseChatCardSpec({
      type: "approve",
      title: "Publish Monday's post?",
      detail: "Three photos of the new lemon tart, with the price and the pickup hours.",
      approveLabel: "Publish",
      rejectLabel: "Not yet",
    }),
  },
  {
    id: "00000000-0000-4000-8000-000000000004",
    agentId: "manager",
    channelId: null,
    status: "open",
    createdAt: at,
    spec: parseChatCardSpec({
      type: "form",
      title: "Shop details",
      detail: "So the customer team answers right.",
      fields: [
        { id: "hours", label: "Opening hours", kind: "text", required: true },
        { id: "area", label: "Delivery area", kind: "select", options: ["City", "City and region"] },
      ],
    }),
  },
];

const answered = new URLSearchParams(location.search).has("answered");
const frozen: Record<string, ChatCardAnswer> = {
  "00000000-0000-4000-8000-000000000001": { rows: { v1: "approve", v2: "reject", v3: "approve" } },
  "00000000-0000-4000-8000-000000000002": { selected: ["sauces"] },
  "00000000-0000-4000-8000-000000000003": { approved: true },
  "00000000-0000-4000-8000-000000000004": { values: { hours: "9-18", area: "City" } },
};

function Card(props: { card: ChatCard }) {
  const [card, setCard] = createSignal<ChatCard>(
    answered
      ? {
          ...props.card,
          status: "answered",
          answer: frozen[props.card.id] ?? {},
          answeredBy: { id: "owner", name: "Owner" },
        }
      : props.card,
  );
  return (
    <ChatCardBlock
      card={card()}
      onAnswer={(answer) => {
        record(props.card.id, answer);
        setCard({ ...card(), status: "answered", answer, answeredBy: { id: "owner", name: "Owner" } });
      }}
    />
  );
}

function Page() {
  return (
    <div
      class="ws-message-content"
      style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px" }}
    >
      <For each={cards}>{(card) => <Card card={card} />}</For>
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <Page />
      </StaticI18nProvider>
    ),
    root,
  );
