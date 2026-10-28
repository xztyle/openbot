import type { ActivityItem } from "@openbot/ui/features/workspace/ActivityView";
import type { ChannelDetailsMember } from "@openbot/ui/features/workspace/ChannelDetails";
import type { FleetAgent } from "@openbot/ui/features/workspace/FleetView";
import type { ThreadListItem } from "@openbot/ui/features/workspace/ThreadsView";
import type { SidebarChannel, SidebarDirectMessage } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type {
  AgentStepView,
  MessageSegment,
  WorkspaceArtifact,
  WorkspaceMember,
} from "@openbot/ui/features/workspace/workspace-types";

/*
 * The "Cakemaker" workspace that every workspace story uses: two humans (delynith owns it) and four
 * agents that build a cake-baking game together.
 */

const MINUTE = 60_000;
/** A fixed "now", so the stories render the same times on every run. */
export const NOW = new Date(2026, 9, 28, 15, 42).getTime();

export const delynith: WorkspaceMember = { id: "u-delynith", kind: "human", name: "delynith", presence: "active" };
export const fonikad: WorkspaceMember = { id: "u-fonikad", kind: "human", name: "Fonikad", presence: "away" };
export const orchestrator: WorkspaceMember = {
  id: "a-orchestrator",
  kind: "agent",
  name: "Orchestrator",
  avatarSeed: "orchestrator",
  avatarHue: 215,
  working: true,
};
export const gameDesigner: WorkspaceMember = {
  id: "a-game-designer",
  kind: "agent",
  name: "Game Designer",
  avatarSeed: "game-designer",
  avatarHue: 320,
};
export const qa: WorkspaceMember = {
  id: "a-qa",
  kind: "agent",
  name: "QA",
  avatarSeed: "qa",
  avatarHue: 150,
  working: true,
};
export const artProducer: WorkspaceMember = {
  id: "a-art-producer",
  kind: "agent",
  name: "Art Producer",
  avatarSeed: "art-producer",
  avatarHue: 30,
};
export const discordUser: WorkspaceMember = { id: "d-crumbs", kind: "human", name: "crumbs", external: true };

export const HUMANS = [delynith, fonikad] as const;
export const AGENTS = [orchestrator, gameDesigner, qa, artProducer] as const;
export const EVERYONE: readonly WorkspaceMember[] = [...HUMANS, ...AGENTS];

export const CHANNELS: readonly SidebarChannel[] = [
  { id: "c-general", name: "general", visibility: "public" },
  { id: "c-cakemaker", name: "cakemaker", visibility: "public", unread: true, mentionCount: 2 },
  { id: "c-leadership", name: "leadership", visibility: "private" },
  { id: "c-random", name: "random", visibility: "public", muted: true, unread: true },
];

export const DIRECT_MESSAGES: readonly SidebarDirectMessage[] = [
  { id: "dm-fonikad", kind: "dm", members: [fonikad], unread: true, mentionCount: 1 },
  { id: "dm-orchestrator", kind: "dm", members: [orchestrator] },
  { id: "dm-qa", kind: "dm", members: [qa] },
  { id: "dm-game-designer", kind: "dm", members: [gameDesigner] },
  { id: "group-art", kind: "group", members: [fonikad, artProducer, gameDesigner] },
];

export const text = (value: string): Extract<MessageSegment, { kind: "text" }> => ({ kind: "text", text: value });
export const mention = (member: WorkspaceMember, self = false): Extract<MessageSegment, { kind: "mention" }> => ({
  kind: "mention",
  label: member.name,
  memberId: member.id,
  self,
});

export const CAKEMAKER_SITE: WorkspaceArtifact = {
  id: "art-site",
  kind: "website",
  title: "Cakemaker — playable web build",
  description:
    "Level 1–3 with the new frosting mechanic, touch controls and the leaderboard. Hosted on the apps broker.",
  url: "https://cakemaker-web.delynith.com",
  agent: orchestrator,
  channelName: "cakemaker",
  costUsd: 1.84,
  durationMs: 27 * MINUTE + 12_000,
  createdAt: NOW - 20 * MINUTE,
};

export const ARTIFACTS: readonly WorkspaceArtifact[] = [
  CAKEMAKER_SITE,
  {
    id: "art-gdd",
    kind: "doc",
    title: "Game design document v3",
    description: "Core loop, economy of sugar and stars, 30 levels outlined with difficulty curve.",
    agent: gameDesigner,
    channelName: "cakemaker",
    costUsd: 0.42,
    durationMs: 9 * MINUTE,
  },
  {
    id: "art-qa",
    kind: "dashboard",
    title: "QA run — build 118",
    description: "142 checks, 3 failures on Safari iOS: the oven timer drifts after backgrounding.",
    agent: qa,
    channelName: "cakemaker",
    costUsd: 0.31,
    durationMs: 6 * MINUTE + 40_000,
  },
  {
    id: "art-deck",
    kind: "deck",
    title: "Launch plan for the leadership sync",
    description: "Timeline, budget and the store page plan.",
    agent: orchestrator,
    channelName: "leadership",
    costUsd: 0.18,
    durationMs: 4 * MINUTE,
  },
  {
    id: "art-sprites",
    kind: "file",
    title: "cake-sprites-v2.zip",
    description: "48 cake layers and toppings, 2x and 3x.",
    agent: artProducer,
    channelName: "cakemaker",
    costUsd: 0.96,
    durationMs: 14 * MINUTE,
  },
  {
    id: "art-editor",
    kind: "app",
    title: "Level editor",
    description: "Drag cake layers onto the grid and export JSON levels.",
    url: "https://cakemaker-editor.delynith.com",
    agent: gameDesigner,
    channelName: "cakemaker",
    costUsd: 2.4,
    durationMs: 41 * MINUTE,
  },
];

