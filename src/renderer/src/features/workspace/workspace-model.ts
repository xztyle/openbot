/*
 * The workspace view as data: who the members are, which rows the sidebar shows, and how a channel
 * page becomes Slack-style message rows. Every function here is a function of the channel data and
 * the directory of people and agents, so the desktop and the browser client build the same view.
 */

import { chatTagReferences } from "@openbot/contracts/chat-tag-references";
import {
  type ChannelMessage,
  type ChannelReaction,
  type ChannelSummary,
  type ChannelWorkspaceFields,
  channelKind,
  channelVisibility,
  isChannelThreadReply,
} from "@openbot/contracts/ipc";
import { markdownPlainText } from "@openbot/contracts/markdown-preview-text";
import type { AgentProfile } from "@openbot/ui/data";
import type { SidebarAgentState } from "@openbot/ui/features/sidebar/sidebar-types";
import type { SidebarChannel, SidebarDirectMessage } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type {
  AgentStepView,
  MessageSegment,
  ThreadSummary,
  WorkspaceArtifact,
  WorkspaceMember,
  WorkspaceReaction,
} from "@openbot/ui/features/workspace/workspace-types";

/** A human of the team, as the presence roster names them. */
export interface WorkspacePerson {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member";
  online: boolean;
}

/** Who and what the workspace knows: the people, the agents, and which ids are the reader. */
export interface WorkspaceDirectory {
  agents: readonly AgentProfile[];
  people: readonly WorkspacePerson[];
  /** Whether an author or member id stands for the reader. */
  isReader: (id: string) => boolean;
  reader: { id: string | null; name: string; avatarUrl: string | null };
  agentStates: Readonly<Record<string, SidebarAgentState>>;
  /** Names that messages carry for people the roster does not list, such as people who left. */
  names?: Readonly<Record<string, string>> | undefined;
}

/** The sidebar row id of an agent's DM that has no channel yet. */
export const AGENT_DM_PREFIX = "agent:";

/** The gap after which a message of the same author starts a new group, as in Slack. */
const GROUP_GAP_MS = 5 * 60_000;

export function agentWorking(directory: WorkspaceDirectory, agentId: string): boolean {
  return directory.agentStates[agentId]?.kind === "working";
}

export function agentMember(agent: AgentProfile, working = false): WorkspaceMember {
  return {
    id: agent.id,
    kind: "agent",
    name: agent.name,
    avatarUrl: agent.avatarUrl ?? null,
    avatarSeed: agent.avatarSeed,
    avatarHue: agent.avatarHue ?? null,
    working,
  };
}

export function personMember(person: WorkspacePerson): WorkspaceMember {
  return {
    id: person.id,
    kind: "human",
    name: person.name,
    avatarUrl: person.avatarUrl,
    presence: person.online ? "active" : "offline",
  };
}

/** The member an id names: an agent, a person of the roster, the reader, or the name the record carries. */
export function memberById(directory: WorkspaceDirectory, id: string, fallbackName?: string): WorkspaceMember {
  const agent = directory.agents.find((candidate) => candidate.id === id);
  if (agent) return agentMember(agent, agentWorking(directory, id));
  const person = directory.people.find((candidate) => candidate.id === id);
  if (person) return personMember(person);
  if (directory.isReader(id))
    return {
      id,
      kind: "human",
      name: directory.reader.name,
      avatarUrl: directory.reader.avatarUrl,
      presence: "active",
    };
  return { id, kind: "human", name: directory.names?.[id] ?? fallbackName ?? id, presence: "offline" };
}

/** The author of a channel message, with the external mark for a person a bridge brought. */
export function messageAuthor(directory: WorkspaceDirectory, entry: ChannelMessage): WorkspaceMember {
  if (entry.externalAuthor)
    return {
      id: `${entry.externalAuthor.platform}:${entry.externalAuthor.id}`,
      kind: "human",
      name: entry.externalAuthor.name,
      avatarUrl: entry.externalAuthor.avatarUrl ?? null,
      external: true,
    };
  if (entry.author.kind === "member") return memberById(directory, entry.author.id, entry.author.name);
  const agent = directory.agents.find((candidate) => candidate.id === entry.author.id);
  return agent
    ? agentMember(agent, agentWorking(directory, agent.id))
    : { id: entry.author.id, kind: "agent", name: entry.author.name, avatarSeed: entry.author.id };
}

