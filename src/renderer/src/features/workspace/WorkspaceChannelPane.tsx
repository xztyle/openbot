import { type Channel, type ChannelSummary, channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Button, Hash, Lock } from "@openbot/ui";
import { QuestionPromptBubble } from "@openbot/ui/components/QuestionPromptBubble";
import { ApprovalCard } from "@openbot/ui/features/conversation/ConversationPrompts";
import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import { useText } from "@openbot/ui/text";
import { createMemo, Show } from "solid-js";
import {
  channelApproval,
  firstUnreadChannelMessageId,
  waitingChannelPrompt,
} from "../channels/channel-conversation-rows";
import { WorkspaceComposer } from "./WorkspaceComposer";
import { WorkspaceMessageList } from "./WorkspaceMessageList";
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
  const typing = createMemo(() => {
    const thinking = thinkingAgents(entries());
    const busy = [...working()].filter((id) => !thinking.includes(id));
    const fleet = ws.fleet.agents();
    const step = (id: string) => fleet.find((agent) => agent.member.id === id)?.currentStep;
    return [
      ...thinking.map((id) => ({ member: memberById(ws.directory(), id), state: "thinking" as const })),
      ...busy.map((id) => ({ member: memberById(ws.directory(), id), state: "working" as const, label: step(id) })),
    ];
  });
  const prompt = createMemo(() => {
    const current = page();
    return current ? waitingChannelPrompt(current) : null;
  });
  const approval = createMemo(() => {
    const current = page();
    const approvals = ws.env.approvals?.() ?? [];
    return current ? channelApproval(current, summary()?.threads, approvals) : undefined;
  });
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
  return (
    <section class="ws-channel-pane" aria-label={name()}>
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
      <Show when={page()} fallback={<p class="ws-pane-loading">{t("workspace.app.channel.loading")}</p>}>
        <WorkspaceMessageList
          channelId={props.channelId}
          channelName={name()}
          entries={entries()}
          firstUnreadId={firstUnreadId()}
          working={working()}
          hasOlder={Boolean(page()?.olderCursor)}
          onLoadOlder={() => ws.channels.loadOlder()}
          highlightedId={threadRoot()}
          onAtEnd={(atEnd) => {
            if (atEnd && ws.channels.state.unread) ws.markRead();
          }}
          empty={<ChannelIntro channel={channel()} name={name()} />}
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
        <TypingIndicator humans={[]} agents={typing()} />
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
            <p class="ws-channel-intro-text">{t("workspace.app.channel.dmIntro", { name: props.name })}</p>
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
