import { Dynamic, type JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, buttonVariants } from "../../button";
import { DropdownMenu } from "../../complex";
import { Input } from "../../form";
import { CircleQuestionMark, Clock3, ExternalLink, Globe2, Info, Moon, Send, Settings, ShieldCheck } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MemberAvatar } from "./WorkspaceAvatar";
import { useRecentTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

/** What a held request asks for, as `OwnerHeldKind` names it. */
export type WhenBackKind = "question" | "approval" | "takeover" | "fyi";

/** One request that an agent held for the owner, as a row shows it. */
export interface WhenBackRow {
  key: string;
  member: WorkspaceMember;
  kind: WhenBackKind;
  title: string;
  detail?: string | undefined;
  options?: readonly string[] | undefined;
  url?: string | undefined;
  /** Where the work belongs: "in #launch", or "Direct message". */
  where?: string | undefined;
  at: number;
}

/** The owner's answer to a held request. */
export interface WhenBackAnswer {
  choice?: string;
  text?: string;
  decision?: "approve" | "decline" | "done" | "dismiss";
}

const KIND_ICON = {
  question: CircleQuestionMark,
  approval: ShieldCheck,
  takeover: Globe2,
  fyi: Info,
} as const satisfies Record<WhenBackKind, typeof Info>;

export interface WhenBackSectionProps {
  rows: readonly WhenBackRow[];
  onAnswer: (key: string, answer: WhenBackAnswer) => Promise<void>;
  onOpenLink: (url: string) => void;
  /** A line over the list, such as the status of quiet hours with the focus menu. */
  status?: JSX.Element;
  class?: string | undefined;
}

/**
 * "When you're back": the requests that agents held for the owner instead of asking at once. Each one
 * is answered here, in place, and goes back to its agent as a message. Nothing shows when nothing waits,
 * except the status line.
 */
export function WhenBackSection(props: WhenBackSectionProps): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.rows.length > 0 || props.status}>
      <section class={cx("ws-when-back", props.class)} aria-label={t("workspace.away.title")}>
        {props.status}
        <Show when={props.rows.length > 0}>
          <h2 class="ws-when-back-heading">
            <Clock3 class="ws-when-back-icon" aria-hidden="true" />
            {t("workspace.away.count", { count: props.rows.length })}
          </h2>
          <ul class="ws-when-back-list">
            <For each={props.rows} keyed={(row) => row.key}>
              {(row) => <WhenBackItem row={row()} onAnswer={props.onAnswer} onOpenLink={props.onOpenLink} />}
            </For>
          </ul>
        </Show>
      </section>
    </Show>
  );
}

