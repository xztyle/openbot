import type { JSX } from "@solidjs/web";
import { createEffect, For, Show } from "solid-js";
import { Button } from "../../button";
import { ArrowLeftRight, ChevronLeft, X } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MessageRow } from "./MessageRow";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import type { WorkspaceMember } from "./workspace-types";

/** Two agents that sent each other messages. */
export interface AgentTalkPair {
  id: string;
  members: [WorkspaceMember, WorkspaceMember];
  count: number;
  lastAt: number;
  lastSenderName: string;
  lastText: string;
}

/** One message from an agent to the other one, or to more agents. */
export interface AgentTalkMessage {
  id: string;
  author: WorkspaceMember;
  sentAt: number;
  text: string;
  /** The names of the other recipients, when there are more than the pair. */
  alsoTo?: string | undefined;
  truncated?: boolean | undefined;
  attachmentCount?: number | undefined;
}

export interface AgentTalkViewProps {
  pairs: readonly AgentTalkPair[] | null;
  /** The pair that shows, or null for the list. */
  selected: AgentTalkPair | null;
  messages: readonly AgentTalkMessage[] | null;
  hasOlder: boolean;
  loading: boolean;
  /** The name of the agent that the list shows the pairs of, when one is chosen. */
  filterName?: string | undefined;
  onClearFilter?: (() => void) | undefined;
  onSelect: (id: string) => void;
  onCloseConversation: () => void;
  onLoadOlder: () => void;
  onBack?: (() => void) | undefined;
  class?: string;
}

/**
 * What agents say to each other, as DMs between two agents. It is read only: their talk stays in
 * each agent's own chat, where it gives the agent its context, and it marks nothing unread.
 */
export function AgentTalkView(props: AgentTalkViewProps): JSX.Element {
  const { t, format } = useText();
  let scroller: HTMLDivElement | undefined;
  /** The pair whose newest message the list scrolled to. Older pages keep the place. */
  let scrolledFor: string | null = null;
  createEffect(
    () => (props.selected && props.messages?.length ? props.selected.id : null),
    (pairId) => {
      if (!pairId || pairId === scrolledFor) {
        if (!pairId) scrolledFor = null;
        return;
      }
      scrolledFor = pairId;
      requestAnimationFrame(() => {
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
    },
  );
  const pairName = (pair: AgentTalkPair) =>
    t("workspace.agentTalk.pair", { first: pair.members[0].name, second: pair.members[1].name });
  return (
    <section class={cx("ws-view ws-agent-talk", props.class)} aria-label={t("workspace.view.agents")}>
      <WorkspacePaneHeader
        icon={<ArrowLeftRight aria-hidden="true" />}
        title={
          <Show when={props.selected} fallback={t("workspace.view.agents")}>
            {(pair) => pairName(pair())}
          </Show>
        }
        subtitle={
          <Show when={props.selected} fallback={t("workspace.agentTalk.description")}>
            {(pair) => t("workspace.agentTalk.count", { count: pair().count })}
          </Show>
        }
        onBack={props.onBack}
        actions={
          <Show when={props.selected}>
            <Button variant="ghost" size="xs" onClick={() => props.onCloseConversation()}>
              <ChevronLeft aria-hidden="true" />
              {t("workspace.agentTalk.all")}
            </Button>
          </Show>
        }
      />
      <Show when={!props.selected && props.filterName}>
        {(name) => (
          <div class="ws-view-toolbar">
            <span class="ws-agent-talk-filter">
              {t("workspace.agentTalk.filter", { name: name() })}
              <Show when={props.onClearFilter}>
                {(clear) => (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => clear()()}
                    aria-label={t("workspace.agentTalk.clear")}
                  >
                    <X aria-hidden="true" />
                  </Button>
                )}
              </Show>
            </span>
          </div>
        )}
      </Show>
      <div class="ws-view-scroll" ref={(element: HTMLDivElement) => (scroller = element)}>
        <Show
          when={props.selected}
          fallback={
            <Show
              when={props.pairs?.length}
              fallback={
                <p class="ws-view-empty">
                  {props.pairs === null ? t("workspace.agentTalk.loading") : t("workspace.agentTalk.empty")}
                </p>
              }
            >
              <ul class="ws-agent-talk-list">
                <For each={props.pairs ?? []} keyed={(pair) => pair.id}>
                  {(pair) => (
                    <li>
                      <Button variant="ghost" class="ws-agent-talk-pair" onClick={() => props.onSelect(pair().id)}>
                        <span class="ws-agent-talk-faces" aria-hidden="true">
                          <MemberAvatar member={pair().members[0]} size="sm" />
                          <MemberAvatar member={pair().members[1]} size="sm" />
                        </span>
                        <span class="ws-agent-talk-copy">
                          <span class="ws-agent-talk-head">
                            <strong class="ws-truncate">{pairName(pair())}</strong>
                            <span class="ws-muted">
                              {format.date(pair().lastAt, { dateStyle: "medium", timeStyle: "short" })}
                            </span>
                          </span>
                          <span class="ws-agent-talk-preview ws-truncate">
                            {pair().lastSenderName}: {pair().lastText}
                          </span>
                        </span>
                        <span class="ws-agent-talk-count">
                          {t("workspace.agentTalk.count", { count: pair().count })}
                        </span>
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          }
        >
          <div class="ws-agent-talk-transcript">
            <Show when={props.hasOlder}>
              <Button variant="ghost" size="xs" disabled={props.loading} onClick={() => props.onLoadOlder()}>
                {t("workspace.agentTalk.older")}
              </Button>
            </Show>
            <Show when={props.messages} fallback={<p class="ws-view-empty">{t("workspace.agentTalk.loading")}</p>}>
              <Show when={props.messages?.length === 0}>
                <p class="ws-view-empty">{t("workspace.agentTalk.empty")}</p>
              </Show>
              <For each={props.messages ?? []} keyed={(message) => message.id}>
                {(message, index) => (
                  <MessageRow
                    author={message().author}
                    sentAt={message().sentAt}
                    grouped={
                      index() > 0 &&
                      props.messages?.[index() - 1]?.author.id === message().author.id &&
                      message().sentAt - (props.messages?.[index() - 1]?.sentAt ?? 0) < 5 * 60_000
                    }
                  >
                    <Show when={message().alsoTo}>
                      {(names) => <p class="ws-muted">{t("workspace.agentTalk.alsoTo", { names: names() })}</p>}
                    </Show>
                    <p class="ws-message-text ws-agent-talk-text">{message().text}</p>
                    <Show when={message().truncated}>
                      <p class="ws-muted">{t("workspace.agentTalk.truncated")}</p>
                    </Show>
                    <Show when={message().attachmentCount}>
                      {(count) => <p class="ws-muted">{t("workspace.agentTalk.files", { count: count() })}</p>}
                    </Show>
                  </MessageRow>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    </section>
  );
}
