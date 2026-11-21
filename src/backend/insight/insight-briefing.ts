import { type InsightGoal, insightGoalPace } from "@openbot/contracts/ipc";

/** What the briefing says, gathered from stored data. Every list is short already. */
export interface BriefingFacts {
  scope: string;
  language: "es" | "en";
  /** The owner's local day, `YYYY-MM-DD`. */
  date: string;
  moved: {
    tasksDone: number;
    tasksFailed: number;
    ticketsCreated: number | null;
    ticketsClosed: number | null;
    landings: { title: string; url: string }[];
  };
  needsYou: { agent: string; what: string; link: string | null }[];
  /** The loop decisions (gates) that wait for the owner. */
  loopDecisions: { title: string; amountUsd: number | null }[];
  /** The notifications that quiet hours or focus held back since the owner was last active. */
  heldNotifications: number;
  money: {
    space: string;
    yesterday: { spend: string | null; revenue: string | null; sales: number | null; net: string | null };
    week: { spend: string | null; revenue: string | null; sales: number | null; net: string | null };
  }[];
  goals: { title: string; progress: string; pace: string; deadline: string | null }[];
  decisions: { agent: string; text: string; link: string }[];
  costs: { weekUsd: number; previousWeekUsd: number; idleUsd: number; top: { agent: string; usd: number }[] };
  alerts: string[];
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function moneyText(amounts: ReadonlyMap<string, number>): string | null {
  if (amounts.size === 0) return null;
  return [...amounts].map(([currency, amount]) => `${NUMBER.format(amount)} ${currency}`).join(" + ");
}

export function goalFact(goal: InsightGoal, now: number): BriefingFacts["goals"][number] {
  return {
    title: goal.title,
    progress: `${NUMBER.format(goal.current)} / ${NUMBER.format(goal.target)} ${goal.metric}`,
    pace: insightGoalPace(goal, now),
    deadline: goal.deadline,
  };
}

/**
 * The prompt of the cheap model. It gets the facts as JSON and writes the one message: a short
 * paragraph, then at most five list items. It must not invent anything or change a link.
 */
export function briefingPrompt(facts: BriefingFacts, owner: string): string {
  const language = facts.language === "es" ? "Spanish" : "English";
  return [
    `Write the morning briefing for ${owner}, who owns a team of AI agents (${facts.scope}). Write it in ${language}.`,
    "Use only the facts in the JSON below; never add a fact, a number or advice that is not there.",
    "Shape: one plain paragraph of at most 70 words with what matters most first (money in and out, what waits for the owner, goals that are behind), then at most 5 list items that start with '- ', one line each: the decisions and what waits for the owner, with their links.",
    "Keep every markdown link exactly as written. No headings, no bold, no tables, no emoji, no greeting beyond two words, no sign-off, no closing question.",
    "Leave out a part that has nothing in it. When nothing happened, say so in one sentence.",
    "Money is in the currency written; costs are API-equivalent US dollars of the agents' work, not plan charges.",
    "",
    "<facts>",
    JSON.stringify(facts),
    "</facts>",
  ].join("\n");
}

const WORDS = {
  es: {
    nothing: "Sin novedades desde ayer.",
    done: (done: number, failed: number) => `${done} tareas terminadas${failed ? `, ${failed} fallaron` : ""}`,
    tickets: (created: number, closed: number) => `${created} tickets nuevos y ${closed} cerrados`,
    landings: (count: number) => `${count} landing${count === 1 ? "" : "s"} publicada${count === 1 ? "" : "s"}`,
    money: (space: string, spend: string | null, revenue: string | null, sales: number | null) =>
      `${space} ayer: gasto ${spend ?? "0"}, ingresos ${revenue ?? "0"}${sales !== null ? ` (${sales} ventas)` : ""}`,
    needs: (count: number) => `${count} cosa${count === 1 ? "" : "s"} esperan por ti`,
    goal: (title: string, progress: string, pace: string) => `Meta ${title}: ${progress} (${PACE.es[pace] ?? pace})`,
    costs: (week: number, previous: number) =>
      `Costo de agentes esta semana: ${NUMBER.format(week)} USD (semana anterior ${NUMBER.format(previous)} USD)`,
    decision: (agent: string, text: string, link: string) => `${agent} decidió: ${text} ${link}`,
    waits: (agent: string, what: string, link: string | null) => `${agent} espera: ${what}${link ? ` ${link}` : ""}`,
  },
  en: {
    nothing: "Nothing new since yesterday.",
    done: (done: number, failed: number) => `${done} tasks done${failed ? `, ${failed} failed` : ""}`,
    tickets: (created: number, closed: number) => `${created} tickets opened and ${closed} closed`,
    landings: (count: number) => `${count} landing page${count === 1 ? "" : "s"} published`,
    money: (space: string, spend: string | null, revenue: string | null, sales: number | null) =>
      `${space} yesterday: spent ${spend ?? "0"}, earned ${revenue ?? "0"}${sales !== null ? ` (${sales} sales)` : ""}`,
    needs: (count: number) => `${count} thing${count === 1 ? "" : "s"} wait${count === 1 ? "s" : ""} for you`,
    goal: (title: string, progress: string, pace: string) => `Goal ${title}: ${progress} (${PACE.en[pace] ?? pace})`,
    costs: (week: number, previous: number) =>
      `Agent cost this week: ${NUMBER.format(week)} USD (week before ${NUMBER.format(previous)} USD)`,
    decision: (agent: string, text: string, link: string) => `${agent} decided: ${text} ${link}`,
    waits: (agent: string, what: string, link: string | null) => `${agent} waits: ${what}${link ? ` ${link}` : ""}`,
  },
} as const;

const PACE: Record<"es" | "en", Record<string, string>> = {
  es: { done: "cumplida", ahead: "adelantada", "on-track": "en camino", behind: "atrasada", unknown: "sin plazo" },
  en: { done: "done", ahead: "ahead", "on-track": "on track", behind: "behind", unknown: "no deadline" },
};

/** The briefing without a model: the same facts, in fixed sentences. Used when the model fails. */
export function plainBriefing(facts: BriefingFacts): string {
  const words = WORDS[facts.language];
  const sentences: string[] = [];
  const { moved } = facts;
  if (moved.tasksDone || moved.tasksFailed) sentences.push(words.done(moved.tasksDone, moved.tasksFailed));
  if (moved.ticketsCreated !== null && moved.ticketsClosed !== null && (moved.ticketsCreated || moved.ticketsClosed))
    sentences.push(words.tickets(moved.ticketsCreated, moved.ticketsClosed));
  if (moved.landings.length) sentences.push(words.landings(moved.landings.length));
  for (const space of facts.money)
    if (space.yesterday.spend || space.yesterday.revenue)
      sentences.push(words.money(space.space, space.yesterday.spend, space.yesterday.revenue, space.yesterday.sales));
  if (facts.needsYou.length + facts.loopDecisions.length)
    sentences.push(words.needs(facts.needsYou.length + facts.loopDecisions.length));
  for (const goal of facts.goals.slice(0, 2)) sentences.push(words.goal(goal.title, goal.progress, goal.pace));
  if (facts.costs.weekUsd > 0) sentences.push(words.costs(facts.costs.weekUsd, facts.costs.previousWeekUsd));
  const items = [
    ...facts.alerts.map((alert) => alert),
    ...facts.decisions.map((decision) => words.decision(decision.agent, decision.text, decision.link)),
    ...facts.needsYou.map((item) => words.waits(item.agent, item.what, item.link)),
    ...facts.loopDecisions.map((decision) => decision.title),
  ].slice(0, 5);
  const paragraph = sentences.length ? `${sentences.join(". ")}.` : words.nothing;
  return [paragraph, ...items.map((item) => `- ${item}`)].join("\n");
}

/**
 * The model's text, or null when it is not a briefing: empty, far too long, or with a link that the
 * facts did not have. The list is cut to five items.
 */
export function checkedBriefing(text: string, facts: BriefingFacts): string | null {
  const trimmed = text.trim();
  if (trimmed.length < 20 || trimmed.length > 2_500) return null;
  const allowed = new Set([
    ...facts.decisions.map((decision) => decision.link),
    ...facts.needsYou.flatMap((item) => (item.link ? [item.link] : [])),
    ...facts.moved.landings.map((landing) => landing.url),
  ]);
  const links = [...trimmed.matchAll(/\]\(([^)\s]+)\)/gu)].map((match) => match[1] ?? "");
  const known = (link: string) => [...allowed].some((value) => value.includes(link));
  if (!links.every(known)) return null;
  let items = 0;
  return trimmed
    .split("\n")
    .filter((line) => {
      if (!/^\s*[-*•]\s+/u.test(line)) return true;
      items += 1;
      return items <= 5;
    })
    .join("\n");
}