function WhenBackItem(props: {
  row: WhenBackRow;
  onAnswer: WhenBackSectionProps["onAnswer"];
  onOpenLink: (url: string) => void;
}): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  const [busy, setBusy] = createSignal(false);
  const [text, setText] = createSignal("");
  const answer = (value: WhenBackAnswer) => {
    if (busy()) return;
    setBusy(true);
    void props.onAnswer(props.row.key, value).finally(() => setBusy(false));
  };
  const reply = () => {
    const value = text().trim();
    if (!value) return;
    answer(props.row.kind === "approval" ? { decision: "approve", text: value } : { text: value });
  };
  return (
    <li class="ws-when-back-item" data-kind={props.row.kind} aria-busy={busy() ? "true" : undefined}>
      <span class="ws-feed-avatar">
        <MemberAvatar member={props.row.member} size="lg" />
        <span class="ws-feed-kind" data-kind="when-back" aria-hidden="true">
          <Dynamic component={KIND_ICON[props.row.kind]} />
        </span>
      </span>
      <div class="ws-when-back-body">
        <div class="ws-when-back-meta">
          <span class="ws-when-back-name">{props.row.member.name}</span>
          <Show when={props.row.where}>{(where) => <span class="ws-feed-where">{where()}</span>}</Show>
          <span class="ws-when-back-time">{recent(props.row.at)}</span>
        </div>
        <p class="ws-when-back-title">{props.row.title}</p>
        <Show when={props.row.detail}>{(detail) => <p class="ws-when-back-detail">{detail()}</p>}</Show>
        <div class="ws-when-back-actions">
          <Show when={props.row.url}>
            {(url) => (
              <Button variant="outline" size="xs" onClick={() => props.onOpenLink(url())}>
                <ExternalLink aria-hidden="true" />
                {t("workspace.away.openPage")}
              </Button>
            )}
          </Show>
          <Show when={props.row.kind === "question"}>
            <For each={props.row.options ?? []}>
              {(option) => (
                <Button variant="secondary" size="xs" disabled={busy()} onClick={() => answer({ choice: option })}>
                  {option}
                </Button>
              )}
            </For>
          </Show>
          <Show when={props.row.kind === "approval"}>
            <Button variant="default" size="xs" disabled={busy()} onClick={() => answer({ decision: "approve" })}>
              {t("workspace.away.approve")}
            </Button>
            <Button variant="secondary" size="xs" disabled={busy()} onClick={() => answer({ decision: "decline" })}>
              {t("workspace.away.decline")}
            </Button>
          </Show>
          <Show when={props.row.kind === "takeover"}>
            <Button variant="default" size="xs" disabled={busy()} onClick={() => answer({ decision: "done" })}>
              {t("workspace.away.done")}
            </Button>
            <Button variant="secondary" size="xs" disabled={busy()} onClick={() => answer({ decision: "decline" })}>
              {t("workspace.away.cannot")}
            </Button>
          </Show>
          <Button variant="ghost" size="xs" disabled={busy()} onClick={() => answer({ decision: "dismiss" })}>
            {t(props.row.kind === "fyi" ? "workspace.away.gotIt" : "workspace.away.dismiss")}
          </Button>
        </div>
        <Show when={props.row.kind !== "fyi"}>
          <form
            class="ws-when-back-reply"
            onSubmit={(event) => {
              event.preventDefault();
              reply();
            }}
          >
            <Input
              size="sm"
              value={text()}
              maxlength={2000}
              disabled={busy()}
              placeholder={t(
                props.row.kind === "question" ? "workspace.away.answerPlaceholder" : "workspace.away.notePlaceholder",
              )}
              aria-label={t("workspace.away.answerLabel", { name: props.row.member.name })}
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              size="xs"
              disabled={busy() || !text().trim()}
              aria-label={t("workspace.away.send")}
            >
              <Send aria-hidden="true" />
            </Button>
          </form>
        </Show>
      </div>
    </li>
  );
}

/** The owner's quiet time now, as the status line and the focus menu show it. */
export interface AwayQuiet {
  kind: "quiet-hours" | "focus";
  /** The end, as a time to show: "08:00". */
  until: string;
}

export interface FocusMenuProps {
  quiet: AwayQuiet | null;
  /** 60 for an hour, "tomorrow" for the next end of quiet hours, null to end focus. */
  onFocus: (choice: number | "tomorrow" | null) => void;
  onSettings: () => void;
  /** The trigger shows its label too, as on the status line; the top bar shows the moon only. */
  labeled?: boolean | undefined;
  class?: string | undefined;
}

/** The focus menu: an hour, until tomorrow, or off, and the quiet hours settings. */
export function FocusMenu(props: FocusMenuProps): JSX.Element {
  const { t } = useText();
  const label = () =>
    props.quiet
      ? t(props.quiet.kind === "focus" ? "workspace.away.focusUntil" : "workspace.away.quietUntil", {
          time: props.quiet.until,
        })
      : t("workspace.away.focus");
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        class={cx(
          buttonVariants({ variant: props.quiet ? "secondary" : "ghost", size: "sm" }),
          "ws-focus-button",
          props.class,
        )}
        data-on={props.quiet ? "" : undefined}
        aria-label={label()}
        title={label()}
      >
        <Moon aria-hidden="true" />
        <Show when={props.labeled || props.quiet}>
          <span>{label()}</span>
        </Show>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="ui-popover-menu-surface ws-focus-menu">
          <DropdownMenu.Item onSelect={() => props.onFocus(60)}>{t("workspace.away.focusHour")}</DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => props.onFocus("tomorrow")}>
            {t("workspace.away.focusTomorrow")}
          </DropdownMenu.Item>
          <Show when={props.quiet?.kind === "focus"}>
            <DropdownMenu.Item onSelect={() => props.onFocus(null)}>{t("workspace.away.focusOff")}</DropdownMenu.Item>
          </Show>
          <DropdownMenu.Item onSelect={() => props.onSettings()}>
            <Settings aria-hidden="true" />
            {t("workspace.away.settings")}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
