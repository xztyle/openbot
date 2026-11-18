import {
  channelKind,
  channelVisibility,
  SIGNED_OUT_CHANNEL_MEMBER_ID,
  type WorkspaceSearchHit,
} from "@openbot/contracts/ipc";
import {
  type DraftListItem,
  type DraftPlace,
  type DraftsTab,
  DraftsView,
  type SentListItem,
} from "@openbot/ui/features/workspace/DraftsView";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, createStore, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { useWorkspace } from "./workspace-context";
import { AGENT_DM_PREFIX, conversationName } from "./workspace-model";

const SENT_PAGE = 30;
/** How many pages one read takes at most to find sent messages of the space that shows. */
const SENT_PAGES_PER_READ = 5;

interface SentState {
  hits: WorkspaceSearchHit[];
  cursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  failed: boolean;
  /** The host has no message search: an older one. */
  unsupported: boolean;
  loaded: boolean;
}

/** Slack's Drafts & sent: the drafts of this device, and the reader's sent messages from the host. */
export function WorkspaceDraftsView() {
  const { t } = useText();
  const ws = useWorkspace();
  const [tab, setTab] = createSignal<DraftsTab>("drafts");
  const [sent, setSent] = createStore<SentState>({
    hits: [],
    cursor: null,
    loading: false,
    loadingMore: false,
    failed: false,
    unsupported: false,
    loaded: false,
  });

  const place = (channelId: string, inThread: boolean): DraftPlace => {
    if (channelId.startsWith(AGENT_DM_PREFIX)) {
      const agentId = channelId.slice(AGENT_DM_PREFIX.length);
      const agent = ws.env.agents().find((entry) => entry.id === agentId);
      return { name: agent?.name ?? t("workspace.drafts.unknown"), kind: "direct", inThread };
    }
    const channel = ws.summary(channelId);
    if (!channel) return { name: t("workspace.drafts.unknown"), kind: "direct", inThread };
    if (channelKind(channel) !== "channel")
      return { name: conversationName(ws.directory(), channel), kind: "direct", inThread };
    return {
      name: `#${channel.name}`,
      kind: channelVisibility(channel) === "private" ? "private-channel" : "channel",
      inThread,
    };
  };

  const drafts = createMemo((): DraftListItem[] =>
    ws.draftEntries().map((entry) => ({
      id: entry.key,
      place: place(entry.channelId, entry.threadRootId !== null),
      text: entry.text.replace(/\s+/gu, " ").trim(),
      at: entry.at,
      fileCount: entry.fileCount,
    })),
  );

  /**
   * The ids the reader's messages carry: their member id, and the ids that the host stamped on
   * their own messages before, as the last message of a conversation shows them.
   */
  const readerIds = () => {
    const ids = new Set<string>();
    const own = ws.env.reader().id;
    if (own) ids.add(own);
    if (ws.env.isReader(SIGNED_OUT_CHANNEL_MEMBER_ID)) ids.add(SIGNED_OUT_CHANNEL_MEMBER_ID);
    for (const channel of ws.channels.state.channels) {
      const author = channel.lastMessage?.author;
      if (author?.kind === "member" && ws.env.isReader(author.id)) ids.add(author.id);
    }
    return [...ids].slice(0, 50);
  };

  async function loadSent(more = false) {
    const search = ws.channels.port().agent.workspaceSearch;
    if (!search) {
      setSent((draft) => {
        draft.unsupported = true;
        draft.loaded = true;
      });
      return;
    }
    const authorIds = readerIds();
    if (!authorIds.length) {
      setSent((draft) => {
        draft.loaded = true;
      });
      return;
    }
    setSent((draft) => {
      if (more) draft.loadingMore = true;
      else draft.loading = true;
      draft.failed = false;
    });
    try {
      const spaceId = ws.spaces.available() ? ws.spaces.current() : undefined;
      // The space of the view only, also from a host that does not filter by space: a page of other
      // spaces' messages reads the next one, a few times at most.
      const hits: WorkspaceSearchHit[] = [];
      let cursor = more ? sent.cursor : null;
      for (let pages = 0; pages < SENT_PAGES_PER_READ; pages += 1) {
        const page = await search({
          query: "",
          authorIds,
          ...(spaceId ? { spaceId } : {}),
          sort: "recent",
          limit: SENT_PAGE,
          ...(cursor ? { cursor } : {}),
        });
        hits.push(
          ...page.hits.filter(
            (hit) => ws.env.isReader(hit.author.id) && (!spaceId || ws.rowSpace(hit.channelId) === spaceId),
          ),
        );
        cursor = page.nextCursor;
        if (hits.length || !cursor) break;
      }
      setSent((draft) => {
        draft.hits = more ? [...draft.hits, ...hits] : hits;
        draft.cursor = cursor;
        draft.loaded = true;
      });
    } catch {
      setSent((draft) => {
        draft.failed = true;
      });
    } finally {
      setSent((draft) => {
        draft.loading = false;
        draft.loadingMore = false;
      });
    }
  }

  // The Sent tab reads the host when it first shows, and again in another space.
  createEffect(
    () => ({ tab: tab(), space: ws.spaces.current() }),
    (current, previous) => {
      const moved = previous !== undefined && previous.space !== current.space;
      if (moved)
        setSent((draft) => {
          draft.hits = [];
          draft.cursor = null;
          draft.loaded = false;
        });
      if (current.tab === "sent" && (moved || !untrack(() => sent.loaded || sent.loading))) void loadSent();
    },
  );

  const sentItems = createMemo((): SentListItem[] =>
    sent.hits.map((hit) => ({
      id: `${hit.channelId}/${hit.messageId}`,
      place: place(hit.channelId, Boolean(hit.threadRootId)),
      text: hit.snippet,
      at: Date.parse(hit.at),
    })),
  );

  return (
    <DraftsView
      tab={tab()}
      onTabChange={setTab}
      drafts={drafts()}
      onOpenDraft={(id) => {
        const entry = ws.draftEntries().find((item) => item.key === id);
        if (!entry) return;
        if (entry.threadRootId) ws.openThread(entry.channelId, entry.threadRootId);
        else ws.openConversation(entry.channelId);
      }}
      onDeleteDraft={(id) => {
        const text = ws.draft(id);
        ws.discardDraft(id);
        // Undo brings the text back; files of the draft are gone from the host by then.
        actionToast.success(t("workspace.drafts.deleted"), {
          action: { label: t("common.undo"), onClick: () => ws.setDraft(id, text) },
        });
      }}
      sent={sentItems()}
      sentLoading={sent.loading}
      sentFailed={sent.failed}
      sentUnsupported={sent.unsupported}
      onRetrySent={() => void loadSent()}
      onOpenSent={(id) => {
        const hit = sent.hits.find((item) => `${item.channelId}/${item.messageId}` === id);
        if (!hit) return;
        // As Activity does: the exact message opens, scrolled to and marked; a reply in its thread.
        if (hit.threadRootId) ws.openThread(hit.channelId, hit.threadRootId);
        else ws.openChannel(hit.channelId);
        ws.focusMessage(hit.channelId, hit.messageId);
      }}
      onMoreSent={sent.cursor ? () => void loadSent(true) : undefined}
      sentLoadingMore={sent.loadingMore}
      onBack={() => ws.back()}
    />
  );
}
