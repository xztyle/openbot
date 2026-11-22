import {
  LOOP_FIELD_TYPES,
  LOOP_GATE_KINDS,
  LOOP_METRIC_OPS,
  LOOP_OUTCOMES,
  type Loop,
  type LoopDefinition,
  type LoopField,
  type LoopFieldType,
  type LoopGateKind,
  type LoopMetricOp,
  type LoopMetricRule,
  type LoopOutcome,
  type LoopStage,
  loopNextStages,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show, untrack } from "solid-js";
import { Button, IconButton } from "../../button";
import { Checkbox } from "../../checkbox";
import { Field, Input, Textarea } from "../../form";
import { FormDialog } from "../../form-dialog";
import { ArrowRight, ChevronDown, ChevronUp, Plus, Trash2 } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { createUnsavedGuard, DiscardChangesDialog } from "../settings/unsaved-changes";
import { GateIcon } from "./LoopGateIcon";
import { LOOP_GATE_LABEL, LOOP_OUTCOME_LABEL } from "./loop-labels";
import { WorkspaceSelect } from "./WorkspaceSelect";
import type { WorkspaceMember } from "./workspace-types";

export interface LoopEditorProps {
  /** Null for a new loop. */
  loop: Loop | null;
  agents: readonly WorkspaceMember[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (definition: LoopDefinition) => void;
  onDelete?: (() => void) | undefined;
}

/** The select value of "none": a select shows no label for an empty value. */
const NONE = "-";

/** A new loop: one stage to work in and one end, named in the reader's language. */
function blankLoop(t: ReturnType<typeof useText>["t"]): LoopDefinition {
  return {
    name: "",
    fields: [],
    stages: [
      { id: "start", name: t("workspace.loops.editor.startStage") },
      { id: "done", name: t("workspace.loops.editor.doneStage"), outcome: "done" },
    ],
  };
}

/** The definition that a save sends, with the text fields trimmed. */
function draftOf(loop: LoopDefinition): LoopDefinition {
  return {
    name: loop.name.trim(),
    ...(loop.description?.trim() ? { description: loop.description.trim() } : {}),
    ...(loop.motionProject?.trim() ? { motionProject: loop.motionProject.trim() } : {}),
    stages: loop.stages,
    fields: loop.fields,
  };
}

function slug(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/gu, "")
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 32) || "stage";
  let candidate = /^[a-z0-9]/u.test(base) ? base : `s-${base}`;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

function fieldLines(fields: readonly LoopField[]): string {
  return fields
    .map((field) => [field.key, field.label, field.type, field.card ? "card" : ""].filter(Boolean).join(" | "))
    .join("\n");
}

function parseFields(text: string): LoopField[] {
  return text
    .split("\n")
    .map((line) => line.split("|").map((part) => part.trim()))
    .filter((parts) => parts[0])
    .map(([key = "", label, type, card]) => {
      const cleanKey =
        key
          .toLowerCase()
          .replace(/[^a-z0-9_]/gu, "_")
          .replace(/^[^a-z]+/u, "")
          .slice(0, 40) || "field";
      const fieldType: LoopFieldType = LOOP_FIELD_TYPES.find((candidate) => candidate === type) ?? "text";
      return { key: cleanKey, label: label || key, type: fieldType, ...(card === "card" ? { card: true } : {}) };
    });
}

function metricLines(rules: readonly LoopMetricRule[] | undefined): string {
  return (rules ?? []).map((rule) => `${rule.field} ${rule.op} ${rule.value}`).join("\n");
}

function parseMetric(line: string): LoopMetricRule | null {
  const match = /^\s*([a-z][a-z0-9_]*)\s*(>=|<=|>|<)\s*(-?[0-9.]+)\s*$/u.exec(line);
  const op = LOOP_METRIC_OPS.find((candidate) => candidate === match?.[2]);
  const value = Number(match?.[3]);
  return match?.[1] && op && Number.isFinite(value) ? { field: match[1], op: op satisfies LoopMetricOp, value } : null;
}

