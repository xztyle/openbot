import {
  type ChatCard,
  type ChatCardAnswer,
  type ChatCardSpec,
  chatCardAnswerText,
} from "@openbot/contracts/portfolio";
import {
  UI_BLOCK_SUBMIT_ACTION_ID,
  UI_CHOICE_VALUES_KEY,
  type UiBlockResponse,
  type UiBlockSpec,
  type UiBlockState,
} from "@openbot/contracts/ui-blocks";
import { Button, Check, Spinner, X } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../../text";
import { UiBlockCard } from "./UiBlockCard";
import { UiBlockingBlock } from "./UiBlockingBlock";

const APPROVE_ACTION = "approve";
const REJECT_ACTION = "reject";

export interface ChatCardBlockProps {
  card: ChatCard;
  /** The reader may not answer: the card shows, its controls do not work. */
  disabled?: boolean | undefined;
  busy?: boolean | undefined;
  error?: string | undefined;
  onAnswer: (answer: ChatCardAnswer) => void;
}

/** The card as the matching blocking block draws it, for every type but a table. */
function blockSpec(
  spec: Exclude<ChatCardSpec, { type: "table" }>,
  labels: { submit: string; approve: string; reject: string },
): UiBlockSpec {
  switch (spec.type) {
    case "choice":
      return {
        type: "choice",
        title: spec.title,
        ...(spec.multiple ? { multiple: true } : {}),
        options: spec.options.map((option) => ({
          id: option.id,
          label: option.label,
          ...(option.detail ? { meta: option.detail.slice(0, 60) } : {}),
        })),
        submit: labels.submit,
      };
    case "approve":
      return {
        type: "confirm",
        title: spec.title,
        ...(spec.detail ? { preview: spec.detail } : {}),
        actions: [
          { id: APPROVE_ACTION, label: spec.approveLabel ?? labels.approve, style: "primary" },
          { id: REJECT_ACTION, label: spec.rejectLabel ?? labels.reject, style: "secondary" },
        ],
      };
    case "form":
      return {
        type: "form",
        title: spec.title,
        fields: spec.fields.map((field) =>
          field.kind === "select" && field.options
            ? {
                id: field.id,
                kind: "select",
                label: field.label,
                options: field.options,
                ...(field.required ? { required: true } : {}),
              }
            : { id: field.id, kind: "text", label: field.label, ...(field.required ? { required: true } : {}) },
        ),
        ...(spec.submitLabel ? { submit: spec.submitLabel } : {}),
      };
  }
}

/** The stored answer as the blocking block's response, so a frozen card shows what was chosen. */
function blockResponse(spec: ChatCardSpec, answer: ChatCardAnswer | undefined): UiBlockResponse | undefined {
  if (!answer) return undefined;
  if (spec.type === "choice")
    return { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values: { [UI_CHOICE_VALUES_KEY]: answer.selected ?? [] } };
  if (spec.type === "approve") return { actionId: answer.approved ? APPROVE_ACTION : REJECT_ACTION };
  if (spec.type === "form") return { actionId: UI_BLOCK_SUBMIT_ACTION_ID, values: { ...answer.values } };
  return undefined;
}

function cardAnswer(spec: ChatCardSpec, response: UiBlockResponse): ChatCardAnswer | null {
  if (spec.type === "choice") {
    const selected = response.values?.[UI_CHOICE_VALUES_KEY];
    return Array.isArray(selected) && selected.length > 0 ? { selected } : null;
  }
  if (spec.type === "approve") return { approved: response.actionId === APPROVE_ACTION };
  if (spec.type === "form") {
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.values ?? {}))
      if (typeof value === "string" && value.trim()) values[key] = value.trim();
    return { values };
  }
  return null;
}

function cardState(card: ChatCard): UiBlockState {
  const status = card.status === "open" ? "pending" : card.status;
  const response = blockResponse(card.spec, card.answer);
  return {
    status,
    ...(response ? { response } : {}),
    ...(card.answer ? { outcome: chatCardAnswerText(card.spec, card.answer) } : {}),
  };
}

/**
 * A card that an agent posted with `post_card`. A choice, an approve or reject and a form draw as the
 * matching blocking block; a table draws its rows with a decision per row, or a pick. The answer goes
 * to `onAnswer`; the host keeps the card and gives the answer to the agent as a message.
 */
export function ChatCardBlock(props: ChatCardBlockProps) {
  const { t } = useText();
  return (
    <Show
      when={props.card.spec.type !== "table" && props.card.spec}
      fallback={
        <Show when={props.card.spec.type === "table" && props.card.spec} keyed>
          {(spec) => <ChatCardTable {...props} spec={spec} />}
        </Show>
      }
      keyed
    >
      {(spec) => (
        <div class="chat-card-block">
          <Show when={spec.type !== "approve" && spec.detail}>
            <p class="chat-card-detail">{spec.detail}</p>
          </Show>
          <UiBlockingBlock
            spec={blockSpec(spec, {
              submit: t("uiBlock.choice.submit"),
              approve: t("portfolio.card.approve"),
              reject: t("portfolio.card.reject"),
            })}
            state={cardState(props.card)}
            disabled={props.disabled}
            busy={props.busy}
            error={props.error}
            onRespond={(response) => {
              const answer = cardAnswer(spec, response);
              if (answer) props.onAnswer(answer);
            }}
          />
        </div>
      )}
    </Show>
  );
}

