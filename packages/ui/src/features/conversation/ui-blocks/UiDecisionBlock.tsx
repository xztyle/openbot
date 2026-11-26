import { ownerDecisionView, type UiAction, type UiConfirmBlock as UiConfirmSpec } from "@openbot/contracts/ui-blocks";
import { Badge, Button, ExternalLink, Spinner } from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { useText } from "../../../text";
import { cx } from "../../../utils";
import { UiBlockCard } from "./UiBlockCard";
import { sendUiBlockResponse, type UiBlockProps, uiBlockState } from "./ui-block-support";

export interface UiDecisionBlockProps extends UiBlockProps<UiConfirmSpec> {
  /** Draws `spec.preview` as safe Markdown. Without it the preview is plain text. */
  renderPreview?: ((markdown: string) => JSX.Element) | undefined;
  /** Opens the card's link, such as the ad campaign. */
  onOpenLink?: ((url: string) => void) | undefined;
  /**
   * The agent's call ended before an answer (a restart, a stop), and the card still takes one: the
   * answer goes to the agent as a message. The card says so and keeps its buttons.
   */
  lateAnswer?: boolean | undefined;
  /** Who asks, when the card does not say it: the agent of the chat the card is in. */
  askerName?: string | undefined;
}

/** The place a link opens, in a word: Meta, Google, or the site's host. */
function linkPlace(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
  if (/(^|\.)(facebook|instagram|meta)\.com$/u.test(host)) return "Meta";
  if (/(^|\.)google\.com$/u.test(host)) return "Google";
  if (/(^|\.)tiktok\.com$/u.test(host)) return "TikTok";
  return host;
}

/** An ads manager page: its button says it shows the campaign. */
function isAdsManager(url: string): boolean {
  return /^https:\/\/(adsmanager\.facebook\.com|business\.facebook\.com|ads\.google\.com|ads\.tiktok\.com)\//u.test(
    url,
  );
}

/**
 * The card of a decision that only the owner takes (`request_decision`): who asks, the question, each
 * option as a clear button with what it does, the recommended one marked, the amount, a labelled link,
 * and what happens after the choice. Ticket keys and raw addresses stay behind the technical details.
 */
export function UiDecisionBlock(props: UiDecisionBlockProps) {
  const { t, sourceText } = useText();
  const view = () => ownerDecisionView(props.spec);
  const stored = () => uiBlockState(props);
  // A card that still takes an answer reads as open, not as expired.
  const open = () => stored().status === "pending" || (props.lateAnswer === true && stored().status === "expired");
  const status = () => (open() ? "pending" : stored().status);
  const locked = () => !open() || props.disabled === true || props.busy === true;
  const askedBy = () => view().askedBy ?? props.askerName;
  const asker = () => askedBy() ?? t("uiBlock.decision.theAgent");

  function respond(action: UiAction): void {
    if (locked()) return;
    sendUiBlockResponse(props.spec, { actionId: action.id }, props.onRespond);
  }

  return (
    <UiBlockCard
      class={cx("ui-block-decision", props.class)}
      title={props.spec.title}
      subtitle={askedBy() ? t("uiBlock.decision.askedBy", { name: askedBy() ?? "" }) : undefined}
      status={status()}
      outcome={stored().outcome}
      busy={props.busy}
      error={props.error}
      onSkip={props.disabled || !open() ? undefined : props.onSkip}
      elementRef={props.elementRef}
    >
      <Show when={view().escalated}>{(escalated) => <p class="ui-decision-note">{sourceText(escalated())}</p>}</Show>
      <Show when={open() && props.lateAnswer === true && stored().status === "expired"}>
        <p class="ui-decision-late" role="note">
          {t("uiBlock.decision.lateNote", { name: asker() })}
        </p>
      </Show>
      <Show when={view().amount}>
        {(amount) => (
          <p class="ui-decision-amount">
            <span class="ui-decision-amount-label">{t("uiBlock.decision.amount")}</span>
            <strong>{sourceText(amount())}</strong>
          </p>
        )}
      </Show>
      <Show when={view().preview}>
        {(preview) => (
          <div class="ui-decision-preview">
            <Show when={props.renderPreview} fallback={<p class="ui-block-preview-text">{preview()}</p>}>
              {(render) => render()(preview())}
            </Show>
          </div>
        )}
      </Show>
      <Show when={view().link}>
        {(link) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="ui-decision-link"
            onClick={() => props.onOpenLink?.(link())}
            disabled={!props.onOpenLink}
          >
            <ExternalLink data-icon="inline-start" aria-hidden="true" />
            {isAdsManager(link())
              ? t("uiBlock.decision.openCampaign", { place: linkPlace(link()) })
              : t("uiBlock.decision.openLink", { place: linkPlace(link()) })}
          </Button>
        )}
      </Show>
      <Show when={open()}>
        <fieldset class="ui-decision-options" aria-busy={props.busy ? "true" : undefined}>
          <legend class="ui-decision-legend">
            {props.lateAnswer === true && stored().status === "expired"
              ? t("uiBlock.decision.answerAnyway")
              : t("uiBlock.decision.choose")}
          </legend>
          <For each={view().options}>
            {(option) => (
              <Button
                type="button"
                variant={option.recommended ? "default" : "outline"}
                class="ui-decision-option"
                data-recommended={option.recommended ? "" : undefined}
                disabled={locked()}
                onClick={() => respond(option.action)}
              >
                <span class="ui-decision-option-head">
                  <span class="ui-decision-option-label">{option.action.label}</span>
                  <Show when={option.recommended}>
                    <Badge variant="secondary" class="ui-decision-recommended">
                      {t("uiBlock.decision.recommended")}
                    </Badge>
                  </Show>
                </span>
                <Show when={option.consequence}>
                  {(consequence) => <span class="ui-decision-option-consequence">{consequence()}</span>}
                </Show>
              </Button>
            )}
          </For>
          <div class="ui-block-actions">
            <For each={view().others}>
              {(action) => (
                <Button
                  type="button"
                  variant={action.style === "ghost" ? "ghost" : "secondary"}
                  size="sm"
                  disabled={locked()}
                  onClick={() => respond(action)}
                >
                  {action.label}
                </Button>
              )}
            </For>
            <Show when={props.busy}>
              <span class="ui-block-sending" role="status">
                <Spinner size="sm" />
                {t("common.sending")}
              </span>
            </Show>
          </div>
        </fieldset>
        <p class="ui-decision-after">{t("uiBlock.decision.after", { name: asker() })}</p>
      </Show>
      <Show when={view().ticket || view().link}>
        {/* Opt-in only: the owner opens it when they want the raw references; it never opens by itself. */}
        <details class="approval-technical ui-decision-technical">
          <summary>{t("uiBlock.decision.technical")}</summary>
          <dl class="ui-block-fields">
            <Show when={view().ticket}>
              {(ticket) => (
                <>
                  <dt>{t("uiBlock.decision.ticket")}</dt>
                  <dd>{ticket()}</dd>
                </>
              )}
            </Show>
            <Show when={view().link}>
              {(link) => (
                <>
                  <dt>{t("uiBlock.decision.address")}</dt>
                  <dd class="ui-decision-address">{link()}</dd>
                </>
              )}
            </Show>
          </dl>
        </details>
      </Show>
    </UiBlockCard>
  );
}
