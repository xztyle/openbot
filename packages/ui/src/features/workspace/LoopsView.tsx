import {
  type Loop,
  type LoopDecision,
  type LoopEvent,
  type LoopExperiment,
  type LoopField,
  type LoopItem,
  type LoopStage,
  type LoopValue,
  loopCheckKey,
  loopItemLate,
  loopNextStages,
  type WorkspaceLoopAction,
  type WorkspaceLoopActionResult,
  type WorkspaceLoops,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Badge } from "../../badge";
import { Button } from "../../button";
import { Checkbox } from "../../checkbox";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import {
  ArrowRight,
  Clock,
  FlaskConical,
  History,
  Kanban,
  Lock,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
  X,
} from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { LoopEditor } from "./LoopEditor";
import { GateIcon } from "./LoopGateIcon";
import { MemberAvatar } from "./WorkspaceAvatar";
import { PaneHeaderAction, WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import type { WorkspaceMember } from "./workspace-types";

/** The select value of "no one": a select shows no label for an empty value. */
const NONE = "-";

export interface LoopsViewProps {
  /** Null while the board loads. */
  board: WorkspaceLoops | null;
  loadError?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  /** The agents of the space, for owners and names. */
  agents: readonly WorkspaceMember[];
  /** Runs an action; it throws with the reason when the host refuses. */
  onAction: (action: WorkspaceLoopAction) => Promise<WorkspaceLoopActionResult>;
  /** The reader may change loops and decide gates (the owner or an admin). */
  canEdit: boolean;
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onBack?: (() => void) | undefined;
  /** The loop to show first, such as from a link in Needs you. */
  initialLoopId?: string | undefined;
  /** The decision that a link opened: its card scrolls into view and stands out. */
  focusDecisionId?: string | undefined;
  /** Opens the chat of the space's lead agent, to describe a loop in words instead of the form. */
  onAskLead?: (() => void) | undefined;
  class?: string;
}

/**
 * A number as people type it in a money, number or percent field: "1200", "1,200.50", "1.200,50",
 * "12,5" (the decimal comma of a phone's keypad in many languages), "$49" or "15 %". Null when the
 * text is not one number.
 */
export function loopNumber(text: string): number | null {
  const bare = text.replace(/\s|[$€£%]|usd|eur/giu, "");
  if (!/^-?\d[\d.,]*$/u.test(bare)) return null;
  const comma = bare.lastIndexOf(",");
  const dot = bare.lastIndexOf(".");
  let plain = bare;
  if (comma !== -1 && dot !== -1) {
    // Both marks: the last one is the decimal mark, the other groups thousands.
    const [group, decimal] = comma > dot ? [".", ","] : [",", "."];
    plain = bare.split(group).join("").replace(decimal, ".");
  } else if (comma !== -1) {
    // Only commas: groups of three digits are thousands (1,200), anything else is a decimal comma (12,5).
    plain = /^-?\d{1,3}(,\d{3})+$/u.test(bare) ? bare.replaceAll(",", "") : bare.replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/u.test(bare)) plain = bare.replaceAll(".", "");
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

function valueText(
  field: LoopField | undefined,
  value: LoopValue | undefined,
  format: ReturnType<typeof useText>["format"],
) {
  if (value === undefined || value === "") return "";
  if (typeof value === "number") {
    if (field?.type === "money") return format.currencyUsd(value);
    if (field?.type === "percent") return format.percent(value / 100);
    return format.number(value);
  }
  return value;
}

/**
 * The owner's loops of a space: each item in the column of its stage, the decisions that wait for the
 * owner on top, one item's fields, checklist, experiments and history beside the board, and the editor
 * of the loop's stages. A phone shows one column at a time, chosen with the stage tabs.
 */
export function LoopsView(props: LoopsViewProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [selectedLoopId, setSelectedLoopId] = createSignal<string | null>(props.initialLoopId ?? null);
  const [itemId, setItemId] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<{ loop: Loop | null } | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const [newTitle, setNewTitle] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [phoneStage, setPhoneStage] = createSignal<string | null>(null);
  const [blocked, setBlocked] = createSignal<string[]>([]);
  // The unsaved field values of each item, by item id: another item's panel never shows or saves them.
  const [drafts, setDrafts] = createSignal<Record<string, Record<string, string>>>({});

  const loops = () => props.board?.loops ?? [];
  const loop = createMemo(() => loops().find((candidate) => candidate.id === selectedLoopId()) ?? loops()[0] ?? null);
  const items = createMemo(() => (props.board?.items ?? []).filter((item) => item.loopId === loop()?.id));
  const pending = createMemo(() =>
    (props.board?.decisions ?? []).filter(
      (decision) => decision.status === "pending" && decision.loopId === loop()?.id,
    ),
  );
  const item = createMemo(() => items().find((candidate) => candidate.id === itemId()) ?? null);
  const opened = createMemo(() => {
    const current = loop();
    const entry = item();
    return current && entry ? { loop: current, item: entry } : null;
  });
  const agent = (id: string | undefined) => (id ? props.agents.find((member) => member.id === id) : undefined);

  /** Shows one item, without the answer of the last action on another one. */
  function openItem(id: string | null) {
    setItemId(id);
    setBlocked([]);
    setFormError(null);
  }

  async function run(action: WorkspaceLoopAction): Promise<WorkspaceLoopActionResult | null> {
    setBusy(true);
    setFormError(null);
    try {
      const result = await props.onAction(action);
      setBlocked(result.blocked ?? []);
      return result;
    } catch (error) {
      setFormError(errorMessage(error, t("workspace.loops.failed")));
      return null;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class={cx("ws-view ws-loops", props.class)} aria-label={t("workspace.view.loops")}>
      <WorkspacePaneHeader
        icon={<Kanban aria-hidden="true" />}
        title={t("workspace.view.loops")}
        subtitle={t("workspace.loops.description")}
        onBack={props.onBack}
        actions={
          <Show when={props.canEdit}>
            <PaneHeaderAction label={t("workspace.loops.new")} onClick={() => setCreating(true)} />
          </Show>
        }
      />
      <Show
        when={props.board && loops().length > 0}
        fallback={
          <div class="ws-view-scroll">
            <Show
              when={!props.loadError}
              fallback={
                <ErrorState
                  title={t("workspace.loops.loadFailed")}
                  description={props.loadError}
                  onRetry={props.onRetry}
                />
              }
            >
              <Show when={props.board} fallback={<LoadingState label={t("workspace.view.loops")} />}>
                <EmptyState
                  icon={<Kanban />}
                  title={t("workspace.loops.empty")}
                  description={t("workspace.loops.emptyHint")}
                  action={
                    <Show when={props.canEdit}>
                      <PaneHeaderAction label={t("workspace.loops.new")} onClick={() => setCreating(true)} />
                    </Show>
                  }
                />
              </Show>
            </Show>
          </div>
        }
      >
        <div class="ws-loops-toolbar">
          <nav class="ws-loops-tabs" aria-label={t("workspace.view.loops")}>
            <For each={loops()} keyed={(entry) => entry.id}>
              {(entry) => (
                <Button
                  variant="ghost"
                  class="ws-loops-tab"
                  aria-pressed={entry().id === loop()?.id ? "true" : "false"}
                  onClick={() => {
                    setSelectedLoopId(entry().id);
                    setItemId(null);
                    setPhoneStage(null);
                  }}
                >
                  <span class="ws-truncate">{entry().name}</span>
                  <Show
                    when={(props.board?.decisions ?? []).some(
                      (decision) => decision.loopId === entry().id && decision.status === "pending",
                    )}
                  >
                    <span class="ws-loops-dot" role="img" aria-label={t("workspace.loops.waiting")} />
                  </Show>
                </Button>
              )}
            </For>
          </nav>
          <Show when={props.canEdit && loop()}>
            {(current) => (
              <Button variant="ghost" size="sm" onClick={() => setEditing({ loop: current() })}>
                <Pencil aria-hidden="true" />
                {t("workspace.loops.edit")}
              </Button>
            )}
          </Show>
        </div>
        <Show when={loop()}>
          {(current) => (
            <div class="ws-loops-body">
              <Show when={pending().length > 0}>
                <DecisionList
                  decisions={pending()}
                  items={items()}
                  agent={agent}
                  canEdit={props.canEdit}
                  busy={busy()}
                  onDecide={(decisionId, approve, note) =>
                    void run({ kind: "decide", decisionId, approve, ...(note ? { note } : {}) })
                  }
                  onOpenItem={openItem}
                  focusDecisionId={props.focusDecisionId}
                />
              </Show>
              <Show when={formError() && !item()}>
                <p class="ws-loops-error" role="alert">
                  {formError()}
                </p>
              </Show>
              <div class="ws-loops-stage-picker">
                <For each={current().stages} keyed={(stage) => stage.id}>
                  {(stage) => (
                    <Button
                      variant="ghost"
                      class="ws-loops-tab"
                      aria-pressed={(phoneStage() ?? current().stages[0]?.id) === stage().id ? "true" : "false"}
                      onClick={() => setPhoneStage(stage().id)}
                    >
                      {stage().name}
                      <span class="ws-loops-count">
                        {items().filter((entry) => entry.stageId === stage().id).length}
                      </span>
                    </Button>
                  )}
                </For>
              </div>
              <div class="ws-loops-board">
                <For each={current().stages} keyed={(stage) => stage.id}>
                  {(stage, index) => (
                    <StageColumn
                      loop={current()}
                      stage={stage()}
                      items={items().filter((entry) => entry.stageId === stage().id)}
                      agent={agent}
                      hiddenOnPhone={(phoneStage() ?? current().stages[0]?.id) !== stage().id}
                      selectedItemId={itemId()}
                      onOpen={openItem}
                      onAdd={index() === 0 && props.canEdit ? () => setAdding(true) : undefined}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </Show>
      </Show>
      {/* Keyed by the item: the move note and the panel's scroll are of one item. */}
      <Show when={opened()?.item.id} keyed>
        {(openedId) => (
          <Show when={opened()}>
            {(open) => (
              <ItemPanel
                loop={open().loop}
                item={open().item}
                draft={drafts()[openedId] ?? {}}
                onDraft={(draft) => setDrafts((current) => ({ ...current, [openedId]: draft }))}
                experiments={(props.board?.experiments ?? []).filter((experiment) => experiment.itemId === itemId())}
                events={(props.board?.events ?? []).filter((event) => event.itemId === itemId())}
                decisions={(props.board?.decisions ?? []).filter((decision) => decision.itemId === itemId())}
                agents={props.agents}
                agent={agent}
                canEdit={props.canEdit}
                busy={busy()}
                error={formError()}
                blocked={blocked()}
                onAction={run}
                onOpenAgent={props.onOpenAgent}
                onClose={() => openItem(null)}
              />
            )}
          </Show>
        )}
      </Show>
      <FormDialog
        open={adding()}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(false);
            setNewTitle("");
            setFormError(null);
          }
        }}
        title={t("workspace.loops.addItem")}
        size="sm"
        busy={busy()}
        error={formError()}
        submitLabel={t("workspace.loops.addItem")}
        submitDisabled={newTitle().trim() === ""}
        onSubmit={() => {
          const current = loop();
          if (!current) return;
          void run({ kind: "save-item", loopId: current.id, title: newTitle().trim() }).then((result) => {
            if (!result) return;
            setAdding(false);
            setNewTitle("");
            if (result.createdId) setItemId(result.createdId);
          });
        }}
      >
        <Field label={t("workspace.loops.itemTitle")} required>
          <Input value={newTitle()} onInput={(event) => setNewTitle(event.currentTarget.value)} />
        </Field>
      </FormDialog>
      <FormDialog
        open={creating()}
        onOpenChange={(open) => {
          if (!open) setCreating(false);
        }}
        title={t("workspace.loops.new")}
        description={t("workspace.loops.newHint")}
        size="md"
        busy={busy()}
        error={formError()}
        submitLabel={t("workspace.loops.blank")}
        onSubmit={() => {
          setCreating(false);
          setEditing({ loop: null });
        }}
      >
        <Show when={(props.board?.templates ?? []).length === 0}>
          <p class="ws-loops-templates-empty">{t("workspace.loops.noTemplates")}</p>
        </Show>
        <Show when={props.onAskLead}>
          {(ask) => (
            <Button
              variant="secondary"
              class="ws-loops-ask-lead"
              onClick={() => {
                setCreating(false);
                ask()();
              }}
            >
              <MessageSquare aria-hidden="true" />
              {t("workspace.loops.askLead")}
            </Button>
          )}
        </Show>
        <div class="ws-loops-templates">
          <For each={props.board?.templates ?? []} keyed={(template) => template.id}>
            {(template) => (
              <Button
                variant="ghost"
                class="ws-loops-template"
                disabled={busy()}
                onClick={() => {
                  const spaceId = props.board?.spaceId;
                  if (!spaceId) return;
                  void run({ kind: "create-loop", spaceId, templateId: template().id }).then((result) => {
                    if (!result) return;
                    setCreating(false);
                    if (result.createdId) setSelectedLoopId(result.createdId);
                  });
                }}
              >
                <strong>{template().name}</strong>
                <span>{template().description}</span>
                <span class="ws-loops-template-stages">{template().stageNames.join(" → ")}</span>
              </Button>
            )}
          </For>
        </div>
      </FormDialog>
      <Show when={editing()}>
        {(target) => (
          <LoopEditor
            loop={target().loop}
            agents={props.agents}
            busy={busy()}
            error={formError()}
            onCancel={() => {
              setEditing(null);
              setFormError(null);
            }}
            onSave={(definition) => {
              const current = target().loop;
              const spaceId = props.board?.spaceId;
              const action: WorkspaceLoopAction | null = current
                ? { kind: "update-loop", loopId: current.id, definition }
                : spaceId
                  ? { kind: "create-loop", spaceId, definition }
                  : null;
              if (!action) return;
              void run(action).then((result) => {
                if (!result) return;
                setEditing(null);
                if (result.createdId) setSelectedLoopId(result.createdId);
              });
            }}
            onDelete={
              target().loop === null
                ? undefined
                : () => {
                    const current = target().loop;
                    if (!current) return;
                    void run({ kind: "delete-loop", loopId: current.id }).then((result) => {
                      if (result) {
                        setEditing(null);
                        setSelectedLoopId(null);
                      }
                    });
                  }
            }
          />
        )}
      </Show>
    </section>
  );
}

function StageColumn(props: {
  loop: Loop;
  stage: LoopStage;
  items: readonly LoopItem[];
  agent: (id: string | undefined) => WorkspaceMember | undefined;
  hiddenOnPhone: boolean;
  selectedItemId: string | null;
  onOpen: (itemId: string) => void;
  onAdd?: (() => void) | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const owner = () => props.agent(props.stage.ownerAgentId);
  const cardFields = () => props.loop.fields.filter((field) => field.card);
  const now = Date.now();
  return (
    <section
      class={cx(
        "ws-loops-column",
        props.stage.outcome && "ws-loops-column-end",
        props.hiddenOnPhone && "ws-loops-phone-hidden",
      )}
      aria-label={props.stage.name}
    >
      <header class="ws-loops-column-head">
        <div class="ws-loops-column-title">
          <Show when={props.stage.gate}>
            {(gate) => (
              <span class="ws-loops-gate" title={t(`workspace.loops.gate.${gate().kind}`)}>
                <GateIcon kind={gate().kind} />
              </span>
            )}
          </Show>
          <span class="ws-truncate">{props.stage.name}</span>
          <span class="ws-loops-count">{props.items.length}</span>
        </div>
        <Show when={owner() ?? props.stage.ownerRole}>
          <div class="ws-loops-owner">
            <Show when={owner()} fallback={<span class="ws-truncate">{props.stage.ownerRole}</span>}>
              {(member) => (
                <>
                  <MemberAvatar member={member()} size="xs" />
                  <span class="ws-truncate">{member().name}</span>
                </>
              )}
            </Show>
          </div>
        </Show>
      </header>
      <div class="ws-loops-cards">
        <For each={props.items} keyed={(entry) => entry.id}>
          {(entry) => (
            <Button
              variant="ghost"
              class="ws-loops-card"
              aria-current={props.selectedItemId === entry().id ? "true" : undefined}
              onClick={() => props.onOpen(entry().id)}
            >
              <span class="ws-loops-card-title">{entry().title}</span>
              <span class="ws-loops-card-fields">
                <For each={cardFields()} keyed={(field) => field.key}>
                  {(field) => (
                    <Show when={valueText(field(), entry().values[field().key], format)}>
                      {(text) => (
                        <span class="ws-loops-card-field">
                          <span class="ws-loops-muted">{field().label}</span> {text()}
                        </span>
                      )}
                    </Show>
                  )}
                </For>
              </span>
              <span class="ws-loops-card-badges">
                <Show when={entry().pendingDecisionId}>
                  <Badge variant="warning-light">
                    <Lock aria-hidden="true" />
                    {t("workspace.loops.waiting")}
                  </Badge>
                </Show>
                <Show when={loopItemLate(props.stage, entry(), now)}>
                  <Badge variant="destructive-light">
                    <Clock aria-hidden="true" />
                    {t("workspace.loops.late")}
                  </Badge>
                </Show>
                <Show when={props.agent(entry().ownerAgentId)}>
                  {(member) => <MemberAvatar member={member()} size="xs" />}
                </Show>
              </span>
            </Button>
          )}
        </For>
        <Show when={props.onAdd}>
          {(add) => (
            <Button variant="ghost" size="sm" class="ws-loops-add" onClick={() => add()()}>
              <Plus aria-hidden="true" />
              {t("workspace.loops.addItem")}
            </Button>
          )}
        </Show>
      </div>
    </section>
  );
}

function DecisionList(props: {
  decisions: readonly LoopDecision[];
  items: readonly LoopItem[];
  agent: (id: string | undefined) => WorkspaceMember | undefined;
  canEdit: boolean;
  busy: boolean;
  focusDecisionId?: string | undefined;
  onDecide: (decisionId: string, approve: boolean, note: string) => void;
  onOpenItem: (itemId: string) => void;
}): JSX.Element {
  const { t } = useText();
  return (
    <section class="ws-loops-decisions" aria-label={t("workspace.loops.decisions")}>
      <h3 class="ws-loops-heading">{t("workspace.loops.decisions")}</h3>
      <For each={props.decisions} keyed={(decision) => decision.id}>
        {(decision) => (
          <DecisionCard decision={decision()} {...props} focused={decision().id === props.focusDecisionId} />
        )}
      </For>
    </section>
  );
}

/** One decision that waits for the owner: what, how much, who asks, and Approve or Reject with a note. */
export function DecisionCard(props: {
  decision: LoopDecision;
  agent: (id: string | undefined) => WorkspaceMember | undefined;
  canEdit: boolean;
  busy: boolean;
  onDecide: (decisionId: string, approve: boolean, note: string) => void;
  onOpenItem?: ((itemId: string) => void) | undefined;
  /** The loop's name, where the card shows outside its loop. */
  loopName?: string | undefined;
  /** A link opened this decision. */
  focused?: boolean | undefined;
}): JSX.Element {
  const { t, format } = useText();
  const [note, setNote] = createSignal("");
  const requester = () => props.agent(props.decision.requestedBy);
  const question = () => props.decision.subject === "question";
  return (
    <article
      class={cx("ws-loops-decision", `ws-loops-decision-${props.decision.kind}`)}
      data-focused={props.focused ? "" : undefined}
      ref={(element) => {
        // A link from Today or Needs you opened this decision: show it.
        if (props.focused) requestAnimationFrame(() => element.scrollIntoView({ block: "center" }));
      }}
    >
      <div class="ws-loops-decision-head">
        <span class="ws-loops-gate">
          <GateIcon kind={props.decision.kind} />
        </span>
        <div class="ws-loops-decision-text">
          <Button
            variant="link"
            size="xs"
            class="ws-loops-link"
            onClick={() => props.onOpenItem?.(props.decision.itemId)}
          >
            {props.decision.title}
          </Button>
          <span class="ws-loops-muted">
            {[
              props.loopName,
              t(question() ? "workspace.loops.question" : `workspace.loops.gate.${props.decision.kind}`),
              requester()?.name,
              format.date(props.decision.createdAt, { dateStyle: "medium", timeStyle: "short" }),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        <Show when={props.decision.amountUsd !== undefined}>
          <strong class="ws-loops-amount">{format.currencyUsd(props.decision.amountUsd ?? 0)}</strong>
        </Show>
      </div>
      <Show when={props.decision.detail}>
        <p class="ws-loops-decision-detail">{props.decision.detail}</p>
      </Show>
      <Show when={props.canEdit}>
        <div class="ws-loops-decision-actions">
          <Input
            size="sm"
            value={note()}
            placeholder={t(question() ? "workspace.loops.answerPlaceholder" : "workspace.loops.notePlaceholder")}
            onInput={(event) => setNote(event.currentTarget.value)}
          />
          <Show
            when={!question()}
            fallback={
              <Button
                size="sm"
                disabled={props.busy || note().trim() === ""}
                onClick={() => props.onDecide(props.decision.id, true, note().trim())}
              >
                {t("workspace.loops.answer")}
              </Button>
            }
          >
            <Button
              size="sm"
              variant="outline"
              disabled={props.busy}
              onClick={() => props.onDecide(props.decision.id, false, note().trim())}
            >
              {t("workspace.loops.reject")}
            </Button>
            <Button
              size="sm"
              disabled={props.busy}
              onClick={() => props.onDecide(props.decision.id, true, note().trim())}
            >
              {t("workspace.loops.approve")}
            </Button>
          </Show>
        </div>
      </Show>
    </article>
  );
}

function ItemPanel(props: {
  loop: Loop;
  item: LoopItem;
  experiments: readonly LoopExperiment[];
  events: readonly LoopEvent[];
  decisions: readonly LoopDecision[];
  agents: readonly WorkspaceMember[];
  agent: (id: string | undefined) => WorkspaceMember | undefined;
  canEdit: boolean;
  busy: boolean;
  error: string | null;
  blocked: readonly string[];
  /** The values typed and not saved yet, as text by field key. */
  draft: Readonly<Record<string, string>>;
  onDraft: (draft: Record<string, string>) => void;
  onAction: (action: WorkspaceLoopAction) => Promise<WorkspaceLoopActionResult | null>;
  onOpenAgent?: ((agentId: string) => void) | undefined;
  onClose: () => void;
}): JSX.Element {
  const { t, format } = useText();
  const draft = () => props.draft;
  const [moveNote, setMoveNote] = createSignal("");
  const stage = () => props.loop.stages.find((candidate) => candidate.id === props.item.stageId);
  const next = () => {
    const current = stage();
    return current ? loopNextStages(props.loop, current) : [];
  };
  const earlier = () => {
    const index = props.loop.stages.findIndex((candidate) => candidate.id === props.item.stageId);
    return props.loop.stages.slice(0, Math.max(index, 0)).filter((candidate) => !candidate.outcome);
  };
  const stageName = (id: string | undefined) =>
    props.loop.stages.find((candidate) => candidate.id === id)?.name ?? id ?? "";
  const changed = () => Object.keys(draft()).length > 0;
  const [notNumbers, setNotNumbers] = createSignal<string[]>([]);

  function save() {
    const values: Record<string, LoopValue | null> = {};
    const wrong: string[] = [];
    for (const [key, text] of Object.entries(draft())) {
      const field = props.loop.fields.find((candidate) => candidate.key === key);
      const trimmed = text.trim();
      const numeric = field && field.type !== "text" && field.type !== "url" && field.type !== "date";
      const number = numeric && trimmed !== "" ? loopNumber(trimmed) : null;
      // A money or number field keeps a number, never text: gates read amounts and exit metrics compare them.
      if (numeric && trimmed !== "" && number === null) wrong.push(field.label);
      values[key] = trimmed === "" ? null : (number ?? trimmed);
    }
    setNotNumbers(wrong);
    if (wrong.length > 0) return;
    void props.onAction({ kind: "save-item", loopId: props.loop.id, itemId: props.item.id, values }).then((result) => {
      if (result) props.onDraft({});
    });
  }

  function move(toStageId: string, force = false) {
    void props
      .onAction({
        kind: "move-item",
        itemId: props.item.id,
        toStageId,
        ...(moveNote().trim() ? { note: moveNote().trim() } : {}),
        ...(force ? { force: true } : {}),
      })
      .then((result) => {
        if (result && !result.blocked?.length) setMoveNote("");
      });
  }

  return (
    <aside class="ws-loops-panel" aria-label={props.item.title}>
      <WorkspacePaneHeader
        title={props.item.title}
        subtitle={stage()?.name}
        onClose={props.onClose}
        onBack={props.onClose}
      />
      <div class="ws-loops-panel-scroll">
        <Show when={props.error}>
          <p class="ws-loops-error" role="alert">
            {props.error}
          </p>
        </Show>
        <Show when={props.canEdit}>
          <Field label={t("workspace.loops.owner")}>
            <WorkspaceSelect
              label={t("workspace.loops.owner")}
              value={props.item.ownerAgentId ?? NONE}
              options={[
                { value: NONE, label: t("workspace.loops.noOwner") },
                ...props.agents.map((member) => ({ value: member.id, label: member.name })),
              ]}
              onChange={(ownerAgentId) =>
                void props.onAction({
                  kind: "save-item",
                  loopId: props.loop.id,
                  itemId: props.item.id,
                  ownerAgentId: ownerAgentId === NONE ? null : ownerAgentId,
                })
              }
            />
          </Field>
        </Show>
        <section class="ws-loops-section">
          <h3 class="ws-loops-heading">{t("workspace.loops.fields")}</h3>
          <div class="ws-loops-fields">
            <For each={props.loop.fields} keyed={(field) => field.key}>
              {(field) => (
                <Field label={field().label}>
                  <Show
                    when={props.canEdit}
                    fallback={<span>{valueText(field(), props.item.values[field().key], format) || "—"}</span>}
                  >
                    <Input
                      value={draft()[field().key] ?? String(props.item.values[field().key] ?? "")}
                      inputmode={field().type === "text" || field().type === "url" ? undefined : "decimal"}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        props.onDraft({ ...props.draft, [field().key]: value });
                      }}
                    />
                  </Show>
                </Field>
              )}
            </For>
          </div>
          <Show when={notNumbers().length > 0}>
            <p class="ws-loops-error" role="alert">
              {t("workspace.loops.notNumber", { fields: notNumbers().join(", ") })}
            </p>
          </Show>
          <Show when={props.canEdit && changed()}>
            <div class="ws-loops-row">
              <Button size="sm" disabled={props.busy} onClick={save}>
                {t("workspace.loops.save")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  props.onDraft({});
                  setNotNumbers([]);
                }}
              >
                {t("workspace.loops.cancel")}
              </Button>
            </div>
          </Show>
        </section>
        <Show when={stage()}>
          {(current) => (
            <section class="ws-loops-section">
              <h3 class="ws-loops-heading">{t("workspace.loops.exit", { stage: current().name })}</h3>
              <Show when={current().description}>
                <p class="ws-loops-muted">{current().description}</p>
              </Show>
              <For
                each={(current().checklist ?? []).map((text, index) => ({
                  text,
                  key: loopCheckKey(current().id, index),
                }))}
                keyed={(entry) => entry.key}
              >
                {(entry) => (
                  <label class="ws-loops-check" for={`loop-check-${props.item.id}-${entry().key}`}>
                    <Checkbox
                      id={`loop-check-${props.item.id}-${entry().key}`}
                      checked={props.item.checks.includes(entry().key)}
                      disabled={!props.canEdit || props.busy}
                      onChange={(event) =>
                        void props.onAction({
                          kind: "check",
                          itemId: props.item.id,
                          check: entry().key,
                          done: event.currentTarget.checked,
                        })
                      }
                    />
                    <span>{entry().text}</span>
                  </label>
                )}
              </For>
              <For each={current().exitMetrics ?? []} keyed={(rule) => `${rule.field}${rule.op}${rule.value}`}>
                {(rule) => (
                  <p class="ws-loops-metric">
                    {props.loop.fields.find((field) => field.key === rule().field)?.label ?? rule().field} {rule().op}{" "}
                    {rule().value}
                  </p>
                )}
              </For>
              <Show when={props.blocked.length > 0}>
                <div class="ws-loops-blocked" role="alert">
                  <strong>{t("workspace.loops.blocked")}</strong>
                  <ul>
                    <For each={props.blocked} keyed={(reason) => reason}>
                      {(reason) => <li>{reason()}</li>}
                    </For>
                  </ul>
                </div>
              </Show>
              <Show when={props.canEdit && (next().length > 0 || earlier().length > 0)}>
                <Input
                  size="sm"
                  value={moveNote()}
                  placeholder={t("workspace.loops.moveNote")}
                  onInput={(event) => setMoveNote(event.currentTarget.value)}
                />
                <div class="ws-loops-row ws-loops-wrap">
                  <For each={next()} keyed={(target) => target.id}>
                    {(target) => (
                      <Button
                        size="sm"
                        variant={target().outcome ? "outline" : "default"}
                        disabled={props.busy || Boolean(props.item.pendingDecisionId)}
                        onClick={() => move(target().id)}
                      >
                        <ArrowRight aria-hidden="true" />
                        {target().name}
                      </Button>
                    )}
                  </For>
                  <Show when={props.blocked.length > 0 && next()[0]}>
                    {(target) => (
                      <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => move(target().id, true)}>
                        {t("workspace.loops.force", { stage: target().name })}
                      </Button>
                    )}
                  </Show>
                  <For each={earlier()} keyed={(target) => target.id}>
                    {(target) => (
                      <Button size="sm" variant="ghost" disabled={props.busy} onClick={() => move(target().id)}>
                        {t("workspace.loops.back", { stage: target().name })}
                      </Button>
                    )}
                  </For>
                </div>
              </Show>
            </section>
          )}
        </Show>
        <section class="ws-loops-section">
          <h3 class="ws-loops-heading">
            <FlaskConical aria-hidden="true" />
            {t("workspace.loops.experiments")}
          </h3>
          <Show
            when={props.experiments.length > 0}
            fallback={<p class="ws-loops-muted">{t("workspace.loops.noExperiments")}</p>}
          >
            <For each={props.experiments} keyed={(experiment) => experiment.id}>
              {(experiment) => (
                <article class="ws-loops-experiment">
                  <div class="ws-loops-row">
                    <strong class="ws-truncate">{experiment().title}</strong>
                    <Badge
                      variant={
                        experiment().status === "done"
                          ? "success-light"
                          : experiment().status === "proposed"
                            ? "warning-light"
                            : "secondary"
                      }
                    >
                      {t(`workspace.loops.experiment.${experiment().status}`)}
                    </Badge>
                  </div>
                  <p class="ws-loops-muted">{experiment().hypothesis}</p>
                  <p class="ws-loops-muted">
                    {[
                      experiment()
                        .variants.map((variant) => variant.name)
                        .join(" / "),
                      experiment().metric,
                      format.currencyUsd(experiment().budgetUsd),
                      t("workspace.loops.days", { count: experiment().durationDays }),
                    ].join(" · ")}
                  </p>
                  <Show when={experiment().winner || experiment().result}>
                    <p>
                      <Show when={experiment().winner}>
                        <strong>{t("workspace.loops.winner", { name: experiment().winner ?? "" })}</strong>{" "}
                      </Show>
                      {experiment().result}
                    </p>
                  </Show>
                  <Show
                    when={props.canEdit && (experiment().status === "running" || experiment().status === "approved")}
                  >
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() =>
                        void props.onAction({
                          kind: "update-experiment",
                          experimentId: experiment().id,
                          status: "cancelled",
                        })
                      }
                    >
                      <X aria-hidden="true" />
                      {t("workspace.loops.cancelExperiment")}
                    </Button>
                  </Show>
                </article>
              )}
            </For>
          </Show>
        </section>
        <section class="ws-loops-section">
          <h3 class="ws-loops-heading">
            <History aria-hidden="true" />
            {t("workspace.loops.history")}
          </h3>
          <ol class="ws-loops-history">
            <For each={props.events} keyed={(event) => event.id}>
              {(event) => (
                <li>
                  <span class="ws-loops-muted">
                    {format.date(event().at, { dateStyle: "short", timeStyle: "short" })}
                  </span>{" "}
                  <Show when={event().actorKind === "agent" ? props.agent(event().actorId) : undefined}>
                    {(member) => (
                      <Button
                        variant="link"
                        size="xs"
                        class="ws-loops-link"
                        onClick={() => props.onOpenAgent?.(member().id)}
                      >
                        {member().name}
                      </Button>
                    )}
                  </Show>
                  <Show when={event().actorKind === "person"}>{t("workspace.loops.you")}</Show>{" "}
                  <Show when={event().kind === "moved"} fallback={event().text}>
                    {t("workspace.loops.moved", { from: stageName(event().from), to: stageName(event().to) })}
                    <Show when={event().text}>{`. ${event().text}`}</Show>
                  </Show>
                </li>
              )}
            </For>
          </ol>
        </section>
        <Show when={props.canEdit}>
          <Button
            size="sm"
            variant="destructive-ghost"
            onClick={() =>
              void props
                .onAction({ kind: "remove-item", itemId: props.item.id })
                .then((result) => result && props.onClose())
            }
          >
            <Trash2 aria-hidden="true" />
            {t("workspace.loops.removeItem")}
          </Button>
        </Show>
      </div>
    </aside>
  );
}

/** A loop item's stage name, for a card outside the board. */
export function loopStageName(loop: Loop | undefined, stageId: string | undefined): string {
  return loop?.stages.find((stage) => stage.id === stageId)?.name ?? "";
}
