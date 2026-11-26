import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { type DynamicRecord, isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { TrustAction, TrustAuditCategory, TrustSandbox } from "@openbot/contracts/trust-control";
import { redactText } from "@openbot/logging";

/**
 * What a tool call does that the trust policy governs. Null from every classifier means the call
 * is ordinary work: it runs with no check and no audit row.
 *
 * The classifiers read only the call itself (a shell command, an MCP tool name and its input, a
 * browser tool and the address of its tab). They are deliberately simple and match the helpers that
 * ship with Atelier (`meta-ads`, `hotmart`, `render-sites`, `appctl`) and the common HTTP APIs, so a
 * reader can predict them. They are a guard rail against mistakes, not a sandbox against an agent
 * that tries to hide what it does.
 *
 * Money is the one action that always needs the owner, so a shell command gets a second look for
 * `pay` and `launch_ads` (`expandCommand`): split strings are joined, base64 and hex payloads are
 * decoded, and a script that the command runs is read, so `echo … | base64 -d | sh`, `python3 -c`
 * with a built URL, or a script file written first do not walk around the rules. The real boundary is
 * a broker that holds the money credentials (docs/self-hosted-server.md, agent jail notes); this is not that.
 */
export interface TrustClassification {
  action: TrustAction;
  /** Such as `meta-ads set-budget` or `openbot_browser.fill_card`. */
  label: string;
  /** One line for the approval card and the audit log, secrets redacted. */
  summary: string;
  platform?: string;
  amount?: number;
  currency?: string;
  /** A public-facing change that sandbox first holds until an approved preview. */
  sandbox?: keyof TrustSandbox;
  /** Who approves a `delete` (`deletionTier`). Absent: the owner. */
  deletes?: DeletionTier;
  /**
   * A browser surface, such as `ads:meta`. One approval covers the agent's next actions on the same
   * surface for the policy's pass time, so a person approves a session, not each click.
   */
  surface?: string;
  /** How long the pass of `surface` lasts after an approval; absent: the policy's pass time. */
  passMinutes?: number;
  /**
   * A browser action on a payment or ads page: the site and what the call does, such as
   * `pay.hotmart.com` and `click "Comprar"`. The approval card says this instead of an amount.
   */
  browser?: { site: string; what: string };
}

const SUMMARY_LIMIT = 300;

/**
 * Who approves a deletion (docs/approvals.md, "Deletions"). `owner`: an agent, a channel, a space, a
 * live site, app or database, an account connection or its credentials. `manager`: a routine, a skill
 * or a shared table. `automatic`: every other deletion, such as tickets, messages, workspace files,
 * branches, drafts and memories.
 */
export type DeletionTier = "automatic" | "manager" | "owner";

/** Words of a deletion target that only the owner approves. */
const OWNER_DELETION_TARGET =
  /^(agents?|channels?|spaces?|sites?|websites?|apps?|applications?|databases?|dbs?|connections?|connectors?|integrations?|accounts?|credentials?|secrets?|tokens?|apikeys?|keys?|vault|logins?|passwords?)$/u;
/** Words of a deletion target that the asking agent's manager approves. */
const MANAGER_DELETION_TARGET = /^(routines?|schedules?|crons?|skills?|tables?)$/u;
/** MCP servers whose data is live production data: every deletion there is the owner's. */
const LIVE_DATA_SERVER =
  /postgres|supabase|neon|mysql|mariadb|turso|planetscale|mongo|redis|firebase|firestore|dynamo|database|(^|[_-])(d1|db|sql)([_-]|$)/u;
/** MCP servers that host live sites and apps: a deletion there is the owner's. */
const HOSTING_SERVER =
  /vercel|netlify|render|cloudflare|railway|heroku|appctl|webflow|wordpress|shopify|digitalocean|(^|[_-])fly([_-]|$)/u;
/** Words of a staged copy, a draft or temporary data: never live. */
const DRAFT_TARGET = /^(previews?|drafts?|staging|branch(es)?|tests?|temp|tmp|cache)$/u;

/** The tier of a deletion by the server (empty for Atelier's own tools) and the tool's name. */
export function deletionTier(server: string, tool: string): DeletionTier {
  const words = tool
    .toLowerCase()
    .replace(/api_?keys?/gu, "apikey")
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  if (words.some((word) => DRAFT_TARGET.test(word))) return "automatic";
  if (server && (LIVE_DATA_SERVER.test(server) || HOSTING_SERVER.test(server))) return "owner";
  if (words.some((word) => OWNER_DELETION_TARGET.test(word))) return "owner";
  if (words.some((word) => MANAGER_DELETION_TARGET.test(word))) return "manager";
  return "automatic";
}

/** Who approves this classification's deletion; null when it is not a deletion. */
export function deletionTierOf(action: TrustClassification): DeletionTier | null {
  return action.action === "delete" ? (action.deletes ?? "owner") : null;
}

export function trustCategory(action: TrustAction): TrustAuditCategory {
  switch (action) {
    case "pay":
    case "launch_ads":
      return "spend";
    case "publish":
      return "publish";
    case "email":
      return "send";
    case "create_agent":
      return "create_agent";
    case "delete":
      return "delete";
  }
}

export function trustSummary(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  const redacted = redactText(line);
  return redacted.length > SUMMARY_LIMIT ? `${redacted.slice(0, SUMMARY_LIMIT - 1)}…` : redacted;
}

function amountOf(text: string, pattern: RegExp, divisor = 1): number | undefined {
  const match = pattern.exec(text);
  if (!match?.[1]) return undefined;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) && value >= 0 ? value / divisor : undefined;
}

