import { Button, ChevronRight, Dialog, ErrorReference, IconButton, X } from "@openbot/ui";
import { createScrollFades } from "@openbot/ui/components/createScrollFades";
import { useText } from "@openbot/ui/text";
import { createEffect, For, Match, onCleanup, onSettled, Show, Switch } from "solid-js";
import { MarketplaceAgentPage } from "./MarketplaceAgentPage";
import { MarketplaceAppPage } from "./MarketplaceAppPage";
import { MarketplaceBrowse } from "./MarketplaceBrowse";
import { MarketplaceEventCheckPage } from "./MarketplaceEventCheckPage";
import { MarketplaceSkillPage } from "./MarketplaceSkillPage";
import { createEventCheckCatalog } from "./marketplace-event-checks";
import { createMarketplaceListing } from "./marketplace-listing";
import type { MarketplaceModel } from "./marketplace-model";
import type { MarketplaceNavigation, MarketplaceScope, MarketplaceView } from "./marketplace-view";

export interface MarketplaceProps {
  model: MarketplaceModel;
  /** Where the user is. The caller owns it, so a link can open the window on an app page. */
  nav: MarketplaceNavigation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A dialog over the window, or a page of the window that the page rail leaves. Default: dialog. */
  variant?: "dialog" | "page" | undefined;
}

function viewTitle(scope: MarketplaceScope, view: MarketplaceView, fallback: string): string {
  switch (view.kind) {
    case "browse":
      return fallback;
    case "agent":
    case "skill":
      return view.listing.name;
    case "app":
      return scope.model.apps().find((app) => app.id === view.id)?.name ?? fallback;
    case "eventCheck":
      return scope.eventChecks.template(view.slug)?.name ?? fallback;
  }
}

/** Marketplace › Linear. A parent crumb goes back to that view. */
function Crumbs(props: { scope: MarketplaceScope; page: boolean }) {
  const { t } = useText();
  const stack = () => props.scope.nav.state.stack;
  const title = (view: MarketplaceView) => viewTitle(props.scope, view, t("marketplace.title"));
  return (
    <nav class="marketplace-crumbs" aria-label={t("marketplace.crumbs.label")}>
      <For each={stack().slice(0, -1)}>
        {(view, index) => (
          <>
            <Button
              type="button"
              variant="ghost"
              class="marketplace-crumb-parent"
              data-cuelume-tap="navigate"
              onClick={() => props.scope.nav.backTo(index())}
            >
              {title(view)}
            </Button>
            <ChevronRight class="marketplace-crumb-separator" aria-hidden="true" />
          </>
        )}
      </For>
      {/* A dialog title needs its dialog, so the page has a plain heading. */}
      <Show
        when={props.page}
        fallback={
          <Dialog.Title class="marketplace-title" tabindex={-1}>
            {title(stack().at(-1) ?? { kind: "browse" })}
          </Dialog.Title>
        }
      >
        <h2 class="marketplace-title" tabindex={-1}>
          {title(stack().at(-1) ?? { kind: "browse" })}
        </h2>
      </Show>
    </nav>
  );
}

/**
 * The inside of the open window. The listings live here, so the catalog loads only while the window
 * is open.
 */
