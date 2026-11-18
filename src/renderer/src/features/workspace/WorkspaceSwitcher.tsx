/*
 * Jump to (⌘K), as Slack's quick switcher: with no text, the unread conversations first, then the
 * recent ones; with text, fuzzy matches (word starts, initials, names without their separators)
 * ranked with the reader's visits ("frecency"). It also opens the workspace views, and offers to
 * create a channel when no channel has the typed name. Conversations of another space say which.
 */

import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Button, FormDialog, Hash, Input, Lock, Plus, Search } from "@openbot/ui";
import { AiBadge, MemberAvatar } from "@openbot/ui/features/workspace/WorkspaceAvatar";
import type { WorkspaceView } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import { slugChannelName } from "@openbot/ui/features/workspace/workspace-format";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";
import {
  AGENT_DM_PREFIX,
  channelMembers,
  conversationName,
  memberById,
  personMember,
  readerJoined,
} from "./workspace-model";

export interface JumpEntry {
  /** A conversation id, `agent:<id>`, `person:<id>`, `view:<view>` or `create:<name>`. */
  id: string;
  label: string;
  kind: "channel" | "dm" | "agent" | "person" | "view" | "create" | "search";
  private?: boolean | undefined;
  member?: WorkspaceMember | undefined;
  unread?: boolean | undefined;
  /** Mentions and DM messages that are not read. */
  mentions?: number | undefined;
  /** The name of the space of a conversation of another space. */
  space?: string | undefined;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

const SEPARATORS = /[\s\-_.,#@]+/u;

/**
 * How well a name matches typed text, as Slack's switcher reads it: the whole name, its start, the
 * start of a word, the initials ("dh" finds Duretti Hirpa), the name without separators ("devweb"
 * finds #devel-webapp), a part of it, the letters in order at word starts, then the letters in order
 * anywhere. -1: no match.
 */
export function jumpMatch(name: string, typed: string): number {
  const text = fold(typed).replace(/^[#@]/u, "").trim();
  if (!text) return 0;
  const full = fold(name);
  if (full === text) return 1_000;
  if (full.startsWith(text)) return 800;
  const words = full.split(SEPARATORS).filter(Boolean);
  const compactText = text.replace(new RegExp(SEPARATORS.source, "gu"), "");
  if (words.some((word) => word.startsWith(text))) return 600;
  const initials = words.map((word) => word[0]).join("");
  if (compactText.length > 1 && initials.startsWith(compactText)) return 550;
  const compact = words.join("");
  if (compact.startsWith(compactText)) return 500;
  if (full.includes(text)) return 350;
  if (compact.includes(compactText)) return 300;
  // The letters in order, each word giving its first letters: "devweb" → "devel-webapp".
  let index = 0;
  for (const word of words) {
    let at = 0;
    while (index < compactText.length && at < word.length && word[at] === compactText[index]) {
      index += 1;
      at += 1;
    }
    if (index === compactText.length) return 200;
  }
  // The letters in order anywhere ("gnrl" → "general"), the weakest match.
  if (compactText.length > 2) {
    let at = 0;
    for (const char of compact) if (char === compactText[at]) at += 1;
    if (at === compactText.length) return 100;
  }
  return -1;
}

/** The entries of Jump to, and of the search field's suggestions. */
export function useJumpEntries() {
  const ws = useWorkspace();
  const { t } = useText();
  const VIEWS: readonly { view: WorkspaceView; label: () => string }[] = [
    { view: "unreads", label: () => t("workspace.view.unreads") },
    { view: "threads", label: () => t("workspace.view.threads") },
    { view: "activity", label: () => t("workspace.view.activity") },
    { view: "dms", label: () => t("workspace.view.dms") },
    { view: "later", label: () => t("workspace.view.later") },
    { view: "fleet", label: () => t("workspace.view.fleet") },
    { view: "artifacts", label: () => t("workspace.view.artifacts") },
    { view: "agents", label: () => t("workspace.view.agents") },
    { view: "space-agents", label: () => t("workspace.view.spaceAgents") },
    { view: "storage", label: () => t("storageHygiene.title") },
    { view: "secrets", label: () => t("workspace.view.secrets") },
    { view: "routines", label: () => t("workspace.app.menu.routines") },
  ];

  const conversations = createMemo((): JumpEntry[] => {
    const list: JumpEntry[] = [];
    // Every space: a conversation of another space says which one, and opening it shows that space.
    const elsewhere = (spaceId: string) =>
      ws.spaces.available() && spaceId !== ws.spaces.current() ? { space: ws.spaces.space(spaceId)?.name } : {};
    const mentions = new Map(
      [...ws.sidebarChannels(), ...ws.sidebarDirectMessages()].map((row) => [row.id, row.mentionCount ?? 0]),
    );
    for (const channel of ws.channels.state.channels) {
      if (channel.archived || !readerJoined(ws.directory(), channel)) continue;
      const kind = channelKind(channel);
      list.push({
        ...elsewhere(ws.spaces.channelSpace(channel.id)),
        id: channel.id,
        label: conversationName(ws.directory(), channel),
        kind: kind === "channel" ? "channel" : "dm",
        private: channelVisibility(channel) === "private",
        member:
          kind === "channel"
            ? undefined
            : channelMembers(ws.directory(), channel).find((member) => !ws.env.isReader(member.id)),
        unread: channel.unreadCount > 0 && !ws.isMuted(channel.id),
        mentions: mentions.get(channel.id) ?? 0,
      });
    }
    for (const agent of ws.env.agents()) {
      if (ws.env.hiddenAgentIds().has(agent.id) || !ws.canMessageAgent(agent.id)) continue;
      const id = `${AGENT_DM_PREFIX}${agent.id}`;
      list.push({
        ...elsewhere(ws.spaces.agentSpace(agent.id)),
        id,
        label: agent.name,
        kind: "agent",
        member: memberById(ws.directory(), agent.id),
        mentions: mentions.get(id) ?? 0,
        unread: (mentions.get(id) ?? 0) > 0,
      });
    }
    for (const person of ws.env.people()) {
      if (ws.env.isReader(person.id)) continue;
      list.push({ id: `person:${person.id}`, label: person.name, kind: "person", member: personMember(person) });
    }
    return list;
  });

  const views = createMemo((): JumpEntry[] =>
    VIEWS.filter((item) => ws.viewAvailable(item.view) && (item.view !== "space-agents" || ws.spaces.available())).map(
      (item) => ({ id: `view:${item.view}`, label: item.label(), kind: "view" }),
    ),
  );

  /** The entries for a text. Empty text: unread first, then recent visits, then the space's own. */
  function entries(query: string, limit = 24): JumpEntry[] {
    const text = query.trim();
    const all = conversations();
    if (!text) {
      const recent = ws.frecency.recent();
      const rank = new Map(recent.map((id, index) => [id, index]));
      const home = all.filter((entry) => entry.space === undefined && entry.kind !== "person");
      const unread = home
        .filter((entry) => entry.unread || (entry.mentions ?? 0) > 0)
        .sort((left, right) => (right.mentions ?? 0) - (left.mentions ?? 0));
      const seen = new Set(unread.map((entry) => entry.id));
      const visited = all
        .filter((entry) => !seen.has(entry.id) && rank.has(entry.id))
        .sort((left, right) => (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0));
      for (const entry of visited) seen.add(entry.id);
      const rest = home.filter((entry) => !seen.has(entry.id));
      return [...unread, ...visited, ...rest].slice(0, limit);
    }
    const ranked = [...all, ...views()]
      .map((entry) => {
        const match = jumpMatch(entry.label, text);
        // A visit is worth up to a step of match quality; the space that shows wins a tie.
        const score =
          match < 0
            ? -1
            : match +
              Math.min(ws.frecency.score(entry.id), 400) * 0.5 +
              (entry.space === undefined ? 25 : 0) +
              (entry.unread ? 10 : 0);
        return { entry, score };
      })
      .filter((item) => item.score >= 0)
      .sort((left, right) => right.score - left.score)
      .map((item) => item.entry)
      .slice(0, limit);
    const name = slugChannelName(text.replace(/^#/u, ""));
    const taken = ws.channels.state.channels.some(
      (channel) => channelKind(channel) === "channel" && channel.name === name,
    );
    if (name && !taken && !text.startsWith("@"))
      ranked.push({ id: `create:${name}`, label: t("workspace.jump.create", { name }), kind: "create" });
    // The messages too, as Slack's phone search offers, after the names.
    if (ws.search.supported())
      ranked.push({ id: `search:${text}`, label: t("workspace.jump.searchMessages", { query: text }), kind: "search" });
    return ranked;
  }

  /** Opens an entry: a conversation, a person's DM, a view, or the form of a new channel. */
  function open(entry: JumpEntry) {
    if (entry.id.startsWith("person:")) ws.messageMember(entry.id.slice("person:".length));
    else if (entry.id.startsWith("view:")) {
      const view = entry.id.slice("view:".length);
      const found = VIEWS.find((item) => item.view === view);
      if (found) ws.openView(found.view);
    } else if (entry.kind === "search") ws.openSearch(entry.id.slice("search:".length));
    else if (entry.kind === "create") ws.openDialog({ kind: "create-channel", name: entry.id.slice("create:".length) });
    else ws.openConversation(entry.id);
  }

  return { entries, open };
}

/** ⌘K: jump to a conversation, a person, an agent or a view by name. */
export function QuickSwitcher(props: { onClose: () => void }) {
  const { t } = useText();
  const jump = useJumpEntries();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const entries = createMemo(() => jump.entries(query()));
  const choose = (entry: JumpEntry | undefined) => {
    if (!entry) return;
    props.onClose();
    jump.open(entry);
  };
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("workspace.app.switcher.title")}
    >
      <div class="ws-switcher-field">
        <Search aria-hidden="true" />
        <Input
          ref={(element) => {
            requestAnimationFrame(() => element.focus());
          }}
          value={query()}
          onValueChange={(value) => {
            setQuery(value);
            setActive(0);
          }}
          placeholder={t("workspace.app.switcher.placeholder")}
          aria-label={t("workspace.app.switcher.placeholder")}
          onKeyDown={(event: KeyboardEvent) => {
            const count = entries().length;
            if (event.key === "ArrowDown" && count) {
              event.preventDefault();
              setActive((index) => (index + 1) % count);
            } else if (event.key === "ArrowUp" && count) {
              event.preventDefault();
              setActive((index) => (index - 1 + count) % count);
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(entries()[active()]);
            }
          }}
        />
      </div>
      <Show when={!query().trim() && entries().length > 0}>
        <p class="ws-switcher-hint">{t("workspace.jump.hint")}</p>
      </Show>
      <ul class="ws-switcher-list" aria-label={t("workspace.app.switcher.results")}>
        <For each={entries()} fallback={<li class="ws-details-empty">{t("workspace.app.switcher.empty")}</li>}>
          {(entry, index) => (
            <li>
              <Button
                variant="ghost"
                class="ws-switcher-item"
                data-active={active() === index() ? "" : undefined}
                data-unread={entry.unread ? "" : undefined}
                onMouseEnter={() => setActive(index())}
                onClick={() => choose(entry)}
              >
                <span class="ws-switcher-glyph" aria-hidden="true">
                  <Show
                    when={entry.member}
                    fallback={
                      <Show
                        when={entry.kind === "create" || entry.kind === "search"}
                        fallback={
                          <Show when={entry.private} fallback={<Hash />}>
                            <Lock />
                          </Show>
                        }
                      >
                        <Show when={entry.kind === "search"} fallback={<Plus />}>
                          <Search />
                        </Show>
                      </Show>
                    }
                  >
                    {(member) => <MemberAvatar member={member()} size="xs" />}
                  </Show>
                </span>
                <span class="ws-switcher-label">{entry.label}</span>
                <Show when={entry.kind === "agent"}>
                  <AiBadge />
                </Show>
                <Show when={entry.kind === "view"}>
                  <span class="ws-switcher-space">{t("workspace.jump.view")}</span>
                </Show>
                <Show when={entry.space}>{(space) => <span class="ws-switcher-space">{space()}</span>}</Show>
                <Show when={(entry.mentions ?? 0) > 0}>
                  <span class="ws-mention-badge">{entry.mentions}</span>
                </Show>
              </Button>
            </li>
          )}
        </For>
      </ul>
    </FormDialog>
  );
}