function currencyOf(text: string): string | undefined {
  const match = /--currency[= ]["']?([A-Za-z]{3})\b/u.exec(text);
  return match?.[1]?.toUpperCase();
}

/** Site names that the render-sites helper may deploy without a go-live: a staging copy. */
const STAGING_SITE = /^[a-z0-9-]*-(preview|staging|draft|test)$/u;

/**
 * The subcommand of a helper in one segment of a command: `node "$M" set-budget …` after the managed
 * skill's loop that finds `meta-ads.mjs`, or the helper by its own name. `domain add` keeps both words.
 */
function helperCommand(segment: string, helper: string, mentioned: boolean): string | null {
  return helperCall(segment, helper, mentioned)?.sub ?? null;
}

/** `helperCommand` and the arguments after the subcommand, which the helper itself parses. */
function helperCall(segment: string, helper: string, mentioned: boolean): { sub: string; rest: string } | null {
  if (!mentioned) return null;
  const trimmed = segment.trim();
  const match = new RegExp(
    `^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:node\\s+"?\\$\\{?[A-Za-z_]+\\}?"?|node\\s+\\S*${helper}\\.mjs"?|\\S*${helper}(?:\\.mjs)?)\\s+([a-z][a-z-]*)(?:\\s+([a-z][a-z-]*))?`,
    "du",
  ).exec(trimmed);
  if (!match?.[1]) return null;
  const sub = match[1] === "domain" && match[2] ? `domain ${match[2]}` : match[1];
  const end = (sub === match[1] ? match.indices?.[1]?.[1] : match.indices?.[2]?.[1]) ?? trimmed.length;
  return { sub, rest: trimmed.slice(end) };
}

/**
 * The meta-ads subcommands that only read: setup, lists, reports, the launch kit and the audit log.
 * They never change an ad, a budget or a bid, whatever flags they carry (`reach-estimate --budgets`
 * only estimates).
 */
const META_ADS_READS = new Set([
  "help",
  "whoami",
  "accounts",
  "account",
  "campaigns",
  "adsets",
  "ads",
  "creatives",
  "get",
  "insights",
  "review",
  "audiences",
  "lead-forms",
  "leads",
  "audit",
  "readiness",
  "reach-estimate",
  "targeting-search",
  "preview",
  "pixel-check",
  "validate",
]);

/** The flags that each helper reads with no value (its `BOOLEAN_FLAGS`): any other `--flag` takes the next word. */
const HELPER_BOOLEAN_FLAGS: Record<"meta-ads" | "hotmart", ReadonlySet<string>> = {
  "meta-ads": new Set([
    "approved",
    "activate",
    "dry-run",
    "validate",
    "deep",
    "raw",
    "help",
    "all",
    "budget-sharing",
    "no-budget-sharing",
    "include-archived",
  ]),
  hotmart: new Set([
    "approved",
    "dry-run",
    "raw",
    "help",
    "sandbox",
    "production",
    "full",
    "send-mail",
    "charge",
    "any-status",
    "no-token-cache",
  ]),
};

/** The words of a shell segment, with quotes taken off as the shell does; null for an unclosed quote. */
function shellWords(segment: string): string[] | null {
  const words: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+?)(?=\s|"|'|$)|(\s+)/gu;
  let current: string | null = null;
  let consumed = 0;
  for (const match of segment.matchAll(pattern)) {
    if (match.index !== consumed) return null;
    consumed = match.index + match[0].length;
    if (match[4] !== undefined) {
      if (current !== null) words.push(current);
      current = null;
      continue;
    }
    current = (current ?? "") + (match[1] ?? match[2] ?? match[3] ?? "");
  }
  if (consumed !== segment.length) return null;
  if (current !== null) words.push(current);
  return words;
}

/**
 * Whether a helper call only checks a change, read as the helper's own argument parser reads it:
 * `--dry-run` shows the request and sends nothing, and (meta-ads only) `--validate` asks Meta to check
 * it with `validate_only`, which saves nothing. A flag that is the value of the option before it
 * (`--name --validate`), that has a value (`--validate=1`, a string, not the flag), or that follows
 * `--` does not count, and neither does a segment with an unquoted expansion that could add words.
 */
function onlyChecks(segment: string, helper: "meta-ads" | "hotmart"): boolean {
  // An unquoted expansion can split into more words, such as a value that eats the flag.
  // A background `&` starts another command in the same segment.
  if (/[`$&]/u.test(segment.replace(/"(?:[^"\\`]|\\.)*"|'[^']*'/gu, "").replace(/\d*>&\d+/gu, ""))) return false;
  const words = shellWords(segment.trim());
  if (!words) return false;
  const booleans = HELPER_BOOLEAN_FLAGS[helper];
  const checks = helper === "meta-ads" ? ["dry-run", "validate"] : ["dry-run"];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? "";
    if (word === "--") return false;
    // What a pipe feeds is another program: only this helper's own words count.
    if (word === "|" || word.startsWith("|")) return false;
    if (!word.startsWith("--") || word.includes("=")) continue;
    const name = word.slice(2);
    if (checks.includes(name)) return true;
    // An option with a value takes the next word, whatever it looks like.
    if (!booleans.has(name)) index += 1;
  }
  return false;
}

function classifyMetaAds(segment: string, mentioned: boolean): TrustClassification | null {
  const call = helperCall(segment, "meta-ads", mentioned);
  if (!call) return null;
  const { sub } = call;
  // `config show` reads; `config set` of a weaker spend guard needs --approved and stays gated below.
  if (META_ADS_READS.has(sub) || (sub === "config" && !/\bconfig\s+set\b/u.test(segment))) return null;
  if (onlyChecks(call.rest, "meta-ads")) return null;
  const activates = sub === "resume" || /--activate\b/u.test(segment) || /"status"\s*:\s*"ACTIVE"/u.test(segment);
  const amount =
    amountOf(segment, /--daily(?:-budget)?[= ]["']?(\d+(?:[.,]\d+)?)/u) ??
    amountOf(segment, /"daily_budget"\s*:\s*"?(\d+)/u, 100);
  const spends =
    activates ||
    amount !== undefined ||
    sub === "set-budget" ||
    sub === "set-bid" ||
    /--lifetime(?:-budget)?\b|"lifetime_budget"|"bid_amount"|--approved\b/u.test(segment);
  if (!spends) return null;
  return {
    action: "launch_ads",
    label: `meta-ads ${sub}`,
    summary: trustSummary(segment.slice(segment.indexOf(sub))),
    platform: "meta",
    ...(amount === undefined ? {} : { amount }),
    ...(activates ? { sandbox: "ads" as const } : {}),
  };
}

function classifyHotmart(segment: string, mentioned: boolean): TrustClassification | null {
  const call = helperCall(segment, "hotmart", mentioned);
  if (!call) return null;
  const { sub } = call;
  // Every hotmart change honours --dry-run: it shows the request and sends nothing.
  if (onlyChecks(call.rest, "hotmart")) return null;
  const base = {
    label: `hotmart ${sub}`,
    summary: trustSummary(segment.slice(segment.indexOf(sub))),
    platform: "hotmart",
  };
  if (sub === "refund" || (sub === "reactivate-subscription" && /--charge\b/u.test(segment)))
    return { action: "pay", ...base };
  if (sub === "create-coupon") return { action: "publish", ...base };
  // A coupon is a price and a subscription is money: both stay the owner's.
  if (sub === "delete-coupon" || sub === "cancel-subscription") return { action: "delete", ...base, deletes: "owner" };
  return null;
}

function classifyRenderSites(segment: string, mentioned: boolean): TrustClassification | null {
  const sub = helperCommand(segment, "render-sites", mentioned);
  if (!sub) return null;
  const tail = segment.slice(segment.indexOf(sub.split(" ")[0] ?? sub) + sub.length).trim();
  const site = /^([a-z0-9-]+)/u.exec(tail)?.[1];
  const base = { label: `render-sites ${sub}`, summary: trustSummary(`${sub} ${tail}`), platform: "render" };
  if (sub === "delete" || sub === "suspend" || sub === "domain remove")
    // A staging copy is a draft; a live site is the owner's.
    return site && STAGING_SITE.test(site) && sub !== "domain remove"
      ? null
      : { action: "delete", ...base, deletes: "owner" };
  if (sub === "create" || sub === "deploy" || sub === "update" || sub === "domain add" || sub === "domain proxy") {
    if (site && STAGING_SITE.test(site) && sub !== "domain add") return null;
    return { action: "publish", ...base, sandbox: "landings" };
  }
  return null;
}

function classifyAppctl(command: string): TrustClassification | null {
  if (!/\bappctl\b/u.test(command)) return null;
  const match = /\bappctl"?\s+(?:([a-z]+)\s+)?([a-z-]+)/u.exec(command);
  if (!match) return null;
  const [, first, second] = match;
  const sub = first === "db" ? `db ${second}` : (first ?? second);
  const base = { label: `appctl ${sub}`, summary: trustSummary(command.slice(command.indexOf("appctl"))) };
  if (sub === "delete" || sub === "db delete" || sub === "db drop")
    return { action: "delete", ...base, deletes: "owner" };
  if (sub === "publish" || (sub === "deploy" && !/--private\b/u.test(command)) || sub === "redeploy")
    return { action: "publish", ...base, platform: "appctl", sandbox: "landings" };
  return null;
}

/** Branches whose push publishes: the default branch and a production branch. */
const PUBLISHED_BRANCHES = /^(main|master|production|prod|live|release)$/u;

/**
 * Whether each `git push` in the command names only review branches, such as `git push origin
 * cambio/hero`: a branch that waits for review is normal work, not a deployment. A push with no
 * branch (the current one), with HEAD, --all or --mirror, or to a published branch is not.
 */
export function pushesOnlyReviewBranches(command: string): boolean {
  const pushes = [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^;&|\n]*)/gu)];
  if (pushes.length === 0) return false;
  return pushes.every((push) => {
    const words = (push[1] ?? "").trim().split(/\s+/u).filter(Boolean);
    if (words.some((word) => word === "--all" || word === "--mirror" || word === "--tags")) return false;
    const refs = words.filter((word) => !word.startsWith("-") && !/^\d?>/u.test(word)).slice(1);
    if (refs.length === 0) return false;
    return refs.every((ref) => {
      const target = (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref)
        .replace(/^\+/u, "")
        .replace(/^refs\/heads\//u, "");
      return target !== "" && target !== "HEAD" && !PUBLISHED_BRANCHES.test(target);
    });
  });
}

/**
 * Whether a `git push` in the command rewrites or deletes a published branch: a force push
 * (`--force`, `-f`, `--force-with-lease`, a `+ref`) or a delete (`--delete`, `-d`, `:ref`) that
 * names main or a production branch. Other branches are normal work.
 */
export function rewritesPublishedBranch(command: string): boolean {
  return [...command.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^;&|\n]*)/gu)].some((push) => {
    const words = (push[1] ?? "").trim().split(/\s+/u).filter(Boolean);
    const forced = words.some((word) =>
      /^(--force(-with-lease)?(=\S*)?|--delete|-[a-zA-Z]*[fd][a-zA-Z]*)$/u.test(word),
    );
    const refs = words.filter((word) => !word.startsWith("-")).slice(1);
    return refs.some((ref) => {
      const rewrites = forced || ref.startsWith("+") || ref.startsWith(":");
      const target = (ref.includes(":") ? ref.slice(ref.indexOf(":") + 1) : ref)
        .replace(/^\+/u, "")
        .replace(/^refs\/heads\//u, "");
      return rewrites && PUBLISHED_BRANCHES.test(target);
    });
  });
}

