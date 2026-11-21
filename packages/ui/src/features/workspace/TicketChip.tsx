import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { Ticket } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";

/** A Motion ticket that an agent works on now. */
export interface WorkspaceTicket {
  /** The ticket key, such as `MOT-12`. */
  key: string;
  title: string;
  url: string;
}

/** The ticket an agent works on, as a small link that opens it in Motion. */
export function TicketChip(props: { ticket: WorkspaceTicket; withTitle?: boolean; class?: string }): JSX.Element {
  const { t } = useText();
  return (
    <a
      class={cx("ws-ticket-chip", props.class)}
      href={props.ticket.url}
      target="_blank"
      rel="noopener noreferrer"
      title={t("workspace.ticket.open", { key: props.ticket.key, title: props.ticket.title })}
      aria-label={t("workspace.ticket.open", { key: props.ticket.key, title: props.ticket.title })}
      onClick={(event: MouseEvent) => event.stopPropagation()}
      onPointerDown={(event: PointerEvent) => event.stopPropagation()}
    >
      <Ticket class="ws-ticket-chip-icon" aria-hidden="true" />
      <span class="ws-ticket-chip-key">{props.ticket.key}</span>
      <Show when={props.withTitle && props.ticket.title}>
        <span class="ws-ticket-chip-title">{props.ticket.title}</span>
      </Show>
    </a>
  );
}
