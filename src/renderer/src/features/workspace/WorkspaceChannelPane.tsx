import {
  type BrowserPreview,
  type Channel,
  type ChannelSummary,
  channelKind,
  channelMembersAnswer,
  channelVisibility,
  type WorkspaceSteps,
} from "@openbot/contracts/ipc";
import { Bell, BellOff, Button, Hash, Info, Lock, LogOut, UsersRound } from "@openbot/ui";
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
import { useWorkspace } from "./workspace-context";
import {
  channelMembers,
  conversationName,
  memberById,
  otherMembers,
  readerJoined,
  thinkingAgents,
  workingAgents,
} from "./workspace-model";

/** The open channel, DM or group: its header, its messages, who works on an answer, and the composer. */
export function WorkspaceChannelPane(props: { channelId: string }) {
  const { t } = useText();
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
  /** The steps so far of each agent that works for the channel, read every 2 s while it works. */
  const [liveSteps, setLiveSteps] = createSignal<Record<string, WorkspaceSteps>>({});
  /** The host's typing list once it sent one; until then the gate marks and the running tasks of the page. */
  const live = createMemo(() => ws.typingIn(props.channelId, null));
  const typing = createMemo(() => {
    const host = live();
    const thinking = host
      ? host.agents.filter((agent) => agent.state === "thinking").map((agent) => agent.id)
      : thinkingAgents(entries());
    const busy = (
      host ? host.agents.filter((agent) => agent.state === "working").map((agent) => agent.id) : [...working()]
    ).filter((id) => !thinking.includes(id));
    const fleet = ws.fleet.agents();
    const step = (id: string) => fleet.find((agent) => agent.member.id === id)?.currentStep;
    const trail = (id: string) => {
      const steps = liveSteps()[id];
      return steps ? { steps: steps.steps, durationMs: steps.durationMs || undefined } : undefined;
    };
    return [
      ...thinking.map((id) => ({ member: memberById(ws.directory(), id), state: "thinking" as const })),
      ...busy.map((id) => ({
        member: memberById(ws.directory(), id),
        state: "working" as const,
        label: step(id),
        trail: trail(id),
      })),
    ];
  });
  createEffect(
    () =>
      typing()
        .filter((agent) => agent.state === "working")
        .map((agent) => agent.member.id)
        .join(" "),
    (key) => {
      const read = ws.channels.port().agent.workspaceSteps;
      if (!key || !read) {
        setLiveSteps({});
        return;
      }
      const channelId = props.channelId;
      const agentIds = key.split(" ");
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        const results = await Promise.all(
          agentIds.map((agentId) =>
            read({ channelId, agentId }).then(
              (steps) => [agentId, steps] as const,
              () => [agentId, null] as const,
            ),
          ),
        );
        if (stopped) return;
        const next: Record<string, WorkspaceSteps> = {};
        for (const [agentId, steps] of results) if (steps && steps.total > 0) next[agentId] = steps;
        setLiveSteps(next);
        timer = setTimeout(() => void poll(), 2_000);
      };
      void poll();
      return () => {
        stopped = true;
        clearTimeout(timer);
      };
    },
  );
  const typingPeople = createMemo(() => (live()?.humans ?? []).map((id) => memberById(ws.directory(), id)));
  const prompt = createMemo(() => {
    const current = page();
    return current ? waitingChannelPrompt(current) : null;
  });
  const approval = createMemo(() => {
    const current = page();
    const approvals = ws.env.approvals?.() ?? [];
    return current ? channelApproval(current, summary()?.threads, approvals) : undefined;
  });
  /** A browser takeover of the channel's work: the agent waits for a person in its browser. */
  const takeover = createMemo(() => {
    const current = page();
    const takeovers = ws.env.takeovers?.() ?? [];
    return current && takeovers.length ? channelBrowserTakeover(current, summary()?.threads, takeovers) : undefined;
  });
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
  const respond = async (action: () => Promise<void>) => {
    try {
      await action();
      void ws.channels.refresh();
      return true;
    } catch {
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
  /** Right-click on the header: details, members, mute, and leave for a channel. */
  const headerMenu = (): WorkspaceMenuItem[] => {
    const muted = ws.isMuted(props.channelId);
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
      ...(kind() === "channel" && joined() && !archived()
        ? [
            {
              id: "leave",
              label: t("workspace.details.leave"),
              icon: <LogOut aria-hidden="true" />,
              danger: true,
              onSelect: () => void ws.leave(props.channelId),
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
          highlightedId={threadRoot()}
          empty={<ChannelIntro channel={channel()} name={name()} />}
          onMarkRead={() => ws.markRead()}
        />
      </Show>
      <div class="ws-channel-bottom">
        <Show when={approval()}>
          {(current) => (
            <div class="ws-interaction">
              <ApprovalCard
                approval={current()}
                requester={{
                  name: memberById(ws.directory(), current().agentId).name,
                  agent: ws.env.agents().find((agent) => agent.id === current().agentId),
                }}
                onApprove={() =>
                  respond(() =>
                    ws.channels.port().agent.respondToApproval({ requestId: current().requestId, decision: "accept" }),
                  )
                }
                onReject={() =>
                  respond(() =>
                    ws.channels.port().agent.respondToApproval({ requestId: current().requestId, decision: "decline" }),
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
                  respond(() =>
                    ws.channels
                      .port()
                      .agent.respondToBrowserTakeover({ requestId: request.requestId, decision: "complete" }),
                  )
                }
                onCancel={() =>
                  respond(() =>
                    ws.channels
                      .port()
                      .agent.respondToBrowserTakeover({ requestId: request.requestId, decision: "cancel" }),
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
                  respond(() =>
                    ws.channels.port().agent.respondToPrompt({ requestId: waiting.prompt.requestId, answers }),
                  )
                }
              />
            </div>
          )}
        </Show>
        <Show when={showModesHint()}>
          <AnswerModesHint channelId={props.channelId} />
        </Show>
        <TypingIndicator humans={typingPeople()} agents={typing()} />
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
