import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button } from "../../button";
import { Dialog, Popover } from "../../complex";
import { Cpu, Gauge, Globe2, MessageSquare, Server, Settings, Terminal } from "../../icons";
import { type TextValue, useText } from "../../text";
import { cx, usesTouchLayout } from "../../utils";
import { AiBadge, MemberAvatar, presenceLabelKey } from "./WorkspaceAvatar";
import type { AgentComputerPart, AgentWorkStatus, WorkspaceMember } from "./workspace-types";

const COMPUTER_PART = {
  browser: { label: "workspace.profile.computer.browser", icon: Globe2 },
  shell: { label: "workspace.profile.computer.shell", icon: Terminal },
  bench: { label: "workspace.profile.computer.bench", icon: Gauge },
  hosting: { label: "workspace.profile.computer.hosting", icon: Server },
} as const;

const ROLE_LABEL = {
  owner: "workspace.role.owner",
  admin: "workspace.role.admin",
  member: "workspace.role.member",
} as const;

export type WorkspaceRole = keyof typeof ROLE_LABEL;

/** The text key of a human's role. */
export function roleLabelKey(role: WorkspaceRole) {
  return ROLE_LABEL[role];
}

export interface MemberProfileCardProps {
  member: WorkspaceMember;
  /** A human's role in the workspace. */
  workspaceRole?: WorkspaceRole | undefined;
  /** An agent's title, such as "Game Designer", or a human's job title. */
  title?: string | undefined;
  /** An agent's description. */
  description?: string | undefined;
  /** An agent's model, as the provider names it. */
  model?: string | undefined;
  /** What an agent does now. */
  status?: AgentWorkStatus | undefined;
  /** The parts of its computer that an agent can use. */
  computer?: readonly AgentComputerPart[] | undefined;
  onMessage?: (() => void) | undefined;
  onSettings?: (() => void) | undefined;
  class?: string;
}

/** The profile of a human or an agent, as the popover over a name shows it. */
export function MemberProfileCard(props: MemberProfileCardProps): JSX.Element {
  const { t } = useText();
  const isAgent = () => props.member.kind === "agent";
  return (
    <section class={cx("ws-profile-card", props.class)} aria-label={props.member.name}>
      <div class="ws-profile-card-banner" data-kind={props.member.kind}>
        <MemberAvatar member={props.member} size="xl" showStatus animate />
      </div>
      <div class="ws-profile-card-body">
        <div class="ws-profile-card-name">
          <strong>{props.member.name}</strong>
          <Show when={isAgent()}>
            <AiBadge />
          </Show>
        </div>
        <Show when={props.title}>
          <p class="ws-profile-card-title">{props.title}</p>
        </Show>
        <Show
          when={isAgent()}
          fallback={
            <p class="ws-profile-card-presence">
              <span class="ws-status-dot ws-status-dot-inline" data-state={props.member.presence ?? "offline"} />
              {t(presenceLabelKey(props.member.presence))}
              <Show when={props.workspaceRole}>
                {(role) => (
                  <>
                    <span aria-hidden="true">·</span>
                    {t(ROLE_LABEL[role()])}
                  </>
                )}
              </Show>
            </p>
          }
        >
          <Show when={props.status}>{(status) => <AgentStatusLine status={status()} />}</Show>
          <Show when={props.description}>
            <p class="ws-profile-card-description">{props.description}</p>
          </Show>
          <Show when={props.model}>
            <p class="ws-profile-card-model">
              <Cpu aria-hidden="true" />
              {props.model}
            </p>
          </Show>
          <Show when={props.computer?.length}>
            <div class="ws-profile-card-computer">
              <span class="ws-profile-card-label">{t("workspace.profile.computer")}</span>
              <ul class="ws-chip-list">
                <For each={props.computer ?? []}>
                  {(part) => {
                    const Icon = COMPUTER_PART[part].icon;
                    return (
                      <li class="ws-chip">
                        <Icon aria-hidden="true" />
                        {t(COMPUTER_PART[part].label)}
                      </li>
                    );
                  }}
                </For>
              </ul>
            </div>
          </Show>
        </Show>
        <div class="ws-profile-card-actions">
          <Show when={props.onMessage}>
            {(message) => (
              <Button variant="secondary" size="sm" onClick={() => message()()}>
                <MessageSquare aria-hidden="true" />
                {t("workspace.profile.message")}
              </Button>
            )}
          </Show>
          <Show when={props.onSettings}>
            {(settings) => (
              <Button variant="ghost" size="sm" onClick={() => settings()()}>
                <Settings aria-hidden="true" />
                {t("workspace.profile.settings")}
              </Button>
            )}
          </Show>
        </div>
      </div>
    </section>
  );
}