function ChatCardTable(props: ChatCardBlockProps & { spec: Extract<ChatCardSpec, { type: "table" }> }) {
  const { t } = useText();
  const frozen = () => props.card.status !== "open";
  const locked = () => frozen() || props.disabled === true || props.busy === true;
  const [rows, setRows] = createSignal<Record<string, "approve" | "reject">>({});
  const [picked, setPicked] = createSignal<string[]>([]);
  const decided = (rowId: string) => (frozen() ? props.card.answer?.rows?.[rowId] : rows()[rowId]);
  const isPicked = (rowId: string) => (frozen() ? (props.card.answer?.selected ?? []) : picked()).includes(rowId);
  const each = () => props.spec.mode === "approve-each";
  const ready = () => (each() ? props.spec.rows.every((row) => rows()[row.id] !== undefined) : picked().length > 0);
  const decide = (rowId: string, decision: "approve" | "reject") => {
    if (!locked()) setRows((current) => ({ ...current, [rowId]: decision }));
  };
  const pick = (rowId: string) => {
    if (locked()) return;
    if (props.spec.mode === "pick-one") setPicked([rowId]);
    else setPicked((current) => (current.includes(rowId) ? current.filter((id) => id !== rowId) : [...current, rowId]));
  };
  const setAll = (decision: "approve" | "reject") => {
    if (!locked()) setRows(Object.fromEntries(props.spec.rows.map((row) => [row.id, decision])));
  };
  const submit = () => {
    if (locked() || !ready()) return;
    props.onAnswer(
      each()
        ? { rows: rows() }
        : { selected: props.spec.rows.filter((row) => picked().includes(row.id)).map((row) => row.id) },
    );
  };
  const status = () => (props.card.status === "open" ? "pending" : props.card.status);
  return (
    <UiBlockCard
      class="chat-card-table"
      title={props.spec.title}
      subtitle={props.spec.detail}
      status={status()}
      outcome={props.card.answer ? chatCardAnswerText(props.spec, props.card.answer) : undefined}
      busy={props.busy}
      error={props.error}
    >
      <ul class="chat-card-rows" aria-label={props.spec.title}>
        <For each={props.spec.rows}>
          {(row) => (
            <li class="chat-card-row" data-decision={decided(row.id)} data-picked={isPicked(row.id) ? "" : undefined}>
              <dl class="chat-card-cells">
                <For each={row.cells}>
                  {(cell, index) => (
                    <div class="chat-card-cell" data-first={index() === 0 ? "" : undefined}>
                      <dt>{props.spec.columns[index()]}</dt>
                      <dd>{cell}</dd>
                    </div>
                  )}
                </For>
              </dl>
              <div class="chat-card-row-actions">
                <Show
                  when={each()}
                  fallback={
                    <Button
                      type="button"
                      size="sm"
                      variant={isPicked(row.id) ? "default" : "secondary"}
                      aria-pressed={isPicked(row.id) ? "true" : "false"}
                      disabled={locked()}
                      onClick={() => pick(row.id)}
                    >
                      {isPicked(row.id) ? t("portfolio.card.picked") : t("portfolio.card.pick")}
                    </Button>
                  }
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={decided(row.id) === "approve" ? "default" : "secondary"}
                    aria-pressed={decided(row.id) === "approve" ? "true" : "false"}
                    aria-label={t("portfolio.card.approveRow", { row: row.cells[0] ?? row.id })}
                    disabled={locked()}
                    onClick={() => decide(row.id, "approve")}
                  >
                    <Check aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={decided(row.id) === "reject" ? "destructive" : "secondary"}
                    aria-pressed={decided(row.id) === "reject" ? "true" : "false"}
                    aria-label={t("portfolio.card.rejectRow", { row: row.cells[0] ?? row.id })}
                    disabled={locked()}
                    onClick={() => decide(row.id, "reject")}
                  >
                    <X aria-hidden="true" />
                  </Button>
                </Show>
              </div>
            </li>
          )}
        </For>
      </ul>
      <Show when={!frozen()}>
        <div class="ui-block-actions">
          <Button type="button" disabled={locked() || !ready()} onClick={submit}>
            {t("portfolio.card.send")}
          </Button>
          <Show when={each()}>
            <Button type="button" variant="ghost" size="sm" disabled={locked()} onClick={() => setAll("approve")}>
              {t("portfolio.card.approveAll")}
            </Button>
          </Show>
          <Show when={props.busy}>
            <span class="ui-block-sending" role="status">
              <Spinner size="sm" />
              {t("common.sending")}
            </span>
          </Show>
        </div>
      </Show>
    </UiBlockCard>
  );
}