/** The people ids of a channel. */
export function humanIds(channel: ChannelWorkspaceFields): readonly string[] {
  return channel.humanMemberIds ?? [];
}

/**
 * Whether the reader is in the channel. A channel from before the workspace lists no people: every
 * member of the server reads it, as before.
 */
export function readerJoined(directory: WorkspaceDirectory, channel: ChannelWorkspaceFields): boolean {
  const ids = humanIds(channel);
  return ids.length === 0 || ids.some((id) => directory.isReader(id));
}

/** The members of a channel: its people first, then its agents. */
export function channelMembers(
  directory: WorkspaceDirectory,
  channel: ChannelWorkspaceFields & { members: readonly { agentId: string }[] },
): WorkspaceMember[] {
  return [
    ...humanIds(channel).map((id) => memberById(directory, id)),
    ...channel.members.map((member) => memberById(directory, member.agentId)),
  ];
}

/** The other members of a DM or a group: everyone but the reader. */
export function otherMembers(
  directory: WorkspaceDirectory,
  channel: ChannelWorkspaceFields & { members: readonly { agentId: string }[] },
): WorkspaceMember[] {
  return channelMembers(directory, channel).filter(
    (member) => !(member.kind === "human" && directory.isReader(member.id)),
  );
}

/** The name of a conversation: the channel name, or the names of the others in a DM. */
export function conversationName(
  directory: WorkspaceDirectory,
  channel: ChannelWorkspaceFields & { name: string; members: readonly { agentId: string }[] },
): string {
  if (channelKind(channel) === "channel") return channel.name;
  const names = otherMembers(directory, channel).map((member) => member.name);
  return names.length ? names.join(", ") : channel.name;
}

/** The agent of a DM with one agent and no other person, or null. */
export function soleAgentOf(
  directory: WorkspaceDirectory,
  channel: ChannelWorkspaceFields & { members: readonly { agentId: string }[] },
): string | null {
  if (channelKind(channel) === "channel") return null;
  const people = humanIds(channel).filter((id) => !directory.isReader(id));
  return people.length === 0 && channel.members.length === 1 ? (channel.members[0]?.agentId ?? null) : null;
}

