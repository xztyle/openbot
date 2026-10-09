import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import {
  Badge,
  Bell,
  Button,
  Heading,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
  SettingsSection,
  Skeleton,
  Text,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import type { JSX } from "@solidjs/web";
import { createEffect, createSignal, For, Show } from "solid-js";
import { Done } from "./MarketplaceParts";
import { templateLinkOf } from "./marketplace-event-checks";
import type { MarketplaceScope } from "./marketplace-view";

/** A template's own icon, or a bell when it has none or the icon does not load. */
export function EventCheckMark(props: { template: Pick<EventCheckTemplate, "iconUrl">; size: "sm" | "md" }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  const url = () => (props.template.iconUrl && props.template.iconUrl !== failed() ? props.template.iconUrl : null);
  return (
    <span class="marketplace-skill-mark" data-size={props.size} data-kind={url() ? "icon" : "none"} aria-hidden="true">
      <Show when={url()} fallback={<Bell />} keyed>
        {(src) => <img src={src} alt="" onError={() => setFailed(src)} />}
      </Show>
    </span>
  );
}

/** The name of the app a template reads from, or its slug while the app is not in the catalog. */
export function worksWithName(scope: MarketplaceScope, template: EventCheckTemplate): string | null {
  const slug = template.app;
  if (!slug) return null;
  return scope.model.apps().find((app) => app.id === slug)?.name ?? slug;
}

/** Whether a copy of the template is on an older version than the host's. */
export function isOutdated(template: EventCheckTemplate, version: string | undefined): boolean {
  return version !== undefined && version !== template.version;
}

/** Whether a template matches the search. */
export function matchesTemplate(template: EventCheckTemplate, query: string): boolean {
  const text = query.trim().toLowerCase();
  return (
    !text ||
    [template.name, template.tagline, template.creatorName, template.app ?? ""].some((value) =>
      value.toLowerCase().includes(text),
    )
  );
}

/** The whole card opens the page of the template. */
function EventCheckCard(props: { scope: MarketplaceScope; template: EventCheckTemplate }) {
  const { t } = useText();
  const id = () => `marketplace-event-check-${props.template.slug}`;
  const instances = () => props.scope.eventChecks.instances(props.template.slug);
  const outdated = () => instances().some((entry) => isOutdated(props.template, templateLinkOf(entry.check)?.version));
  const foot = () =>
    [
      props.template.creatorName,
      worksWithName(props.scope, props.template) &&
        t("marketplace.eventCheck.worksWith", { app: worksWithName(props.scope, props.template) ?? "" }),
    ]
      .filter(Boolean)
      .join(" · ");
  return (
    <article class="marketplace-card" aria-labelledby={id()}>
      <Button
        type="button"
        variant="ghost"
        class="marketplace-hitarea"
        data-cuelume-tap="navigate"
        aria-label={t("marketplace.open", { name: props.template.name })}
        onClick={() => props.scope.nav.go({ kind: "eventCheck", slug: props.template.slug })}
      />
      <div class="marketplace-card-head">
        <EventCheckMark template={props.template} size="md" />
        <Heading as="h3" size="sm" class="marketplace-card-name" id={id()}>
          {props.template.name}
        </Heading>
        <Show when={instances().length > 0}>
          <div class="marketplace-card-action">
            <Show when={outdated()} fallback={<Done>{t("marketplace.eventCheck.installed")}</Done>}>
              <Badge variant="info-light">{t("marketplace.eventCheck.updateAvailable")}</Badge>
            </Show>
          </div>
        </Show>
      </div>
      <Text as="p" variant="body-sm" class="marketplace-card-body">
        {props.template.tagline}
      </Text>
      <div class="marketplace-card-foot">
        <Text as="span" variant="caption" tone="muted">
          {foot()}
        </Text>
      </div>
    </article>
  );
}

export function EventCheckGrid(props: { scope: MarketplaceScope; items: readonly EventCheckTemplate[] }) {
  return (
    <div class="marketplace-grid">
      <For each={props.items} keyed={(template) => template.slug}>
        {(template) => <EventCheckCard scope={props.scope} template={template()} />}
      </For>
    </div>
  );
}

/** The first load of the templates, its failure, and the cards. `empty` shows when nothing is left to show. */
export function EventCheckPanel(props: {
  scope: MarketplaceScope;
  count: number;
  empty: JSX.Element;
  children: JSX.Element;
}) {
  const { t } = useText();
  const catalog = () => props.scope.eventChecks;
  return (
    <Show
      when={catalog().status() !== "loading" && catalog().status() !== "idle"}
      fallback={
        <div class="marketplace-grid" role="status" aria-label={t("marketplace.loading.eventChecks")}>
          <For each={Array.from({ length: 3 }, (_, index) => index)}>
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
      <Show
        when={catalog().status() !== "failed"}
        fallback={
          <div class="marketplace-empty" role="alert">
            <Text as="p" variant="body-sm" tone="muted">
              {catalog().error()}
            </Text>
            <Button type="button" variant="outline" size="sm" onClick={catalog().reload}>
              {t("common.retry")}
            </Button>
          </div>
        }
      >
        <div class="marketplace-stack">
          <Text as="p" variant="body-sm" tone="muted">
            {t("marketplace.eventCheck.intro")}
          </Text>
          <Show when={props.count > 0} fallback={props.empty}>
            {props.children}
          </Show>
        </div>
      </Show>
    </Show>
  );
}

/**
 * The reviewed event checks that read the API of an app, on the app's page. They keep their own
 * private variables on the host. They never use the accounts of the app, so connecting the app gives
 * a check no access, and a check gives the app none.
 */
export function RelatedEventChecks(props: { scope: MarketplaceScope; appId: string }) {
  const { t } = useText();
  const catalog = () => props.scope.eventChecks;
  const templates = () =>
    props.scope.model.eventChecks
      ? catalog()
          .templates()
          .filter((template) => template.app === props.appId)
      : [];
  /* The installed copies show only once the checks of the agents were read. */
  createEffect(
    () => templates().length > 0,
    (any) => {
      if (any) catalog().readChecks();
    },
  );
  const outdated = (template: EventCheckTemplate) =>
    catalog()
      .instances(template.slug)
      .some((entry) => isOutdated(template, templateLinkOf(entry.check)?.version));
  return (
    <Show when={templates().length > 0}>
      <SettingsSection title={t("marketplace.eventCheck.forApp")} description={t("marketplace.eventCheck.forAppHelp")}>
        <ItemGroup class="settings-modal-card">
          <For each={templates()} keyed={(template) => template.slug}>
            {(template) => (
              <Item class="settings-modal-row">
                <ItemMedia>
                  <EventCheckMark template={template()} size="sm" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{template().name}</ItemTitle>
                  <ItemDescription>{template().tagline}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Show when={catalog().instances(template().slug).length > 0}>
                    <Show when={outdated(template())} fallback={<Done>{t("marketplace.eventCheck.installed")}</Done>}>
                      <Badge variant="info-light">{t("marketplace.eventCheck.updateAvailable")}</Badge>
                    </Show>
                  </Show>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("marketplace.open", { name: template().name })}
                    onClick={() => props.scope.nav.go({ kind: "eventCheck", slug: template().slug })}
                  >
                    {t("marketplace.eventCheck.view")}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
      </SettingsSection>
    </Show>
  );
}
