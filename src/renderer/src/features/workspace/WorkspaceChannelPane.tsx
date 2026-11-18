import {
  type BrowserPreview,
  type Channel,
  type ChannelSummary,
  channelKind,
  channelMembersAnswer,
  channelVisibility,
} from "@openbot/contracts/ipc";
import { Bell, BellOff, Button, Hash, Info, Link, Lock, LogOut, toast, UsersRound } from "@openbot/ui";
import { QuestionPromptBubble } from "@openbot/ui/components/QuestionPromptBubble";
import { ApprovalCard, BrowserTakeoverCard } from "@openbot/ui/features/conversation/ConversationPrompts";
import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import { WorkspaceContextMenu } from "@openbot/ui/features/workspace/WorkspaceContextMenu";
import type { WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import {
  channelApproval,
  channelBrowserTakeover,
  firstUnreadChannelMessageId,
  waitingChannelPrompt,
} from "../channels/channel-conversation-rows";
import { WorkspaceComposer } from "./WorkspaceComposer";
import { WorkspaceMessageList } from "./WorkspaceMessageList";
import { AnswerModesHint } from "./WorkspaceWelcome";
import { createAgentWork } from "./workspace-agent-work";
import { useWorkspace } from "./workspace-context";
import {
  channelMembers,
  conversationName,
  memberById,
  otherMembers,
  readerJoined,
  workingAgents,
} from "./workspace-model";

/** The open channel, DM or group: its header, its messages, who works on an answer, and the composer. */
export function WorkspaceChannelPane(props: { channelId: string }) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const page = () => {
    const current = ws.channels.state.page;
    return current?.channel.id === props.channelId ? current : null;
  };
  const summary = () => ws.summary(props.channelId);
  const channel = () => page()?.channel ?? summary();
  const kind = () => {
    const current = channel();
    return current ? channelKind(current) : "channel";
  };
  const visibility = () => {
    const current = channel();
    return current ? channelVisibility(current) : "public";
  };
  const name = () => {
    const current = channel();
    return current ? conversationName(ws.directory(), current) : "";
  };
  const members = createMemo(() => {
    const current = channel();
    return current ? channelMembers(ws.directory(), current) : [];
  });
  const others = createMemo(() => {
    const current = channel();
    return current ? otherMembers(ws.directory(), current) : [];
  });
  const joined = () => {
    const current = channel();
    return current ? readerJoined(ws.directory(), current) : true;
  };
  const archived = () => channel()?.archived === true;
  const entries = () => page()?.messages ?? [];
  const working = createMemo(() => new Set(workingAgents(entries(), page()?.tasks ?? [])));
  const firstUnreadId = createMemo(() => {
    const held = ws.channels.state.unread;
    if (!held || held.channelId !== props.channelId) return null;
    return firstUnreadChannelMessageId(entries(), held.count, ws.env.isReader);
  });
  /** Who works, thinks and types here, with Stop for a working agent. */
  const work = createAgentWork({
    channelId: props.channelId,
    threadRootId: null,
    entries,
    canStop: () => joined() && !archived() && ws.env.connectionReady(),
  });
  // Each channel update reads the prompt again as a new object. The card stays the same while the
  // request does, so the reader keeps the answers they picked or typed.
  const prompt = createMemo(
    () => {
      const current = page();
      return current ? waitingChannelPrompt(current) : null;
    },
    {
      equals: (left, right) => left?.entry.id === right?.entry.id && left?.prompt.requestId === right?.prompt.requestId,
    },
  );
  // A new request gets a new card: the card of an answered approval stays "Sending" until it goes.
  const approval = createMemo(
    () => {
      const current = page();
      const approvals = ws.env.approvals?.() ?? [];
      return current ? channelApproval(current, summary()?.threads, approvals) : undefined;
    },
    {
      equals: (left, right) => left?.agentId === right?.agentId && left?.requestId === right?.requestId,
    },
  );
  /** A browser takeover of the channel's work: the agent waits for a person in its browser. */
  const takeover = createMemo(
    () => {
      const current = page();
      const takeovers = ws.env.takeovers?.() ?? [];
      return current && takeovers.length ? channelBrowserTakeover(current, summary()?.threads, takeovers) : undefined;
    },
    { equals: (left, right) => left?.agentId === right?.agentId && left?.requestId === right?.requestId },
  );
  /** The page the agent waits on, captured again every 4 s while the card shows. */
  const [takeoverPreview, setTakeoverPreview] = createSignal<{
    preview: BrowserPreview | null;
    status: "idle" | "loading" | "ready" | "failed";
  }>({ preview: null, status: "idle" });
  createEffect(
    () => takeover()?.tabId,
    (tabId) => {
      setTakeoverPreview({ preview: null, status: tabId ? "loading" : "idle" });
      if (!tabId) return;
      let stopped = false;
      const capture = () =>
        ws.channels
          .port()
          .browser.capturePreview(tabId)
          .then(
            (preview) => {
              if (!stopped) setTakeoverPreview({ preview, status: "ready" });
            },
            () => {
              if (!stopped)
                setTakeoverPreview((current) => (current.preview ? current : { preview: null, status: "failed" }));
            },
          );
      void capture();
      const timer = setInterval(() => void capture(), 4_000);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
  );
  const membersAnswer = () => {
    const current = channel();
    return current ? channelMembersAnswer(current) : false;
  };
  /** Agents answer only when mentioned in a channel the reader may change: say it once. */
  // The tip says that agents answer on a mention, so it shows only while every agent here does.
  const showModesHint = () => {
    const current = channel();
    if (!current || kind() !== "channel" || !joined() || archived() || current.members.length === 0) return false;
    return current.members.every(
      (member) => (member.answerMode ?? (current.leadAgentId === member.agentId ? "lead" : "mention")) === "mention",
    );
  };
  const respond = async (action: () => Promise<void>, failure: string) => {
    try {
      await action();
      void ws.channels.refresh();
      return true;
    } catch (error) {
      toast.error(errorMessage(error, failure));
      return false;
    }
  };
  const placeholder = () =>
    kind() === "channel"
      ? t(
          visibility() === "private"
            ? "workspace.app.composer.messagePrivate"
            : "workspace.app.composer.messageChannel",
          {
            name: name(),
          },
        )
      : t("workspace.app.composer.messageDm", { name: name() });
  const panel = () => ws.state.panel;
  const threadRoot = () => {
    const current = panel();
    return current?.kind === "thread" ? current.rootId : undefined;
  };
  /** The message that a link named, when it is in this channel's transcript and not in a thread. */
  const focusId = () => {
    const focus = ws.state.focus;
    return focus?.channelId === props.channelId && !threadRoot() ? focus.messageId : undefined;
  };
  /** Right-click on the header: details, members, mute, a link, and leave for a channel. */
  const headerMenu = (): WorkspaceMenuItem[] => {
    const muted = ws.isMuted(props.channelId);
    const link = ws.env.channelLink?.(props.channelId);
    return [
      {
        id: "details",
        label: t("workspace.details.title"),
        icon: <Info aria-hidden="true" />,
        onSelect: () => ws.openDetails(props.channelId, "about"),
      },
      {
        id: "members",
        label: t("workspace.details.membersTab", { count: members().length }),
        icon: <UsersRound aria-hidden="true" />,
        onSelect: () => ws.openDetails(props.channelId, "members"),
      },
      {
        id: "mute",
        label: t(muted ? "workspace.sidebar.unmute" : "workspace.sidebar.mute"),
        icon: muted ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />,
        onSelect: () => ws.setMuted(props.channelId, !muted),
      },
      ...(link
        ? [
            {
              id: "copy-link",
              label: t("workspace.app.channel.copyLink"),
              icon: <Link aria-hidden="true" />,
              onSelect: () =>
                void navigator.clipboard?.writeText(link).then(
                  () => toast.success(t("workspace.app.message.linkCopied")),
                  () => undefined,
                ),
            },
          ]
        : []),
      ...(kind() === "channel" && joined() && !archived()
        ? [
            {
              id: "leave",
              label: t("workspace.details.leave"),
              icon: <LogOut aria-hidden="true" />,
              danger: true,
              onSelect: () => ws.requestLeave(props.channelId),
            },
          ]
        : []),
    ];
  };
  return (
    <section class="ws-channel-pane" aria-label={name()}>
      <WorkspaceContextMenu items={headerMenu} label={t("workspace.details.title")}>
        <ChannelHeader
          kind={kind()}
          name={name()}
          visibility={visibility()}
          dmMember={kind() === "dm" ? others()[0] : undefined}
          topic={channel()?.topic}
          onEditTopic={
            kind() === "channel" && !archived() && joined()
              ? () => ws.openDialog({ kind: "edit-meta", channelId: props.channelId, field: "topic" })
              : undefined
          }
          members={members()}
          memberCount={members().length}
          onShowMembers={() => ws.openDetails(props.channelId, "members")}
          onShowDetails={() => ws.openDetails(props.channelId, "about")}
          onShowArtifacts={() => ws.openArtifactsPanel(props.channelId)}
          activePanel={panel()?.kind === "details" ? "details" : panel()?.kind === "artifacts" ? "artifacts" : null}
          muted={ws.isMuted(props.channelId)}
          onToggleMute={() => ws.setMuted(props.channelId, !ws.isMuted(props.channelId))}
          onBack={() => ws.back()}
        />
      </WorkspaceContextMenu>
      <Show when={page()} fallback={<p class="ws-pane-loading">{t("workspace.app.channel.loading")}</p>}>
        <WorkspaceMessageList
          channelId={props.channelId}
          channelName={name()}
          entries={entries()}
          firstUnreadId={firstUnreadId()}
          working={working()}
          membersAnswer={membersAnswer()}
          hasOlder={Boolean(page()?.olderCursor)}
          onLoadOlder={() => ws.channels.loadOlder()}
          highlightedId={focusId() ?? threadRoot()}
          focusId={focusId()}
          empty={<ChannelIntro channel={channel()} name={name()} />}
          onMarkRead={() => ws.markRead()}
        />
      </Show>
      <div class="ws-channel-bottom">
        <Show when={approval()} keyed>
          {(current) => (
            <div class="ws-interaction">
              <ApprovalCard
                approval={current}
                requester={{
                  name: memberById(ws.directory(), current.agentId).name,
                  agent: ws.env.agents().find((agent) => agent.id === current.agentId),
                }}
                onApprove={() =>
                  respond(
                    () =>
                      ws.channels.port().agent.respondToApproval({ requestId: current.requestId, decision: "accept" }),
                    t("prompt.approval.answerFailed"),
                  )
                }
                onReject={() =>
                  respond(
                    () =>
                      ws.channels.port().agent.respondToApproval({ requestId: current.requestId, decision: "decline" }),
                    t("prompt.approval.answerFailed"),
                  )
                }
              />
            </div>
          )}
        </Show>
        <Show when={takeover()} keyed>
          {(request) => (
            <div class="ws-interaction">
              <BrowserTakeoverCard
                request={request}
                agentName={memberById(ws.directory(), request.agentId).name}
                tab={undefined}
                preview={takeoverPreview().preview}
                previewStatus={takeoverPreview().status}
                onOpen={() => {
                  // The agent's chat holds its browser, where the person finishes the step.
                  ws.openAgent(request.agentId);
                  ws.env.openBrowserTab?.(request.tabId, request.agentId);
                }}
                onComplete={() =>
                  respond(
                    () =>
                      ws.channels
                        .port()
                        .agent.respondToBrowserTakeover({ requestId: request.requestId, decision: "complete" }),
                    t("uiBlock.error.answerFailed"),
                  )
                }
                onCancel={() =>
                  respond(
                    () =>
                      ws.channels
                        .port()
                        .agent.respondToBrowserTakeover({ requestId: request.requestId, decision: "cancel" }),
                    t("uiBlock.error.answerFailed"),
                  )
                }
                browserSecret={{
                  loadPreview: (tabId) => ws.channels.port().browser.capturePreview(tabId),
                  vaultSave: ws.env.localHost?.() === true,
                  onRespond: (input) => ws.channels.port().agent.respondToBrowserSecret(input),
                }}
              />
            </div>
          )}
        </Show>
        <Show when={prompt()} keyed>
          {(waiting) => (
            <div class="ws-interaction">
              <p class="ws-interaction-title">
                {t("workspace.app.channel.question", { name: waiting.entry.author.name })}
              </p>
              <QuestionPromptBubble
                questions={waiting.prompt.questions}
                onSubmit={(answers) =>
                  respond(
                    () => ws.channels.port().agent.respondToPrompt({ requestId: waiting.prompt.requestId, answers }),
                    t("uiBlock.error.answerFailed"),
                  )
                }
              />
            </div>
          )}
        </Show>
        <Show when={showModesHint()}>
          <AnswerModesHint channelId={props.channelId} />
        </Show>
        <TypingIndicator humans={work.humans()} agents={work.agents()} />
        <Show when={!archived()} fallback={<p class="ws-channel-notice">{t("workspace.app.channel.archived")}</p>}>
          <Show
            when={joined()}
            fallback={
              <div class="ws-join-banner">
                <p>{t("workspace.app.channel.notMember", { name: name() })}</p>
                <Button size="sm" onClick={() => void ws.join(props.channelId)}>
                  {t("workspace.app.channel.join")}
                </Button>
              </div>
            }
          >
            <WorkspaceComposer
              channelId={props.channelId}
              placeholder={placeholder()}
              label={placeholder()}
              focusRequest={1}
              disabled={!ws.env.connectionReady()}
            />
          </Show>
        </Show>
      </div>
    </section>
  );
}

/** The top of a conversation: "This is the very beginning of #general", or the members of a DM. */
function ChannelIntro(props: { channel: ChannelSummary | Channel | undefined; name: string }) {
  const { t } = useText();
  const ws = useWorkspace();
  const kind = () => (props.channel ? channelKind(props.channel) : "channel");
  const others = () => (props.channel ? otherMembers(ws.directory(), props.channel) : []);
  const soleAgent = () => (props.channel ? ws.soleAgent(props.channel) : null);
  return (
    <div class="ws-channel-intro">
      <Show
        when={kind() === "channel"}
        fallback={
          <>
            <div class="ws-channel-intro-faces">
              {others()
                .slice(0, 4)
                .map((member) => (
                  <MemberAvatar member={member} size="xl" />
                ))}
            </div>
            <h2 class="ws-channel-intro-title">{props.name}</h2>
            <p class="ws-channel-intro-text">
              {t(soleAgent() ? "workspace.app.channel.agentDmIntro" : "workspace.app.channel.dmIntro", {
                name: props.name,
              })}
            </p>
          </>
        }
      >
        <span class="ws-channel-intro-glyph" aria-hidden="true">
          <Show when={props.channel && channelVisibility(props.channel) === "private"} fallback={<Hash />}>
            <Lock />
          </Show>
        </span>
        <h2 class="ws-channel-intro-title">{props.name}</h2>
        <p class="ws-channel-intro-text">
          {props.channel?.description || t("workspace.app.channel.intro", { name: props.name })}
        </p>
        <Show when={props.channel}>
          {(channel) => (
            <Button
              variant="outline"
              size="sm"
              onClick={() => ws.openDialog({ kind: "invite", channelId: channel().id })}
            >
              {t("workspace.app.channel.addPeople")}
            </Button>
          )}
        </Show>
      </Show>
    </div>
  );
}
