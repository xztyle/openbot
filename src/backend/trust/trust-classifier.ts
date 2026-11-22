import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
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
  /**
   * A browser surface, such as `ads:meta`. One approval covers the agent's next actions on the same
   * surface for the policy's pass time, so a person approves a session, not each click.
   */
  surface?: string;
}

const SUMMARY_LIMIT = 300;

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
  if (!mentioned) return null;
  const match = new RegExp(
    `^(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:node\\s+"?\\$\\{?[A-Za-z_]+\\}?"?|node\\s+\\S*${helper}\\.mjs"?|\\S*${helper}(?:\\.mjs)?)\\s+([a-z][a-z-]*)(?:\\s+([a-z][a-z-]*))?`,
    "u",
  ).exec(segment.trim());
  if (!match?.[1]) return null;
  return match[1] === "domain" && match[2] ? `domain ${match[2]}` : match[1];
}

function classifyMetaAds(segment: string, mentioned: boolean): TrustClassification | null {
  const sub = helperCommand(segment, "meta-ads", mentioned);
  if (!sub) return null;
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
  const sub = helperCommand(segment, "hotmart", mentioned);
  if (!sub) return null;
  const base = {
    label: `hotmart ${sub}`,
    summary: trustSummary(segment.slice(segment.indexOf(sub))),
    platform: "hotmart",
  };
  if (sub === "refund" || (sub === "reactivate-subscription" && /--charge\b/u.test(segment)))
    return { action: "pay", ...base };
  if (sub === "create-coupon") return { action: "publish", ...base };
  if (sub === "delete-coupon" || sub === "cancel-subscription") return { action: "delete", ...base };
  return null;
}

function classifyRenderSites(segment: string, mentioned: boolean): TrustClassification | null {
  const sub = helperCommand(segment, "render-sites", mentioned);
  if (!sub) return null;
  const tail = segment.slice(segment.indexOf(sub.split(" ")[0] ?? sub) + sub.length).trim();
  const site = /^([a-z0-9-]+)/u.exec(tail)?.[1];
  const base = { label: `render-sites ${sub}`, summary: trustSummary(`${sub} ${tail}`), platform: "render" };
  if (sub === "delete" || sub === "suspend" || sub === "domain remove") return { action: "delete", ...base };
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
  if (sub === "delete" || sub === "db delete" || sub === "db drop") return { action: "delete", ...base };
  if (sub === "publish" || (sub === "deploy" && !/--private\b/u.test(command)) || sub === "redeploy")
    return { action: "publish", ...base, platform: "appctl", sandbox: "landings" };
  return null;
}

function classifyGit(command: string): TrustClassification | null {
  if (/\bgh\s+repo\s+delete\b/u.test(command))
    return { action: "delete", label: "gh repo delete", summary: trustSummary(command), platform: "github" };
  if (!/\bgit\s+(?:-C\s+\S+\s+)?push\b/u.test(command)) return null;
  // A push to the landings repository deploys on Render: auto-deploy follows the folder.
  if (!/landing/iu.test(command)) return null;
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
  if (has(/(^|_)(delete|destroy|drop|purge)(_|$)/u)) return { action: "delete", label, summary, platform: server };
  return null;
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

/** A browser tool call, with the address of the tab it acts on. */
export function classifyBrowserCall(
  tool: string,
  args: unknown,
  tabUrl: string | undefined,
): TrustClassification | null {
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
    };
  }
  if (!url || !ACTING_BROWSER_TOOLS.has(tool)) return null;
  const surface = BROWSER_SURFACES.find((candidate) => candidate.test(url));
  if (!surface) return null;
  return {
    action: surface.action,
    label: `openbot_browser.${tool}`,
    summary: trustSummary(`Acts on ${url.hostname}${url.pathname}`),
    platform: surface.platform === "checkout" ? surfacePlatform(url) : surface.platform,
    surface: surface.surface,
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
