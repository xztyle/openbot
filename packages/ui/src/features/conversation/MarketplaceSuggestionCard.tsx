import { Button, Check, IconButton, Lock, Spinner, X } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createSignal, createStore, createUniqueId, onCleanup, onSettled, Show } from "solid-js";
import { useText } from "../../text";
import { PluginIcon } from "../marketplace/PluginIcon";

/** An app connects to a service. A skill installs on the agent. */
export type MarketplaceSuggestionKind = "app" | "skill";

/**
 * Where the suggested listing is for this user. `attention` is an app whose connection needs a new
 * sign-in. `unavailable` cannot be connected here, for example by a member of a joined server.
 * `disabled` is an app that is connected and turned off. `off` is an app that is connected and
 * turned on, and that this chat may not use yet: only the user allows it, from the app's page.
 */
export type MarketplaceSuggestionState =
  | "available"
  | "busy"
  | "connected"
  | "attention"
  | "unavailable"
  | "disabled"
  | "off";

export interface MarketplaceSuggestionCardProps {
  kind: MarketplaceSuggestionKind;
  name: string;
  /** The one line under the name: the listing tagline. */
  description: string;
  iconUrl: string | null;
  /** Drawn instead of the icon: the mark of an app with no listing icon, such as GitHub. */
  mark?: JSX.Element | undefined;
  state: MarketplaceSuggestionState;
  /** Why the user cannot connect it here. Shown under the header when `unavailable`. */
  unavailableText?: string;
  /** What the user has to do next. Shown under the header when the state is `off` or `disabled`. */
  stateText?: string;
  /** The user dismissed the card. It stays as one line with Undo. */
  dismissed?: boolean;
  /** Runs the connect or install step. The approval and sign-in dialogs stay in the consumer. */
  onConnect?: (() => void) | undefined;
  /** Opens the listing in Marketplace. */
  onOpenDetails?: (() => void) | undefined;
  /**
   * Opens the app's page, where the user turns an account on or allows it in this chat. It grants
   * nothing: the choice is made on the page.
   */
  onManage?: (() => void) | undefined;
  onDismiss?: () => void;
  onRestore?: () => void;
}

/**
 * A Marketplace app or skill that an agent suggests in a conversation. The user connects it from
 * the chat, opens its listing, or dismisses it.
 */
export function MarketplaceSuggestionCard(props: MarketplaceSuggestionCardProps) {
  const { t } = useText();
  const titleId = createUniqueId();
  /* Dismiss and Undo replace each other, so the focus moves to the control that is there now. */
  let dismissButton: HTMLButtonElement | undefined;
  let undoButton: HTMLButtonElement | undefined;
  /* The action animates only a change that the user started here. A card that opens connected, or
     that reads its state late, shows the state with no motion. */
  const [moving, setMoving] = createSignal(false);
  return (
    <Show
      when={!props.dismissed}
      fallback={
        <div class="marketplace-suggestion-dismissed">
          <span role="status">{t("chat.suggestion.dismissed", { name: props.name })}</span>
          <Show when={props.onRestore}>
            <Button
              variant="ghost"
              size="xs"
              type="button"
              ref={(element) => (undoButton = element)}
              onClick={() => {
                props.onRestore?.();
                onSettled(() => dismissButton?.focus());
              }}
            >
              {t("chat.suggestion.undo")}
            </Button>
          </Show>
        </div>
      }
    >
      <article
        class="conversation-interaction-card marketplace-suggestion"
        aria-labelledby={titleId}
        data-state={props.state}
        data-motion={moving() ? "" : undefined}
      >
        <header class="marketplace-suggestion-header">
          <Show
            when={props.mark}
            fallback={
              <PluginIcon
                iconUrl={props.iconUrl}
                fallback={props.kind === "skill" ? "skill" : "plugin"}
                class="marketplace-suggestion-icon"
              />
            }
          >
            {(mark) => <span class="skills-marketplace-icon marketplace-suggestion-icon">{mark()}</span>}
          </Show>
          <div class="marketplace-suggestion-heading">
            <h3 id={titleId} class="marketplace-suggestion-title">
              <Show when={props.onOpenDetails} fallback={props.name}>
                <Button
                  variant="link"
                  type="button"
                  class="marketplace-suggestion-name"
                  aria-label={t("chat.suggestion.detailsNamed", { name: props.name })}
                  onClick={() => props.onOpenDetails?.()}
                >
                  {props.name}
                </Button>
              </Show>
            </h3>
            <span class="marketplace-suggestion-description">{props.description}</span>
          </div>
          <div class="marketplace-suggestion-action" role="status">
            <SuggestionAction {...props} onStart={() => setMoving(true)} />
          </div>
          {/* A connected card has nothing to dismiss. The stylesheet folds the button away, so the
              action moves to the edge instead of a jump. */}
          <Show when={props.onDismiss}>
            <IconButton
              label={t("chat.suggestion.dismissNamed", { name: props.name })}
              variant="ghost"
              size="icon-xs"
              class="marketplace-suggestion-dismiss"
              ref={(element) => (dismissButton = element)}
              onClick={() => {
                props.onDismiss?.();
                onSettled(() => undoButton?.focus());
              }}
            >
              <X />
            </IconButton>
          </Show>
        </header>
        <Show when={props.state === "unavailable" && props.unavailableText}>
          <p class="marketplace-suggestion-unavailable">
            <Lock aria-hidden="true" />
            {props.unavailableText}
          </p>
        </Show>
        <Show when={(props.state === "off" || props.state === "disabled") && props.stateText}>
          <p class="marketplace-suggestion-unavailable">
            <Lock aria-hidden="true" />
            {props.stateText}
          </p>
        </Show>
      </article>
    </Show>
  );
}

