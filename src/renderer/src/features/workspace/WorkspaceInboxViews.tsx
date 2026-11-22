/*
 * The views of the workspace that gather messages from every conversation: Unreads, Later, DMs and
 * the search results. Each one opens the exact message, in its thread when it is a reply.
 */

import { channelKind, channelVisibility, type WorkspaceSearchSort } from "@openbot/contracts/ipc";
import { Switch as Toggle, toast } from "@openbot/ui";
import { type DirectMessageItem, DirectMessagesView } from "@openbot/ui/features/workspace/DirectMessagesView";
import { type LaterItem, type LaterTab, LaterView } from "@openbot/ui/features/workspace/LaterView";
import { agentStatusText } from "@openbot/ui/features/workspace/MemberProfileCard";
import {
  type SearchChannelItem,
  type SearchHitItem,
  type SearchPersonItem,
  type SearchTab,
  SearchView,
} from "@openbot/ui/features/workspace/SearchView";
import { type UnreadGroup, UnreadsView } from "@openbot/ui/features/workspace/UnreadsView";
import { WorkspaceSelect } from "@openbot/ui/features/workspace/WorkspaceSelect";
import { parseSearchQuery, withSearchModifier } from "@openbot/ui/features/workspace/workspace-search-query";
import type { WorkspaceMember } from "@openbot/ui/features/workspace/workspace-types";
import { currentText, useText } from "@openbot/ui/text";
import { createMemo, createSignal } from "solid-js";
import { actionToast } from "../../action-toast";
import { useConversationMenu } from "./WorkspaceSidebarPane";
import { useWorkspace } from "./workspace-context";
import {
  AGENT_DM_PREFIX,
  channelMembers,
  conversationName,
  memberById,
  messageAuthor,
  otherMembers,
  personMember,
  plainMessageSegments,
  previewText,
  readerJoined,
} from "./workspace-model";
import { searchInValue } from "./workspace-search";

type Workspace = ReturnType<typeof useWorkspace>;

/** Opens a message: its channel, or its thread when it is a reply, scrolled to and marked. */
export function openWorkspaceMessage(ws: Workspace, channelId: string, messageId: string, threadRootId?: string) {
  if (threadRootId) ws.openThread(channelId, threadRootId);
  else ws.openChannel(channelId);
  ws.focusMessage(channelId, messageId);
}

/** `#general`, or the names of the others in a DM or a group. */
function placeName(ws: Workspace, channelId: string): string {
  const channel = ws.summary(channelId);
  if (!channel) return "";
  const name = conversationName(ws.directory(), channel);
  return channelKind(channel) === "channel" ? `#${name}` : name;
}

function authorMember(ws: Workspace, author: { kind: string; id: string; name: string }): WorkspaceMember {
  return author.kind === "external"
    ? { id: author.id, kind: "human", name: author.name, external: true }
    : memberById(ws.directory(), author.id, author.name);
}

/**
 * Reads threads through their newest reply, as Mark all as read in Threads and a thread opened from
 * there do. A host without thread positions reads nothing.
 */
export async function markThreadsRead(
  ws: Workspace,
  threads: readonly { channelId: string; rootId: string }[],
): Promise<void> {
  const read = ws.channels.port().agent.workspaceReadThread;
  if (!read || !threads.length) return;
  const results = await Promise.allSettled(
    threads.map(async (thread) => {
      const page = await ws.channels.port().agent.readChannel({
        channelId: thread.channelId,
        threadRootId: thread.rootId,
      });
      await read({
        operationId: crypto.randomUUID(),
        channelId: thread.channelId,
        threadRootId: thread.rootId,
        throughSequence: page.throughSequence,
      });
    }),
  );
  void ws.refreshActivity();
  if (results.some((result) => result.status === "rejected"))
    actionToast.error(currentText().t("workspace.threads.markFailed"));
}

// ---------------------------------------------------------------- Unreads