function classifyGit(command: string): TrustClassification | null {
  // A repository is code, as the files of a workspace: its deletion runs at once (docs/approvals.md).
  if (/\bgh\s+repo\s+delete\b/u.test(command))
    return {
      action: "delete",
      label: "gh repo delete",
      summary: trustSummary(command),
      platform: "github",
      deletes: "automatic",
    };
  if (!/\bgit\s+(?:-C\s+\S+\s+)?push\b/u.test(command)) return null;
  if (rewritesPublishedBranch(command))
    return {
      action: "delete",
      label: "git push (rewrites a published branch)",
      summary: trustSummary(command),
      platform: "github",
      deletes: "owner",
    };
  // A push to the landings repository deploys on Render: auto-deploy follows the folder. A push of a
  // review branch publishes nothing until it is merged.
  if (!/landing/iu.test(command) || pushesOnlyReviewBranches(command)) return null;
  return {
    action: "publish",
    label: "git push (landings)",
    summary: trustSummary(command),
    platform: "github",
    sandbox: "landings",
  };
}

const EMAIL_APIS: ReadonlyArray<[RegExp, string]> = [
  [/api\.resend\.com/u, "resend"],
  [/api\.sendgrid\.com/u, "sendgrid"],
  [/api\.mailgun\.net|api\.eu\.mailgun\.net/u, "mailgun"],
  [/api\.postmarkapp\.com/u, "postmark"],
  [/api\.brevo\.com|api\.sendinblue\.com/u, "brevo"],
  [/mandrillapp\.com/u, "mailchimp"],
  [/gmail\.googleapis\.com\/.*\/send/u, "gmail"],
];

