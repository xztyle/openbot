import type { EventCheckTemplate } from "@openbot/contracts/event-check-templates";
import { pluginLinkText } from "@openbot/contracts/plugin-links";
import { Badge, Button, ConfirmDialog, ExternalLink, Heading, Text } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createEffect, createStore, For, Show } from "solid-js";
import { EventCheckInstallDialog } from "./EventCheckInstallDialog";
import { EventCheckMark, isOutdated, worksWithName } from "./MarketplaceEventChecks";
import { Block, PageHead, Properties } from "./MarketplaceParts";
import { accountLabelOf, type EventCheckInstance, templateLinkOf } from "./marketplace-event-checks";
import type { MarketplaceScope } from "./marketplace-view";

interface PageState {
  /** The copy that the user is about to update. */
  updating: EventCheckInstance | null;
  updateError: string;
  /** What a link or an update did, for the reader and the screen reader. */
  notice: string;
  /** The error of a link, as a sentence. */
  linkError: string;
  /** The check that is being linked. */
  linking: string | null;
  installing: boolean;
}

/** What the user needs before they install: private variables, settings and the interval. */
function Needs(props: { scope: MarketplaceScope; template: EventCheckTemplate }) {
  const { t } = useText();
  const template = () => props.template;
  const nothing = () => template().variables.length === 0 && template().configuration.length === 0;
  return (
    <Block id="marketplace-event-check-need" level="h4" title={t("marketplace.eventCheck.need.title")}>
      <div class="marketplace-need">
        <Show when={template().variables.length > 0}>
          <section class="marketplace-need-group" aria-labelledby="marketplace-event-check-variables">
            <Heading as="h5" size="sm" id="marketplace-event-check-variables">
              {t("marketplace.eventCheck.need.variables")}
            </Heading>
            <Text as="p" variant="caption" tone="muted">
              {t("marketplace.eventCheck.need.variablesHelp")}
            </Text>
            <ul class="marketplace-need-list">
              <For each={template().variables}>
                {(variable) => (
                  <li>
                    <Text as="span" variant="body-sm" class="marketplace-need-name">
                      {variable.label}
                    </Text>
                    <Show when={variable.hint}>
                      <Text as="span" variant="caption" tone="muted">
                        {variable.hint}
                      </Text>
                    </Show>
                    <Show when={variable.docsUrl}>
                      {(url) => (
                        <Button
                          type="button"
                          variant="link"
                          class="marketplace-link"
                          aria-label={t("marketplace.eventCheck.need.docsNamed", { label: variable.label })}
                          onClick={() => props.scope.model.openUrl(url())}
                        >
                          {t("marketplace.eventCheck.need.docs")}
                          <ExternalLink aria-hidden="true" />
                        </Button>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={template().configuration.length > 0}>
          <section class="marketplace-need-group" aria-labelledby="marketplace-event-check-settings">
            <Heading as="h5" size="sm" id="marketplace-event-check-settings">
              {t("marketplace.eventCheck.need.settings")}
            </Heading>
            <Text as="p" variant="caption" tone="muted">
              {t("marketplace.eventCheck.need.settingsHelp")}
            </Text>
            <ul class="marketplace-need-list">
              <For each={template().configuration}>
                {(field) => (
                  <li>
                    <Text as="span" variant="body-sm" class="marketplace-need-name">
                      {field.label}{" "}
                      <Badge variant="outline">
                        {field.required
                          ? t("marketplace.eventCheck.need.required")
                          : t("marketplace.eventCheck.optional")}
                      </Badge>
                    </Text>
                    <Show when={field.description}>
                      <Text as="span" variant="caption" tone="muted">
                        {field.description}
                      </Text>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
        <Show when={nothing()}>
          <Text as="p" variant="body-sm" tone="muted">
            {t("marketplace.eventCheck.need.nothing")}
          </Text>
        </Show>
        <Text as="p" variant="body-sm" tone="muted">
          {t("marketplace.eventCheck.need.interval", {
            interval: t("marketplace.eventCheck.intervalSeconds", {
              count: template().intervalSeconds,
            }),
          })}
        </Text>
      </div>
    </Block>
  );
}

/** The detail page of one event check template: what it needs, the install, and every copy of it. */
export function MarketplaceEventCheckPage(props: { scope: MarketplaceScope; slug: string }) {
  const { t, errorMessage } = useText();
  const catalog = () => props.scope.eventChecks;
  const model = () => props.scope.model;
  const [state, setState] = createStore<PageState>({
    updating: null,
    updateError: "",
    notice: "",
    linkError: "",
    linking: null,
    installing: false,
  });
  const template = () => catalog().template(props.slug);
  const worksWith = () => {
    const found = template();
    return found ? worksWithName(props.scope, found) : null;
  };
  let installButton: HTMLButtonElement | undefined;

  // An effect, not `onSettled`: the read goes through the owner's props.
  createEffect(
    () => props.slug,
    () => {
      catalog().load();
      catalog().readChecks();
    },
  );

  const reading = () =>
    model()
      .agents()
      .some((agent) => ["idle", "loading"].includes(catalog().checksRead(agent.id)));

  async function update(entry: EventCheckInstance) {
    setState((draft) => {
      draft.updateError = "";
    });
    try {
      const check = await catalog().update({ agentId: entry.check.agentId, id: entry.check.id });
      setState((draft) => {
        draft.updating = null;
        draft.notice = t("marketplace.eventCheck.updated", {
          name: check.name,
          version: templateLinkOf(check)?.version ?? template()?.version ?? "",
        });
      });
    } catch (error) {
      setState((draft) => {
        draft.updateError = errorMessage(error, t("agentSettings.eventCheck.failed"));
      });
    }
  }

  async function link(entry: EventCheckInstance) {
    if (state.linking) return;
    setState((draft) => {
      draft.linking = entry.check.id;
      draft.linkError = "";
      draft.notice = "";
    });
    try {
      const check = await catalog().adopt({ agentId: entry.check.agentId, id: entry.check.id, slug: props.slug });
      setState((draft) => {
        draft.notice = t("marketplace.eventCheck.linked", { name: check.name });
      });
    } catch (error) {
      setState((draft) => {
        draft.linkError = errorMessage(error, t("agentSettings.eventCheck.failed"));
      });
    } finally {
      setState((draft) => {
        draft.linking = null;
      });
    }
  }

  return (
    <div class="marketplace-view">
      <Show
        when={template()}
        fallback={
          <Show
            when={catalog().status() === "loading" || catalog().status() === "idle"}
            fallback={
              <div class="marketplace-empty" role="alert">
                <Text as="p" variant="body-sm" tone="muted">
                  {catalog().status() === "failed" ? catalog().error() : t("marketplace.eventCheck.missing")}
                </Text>
                <Show when={catalog().status() === "failed"}>
                  <Button type="button" variant="outline" size="sm" onClick={catalog().reload}>
                    {t("common.retry")}
                  </Button>
                </Show>
              </div>
            }
          >
            <Text as="p" variant="body-sm" tone="muted" role="status">
              {t("marketplace.eventCheck.loading")}
            </Text>
          </Show>
        }
      >
        {(current) => (
          <>
            <PageHead
              media={<EventCheckMark template={current()} size="md" />}
              title={current().name}
              description={current().tagline}
              actions={
                <Button
                  type="button"
                  ref={(element) => (installButton = element)}
                  onClick={() =>
                    setState((draft) => {
                      draft.installing = true;
                    })
                  }
                >
                  {t("marketplace.eventCheck.install")}
                </Button>
              }
            />
            <div class="marketplace-page">
              <div class="marketplace-stack">
                <Text as="p" variant="body-sm" class="marketplace-event-check-description">
                  {current().description}
                </Text>
                <Needs scope={props.scope} template={current()} />
                <Block
                  id="marketplace-event-check-installed"
                  level="h4"
                  title={t("marketplace.eventCheck.installedTitle")}
                  description={t("marketplace.eventCheck.installedHelp")}
                >
                  <InstalledCopies
                    scope={props.scope}
                    template={current()}
                    reading={reading()}
                    linking={state.linking}
                    onUpdate={(entry) =>
                      setState((draft) => {
                        draft.updating = entry;
                        draft.updateError = "";
                        draft.notice = "";
                      })
                    }
                    onLink={(entry) => void link(entry)}
                    linkError={state.linkError}
                    notice={state.notice}
                  />
                </Block>
              </div>
              <Properties
                label={t("marketplace.properties.eventCheck")}
                items={[
                  { label: t("marketplace.properties.creator"), value: current().creatorName },
                  ...(worksWith() ? [{ label: t("marketplace.properties.worksWith"), value: worksWith() ?? "" }] : []),
                  { label: t("marketplace.properties.version"), value: current().version },
                  {
                    label: t("marketplace.properties.interval"),
                    value: t("marketplace.eventCheck.intervalSeconds", { count: current().intervalSeconds }),
                  },
                  ...(current().websiteUrl
                    ? [
                        {
                          label: t("marketplace.properties.website"),
                          value: (
                            <Button
                              type="button"
                              variant="link"
                              class="marketplace-link"
                              onClick={() => {
                                const url = current().websiteUrl;
                                if (url) model().openUrl(url);
                              }}
                            >
                              {pluginLinkText(current().websiteUrl ?? "")}
                              <ExternalLink aria-hidden="true" />
                            </Button>
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            </div>
            <Show when={state.installing}>
              <EventCheckInstallDialog
                template={current()}
                agents={model().agents()}
                activeAgentId={model().activeAgentId()}
                catalog={catalog()}
                onOpenUrl={(url) => model().openUrl(url)}
                onClose={() => {
                  setState((draft) => {
                    draft.installing = false;
                  });
                  installButton?.focus();
                }}
              />
            </Show>
            <Show when={state.updating} keyed>
              {(entry) => (
                <ConfirmDialog
                  open={true}
                  tone="default"
                  initialFocus="cancel"
                  title={t("marketplace.eventCheck.update.title", { name: entry.check.name })}
                  description={t("marketplace.eventCheck.update.description", {
                    from: templateLinkOf(entry.check)?.version ?? "",
                    to: current().version,
                  })}
                  confirmLabel={t("marketplace.eventCheck.update.confirm")}
                  error={state.updateError || undefined}
                  onCancel={() =>
                    setState((draft) => {
                      draft.updating = null;
                    })
                  }
                  onConfirm={() => update(entry)}
                />
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

/** Every copy of the template on the agents, and the checks that the user could link to it. */
function InstalledCopies(props: {
  scope: MarketplaceScope;
  template: EventCheckTemplate;
  reading: boolean;
  linking: string | null;
  linkError: string;
  notice: string;
  onUpdate: (entry: EventCheckInstance) => void;
  onLink: (entry: EventCheckInstance) => void;
}) {
  const { t } = useText();
  const catalog = () => props.scope.eventChecks;
  const instances = () => catalog().instances(props.template.slug);
  const unlinked = () => catalog().unlinked();
  const failedAgents = () => catalog().unreadAgents();
  return (
    <div class="marketplace-stack">
      <Show when={props.reading}>
        <Text as="p" variant="body-sm" tone="muted" role="status">
          {t("marketplace.eventCheck.reading")}
        </Text>
      </Show>
      <Show when={failedAgents().length > 0}>
        <Text as="p" variant="body-sm" tone="muted" role="alert">
          {t("marketplace.eventCheck.readFailed", {
            agents: failedAgents()
              .map((agent) => agent.name)
              .join(", "),
          })}
        </Text>
      </Show>
      <Show
        when={instances().length > 0}
        fallback={
          <Show when={!props.reading && failedAgents().length === 0}>
            <Text as="p" variant="body-sm" tone="muted">
              {t("marketplace.eventCheck.installedNone")}
            </Text>
          </Show>
        }
      >
        <ul class="marketplace-rows">
          <For each={instances()} keyed={(entry) => `${entry.check.agentId}:${entry.check.id}`}>
            {(entry) => {
              const version = () => templateLinkOf(entry().check)?.version;
              return (
                <li class="marketplace-row marketplace-event-check-row">
                  <span class="marketplace-avatar" data-size="sm">
                    <AgentAvatar agent={entry().agent} motion="idle" />
                  </span>
                  <span class="marketplace-row-copy">
                    <Text as="span" variant="body-sm">
                      {t("marketplace.eventCheck.instance", {
                        agent: entry().agent.name,
                        account: accountLabelOf(entry().check),
                      })}
                    </Text>
                    <Text as="span" variant="caption" tone="muted">
                      {t("marketplace.eventCheck.version", { version: version() ?? "" })}
                    </Text>
                  </span>
                  <Badge variant={entry().check.active ? "success-light" : "outline"}>
                    {entry().check.active
                      ? t("marketplace.eventCheck.status.active")
                      : t("marketplace.eventCheck.status.paused")}
                  </Badge>
                  <Show when={isOutdated(props.template, version())}>
                    <Badge variant="info-light">{t("marketplace.eventCheck.updateAvailable")}</Badge>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={t("marketplace.eventCheck.updateNamed", { name: entry().check.name })}
                      onClick={() => props.onUpdate(entry())}
                    >
                      {t("marketplace.eventCheck.update")}
                    </Button>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <Show when={unlinked().length > 0}>
        <section class="marketplace-stack" aria-labelledby="marketplace-event-check-unlinked">
          <Heading as="h5" size="sm" id="marketplace-event-check-unlinked">
            {t("marketplace.eventCheck.unlinked.title")}
          </Heading>
          <Text as="p" variant="caption" tone="muted">
            {t("marketplace.eventCheck.unlinked.help")}
          </Text>
          <ul class="marketplace-rows">
            <For each={unlinked()} keyed={(entry) => `${entry.check.agentId}:${entry.check.id}`}>
              {(entry) => (
                <li class="marketplace-row marketplace-event-check-row">
                  <span class="marketplace-avatar" data-size="sm">
                    <AgentAvatar agent={entry().agent} motion="idle" />
                  </span>
                  <span class="marketplace-row-copy">
                    <Text as="span" variant="body-sm">
                      {entry().check.name}
                    </Text>
                    <Text as="span" variant="caption" tone="muted">
                      {t("marketplace.eventCheck.instance", {
                        agent: entry().agent.name,
                        account: accountLabelOf(entry().check),
                      })}
                    </Text>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    loading={props.linking === entry().check.id}
                    disabled={props.linking !== null}
                    aria-label={t("marketplace.eventCheck.linkNamed", { name: entry().check.name })}
                    onClick={() => props.onLink(entry())}
                  >
                    {t("marketplace.eventCheck.link")}
                  </Button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </Show>
      <Show when={props.linkError}>
        <Text as="p" variant="body-sm" role="alert">
          {props.linkError}
        </Text>
      </Show>
      <Show when={props.notice}>
        <Text as="p" variant="body-sm" role="status">
          {props.notice}
        </Text>
      </Show>
    </div>
  );
}
