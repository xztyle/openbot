import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve } from "node:path";
import {
  PORTFOLIO_LIMITS,
  type RealityClaim,
  type RealityReport,
  type RealitySettings,
} from "@openbot/contracts/portfolio";
import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import { createOpenBotLogger } from "@openbot/logging";
import { Effect, Schema } from "effect";
import { JsonStore } from "../agent-efficiency/json-store";
import { extractJsonObject } from "../structured-output";
import { RealitySummary, realityPrompt } from "./portfolio-prompts";

const logger = createOpenBotLogger("portfolio-reality");

export const REALITY_CHECK_FILE = "portfolio-reality-v1.json";
const DAY_MS = 86_400_000;
const CHECK_INTERVAL_MS = 30 * 60_000;
const REPORTS_KEPT = 50;
const URL_TIMEOUT_MS = 10_000;
/** The URLs and files that one report checks, so a chatty week does not make hundreds of requests. */
const URLS_CHECKED = 15;
const FILES_CHECKED = 15;

/** Words of an agent's message that claim something is done, live or sold. */
const CLAIM_WORDS =
  /\b(?:done|live|launched|published|deployed|shipped|finished|sold|sales?|ready|uploaded|listo|lista|publicad[oa]s?|lanzad[oa]|subid[oa]|terminad[oa]|hecho|vendid[oa]s?|ventas?|en vivo|desplegad[oa])\b/iu;
const SALE_WORDS = /\b(?:sold|sales?|vendid[oa]s?|ventas?|purchases?|compras?)\b/iu;
const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/giu;
/** A path that looks like a file an agent made, such as `/home/…/landing.html` or `Spaces/shop/report.pdf`. */
const FILE_PATTERN = /(?:^|[\s(`"'])((?:\/|~\/|Spaces\/|shared\/)[^\s`"'()<>]+\.[A-Za-z0-9]{1,6})/gu;

interface StoredReality {
  version: 1;
  settings: RealitySettings;
  reports: RealityReport[];
  /** The ISO week of each space's last automatic report. */
  weeks: Record<string, string>;
}

const EMPTY: StoredReality = {
  version: 1,
  settings: { enabled: true, weekday: 1, hour: 9 },
  reports: [],
  weeks: {},
};

function isReport(value: unknown): value is RealityReport {
  return (
    isDynamicRecord(value) &&
    isString(value.id) &&
    isString(value.spaceId) &&
    isString(value.at) &&
    isString(value.summary) &&
    Array.isArray(value.claims)
  );
}

function decodeStored(value: unknown): StoredReality | null {
  if (!isDynamicRecord(value) || value.version !== 1) return null;
  const settings = isDynamicRecord(value.settings) ? value.settings : {};
  const integer = (entry: unknown, min: number, max: number, fallback: number) =>
    typeof entry === "number" && Number.isInteger(entry) && entry >= min && entry <= max ? entry : fallback;
  return {
    version: 1,
    settings: {
      enabled: settings.enabled !== false,
      weekday: integer(settings.weekday, 0, 6, EMPTY.settings.weekday),
      hour: integer(settings.hour, 0, 23, EMPTY.settings.hour),
    },
    reports: Array.isArray(value.reports) ? value.reports.filter(isReport) : [],
    weeks: isDynamicRecord(value.weeks)
      ? Object.fromEntries(Object.entries(value.weeks).filter((entry): entry is [string, string] => isString(entry[1])))
      : {},
  };
}

function cut(text: string, max: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** A host name that must not be fetched from the server: itself or a private network. */
export function privateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./u.test(host) ||
    /^10\./u.test(host) ||
    /^192\.168\./u.test(host) ||
    /^169\.254\./u.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) ||
    /^(?:fc|fd|fe80)/u.test(host)
  );
}

/** The local weekday, hour and ISO week of `now` in `timeZone`. */
export function localWeek(now: Date, timeZone: string): { weekday: number; hour: number; week: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
  } catch {
    return localWeek(now, "UTC");
  }
  const part = (type: string) => Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day")));
  const weekday = date.getUTCDay();
  // ISO week: the Thursday of this week decides the year.
  const thursday = new Date(date.getTime() + (3 - ((weekday + 6) % 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * DAY_MS));
  return { weekday, hour: part("hour"), week: `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}` };
}

/** The URLs, files and sales that one agent message claims. */
export function messageClaims(text: string): { urls: string[]; files: string[]; sale: boolean } {
  if (!CLAIM_WORDS.test(text)) return { urls: [], files: [], sale: false };
  const urls = [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.,;:!?)]+$/u, ""));
  const files = [...text.matchAll(FILE_PATTERN)]
    .map((match) => (match[1] ?? "").replace(/[.,;:!?)]+$/u, ""))
    .filter((path) => path && !path.startsWith("//"));
  return { urls: [...new Set(urls)], files: [...new Set(files)], sale: SALE_WORDS.test(text) };
}