function MarketplaceWindow(props: MarketplaceProps) {
  const { t, errorMessage } = useText();
  const nav = props.nav;
  const scope: MarketplaceScope = {
    get model() {
      return props.model;
    },
    nav,
    agents: createMarketplaceListing({
      list: (query) => props.model.listAgents(query),
      homeCache: props.model.agentHomeCache,
      query: () => nav.state.query,
      category: () => nav.state.agentCategory,
    }),
    skills: createMarketplaceListing({
      list: (query) => props.model.listSkills(query),
      homeCache: props.model.skillHomeCache,
      query: () => nav.state.query,
      category: () => nav.state.skillCategory,
    }),
    eventChecks: createEventCheckCatalog({
      source: () => props.model.eventChecks,
      agents: () => props.model.agents(),
      message: (error) => errorMessage(error, t("marketplace.eventCheck.loadFailed")),
    }),
  };
  let body: HTMLDivElement | undefined;
  // A tab, a search or a new view changes the content height but not the body size, so the frame
  // is observed too.
  const fades = createScrollFades();
  const frameObserver = new ResizeObserver(() => fades.measure());
  onCleanup(() => {
    fades.stop();
    frameObserver.disconnect();
  });
  // For each open view: its scroll offset, and the name of the control the user last clicked, which
  // opened the next view. Back returns to that place and that control.
  const places: { top: number; opener: string | null }[] = [];
  const remember = (place: Partial<(typeof places)[number]>) => {
    const depth = nav.state.stack.length - 1;
    places[depth] = { top: 0, opener: null, ...places[depth], ...place };
  };
  // A new view moves the focus to its name, as a route change does. The first view keeps the focus.
  createEffect(
    () => nav.state.stack.length,
    (length, previous) => {
      if (previous === undefined) return;
      const place = length < previous ? places[length - 1] : undefined;
      places.length = length;
      body?.scrollTo({ top: place?.top ?? 0 });
      const opener = place?.opener
        ? body?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(place.opener)}"]`)
        : null;
      const heading = length > 1 ? body?.querySelector<HTMLElement>(".marketplace-view h3") : null;
      if (heading && !heading.hasAttribute("tabindex")) heading.tabIndex = -1;
      (opener ?? heading ?? document.querySelector<HTMLElement>(".skills-marketplace .marketplace-title"))?.focus({
        preventScroll: true,
      });
    },
  );

  return (
    <>
      <header class="skills-marketplace-topbar">
        <Crumbs scope={scope} page={props.variant === "page"} />
        {/* The page rail is the way back from the page. */}
        <Show when={props.variant !== "page"}>
          <div class="skills-marketplace-topbar-actions">
            <IconButton
              label={t("marketplace.close")}
              variant="ghost"
              data-cuelume-tap="close"
              onClick={() => props.onOpenChange(false)}
            >
              <X />
            </IconButton>
          </div>
        </Show>
      </header>
      <div
        class={["skills-marketplace-body", fades.classes()]}
        ref={(element) => {
          body = element;
          fades.bind(element);
          element.addEventListener(
            "click",
            (event) => {
              const control = event.target instanceof Element ? event.target.closest("[aria-label]") : null;
              remember({ opener: control && element.contains(control) ? control.getAttribute("aria-label") : null });
            },
            true,
          );
        }}
        onScroll={() => {
          fades.measure();
          if (body) remember({ top: body.scrollTop });
        }}
      >
        <div class="marketplace-frame" ref={(element) => frameObserver.observe(element)}>
          <Show when={nav.state.stack.at(-1)} keyed>
            {(view) => (
              <Switch>
                <Match when={view.kind === "browse"}>
                  <MarketplaceBrowse scope={scope} />
                </Match>
                <Match when={view.kind === "agent" && view.listing} keyed>
                  {(listing) => <MarketplaceAgentPage scope={scope} listing={listing} />}
                </Match>
                <Match when={view.kind === "skill" && view.listing} keyed>
                  {(listing) => <MarketplaceSkillPage scope={scope} listing={listing} />}
                </Match>
                <Match when={view.kind === "app" && view.id} keyed>
                  {(id) => <MarketplaceAppPage scope={scope} id={id} />}
                </Match>
                <Match when={view.kind === "eventCheck" && view.slug} keyed>
                  {(slug) => <MarketplaceEventCheckPage scope={scope} slug={slug} />}
                </Match>
              </Switch>
            )}
          </Show>
        </div>
        {/* Said by the live region below too, so a reader hears it once. This line is for the eyes. */}
        <Show when={props.model.notice()}>
          {(message) => (
            <div class="skills-marketplace-notice" aria-hidden="true">
              <span>{message()}</span>
            </div>
          )}
        </Show>
        <Show when={props.model.error()}>
          {(message) => (
            <div class="skills-marketplace-error">
              <span>
                {message()}
                <ErrorReference reference={props.model.errorReference?.()} />
              </span>
              <IconButton label={t("common.close")} variant="ghost" size="icon-sm" onClick={props.model.clearError}>
                <X />
              </IconButton>
            </div>
          )}
        </Show>
      </div>
      {/*
        The skill install menu stays open while installs run, and an open menu hides the rest of the
        window from screen readers. It keeps an element with `data-live-announcer` visible, so the
        results are said from here.
      */}
      <p class="marketplace-visually-hidden" role="status" data-live-announcer="">
        {props.model.notice()}
      </p>
      <p class="marketplace-visually-hidden" role="alert" data-live-announcer="">
        {props.model.error()}
      </p>
    </>
  );
}

/**
 * The Marketplace as a page of the window. The title takes the focus, as a new page does, and the
 * control that opened the page gets it back when the page closes with the focus in it. Escape goes
 * back one view, or else clears the search, or else closes the page, as it closed the dialog. A view
 * keeps the search but does not show it, so the view goes back first. The handler is on the document
 * and after the delegated handlers, so a control that handles Escape keeps it. The focus can stay on
 * the control that opened the page, so a target outside the page also counts, except an open popup or
 * a text field.
 */
function MarketplacePage(props: MarketplaceProps) {
  const { t } = useText();
  let root!: HTMLElement;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  onSettled(() => {
    root.querySelector<HTMLElement>(".marketplace-title")?.focus({ preventScroll: true });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[role=dialog], [role=alertdialog], [role=menu], [role=listbox]")) return;
      if (target && !root.contains(target) && target.closest("input, textarea, select, [contenteditable]")) return;
      event.preventDefault();
      const nav = props.nav;
      if (nav.state.stack.length > 1) nav.back();
      else if (nav.state.query)
        nav.set((draft) => {
          draft.query = "";
        });
      else props.onOpenChange(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("keydown", closeOnEscape);
      // A rail button that closed the page keeps the focus.
      const focus = document.activeElement;
      if (focus && focus !== document.body && !root.contains(focus)) return;
      // After the page leaves the DOM, unless the next page took the focus.
      queueMicrotask(() => {
        if (opener?.isConnected && (!document.activeElement || document.activeElement === document.body)) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  });
  return (
    <section ref={root} class="skills-marketplace skills-marketplace-page" aria-label={t("marketplace.title")}>
      <MarketplaceWindow {...props} />
    </section>
  );
}

/** The Marketplace window: agents, apps, skills and event checks, and a page for each. */
export function Marketplace(props: MarketplaceProps) {
  // A closed window starts again from the first tab, with no search and no filter.
  createEffect(
    () => props.open,
    (open, previous) => {
      if (previous && !open) props.nav.reset();
    },
  );
  return (
    <Show
      when={props.variant === "page"}
      fallback={
        <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
          <Dialog.Portal>
            <Dialog.Overlay class="skills-marketplace-backdrop">
              <Dialog.Content class="skills-marketplace" onOpenAutoFocus={(event: Event) => event.preventDefault()}>
                <MarketplaceWindow {...props} />
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>
      }
    >
      <Show when={props.open}>
        <MarketplacePage {...props} />
      </Show>
    </Show>
  );
}
