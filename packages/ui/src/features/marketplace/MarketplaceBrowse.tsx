import { SKILL_CATEGORIES, type SkillCategory } from "@openbot/contracts/ipc";
import { Button, Input, Search, Skeleton, SlidingTabs, Text } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, For, Show } from "solid-js";
import { AgentGrid, AppCard, AppsReadNotice, SkillGrid } from "./MarketplaceCards";
import { EventCheckGrid, EventCheckPanel, matchesTemplate } from "./MarketplaceEventChecks";
import { type FilterGroup, MarketplaceFilter } from "./MarketplaceFilter";
import { outdatedAgentIds, SkillUpdates, skillAgents } from "./MarketplaceInstallSkill";
import { Block } from "./MarketplaceParts";
import { CATEGORY_LABELS, type MarketplaceListing } from "./marketplace-listing";
import type { MarketplaceApp } from "./marketplace-model";
import {
  appGroups,
  isMarketplaceTab,
  type MarketplaceScope,
  type MarketplaceTab,
  matchesApp,
  type OwnedFilter,
  type SkillStatusFilter,
} from "./marketplace-view";

const TABS: readonly MarketplaceTab[] = ["agents", "apps", "skills", "eventChecks"];

const TAB_LABEL = {
  agents: "marketplace.tab.agents",
  apps: "marketplace.tab.apps",
  skills: "marketplace.tab.skills",
  eventChecks: "marketplace.tab.eventChecks",
} as const;

const NO_MATCH = {
  agents: "marketplace.noMatch.agents",
  apps: "marketplace.noMatch.apps",
  skills: "marketplace.noMatch.skills",
  eventChecks: "marketplace.noMatch.eventChecks",
} as const;

const EMPTY = {
  agents: "marketplace.empty.agents",
  apps: "marketplace.empty.apps",
  skills: "marketplace.empty.skills",
  eventChecks: "marketplace.empty.eventChecks",
} as const;

const SHOW_TAB = {
  agents: "marketplace.noMatch.showAgents",
  apps: "marketplace.noMatch.showApps",
  skills: "marketplace.noMatch.showSkills",
  eventChecks: "marketplace.noMatch.showEventChecks",
} as const;

function ownedOf(value: string | null): OwnedFilter | null {
  return value === "yes" || value === "no" ? value : null;
}

function skillStatusOf(value: string | null): SkillStatusFilter | null {
  return value === "update" ? value : ownedOf(value);
}

function categoryOf(value: string | null): SkillCategory | null {
  return SKILL_CATEGORIES.find((category) => category === value) ?? null;
}

function owns(owned: OwnedFilter | null, have: boolean) {
  return owned === null || (owned === "yes") === have;
}