export function WorkspaceUnreadsView() {
  const ws = useWorkspace();
  const { t } = useText();
  const groups = createMemo((): UnreadGroup[] =>
    ws.unreads.state.groups.flatMap((group) => {
      const channel = ws.summary(group.channelId);
      if (!channel) return [];
      const kind = channelKind(channel);
      return [
        {
          id: group.channelId,
          name: conversationName(ws.directory(), channel),
          kind: kind === "group" ? "group" : kind === "dm" ? "dm" : "channel",
          visibility: channelVisibility(channel),
          members: kind === "channel" ? undefined : otherMembers(ws.directory(), channel),
          count: group.unreadCount,
          read: group.read,
          collapsed: group.collapsed,
          messages: group.messages.map((entry) => ({
            id: entry.id,
            author: messageAuthor(ws.directory(), entry),
            at: Date.parse(entry.message.createdAt),
            text: plainMessageSegments(ws.directory(), entry) ?? [
              { kind: "text", text: previewText(entry.message.text, 600) },
            ],
          })),
        },
      ];
    }),
  );
  const fail = (error: unknown) => actionToast.error(error instanceof Error ? error.message : String(error));
  return (
    <UnreadsView
      groups={groups()}
      loading={ws.unreads.state.loading && !ws.unreads.state.loaded}
      failed={ws.unreads.state.failed}
      onRetry={() => void ws.unreads.load()}
      stale={ws.unreads.stale()}
      onRefresh={() => void ws.unreads.load()}
      onOpenMessage={(channelId, messageId) => openWorkspaceMessage(ws, channelId, messageId)}
      onOpenConversation={(channelId) => ws.openChannel(channelId)}
      onMarkRead={(channelId) => void ws.unreads.markRead(channelId).catch(fail)}
      onUndo={ws.unreads.canUndo() ? (channelId) => void ws.unreads.undo(channelId).catch(fail) : undefined}
      onToggle={(channelId) => ws.unreads.toggle(channelId)}
      onMarkAllRead={() =>
        void ws.unreads
          .markAllRead()
          .then(() => ws.refreshActivity())
          .catch(() => actionToast.error(t("workspace.unreads.markFailed")))
      }
      onBack={() => ws.back()}
    />
  );
}

// ---------------------------------------------------------------- Later

export function WorkspaceLaterView() {
  const ws = useWorkspace();
  const { t } = useText();
  const [tab, setTab] = createSignal<LaterTab>("saved");
  const list = () => ws.later.state[tab()];
  const items = createMemo((): LaterItem[] =>
    list().items.map((item) => ({
      id: `${item.channelId}/${item.messageId}`,
      author: authorMember(ws, item.author),
      where: placeName(ws, item.channelId),
      inThread: Boolean(item.threadRootId),
      at: Date.parse(item.at),
      preview: item.preview,
      deleted: item.deleted,
    })),
  );
  const find = (id: string) =>
    [...ws.later.state.saved.items, ...ws.later.state.done.items].find(
      (item) => `${item.channelId}/${item.messageId}` === id,
    );
  const fail = (error: unknown) => actionToast.error(error instanceof Error ? error.message : String(error));
  return (
    <LaterView
      tab={tab()}
      onTabChange={(next) => {
        setTab(next);
        void ws.later.load(next);
      }}
      items={items()}
      savedCount={ws.later.count()}
      loading={list().loading && !list().loaded}
      failed={list().failed && list().items.length === 0}
      onRetry={() => void ws.later.load(tab())}
      hasMore={Boolean(list().nextCursor)}
      loadingMore={list().loadingMore}
      onLoadMore={() => void ws.later.load(tab(), true)}
      onOpen={(id) => {
        const item = find(id);
        if (item) openWorkspaceMessage(ws, item.channelId, item.messageId, item.threadRootId);
      }}
      onSetDone={(id, done) => {
        const item = find(id);
        if (item) void ws.later.set(item.channelId, item.messageId, done ? "done" : "saved").catch(fail);
      }}
      onRemove={(id) => {
        const item = find(id);
        if (!item) return;
        const before = item.state;
        void ws.later
          .set(item.channelId, item.messageId, null)
          .then(() =>
            // Undo instead of a confirm: the item comes back as it was.
            toast(t("workspace.later.removed"), {
              action: {
                label: t("common.undo"),
                onClick: () => void ws.later.set(item.channelId, item.messageId, before).catch(fail),
              },
            }),
          )
          .catch(fail);
      }}
      onBack={() => ws.back()}
    />
  );
}

