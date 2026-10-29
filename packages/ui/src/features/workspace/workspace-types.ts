import type { AvatarHue } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";

/**
 * Display models of the Slack-style workspace. They hold only what a component shows, so the
 * wiring phase maps its contracts onto them. Nothing here is a wire format.
 */

/** Whether a person is at the computer. Agents have no presence; they work or they rest. */
export type WorkspacePresence = "active" | "away" | "offline";

/** A human teammate or an AI agent, as an avatar, a name or a row shows it. */
export interface WorkspaceMember {
  id: string;
  kind: "human" | "agent";
  name: string;
  avatarUrl?: string | null | undefined;
  /** Agent: the seed and the hue of its generated face. */
  avatarSeed?: string | undefined;
  avatarHue?: AvatarHue | null | undefined;
  /** Human: presence. */
  presence?: WorkspacePresence | undefined;
  /** Agent: it runs a turn now. */
  working?: boolean | undefined;
  /** A person from a bridged service, such as a Discord user. */
  external?: boolean | undefined;
}

export type ChannelVisibility = "public" | "private";

/** `dm` has two members; `group` has three to nine. */
export type ConversationKind = "channel" | "dm" | "group";

/** When an agent answers in a channel. `lead` is the coordinator routing. */
export type AgentAnswerMode = "mention" | "always" | "always-no-gate" | "lead";

/** One action of a "more" menu. */
export interface WorkspaceMenuItem {
  id: string;
  label: string;
  icon?: JSX.Element | undefined;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  onSelect: () => void;
}

/** One emoji under a message. `reacted` is true when the reader is one of the actors. */
export interface WorkspaceReaction {
  emoji: string;
  count: number;
  reacted: boolean;
  /** The names of the actors, for the tooltip. */
  actors?: readonly string[] | undefined;
}

/** A run of message text. Mentions and channel links are highlighted. */
export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; label: string; memberId?: string | undefined; self?: boolean | undefined }
  | { kind: "broadcast"; label: "channel" | "here" }
  | { kind: "channel"; name: string; channelId?: string | undefined }
  | { kind: "link"; text: string; href: string }
  | { kind: "code"; text: string };

/** The thread summary under a root message. */
export interface ThreadSummary {
  replyCount: number;
  lastReplyAt: number;
  participants: readonly WorkspaceMember[];
  unread?: boolean | undefined;
}

export type ArtifactKind = "website" | "app" | "doc" | "deck" | "dashboard" | "file";

/** A deliverable of an agent: a hosted app, a site, a document, a deck, a dashboard or a file. */
export interface WorkspaceArtifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  description?: string | undefined;
  /** The address it opens at, such as `https://cakemaker-web.delynith.com`. */
  url?: string | undefined;
  thumbnailUrl?: string | null | undefined;
  agent?: WorkspaceMember | undefined;
  channelId?: string | undefined;
  channelName?: string | undefined;
  costUsd?: number | undefined;
  durationMs?: number | undefined;
  createdAt?: number | undefined;
}

export type AgentStepKind = "search" | "browse" | "tool" | "shell" | "file" | "skill" | "think";

/** One step of an agent turn. `label` and `detail` are the host's text. */
export interface AgentStepView {
  id: string;
  kind: AgentStepKind;
  label: string;
  detail?: string | undefined;
  status: "running" | "done" | "failed";
  durationMs?: number | undefined;
}

/** What an agent does now, for the fleet and the profile. */
export type AgentWorkStatus =
  | { state: "idle" }
  | { state: "working"; task: string; channelName?: string | undefined }
  | {
      state: "waiting";
      personName: string;
      channelName?: string | undefined;
      /** The agent waits for a provider usage limit, not a person; `resetsAt` is when it ends. */
      usageLimit?: { resetsAt?: number | undefined } | undefined;
    };

/** The parts of the computer an agent can use. */
export type AgentComputerPart = "browser" | "shell" | "bench" | "hosting";

/** A slot the caller fills, such as an editor, a search field or a Discord link row. */
export type WorkspaceSlot = JSX.Element;
