import { agentProviderName } from "@openbot/contracts/agent-providers";
import {
  type AgentEvent,
  type AgentInputEscalation,
  type ClientAgentSummary,
  inputEscalationOf,
  inputEscalationRoot,
  type ServerNotificationLevel,
  type TeamRealtimeEvent,
} from "@openbot/contracts/ipc";
import { markdownPreviewText } from "@openbot/contracts/markdown-preview-text";
import type { AppFormat, AppTranslate } from "@openbot/i18n";
import { cleanAgentMessageText } from "./agent-message-text";
import { isUnattendedFailure, unattendedFailureSubject } from "./unattended-failure-notification";

export { UNATTENDED_FAILURE_ERROR_CODES } from "./unattended-failure-notification";

export interface AgentNotificationContent {
  title: string;
  body: string;
  agentId: string;
  threadId: string | null;
  /** The channel whose thread the event came from. A click opens the channel, not the agent chat. */
  channelId?: string;
}

/** The channel that owns the thread of an event, as the caller found it. */
export interface AgentNotificationChannel {
  id: string;
  name: string;
}

/**
 * The one notice for a provider plan limit, at every level but "nothing". It is about the account,
 * so the switch of the agent whose turn found the limit does not silence it.
 */
export function notificationForUsageLimit(
  event: Extract<AgentEvent, { type: "usage-limit-reached" }>,
  agents: ClientAgentSummary[],
  translate: AppTranslate,
  format: AppFormat,
  level: ServerNotificationLevel,
): AgentNotificationContent | null {
  if (level === "nothing") return null;
  const count = event.agentCount;
  // A weekly window can reset days later, so a reset that is not today names its day.
  const resetDate = event.resetsAt === null ? null : new Date(event.resetsAt * 1_000);
  const reset =
    resetDate === null
      ? null
      : format.date(resetDate, {
          ...(resetDate.toDateString() === new Date().toDateString() ? {} : { weekday: "short" }),
          hour: "numeric",
          minute: "2-digit",
        });
  return {
    title: translate("notification.usageLimit.title", { provider: agentProviderName(event.provider) }),
    body: reset
      ? translate("notification.usageLimit.bodyResets", { count, reset })
      : translate("notification.usageLimit.body", { count }),
    agentId: event.agentId,
    threadId: agents.find((agent) => agent.id === event.agentId)?.threadId ?? null,
  };
}

/**
 * The words of the agent that a notification may show. Without it, a notification shows only a
 * fixed text, so a shared screen or the Lock Screen shows no part of a conversation.
 */
export interface AgentNotificationPreview {
  /** The answer of the finished turn, as the agent wrote it, or null when the caller has none. */
  reply: string | null;
  /**
   * Hides the secrets in the text, because the Lock Screen can show it. The caller supplies it:
   * this package runs in a browser and in React Native, without the log redaction.
   */
  redact: (text: string) => string;
}

/** About three lines of a macOS notification. The system cuts a longer body itself. */
const PREVIEW_LIMIT = 200;
/** The start of a reply that the preview reads, so that a long reply is not parsed in full. */
const REPLY_READ_LIMIT = 2_000;

/** A message or a routine run that the provider refused to start. No turn records the failure. */
const START_FAILED_CODE = "delivery_start_failed";

/**
 * The agent events that `notificationForAgentEvent` can show. Desktop, web and phone pass only these,
 * so each surface notifies about the same kinds.
 */
export function agentEventCanNotify(event: AgentEvent | TeamRealtimeEvent): boolean {
  switch (event.type) {
    case "prompt":
    case "approval":
    case "browser-takeover-requested":
      return true;
    case "turn-completed":
      return event.status === "completed" || event.status === "failed";
    case "error":
      return (event.code === START_FAILED_CODE || isUnattendedFailure(event)) && event.agentId !== undefined;
    default:
      return false;
  }
}

/**
 * The request that a notification waits for, or that an event resolves, so that an answer from any
 * device withdraws the notification. Null for an event that is not a request.
 */
export function notificationRequestKey(serverId: string, event: AgentEvent): string | null {
  switch (event.type) {
    case "prompt":
      return `${serverId}:${event.agentId}:prompt:${event.requestId}`;
    case "approval":
      return `${serverId}:${event.approval.agentId}:approval:${event.approval.requestId}`;
    case "agent-input-resolved":
      return `${serverId}:${event.agentId}:${event.kind}:${event.requestId}`;
    case "browser-takeover-requested":
      return `${serverId}:${event.request.agentId}:browser:${event.request.requestId}`;
    case "browser-takeover-resolved":
      return `${serverId}:${event.agentId}:browser:${event.requestId}`;
    default:
      return null;
  }
}

/**
 * Whether the event waits for the user, or reports a failure of unattended work that nobody watches,
 * so that the "needs-me" level keeps it.
 */
export function agentEventNeedsUser(event: AgentEvent): boolean {
  return (
    event.type === "prompt" ||
    event.type === "approval" ||
    event.type === "browser-takeover-requested" ||
    isUnattendedFailure(event)
  );
}

/**
 * The agent whose chat shows the request of this event for its teammate: the root of the delegation
 * chain, which the user talks to. Null for any other event, and for a request that no agent delegated.
 */
export function inputEscalationDelegator(
  escalations: readonly AgentInputEscalation[],
  event: AgentEvent,
): string | null {
  const found =
    event.type === "prompt"
      ? inputEscalationOf(escalations, "prompt", event.agentId, event.requestId)
      : event.type === "approval"
        ? inputEscalationOf(escalations, "approval", event.approval.agentId, event.approval.requestId)
        : event.type === "browser-takeover-requested"
          ? inputEscalationOf(escalations, "browser-takeover", event.request.agentId, event.request.requestId)
          : undefined;
  return found ? inputEscalationRoot(found) : null;
}