// ---------------------------------------------------------------- DMs

/**
 * Slack's DMs list: a view on a computer (⌘⇧K, under More), and the DMs tab of a phone, which has
 * no Back. A right-click or a long press on a row opens the same actions as its sidebar row.
 */
export function WorkspaceDmsView(props: { tab?: boolean }) {
  const ws = useWorkspace();
  const text = useText();
  const conversationMenu = useConversationMenu();
  const items = createMemo((): DirectMessageItem[] => {
    const rows = ws.sidebarDirectMessages().map((row) => {
      const agentId = row.id.startsWith(AGENT_DM_PREFIX) ? row.id.slice(AGENT_DM_PREFIX.length) : null;
      const channel = agentId ? undefined : ws.summary(row.id);
      const last = channel?.lastMessage;
      const fromReader = last?.author ? ws.env.isReader(last.author.id) : false;
      // The owner's chat with an agent has no last message here: the agent's state says what it does.
      const agent = agentId ? ws.fleet.agents().find((entry) => entry.member.id === agentId) : undefined;
      const note =
        agent && (agent.status.state !== "idle" || !agent.title) ? agentStatusText(agent.status, text) : agent?.title;
      return {
        id: row.id,
        kind: row.kind,
        members: row.members,
        name: row.members.map((member) => member.name).join(", "),
        preview: last ? previewText(last.text, 160) : undefined,
        note,
        fromReader,
        author: last && !fromReader ? last.authorName : undefined,
        at: last ? Date.parse(last.at) : undefined,
        unread: Boolean(row.unread),
        count: row.mentionCount ?? 0,
        muted: row.muted,
        needsYou: row.needsYou,
      } satisfies DirectMessageItem;
    });
    // What waits for the reader first; then newest first, as Slack's DMs; a row with no message keeps
    // the sidebar's order after them.
    return rows.sort(
      (left, right) =>
        Number(Boolean(right.needsYou)) - Number(Boolean(left.needsYou)) || (right.at ?? 0) - (left.at ?? 0),
    );
  });
  return (
    <DirectMessagesView
      items={items()}
      // The phone's tab is a list of its own: the conversation behind it is not "selected" there.
      activeId={props.tab ? undefined : ws.activeConversationId()}
      loading={!ws.channels.state.listed}
      onOpen={(id) => ws.openConversation(id)}
      onNewMessage={() => ws.openDialog({ kind: "new-message" })}
      rowMenu={(id) => conversationMenu(id)}
      onBack={props.tab ? undefined : () => ws.back()}
    />
  );
}

// ---------------------------------------------------------------- search

type DateFilter = "any" | "today" | "yesterday" | "week" | "month" | "year";
/** The "any" option of the In and From filters: no modifier. No name is empty. */
const ANY = "__any__";