export interface RealityCheckHooks {
  path: string;
  spaces(): readonly { id: string; name: string }[];
  /** The agents of a space with their workspace folders. */
  agents(spaceId: string): readonly { id: string; name: string; workspacePath: string | null }[];
  /** The shared folder of a space. */
  sharedDirectory(spaceId: string): string | null;
  /** What the space's agents wrote in its channels since `since`. */
  agentMessages(spaceId: string, since: string): readonly { agentId: string; text: string; at: string }[];
  /** The Motion cards that the space's agents finished since `since`. */
  cardsDone(spaceId: string, since: string): readonly { key: string; title: string; agentIds: readonly string[] }[];
  /** The revenue and the sales of the space since `since`, from the money rows. */
  money(spaceId: string, since: string): Effect.Effect<{ revenue: number; sales: number }>;
  generate(prompt: string): Effect.Effect<string | null>;
  /** Sends the report to the owner. The channel that got it, or null. */
  deliver(spaceId: string, spaceName: string, text: string): string | null;
  timeZone(): string;
  running(): boolean;
  /** URL reachability, for tests. */
  fetch?(url: string): Promise<boolean>;
}

async function reachable(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const response = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(URL_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  };
  const status = await attempt("HEAD").catch(() => 0);
  if (status > 0 && status < 400) return true;
  // Some servers refuse HEAD; a GET says it for sure.
  const second = await attempt("GET").catch(() => 0);
  return second > 0 && second < 400;
}

/**
 * The weekly reality check of each space: what its agents said they did (cards done, links that are
 * "live", files that are "ready", "sales") against evidence that the host checks itself (the link
 * answers, the file exists, the money rows show sales). A cheap model writes a short honest report
 * from the checked facts, and the owner gets it. It never wakes an agent.
 */
export class RealityCheck {
  readonly #hooks: RealityCheckHooks;
  readonly #store: JsonStore<StoredReality>;
  #timer: ReturnType<typeof setInterval> | null = null;
  #busy = false;