function parseMetrics(text: string): LoopMetricRule[] {
  return text.split("\n").flatMap((line) => {
    const rule = parseMetric(line);
    return rule ? [rule] : [];
  });
}

/** The lines of a stage's metrics that are not a rule on one of the loop's fields, as typed. */
function wrongMetrics(text: string, fields: readonly LoopField[]): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const rule = parseMetric(line);
      return !rule || !fields.some((field) => field.key === rule.field);
    });
}

function checklistLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/**
 * The loop editor: the stages as a flow from left to right with their branches, and the selected
 * stage's owner, gate, deadline, checklist, exit metrics, next stages and entry actions; then the
 * loop's fields. Gates stay the owner's: the editor is shown only to the owner and admins.
 */
export function LoopEditor(props: LoopEditorProps): JSX.Element {
  const { t } = useText();
  const idPrefix = createUniqueId();
  // The editor works on a copy of the loop as it opened: a board refresh does not reset what is typed.
  const opened = untrack(() => props.loop);
  const start = opened ?? blankLoop(t);
  const [name, setName] = createSignal(start.name);
  const [description, setDescription] = createSignal(start.description ?? "");
  const [motionProject, setMotionProject] = createSignal(start.motionProject ?? "");
  const [stages, setStages] = createSignal<LoopStage[]>(structuredClone(start.stages));
  const [fields, setFields] = createSignal(fieldLines(start.fields));
  const [selected, setSelected] = createSignal(0);
  const stage = createMemo(() => stages()[selected()]);
  const draft = (): LoopDefinition =>
    draftOf({
      name: name(),
      description: description(),
      motionProject: motionProject(),
      stages: stages(),
      fields: parseFields(fields()),
    });
  // The checklist and metrics of each stage as typed, by stage id: the text keeps its new lines and
  // spaces while the stage keeps the parsed entries, and a metric that is not a rule stays to be fixed.
  const [checklists, setChecklists] = createSignal<Record<string, string>>({});
  const [metrics, setMetrics] = createSignal<Record<string, string>>({});
  const metricsText = (entry: LoopStage) => metrics()[entry.id] ?? metricLines(entry.exitMetrics);
  const wrong = (entry: LoopStage) => wrongMetrics(metricsText(entry), parseFields(fields()));
  const baseline = untrack(() => JSON.stringify(draft()));
  const dirty = () =>
    JSON.stringify(draft()) !== baseline ||
    stages().some((entry) => metrics()[entry.id] !== undefined && wrong(entry).length > 0);
  // Escape, a click outside, the close button and Cancel ask first when something would be lost.
  const guard = createUnsavedGuard({ dirty });

  function change(patch: Partial<LoopStage>, remove: (keyof LoopStage)[] = []) {
    setStages((current) =>
      current.map((entry, index) => {
        if (index !== selected()) return entry;
        const next: LoopStage = { ...entry, ...patch };
        for (const key of remove) delete next[key];
        return next;
      }),
    );
  }

  function addStage() {
    const taken = new Set(stages().map((entry) => entry.id));
    const firstEnd = stages().findIndex((entry) => entry.outcome);
    const at = firstEnd === -1 ? stages().length : firstEnd;
    const created: LoopStage = {
      id: slug(t("workspace.loops.editor.newStage"), taken),
      name: t("workspace.loops.editor.newStage"),
    };
    setStages((current) => [...current.slice(0, at), created, ...current.slice(at)]);
    setSelected(at);
  }

  function moveStage(offset: number) {
    const from = selected();
    const to = from + offset;
    if (to < 0 || to >= stages().length) return;
    setStages((current) => {
      const copy = [...current];
      const [entry] = copy.splice(from, 1);
      if (entry) copy.splice(to, 0, entry);
      return copy;
    });
    setSelected(to);
  }

  function removeStage() {
    const removed = stage();
    if (!removed || stages().length <= 1) return;
    setStages((current) =>
      current
        .filter((_, index) => index !== selected())
        .map((entry) => (entry.next ? { ...entry, next: entry.next.filter((id) => id !== removed.id) } : entry)),
    );
    setSelected(Math.max(0, selected() - 1));
  }

  const agentOptions = () => [
    { value: NONE, label: t("workspace.loops.noOwner") },
    ...props.agents.map((member) => ({ value: member.id, label: member.name })),
  ];
  const gateOptions = () => [
    { value: NONE, label: t("workspace.loops.editor.noGate") },
    ...LOOP_GATE_KINDS.map((kind) => ({ value: kind, label: t(LOOP_GATE_LABEL[kind]) })),
  ];
  const outcomeOptions = () => [
    { value: NONE, label: t("workspace.loops.editor.notEnd") },
    ...LOOP_OUTCOMES.map((outcome) => ({ value: outcome, label: t(LOOP_OUTCOME_LABEL[outcome]) })),
  ];

  return (
    <>
      <FormDialog
        open
        onOpenChange={(open) => {
          if (!open) guard.request(props.onCancel);
        }}
        title={opened ? t("workspace.loops.edit") : t("workspace.loops.new")}
        size="lg"
        busy={props.busy}
        error={props.error}
        submitLabel={t("workspace.loops.save")}
        submitDisabled={
          name().trim() === "" ||
          stages().every((entry) => entry.outcome) ||
          stages().some((entry) => wrong(entry).length > 0)
        }
        onSubmit={() => props.onSave(draft())}
      >
        <Field label={t("workspace.loops.editor.name")} required>
          <Input value={name()} onInput={(event) => setName(event.currentTarget.value)} />
        </Field>
        <Field label={t("workspace.loops.editor.description")}>
          <Textarea rows={2} value={description()} onInput={(event) => setDescription(event.currentTarget.value)} />
        </Field>
        <section class="ws-loops-flow" aria-label={t("workspace.loops.editor.stages")}>
          <For each={stages()} keyed={(entry) => entry.id}>
            {(entry, index) => (
              <>
                <Show when={index() > 0 && !entry().outcome}>
                  <ArrowRight class="ws-loops-flow-arrow" aria-hidden="true" />
                </Show>
                <Button
                  variant="ghost"
                  aria-pressed={selected() === index() ? "true" : "false"}
                  class={cx("ws-loops-flow-stage", entry().outcome && "ws-loops-flow-end")}
                  onClick={() => setSelected(index())}
                >
                  <span class="ws-loops-flow-name">
                    <Show when={entry().gate}>{(gate) => <GateIcon kind={gate().kind} />}</Show>
                    {entry().name}
                  </span>
                  <Show when={entry().next || !entry().outcome}>
                    <span class="ws-loops-flow-next">
                      →{" "}
                      {loopNextStages({ stages: stages() }, entry())
                        .map((target) => target.name)
                        .join(", ") || "—"}
                    </span>
                  </Show>
                </Button>
              </>
            )}
          </For>
          <IconButton variant="ghost" size="icon-sm" label={t("workspace.loops.editor.addStage")} onClick={addStage}>
            <Plus />
          </IconButton>
        </section>
        <Show when={stage()}>
          {(current) => (
            <section class="ws-loops-stage-editor" aria-label={current().name}>
              <div class="ws-loops-row">
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  label={t("workspace.loops.editor.moveLeft")}
                  onClick={() => moveStage(-1)}
                >
                  <ChevronUp />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  label={t("workspace.loops.editor.moveRight")}
                  onClick={() => moveStage(1)}
                >
                  <ChevronDown />
                </IconButton>
                <span class="ws-loops-muted ws-loops-mono">{current().id}</span>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  label={t("workspace.loops.editor.removeStage")}
                  disabled={stages().length <= 1}
                  onClick={removeStage}
                >
                  <Trash2 />
                </IconButton>
              </div>
              <div class="ws-loops-editor-grid">
                <Field label={t("workspace.loops.editor.stageName")} required>
                  <Input value={current().name} onInput={(event) => change({ name: event.currentTarget.value })} />
                </Field>
                <Field label={t("workspace.loops.owner")}>
                  <WorkspaceSelect
                    label={t("workspace.loops.owner")}
                    value={current().ownerAgentId ?? NONE}
                    options={agentOptions()}
                    onChange={(value) =>
                      value !== NONE ? change({ ownerAgentId: value }) : change({}, ["ownerAgentId"])
                    }
                  />
                </Field>
                <Field label={t("workspace.loops.editor.role")}>
                  <Input
                    value={current().ownerRole ?? ""}
                    onInput={(event) =>
                      event.currentTarget.value.trim()
                        ? change({ ownerRole: event.currentTarget.value })
                        : change({}, ["ownerRole"])
                    }
                  />
                </Field>
                <Field label={t("workspace.loops.editor.gate")} description={t("workspace.loops.editor.gateHint")}>
                  <WorkspaceSelect
                    label={t("workspace.loops.editor.gate")}
                    value={current().gate?.kind ?? NONE}
                    options={gateOptions()}
                    onChange={(value) => {
                      const kind = LOOP_GATE_KINDS.find((candidate) => candidate === value) satisfies
                        | LoopGateKind
                        | undefined;
                      if (kind) change({ gate: { ...current().gate, kind } });
                      else change({}, ["gate"]);
                    }}
                  />
                </Field>
                <Show when={current().gate}>
                  {(gate) => (
                    <>
                      <Field label={t("workspace.loops.editor.gateNote")}>
                        <Input
                          value={gate().note ?? ""}
                          onInput={(event) => change({ gate: { ...gate(), note: event.currentTarget.value } })}
                        />
                      </Field>
                      <Show when={gate().kind === "money"}>
                        <Field label={t("workspace.loops.editor.amountField")}>
                          <WorkspaceSelect
                            label={t("workspace.loops.editor.amountField")}
                            value={gate().amountField ?? NONE}
                            options={[
                              { value: NONE, label: "—" },
                              ...parseFields(fields())
                                .filter((field) => field.type === "money" || field.type === "number")
                                .map((field) => ({ value: field.key, label: field.label })),
                            ]}
                            onChange={(value) => {
                              const { amountField: _old, ...rest } = gate();
                              change({ gate: value !== NONE ? { ...rest, amountField: value } : rest });
                            }}
                          />
                        </Field>
                      </Show>
                    </>
                  )}
                </Show>
                <Field label={t("workspace.loops.editor.end")}>
                  <WorkspaceSelect
                    label={t("workspace.loops.editor.end")}
                    value={current().outcome ?? NONE}
                    options={outcomeOptions()}
                    onChange={(value) => {
                      const outcome = LOOP_OUTCOMES.find((candidate) => candidate === value) satisfies
                        | LoopOutcome
                        | undefined;
                      if (outcome) change({ outcome });
                      else change({}, ["outcome"]);
                    }}
                  />
                </Field>
                <Field label={t("workspace.loops.editor.sla")}>
                  <Input
                    type="number"
                    min="0"
                    max="3650"
                    value={current().slaDays === undefined ? "" : String(current().slaDays)}
                    onInput={(event) => {
                      const days = Number.parseInt(event.currentTarget.value, 10);
                      if (Number.isFinite(days) && days > 0) change({ slaDays: Math.min(days, 3650) });
                      else change({}, ["slaDays"]);
                    }}
                  />
                </Field>
              </div>
              <Field label={t("workspace.loops.editor.stageDescription")}>
                <Textarea
                  rows={2}
                  value={current().description ?? ""}
                  onInput={(event) =>
                    event.currentTarget.value.trim()
                      ? change({ description: event.currentTarget.value })
                      : change({}, ["description"])
                  }
                />
              </Field>
              <Field label={t("workspace.loops.editor.checklist")} description={t("workspace.loops.editor.oneLine")}>
                <Textarea
                  rows={3}
                  value={checklists()[current().id] ?? (current().checklist ?? []).join("\n")}
                  onInput={(event) => {
                    const text = event.currentTarget.value;
                    const lines = checklistLines(text);
                    setChecklists((typed) => ({ ...typed, [current().id]: text }));
                    if (lines.length) change({ checklist: lines });
                    else change({}, ["checklist"]);
                  }}
                />
              </Field>
              <Field
                label={t("workspace.loops.editor.metrics")}
                description={t("workspace.loops.editor.metricsHint")}
                error={
                  wrong(current()).length > 0
                    ? t("workspace.loops.editor.wrongMetrics", { lines: wrong(current()).join("; ") })
                    : undefined
                }
              >
                <Textarea
                  rows={2}
                  class="ws-loops-mono"
                  value={metricsText(current())}
                  onInput={(event) => {
                    const text = event.currentTarget.value;
                    const rules = parseMetrics(text);
                    setMetrics((typed) => ({ ...typed, [current().id]: text }));
                    if (rules.length) change({ exitMetrics: rules });
                    else change({}, ["exitMetrics"]);
                  }}
                />
              </Field>
              <Field label={t("workspace.loops.editor.next")} description={t("workspace.loops.editor.nextHint")}>
                <div class="ws-loops-row ws-loops-wrap">
                  <For each={stages().filter((entry) => entry.id !== current().id)} keyed={(entry) => entry.id}>
                    {(entry) => (
                      <label class="ws-loops-check" for={`${idPrefix}-next-${entry().id}`}>
                        <Checkbox
                          id={`${idPrefix}-next-${entry().id}`}
                          checked={current().next?.includes(entry().id) ?? false}
                          onChange={(event) => {
                            const set = new Set(current().next ?? []);
                            if (event.currentTarget.checked) set.add(entry().id);
                            else set.delete(entry().id);
                            if (set.size) change({ next: [...set] });
                            else change({}, ["next"]);
                          }}
                        />
                        <span>{entry().name}</span>
                      </label>
                    )}
                  </For>
                </div>
              </Field>
              <fieldset class="ws-loops-actions-editor">
                <legend>{t("workspace.loops.editor.onEnter")}</legend>
                <label class="ws-loops-check" for={`${idPrefix}-notify`}>
                  <Checkbox
                    id={`${idPrefix}-notify`}
                    checked={current().onEnter?.notifyOwner === true}
                    onChange={(event) =>
                      change({ onEnter: { ...current().onEnter, notifyOwner: event.currentTarget.checked } })
                    }
                  />
                  <span>{t("workspace.loops.editor.notifyOwner")}</span>
                </label>
                <Field
                  label={t("workspace.loops.editor.ticket")}
                  description={t("workspace.loops.editor.ticketHint", {
                    item: "{item}",
                    stage: "{stage}",
                    loop: "{loop}",
                  })}
                >
                  <Input
                    value={current().onEnter?.ticket?.title ?? ""}
                    onInput={(event) => {
                      const title = event.currentTarget.value;
                      const { ticket: _old, ...rest } = current().onEnter ?? {};
                      change({
                        onEnter: title.trim() ? { ...rest, ticket: { ...current().onEnter?.ticket, title } } : rest,
                      });
                    }}
                  />
                </Field>
                <Show when={current().onEnter?.routine}>
                  {(routine) => (
                    <p class="ws-loops-muted">
                      {t("workspace.loops.editor.routine", {
                        agent:
                          props.agents.find((member) => member.id === routine().agentId)?.name ?? routine().agentId,
                      })}
                    </p>
                  )}
                </Show>
              </fieldset>
            </section>
          )}
        </Show>
        <Field label={t("workspace.loops.editor.motion")} description={t("workspace.loops.editor.motionHint")}>
          <Input
            value={motionProject()}
            class="ws-loops-mono"
            onInput={(event) => setMotionProject(event.currentTarget.value)}
          />
        </Field>
        <Field label={t("workspace.loops.fields")} description={t("workspace.loops.editor.fieldsHint")}>
          <Textarea
            rows={5}
            class="ws-loops-mono"
            value={fields()}
            onInput={(event) => setFields(event.currentTarget.value)}
          />
        </Field>
        <Show when={props.onDelete}>
          {(remove) => (
            <Button variant="destructive-ghost" size="sm" onClick={() => remove()()}>
              <Trash2 aria-hidden="true" />
              {t("workspace.loops.editor.delete")}
            </Button>
          )}
        </Show>
      </FormDialog>
      <DiscardChangesDialog guard={guard} />
    </>
  );
}