/** A tab with nothing to show: the filters hide it, the search finds nothing, or the catalog is empty. */
function NoMatch(props: {
  scope: MarketplaceScope;
  tab: MarketplaceTab;
  counts: Record<MarketplaceTab, number>;
  filtered: boolean;
  onClearFilters: () => void;
}) {
  const { t } = useText();
  const nav = () => props.scope.nav;
  const searching = () => nav().state.query.trim() !== "";
  const others = () => TABS.filter((tab) => tab !== props.tab && props.counts[tab] > 0);
  return (
    <div class="marketplace-empty">
      <Text as="p" variant="body-sm" tone="muted">
        {props.filtered ? t("marketplace.noMatch.filters") : searching() ? t(NO_MATCH[props.tab]) : t(EMPTY[props.tab])}
      </Text>
      <Show when={props.filtered || (searching() && others().length > 0)}>
        <div class="marketplace-empty-actions">
          <Show
            when={props.filtered}
            fallback={
              <For each={others()}>
                {(tab) => (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-cuelume-tap="select"
                    onClick={() =>
                      nav().set((draft) => {
                        draft.tab = tab;
                      })
                    }
                  >
                    {t(SHOW_TAB[tab], { count: props.counts[tab] })}
                  </Button>
                )}
              </For>
            }
          >
            <Button type="button" variant="outline" size="sm" onClick={props.onClearFilters}>
              {t("marketplace.filter.clear")}
            </Button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** A listing's first load, its failure, its rows, and "Load more" while the server has more. */
function ListingPanel(props: {
  listing: MarketplaceListing<unknown>;
  loadingLabel: string;
  count: number;
  empty: JSX.Element;
  children: JSX.Element;
}) {
  const { t } = useText();
  const failure = () => (
    <div class="marketplace-empty" role="alert">
      <Text as="p" variant="body-sm" tone="muted">
        {props.listing.error()}
      </Text>
      <Button type="button" variant="outline" size="sm" onClick={props.listing.retry}>
        {t("common.retry")}
      </Button>
    </div>
  );
  return (
    <Show
      when={!props.listing.loading()}
      fallback={
        <div class="marketplace-grid" role="status" aria-label={props.loadingLabel}>
          <For each={Array.from({ length: 6 }, (_, index) => index)}>
            {() => (
              <div class="marketplace-card marketplace-card-skeleton" aria-hidden="true">
                <Skeleton class="marketplace-skeleton-mark" />
                <Skeleton class="marketplace-skeleton-line" />
                <Skeleton class="marketplace-skeleton-line" />
              </div>
            )}
          </For>
        </div>
      }
    >
      {/* A failed "Load more" keeps the rows that loaded. */}
      <Show when={!props.listing.error() || props.count > 0} fallback={failure()}>
        <div class="marketplace-stack">
          <Show when={props.count > 0 || props.listing.pending()} fallback={props.empty}>
            {props.children}
          </Show>
          <Show when={!props.listing.error()} fallback={failure()}>
            {/* A filter can hide each loaded row while a later page still holds a match. */}
            <Show when={props.listing.hasMore()}>
              <Button
                type="button"
                variant="outline"
                class="marketplace-load-more"
                data-cuelume-tap="navigate"
                loading={props.listing.loadingMore()}
                onClick={props.listing.loadMore}
              >
                {t("marketplace.loadMore")}
              </Button>
            </Show>
          </Show>
        </div>
      </Show>
    </Show>
  );
}

export function MarketplaceBrowse(props: { scope: MarketplaceScope }) {
  const { t, format } = useText();
  const model = () => props.scope.model;
  const nav = () => props.scope.nav;
  const state = () => props.scope.nav.state;
  const searching = () => state().query.trim() !== "";

  const agents = () =>
    props.scope.agents
      .items()
      .filter((listing) => owns(state().agentsOwned, (model().agentState(listing) ?? "add") !== "add"));
  const skills = () =>
    props.scope.skills.items().filter((skill) => {
      const status = state().skillsOwned;
      if (status === "update") return outdatedAgentIds(props.scope, skill).length > 0;
      return owns(status, skillAgents(props.scope, skill).length > 0);
    });
  /** The category in the reader's language, which the search reads beside the name and the description. */
  const appCategoryLabel = (app: MarketplaceApp) =>
    t(app.kind === "custom" ? "marketplace.app.custom" : CATEGORY_LABELS[app.category]);
  const apps = () =>
    model()
      .apps()
      .filter((app) => matchesApp(app, state().query, appCategoryLabel(app)))
      .filter((app) => state().appCategory === null || (app.kind !== "custom" && app.category === state().appCategory));
  const eventChecks = () =>
    model().eventChecks
      ? props.scope.eventChecks
          .templates()
          .filter((template) => matchesTemplate(template, state().query))
          .filter((template) =>
            owns(state().eventChecksOwned, props.scope.eventChecks.instances(template.slug).length > 0),
          )
      : [];
  /** The Event checks tab exists only on a host that has the templates. */
  const tabs = () => (model().eventChecks ? TABS : TABS.filter((tab) => tab !== "eventChecks"));
  const activeTab = (): MarketplaceTab => (tabs().includes(state().tab) ? state().tab : "agents");
  const counts = (): Record<MarketplaceTab, number> => ({
    agents: agents().length,
    apps: apps().length,
    skills: skills().length,
    eventChecks: eventChecks().length,
  });
  /** A listing that pages shows "50+" while the server holds more rows than the loaded ones. */
  const countLabel = (tab: MarketplaceTab) => {
    const more =
      (tab === "agents" && props.scope.agents.hasMore()) || (tab === "skills" && props.scope.skills.hasMore());
    return `${format.number(counts()[tab])}${more ? "+" : ""}`;
  };

  /* The Installed filter and the install buttons need each agent's skills. */
  createEffect(
    () => state().tab,
    (tab) => {
      if (tab === "skills") model().readSkills();
    },
  );
  /* The templates load with the window, so the count of a search is right. The Installed filter needs each agent's checks. */
  createEffect(
    () => model().eventChecks,
    (source) => {
      if (source) props.scope.eventChecks.load();
    },
  );
  createEffect(
    () => activeTab(),
    (current) => {
      if (current === "eventChecks") props.scope.eventChecks.readChecks();
    },
  );

  const categoryOptions = () =>
    SKILL_CATEGORIES.map((category) => ({ value: category, label: t(CATEGORY_LABELS[category]) }));
  const agentGroups = (): FilterGroup[] => [
    /* A chosen status stays in the menu, so that the user can clear it. */
    ...(state().agentsOwned !== null || props.scope.agents.items().some((item) => model().agentState(item) !== null)
      ? [
          {
            legend: t("marketplace.filter.status"),
            options: [
              { value: "yes", label: t("marketplace.filter.added") },
              { value: "no", label: t("marketplace.filter.notAdded") },
            ],
            value: state().agentsOwned,
            set: (value: string | null) =>
              nav().set((draft) => {
                draft.agentsOwned = ownedOf(value);
              }),
          },
        ]
      : []),
    {
      legend: t("marketplace.filter.category"),
      options: categoryOptions(),
      value: state().agentCategory,
      set: (value) =>
        nav().set((draft) => {
          draft.agentCategory = categoryOf(value);
        }),
    },
  ];
  const skillGroups = (): FilterGroup[] => [
    ...(model().agents().length > 0
      ? [
          {
            legend: t("marketplace.filter.status"),
            options: [
              { value: "yes", label: t("marketplace.filter.installed") },
              { value: "no", label: t("marketplace.filter.notInstalled") },
              { value: "update", label: t("marketplace.filter.updates") },
            ],
            value: state().skillsOwned,
            set: (value: string | null) =>
              nav().set((draft) => {
                draft.skillsOwned = skillStatusOf(value);
              }),
          },
        ]
      : []),
    {
      legend: t("marketplace.filter.category"),
      options: categoryOptions(),
      value: state().skillCategory,
      set: (value) =>
        nav().set((draft) => {
          draft.skillCategory = categoryOf(value);
        }),
    },
  ];
  /** Only the categories that an app has, so no choice leads to an empty list. */
  const appCategoryOptions = () => {
    const present = new Set(
      model()
        .apps()
        .flatMap((app) => (app.kind === "custom" ? [] : [app.category])),
    );
    return categoryOptions().filter((option) => present.has(option.value) || option.value === state().appCategory);
  };
  const appFilterGroups = (): FilterGroup[] => [
    {
      legend: t("marketplace.filter.category"),
      options: appCategoryOptions(),
      value: state().appCategory,
      set: (value) =>
        nav().set((draft) => {
          draft.appCategory = categoryOf(value);
        }),
    },
  ];
  const eventCheckGroups = (): FilterGroup[] =>
    model().agents().length > 0
      ? [
          {
            legend: t("marketplace.filter.status"),
            options: [
              { value: "yes", label: t("marketplace.filter.installed") },
              { value: "no", label: t("marketplace.filter.notInstalled") },
            ],
            value: state().eventChecksOwned,
            set: (value) =>
              nav().set((draft) => {
                draft.eventChecksOwned = ownedOf(value);
              }),
          },
        ]
      : [];
  const eventChecksFiltered = () => state().eventChecksOwned !== null;
  const appsFiltered = () => state().appCategory !== null;
  const agentsFiltered = () => state().agentCategory !== null || state().agentsOwned !== null;
  const skillsFiltered = () => state().skillCategory !== null || state().skillsOwned !== null;
  const clearFilters = (tab: MarketplaceTab) =>
    nav().set((draft) => {
      if (tab === "eventChecks") {
        draft.eventChecksOwned = null;
      } else if (tab === "apps") {
        draft.appCategory = null;
      } else if (tab === "agents") {
        draft.agentCategory = null;
        draft.agentsOwned = null;
      } else {
        draft.skillCategory = null;
        draft.skillsOwned = null;
      }
    });

  return (
    <div class="marketplace-view">
      <SlidingTabs.Root
        value={activeTab()}
        onChange={(value: string) =>
          nav().set((draft) => {
            draft.tab = isMarketplaceTab(value) ? value : "agents";
          })
        }
      >
        <div class="marketplace-toolbar">
          <SlidingTabs.List aria-label={t("marketplace.kinds")}>
            <For each={tabs()}>
              {(tab) => (
                <SlidingTabs.Trigger value={tab}>
                  {t(TAB_LABEL[tab])}
                  <Show when={searching()}>
                    <span class="marketplace-count">{countLabel(tab)}</span>
                  </Show>
                </SlidingTabs.Trigger>
              )}
            </For>
          </SlidingTabs.List>
          <label class="search-field marketplace-search">
            <Search aria-hidden="true" />
            <Input
              type="search"
              aria-label={t("marketplace.search.label")}
              placeholder={t("marketplace.search.placeholder")}
              value={state().query}
              onInput={(event) => {
                const value = event.currentTarget.value;
                nav().set((draft) => {
                  draft.query = value;
                });
              }}
            />
          </label>
          <Show when={state().tab === "agents"}>
            <MarketplaceFilter groups={agentGroups()} />
          </Show>
          <Show when={state().tab === "apps"}>
            <MarketplaceFilter groups={appFilterGroups()} />
          </Show>
          <Show when={state().tab === "skills"}>
            <MarketplaceFilter groups={skillGroups()} />
          </Show>
          <Show when={activeTab() === "eventChecks" && eventCheckGroups().length > 0}>
            <MarketplaceFilter groups={eventCheckGroups()} />
          </Show>
        </div>
        <SlidingTabs.ContentSlot class="marketplace-tab-slot">
          <SlidingTabs.Content value="agents">
            <ListingPanel
              listing={props.scope.agents}
              loadingLabel={t("marketplace.loading.agents")}
              count={agents().length}
              empty={
                <NoMatch
                  scope={props.scope}
                  tab="agents"
                  counts={counts()}
                  filtered={agentsFiltered()}
                  onClearFilters={() => clearFilters("agents")}
                />
              }
            >
              <AgentGrid scope={props.scope} items={agents()} />
            </ListingPanel>
          </SlidingTabs.Content>
          <SlidingTabs.Content value="apps">
            <div class="marketplace-stack">
              <AppsReadNotice scope={props.scope} />
              <Show when={state().missingApp}>
                <div class="marketplace-empty" role="alert">
                  <Text as="p" variant="body-sm" tone="muted">
                    {t("marketplace.plugins.missing")}
                  </Text>
                </div>
              </Show>
              <Show
                when={apps().length > 0}
                fallback={
                  <NoMatch
                    scope={props.scope}
                    tab="apps"
                    counts={counts()}
                    filtered={appsFiltered()}
                    onClearFilters={() => clearFilters("apps")}
                  />
                }
              >
                {/* Each read of the host makes new app objects, so the cards are kept by id: the
                    element under the pointer or the focus stays. */}
                <For each={appGroups(apps())} keyed={(group) => group.id}>
                  {(group) => (
                    <Block id={group().id} level="h3" title={t(group().key)}>
                      <div class="marketplace-grid">
                        <For each={group().apps} keyed={(app) => app.id}>
                          {(app) => <AppCard scope={props.scope} app={app()} />}
                        </For>
                      </div>
                    </Block>
                  )}
                </For>
              </Show>
            </div>
          </SlidingTabs.Content>
          <SlidingTabs.Content value="skills">
            <div class="marketplace-stack">
              <SkillUpdates scope={props.scope} />
              <ListingPanel
                listing={props.scope.skills}
                loadingLabel={t("marketplace.loading.skills")}
                count={skills().length}
                empty={
                  <NoMatch
                    scope={props.scope}
                    tab="skills"
                    counts={counts()}
                    filtered={skillsFiltered()}
                    onClearFilters={() => clearFilters("skills")}
                  />
                }
              >
                <SkillGrid scope={props.scope} items={skills()} />
              </ListingPanel>
            </div>
          </SlidingTabs.Content>
          <Show when={model().eventChecks}>
            <SlidingTabs.Content value="eventChecks">
              <EventCheckPanel
                scope={props.scope}
                count={eventChecks().length}
                empty={
                  <NoMatch
                    scope={props.scope}
                    tab="eventChecks"
                    counts={counts()}
                    filtered={eventChecksFiltered()}
                    onClearFilters={() => clearFilters("eventChecks")}
                  />
                }
              >
                <EventCheckGrid scope={props.scope} items={eventChecks()} />
              </EventCheckPanel>
            </SlidingTabs.Content>
          </Show>
        </SlidingTabs.ContentSlot>
      </SlidingTabs.Root>
    </div>
  );
}