export const STEPS: readonly AgentStepView[] = [
  { id: "s1", kind: "skill", label: "Loaded skill “apps-broker”", status: "done", durationMs: 800 },
  { id: "s2", kind: "file", label: "Read web/src/levels.ts", detail: "312 lines", status: "done", durationMs: 400 },
  { id: "s3", kind: "shell", label: "bun run build", detail: "vite v7 · 1.2 MB", status: "done", durationMs: 14_000 },
  { id: "s4", kind: "tool", label: "appctl deploy cakemaker-web", status: "done", durationMs: 9_000 },
  { id: "s5", kind: "browse", label: "Opened cakemaker-web.delynith.com", status: "done", durationMs: 3_000 },
  {
    id: "s6",
    kind: "search",
    label: "Searched “safari visibilitychange timer drift”",
    status: "done",
    durationMs: 2_000,
  },
  { id: "s7", kind: "think", label: "Planned the fix for the oven timer", status: "done", durationMs: 13_000 },
];

export const STREAMING_STEPS: readonly AgentStepView[] = [
  ...STEPS.slice(0, 3),
  { id: "s4", kind: "tool", label: "appctl deploy cakemaker-web", status: "failed", durationMs: 2_000 },
  { id: "s5", kind: "shell", label: "bun run test --filter oven", status: "running" },
];

export const DETAILS_MEMBERS: readonly ChannelDetailsMember[] = [
  { member: delynith, role: "owner" },
  { member: fonikad, role: "member" },
  { member: orchestrator, answerMode: "always", gateEnabled: true, focus: "Plan, deploy and keep the build green" },
  { member: gameDesigner, answerMode: "always", gateEnabled: true, focus: "Level design and game feel" },
  { member: qa, answerMode: "mention", focus: "Test every build on desktop and iOS" },
  { member: artProducer, answerMode: "mention" },
];

export const FLEET: readonly FleetAgent[] = [
  {
    member: orchestrator,
    title: "Producer",
    status: { state: "working", task: "the web build deploy", channelName: "cakemaker" },
    currentStep: "appctl deploy cakemaker-web",
    todayCostUsd: 3.12,
    todayDurationMs: 74 * MINUTE,
  },
  {
    member: gameDesigner,
    title: "Game Designer",
    status: { state: "waiting", personName: "delynith", channelName: "cakemaker" },
    todayCostUsd: 1.05,
    todayDurationMs: 38 * MINUTE,
  },
  {
    member: qa,
    title: "QA Engineer",
    status: { state: "working", task: "regression tests for build 118" },
    currentStep: "bun run test --filter oven",
    todayCostUsd: 0.87,
    todayDurationMs: 52 * MINUTE,
  },
  {
    member: artProducer,
    title: "Art Producer",
    status: { state: "idle" },
    todayCostUsd: 0.96,
    todayDurationMs: 14 * MINUTE,
  },
];

export const ACTIVITY: readonly ActivityItem[] = [
  {
    id: "act-1",
    kind: "mention",
    actor: qa,
    channelName: "cakemaker",
    preview: "@delynith the oven timer drifts on Safari iOS after the app goes to the background. Can I ship the fix?",
    at: NOW - 4 * MINUTE,
    unread: true,
  },
  {
    id: "act-2",
    kind: "reply",
    actor: orchestrator,
    channelName: "cakemaker",
    preview: "Deployed to https://cakemaker-web.delynith.com — levels 1–3 are playable.",
    at: NOW - 18 * MINUTE,
    unread: true,
  },
  {
    id: "act-3",
    kind: "dm",
    actor: fonikad,
    preview: "Can we review the sprite pack before the leadership sync?",
    at: NOW - 3 * 60 * MINUTE,
    unread: false,
  },
  {
    id: "act-4",
    kind: "reaction",
    actor: gameDesigner,
    channelName: "general",
    emoji: "🎉",
    preview: "Welcome to the Cakemaker workspace!",
    at: NOW - 26 * 60 * MINUTE,
    unread: false,
  },
];

export const THREADS: readonly ThreadListItem[] = [
  {
    id: "m-root",
    channelName: "cakemaker",
    visibility: "public",
    author: delynith,
    text: [mention(orchestrator), text(" can you put the web build online so Fonikad can play it on the phone?")],
    replyCount: 4,
    lastReplyAt: NOW - 4 * MINUTE,
    participants: [orchestrator, qa, fonikad],
    unreadCount: 2,
  },
  {
    id: "m-budget",
    channelName: "leadership",
    visibility: "private",
    author: fonikad,
    text: [text("Budget for the launch trailer: is 2k ok?")],
    replyCount: 2,
    lastReplyAt: NOW - 2 * 60 * MINUTE,
    participants: [delynith, orchestrator],
  },
];
