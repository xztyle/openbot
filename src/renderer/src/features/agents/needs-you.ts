import {
  type AgentApproval,
  type AgentAttentionItem,
  type AgentAttentionKind,
  agentAttentionKey,
  type BrowserTakeoverRequest,
  isTicketAttention,
} from "@openbot/contracts/ipc";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarApproval, SidebarAttention } from "@openbot/ui/features/sidebar/sidebar-agent-states";
import type { TextValue } from "@openbot/ui/text";

/** A question that a client holds: its own event, or a snapshot entry. */
export interface HeldPrompt {
  requestId: string | number;
  agentId: string;
  threadId: string;
  turnId: string;
  questions?: readonly { question: string; isSecret?: boolean | undefined }[];
}

export interface NeedsYouSources {
  /** The host's whole list, or null where the host does not send it. */
  items: readonly AgentAttentionItem[] | null;
  prompts: readonly HeldPrompt[];
  approvals: readonly AgentApproval[];
  takeovers: readonly BrowserTakeoverRequest[];
}

/** How long a request that the client holds may wait for the host's list to name it. */
const HOST_LIST_GRACE_MS = 60_000;

/** When this client first saw a request that the host's list does not name. */
const firstSeen = new Map<string, string>();

function seenAt(key: string): string {
  let at = firstSeen.get(key);
  if (!at) {
    at = new Date().toISOString();
    firstSeen.set(key, at);
    if (firstSeen.size > 500) firstSeen.delete(firstSeen.keys().next().value ?? "");
  }
  return at;
}

function hostOf(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname || undefined;
  } catch {
    return undefined;
  }
}

export function takeoverKind(request: Pick<BrowserTakeoverRequest, "secret" | "reason">): AgentAttentionKind {
  return request.secret ? "secret" : request.reason === "sign-in-blocked" ? "sign-in" : "browser-takeover";
}

/**
 * Every request that waits for the user: the host's list, and each request that the client holds and
 * the list does not name (a host without `attention-items-v1`, or an event that came first). Oldest
 * first.
 */
