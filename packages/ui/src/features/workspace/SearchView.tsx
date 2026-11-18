import type { JSX } from "@solidjs/web";
import { createMemo, For, Match, onSettled, Show, Switch } from "solid-js";
import { Button, IconButton } from "../../button";
import { Input } from "../../form";
import { Hash, History, Lock, MessageSquareText, Search, UserRound, X } from "../../icons";
import { SlidingTabs } from "../../sliding-tabs";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { AiBadge, MemberAvatar, MemberName } from "./WorkspaceAvatar";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime } from "./workspace-format";
import type { ChannelVisibility, WorkspaceMember } from "./workspace-types";

export type SearchTab = "messages" | "channels" | "people";

export interface SearchHitItem {
  /** The message id. */
  id: string;
  author: WorkspaceMember;
  /** `#general`, or the names of a DM. */
  where: string;
  inThread: boolean;
  /** The space of a result in another space. */
  space?: string | undefined;
  at: number;
  snippet: string;
  highlights: readonly { start: number; length: number }[];
}

export interface SearchChannelItem {
  id: string;
  name: string;
  visibility: ChannelVisibility;
  topic?: string | undefined;
  memberCount: number;
  joined: boolean;
  archived?: boolean | undefined;
}

export interface SearchPersonItem {
  id: string;
  member: WorkspaceMember;
  /** A role or a title. */
  detail?: string | undefined;
}

