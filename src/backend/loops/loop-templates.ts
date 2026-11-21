import type { LoopDefinition, LoopTemplateSummary } from "@openbot/contracts/ipc";

export interface LoopTemplate {
  id: string;
  definition: LoopDefinition;
}

const ticket = (title: string, body: string) => ({ notifyOwner: true, ticket: { title, body } });

/**
 * The loops a space can start from. Each is only a starting point: the owner or an orchestrator edits
 * the stages, owners, gates and fields after the create. The affiliate loop keeps the process that the
 * Universidad Online team follows today (scout, validate, landing, paid test, measure, scale or kill,
 * with every paid step approved by the owner).
 */
export const LOOP_TEMPLATES: readonly LoopTemplate[] = [
  {
    id: "affiliate-growth",
    definition: {
      name: "Affiliate course growth loop",
      description:
        "Find a course to promote as an affiliate, check that it can sell, build its landing, test paid ads with a small approved budget, measure, then scale or kill it.",
      fields: [
        { key: "product_id", label: "Product ID", type: "text", card: true },
        { key: "offer_id", label: "Offer ID", type: "text" },
        { key: "landing_url", label: "Landing", type: "url" },
        { key: "ad_account", label: "Ad account", type: "text" },
        { key: "price_usd", label: "Price", type: "money" },
        { key: "commission_usd", label: "Commission", type: "money", card: true },
        { key: "budget_usd", label: "Approved budget", type: "money" },
        { key: "spend_usd", label: "Spend", type: "money", card: true },
        { key: "sales", label: "Sales", type: "number", card: true },
        { key: "roas", label: "ROAS", type: "number", card: true },
        { key: "cpa_usd", label: "Cost per sale", type: "money" },
      ],
      stages: [
        {
          id: "scout",
          name: "Scout",
          description: "Find the course, its affiliate link, price, commission and the producer's rules.",
          checklist: ["Affiliate link works", "Price and commission read", "Producer rules read"],
          slaDays: 3,
          onEnter: { notifyOwner: true },
        },
        {
          id: "validate",
          name: "Validate",
          description: "Is there demand, who buys, when, and what competitors run? Propose go or kill.",
          checklist: ["Demand and season checked", "Buyer persona written", "Competitor ads reviewed"],
          slaDays: 5,
          onEnter: ticket("Validate {item}", "Check demand, buyer persona and competitor ads for {item} ({loop})."),
        },
        {
          id: "landing",
          name: "Landing",
          description:
            "Offer, angles and the landing page. The owner selects the product and approves the affiliation.",
          gate: { kind: "decision", note: "Select this product and approve the affiliation." },
          checklist: ["Offer and angles written", "Landing published", "QA and compliance OK"],
          slaDays: 7,
          onEnter: ticket("Landing for {item}", "Write the offer and angles and build the landing of {item}."),
        },
        {
          id: "ads-test",
          name: "Ads test",
          description: "A small paid test. Nothing is spent before the owner approves the budget.",
          gate: {
            kind: "money",
            note: "Approve the test budget (product, amount, days, goal).",
            amountField: "budget_usd",
          },
          checklist: [
            "Facebook page, pixel and tracking ready",
            "Ads approved by QA and compliance",
            "Campaign launched",
          ],
          slaDays: 10,
          onEnter: ticket(
            "Ads test for {item}",
            "Launch the approved test for {item}. Never spend over the approved budget.",
          ),
        },
        {
          id: "measure",
          name: "Measure",
          description: "Read spend, clicks, sales and commission; propose scale or kill.",
          exitMetrics: [{ field: "sales", op: ">=", value: 1 }],
          slaDays: 7,
          onEnter: { notifyOwner: true },
          next: ["scale", "killed"],
        },
        {
          id: "scale",
          name: "Scale",
          description: "More budget on what works. Each budget step is approved by the owner.",
          gate: { kind: "money", note: "Approve the scale budget.", amountField: "budget_usd" },
          exitMetrics: [{ field: "roas", op: ">=", value: 1.2 }],
          onEnter: ticket("Scale {item}", "Scale {item} within the approved budget and report daily."),
          next: ["killed", "done"],
        },
        { id: "done", name: "Done", outcome: "won" },
        { id: "killed", name: "Killed", outcome: "killed" },
      ],
    },
  },
  {
    id: "content-pipeline",
    definition: {
      name: "Content pipeline",
      description: "Idea to script to edit to publish to measure, for clips and videos.",
      fields: [
        { key: "platform", label: "Platform", type: "text", card: true },
        { key: "source_url", label: "Source", type: "url" },
        { key: "video_url", label: "Published at", type: "url" },
        { key: "views", label: "Views", type: "number", card: true },
        { key: "likes", label: "Likes", type: "number" },
        { key: "watch_percent", label: "Watch time", type: "percent" },
      ],
      stages: [
        { id: "idea", name: "Idea", description: "A hook and why it can work.", slaDays: 2 },
        {
          id: "script",
          name: "Script",
          checklist: ["Hook in the first 2 seconds", "Rights of the source checked"],
          slaDays: 2,
          onEnter: { notifyOwner: true },
        },
        { id: "edit", name: "Edit", checklist: ["Captions", "Thumbnail"], slaDays: 2, onEnter: { notifyOwner: true } },
        {
          id: "publish",
          name: "Publish",
          gate: { kind: "publish", note: "Approve the video before it goes public." },
          checklist: ["Published", "Link saved"],
          slaDays: 1,
          onEnter: { notifyOwner: true },
        },
        { id: "measure", name: "Measure", description: "Read views and watch time after 48 hours.", slaDays: 3 },
        { id: "done", name: "Done", outcome: "done" },
        { id: "dropped", name: "Dropped", outcome: "killed" },
      ],
    },
  },
  {
    id: "sales-leads",
    definition: {
      name: "Leads",
      description: "Lead to contacted to qualified to won or lost.",
      fields: [
        { key: "company", label: "Company", type: "text", card: true },
        { key: "contact", label: "Contact", type: "text" },
        { key: "value_usd", label: "Value", type: "money", card: true },
        { key: "source", label: "Source", type: "text" },
      ],
      stages: [
        { id: "lead", name: "Lead", slaDays: 2, onEnter: { notifyOwner: true } },
        { id: "contacted", name: "Contacted", checklist: ["First message sent"], slaDays: 5 },
        { id: "qualified", name: "Qualified", checklist: ["Need, budget and date known"], slaDays: 10 },
        { id: "won", name: "Won", outcome: "won" },
        { id: "lost", name: "Lost", outcome: "lost" },
      ],
    },
  },
  {
    id: "customer-inbox",
    definition: {
      name: "Customer inbox",
      description:
        "Questions from buyers (mail, Hotmart, WhatsApp) answered by an agent. A question the agent cannot answer goes to the owner in Needs you.",
      fields: [
        { key: "channel", label: "Channel", type: "text", card: true },
        { key: "from", label: "From", type: "text", card: true },
        { key: "product", label: "Product", type: "text" },
        { key: "question", label: "Question", type: "text" },
        { key: "thread_url", label: "Thread", type: "url" },
      ],
      stages: [
        {
          id: "new",
          name: "New",
          description: "A question arrived. Answer it from the product facts, or escalate it.",
          slaDays: 1,
          onEnter: { notifyOwner: true },
        },
        { id: "answered", name: "Answered", description: "The agent replied; wait for the buyer.", slaDays: 3 },
        { id: "escalated", name: "With the owner", description: "The owner answers or decides.", slaDays: 2 },
        { id: "closed", name: "Closed", outcome: "done" },
      ],
    },
  },
];

export function loopTemplate(id: string): LoopTemplate | undefined {
  return LOOP_TEMPLATES.find((template) => template.id === id);
}

export const LOOP_TEMPLATE_SUMMARIES: LoopTemplateSummary[] = LOOP_TEMPLATES.map((template) => ({
  id: template.id,
  name: template.definition.name,
  description: template.definition.description ?? "",
  stageNames: template.definition.stages.map((stage) => stage.name),
}));