/** The thread that an event waits on, or null when it is not a request. A channel can own that thread. */
export function agentEventRequestThread(event: AgentEvent): string | null {
  if (event.type === "prompt") return event.threadId;
  if (event.type === "approval") return event.approval.threadId;
  if (event.type === "browser-takeover-requested") return event.request.threadId;
  return null;
}

/**
 * What a server's agent event says to the user, or null when the server level or the agent's own
 * switch keeps it quiet. "needs-me" keeps only the events that wait for the user, and the failures of
 * unattended work. A completed turn after which the agent has more work says nothing: the notice comes
 * with the turn that leaves it idle. `channel` is the channel that owns the thread of the event (see
 * `agentEventRequestThread`): the title then names it.
 */
export function notificationForAgentEvent(
  event: AgentEvent,
  agents: ClientAgentSummary[],
  translate: AppTranslate,
  level: ServerNotificationLevel,
  preview: AgentNotificationPreview | null = null,
  channel: AgentNotificationChannel | null = null,
  delegatorAgentId: string | null = null,
): AgentNotificationContent | null {
  if (level === "nothing") return null;
  const subject = notificationSubject(event, level, translate, preview);
  if (!subject) return null;
  const agent = agents.find((candidate) => candidate.id === subject.agentId);
  // A request of a teammate that works for another agent shows in the chat of that agent, which the
  // user talks to. The notice names both and opens that chat. That agent's switch decides it too: a
  // background teammate starts with its notifications off, and the user never opens its chat.
  const delegator =
    delegatorAgentId && agentEventNeedsUser(event)
      ? agents.find((candidate) => candidate.id === delegatorAgentId)
      : undefined;
  if (agent && delegator && (delegator.notifications || agent.notifications))
    return {
      title: translate("notification.teammateTitle", { agent: delegator.name, teammate: agent.name }),
      ...subject,
      agentId: delegator.id,
      threadId: delegator.threadId,
    };
  if (!agent?.notifications) return null;
  if (channel)
    return {
      title: translate("notification.channelTitle", { agent: agent.name, channel: channel.name }),
      ...subject,
      channelId: channel.id,
    };
  // A start failure names no thread, so it opens the agent's own chat.
  return { title: agent.name, ...subject, threadId: subject.threadId ?? agent.threadId ?? null };
}

function notificationSubject(
  event: AgentEvent,
  level: ServerNotificationLevel,
  translate: AppTranslate,
  preview: AgentNotificationPreview | null,
): Omit<AgentNotificationContent, "title"> | null {
  if (event.type === "prompt") {
    // A secret question asks for a password or a key, so even its wording stays off the lock screen.
    const question =
      preview && !event.questions.some((candidate) => candidate.isSecret) && event.questions[0]?.question;
    const body = (question && plainPreview(preview.redact(question))) || translate("notification.needsInput");
    return { body, agentId: event.agentId, threadId: event.threadId };
  }
  if (event.type === "approval") {
    const { agentId, threadId, kind, command, reason } = event.approval;
    // A command keeps its characters; a reason is Markdown, as a reply is.
    const action = !preview
      ? null
      : kind === "command" && command
        ? previewText(preview.redact(command))
        : reason && plainPreview(preview.redact(reason));
    const body = action
      ? translate("notification.needsApprovalFor", { action })
      : translate("notification.needsApproval");
    return { body, agentId, threadId };
  }
  if (event.type === "browser-takeover-requested") {
    const { agentId, threadId } = event.request;
    return { body: translate("notification.needsBrowserStep"), agentId, threadId };
  }
  // Nobody watches unattended work, so its failure shows at the "needs-me" level too.
  const unattended = unattendedFailureSubject(event, translate);
  if (unattended) return unattended;
  if (level !== "all") return null;
  if (event.type === "error" && event.agentId && agentEventCanNotify(event))
    return { body: translate("notification.failed"), agentId: event.agentId, threadId: null };
  // A quiet routine run posted nothing, so there is nothing to look at.
  if (event.type !== "turn-completed" || event.quiet) return null;
  // The agent goes on with queued work or waits for a teammate, so this turn is not the end.
  if (event.moreWork && event.status === "completed") return null;
  const { agentId, threadId } = event;
  if (event.status === "completed") {
    // Redact before the cut and the Markdown change the shape of a secret.
    const reply = preview?.reply && plainPreview(preview.redact(preview.reply).slice(0, REPLY_READ_LIMIT));
    return { body: reply || translate("notification.finished"), agentId, threadId };
  }
  // An interrupted turn is one the user stopped, so it is not news.
  if (event.status === "failed") return { body: translate("notification.failed"), agentId, threadId };
  return null;
}

/** Agent Markdown as plain text, cut to the preview length. */
export function plainPreview(text: string): string | null {
  return previewText(markdownPreviewText(cleanAgentMessageText(text)));
}

/** The text as one line, cut to the preview length, or null when nothing is left. */
function previewText(text: string): string | null {
  const characters = Array.from(text.replace(/\s+/gu, " ").trim());
  if (characters.length === 0) return null;
  if (characters.length <= PREVIEW_LIMIT) return characters.join("");
  return `${characters
    .slice(0, PREVIEW_LIMIT - 1)
    .join("")
    .trimEnd()}…`;
}