  constructor(hooks: RealityCheckHooks) {
    this.#hooks = hooks;
    this.#store = new JsonStore(hooks.path, EMPTY, decodeStored);
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.#tick(), CHECK_INTERVAL_MS);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  readonly page = Effect.fn("RealityCheck.page")(function* (
    this: RealityCheck,
    input: { spaceId?: string; settings?: Partial<RealitySettings> },
  ) {
    const change = input.settings;
    if (change && Object.keys(change).length > 0)
      yield* this.#store.update((stored) => ({ ...stored, settings: { ...stored.settings, ...change } }));
    const stored = yield* this.#store.load();
    return {
      settings: stored.settings,
      reports: stored.reports.filter((report) => !input.spaceId || report.spaceId === input.spaceId).slice(0, 50),
    };
  });

  async #tick(): Promise<void> {
    if (this.#busy || !this.#hooks.running()) return;
    this.#busy = true;
    try {
      await Effect.runPromise(this.#weekly());
    } catch (cause) {
      logger.warn("The weekly reality check failed.", { cause });
    } finally {
      this.#busy = false;
    }
  }

  readonly #weekly = Effect.fn("RealityCheck.weekly")(function* (this: RealityCheck) {
    const stored = yield* this.#store.load();
    if (!stored.settings.enabled) return;
    const clock = localWeek(new Date(), this.#hooks.timeZone());
    if (clock.weekday !== stored.settings.weekday || clock.hour < stored.settings.hour) return;
    for (const space of this.#hooks.spaces()) {
      if (this.#store.current.weeks[space.id] === clock.week) continue;
      if (this.#hooks.agents(space.id).length === 0) continue;
      yield* this.#store.update((current) => ({ ...current, weeks: { ...current.weeks, [space.id]: clock.week } }));
      yield* this.run(space.id);
    }
  });

  /** Checks one space's last seven days now, keeps the report and sends it. Null for an unknown space. */
  readonly run = Effect.fn("RealityCheck.run")(function* (this: RealityCheck, spaceId: string) {
    const hooks = this.#hooks;
    const space = hooks.spaces().find((entry) => entry.id === spaceId);
    if (!space) return null;
    const since = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const agents = hooks.agents(spaceId);
    const name = (agentId: string | null) => agents.find((agent) => agent.id === agentId)?.name ?? null;
    const claims: RealityClaim[] = [];
    const urls = new Map<string, { text: string; agentId: string }>();
    const files = new Map<string, { text: string; agentId: string }>();
    let saleClaim: { text: string; agentId: string } | null = null;
    const messages = hooks.agentMessages(spaceId, since);
    for (const message of messages) {
      const found = messageClaims(message.text);
      for (const url of found.urls) if (!urls.has(url)) urls.set(url, { text: message.text, agentId: message.agentId });
      for (const file of found.files)
        if (!files.has(file)) files.set(file, { text: message.text, agentId: message.agentId });
      if (found.sale && !saleClaim) saleClaim = { text: message.text, agentId: message.agentId };
    }
    const check = hooks.fetch ?? reachable;
    for (const [url, source] of [...urls].slice(0, URLS_CHECKED)) {
      let evidence: RealityClaim["evidence"] = "unknown";
      let detail = "Not checked: the address is on a private network.";
      try {
        const parsed = new URL(url);
        if (!privateHost(parsed.hostname)) {
          const live = yield* Effect.promise(() => check(url).catch(() => false));
          evidence = live ? "found" : "missing";
          detail = live ? `${parsed.host} answers.` : `${parsed.host} does not answer or answers with an error.`;
        }
      } catch {
        detail = "Not a valid address.";
      }
      claims.push({
        kind: "url",
        text: cut(`${url} — ${source.text}`, 400),
        agentId: source.agentId,
        evidence,
        detail,
      });
    }
    const roots = [hooks.sharedDirectory(spaceId), ...agents.map((agent) => agent.workspacePath)].filter(
      (root): root is string => Boolean(root),
    );
    for (const [file, source] of [...files].slice(0, FILES_CHECKED)) {
      const located = locate(file, roots);
      let evidence: RealityClaim["evidence"] = "unknown";
      let detail = "Not checked: the path is outside the space and the agents' folders.";
      if (located) {
        const exists = yield* Effect.promise(() =>
          stat(located).then(
            (entry) => entry.isFile() || entry.isDirectory(),
            () => false,
          ),
        );
        evidence = exists ? "found" : "missing";
        detail = exists ? "The file exists." : "The file is not there.";
      }
      claims.push({
        kind: "file",
        text: cut(`${file} — ${source.text}`, 400),
        agentId: source.agentId,
        evidence,
        detail,
      });
    }
    const money = yield* hooks.money(spaceId, since);
    if (saleClaim)
      claims.push({
        kind: "sale",
        text: cut(saleClaim.text, 400),
        agentId: saleClaim.agentId,
        evidence: money.sales > 0 || money.revenue > 0 ? "found" : "missing",
        detail:
          money.sales > 0 || money.revenue > 0
            ? `${money.sales} sales and ${money.revenue.toFixed(2)} of revenue in the money rows.`
            : "The money rows show no sale this week.",
      });
    const cards = hooks.cardsDone(spaceId, since);
    for (const card of cards.slice(0, PORTFOLIO_LIMITS.claims - claims.length)) {
      // A done card is backed when its agent named it next to a link or a file that checked out.
      const mentions = messages.filter(
        (message) => card.agentIds.includes(message.agentId) && card.key && message.text.includes(card.key),
      );
      const backed = claims.some(
        (claim) =>
          claim.evidence === "found" &&
          (claim.kind === "url" || claim.kind === "file") &&
          mentions.some((message) => claim.text.includes(cut(message.text, 380).slice(0, 60))),
      );
      claims.push({
        kind: "card",
        text: cut(`${card.key} ${card.title}`, 400),
        agentId: card.agentIds[0] ?? null,
        evidence: backed ? "found" : mentions.length > 0 ? "unknown" : "missing",
        detail: backed
          ? "A link or a file that the agent named with the card checks out."
          : mentions.length > 0
            ? "The agent wrote about it, without a link or a file to check."
            : "Done on the board, with no link, file or report in the chats.",
      });
    }
    const flagged = claims.filter((claim) => claim.evidence === "missing").length;
    const facts = {
      claims: claims.map((claim) => ({
        kind: claim.kind,
        text: claim.text.slice(0, 200),
        evidence: claim.evidence,
        detail: claim.detail,
        agent: name(claim.agentId),
      })),
      revenue: Math.round(money.revenue * 100) / 100,
      sales: money.sales,
      cardsDone: cards.length,
    };
    const text = claims.length ? yield* hooks.generate(realityPrompt(space.name, facts)) : null;
    const written = text
      ? yield* Effect.try(() => extractJsonObject(text)).pipe(
          Effect.flatMap((json) => Schema.decodeUnknownEffect(RealitySummary)(json)),
          Effect.map((answer) => answer.summary),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const summary = written ?? plainSummary(facts, claims.length);
    const report: RealityReport = {
      id: randomUUID(),
      spaceId,
      at: new Date().toISOString(),
      summary: summary.slice(0, 2_000),
      claims: claims.slice(0, PORTFOLIO_LIMITS.claims),
      flagged,
      channelId: null,
    };
    report.channelId = hooks.deliver(spaceId, space.name, `${report.summary}`);
    yield* this.#store.update((stored) => ({ ...stored, reports: [report, ...stored.reports].slice(0, REPORTS_KEPT) }));
    return report;
  });
}

/** The plain report when the model gives none. */
function plainSummary(
  facts: {
    claims: readonly { evidence: string; text: string; agent: string | null }[];
    revenue: number;
    sales: number;
  },
  count: number,
): string {
  if (count === 0) return `No claim to check this week. Revenue ${facts.revenue.toFixed(2)}, ${facts.sales} sales.`;
  const backed = facts.claims.filter((claim) => claim.evidence === "found").length;
  const missing = facts.claims.filter((claim) => claim.evidence === "missing");
  return [
    `${backed} of ${count} claims have evidence.`,
    ...missing
      .slice(0, 10)
      .map((claim) => `- No evidence: ${claim.agent ? `${claim.agent}: ` : ""}${claim.text.slice(0, 140)}`),
    `Revenue ${facts.revenue.toFixed(2)}, ${facts.sales} sales.`,
  ].join("\n");
}

/** The path of a claimed file inside one of `roots`, or null when it would be outside all of them. */
export function locate(file: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const base = resolve(root);
    const candidate = isAbsolute(file)
      ? normalize(file)
      : resolve(base, file.replace(/^(?:shared|Spaces\/[^/]+)\//u, ""));
    const inside = relative(base, candidate);
    if (inside && !inside.startsWith("..") && !isAbsolute(inside)) return candidate;
  }
  return null;
}
