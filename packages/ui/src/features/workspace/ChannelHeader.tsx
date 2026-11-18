import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { Button, buttonVariants, IconButton } from "../../button";
import { DropdownMenu } from "../../complex";
import { Bell, BellOff, Check, ChevronLeft, Hash, Info, LayoutDashboard, Lock, MessageSquareText } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AiBadge, AvatarStack, MemberAvatar } from "./WorkspaceAvatar";
import type { ChannelVisibility, ConversationKind, WorkspaceMember } from "./workspace-types";

/** The right panel that a header button opens, to show its pressed state. */
export type ChannelHeaderPanel = "details" | "threads" | "artifacts";

/** The bell's choice for one conversation. `default`: the reader's level for the server applies. */
export type ChannelNotifyChoice = "default" | "all" | "mentions" | "nothing";

const NOTIFY_CHOICES = [
  { value: "default", label: "workspace.header.notifyDefault" },
  { value: "all", label: "workspace.header.notifyAll" },
  { value: "mentions", label: "workspace.header.notifyMentions" },
  { value: "nothing", label: "workspace.header.notifyNothing" },
] as const satisfies readonly { value: ChannelNotifyChoice; label: string }[];

function isNotifyChoice(value: string): value is ChannelNotifyChoice {
  return NOTIFY_CHOICES.some((choice) => choice.value === value);
}

