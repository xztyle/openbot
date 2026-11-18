/*
 * What a workspace message box offers: the people and agents that `@` mentions, the channels that `#`
 * links, the emoji that `:` finds, and whether the formatting toolbar shows. The composer under a
 * conversation and the editor of a message in place share them.
 */

import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { isDynamicRecord } from "@openbot/contracts/runtime-values";
import type { ComposerChannel, ComposerEmoji, ComposerMember } from "@openbot/ui/features/conversation/composer-picker";
import { searchEmoji, withSkinTone } from "@openbot/ui/features/workspace/emoji-data";
import { usesTouchLayout } from "@openbot/ui/utils";
import { createMemo, createSignal } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { readerJoined } from "./workspace-model";

const TOOLBAR_KEY = "openbot.workspace.composer.toolbar.v1";

/**
 * Whether the formatting toolbar shows under a conversation and in a thread. On this computer. Until
 * the reader chooses, it shows under a conversation on a computer only: a phone keeps the room for
 * the messages, as Slack's app does.
 */
function readToolbar(): { main: boolean; thread: boolean } {
  const fallback = { main: !usesTouchLayout(), thread: false };
  try {
    const value = JSON.parse(window.localStorage.getItem(TOOLBAR_KEY) ?? "{}");
    const record = isDynamicRecord(value) ? value : {};
    return {
      main: typeof record.main === "boolean" ? record.main : fallback.main,
      thread: typeof record.thread === "boolean" ? record.thread : fallback.thread,
    };
  } catch {
    return fallback;
  }
}

// One choice for every composer of the window, as Slack keeps the "Aa" toggle.
const [toolbar, setToolbar] = createSignal(
  typeof window === "undefined" ? { main: true, thread: false } : readToolbar(),
);

/** The toolbar choice of a composer under a conversation (`main`) or in a thread. */
export function composerToolbar(place: "main" | "thread") {
  return {
    shown: () => toolbar()[place],
    setShown: (shown: boolean) => {
      const next = { ...toolbar(), [place]: shown };
      setToolbar(next);
      try {
        window.localStorage.setItem(TOOLBAR_KEY, JSON.stringify(next));
      } catch {
        // A private window keeps the choice for this session.
      }
    },
  };
}

/** The mention, channel and emoji sources of a message box in a conversation. */
export function useComposerSources(channelId: () => string) {
  const ws = useWorkspace();
  const people = createMemo((): ComposerMember[] =>
    ws.env
      .people()
      .filter((person) => !ws.env.isReader(person.id))
      .map((person) => ({ id: person.id, name: person.name, avatarUrl: person.avatarUrl })),
  );
  /** A mention reaches only members, so the picker offers only the agents of this conversation. */
  const mentionAgents = createMemo(() => {
    const summary = ws.summary(channelId());
    if (!summary) return ws.env.agents();
    const members = new Set(summary.members.map((member) => member.agentId));
    return ws.env.agents().filter((agent) => members.has(agent.id));
  });
  const channelLinks = createMemo((): ComposerChannel[] =>
    ws.channels.state.channels
      .filter(
        (channel) =>
          !channel.archived &&
          channelKind(channel) === "channel" &&
          (channelVisibility(channel) === "public" || readerJoined(ws.directory(), channel)),
      )
      .map((channel) => ({ id: channel.id, name: channel.name, private: channelVisibility(channel) === "private" })),
  );
  const isChannel = () => {
    const summary = ws.summary(channelId());
    return summary ? channelKind(summary) !== "dm" : true;
  };
  /** Slack's `:smile`: the emoji whose short code or name starts with the letters, in the reader's skin tone. */
  const emojiSearch = (query: string): ComposerEmoji[] =>
    searchEmoji(query, 8).map((entry) => ({
      emoji: withSkinTone(entry, ws.state.emoji.skinTone),
      name: entry.n,
      code: entry.k?.startsWith(":") ? (entry.k.slice(1).split(" ")[0] ?? entry.n) : entry.n.replaceAll(" ", "_"),
    }));
  return { people, mentionAgents, channelLinks, isChannel, emojiSearch };
}
