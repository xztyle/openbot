import { agentProviderName } from "@openbot/contracts/agent-providers";
import type { AgentEvent, AgentSummary, ServerNotificationLevel } from "@openbot/contracts/ipc";
import type { AppFormat, AppTranslate } from "@openbot/i18n";
import { unattendedFailureSubject } from "./unattended-failure-notification";

export { UNATTENDED_FAILURE_ERROR_CODES } from "./unattended-failure-notification";

export interface AgentNotificationContent {
  title: string;
  body: string;
  agentId: string;
  threadId: string | null;
}

/**
 * The one notice for a provider plan limit, at every level but "nothing". It is about the account,
 * so the switch of the agent whose turn found the limit does not silence it.
 */
export function notificationForUsageLimit(
  event: Extract<AgentEvent, { type: "usage-limit-reached" }>,
  agents: AgentSummary[],
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

export interface AgentNotificationOptions {
  /**
   * Puts the question or the approval reason in the body. Off by default: a notification can show on
   * a lock screen. `redact` is required with it, and runs on the text before it is shortened.
   */
  detail?: { redact(text: string): string } | undefined;
}

/** The longest question or reason a body shows. A notification is one glance, not a document. */
const DETAIL_LIMIT = 160;

/**
 * What a server's agent event says to the user, or null when the server level or the agent's own
 * switch keeps it quiet. "needs-me" keeps only the events that wait for the user. A completed turn
 * after which the agent has more work says nothing: the notice comes with the turn that leaves it idle.
 */
export function notificationForAgentEvent(
  event: AgentEvent,
  agents: AgentSummary[],
  translate: AppTranslate,
  level: ServerNotificationLevel,
  options: AgentNotificationOptions = {},
): AgentNotificationContent | null {
  if (level === "nothing") return null;
  const subject = notificationSubject(event, level, translate, options);
  if (!subject) return null;
  const agent = agents.find((candidate) => candidate.id === subject.agentId);
  if (!agent?.notifications) return null;
  return { title: agent.name, ...subject };
}

/** One line of redacted text, cut at a word where it is long. Empty when there is nothing to show. */
function detailLine(text: string | null | undefined, redact: (text: string) => string): string {
  const line = redact(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (line.length <= DETAIL_LIMIT) return line;
  const cut = line.slice(0, DETAIL_LIMIT);
  const word = cut.lastIndexOf(" ");
  return `${(word > DETAIL_LIMIT / 2 ? cut.slice(0, word) : cut).trimEnd()}…`;
}

function notificationSubject(
  event: AgentEvent,
  level: ServerNotificationLevel,
  translate: AppTranslate,
  options: AgentNotificationOptions,
): Omit<AgentNotificationContent, "title"> | null {
  if (event.type === "prompt") {
    // A secret question asks for a password or a key, so even its wording stays off the lock screen.
    const [question] = event.questions;
    const detail =
      options.detail && question && !event.questions.some((candidate) => candidate.isSecret)
        ? detailLine(question.question, options.detail.redact)
        : "";
    return {
      body: detail || translate("notification.needsInput"),
      agentId: event.agentId,
      threadId: event.threadId,
    };
  }
  if (event.type === "approval") {
    const { agentId, threadId } = event.approval;
    // The reason only: the command can hold a secret that no pattern recognizes.
    const detail = options.detail ? detailLine(event.approval.reason, options.detail.redact) : "";
    return { body: detail || translate("notification.needsApproval"), agentId, threadId };
  }
  const unattended = unattendedFailureSubject(event, translate);
  if (unattended) return unattended;
  // A quiet routine run posted nothing, so there is nothing to look at.
  if (event.type !== "turn-completed" || level !== "all" || event.quiet) return null;
  // The agent goes on with queued work or waits for a teammate, so this turn is not the end.
  if (event.moreWork && event.status === "completed") return null;
  const { agentId, threadId } = event;
  if (event.status === "completed") return { body: translate("notification.finished"), agentId, threadId };
  // An interrupted turn is one the user stopped, so it is not news.
  if (event.status === "failed") return { body: translate("notification.failed"), agentId, threadId };
  return null;
}