export interface ChannelHeaderProps {
  kind: ConversationKind;
  /** The channel name without `#`, or the names of a DM. */
  name: string;
  visibility?: ChannelVisibility | undefined;
  /** The other member of a DM, for its avatar. */
  dmMember?: WorkspaceMember | undefined;
  topic?: string | undefined;
  /** Opens the topic editor. Without it the topic is text only. */
  onEditTopic?: (() => void) | undefined;
  /** The first faces of the member pile. */
  members: readonly WorkspaceMember[];
  memberCount: number;
  onShowMembers?: (() => void) | undefined;
  onShowDetails?: (() => void) | undefined;
  onShowThreads?: (() => void) | undefined;
  onShowArtifacts?: (() => void) | undefined;
  activePanel?: ChannelHeaderPanel | null | undefined;
  /** The reader muted the conversation: the bell shows it and turns it back on. */
  muted?: boolean | undefined;
  onToggleMute?: (() => void) | undefined;
  /** The reader's notification level here. With `onNotifyChange` the bell opens Slack's menu. */
  notify?: ChannelNotifyChoice | undefined;
  /** Absent on a host that keeps no level for each conversation: the bell only mutes. */
  onNotifyChange?: ((choice: ChannelNotifyChoice) => void) | undefined;
  /** A search field, at the right. */
  search?: JSX.Element;
  /** The narrow layout's back button. */
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The header of the message pane: name, topic, member faces and the panel buttons. */
export function ChannelHeader(props: ChannelHeaderProps): JSX.Element {
  const { t } = useText();
  const pressed = (panel: ChannelHeaderPanel) => (props.activePanel === panel ? "true" : "false");
  return (
    <header class={cx("ws-channel-header", props.class)}>
      <Show when={props.onBack}>
        {(back) => (
          <IconButton class="ws-phone-only" variant="ghost" label={t("workspace.layout.back")} onClick={() => back()()}>
            <ChevronLeft />
          </IconButton>
        )}
      </Show>
      <div class="ws-channel-header-identity">
        <h1 class="ws-channel-header-heading">
          <Button
            variant="ghost"
            class="ws-channel-header-name"
            aria-label={t("workspace.header.openDetails", { name: props.name })}
            onClick={() => props.onShowDetails?.()}
            disabled={!props.onShowDetails}
          >
            <Show
              when={props.kind === "channel"}
              fallback={
                <Show when={props.dmMember} fallback={<AvatarStack members={props.members} max={2} size="xs" />}>
                  {(member) => <MemberAvatar member={member()} size="sm" showStatus />}
                </Show>
              }
            >
              <Show
                when={props.visibility === "private"}
                fallback={<Hash class="ws-channel-header-glyph" aria-hidden="true" />}
              >
                <Lock class="ws-channel-header-glyph" aria-hidden="true" />
              </Show>
            </Show>
            <span class="ws-channel-header-title">{props.name}</span>
            <Show when={props.kind === "dm" && props.dmMember?.kind === "agent"}>
              <AiBadge />
            </Show>
          </Button>
        </h1>
        <Show when={props.topic || props.onEditTopic}>
          <Show when={props.onEditTopic} fallback={<span class="ws-channel-header-topic">{props.topic}</span>}>
            {(edit) => (
              <Button
                variant="ghost"
                size="xs"
                class="ws-channel-header-topic ws-channel-header-topic-button"
                data-empty={props.topic ? undefined : ""}
                aria-label={t("workspace.header.editTopic")}
                onClick={() => edit()()}
              >
                {props.topic || t("workspace.header.addTopic")}
              </Button>
            )}
          </Show>
        </Show>
      </div>
      <div class="ws-channel-header-actions">
        <Show when={props.search}>
          <div class="ws-channel-header-search">{props.search}</div>
        </Show>
        <Show when={props.kind !== "dm"}>
          <Button
            variant="outline"
            size="xs"
            class="ws-face-pile"
            aria-label={t("workspace.header.members", { count: props.memberCount })}
            onClick={() => props.onShowMembers?.()}
            disabled={!props.onShowMembers}
          >
            <AvatarStack members={props.members.slice(0, 3)} max={3} size="xs" />
            <span class="ws-face-pile-count">{props.memberCount}</span>
          </Button>
        </Show>
        <Show when={props.onToggleMute}>
          {(toggle) => (
            <Show
              when={props.onNotifyChange}
              fallback={
                <IconButton
                  variant="ghost"
                  class="ws-channel-header-bell"
                  data-muted={props.muted ? "" : undefined}
                  label={t(props.muted ? "workspace.header.unmute" : "workspace.header.mute")}
                  onClick={() => toggle()()}
                >
                  <Show when={props.muted} fallback={<Bell />}>
                    <BellOff />
                  </Show>
                </IconButton>
              }
            >
              {(change) => (
                <NotifyMenu
                  name={props.name}
                  muted={props.muted}
                  notify={props.notify}
                  onToggleMute={toggle()}
                  onNotifyChange={change()}
                />
              )}
            </Show>
          )}
        </Show>
        <Show when={props.onShowThreads}>
          {(open) => (
            <IconButton
              variant="ghost"
              label={t("workspace.view.threads")}
              aria-pressed={pressed("threads")}
              onClick={() => open()()}
            >
              <MessageSquareText />
            </IconButton>
          )}
        </Show>
        <Show when={props.onShowArtifacts}>
          {(open) => (
            <IconButton
              variant="ghost"
              label={t("workspace.view.artifacts")}
              aria-pressed={pressed("artifacts")}
              onClick={() => open()()}
            >
              <LayoutDashboard />
            </IconButton>
          )}
        </Show>
        <Show when={props.onShowDetails}>
          {(open) => (
            <IconButton
              variant="ghost"
              label={t("workspace.header.details")}
              aria-pressed={pressed("details")}
              onClick={() => open()()}
            >
              <Info />
            </IconButton>
          )}
        </Show>
      </div>
    </header>
  );
}

/** Slack's bell: the level of the conversation, then Mute. */
function NotifyMenu(props: {
  name: string;
  muted?: boolean | undefined;
  notify?: ChannelNotifyChoice | undefined;
  onToggleMute: () => void;
  onNotifyChange: (choice: ChannelNotifyChoice) => void;
}): JSX.Element {
  const { t } = useText();
  const choice = () => props.notify ?? "default";
  const quiet = () => props.muted || choice() === "nothing";
  return (
    <DropdownMenu.Root placement="bottom-end" gutter={4}>
      <DropdownMenu.Trigger
        class={cx(buttonVariants({ variant: "ghost", size: "icon-sm" }), "ws-channel-header-bell")}
        data-muted={quiet() ? "" : undefined}
        aria-label={t("workspace.header.notifications", { name: props.name })}
      >
        <Show when={quiet()} fallback={<Bell aria-hidden="true" />}>
          <BellOff aria-hidden="true" />
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="ws-notify-menu">
          <DropdownMenu.RadioGroup
            value={choice()}
            onChange={(value) => {
              if (isNotifyChoice(value)) props.onNotifyChange(value);
            }}
          >
            <For each={NOTIFY_CHOICES}>
              {(item) => (
                <DropdownMenu.RadioItem value={item.value} closeOnSelect class="ws-notify-option">
                  <span>{t(item.label)}</span>
                  <Show when={choice() === item.value}>
                    <Check aria-hidden="true" class="ws-notify-check" />
                  </Show>
                </DropdownMenu.RadioItem>
              )}
            </For>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => props.onToggleMute()}>
            <Show when={props.muted} fallback={<BellOff aria-hidden="true" />}>
              <Bell aria-hidden="true" />
            </Show>
            <span>{t(props.muted ? "workspace.header.unmute" : "workspace.header.mute")}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