/** The channels of the sidebar: named channels the reader is in, by name. */
export function sidebarChannels(
  directory: WorkspaceDirectory,
  summaries: readonly ChannelSummary[],
  mentions: Readonly<Record<string, number>>,
): SidebarChannel[] {
  return summaries
    .filter((channel) => !channel.archived && channelKind(channel) === "channel" && readerJoined(directory, channel))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      visibility: channelVisibility(channel),
      unread: channel.unreadCount > 0,
      mentionCount: mentions[channel.id] ?? 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export interface DirectMessagesInput {
  directory: WorkspaceDirectory;
  summaries: readonly ChannelSummary[];
  /** The server owner reads each agent's main chat as its DM. */
  agentDmIsMainChat: boolean;
  hiddenAgentIds: ReadonlySet<string>;
}

/**
 * The DMs of the sidebar: the DM and group channels, newest first, then one row for each agent the
 * reader has no DM channel with. For the owner an agent's row opens its main chat, so the owner's DM
 * channels with one agent stay out unless they hold messages.
 */
export function sidebarDirectMessages(input: DirectMessagesInput): SidebarDirectMessage[] {
  const { directory } = input;
  const rows: { row: SidebarDirectMessage; at: number }[] = [];
  const agentsWithChannel = new Set<string>();
  for (const channel of input.summaries) {
    const kind = channelKind(channel);
    if (channel.archived || kind === "channel" || !readerJoined(directory, channel)) continue;
    const soleAgent = soleAgentOf(directory, channel);
    if (soleAgent && input.agentDmIsMainChat && !channel.lastMessage) continue;
    if (soleAgent && !input.agentDmIsMainChat) agentsWithChannel.add(soleAgent);
    const members = otherMembers(directory, channel);
    rows.push({
      row: {
        id: channel.id,
        kind: kind === "group" ? "group" : "dm",
        members: members.length ? members : [memberById(directory, directory.reader.id ?? "", directory.reader.name)],
        unread: channel.unreadCount > 0,
        mentionCount: channel.unreadCount,
      },
      at: channel.lastMessage ? Date.parse(channel.lastMessage.at) : Date.parse(channel.createdAt),
    });
  }
  rows.sort((left, right) => right.at - left.at);
  const agentRows = directory.agents
    .filter((agent) => !input.hiddenAgentIds.has(agent.id) && !agentsWithChannel.has(agent.id))
    .map((agent): SidebarDirectMessage => {
      const state = directory.agentStates[agent.id];
      const unread = state?.kind === "unread" ? state.count : state?.kind === "waiting" ? 1 : 0;
      return {
        id: `${AGENT_DM_PREFIX}${agent.id}`,
        kind: "dm",
        members: [agentMember(agent, state?.kind === "working")],
        unread: unread > 0 || state?.kind === "responded",
        mentionCount: input.agentDmIsMainChat ? unread : 0,
      };
    });
  return [...rows.map((entry) => entry.row), ...agentRows];
}

/** A thinking or narration part of an agent's turn: it folds into the steps above the answer. */
export function isStepEntry(entry: ChannelMessage): boolean {
  return entry.message.author === "assistant" && entry.message.itemType === "commentary";
}

/** A message the transcript draws: text, files, a question, or a deleted message that keeps replies. */
export function visibleEntry(entry: ChannelMessage): boolean {
  if (isStepEntry(entry)) return false;
  if (entry.deletedAt) return (entry.threadSummary?.replyCount ?? 0) > 0;
  return Boolean(
    entry.message.text.trim() ||
      entry.message.attachments?.length ||
      entry.message.questionPrompt ||
      (entry.threadSummary?.replyCount ?? 0) > 0,
  );
}

export interface WorkspaceStepTrailView {
  steps: AgentStepView[];
  durationMs?: number | undefined;
  streaming: boolean;
}

/** One row of the message list. Dividers ride on the row they stand above, so a row is a message. */
export interface WorkspaceMessageRowModel {
  key: string;
  /** The message, or the last step of a turn that has no answer yet. */
  entry: ChannelMessage;
  /** A turn that works and has not answered: the row shows its steps only. */
  pending: boolean;
  grouped: boolean;
  /** The start of a day: a divider stands above the row. */
  dayStart: number | null;
  /** The first unread message: the "new" divider stands above the row. */
  firstUnread: boolean;
  steps: WorkspaceStepTrailView | null;
}

function stepLabel(entry: ChannelMessage): string {
  const line =
    markdownPlainText(entry.message.text)
      .split("\n")
      .find((text) => text.trim()) ?? "";
  return line.trim().slice(0, 160);
}

function stepsOf(turn: readonly ChannelMessage[], answer: ChannelMessage | null): WorkspaceStepTrailView {
  const streaming = turn.some((entry) => entry.message.status === "streaming") || answer === null;
  const first = turn[0];
  const end = answer ?? turn.at(-1);
  const durationMs =
    first && end ? Math.max(0, Date.parse(end.message.createdAt) - Date.parse(first.message.createdAt)) : undefined;
  return {
    steps: turn.map((entry, index) => ({
      id: entry.id,
      kind: "think",
      label: stepLabel(entry),
      status:
        entry.message.status === "failed" ? "failed" : streaming && index === turn.length - 1 ? "running" : "done",
    })),
    durationMs: durationMs || undefined,
    streaming,
  };
}

function dayKey(at: number): string {
  return new Date(at).toDateString();
}

/**
 * The rows of a channel transcript or a thread. The steps of each agent turn go on its answer; a
 * turn that has not answered yet is a row of its own. Messages of one author within five minutes
 * group, and a day divider and the "new" divider stand above the row they belong to.
 */
export function messageRows(
  entries: readonly ChannelMessage[],
  options: {
    firstUnreadId?: string | null;
    thread?: boolean;
    /** Agents whose work runs here: their newest turn without an answer shows as working. */
    working?: ReadonlySet<string>;
  } = {},
): WorkspaceMessageRowModel[] {
  const shown = options.thread ? entries : entries.filter((entry) => !isChannelThreadReply(entry));
  const turns = new Map<string, ChannelMessage[]>();
  for (const entry of shown) {
    if (!isStepEntry(entry)) continue;
    const key = `${entry.author.id}:${entry.message.turnId ?? entry.taskId ?? entry.id}`;
    const turn = turns.get(key);
    if (turn) turn.push(entry);
    else turns.set(key, [entry]);
  }
  const answered = new Set<string>();
  const rows: WorkspaceMessageRowModel[] = [];
  let previous: { authorKey: string; at: number; day: string } | null = null;
  const push = (entry: ChannelMessage, pending: boolean, steps: WorkspaceStepTrailView | null) => {
    const at = Date.parse(entry.message.createdAt);
    const day = dayKey(at);
    const authorKey = `${entry.author.kind}:${entry.externalAuthor?.id ?? entry.author.id}`;
    const firstUnread = !pending && options.firstUnreadId === entry.id;
    const dayStart = previous?.day === day ? null : at;
    const grouped =
      previous !== null &&
      dayStart === null &&
      !firstUnread &&
      previous.authorKey === authorKey &&
      at - previous.at < GROUP_GAP_MS;
    rows.push({
      key: pending ? `pending:${entry.id}` : entry.id,
      entry,
      pending,
      grouped,
      dayStart,
      firstUnread,
      steps,
    });
    previous = { authorKey, at, day };
  };
  for (const entry of shown) {
    if (isStepEntry(entry)) continue;
    if (!visibleEntry(entry)) continue;
    let steps: WorkspaceStepTrailView | null = null;
    if (entry.author.kind === "agent") {
      const key = `${entry.author.id}:${entry.message.turnId ?? entry.taskId ?? entry.id}`;
      const turn = turns.get(key);
      if (turn && !answered.has(key)) {
        const before = turn.filter((step) => step.sequence < entry.sequence);
        if (before.length) {
          steps = stepsOf(before, entry);
          answered.add(key);
        }
      }
    }
    push(entry, false, steps);
  }
  // A turn that has thought but not answered yet shows at the end, with its steps streaming.
  const newestTurn = new Map<string, string>();
  for (const [key, turn] of turns) {
    const last = turn.at(-1);
    if (last) newestTurn.set(last.author.id, key);
  }
  for (const [key, turn] of turns) {
    if (answered.has(key)) continue;
    const last = turn.at(-1);
    if (!last) continue;
    const running =
      last.message.status === "streaming" ||
      (options.working?.has(last.author.id) === true && newestTurn.get(last.author.id) === key);
    if (running) push(last, true, stepsOf(turn, null));
  }
  return rows;
}

/** The reactions of a message as the reaction bar shows them. */
export function reactionViews(
  directory: WorkspaceDirectory,
  reactions: readonly ChannelReaction[] | undefined,
): WorkspaceReaction[] {
  return (reactions ?? []).map((reaction) => ({
    emoji: reaction.emoji,
    count: reaction.actors.length,
    reacted: reaction.actors.some((actor) => actor.kind === "member" && directory.isReader(actor.id)),
    actors: reaction.actors.map((actor) => memberById(directory, actor.id).name),
  }));
}

/** Whether the reader reacted with `emoji`. */
export function readerReacted(
  directory: WorkspaceDirectory,
  reactions: readonly ChannelReaction[] | undefined,
  emoji: string,
): boolean {
  return (
    reactions?.some(
      (reaction) =>
        reaction.emoji === emoji &&
        reaction.actors.some((actor) => actor.kind === "member" && directory.isReader(actor.id)),
    ) ?? false
  );
}

export function threadSummaryView(directory: WorkspaceDirectory, entry: ChannelMessage): ThreadSummary | undefined {
  const summary = entry.threadSummary;
  if (!summary || summary.replyCount <= 0) return undefined;
  return {
    replyCount: summary.replyCount,
    lastReplyAt: Date.parse(summary.lastReplyAt),
    participants: summary.participantIds.map((id) => memberById(directory, id)),
  };
}

/** Whether a message mentions the reader, by name or by `@channel` / `@here`. */
export function mentionsReader(directory: WorkspaceDirectory, entry: ChannelMessage): boolean {
  if (entry.author.kind === "member" && directory.isReader(entry.author.id)) return false;
  const mentions =
    entry.mentions ??
    chatTagReferences(entry.message.text)
      .filter((reference) => reference.kind === "member")
      .map((reference) => ({ kind: "member" as const, id: reference.id }));
  return mentions.some(
    (mention) =>
      mention.kind === "channel" ||
      mention.kind === "here" ||
      (mention.kind === "member" && directory.isReader(mention.id ?? "")),
  );
}

/** The plain one-line text of a message, for a preview. */
export function previewText(text: string, limit = 160): string {
  const plain = markdownPlainText(
    text.replace(/([@#])\[([^\]\r\n]+)\]\((?:agent|skill|mcp|quote|member|channel)(?:\+uri)?:[^)\r\n]+\)/gu, "$1$2"),
  )
    .replace(/\s+/gu, " ")
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit - 1)}…` : plain;
}

const LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()\]]+)/giu;
const DOC_EXTENSIONS = /\.(?:pdf|docx?|odt|rtf|md|txt)$/iu;
const DECK_EXTENSIONS = /\.(?:pptx?|key|odp)$/iu;
const SHEET_EXTENSIONS = /\.(?:xlsx?|csv|ods)$/iu;
const PAGE_EXTENSIONS = /\.html?$/iu;
/** The host of the apps that agents deploy, and of the download gateway. */
const APPS_DOMAIN = "delynith.com";
const DOWNLOAD_HOST = "dl.delynith.com";

function artifactKindOf(url: URL): WorkspaceArtifact["kind"] | null {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  if (host === DOWNLOAD_HOST) return DECK_EXTENSIONS.test(path) ? "deck" : DOC_EXTENSIONS.test(path) ? "doc" : "file";
  if (host === APPS_DOMAIN || host.endsWith(`.${APPS_DOMAIN}`))
    return host.startsWith("dashboard") || path.includes("dashboard") ? "dashboard" : "app";
  if (PAGE_EXTENSIONS.test(path)) return "website";
  if (DECK_EXTENSIONS.test(path)) return "deck";
  if (SHEET_EXTENSIONS.test(path)) return "dashboard";
  if (DOC_EXTENSIONS.test(path)) return "doc";
  if (host === "openbot.site" || host.endsWith(".openbot.site")) return "website";
  if (host.endsWith(".pages.dev") || host.endsWith(".netlify.app") || host.endsWith(".vercel.app")) return "website";
  return null;
}

function artifactTitle(url: URL, label: string | undefined): string {
  if (label && label !== url.href) return label;
  const file = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "");
  if (file && /\.[a-z0-9]{2,5}$/iu.test(file)) return file;
  return url.hostname.split(".")[0] === "www" ? url.hostname.slice(4) : url.hostname;
}

/**
 * The deliverables an agent message names: hosted apps and sites, pages, documents, decks and
 * sheets that its links point to, and the files it attached.
 */
export function messageArtifacts(
  directory: WorkspaceDirectory,
  entry: ChannelMessage,
  channelName?: string,
): WorkspaceArtifact[] {
  if (entry.author.kind !== "agent" || entry.deletedAt) return [];
  const agent = messageAuthor(directory, entry);
  const createdAt = Date.parse(entry.message.createdAt);
  const found = new Map<string, WorkspaceArtifact>();
  for (const match of entry.message.text.matchAll(LINK)) {
    const raw = (match[2] ?? match[3] ?? "").replace(/[.,!?;:]+$/u, "");
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    const kind = artifactKindOf(url);
    if (!kind || found.has(url.href)) continue;
    found.set(url.href, {
      id: `${entry.id}:${url.href}`,
      kind,
      title: artifactTitle(url, match[1]),
      description: artifactTitle(url, match[1]) === url.hostname ? undefined : url.hostname,
      url: url.href,
      agent,
      channelId: entry.channelId,
      channelName,
      createdAt,
    });
  }
  for (const attachment of entry.message.attachments ?? []) {
    const kind: WorkspaceArtifact["kind"] = DECK_EXTENSIONS.test(attachment.name)
      ? "deck"
      : DOC_EXTENSIONS.test(attachment.name)
        ? "doc"
        : PAGE_EXTENSIONS.test(attachment.name)
          ? "website"
          : "file";
    if (attachment.kind === "image") continue;
    found.set(`attachment:${attachment.id}`, {
      id: `${entry.id}:attachment:${attachment.id}`,
      kind,
      title: attachment.name,
      agent,
      channelId: entry.channelId,
      channelName,
      createdAt,
    });
  }
  return [...found.values()];
}

/** The agents that the gate still considers for the newest messages of people: they are "thinking". */
export function thinkingAgents(entries: readonly ChannelMessage[]): string[] {
  const ids = new Set<string>();
  for (const entry of entries.slice(-20)) for (const id of entry.gatePending ?? []) ids.add(id);
  return [...ids];
}

/** The agents whose work in this channel runs now, or whose answer still streams: they are "working". */
export function workingAgents(
  entries: readonly ChannelMessage[],
  tasks: readonly { state: string; ownerAgentId: string | null }[],
): string[] {
  const ids = new Set<string>();
  for (const task of tasks) if (task.state === "running" && task.ownerAgentId) ids.add(task.ownerAgentId);
  for (const entry of entries.slice(-30))
    if (entry.author.kind === "agent" && entry.message.status === "streaming") ids.add(entry.author.id);
  return [...ids];
}

/** Markdown that the light row cannot show: emphasis, code, quotes, headings, lists, tables, links. */
const MARKDOWN = /[*_`~|\\]|^\s{0,3}(?:#|>|[-+]\s|\d+[.)]\s)|\]\(|<\w|\n\s*\n/mu;
const PLAIN_TOKEN =
  /([@#])\[([^\]\r\n]+)\]\((agent|member|channel)(\+uri)?:([^)\r\n]+)\)|(^|[^\w@])(@(?:channel|everyone|here))\b|https?:\/\/[^\s<>()]+/gu;

/**
 * The runs of a short plain message: text, mentions, channel links, broadcasts and bare links. A
 * message with Markdown, files, a question or a streaming body returns null and gets the full
 * renderer. Most chat lines are plain, and the light row keeps a long channel fast to scroll.
 */
export function plainMessageSegments(directory: WorkspaceDirectory, entry: ChannelMessage): MessageSegment[] | null {
  const message = entry.message;
  if (
    message.status === "streaming" ||
    message.attachments?.length ||
    message.questionPrompt ||
    message.uiBlock ||
    message.text.length > 2_000 ||
    MARKDOWN.test(message.text)
  )
    return null;
  const text = message.text;
  const segments: MessageSegment[] = [];
  let cursor = 0;
  const push = (value: string) => {
    if (value) segments.push({ kind: "text", text: value });
  };
  for (const match of text.matchAll(PLAIN_TOKEN)) {
    const index = match.index ?? 0;
    if (match[3] !== undefined) {
      if (match[4]) return null;
      const kind = match[3];
      if ((match[1] === "#") !== (kind === "channel")) continue;
      push(text.slice(cursor, index));
      const id = match[5] ?? "";
      const name = match[2] ?? "";
      if (kind === "channel") segments.push({ kind: "channel", name, channelId: id });
      else
        segments.push({
          kind: "mention",
          label: kind === "agent" ? (directory.agents.find((agent) => agent.id === id)?.name ?? name) : name,
          memberId: id,
          self: kind === "member" && directory.isReader(id),
        });
      cursor = index + match[0].length;
      continue;
    }
    if (match[7] !== undefined) {
      const start = index + (match[6]?.length ?? 0);
      push(text.slice(cursor, start));
      segments.push({ kind: "broadcast", label: match[7].slice(1).toLowerCase() === "here" ? "here" : "channel" });
      cursor = start + match[7].length;
      continue;
    }
    const href = match[0].replace(/[.,!?;:]+$/u, "");
    push(text.slice(cursor, index));
    segments.push({ kind: "link", text: href, href });
    cursor = index + href.length;
  }
  push(text.slice(cursor));
  return segments;
}
