import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useText } from "../../text";
import { UserAvatar } from "../../user-avatar";
import { cx } from "../../utils";
import { AgentAvatar } from "../agents/AgentAvatar";
import type { WorkspaceMember, WorkspacePresence } from "./workspace-types";

export type WorkspaceAvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const PRESENCE_LABEL = {
  active: "workspace.presence.active",
  away: "workspace.presence.away",
  offline: "workspace.presence.offline",
} as const;

export interface MemberAvatarProps {
  member: WorkspaceMember;
  size?: WorkspaceAvatarSize;
  /** Shows the presence dot of a human, or the working dot of an agent. */
  showStatus?: boolean;
  /** Lets a working agent fly its rings. Off in long lists. */
  animate?: boolean;
  class?: string;
}

/**
 * A member's face. A human has a rounded square with a photo or initials, as in Slack; an agent
 * keeps its round generated face, so a reader tells the two apart at a glance.
 */
export function MemberAvatar(props: MemberAvatarProps): JSX.Element {
  const size = () => props.size ?? "md";
  return (
    <span class={cx("ws-avatar", props.class)} data-size={size()} data-kind={props.member.kind} aria-hidden="true">
      <Show
        when={props.member.kind === "agent"}
        fallback={
          <UserAvatar
            class="ws-avatar-human"
            decorative
            user={{ name: props.member.name, email: "", avatarUrl: props.member.avatarUrl ?? null }}
          />
        }
      >
        <AgentAvatar
          class="ws-avatar-agent"
          seed={props.member.avatarSeed ?? props.member.id}
          hue={props.member.avatarHue ?? null}
          url={props.member.avatarUrl ?? null}
          motion="idle"
          mood={props.animate && props.member.working ? "working" : "idle"}
        />
      </Show>
      <Show when={props.showStatus}>
        <StatusDot member={props.member} />
      </Show>
    </span>
  );
}

function StatusDot(props: { member: WorkspaceMember }): JSX.Element {
  const state = () => {
    if (props.member.kind === "agent") return props.member.working ? "working" : undefined;
    return props.member.presence ?? "offline";
  };
  return (
    <Show when={state()}>{(current) => <span class="ws-status-dot" data-state={current()} aria-hidden="true" />}</Show>
  );
}

/** The presence of a human, as text for a screen reader or a profile. */
export function presenceLabelKey(presence: WorkspacePresence | undefined) {
  return PRESENCE_LABEL[presence ?? "offline"];
}

export interface AvatarStackProps {
  members: readonly WorkspaceMember[];
  /** How many faces show before the rest become a count. */
  max?: number;
  size?: WorkspaceAvatarSize;
  /** The full count when `members` is only the first page. */
  total?: number;
  class?: string;
}

/** Overlapping faces, as in a face pile or a group DM. */
export function AvatarStack(props: AvatarStackProps): JSX.Element {
  const max = () => props.max ?? 3;
  const shown = () => props.members.slice(0, max());
  const rest = () => (props.total ?? props.members.length) - shown().length;
  return (
    <span class={cx("ws-avatar-stack", props.class)} data-size={props.size ?? "sm"} aria-hidden="true">
      <For each={shown()}>{(member) => <MemberAvatar member={member} size={props.size ?? "sm"} />}</For>
      <Show when={rest() > 0}>
        <span class="ws-avatar-stack-more">+{rest()}</span>
      </Show>
    </span>
  );
}

/** The "AI" mark next to an agent's name. */
export function AiBadge(props: { class?: string }): JSX.Element {
  const { t } = useText();
  return (
    <span class={cx("ws-ai-badge", props.class)} title={t("workspace.member.aiTitle")}>
      {t("workspace.member.ai")}
    </span>
  );
}

/** The mark next to a person from a bridged service. */
export function ExternalBadge(props: { class?: string }): JSX.Element {
  const { t } = useText();
  return <span class={cx("ws-ai-badge ws-external-badge", props.class)}>{t("workspace.member.external")}</span>;
}

/** A name with the AI or external mark that its kind needs. */
export function MemberName(props: { member: WorkspaceMember; class?: string }): JSX.Element {
  return (
    <span class={cx("ws-member-name", props.class)}>
      <span class="ws-member-name-text">{props.member.name}</span>
      <Show when={props.member.kind === "agent"}>
        <AiBadge />
      </Show>
      <Show when={props.member.external}>
        <ExternalBadge />
      </Show>
    </span>
  );
}
