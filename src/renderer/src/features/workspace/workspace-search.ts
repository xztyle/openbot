/*
 * The message search of the workspace, as Slack's: the query of the search field with its modifiers
 * (`in:`, `from:`, dates, `is:thread`), its pages of results from the host, and the recent searches.
 * The search view and the top bar field read the same state.
 */

import {
  type ChannelSummary,
  channelKind,
  type WorkspaceSearchHit,
  type WorkspaceSearchInput,
  type WorkspaceSearchSort,
} from "@openbot/contracts/ipc";
import {
  type ParsedSearch,
  parseSearchQuery,
  searchDateRange,
  searchHasTerms,
} from "@openbot/ui/features/workspace/workspace-search-query";
import { currentText } from "@openbot/ui/text";
import { createEffect, createStore } from "solid-js";
import type { ChannelsController } from "../channels/channels-controller";
import { otherMembers, readerJoined, type WorkspaceDirectory } from "./workspace-model";

const RECENT_KEY = "openbot.workspace.searches.v1";
const RECENT_LIMIT = 10;
const PAGE_SIZE = 20;

function readRecent(key: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(`${RECENT_KEY}:${key}`) ?? "[]");
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .slice(0, RECENT_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function writeRecent(key: string, recent: readonly string[]): void {
  try {
    window.localStorage.setItem(`${RECENT_KEY}:${key}`, JSON.stringify(recent));
  } catch {
    // A private window or a full disk keeps no recent searches.
  }
}

interface SearchState {
  /** The query that the results are for. Empty: no search ran. */
  query: string;
  sort: WorkspaceSearchSort;
  /** Every space, not only the one that shows. */
  everywhere: boolean;
  hits: WorkspaceSearchHit[];
  total: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  /** Why the last read failed, in the reader's language. */
  error: string | null;
  /** Names of `in:` and `from:` that match no conversation or person. */
  unknown: string[];
  /** Date values that are not dates. */
  invalid: string[];
  /** The query has no words: the host needs at least one. */
  noTerms: boolean;
  recent: string[];
}

export interface WorkspaceSearchDeps {
  channels: ChannelsController;
  directory: () => WorkspaceDirectory;
  storageKey: () => string;
  connectionReady: () => boolean;
  /** The space that shows, or null on a host without spaces. */
  currentSpace: () => string | null;
}

function folded(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

/** Whether `name` matches a typed name: the same, or the start of it or of one of its words. */
function nameMatches(name: string, typed: string): boolean {
  const full = folded(name);
  const value = folded(typed);
  return full === value || full.startsWith(value) || full.split(/[\s\-_.]+/u).some((word) => word.startsWith(value));
}

export function createWorkspaceSearch(deps: WorkspaceSearchDeps) {
  const [state, setState] = createStore<SearchState>({
    query: "",
    sort: "relevance",
    everywhere: false,
    hits: [],
    total: 0,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    unknown: [],
    invalid: [],
    noTerms: false,
    recent: [],
  });
  createEffect(deps.storageKey, (key) =>
    setState((draft) => {
      draft.recent = readRecent(key);
    }),
  );

  const supported = () => Boolean(deps.channels.port().agent.workspaceSearch);

  /** The people and agents a `from:` name means. */
  function authorIds(names: readonly string[]): { ids: string[]; unknown: string[] } {
    const directory = deps.directory();
    const ids: string[] = [];
    const unknown: string[] = [];
    for (const name of names) {
      if (name.toLocaleLowerCase() === "me" && directory.reader.id) {
        ids.push(directory.reader.id);
        continue;
      }
      const found = [
        ...directory.people.filter((person) => nameMatches(person.name, name)).map((person) => person.id),
        ...directory.agents.filter((agent) => nameMatches(agent.name, name)).map((agent) => agent.id),
      ];
      if (found.length) ids.push(...found);
      else unknown.push(`@${name}`);
    }
    return { ids: [...new Set(ids)].slice(0, 50), unknown };
  }

  /** The conversations an `in:` name means: `#name` a channel, `@name` the DMs and groups with that member. */
  function channelIds(names: readonly string[]): { ids: string[]; unknown: string[] } {
    const directory = deps.directory();
    const summaries = deps.channels.state.channels;
    const ids: string[] = [];
    const unknown: string[] = [];
    const named = (name: string) =>
      summaries.filter(
        (channel) => channelKind(channel) === "channel" && folded(channel.name) === folded(name.replace(/^#/u, "")),
      );
    const withMember = (name: string): ChannelSummary[] =>
      summaries.filter(
        (channel) =>
          channelKind(channel) !== "channel" &&
          readerJoined(directory, channel) &&
          otherMembers(directory, channel).some((member) => nameMatches(member.name, name.replace(/^@/u, ""))),
      );
    for (const name of names) {
      const found = name.startsWith("@") ? withMember(name) : named(name);
      const fallback = found.length || name.startsWith("#") || name.startsWith("@") ? found : withMember(name);
      if (fallback.length) ids.push(...fallback.map((channel) => channel.id));
      else unknown.push(name.startsWith("#") || name.startsWith("@") ? name : `#${name}`);
    }
    return { ids: [...new Set(ids)].slice(0, 100), unknown };
  }

  /** The host's input for a parsed query, or the names and dates it could not read. */
  function input(
    parsed: ParsedSearch,
    cursor?: string,
  ): { input: WorkspaceSearchInput | null; unknown: string[]; invalid: string[] } {
    const authors = authorIds(parsed.from);
    const conversations = channelIds(parsed.in);
    const dates = searchDateRange(parsed);
    const unknown = [...conversations.unknown, ...authors.unknown];
    if (unknown.length || dates.invalid.length) return { input: null, unknown, invalid: dates.invalid };
    const space = deps.currentSpace();
    return {
      input: {
        query: parsed.text,
        ...(parsed.in.length ? { channelIds: conversations.ids } : {}),
        ...(parsed.from.length ? { authorIds: authors.ids } : {}),
        ...(dates.after ? { after: dates.after } : {}),
        ...(dates.before ? { before: dates.before } : {}),
        ...(parsed.threads ? { threadsOnly: true } : {}),
        // An `in:` names its conversations wherever they are.
        ...(space && !state.everywhere && !parsed.in.length ? { spaceId: space } : {}),
        sort: state.sort,
        limit: PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      },
      unknown,
      invalid: [],
    };
  }

  /** The top bar's field, while one shows. */
  let bar: { focus: (text?: string) => void; visible: () => boolean } | null = null;

  let run = 0;
  async function load(query: string) {
    const search = deps.channels.port().agent.workspaceSearch;
    const parsed = parseSearchQuery(query);
    const current = ++run;
    const request = input(parsed);
    // The host lists an author's messages without words; anything else needs a word.
    const noTerms = !searchHasTerms(parsed) && parsed.from.length === 0;
    setState((draft) => {
      draft.query = query;
      draft.hits = [];
      draft.total = 0;
      draft.nextCursor = null;
      draft.error = null;
      draft.unknown = request.unknown;
      draft.invalid = request.invalid;
      draft.noTerms = noTerms;
      draft.loading = Boolean(search && request.input && !noTerms);
    });
    if (!search || !request.input || noTerms) return;
    try {
      const page = await search(request.input);
      if (current !== run) return;
      setState((draft) => {
        draft.hits = page.hits;
        draft.total = page.total;
        draft.nextCursor = page.nextCursor;
        draft.loading = false;
      });
    } catch (error) {
      if (current !== run) return;
      const text = currentText();
      setState((draft) => {
        draft.loading = false;
        draft.error = text.errorMessage(error, text.t("workspace.search.failed"));
      });
    }
  }

  /** Runs a search and keeps it in the recent searches. */
  function submit(query: string) {
    const text = query.trim().replace(/\s+/gu, " ");
    if (!text) return;
    setState((draft) => {
      draft.recent = [text, ...draft.recent.filter((item) => item !== text)].slice(0, RECENT_LIMIT);
    });
    writeRecent(deps.storageKey(), state.recent);
    void load(text);
  }

  async function loadMore() {
    const search = deps.channels.port().agent.workspaceSearch;
    const cursor = state.nextCursor;
    if (!search || !cursor || state.loadingMore) return;
    const request = input(parseSearchQuery(state.query), cursor);
    if (!request.input) return;
    const current = run;
    setState((draft) => {
      draft.loadingMore = true;
    });
    try {
      const page = await search(request.input);
      if (current !== run) return;
      setState((draft) => {
        const known = new Set(draft.hits.map((hit) => hit.messageId));
        draft.hits.push(...page.hits.filter((hit) => !known.has(hit.messageId)));
        draft.nextCursor = page.nextCursor;
        draft.total = page.total;
        draft.loadingMore = false;
      });
    } catch (error) {
      if (current !== run) return;
      const text = currentText();
      setState((draft) => {
        draft.loadingMore = false;
        draft.error = text.errorMessage(error, text.t("workspace.search.failed"));
      });
    }
  }

  return {
    state,
    supported,
    submit,
    /**
     * The top bar's field registers here while it shows; it gets the focus of ⌘G and /. The answer
     * takes it out again, unless another field registered since.
     */
    attachBar(next: { focus: (text?: string) => void; visible: () => boolean }): () => void {
      bar = next;
      return () => {
        if (bar === next) bar = null;
      };
    },
    /** Puts the focus in the top bar's field. False when no field shows, such as on a phone. */
    focusBar(text?: string): boolean {
      if (!bar?.visible()) return false;
      bar.focus(text);
      return true;
    },
    loadMore,
    retry: () => void load(state.query),
    setSort(sort: WorkspaceSearchSort) {
      setState((draft) => {
        draft.sort = sort;
      });
      if (state.query) void load(state.query);
    },
    setEverywhere(everywhere: boolean) {
      setState((draft) => {
        draft.everywhere = everywhere;
      });
      if (state.query) void load(state.query);
    },
    removeRecent(query: string) {
      setState((draft) => {
        draft.recent = draft.recent.filter((item) => item !== query);
      });
      writeRecent(deps.storageKey(), state.recent);
    },
    clearRecent() {
      setState((draft) => {
        draft.recent = [];
      });
      writeRecent(deps.storageKey(), []);
    },
    /** Forgets the results, as when the reader leaves the server. */
    reset() {
      run += 1;
      setState((draft) => {
        draft.query = "";
        draft.hits = [];
        draft.total = 0;
        draft.nextCursor = null;
        draft.loading = false;
        draft.error = null;
      });
    },
  };
}

export type WorkspaceSearch = ReturnType<typeof createWorkspaceSearch>;