const PAYMENT_APIS: ReadonlyArray<[RegExp, string]> = [
  [/api\.stripe\.com\/v1\/(charges|payment_intents|payouts|transfers|refunds|invoices\/[^/\s]+\/pay)/u, "stripe"],
  [/api(?:-m)?\.paypal\.com\/v[12]\/(payments|checkout\/orders\/[^/\s]+\/capture)/u, "paypal"],
  [/api\.mercadopago\.com\/v1\/(payments|advanced_payments)/u, "mercadopago"],
  // A live order of the Alpaca trading API buys or sells with real money. The paper API does not.
  [/(?<![a-z-])api\.alpaca\.markets\/v2\/orders/u, "alpaca"],
  [/developers\.hotmart\.com\/payments\/api\/v1\/sales\/[^/\s"']+\/refund/u, "hotmart"],
];

const WRITES =
  /\s(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|-d\b|--data\b|--data-[a-z]+\b|-F\b|--form\b|--json\b)/iu;

function classifyHttp(command: string): TrustClassification | null {
  if (!/\b(curl|wget|http|https|xh)\b/u.test(command)) return null;
  const writes = WRITES.test(command);
  if (writes && /graph\.facebook\.com\/[^\s"']*\/(ads|adsets|campaigns)\b/u.test(command)) {
    const activates = /status["']?\s*[:=]\s*["']?ACTIVE/u.test(command);
    const amount = amountOf(command, /daily_budget["']?\s*[:=]\s*["']?(\d+)/u, 100);
    return {
      action: "launch_ads",
      label: "Meta Graph API",
      summary: trustSummary(command),
      platform: "meta",
      ...(amount === undefined ? {} : { amount }),
      ...(activates ? { sandbox: "ads" as const } : {}),
    };
  }
  if (writes) {
    for (const [pattern, platform] of PAYMENT_APIS)
      if (pattern.test(command)) {
        const amount = amountOf(command, /\bamount["']?\s*[:=]\s*["']?(\d+)/u, 100);
        return {
          action: "pay",
          label: `${platform} API`,
          summary: trustSummary(command),
          platform,
          ...(amount === undefined ? {} : { amount }),
          ...(currencyOf(command) ? { currency: currencyOf(command) } : {}),
        };
      }
    for (const [pattern, platform] of EMAIL_APIS)
      if (pattern.test(command))
        return {
          action: "email",
          label: `${platform} API`,
          summary: trustSummary(command),
          platform,
          sandbox: "emails",
        };
  }
  return null;
}

function classifyMailCommand(command: string): TrustClassification | null {
  if (
    /(^|[\s;&|(])(sendmail|msmtp|swaks|mutt)\s/u.test(command) ||
    /(^|[\s;&|(])mail\s+-s\s/u.test(command) ||
    /smtplib\.SMTP|nodemailer|\.sendMail\(/u.test(command)
  )
    return { action: "email", label: "mail command", summary: trustSummary(command), sandbox: "emails" };
  return null;
}

/** A write in program code, where no curl flag says so. */
const CODE_WRITES =
  /\b(?:requests|httpx|session|client|axios|got|ky|http|urllib3)\s*\.\s*(?:post|put|patch|delete|request)\s*\(|\bmethod\s*[:=]\s*["'`]?(?:POST|PUT|PATCH|DELETE)\b|urlopen\s*\([^)]*data\s*=|Request\s*\([^)]*data\s*=|\bNet::HTTP::Post\b|\bhttp_post\b/iu;

/** A live payment key in plain sight: whatever writes with it can move money. */
const LIVE_PAYMENT_KEY = /\b(?:sk|rk)_live_[A-Za-z0-9]{8,}|\bSTRIPE_(?:SECRET|API|RESTRICTED)_KEY\b/u;

/** Spending fields of the Meta Marketing API, in a payload that code builds. */
const META_SPEND = /daily_budget|lifetime_budget|bid_amount|["']?status["']?\s*[:=]\s*["']?ACTIVE/u;

/**
 * The money rules on program code or decoded text: a write to a payment API or to the ad objects
 * of the Meta Graph API, or a write next to a live payment key.
 */
function classifyMoneyCode(text: string): TrustClassification | null {
  const writes = WRITES.test(` ${text}`) || CODE_WRITES.test(text);
  if (!writes) return null;
  if (/graph\.facebook\.com/u.test(text) && (/\/(ads|adsets|campaigns)\b/u.test(text) || META_SPEND.test(text)))
    return {
      action: "launch_ads",
      label: "Meta Graph API",
      summary: trustSummary(text),
      platform: "meta",
      ...(/status["']?\s*[:=]\s*["']?ACTIVE/u.test(text) ? { sandbox: "ads" as const } : {}),
    };
  for (const [pattern, platform] of PAYMENT_APIS)
    if (pattern.test(text)) return { action: "pay", label: `${platform} API`, summary: trustSummary(text), platform };
  if (LIVE_PAYMENT_KEY.test(text))
    return { action: "pay", label: "payment key", summary: trustSummary(text), platform: "stripe" };
  return null;
}

/** The largest script that a command runs which the check reads. */
const SCRIPT_READ_LIMIT = 256 * 1024;
/** Helpers that the rules above know by their subcommands. Their own code is not the agent's call. */
const KNOWN_HELPER = /(?:^|\/)(?:meta-ads|hotmart|render-sites|appctl)(?:\.mjs|\.js)?$/u;
const SCRIPT_FILE = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|php)$/u;
const INTERPRETER =
  /(?:^|[\s;&|(])(?:bash|sh|zsh|dash|python[0-9.]*|node|bun|deno|ruby|perl|php|source|\.)\s+(?:-[A-Za-z]+\s+)*([^\s;&|)<>]+)/gu;

export interface CommandContext {
  /** The folder the command runs in, to find a script that it names by a relative path. */
  cwd?: string | null;
  /** Tests only. */
  readScript?: (path: string) => string | null;
}

function readScriptFile(path: string): string | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > SCRIPT_READ_LIMIT) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Decodes a run that looks like base64 when the result is mostly text. */
function decodedBase64(token: string): string | null {
  if (token.length < 16 || token.length > 64 * 1024) return null;
  const text = Buffer.from(token.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
  if (text.length < 8) return null;
  let printable = 0;
  for (const char of text) if (/[\x20-\x7e\n\r\t]/u.test(char)) printable += 1;
  return printable / text.length > 0.9 ? text : null;
}

/**
 * The text of a command with what it hides made readable: quotes and `+` joins of string pieces
 * removed, `\x63` escapes and base64 runs decoded (two levels), and each script that it runs read
 * (one level, never a known helper). The original text comes first.
 */
export function expandCommand(command: string, context: CommandContext = {}): string {
  const parts = [command];
  const joined = command
    .replace(/\\\n/gu, "")
    .replace(/["'`]\s*[+.]\s*["'`]/gu, "")
    .replace(/\\x([0-9a-fA-F]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
    .replace(/["'`\\]/gu, "");
  if (joined !== command) parts.push(joined);
  let decodable = joined;
  for (let level = 0; level < 2; level += 1) {
    const decoded: string[] = [];
    for (const token of decodable.match(/[A-Za-z0-9+/_-]{16,}={0,2}/gu) ?? []) {
      const text = decodedBase64(token);
      if (text) decoded.push(text);
    }
    if (decoded.length === 0) break;
    parts.push(...decoded);
    decodable = decoded.join("\n");
  }
  const read = context.readScript ?? readScriptFile;
  const seen = new Set<string>();
  const scripts = [...joined.matchAll(INTERPRETER)].map((match) => match[1] ?? "");
  for (const token of joined.split(/[\s;&|()<>]+/u)) if (SCRIPT_FILE.test(token)) scripts.push(token);
  for (const token of scripts) {
    if (!token || token.startsWith("-") || token.startsWith("$") || KNOWN_HELPER.test(token)) continue;
    const path = isAbsolute(token) ? token : context.cwd ? resolve(context.cwd, token) : null;
    if (!path || seen.has(path) || seen.size >= 4) continue;
    seen.add(path);
    const text = read(path);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/** A shell command of an agent, such as the Bash tool of Claude. The first consequential part wins. */
export function classifyCommand(command: string, context: CommandContext = {}): TrustClassification | null {
  if (!command.trim()) return null;
  const found = classifyPlainCommand(command);
  if (found) return found;
  // The second look, for money only: the other actions keep the predictable rules above.
  const expanded = expandCommand(command, context);
  const money = (classification: TrustClassification | null) =>
    classification && (classification.action === "pay" || classification.action === "launch_ads")
      ? { ...classification, summary: trustSummary(command) }
      : null;
  return (expanded === command ? null : money(classifyPlainCommand(expanded))) ?? money(classifyMoneyCode(expanded));
}

function classifyPlainCommand(command: string): TrustClassification | null {
  const mentions = {
    metaAds: command.includes("meta-ads"),
    hotmart: command.includes("hotmart"),
    renderSites: command.includes("render-sites"),
  };
  for (const segment of command.split(/\n|;|&&|\|\|/u)) {
    const found =
      classifyMetaAds(segment, mentions.metaAds) ??
      classifyHotmart(segment, mentions.hotmart) ??
      classifyRenderSites(segment, mentions.renderSites);
    if (found) return found;
  }
  return classifyAppctl(command) ?? classifyGit(command) ?? classifyHttp(command) ?? classifyMailCommand(command);
}

/** MCP servers whose tools never leave Atelier's own world: its tools and the agents' board. */
const QUIET_MCP_SERVER = /^(openbot|atelier|motion)/u;

/**
 * A tool of a connected MCP server, by the name Claude gives it (`mcp__<server>__<tool>`). The server
 * and tool names decide; the input only gives an amount.
 */
export function classifyMcpTool(qualifiedName: string, input: unknown): TrustClassification | null {
  const match = /^mcp__(.+?)__(.+)$/u.exec(qualifiedName);
  if (!match?.[1] || !match[2]) return null;
  const server = match[1].toLowerCase();
  const tool = match[2].toLowerCase();
  if (QUIET_MCP_SERVER.test(server)) return null;
  const label = `${server}.${tool}`;
  const summary = trustSummary(`${label} ${JSON.stringify(input ?? {}).slice(0, 400)}`);
  const both = `${server} ${tool}`;
  const has = (pattern: RegExp) => pattern.test(tool);
  if (
    has(/(^|_)(send|reply|forward)(_|$)|send_?(e?mail|message|campaign|newsletter)/u) &&
    /mail|newsletter|campaign|outlook|resend|sendgrid|brevo|mailchimp|klaviyo/u.test(both)
  )
    return { action: "email", label, summary, platform: server, sandbox: "emails" };
  if (has(/(^|_)(pay|charge|purchase|checkout|refund|payout|transfer)(_|$)|create_?payment/u))
    return { action: "pay", label, summary, platform: server };
  if (
    /meta|facebook|google_?ads|tiktok|(^|_)ads?(_|$)/u.test(both) &&
    has(/(create|update|activate|resume|budget|publish|launch)/u)
  ) {
    const amount =
      input && typeof input === "object" && "daily_budget" in input && typeof input.daily_budget === "number"
        ? input.daily_budget
        : undefined;
    return {
      action: "launch_ads",
      label,
      summary,
      platform: server,
      ...(amount === undefined ? {} : { amount }),
      ...(has(/activate|resume|publish|launch/u) ? { sandbox: "ads" as const } : {}),
    };
  }
  if (has(/(^|_)(publish|deploy|go_?live|release)(_|$)/u))
    return {
      action: "publish",
      label,
      summary,
      platform: server,
      ...(/site|landing|page|render|vercel|netlify|webflow|wordpress/u.test(both)
        ? { sandbox: "landings" as const }
        : {}),
    };
  if (has(/(^|_)(delete|destroy|drop|purge|remove|uninstall|revoke|disconnect)(_|$)/u))
    return { action: "delete", label, summary, platform: server, deletes: deletionTier(server, tool) };
  return null;
}

/** Atelier's own tools that the trust policy governs, by the agent's call (`openbot.<tool>`). */
export function classifyOpenBotTool(tool: string, args: unknown): TrustClassification | null {
  const record = isDynamicRecord(args) ? args : {};
  const text = (key: string) => (typeof record[key] === "string" ? record[key] : "");
  if (tool === "create_agent")
    return {
      action: "create_agent",
      label: "openbot.create_agent",
      summary: trustSummary(`Create the agent ${text("name")}`),
    };
  const deletion = (what: string, deletes: DeletionTier): TrustClassification => ({
    action: "delete",
    label: `openbot.${tool}`,
    summary: trustSummary(`${what} ${JSON.stringify(record).slice(0, 300)}`),
    deletes,
  });
  switch (tool) {
    case "delete_channel":
      // Without userAsked the tool refuses the call itself.
      return record.userAsked === true ? deletion("Delete a channel", "owner") : null;
    case "remove_api_key":
      return deletion("Delete a saved key", "owner");
    case "delete_routine":
      return deletion("Delete a routine", "manager");
    case "uninstall_skill":
      return deletion("Remove a skill", "manager");
    case "delete_table":
      return deletion("Delete a shared table", "manager");
    case "execute_data":
      return /^\s*drop\s+table\b/iu.test(text("sql")) ? deletion("Drop a shared table", "manager") : null;
    default:
      return null;
  }
}

interface BrowserSurface {
  surface: string;
  action: TrustAction;
  platform: string;
  test(url: URL): boolean;
}

/** Pages where an agent's click can spend money or publish. Reading them stays free. */
const BROWSER_SURFACES: readonly BrowserSurface[] = [
  {
    surface: "ads:meta",
    action: "launch_ads",
    platform: "meta",
    test: (url) =>
      url.hostname === "adsmanager.facebook.com" ||
      ((url.hostname === "business.facebook.com" || url.hostname === "www.facebook.com") &&
        /^\/(adsmanager|latest\/ads|ads\/manager|billing_hub)/u.test(url.pathname)),
  },
  { surface: "ads:google", action: "launch_ads", platform: "google", test: (url) => url.hostname === "ads.google.com" },
  {
    surface: "ads:tiktok",
    action: "launch_ads",
    platform: "tiktok",
    test: (url) => url.hostname === "ads.tiktok.com",
  },
  {
    surface: "pay:checkout",
    action: "pay",
    platform: "checkout",
    test: (url) =>
      ["checkout.stripe.com", "buy.stripe.com", "pay.hotmart.com", "www.mercadopago.com"].includes(url.hostname) ||
      (/(^|\.)paypal\.com$/u.test(url.hostname) && /^\/(checkoutnow|webapps\/hermes|pay)/u.test(url.pathname)),
  },
];

/** Browser tools that act on a page. Reading tools (snapshot, screenshot, status) are free. */
const ACTING_BROWSER_TOOLS = new Set([
  "click",
  "type",
  "press",
  "fill_fields",
  "run_steps",
  "select_option",
  "set_checked",
  "drag",
  "evaluate",
  "act",
  "upload_files",
]);

function parsedUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function surfacePlatform(url: URL): string {
  const host = url.hostname.replace(/^www\./u, "");
  return host.split(".").slice(-2, -1)[0] ?? host;
}

/** The longest page script that the read-only check reads. A longer one is treated as acting. */
const READ_ONLY_SCRIPT_LIMIT = 4_000;

/** Names that a read-only page script may start from. */
const READ_ONLY_ROOTS = new Set([
  "document",
  "location",
  "window",
  "JSON",
  "Object",
  "Array",
  "Math",
  "URL",
  "URLSearchParams",
  "String",
  "Number",
  "Boolean",
  "parseInt",
  "parseFloat",
  "isNaN",
  "encodeURIComponent",
  "decodeURIComponent",
  "undefined",
  "null",
  "true",
  "false",
  "NaN",
  "Infinity",
]);

/** The only properties of `window` that a read-only script may read. */
const READ_ONLY_WINDOW_PROPERTIES = new Set(["location", "document"]);

/** Functions that a read-only script may call by their bare name. */
const READ_ONLY_FUNCTIONS = new Set([
  "String",
  "Number",
  "Boolean",
  "parseInt",
  "parseFloat",
  "isNaN",
  "encodeURIComponent",
  "decodeURIComponent",
]);

/** Constructors that a read-only script may call with `new`. */
const READ_ONLY_CONSTRUCTORS = new Set(["URL", "URLSearchParams"]);

/**
 * Methods that only read: DOM queries and attributes, URL and search parameter reads, and plain
 * string, array, object and number helpers. `click`, `submit`, `dispatchEvent`, `fetch`, `assign`,
 * `replace` (also `location.replace`), `open`, `focus` and every other name are not here.
 */
const READ_ONLY_METHODS = new Set([
  "querySelector",
  "querySelectorAll",
  "getElementById",
  "getElementsByClassName",
  "getElementsByTagName",
  "getElementsByName",
  "getAttribute",
  "getAttributeNames",
  "hasAttribute",
  "closest",
  "matches",
  "contains",
  "item",
  "get",
  "getAll",
  "has",
  "keys",
  "values",
  "entries",
  "fromEntries",
  "from",
  "of",
  "isArray",
  "map",
  "filter",
  "find",
  "findIndex",
  "some",
  "every",
  "includes",
  "indexOf",
  "lastIndexOf",
  "slice",
  "at",
  "join",
  "concat",
  "flat",
  "stringify",
  "parse",
  "trim",
  "trimStart",
  "trimEnd",
  "toLowerCase",
  "toUpperCase",
  "startsWith",
  "endsWith",
  "split",
  "substring",
  "padStart",
  "padEnd",
  "match",
  "test",
  "exec",
  "toString",
  "toFixed",
  "normalize",
  "round",
  "floor",
  "ceil",
  "min",
  "max",
  "abs",
]);

/** Properties that lead out of the page's document to a window or a prototype, which a getter can use. */
const ESCAPE_PROPERTIES = new Set([
  "defaultView",
  "opener",
  "parent",
  "top",
  "frames",
  "self",
  "globalThis",
  "contentWindow",
  "contentDocument",
  "constructor",
  "prototype",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
]);

/** Keywords that a read-only expression may hold. Every other keyword (`function`, `delete`, `await`) is not read-only. */
const READ_ONLY_KEYWORDS = new Set(["new", "typeof", "in", "instanceof"]);

const JS_KEYWORDS = new Set([
  "await",
  "async",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "eval",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "let",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "arguments",
]);

/** Operators that a read-only expression may hold. `=`, `+=`, `++`, `||=` and the other writes are not here. */
const READ_ONLY_OPERATORS = [
  "...",
  "===",
  "!==",
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  ".",
  ",",
  ":",
  ";",
  "?",
  "!",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "/",
] as const;

type ScriptToken = { kind: "name" | "literal" | "op"; text: string };

/** Ends a string literal that starts at `start`, or -1. A template literal must not hold `${`. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (quote === "`" && char === "$" && source[index + 1] === "{") return -1;
    if (char === quote) return index + 1;
    if (char === "\n" && quote !== "`") return -1;
  }
  return -1;
}

/** Ends a regular expression literal that starts at `start`, or -1. */
function regexEnd(source: string, start: number): number {
  let inClass = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n") return -1;
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      let end = index + 1;
      while (end < source.length && /[a-z]/u.test(source[end] ?? "")) end += 1;
      return end;
    }
  }
  return -1;
}

/** The tokens of a page script, or null when it holds anything outside the read-only grammar. */
function scriptTokens(source: string): ScriptToken[] | null {
  const tokens: ScriptToken[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    const previous = tokens.at(-1);
    if (char === "'" || char === '"' || char === "`") {
      // A template right after a name or a call is a tagged template, which calls that name.
      if (char === "`" && previous && (previous.kind === "name" || previous.text === ")" || previous.text === "]"))
        return null;
      const end = stringEnd(source, index);
      if (end < 0) return null;
      tokens.push({ kind: "literal", text: source.slice(index, end) });
      index = end;
      continue;
    }
    const name = /^[A-Za-z_$][\w$]*/u.exec(source.slice(index))?.[0];
    if (name) {
      tokens.push({ kind: "name", text: name });
      index += name.length;
      continue;
    }
    const number = /^\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?/iu.exec(source.slice(index))?.[0];
    if (number) {
      tokens.push({ kind: "literal", text: number });
      index += number.length;
      continue;
    }
    // A comment can hide nothing that matters, but it is not part of a simple read.
    if (source.startsWith("//", index) || source.startsWith("/*", index)) return null;
    const divides = previous && (previous.kind !== "op" || previous.text === ")" || previous.text === "]");
    if (char === "/" && !divides) {
      const end = regexEnd(source, index);
      if (end < 0) return null;
      tokens.push({ kind: "literal", text: source.slice(index, end) });
      index = end;
      continue;
    }
    const operator = READ_ONLY_OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!operator) return null;
    // Comparisons are listed whole, so an operator before `=` is a write: `+=`, `||=`, `??=`. A lone
    // `=` matches nothing and is refused above.
    if (source[index + operator.length] === "=") return null;
    if ((operator === "+" || operator === "-") && source[index + 1] === operator) return null;
    tokens.push({ kind: "op", text: operator });
    index += operator.length;
  }
  return tokens;
}

/** The names that arrow functions of the script take as parameters. */
function arrowParameters(tokens: readonly ScriptToken[]): Set<string> {
  const names = new Set<string>();
  tokens.forEach((token, position) => {
    if (token.text !== "=>") return;
    const before = tokens[position - 1];
    if (before?.kind === "name") {
      names.add(before.text);
      return;
    }
    if (before?.text !== ")") return;
    let depth = 0;
    for (let index = position - 1; index >= 0; index -= 1) {
      const candidate = tokens[index];
      if (!candidate) break;
      if (candidate.text === ")") depth += 1;
      else if (candidate.text === "(") {
        depth -= 1;
        if (depth === 0) break;
      } else if (candidate.kind === "name") names.add(candidate.text);
    }
  });
  return names;
}

/**
 * True when a page script only reads, such as `location.href`,
 * `new URLSearchParams(location.search).get("off")`, `document.title` or
 * `document.querySelector("h1").textContent`. It allows member reads from the document, the address
 * and plain helpers, calls of listed reading methods only, and no assignment, update, declaration,
 * comment, computed call, tagged template or template substitution. Anything else, including any
 * script it cannot read, is not read-only.
 */
export function isReadOnlyPageScript(expression: string): boolean {
  if (expression.length > READ_ONLY_SCRIPT_LIMIT) return false;
  const tokens = scriptTokens(expression);
  if (!tokens || tokens.length === 0) return false;
  const parameters = arrowParameters(tokens);
  for (const [position, token] of tokens.entries()) {
    const before = tokens[position - 1];
    const after = tokens[position + 1];
    const member = before?.text === "." || before?.text === "?.";
    if (token.kind === "name") {
      if (member) {
        if (ESCAPE_PROPERTIES.has(token.text)) return false;
        if (after?.text === "(" && !READ_ONLY_METHODS.has(token.text)) return false;
        const owner = tokens[position - 2];
        if (owner?.text === "window" && !READ_ONLY_WINDOW_PROPERTIES.has(token.text)) return false;
        continue;
      }
      // A key of an object literal, such as `{ offer: ... }`, names nothing.
      if (after?.text === ":" && (before?.text === "{" || before?.text === ",")) continue;
      if (READ_ONLY_KEYWORDS.has(token.text)) {
        if (token.text === "new" && !(after && READ_ONLY_CONSTRUCTORS.has(after.text))) return false;
        continue;
      }
      if (JS_KEYWORDS.has(token.text)) return false;
      if (before?.text === "new") continue;
      if (parameters.has(token.text)) {
        if (after?.text === "(") return false;
        continue;
      }
      if (!READ_ONLY_ROOTS.has(token.text)) return false;
      if (after?.text === "(" && !READ_ONLY_FUNCTIONS.has(token.text)) return false;
      if (token.text === "window" && after?.text !== "." && after?.text !== "?.") return false;
      continue;
    }
    // A call of whatever a bracket, a call or an optional call gave, such as `el["click"]()`.
    if (token.text === "(" && before && (before.text === ")" || before.text === "]" || before.text === "?."))
      return false;
    if (token.text === "(" && before?.kind === "literal") return false;
  }
  return true;
}

/** One line, cut to `limit` characters. */
function oneLine(text: string, limit: number): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** The element that a browser call targets, in words: `"Comprar"`, `button "Pay"`, `#submit` or `e12`. */
function targetWords(target: unknown): string {
  if (!isDynamicRecord(target)) return "";
  if (typeof target.name === "string")
    return `${typeof target.role === "string" ? `${target.role} ` : ""}"${oneLine(target.name, 60)}"`;
  if (typeof target.text === "string") return `"${oneLine(target.text, 60)}"`;
  if (typeof target.role === "string") return target.role;
  if (typeof target.selector === "string") return oneLine(target.selector, 60);
  if (typeof target.ref === "string") return target.ref;
  return "";
}

/**
 * What a browser call does, for the approval card: the tool and its target, key or script. Typed
 * text never shows: on a payment page it can be a card detail.
 */
function browserCallWords(tool: string, record: DynamicRecord): string {
  if (tool === "evaluate" && typeof record.expression === "string")
    return `evaluate: ${oneLine(record.expression, 120)}`;
  if (tool === "press" && typeof record.key === "string") return `press ${oneLine(record.key, 40)}`;
  if (tool === "run_steps" && Array.isArray(record.steps)) {
    const steps = record.steps
      .map((step) => (isDynamicRecord(step) && typeof step.action === "string" ? step.action : null))
      .filter((step): step is string => step !== null);
    return `run_steps: ${oneLine(steps.join(", "), 100)}`;
  }
  const target = targetWords(record.target);
  return target ? `${tool} ${target}` : tool;
}

/**
 * What the trust gate knows of a tab's page from its last snapshot: the element of a ref, and the
 * element that has the focus. Both are null when the snapshot is gone or does not hold it.
 */
export interface BrowserPageFacts {
  element(ref: string): { role: string | null; name: string; description: string; tag: string } | null;
  focus(): { role: string | null; name: string; tag: string; editable: boolean } | null;
}

/** A browser call on a checkout page that the gate refuses without a card: it cannot tell what the step hits. */
export interface BrowserStepBlock {
  blocked: string;
}

export function isBrowserStepBlock(value: TrustClassification | BrowserStepBlock | null): value is BrowserStepBlock {
  return value !== null && "blocked" in value;
}

/** The agent's message when the gate cannot tell a click on a checkout page from the pay button. */
export const CHECKOUT_UNKNOWN_CLICK =
  "No puedo confirmar que ese clic no sea el de pagar; usa snapshot para leer o elige el elemento por su texto.";
/** The same for text typed where the gate cannot tell a payment field from another. */
export const CHECKOUT_UNKNOWN_FIELD =
  "No puedo confirmar que ese campo no sea de pago; usa snapshot para leer o elige el campo por su texto.";

/** How long one owner approval on a checkout page covers the agent's steps on that site. */
export const CHECKOUT_PASS_MINUTES = 30;

/**
 * A payment field: card number, expiry, security code, cardholder, a tax or identity document,
 * billing data, or PIX and boleto. Agents never type into these without the owner.
 */
const PAYMENT_FIELD =
  /card|tarjeta|cart[aã]o|cc-?(?:number|num|exp|csc|name)|cvv|cvc|\bcsc\b|security.?code|c[oó]digo de seguran[cç]a|c[oó]digo de seguridad|expir|vencim|validade|\bmm\s*\/\s*(?:aa|yy)|cardholder|titular|name on card|nombre en la tarjeta|nome no cart|document|\bcpf\b|\bcnpj\b|\bdni\b|\brut\b|\bcuit\b|\bnit\b|c[eé]dula|tax.?id|billing|facturaci|\bpix\b|boleto/iu;
/** The buy or submit control of a checkout. */
const BUY_CONTROL =
  /comprar|pagar|finalizar|confirmar|\bbuy\b|\bpay\b|place.?order|subscribe|suscrib|assinar|checkout.?submit|submit/iu;
/** A CSS selector of a button that says nothing of which button it is. */
const ANONYMOUS_BUTTON = /button|\bbtn|\[type\s*=|input\[/iu;
/** Typed text that looks like a card number, whatever field it goes to. */
const CARD_NUMBER_TEXT = /(?:\d[ -]?){13,19}/u;

type StepClass = "free" | "money" | "card" | "unknown-click" | "unknown-field";

interface TargetFacts {
  /** The target's words: role, name, text, selector. Empty when nothing names it. */
  words: string;
  /** Whether the words say what the element is. */
  known: boolean;
  /** A button or link with no name, or a point: the gate cannot tell which control it is. */
  anonymous: boolean;
}

function factsOf(target: unknown, page: BrowserPageFacts | null): TargetFacts {
  if (target === undefined) {
    const focus = page?.focus() ?? null;
    if (!focus) return { words: "", known: false, anonymous: true };
    const words = [focus.role ?? "", focus.name, focus.tag].join(" ").trim();
    return { words, known: focus.name.trim() !== "", anonymous: focus.name.trim() === "" };
  }
  if (!isDynamicRecord(target)) return { words: "", known: false, anonymous: true };
  const text = (key: string) => (typeof target[key] === "string" ? target[key] : "");
  switch (target.kind) {
    case "ref": {
      const element = page?.element(text("ref")) ?? null;
      if (!element) return { words: "", known: false, anonymous: true };
      const words = [element.role ?? "", element.name, element.description, element.tag].join(" ").trim();
      const named = `${element.name}${element.description}`.trim() !== "";
      return { words, known: named, anonymous: !named };
    }
    case "role": {
      const words = `${text("role")} ${text("name")}`.trim();
      return { words, known: text("name").trim() !== "", anonymous: text("name").trim() === "" };
    }
    case "text":
      return { words: text("text"), known: true, anonymous: false };
    case "css": {
      const selector = text("selector");
      return { words: selector, known: true, anonymous: ANONYMOUS_BUTTON.test(selector) };
    }
    default:
      return { words: "", known: false, anonymous: true };
  }
}

function clickClass(target: unknown, page: BrowserPageFacts | null): "money" | "unknown-click" | "free" {
  const facts = factsOf(target, page);
  if (BUY_CONTROL.test(facts.words)) return "money";
  if (!facts.known || facts.anonymous) return "unknown-click";
  return "free";
}

function typeClass(target: unknown, text: unknown, submit: boolean, page: BrowserPageFacts | null): StepClass {
  const facts = factsOf(target, page);
  if (PAYMENT_FIELD.test(facts.words) || (typeof text === "string" && CARD_NUMBER_TEXT.test(text))) return "card";
  if (!facts.known) return "unknown-field";
  // Enter in a field sends its form: on a checkout page that is the payment.
  return submit ? "money" : "free";
}

function pressClass(key: unknown, target: unknown, page: BrowserPageFacts | null): StepClass {
  const name = typeof key === "string" ? key.toLowerCase() : "";
  if (/(^|\+)(enter|numpadenter|return)$/u.test(name)) return "money";
  if (name === " " || name === "space") return clickClass(target, page);
  return "free";
}

/** The class of one step of a browser call on a checkout page. */
function stepClass(action: string, step: DynamicRecord, page: BrowserPageFacts | null): StepClass {
  switch (action) {
    case "click":
      return clickClass(step.target, page);
    case "type":
      return typeClass(step.target, step.text, step.submit === true, page);
    case "press":
      return pressClass(step.key, step.target, page);
    case "fill_fields": {
      const fields = Array.isArray(step.fields) ? step.fields : [];
      return worst(
        fields.map((field) =>
          isDynamicRecord(field)
            ? typeClass({ kind: "ref", ref: field.ref }, field.text, false, page)
            : ("unknown-field" as const),
        ),
      );
    }
    case "evaluate":
      return typeof step.expression === "string" && isReadOnlyPageScript(step.expression) ? "free" : "money";
    case "act": {
      const legacy = isDynamicRecord(step.action) ? step.action : {};
      const ref = typeof legacy.ref === "string" ? { kind: "ref", ref: legacy.ref } : undefined;
      if (legacy.type === "click") return clickClass(ref, page);
      if (legacy.type === "type") return typeClass(ref, legacy.text, legacy.submit === true, page);
      if (legacy.type === "key") return pressClass(legacy.key, undefined, page);
      return "free";
    }
    // Choosing a country, a language or the installments shown, scrolling, waiting, moving to
    // another address and reading pay nothing.
    default:
      return "free";
  }
}

const STEP_ORDER: readonly StepClass[] = ["card", "money", "unknown-click", "unknown-field", "free"];

function worst(classes: readonly StepClass[]): StepClass {
  return STEP_ORDER.find((candidate) => classes.includes(candidate)) ?? "free";
}

/** The class of a whole browser call on a checkout page: its worst step. */
function checkoutCallClass(tool: string, record: DynamicRecord, page: BrowserPageFacts | null): StepClass {
  if (tool !== "run_steps") return stepClass(tool, record, page);
  const steps = Array.isArray(record.steps) ? record.steps : [];
  return worst(
    steps.map((step) =>
      isDynamicRecord(step) && typeof step.action === "string" ? stepClass(step.action, step, page) : "unknown-click",
    ),
  );
}

/**
 * A browser tool call, with the address of the tab it acts on and what its last snapshot says of the
 * page. On a checkout page only real payment steps are money: a card fill, text in a payment field,
 * the buy or submit control, Enter, or a script that writes. A step whose target the gate cannot
 * tell is refused with a message to the agent (`BrowserStepBlock`); the owner never sees it.
 */
export function classifyBrowserCall(
  tool: string,
  args: unknown,
  tabUrl: string | undefined,
  page: BrowserPageFacts | null = null,
): TrustClassification | BrowserStepBlock | null {
  const url = parsedUrl(tabUrl);
  const record = isDynamicRecord(args) ? args : {};
  if (tool === "fill_card") {
    const amount = typeof record.amount === "number" && record.amount >= 0 ? record.amount : undefined;
    const currency = typeof record.currency === "string" ? record.currency.toUpperCase().slice(0, 8) : undefined;
    return {
      action: "pay",
      label: "openbot_browser.fill_card",
      summary: trustSummary(
        `Card payment on ${url?.hostname ?? "a page"}${amount === undefined ? "" : `: ${amount} ${currency ?? ""}`}`,
      ),
      platform: url ? surfacePlatform(url) : "browser",
      ...(amount === undefined ? {} : { amount }),
      ...(currency ? { currency } : {}),
      browser: { site: url?.hostname ?? "a page", what: "fill_card" },
    };
  }
  // A saved login of the Vault is a stored credential: only the owner deletes it.
  if (tool === "delete_vault_item")
    return {
      action: "delete",
      label: "openbot_browser.delete_vault_item",
      summary: trustSummary(`Delete a saved login ${typeof record.id === "string" ? record.id : ""}`),
      deletes: "owner",
    };
  if (!url || !ACTING_BROWSER_TOOLS.has(tool)) return null;
  const surface = BROWSER_SURFACES.find((candidate) => candidate.test(url));
  if (!surface) return null;
  const what = browserCallWords(tool, record);
  if (surface.surface === "pay:checkout") {
    const found = checkoutCallClass(tool, record, page);
    if (found === "free") return null;
    if (found === "unknown-click") return { blocked: CHECKOUT_UNKNOWN_CLICK };
    if (found === "unknown-field") return { blocked: CHECKOUT_UNKNOWN_FIELD };
    return {
      action: "pay",
      label: `openbot_browser.${tool}`,
      summary: trustSummary(`Acts on ${url.hostname}${url.pathname}: ${what}`),
      platform: surfacePlatform(url),
      // Card data is the owner's every time; a buy step's approval covers this site for a while.
      ...(found === "money" ? { surface: `pay:checkout:${url.hostname}`, passMinutes: CHECKOUT_PASS_MINUTES } : {}),
      browser: { site: url.hostname, what: trustSummary(what) },
    };
  }
  // A script that only reads, such as the offer in the address or the page title, cannot pay or
  // publish. Every other script, and every click, key or typed text, is the surface's action.
  if (tool === "evaluate" && typeof record.expression === "string" && isReadOnlyPageScript(record.expression))
    return null;
  return {
    action: surface.action,
    label: `openbot_browser.${tool}`,
    summary: trustSummary(`Acts on ${url.hostname}${url.pathname}: ${what}`),
    platform: surface.platform,
    surface: surface.surface,
    browser: { site: url.hostname, what: trustSummary(what) },
  };
}

/** The server request that the Claude hook sends before a Bash or MCP tool runs. */
export const TRUST_CHECK_METHOD = "openbot/trust-check";

/** The classification of a Claude tool use: Bash by its command, an MCP tool by its name. */
export function classifyToolUse(
  toolName: unknown,
  toolInput: unknown,
  cwd?: string | null,
): TrustClassification | null {
  if (typeof toolName !== "string") return null;
  if (toolName === "Bash") {
    const command =
      toolInput && typeof toolInput === "object" && "command" in toolInput && typeof toolInput.command === "string"
        ? toolInput.command
        : "";
    return classifyCommand(command, { cwd: cwd ?? null });
  }
  if (toolName.startsWith("mcp__")) return classifyMcpTool(toolName, toolInput);
  return null;
}
