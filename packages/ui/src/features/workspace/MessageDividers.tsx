import type { AppTranslate } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { Match, Switch } from "solid-js";
import { Bot, Hash, LogIn, LogOut, Pencil, TextQuote, UserRoundPlus } from "../../icons";
import { useText } from "../../text";
import { MemberAvatar } from "./WorkspaceAvatar";
import { useMessageTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

/** The sticky date between the days of a channel: "Today", "Yesterday" or "Monday, October 27th". */
export function DayDivider(props: { date: number; now?: number | undefined }): JSX.Element {
  const { t, format } = useText();
  const label = () => {
    const now = new Date(props.now ?? Date.now());
    const day = new Date(props.date);
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (day.toDateString() === now.toDateString()) return t("workspace.day.today");
    if (day.toDateString() === yesterday.toDateString()) return t("workspace.day.yesterday");
    const sameYear = day.getFullYear() === now.getFullYear();
    return format.date(props.date, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
    });
  };
  return (
    <div class="ws-day-divider">
      <span class="ws-day-divider-label">{label()}</span>
    </div>
  );
}

/** The line above the first message that the reader has not read. */
export function NewMessagesDivider(): JSX.Element {
  const { t } = useText();
  return (
    <div class="ws-new-divider">
      <span class="ws-new-divider-label">{t("workspace.divider.new")}</span>
    </div>
  );
}

/** The "N replies" line between a thread root and its replies. */
export function RepliesDivider(props: { count: number }): JSX.Element {
  const { t } = useText();
  return (
    <div class="ws-replies-divider">
      <span>{t("workspace.thread.replies", { count: props.count })}</span>
    </div>
  );
}

export type SystemEventKind =
  | { kind: "joined" }
  | { kind: "left" }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "topic"; topic: string }
  | { kind: "agent-added"; agent: WorkspaceMember }
  | { kind: "member-added"; member: WorkspaceMember }
  | { kind: "created"; name: string };

export interface SystemEventProps {
  actor: WorkspaceMember;
  event: SystemEventKind;
  at: number;
}

/** A quiet row for a channel event: a join, a rename, a new topic or an agent that was added. */
export function SystemEvent(props: SystemEventProps): JSX.Element {
  const { t } = useText();
  const time = useMessageTime();
  const event = () => props.event;
  return (
    <div class="ws-system-event">
      <span class="ws-system-event-icon" aria-hidden="true">
        <Switch fallback={<Hash />}>
          <Match when={event().kind === "joined"}>
            <LogIn />
          </Match>
          <Match when={event().kind === "left"}>
            <LogOut />
          </Match>
          <Match when={event().kind === "renamed"}>
            <Pencil />
          </Match>
          <Match when={event().kind === "topic"}>
            <TextQuote />
          </Match>
          <Match when={event().kind === "agent-added"}>
            <Bot />
          </Match>
          <Match when={event().kind === "member-added"}>
            <UserRoundPlus />
          </Match>
        </Switch>
      </span>
      <MemberAvatar member={props.actor} size="xs" />
      <p class="ws-system-event-text">{systemText(event(), props.actor.name, t)}</p>
      <time class="ws-system-event-time" datetime={new Date(props.at).toISOString()}>
        {time(props.at)}
      </time>
    </div>
  );
}

function systemText(event: SystemEventKind, name: string, t: AppTranslate): string {
  switch (event.kind) {
    case "joined":
      return t("workspace.event.joined", { name });
    case "left":
      return t("workspace.event.left", { name });
    case "renamed":
      return t("workspace.event.renamed", { name, from: event.from, to: event.to });
    case "topic":
      return t("workspace.event.topic", { name, topic: event.topic });
    case "agent-added":
      return t("workspace.event.agentAdded", { name, agent: event.agent.name });
    case "member-added":
      return t("workspace.event.memberAdded", { name, member: event.member.name });
    case "created":
      return t("workspace.event.created", { name, channel: event.name });
  }
}