export function WorkspaceSearchView() {
  const ws = useWorkspace();
  const { t } = useText();
  const [tab, setTab] = createSignal<SearchTab>("messages");
  const search = ws.search;
  const parsed = createMemo(() => parseSearchQuery(search.state.query));
  const words = () => parsed().text.replace(/["-]/gu, " ").trim().toLocaleLowerCase();

  const hits = createMemo((): SearchHitItem[] =>
    search.state.hits.map((hit) => ({
      id: hit.messageId,
      author: authorMember(ws, hit.author),
      where: placeName(ws, hit.channelId),
      inThread: Boolean(hit.threadRootId),
      space:
        hit.spaceId && ws.spaces.available() && hit.spaceId !== ws.spaces.current()
          ? ws.spaces.space(hit.spaceId)?.name
          : undefined,
      at: Date.parse(hit.at),
      snippet: hit.snippet,
      highlights: hit.highlights,
    })),
  );

  const channels = createMemo((): SearchChannelItem[] => {
    const text = words();
    if (!text) return [];
    return ws.channels.state.channels
      .filter((channel) => {
        if (channelKind(channel) !== "channel" || !ws.spaces.channelInCurrent(channel.id)) return false;
        const joined = readerJoined(ws.directory(), channel);
        if (channelVisibility(channel) === "private" && !joined) return false;
        return (
          channel.name.toLocaleLowerCase().includes(text) ||
          (channel.topic ?? "").toLocaleLowerCase().includes(text) ||
          (channel.description ?? "").toLocaleLowerCase().includes(text)
        );
      })
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        visibility: channelVisibility(channel),
        topic: channel.topic || channel.description || undefined,
        memberCount: channelMembers(ws.directory(), channel).length,
        joined: readerJoined(ws.directory(), channel),
        archived: channel.archived,
      }))
      .slice(0, 50);
  });

  const people = createMemo((): SearchPersonItem[] => {
    const text = words();
    if (!text) return [];
    const matches = (name: string) =>
      name
        .toLocaleLowerCase()
        .split(/\s+/u)
        .some((word) => word.startsWith(text)) || name.toLocaleLowerCase().startsWith(text);
    return [
      ...ws.env
        .people()
        .filter((person) => !ws.env.isReader(person.id) && matches(person.name))
        .map((person) => ({
          id: `person:${person.id}`,
          member: personMember(person),
          detail: t(person.role === "member" ? "workspace.search.person" : "workspace.search.admin"),
        })),
      ...ws
        .spaceAgents()
        .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id) && matches(agent.name))
        .map((agent) => ({
          id: `${AGENT_DM_PREFIX}${agent.id}`,
          member: memberById(ws.directory(), agent.id),
          detail: agent.title || t("workspace.search.agent"),
        })),
    ].slice(0, 50);
  });

  /** The query with one filter changed, run again. */
  const refine = (query: string) => search.submit(query);
  const conversationOptions = createMemo(() => [
    { value: ANY, label: t("workspace.search.anyConversation") },
    ...ws.channels.state.channels
      .filter(
        (channel) =>
          !channel.archived && readerJoined(ws.directory(), channel) && ws.spaces.channelInCurrent(channel.id),
      )
      .map((channel) => {
        const name = conversationName(ws.directory(), channel);
        return {
          value: searchInValue(ws.directory(), channel),
          label: channelKind(channel) === "channel" ? `#${name}` : name,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label)),
  ]);
  const authorOptions = createMemo(() => [
    { value: ANY, label: t("workspace.search.anyone") },
    { value: "me", label: t("workspace.search.me") },
    ...ws.env
      .people()
      .filter((person) => !ws.env.isReader(person.id))
      .map((person) => ({ value: person.name, label: person.name })),
    ...ws
      .spaceAgents()
      .filter((agent) => !ws.env.hiddenAgentIds().has(agent.id))
      .map((agent) => ({ value: agent.name, label: agent.name })),
  ]);
  const dateValue = (): DateFilter => {
    const during = parsed().during?.toLocaleLowerCase();
    return during === "today" || during === "yesterday" || during === "week" || during === "month" || during === "year"
      ? during
      : "any";
  };
  const filtered = () =>
    parsed().in.length > 0 ||
    parsed().from.length > 0 ||
    parsed().threads ||
    Boolean(parsed().before || parsed().after || parsed().on || parsed().during);

  const filters = () => (
    <>
      <WorkspaceSelect
        label={t("workspace.search.in")}
        prefix={t("workspace.search.inPrefix")}
        value={parsed().in[0] ?? ANY}
        options={conversationOptions()}
        onChange={(value) => refine(withSearchModifier(search.state.query, "in", value === ANY ? null : value))}
      />
      <WorkspaceSelect
        label={t("workspace.search.from")}
        prefix={t("workspace.search.fromPrefix")}
        value={parsed().from[0] ?? ANY}
        options={authorOptions()}
        onChange={(value) =>
          refine(
            withSearchModifier(search.state.query, "from", value === ANY ? null : value === "me" ? "me" : `@${value}`),
          )
        }
      />
      <WorkspaceSelect<DateFilter>
        label={t("workspace.search.date")}
        value={dateValue()}
        options={[
          { value: "any", label: t("workspace.search.anyTime") },
          { value: "today", label: t("workspace.search.today") },
          { value: "yesterday", label: t("workspace.search.yesterday") },
          { value: "week", label: t("workspace.search.thisWeek") },
          { value: "month", label: t("workspace.search.thisMonth") },
          { value: "year", label: t("workspace.search.thisYear") },
        ]}
        onChange={(value) => {
          let query = withSearchModifier(search.state.query, "during", value === "any" ? null : value);
          for (const key of ["before", "after", "on"] as const) query = withSearchModifier(query, key, null);
          refine(query);
        }}
      />
      <span class="ws-inline-switch ws-search-threads">
        <span aria-hidden="true">{t("workspace.search.threadsOnly")}</span>
        <Toggle
          size="sm"
          aria-label={t("workspace.search.threadsOnly")}
          checked={parsed().threads}
          onChange={(checked: boolean) =>
            refine(withSearchModifier(search.state.query, "is", checked ? "thread" : null))
          }
        />
      </span>
      <WorkspaceSelect<WorkspaceSearchSort>
        label={t("workspace.search.sort")}
        value={search.state.sort}
        options={[
          { value: "relevance", label: t("workspace.search.relevance") },
          { value: "recent", label: t("workspace.search.newest") },
        ]}
        onChange={(value) => search.setSort(value)}
      />
      {ws.spaces.available() ? (
        <WorkspaceSelect<"space" | "all">
          label={t("workspace.search.scope")}
          value={search.state.everywhere ? "all" : "space"}
          options={[
            { value: "space", label: t("workspace.search.thisSpace") },
            { value: "all", label: t("workspace.search.allSpaces") },
          ]}
          onChange={(value) => search.setEverywhere(value === "all")}
        />
      ) : null}
    </>
  );

  return (
    <SearchView
      query={search.state.query}
      onSubmit={(query) => {
        setTab("messages");
        search.submit(query);
      }}
      tab={tab()}
      onTabChange={setTab}
      hits={hits()}
      total={search.state.total}
      loading={search.state.loading}
      error={search.state.error}
      onRetry={() => search.retry()}
      hasMore={Boolean(search.state.nextCursor)}
      loadingMore={search.state.loadingMore}
      onLoadMore={() => void search.loadMore()}
      unknown={search.state.unknown}
      invalid={search.state.invalid}
      noTerms={search.state.noTerms}
      filtered={filtered()}
      onClearFilters={() => refine(parsed().text)}
      filters={filters()}
      channels={channels()}
      people={people()}
      onOpenHit={(id) => {
        const hit = search.state.hits.find((item) => item.messageId === id);
        if (hit) openWorkspaceMessage(ws, hit.channelId, hit.messageId, hit.threadRootId);
      }}
      onOpenChannel={(id) => ws.openChannel(id)}
      onOpenPerson={(id) => {
        if (id.startsWith("person:")) ws.messageMember(id.slice("person:".length));
        else ws.openConversation(id);
      }}
      recent={search.state.recent}
      onRemoveRecent={(query) => search.removeRecent(query)}
      onClearRecent={() => search.clearRecent()}
      onBack={() => ws.back()}
    />
  );
}