export function needsYouItems(sources: NeedsYouSources, now = Date.now()): AgentAttentionItem[] {
  const items = new Map<string, AgentAttentionItem>();
  for (const item of sources.items ?? []) items.set(agentAttentionKey(item), item);
  const add = (item: Omit<AgentAttentionItem, "createdAt">) => {
    const key = agentAttentionKey(item);
    if (items.has(key)) return;
    const at = seenAt(key);
    // Where the host sends its list, a request that it still does not name after a while ended there:
    // its end event was lost. It does not wait for the user any more.
    if (sources.items && now - Date.parse(at) > HOST_LIST_GRACE_MS) return;
    items.set(key, { ...item, createdAt: at });
  };
  for (const prompt of sources.prompts) {
    const question = prompt.questions?.some((entry) => entry.isSecret) ? undefined : prompt.questions?.[0]?.question;
    add({
      kind: "question",
      requestId: prompt.requestId,
      agentId: prompt.agentId,
      threadId: prompt.threadId,
      turnId: prompt.turnId,
      ...(question ? { summary: question } : {}),
    });
  }
  for (const approval of sources.approvals)
    add({
      kind: "approval",
      requestId: approval.requestId,
      agentId: approval.agentId,
      threadId: approval.threadId,
      turnId: approval.turnId,
    });
  for (const request of sources.takeovers) {
    const origin = hostOf(request.secret?.origin);
    add({
      kind: takeoverKind(request),
      requestId: request.requestId,
      agentId: request.agentId,
      threadId: request.threadId,
      turnId: request.turnId,
      ...(origin ? { origin } : {}),
    });
  }
  return [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

const ACTION_KEY = {
  question: "workspace.needsYou.action.question",
  form: "workspace.needsYou.action.form",
  "api-key": "workspace.needsYou.action.apiKey",
  approval: "workspace.needsYou.action.approval",
  "browser-takeover": "workspace.needsYou.action.takeover",
  "sign-in": "workspace.needsYou.action.signIn",
  secret: "workspace.needsYou.action.secret",
} as const satisfies Record<AgentAttentionKind, string>;

const ACTION_AT_KEY = {
  "browser-takeover": "workspace.needsYou.action.takeoverAt",
  "sign-in": "workspace.needsYou.action.signInAt",
  secret: "workspace.needsYou.action.secretAt",
} as const;

/** What the user does for a request, in a few words: "Sign in on accounts.google.com", "Answer a question". */
export function needsYouAction(
  item: Pick<AgentAttentionItem, "kind" | "origin" | "turnId" | "url">,
  t: TextValue["t"],
): string {
  if (isTicketAttention(item)) return t("workspace.needsYou.action.ticket");
  if (item.origin && (item.kind === "browser-takeover" || item.kind === "sign-in" || item.kind === "secret"))
    return t(ACTION_AT_KEY[item.kind], { site: item.origin });
  return t(ACTION_KEY[item.kind]);
}

/** One line of a request: what the user does, then what the agent asks, when it is not the same. */
export function needsYouDetail(item: AgentAttentionItem, t: TextValue["t"]): string {
  const action = needsYouAction(item, t);
  return item.summary ? `${action}: ${item.summary}` : action;
}

/**
 * The sidebar attention with each agent that waits in its own chat marked as waiting, where the
 * client holds none of its requests: the request is in the host's list only. A takeover names what
 * the user does.
 */
export function withAttentionItems<P, A>(
  attention: {
    pendingPrompts: Record<string, P | SidebarAttention | undefined>;
    pendingApprovals: Record<string, A | SidebarApproval | undefined>;
  },
  items: readonly AgentAttentionItem[],
  agents: readonly Pick<AgentProfile, "id" | "threadId">[],
  t: TextValue["t"],
): {
  pendingPrompts: Record<string, P | SidebarAttention | undefined>;
  pendingApprovals: Record<string, A | SidebarApproval | undefined>;
} {
  if (items.length === 0) return attention;
  const threads = new Map(agents.map((agent) => [agent.id, agent.threadId]));
  const pendingPrompts = { ...attention.pendingPrompts };
  const pendingApprovals = { ...attention.pendingApprovals };
  for (const item of items) {
    if (threads.get(item.agentId) !== item.threadId) continue;
    if (pendingPrompts[item.agentId] || pendingApprovals[item.agentId]) {
      // A takeover that the client holds still says what the user does.
      const held = pendingPrompts[item.agentId];
      if (isTakeoverAttention(held) && !held.detail && isTakeoverKind(item.kind))
        pendingPrompts[item.agentId] = { ...held, detail: needsYouAction(item, t) };
      continue;
    }
    if (item.kind === "approval") pendingApprovals[item.agentId] = { turnId: item.turnId };
    else if (isTakeoverKind(item.kind))
      pendingPrompts[item.agentId] = {
        type: "browser-takeover-requested",
        request: { turnId: item.turnId },
        detail: needsYouAction(item, t),
      };
    else
      pendingPrompts[item.agentId] = {
        type: "prompt",
        turnId: item.turnId,
        questions: [{ question: item.summary ?? needsYouAction(item, t) }],
      };
  }
  return { pendingPrompts, pendingApprovals };
}

function isTakeoverKind(kind: AgentAttentionKind): boolean {
  return kind === "browser-takeover" || kind === "sign-in" || kind === "secret";
}

function isTakeoverAttention(
  value: unknown,
): value is Extract<SidebarAttention, { type: "browser-takeover-requested" }> {
  return typeof value === "object" && value !== null && "type" in value && value.type === "browser-takeover-requested";
}

/**
 * The requests that wait in a channel thread, as the channel waits read them: the ones the client
 * does not hold already.
 */
export function attentionChannelRequests(
  items: readonly AgentAttentionItem[],
  t: TextValue["t"],
): {
  prompts: { agentId: string; threadId: string; questions: { question: string }[] }[];
  takeovers: { agentId: string; threadId: string; detail: string }[];
  approvals: { agentId: string; threadId: string }[];
} {
  return {
    prompts: items
      .filter((item) => item.kind === "question" || item.kind === "form" || item.kind === "api-key")
      .map((item) => ({
        agentId: item.agentId,
        threadId: item.threadId,
        questions: [{ question: item.summary ?? needsYouAction(item, t) }],
      })),
    takeovers: items
      .filter((item) => isTakeoverKind(item.kind))
      .map((item) => ({ agentId: item.agentId, threadId: item.threadId, detail: needsYouAction(item, t) })),
    approvals: items
      .filter((item) => item.kind === "approval")
      .map((item) => ({ agentId: item.agentId, threadId: item.threadId })),
  };
}
