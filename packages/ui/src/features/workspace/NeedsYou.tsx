import { Dynamic, type JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button, buttonVariants } from "../../button";
import { Popover } from "../../complex";
import { CircleQuestionMark, Globe2, Hand, KeyRound, LogIn, ShieldCheck, Ticket } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { useRecentTime } from "./workspace-format";
import type { WorkspaceMember } from "./workspace-types";

/** What a request asks of the user, as `AgentAttentionKind` names it. */
export type NeedsYouKind =
  | "question"
  | "form"
  | "api-key"
  | "approval"
  | "browser-takeover"
  | "sign-in"
  | "secret"
  /** A loop decision: a gate, an experiment budget or an escalated question (`LoopDecision`). */
  | "decision"
  /** A Motion ticket that waits on the reader. */
  | "ticket";

/** One request that waits for the reader, as a row shows it. */
export interface NeedsYouRow {
  key: string;
  /** The agent that asks. */
  member: WorkspaceMember;
  kind: NeedsYouKind;
  /** What the reader does, in a few words: "Sign in on accounts.google.com". */
  action: string;
  /** What the agent asks, when it is safe to show: a question, the title of the tab. */
  summary?: string | undefined;
  /** Where it waits: "Direct message" or "in #launch". */
  where?: string | undefined;
  at: number;
}

const KIND_ICON = {
  question: CircleQuestionMark,
  form: CircleQuestionMark,
  "api-key": KeyRound,
  approval: ShieldCheck,
  "browser-takeover": Globe2,
  "sign-in": LogIn,
  secret: KeyRound,
  decision: ShieldCheck,
  ticket: Ticket,
} as const satisfies Record<NeedsYouKind, typeof Hand>;

export interface NeedsYouListProps {
  rows: readonly NeedsYouRow[];
  onOpen: (key: string) => void;
  /** The accessible name of the list. */
  label?: string | undefined;
  class?: string | undefined;
}

/** The requests that wait for the reader, oldest first. Each row opens the chat that answers it. */
export function NeedsYouList(props: NeedsYouListProps): JSX.Element {
  const { t } = useText();
  const recent = useRecentTime();
  return (
    <WorkspaceList label={props.label ?? t("workspace.needsYou.title")} class={cx("ws-needs-you-list", props.class)}>
      <For each={props.rows} keyed={(row) => row.key}>
        {(row) => (
          <WorkspaceListRow
            unread
            class="ws-needs-you-row"
            onOpen={() => props.onOpen(row().key)}
            label={t("workspace.needsYou.rowLabel", { name: row().member.name, action: row().action })}
            leading={
              <span class="ws-feed-avatar">
                <MemberAvatar member={row().member} size="lg" />
                <span class="ws-feed-kind" data-kind="needs-you" aria-hidden="true">
                  <Dynamic component={KIND_ICON[row().kind]} />
                </span>
              </span>
            }
            title={t("workspace.needsYou.rowTitle", { name: row().member.name })}
            titleEnd={recent(row().at)}
            trailing={<span class="ws-needs-you-open">{t("workspace.needsYou.open")}</span>}
          >
            <span class="ws-needs-you-action">{row().action}</span>
            <Show when={row().summary}>{(summary) => <span class="ws-feed-preview">{summary()}</span>}</Show>
            <Show when={row().where}>{(where) => <span class="ws-feed-where">{where()}</span>}</Show>
          </WorkspaceListRow>
        )}
      </For>
    </WorkspaceList>
  );
}

/** The "Needs you" block at the top of Activity: nothing when nothing waits. */
export function NeedsYouSection(props: NeedsYouListProps): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.rows.length > 0}>
      <section class="ws-needs-you-section" aria-label={t("workspace.needsYou.title")}>
        <h2 class="ws-needs-you-heading">
          <Hand aria-hidden="true" />
          {t("workspace.needsYou.count", { count: props.rows.length })}
        </h2>
        <NeedsYouList {...props} />
      </section>
    </Show>
  );
}

/**
 * The "Needs you" button of the top bar: it shows only while something waits, with the count, and
 * opens the list of the requests. A row opens the chat that answers it.
 */
export function NeedsYouButton(props: NeedsYouListProps): JSX.Element {
  const { t } = useText();
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.rows.length > 0}>
      <Popover.Root modal open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={6}>
        <Popover.Trigger
          class={cx(buttonVariants({ variant: "secondary", size: "sm" }), "ws-needs-you-button")}
          aria-label={t("workspace.needsYou.buttonLabel", { count: props.rows.length })}
        >
          <Hand aria-hidden="true" />
          <span>{t("workspace.needsYou.title")}</span>
          <span class="ws-needs-you-count" aria-hidden="true">
            {Math.min(props.rows.length, 99)}
          </span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content class="ui-popover-menu-surface ws-needs-you-popover">
            <Popover.Title class="ws-needs-you-popover-title">
              {t("workspace.needsYou.count", { count: props.rows.length })}
            </Popover.Title>
            <NeedsYouList
              rows={props.rows}
              label={props.label}
              onOpen={(key) => {
                setOpen(false);
                props.onOpen(key);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Show>
  );
}

/** The chip of the phone's Home: the count of what waits, opening the list. */
export function NeedsYouChip(props: { count: number; onOpen: () => void }): JSX.Element {
  const { t } = useText();
  return (
    <Show when={props.count > 0}>
      <Button
        variant="secondary"
        size="sm"
        class="ws-needs-you-button"
        aria-label={t("workspace.needsYou.buttonLabel", { count: props.count })}
        onClick={() => props.onOpen()}
      >
        <Hand aria-hidden="true" />
        <span>{t("workspace.needsYou.title")}</span>
        <span class="ws-needs-you-count" aria-hidden="true">
          {Math.min(props.count, 99)}
        </span>
      </Button>
    </Show>
  );
}
