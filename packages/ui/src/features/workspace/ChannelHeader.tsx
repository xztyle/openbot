import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { ChevronLeft, Hash, Info, LayoutDashboard, Lock, MessageSquareText } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { AiBadge, AvatarStack, MemberAvatar } from "./WorkspaceAvatar";
import type { ChannelVisibility, ConversationKind, WorkspaceMember } from "./workspace-types";

/** The right panel that a header button opens, to show its pressed state. */
export type ChannelHeaderPanel = "details" | "threads" | "artifacts";

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