/**
 * Connect or Install. The same button shows the busy step and then turns green with a check, so the
 * focus stays on it. Each label keeps its width, and the button takes the width of the label on screen.
 */
function SuggestionAction(props: MarketplaceSuggestionCardProps & { onStart: () => void }) {
  const { t } = useText();
  const app = () => props.kind === "app";
  const done = () => props.state === "connected";
  const busy = () => props.state === "busy";
  const startable = () => props.state === "available" || props.state === "attention";
  /** Connected, and turned off or not allowed in this chat: the user decides on the app's page. */
  const managed = () => props.state === "off" || props.state === "disabled";
  const shown = () => done() || Boolean(props.onConnect && props.state !== "unavailable" && !managed());
  const variant = () => (props.state === "attention" ? "outline" : "default");
  const label = () => {
    if (done()) return undefined;
    if (!app()) return t("chat.suggestion.installNamed", { name: props.name });
    return props.state === "attention"
      ? t("marketplace.app.reconnectNamed", { name: props.name })
      : t("marketplace.app.connectNamed", { name: props.name });
  };
  const text = () => {
    if (!app()) return t("chat.suggestion.install");
    return props.state === "attention" ? t("marketplace.app.reconnect") : t("marketplace.app.connect");
  };
  const doneText = () => (app() ? t("marketplace.app.connected") : t("chat.suggestion.installed"));
  const [widths, setWidths] = createStore({ start: 0, done: 0 });
  // `Show` builds the button again when it comes back, so a layer drops the observer of its old element.
  const observers: Partial<Record<"start" | "done", ResizeObserver>> = {};
  onCleanup(() => {
    observers.start?.disconnect();
    observers.done?.disconnect();
  });
  const measure = (layer: "start" | "done") => (element: HTMLElement) => {
    observers[layer]?.disconnect();
    const observer = new ResizeObserver(() =>
      setWidths((draft) => {
        draft[layer] = element.offsetWidth;
      }),
    );
    observer.observe(element);
    observers[layer] = observer;
  };
  // A busy or connected button does nothing, so it makes no tap sound, as a loading button does not.
  const tapCue = () => (startable() ? "" : undefined);
  const stageStyle = () => {
    const width = widths[done() ? "done" : "start"];
    return width > 0 ? { width: `${width}px` } : undefined;
  };
  return (
    <Show
      when={!(props.onManage && managed())}
      fallback={
        <Button
          type="button"
          variant="default"
          size="sm"
          aria-label={
            props.state === "off"
              ? t("chat.suggestion.allowNamed", { name: props.name })
              : t("chat.suggestion.turnOnNamed", { name: props.name })
          }
          onClick={() => props.onManage?.()}
        >
          {props.state === "off" ? t("chat.suggestion.allow") : t("chat.suggestion.turnOn")}
        </Button>
      }
    >
      <Show when={shown()}>
        <Button
          type="button"
          variant={variant()}
          size="sm"
          class="marketplace-suggestion-button"
          data-state={props.state}
          data-cuelume-tap={tapCue()}
          data-disabled={busy() ? "" : undefined}
          aria-busy={busy() ? "true" : undefined}
          aria-disabled={busy() || done() ? "true" : undefined}
          aria-label={label()}
          onClick={() => {
            if (!startable()) return;
            props.onStart();
            props.onConnect?.();
          }}
        >
          <span class="marketplace-suggestion-stage" style={stageStyle()}>
            <span
              class="marketplace-suggestion-layer"
              data-layer="start"
              ref={measure("start")}
              aria-hidden={done() ? "true" : undefined}
            >
              <span class="marketplace-suggestion-spinner">
                <Spinner size="sm" />
              </span>
              {text()}
            </span>
            <span
              class="marketplace-suggestion-layer"
              data-layer="done"
              ref={measure("done")}
              aria-hidden={done() ? undefined : "true"}
            >
              <Check aria-hidden="true" />
              {doneText()}
            </span>
          </span>
        </Button>
      </Show>
    </Show>
  );
}
