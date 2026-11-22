import { createHash } from "node:crypto";
import type { TrustAuditEntry, TrustAuditQuery } from "@openbot/contracts/trust-control";
import type { TrustClassification } from "../trust/trust-classifier";

/** What a money approval card says: the effect, what to pay and where, and the call it is bound to. */
export interface MoneyEffect {
  /** One line, such as "Meta ads · daily budget 10 → 50 USD · ad set 1203". */
  headline: string;
  /** For a payment: what the owner pays by hand after approving, and where. */
  payByHand: string | null;
  /** The digest of the exact call. A changed call is another approval. */
  digest: string;
}

/** An identical call after an approval runs without a second card within this time, once. */
const SAME_CALL_MS = 10 * 60_000;

function amountText(amount: number | undefined, currency: string): string {
  if (amount === undefined) return `? ${currency}`;
  return `${Number.isInteger(amount) ? amount : amount.toFixed(2)} ${currency}`;
}

/** The thing a money call acts on, from its command or tool input: an ad set, a campaign, a product. */
export function moneyTarget(text: string): { kind: string; id: string } | null {
  const flag =
    /--(adset|ad-set|campaign|ad|product|transaction|subscription|customer|offer|invoice)(?:-id)?[= ]["']?([A-Za-z0-9_.-]{2,64})/u.exec(
      text,
    );
  if (flag?.[1] && flag[2]) return { kind: flag[1].replace("ad-set", "adset"), id: flag[2] };
  const graph = /graph\.facebook\.com\/v[\d.]+\/(\d{5,})/u.exec(text);
  if (graph?.[1]) return { kind: "object", id: graph[1] };
  const json = /"(adset_id|campaign_id|product_id|customer|destination)"\s*:\s*"?([A-Za-z0-9_.-]{2,64})/u.exec(text);
  if (json?.[1] && json[2]) return { kind: json[1].replace(/_id$/u, ""), id: json[2] };
  const positional = /\b(?:set-budget|set-bid|resume|refund|pay)\s+["']?(\d{5,})\b/u.exec(text);
  if (positional?.[1]) return { kind: "object", id: positional[1] };
  return null;
}

const TARGET_WORDS: Record<string, string> = {
  adset: "ad set",
  campaign: "campaign",
  ad: "ad",
  product: "product",
  transaction: "sale",
  subscription: "subscription",
  customer: "customer",
  offer: "offer",
  invoice: "invoice",
  destination: "payee",
  object: "id",
};

function where(action: TrustClassification): string {
  const url = /https?:\/\/[^\s"'<>]+/u.exec(action.summary)?.[0];
  if (url) return url.length > 120 ? `${url.slice(0, 119)}…` : url;
  const host = /\bon ([a-z0-9.-]+\.[a-z]{2,})/iu.exec(action.summary)?.[1];
  return host ?? `the ${action.platform ?? "payment"} page`;
}

/** The digest of the exact call: what it is, its text and its amount. */
export function moneyDigest(action: TrustClassification): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        action.action,
        action.label,
        action.summary.replace(/\s+/gu, " ").trim(),
        action.amount ?? null,
        action.currency ?? null,
        action.platform ?? null,
      ]),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * The effect of a money call for its approval card. The previous amount of the same target comes
 * from the last approved or allowed spend of the audit trail that names it, so "10 → 50" shows
 * without a call to the platform; it shows "?" when Atelier never saw one.
 */
export function moneyEffect(
  action: TrustClassification,
  audit: { query(query: TrustAuditQuery): TrustAuditEntry[] } | null,
): MoneyEffect {
  const currency = action.currency ?? "USD";
  const target = moneyTarget(action.summary);
  const targetText = target ? ` · ${TARGET_WORDS[target.kind] ?? target.kind} ${target.id}` : "";
  const platform = action.platform ? action.platform.charAt(0).toUpperCase() + action.platform.slice(1) : "Payment";
  let headline: string;
  if (action.action === "launch_ads") {
    const previous =
      target && audit
        ? audit
            .query({ category: "spend", text: target.id, limit: 20 })
            .find(
              (entry) => entry.amount !== undefined && (entry.outcome === "approved" || entry.outcome === "allowed"),
            )
        : undefined;
    const budget = /lifetime/u.test(action.summary) ? "lifetime budget" : "daily budget";
    headline =
      action.amount === undefined
        ? `${platform} ads · ${action.label}${targetText}`
        : `${platform} ads · ${budget} ${previous?.amount === undefined ? "?" : amountText(previous.amount, previous.currency ?? currency)} → ${amountText(action.amount, currency)}${targetText}`;
  } else {
    headline = `${platform} · pay ${amountText(action.amount, currency)}${targetText}`;
  }
  return {
    headline,
    payByHand:
      action.action === "pay"
        ? `After you approve: pay ${amountText(action.amount, currency)} by hand at ${where(action)}${target ? ` for ${TARGET_WORDS[target.kind] ?? target.kind} ${target.id}` : ""}.`
        : null,
    digest: moneyDigest(action),
  };
}

/**
 * The approvals of money calls that the owner gave: an identical call (the same digest) of the same
 * agent runs once more within ten minutes without a second card, such as a retry after a network
 * error. Any change of the call is another digest and asks again. Kept in memory only.
 */
export class MoneyApprovals {
  readonly #approved = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  grant(agentId: string, digest: string): void {
    this.#approved.set(`${agentId}\n${digest}`, this.#now() + SAME_CALL_MS);
    if (this.#approved.size > 500) this.#approved.delete(this.#approved.keys().next().value ?? "");
  }

  /** True once for an identical call that the owner approved a short time ago. */
  consume(agentId: string, digest: string): boolean {
    const key = `${agentId}\n${digest}`;
    const until = this.#approved.get(key);
    this.#approved.delete(key);
    return until !== undefined && until > this.#now();
  }
}