export interface SearchViewProps {
  /** The query the results are for. */
  query: string;
  /** The field of the view, which a phone shows; a computer types in the top bar. */
  onSubmit: (query: string) => void;
  tab: SearchTab;
  onTabChange: (tab: SearchTab) => void;
  hits: readonly SearchHitItem[];
  total: number;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  hasMore?: boolean | undefined;
  loadingMore?: boolean | undefined;
  onLoadMore?: (() => void) | undefined;
  /** `in:` and `from:` names that match nothing, and dates that are not dates. */
  unknown?: readonly string[] | undefined;
  invalid?: readonly string[] | undefined;
  /** The query has no words to look for. */
  noTerms?: boolean | undefined;
  /** The filters are narrower than the default: an empty result offers to clear them. */
  filtered?: boolean | undefined;
  onClearFilters?: (() => void) | undefined;
  /** The filter controls of the Messages tab. */
  filters?: JSX.Element;
  channels: readonly SearchChannelItem[];
  people: readonly SearchPersonItem[];
  onOpenHit: (id: string) => void;
  onOpenChannel: (id: string) => void;
  onOpenPerson: (id: string) => void;
  recent: readonly string[];
  onRemoveRecent?: ((query: string) => void) | undefined;
  onClearRecent?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The snippet in runs, with the parts that match the query marked. */
function snippetRuns(snippet: string, highlights: readonly { start: number; length: number }[]) {
  const runs: { text: string; match: boolean }[] = [];
  let at = 0;
  for (const range of [...highlights].sort((left, right) => left.start - right.start)) {
    if (range.start < at || range.start >= snippet.length) continue;
    if (range.start > at) runs.push({ text: snippet.slice(at, range.start), match: false });
    runs.push({ text: snippet.slice(range.start, range.start + range.length), match: true });
    at = range.start + range.length;
  }
  if (at < snippet.length) runs.push({ text: snippet.slice(at), match: false });
  return runs;
}

export function SearchSnippet(props: { snippet: string; highlights: readonly { start: number; length: number }[] }) {
  return (
    <For each={snippetRuns(props.snippet, props.highlights)}>
      {(run) => (
        <Show when={run.match} fallback={run.text}>
          <mark class="ws-search-mark">{run.text}</mark>
        </Show>
      )}
    </For>
  );
}

/**
 * Slack's search results: Messages with their filters, Channels and People, for the query of the
 * search field. With no query it shows the recent searches. A result opens the exact message.
 */
export function SearchView(props: SearchViewProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  let field: HTMLInputElement | undefined;
  // A phone opens the search without words: the field takes the focus, so the keyboard can rise, as in
  // Slack's app. The field shows only on a phone (the top bar has the computer's).
  onSettled(() => {
    if (!props.query && field && field.getClientRects().length > 0) field.focus();
  });
  const hasQuery = () => props.query.trim().length > 0;
  const missing = createMemo(() => [...(props.unknown ?? []), ...(props.invalid ?? [])]);
  return (
    <section class={cx("ws-view ws-search", props.class)} aria-label={t("workspace.view.search")}>
      <WorkspacePaneHeader
        icon={<Search aria-hidden="true" />}
        title={t("workspace.view.search")}
        subtitle={hasQuery() ? t("workspace.search.resultsFor", { query: props.query }) : undefined}
        onBack={props.onBack}
      />
      {/* A phone has no top bar: the view has its own field. */}
      <form
        class="ws-search-view-field ws-phone-only"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit(field?.value ?? "");
        }}
      >
        <Search aria-hidden="true" />
        <Input
          ref={(element: HTMLInputElement) => (field = element)}
          type="search"
          enterkeyhint="search"
          value={props.query}
          placeholder={t("workspace.search.placeholder")}
          aria-label={t("workspace.search.placeholder")}
        />
      </form>
      <Show
        when={hasQuery()}
        fallback={
          <div class="ws-view-scroll">
            <Show
              when={props.recent.length > 0}
              fallback={
                <EmptyState
                  icon={<Search />}
                  title={t("workspace.search.startTitle")}
                  description={t("workspace.search.startHint")}
                />
              }
            >
              <div class="ws-search-recent-header">
                <h3>{t("workspace.search.recent")}</h3>
                <Show when={props.onClearRecent}>
                  {(clear) => (
                    <Button variant="ghost" size="xs" onClick={() => clear()()}>
                      {t("workspace.search.clearRecent")}
                    </Button>
                  )}
                </Show>
              </div>
              <WorkspaceList class="ws-search-recent" label={t("workspace.search.recent")}>
                <For each={props.recent}>
                  {(query) => (
                    <WorkspaceListRow
                      leading={<History aria-hidden="true" />}
                      title={query}
                      onOpen={props.onRemoveRecent ? undefined : () => props.onSubmit(query)}
                      actions={
                        <Show when={props.onRemoveRecent}>
                          {(remove) => (
                            <>
                              <IconButton
                                variant="ghost"
                                label={t("workspace.search.searchFor", { query })}
                                onClick={() => props.onSubmit(query)}
                              >
                                <Search />
                              </IconButton>
                              <IconButton
                                variant="ghost"
                                label={t("workspace.search.removeRecent", { query })}
                                onClick={() => remove()(query)}
                              >
                                <X />
                              </IconButton>
                            </>
                          )}
                        </Show>
                      }
                    />
                  )}
                </For>
              </WorkspaceList>
            </Show>
            <p class="ws-search-tips">{t("workspace.search.tips")}</p>
          </div>
        }
      >
        <div class="ws-view-toolbar ws-search-tabs">
          <SlidingTabs.Root
            value={props.tab}
            onChange={(value) => {
              if (value === "messages" || value === "channels" || value === "people") props.onTabChange(value);
            }}
          >
            <SlidingTabs.List aria-label={t("workspace.search.tabs")}>
              <SlidingTabs.Trigger value="messages">
                {t("workspace.search.messages", { count: props.total })}
              </SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="channels">
                {t("workspace.search.channels", { count: props.channels.length })}
              </SlidingTabs.Trigger>
              <SlidingTabs.Trigger value="people">
                {t("workspace.search.people", { count: props.people.length })}
              </SlidingTabs.Trigger>
            </SlidingTabs.List>
          </SlidingTabs.Root>
        </div>
        <Show when={props.tab === "messages" && props.filters}>
          <div class="ws-view-toolbar ws-search-filters">{props.filters}</div>
        </Show>
        <div class="ws-view-scroll">
          <Switch>
            <Match when={props.tab === "channels"}>
              <Show
                when={props.channels.length > 0}
                fallback={<EmptyState size="compact" icon={<Hash />} title={t("workspace.search.noChannels")} />}
              >
                <WorkspaceList>
                  <For each={props.channels} keyed={(channel) => channel.id}>
                    {(channel) => (
                      <WorkspaceListRow
                        onOpen={() => props.onOpenChannel(channel().id)}
                        leading={
                          <span class="ws-search-glyph" aria-hidden="true">
                            <Show when={channel().visibility === "private"} fallback={<Hash />}>
                              <Lock />
                            </Show>
                          </span>
                        }
                        title={
                          <>
                            {channel().name}
                            <Show when={channel().joined}>
                              <span class="ws-search-tag">{t("workspace.browse.joined")}</span>
                            </Show>
                            <Show when={channel().archived}>
                              <span class="ws-search-tag">{t("workspace.browse.archived")}</span>
                            </Show>
                          </>
                        }
                      >
                        <span class="ws-feed-where">
                          {t("workspace.app.browse.members", { count: channel().memberCount })}
                          <Show when={channel().topic}>{(topic) => ` · ${topic()}`}</Show>
                        </span>
                      </WorkspaceListRow>
                    )}
                  </For>
                </WorkspaceList>
              </Show>
            </Match>
            <Match when={props.tab === "people"}>
              <Show
                when={props.people.length > 0}
                fallback={<EmptyState size="compact" icon={<UserRound />} title={t("workspace.search.noPeople")} />}
              >
                <WorkspaceList>
                  <For each={props.people} keyed={(person) => person.id}>
                    {(person) => (
                      <WorkspaceListRow
                        onOpen={() => props.onOpenPerson(person().id)}
                        leading={<MemberAvatar member={person().member} size="lg" />}
                        title={
                          <>
                            {person().member.name}
                            <Show when={person().member.kind === "agent"}>
                              <AiBadge />
                            </Show>
                          </>
                        }
                      >
                        <Show when={person().detail}>{(detail) => <span class="ws-feed-where">{detail()}</span>}</Show>
                      </WorkspaceListRow>
                    )}
                  </For>
                </WorkspaceList>
              </Show>
            </Match>
            <Match when={missing().length > 0}>
              <EmptyState
                size="compact"
                icon={<Search />}
                title={t("workspace.search.unknownTitle")}
                description={t("workspace.search.unknown", { names: missing().join(", ") })}
              />
            </Match>
            <Match when={props.noTerms}>
              <EmptyState
                size="compact"
                icon={<Search />}
                title={t("workspace.search.noTermsTitle")}
                description={t("workspace.search.noTerms")}
              />
            </Match>
            <Match when={props.error && props.hits.length === 0}>
              <ErrorState title={t("workspace.search.failed")} description={props.error} onRetry={props.onRetry} />
            </Match>
            <Match when={props.loading && props.hits.length === 0}>
              <LoadingState label={t("workspace.view.search")} />
            </Match>
            <Match when={props.hits.length === 0}>
              <EmptyState
                size="compact"
                icon={<MessageSquareText />}
                title={t("workspace.search.noResultsTitle")}
                description={t("workspace.search.noResults", { query: props.query })}
                action={
                  <Show when={props.filtered && props.onClearFilters}>
                    <Button variant="secondary" size="sm" onClick={() => props.onClearFilters?.()}>
                      {t("workspace.view.clearFilters")}
                    </Button>
                  </Show>
                }
              />
            </Match>
            <Match when={true}>
              <WorkspaceList class="ws-search-results">
                <For each={props.hits} keyed={(hit) => hit.id}>
                  {(hit) => (
                    <WorkspaceListRow
                      class="ws-search-hit"
                      onOpen={() => props.onOpenHit(hit().id)}
                      leading={<MemberAvatar member={hit().author} size="lg" />}
                      title={<MemberName member={hit().author} />}
                      titleEnd={recent(hit().at)}
                    >
                      <span class="ws-feed-where">
                        {hit().inThread ? t("workspace.search.inThread", { where: hit().where }) : hit().where}
                        <Show when={hit().space}>{(space) => ` · ${space()}`}</Show>
                      </span>
                      <span class="ws-search-snippet">
                        <SearchSnippet snippet={hit().snippet} highlights={hit().highlights} />
                      </span>
                    </WorkspaceListRow>
                  )}
                </For>
              </WorkspaceList>
              <Show when={props.hasMore}>
                <div class="ws-view-more">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={props.loadingMore}
                    onClick={() => props.onLoadMore?.()}
                  >
                    {t("workspace.view.showMore")}
                  </Button>
                </div>
              </Show>
            </Match>
          </Switch>
        </div>
      </Show>
    </section>
  );
}