/** "Working on the level editor in #cakemaker", "Waiting for delynith" or "Idle". */
export function agentStatusText(status: AgentWorkStatus, text: Pick<TextValue, "t" | "format">): string {
  const { t, format } = text;
  if (status.state === "working") {
    return status.channelName
      ? t("workspace.agent.workingIn", { task: status.task, channel: status.channelName })
      : t("workspace.agent.working", { task: status.task });
  }
  if (status.state === "waiting" && status.usageLimit) {
    const resetsAt = status.usageLimit.resetsAt;
    return resetsAt
      ? t("workspace.agent.usageLimitUntil", { time: format.date(resetsAt, { timeStyle: "short" }) })
      : t("workspace.agent.usageLimit");
  }
  if (status.state === "waiting") {
    return status.channelName
      ? t("workspace.agent.waitingIn", { name: status.personName, channel: status.channelName })
      : t("workspace.agent.waiting", { name: status.personName });
  }
  return t("workspace.agent.idle");
}

/** The agent's state as a line with a dot: what it works on, whom it waits for, or idle. */
export function AgentStatusLine(props: { status: AgentWorkStatus; class?: string }): JSX.Element {
  const text = useText();
  const line = () => agentStatusText(props.status, text);
  return (
    <p class={cx("ws-agent-status", props.class)} data-state={props.status.state}>
      <span class="ws-agent-status-dot" aria-hidden="true" />
      <span class="ws-truncate">{line()}</span>
    </p>
  );
}

export interface MemberProfilePopoverProps {
  /**
   * Draws the card that opens. It runs only when the popover opens, so a long message list does not
   * build a card for each row. Without it the trigger is plain content.
   */
  card?: (() => JSX.Element) | undefined;
  /** The accessible name of the trigger, such as "Open the profile of QA". */
  label: string;
  children: JSX.Element;
  class?: string;
}

/**
 * Makes an avatar or a name open a profile card. A touch screen opens it in a sheet from the bottom
 * edge, as Slack's app does: a popover beside the avatar went off the right edge of a phone.
 */
export function MemberProfilePopover(props: MemberProfilePopoverProps): JSX.Element {
  const touch = usesTouchLayout();
  return (
    <Show when={props.card} fallback={<span class={cx("ws-profile-trigger", props.class)}>{props.children}</span>}>
      <Show when={!touch} fallback={<ProfileSheet {...props} />}>
        <ProfilePopover {...props} />
      </Show>
    </Show>
  );
}

/** The card in a sheet from the bottom edge, the form of `ActionSheet` with the card as its content. */
function ProfileSheet(props: MemberProfilePopoverProps): JSX.Element {
  return (
    <Dialog.Root>
      <Dialog.Trigger class={cx("ws-profile-trigger", props.class)} aria-label={props.label}>
        {props.children}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay class="ui-sheet-overlay">
          <Dialog.Content class="ui-sheet ws-profile-sheet">
            <span class="ui-sheet-handle" aria-hidden="true" />
            <Dialog.Title class="sr-only">{props.label}</Dialog.Title>
            {props.card?.()}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProfilePopover(props: MemberProfilePopoverProps): JSX.Element {
  return (
    <Show when={props.card}>
      <Popover.Root placement="right-start" gutter={8}>
        <Popover.Trigger class={cx("ws-profile-trigger", props.class)} aria-label={props.label}>
          {props.children}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="ui-popover-menu-surface ws-profile-popover">{props.card?.()}</Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Show>
  );
}
