import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import { ArtifactCard } from "@openbot/ui/features/workspace/ArtifactCard";
import { ChannelHeader } from "@openbot/ui/features/workspace/ChannelHeader";
import { MemberProfileCard } from "@openbot/ui/features/workspace/MemberProfileCard";
import { MessageComposer } from "@openbot/ui/features/workspace/MessageComposer";
import { DayDivider, NewMessagesDivider, SystemEvent } from "@openbot/ui/features/workspace/MessageDividers";
import { MessageRow } from "@openbot/ui/features/workspace/MessageRow";
import { StepTrail } from "@openbot/ui/features/workspace/StepTrail";
import { ThreadPanel } from "@openbot/ui/features/workspace/ThreadPanel";
import { TypingIndicator } from "@openbot/ui/features/workspace/TypingIndicator";
import { WorkspaceSidebar, type WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { WorkspaceMember, WorkspaceMenuItem } from "@openbot/ui/features/workspace/workspace-types";
import type { JSX } from "@solidjs/web";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import {
  artProducer,
  CAKEMAKER_SITE,
  CHANNELS,
  DIRECT_MESSAGES,
  delynith,
  EVERYONE,
  fonikad,
  gameDesigner,
  mention,
  NOW,
  orchestrator,
  qa,
  STEPS,
  text,
} from "./workspace-fixtures";

const MINUTE = 60_000;

/** The Storybook globals of the light palette, for a `Light` story. */
export const LIGHT = { globals: { colorScheme: "light" } } as const;

/** A frame with the height of the canvas, for panes that fill their parent. */
export function StoryFrame(props: { children: JSX.Element; width?: string; height?: string }): JSX.Element {
  return (
    <div
      style={{
        width: props.width ?? "100%",
        height: props.height ?? "100vh",
        "max-width": "100vw",
        display: "flex",
        "flex-direction": "column",
        background: "var(--openbot-bg-canvas)",
        overflow: "hidden",
      }}
    >
      {props.children}
    </div>
  );
}

export const MESSAGE_MENU: readonly WorkspaceMenuItem[] = [
  { id: "edit", label: "Edit message", onSelect: fn() },
  { id: "link", label: "Copy link", onSelect: fn() },
  { id: "unread", label: "Mark unread", onSelect: fn() },
  { id: "delete", label: "Delete message", danger: true, onSelect: fn() },
];

const PROFILES: Record<string, () => JSX.Element> = {
  [delynith.id]: () => <MemberProfileCard member={delynith} workspaceRole="owner" title="Founder" onMessage={fn()} />,
  [fonikad.id]: () => <MemberProfileCard member={fonikad} workspaceRole="member" title="Producer" onMessage={fn()} />,
  [orchestrator.id]: () => (
    <MemberProfileCard
      member={orchestrator}
      title="Producer"
      description="Plans the work, splits it between the agents and keeps the build deployed."
      model="claude-opus-5-5"
      status={{ state: "working", task: "the web build deploy", channelName: "cakemaker" }}
      computer={["browser", "shell", "bench", "hosting"]}
      onMessage={fn()}
      onSettings={fn()}
    />
  ),
  [qa.id]: () => (
    <MemberProfileCard
      member={qa}
      title="QA Engineer"
      description="Tests every build on desktop and iOS and files what breaks."
      model="gpt-6-luna"
      status={{ state: "working", task: "regression tests for build 118" }}
      computer={["browser", "shell"]}
      onMessage={fn()}
      onSettings={fn()}
    />
  ),
};

export function profileOf(member: WorkspaceMember): JSX.Element | undefined {
  return PROFILES[member.id]?.();
}

/** The real conversation editor in the composer slot, as the renderer plugs it in. */
export function StoryEditor(props: { label: string; value?: string }): JSX.Element {
  const [value, setValue] = createSignal(props.value ?? "");
  return (
    <ComposerEditor
      agentId={undefined}
      agents={[]}
      value={value()}
      placeholder={props.label}
      ariaLabel={props.label}
      disabled={false}
      onValueChange={setValue}
      onSubmit={fn()}
    />
  );
}

export function CakemakerComposer(props: { thread?: boolean }): JSX.Element {
  const [also, setAlso] = createSignal(false);
  return (
    <MessageComposer
      label={props.thread ? "Reply in thread" : "Message #cakemaker"}
      editor={<StoryEditor label={props.thread ? "Reply…" : "Message #cakemaker"} />}
      onFormat={fn()}
      activeFormats={["bold"]}
      onAttach={fn()}
      onEmoji={fn()}
      onMention={fn()}
      onSend={fn()}
      canSend={!props.thread}
      defaultToolbarHidden={props.thread}
      alsoSendTo={props.thread ? { channelName: "cakemaker", checked: also(), onChange: setAlso } : undefined}
    />
  );
}

export function CakemakerSidebar(props: { activeView?: WorkspaceView; activeId?: string }): JSX.Element {
  return (
    <WorkspaceSidebar
      workspaceName="Cakemaker"
      workspaceMenu={[
        { id: "invite", label: "Invite people to Cakemaker", onSelect: fn() },
        { id: "settings", label: "Workspace settings", onSelect: fn() },
        { id: "gate", label: "Answer gate model", onSelect: fn() },
      ]}
      onNewMessage={fn()}
      activeView={props.activeView}
      activeConversationId={props.activeView ? undefined : (props.activeId ?? "c-cakemaker")}
      onSelectView={fn()}
      onSelectConversation={fn()}
      activityCount={3}
      threadsUnread
      workingAgentCount={2}
      channels={CHANNELS}
      directMessages={DIRECT_MESSAGES}
      onAddChannel={fn()}
      onAddTeammate={fn()}
    />
  );
}

export function CakemakerHeader(props: { onBack?: () => void }): JSX.Element {
  return (
    <ChannelHeader
      kind="channel"
      name="cakemaker"
      visibility="public"
      topic="Ship the web build of Cakemaker by Friday 🎂"
      onEditTopic={fn()}
      members={[delynith, fonikad, orchestrator, gameDesigner]}
      memberCount={EVERYONE.length}
      onShowMembers={fn()}
      onShowDetails={fn()}
      onShowThreads={fn()}
      onShowArtifacts={fn()}
      activePanel="threads"
      onBack={props.onBack}
    />
  );
}

/** The thread of the stories: delynith asks Orchestrator to put the build online. */
export function CakemakerRoot(props: { highlighted?: boolean; withThread?: boolean }): JSX.Element {
  return (
    <MessageRow
      author={delynith}
      sentAt={NOW - 42 * MINUTE}
      text={[
        mention(orchestrator),
        text(" can you put the web build online so "),
        mention(fonikad),
        text(" can play it on the phone?"),
      ]}
      reactions={[
        { emoji: "👍", count: 2, reacted: true, actors: ["delynith", "Fonikad"] },
        { emoji: "🎂", count: 1, reacted: false, actors: ["Game Designer"] },
      ]}
      onToggleReaction={fn()}
      onOpenEmojiPicker={fn()}
      thread={
        props.withThread
          ? { replyCount: 4, lastReplyAt: NOW - 4 * MINUTE, participants: [orchestrator, qa, fonikad], unread: true }
          : undefined
      }
      onOpenThread={fn()}
      menuItems={MESSAGE_MENU}
      highlighted={props.highlighted}
      profile={profileOf(delynith)}
    />
  );
}

export function CakemakerReplies(): JSX.Element {
  return (
    <>
      <MessageRow
        author={orchestrator}
        sentAt={NOW - 20 * MINUTE}
        text={[text("Done. The build is live, levels 1–3 are playable and the leaderboard works.")]}
        reactions={[{ emoji: "🎉", count: 3, reacted: true, actors: ["delynith", "Fonikad", "QA"] }]}
        onToggleReaction={fn()}
        onOpenThread={fn()}
        menuItems={MESSAGE_MENU}
        profile={profileOf(orchestrator)}
      >
        <StepTrail steps={STEPS} durationMs={27 * MINUTE + 12_000} />
        <ArtifactCard artifact={CAKEMAKER_SITE} onOpen={fn()} />
      </MessageRow>
      <MessageRow
        author={qa}
        sentAt={NOW - 12 * MINUTE}
        text={[
          mention(delynith, true),
          text(" the oven timer drifts on Safari iOS after the app goes to the background. I can ship a fix with "),
          { kind: "code", text: "visibilitychange" },
          text("."),
        ]}
        mentionsReader
        onToggleReaction={fn()}
        onOpenThread={fn()}
        menuItems={MESSAGE_MENU}
        profile={profileOf(qa)}
      />
      <MessageRow
        author={qa}
        sentAt={NOW - 11 * MINUTE}
        grouped
        text={[text("Repro steps are in the QA dashboard of build 118.")]}
        edited
        onToggleReaction={fn()}
        menuItems={MESSAGE_MENU}
      />
      <MessageRow
        author={fonikad}
        sentAt={NOW - 4 * MINUTE}
        text={[text("Played it on the phone, it is so good. Ship the fix 🚀")]}
        onToggleReaction={fn()}
        menuItems={MESSAGE_MENU}
        profile={profileOf(fonikad)}
      />
    </>
  );
}

/** The #cakemaker message list: day divider, events, the thread root, new messages and typing. */
export function CakemakerMessages(): JSX.Element {
  return (
    <div style={{ flex: "1 1 auto", "min-height": "0", "overflow-y": "auto", "padding-bottom": "8px" }}>
      <DayDivider date={NOW - 26 * 60 * MINUTE} now={NOW} />
      <SystemEvent actor={delynith} event={{ kind: "created", name: "cakemaker" }} at={NOW - 26 * 60 * MINUTE} />
      <SystemEvent actor={delynith} event={{ kind: "agent-added", agent: gameDesigner }} at={NOW - 26 * 60 * MINUTE} />
      <MessageRow
        author={gameDesigner}
        sentAt={NOW - 25 * 60 * MINUTE}
        text={[text("The design doc v3 is ready: 30 levels, the sugar economy and the frosting mechanic.")]}
        onToggleReaction={fn()}
        onOpenThread={fn()}
        menuItems={MESSAGE_MENU}
      />
      <MessageRow author={artProducer} sentAt={NOW - 25 * 60 * MINUTE} deleted />
      <DayDivider date={NOW - 60 * MINUTE} now={NOW} />
      <SystemEvent actor={fonikad} event={{ kind: "joined" }} at={NOW - 50 * MINUTE} />
      <CakemakerRoot withThread />
      <NewMessagesDivider />
      <MessageRow
        author={orchestrator}
        sentAt={NOW - 3 * MINUTE}
        text={[
          text("Next: "),
          mention(qa),
          text(" ships the timer fix, then I redeploy. Details in "),
          { kind: "channel", name: "cakemaker" },
          text(" and on "),
          { kind: "link", text: "cakemaker-web.delynith.com", href: CAKEMAKER_SITE.url ?? "" },
          text("."),
        ]}
        onToggleReaction={fn()}
        onOpenThread={fn()}
        menuItems={MESSAGE_MENU}
        profile={profileOf(orchestrator)}
      />
    </div>
  );
}

export function CakemakerTyping(): JSX.Element {
  return (
    <TypingIndicator
      humans={[fonikad]}
      agents={[{ member: qa, state: "working", label: "Running the oven timer tests" }]}
    />
  );
}

export function CakemakerThread(props: { onBack?: () => void }): JSX.Element {
  return (
    <ThreadPanel
      channelName="cakemaker"
      root={<CakemakerRoot />}
      replyCount={4}
      replies={<CakemakerReplies />}
      typing={<TypingIndicator humans={[]} agents={[{ member: orchestrator, state: "thinking" }]} />}
      composer={<CakemakerComposer thread />}
      onClose={fn()}
      onBack={props.onBack}
    />
  );
}
