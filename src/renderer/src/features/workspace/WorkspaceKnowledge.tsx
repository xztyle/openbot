/*
 * What the agents of a space know together: the decision log that `log_decision` writes, and the
 * customer, product and supplier memory of `space_memory` (docs/agent-learning.md, "Space knowledge").
 * The owner reads it, searches it and removes what is wrong; agents write it. Owners and admins of a
 * fork host only, as the learning routes.
 */
import {
  SPACE_ENTITY_TYPES,
  type SpaceDecision,
  type SpaceEntity,
  type SpaceEntityType,
  type SpaceKnowledge,
} from "@openbot/contracts/agent-learning";
import type { AppTextKey } from "@openbot/i18n";
import { BookOpen, Button, Input, Trash2, toast } from "@openbot/ui";
import { WorkspacePaneHeader } from "@openbot/ui/features/workspace/WorkspacePaneHeader";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { RemoveSpaceKnowledgeInput } from "../efficiency/efficiency-port";
import { useWorkspace } from "./workspace-context";
import "./knowledge.css";

type Tab = "decisions" | "memory";
type TypeFilter = SpaceEntityType | "all";

const TYPE_LABEL = {
  customer: "workspace.knowledge.type.customer",
  product: "workspace.knowledge.type.product",
  supplier: "workspace.knowledge.type.supplier",
  other: "workspace.knowledge.type.other",
} as const satisfies Record<SpaceEntityType, AppTextKey>;

/** A search waits this long after the last key, so typing sends one request. */
const SEARCH_DELAY_MS = 300;

export function WorkspaceKnowledgeView() {
  const ws = useWorkspace();
  const { t, format, errorMessage } = useText();
  const calls = () => ws.env.efficiency?.();
  const spaceId = () => ws.spaces.current();
  const [tab, setTab] = createSignal<Tab>("decisions");
  const [filter, setFilter] = createSignal<TypeFilter>("all");
  const [query, setQuery] = createSignal("");
  const [knowledge, setKnowledge] = createSignal<SpaceKnowledge | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  let request = 0;

  async function load(space: string, text: string) {
    const api = calls();
    if (!api) return;
    const mine = ++request;
    try {
      const next = await api.knowledge(space, text);
      if (mine !== request) return;
      setKnowledge(next);
      setError(null);
    } catch (failure) {
      if (mine === request) setError(errorMessage(failure, t("workspace.knowledge.loadFailed")));
    }
  }

  // A new space loads at once; a search waits for the typing to stop.
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    () => ({ space: spaceId(), text: query() }),
    (next, previous) => {
      clearTimeout(timer);
      if (!previous || previous.space !== next.space) {
        setKnowledge(null);
        void load(next.space, next.text);
        return;
      }
      timer = setTimeout(() => void load(next.space, next.text), SEARCH_DELAY_MS);
    },
  );
  onCleanup(() => clearTimeout(timer));

  async function remove(input: Omit<RemoveSpaceKnowledgeInput, "spaceId">) {
    const api = calls();
    if (!api || busy()) return;
    setBusy(input.id);
    try {
      const next = await api.removeKnowledge({ ...input, spaceId: spaceId() });
      // The host answers the whole space; a search keeps its filter by reading again.
      if (query().trim()) void load(spaceId(), query());
      else setKnowledge(next);
      toast.success(t("workspace.knowledge.removed"));
    } catch (failure) {
      toast.error(errorMessage(failure, t("workspace.knowledge.removeFailed")));
    } finally {
      setBusy(null);
    }
  }

  const agentName = (agentId: string | null) =>
    agentId
      ? (ws.env.agents().find((agent) => agent.id === agentId)?.name ?? t("chat.message.agentFallback"))
      : t("workspace.knowledge.byOwner");
  const decisions = createMemo(() =>
    [...(knowledge()?.decisions ?? [])].sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  );
  const entities = createMemo(() =>
    (knowledge()?.entities ?? [])
      .filter((entity) => filter() === "all" || entity.type === filter())
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
  );
  const when = (at: string) => format.date(new Date(at), { dateStyle: "medium" });

  return (
    <section class="ws-view knowledge-view" aria-label={t("workspace.knowledge.title")}>
      <WorkspacePaneHeader
        icon={<BookOpen aria-hidden="true" />}
        title={t("workspace.knowledge.title")}
        subtitle={t("workspace.knowledge.subtitle")}
        onBack={() => ws.back()}
      />
      <div class="knowledge-toolbar">
        <fieldset class="knowledge-tabs" aria-label={t("workspace.knowledge.title")}>
          <For each={["decisions", "memory"] as const}>
            {(value) => (
              <Button
                type="button"
                size="sm"
                variant={tab() === value ? "secondary" : "ghost"}
                aria-pressed={tab() === value ? "true" : "false"}
                onClick={() => setTab(value)}
              >
                {value === "decisions"
                  ? t("workspace.knowledge.tab.decisions", { count: knowledge()?.decisions.length ?? 0 })
                  : t("workspace.knowledge.tab.memory", { count: knowledge()?.entities.length ?? 0 })}
              </Button>
            )}
          </For>
        </fieldset>
        <Input
          type="search"
          class="knowledge-search"
          value={query()}
          placeholder={t("workspace.knowledge.search")}
          aria-label={t("workspace.knowledge.search")}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </div>
      <div class="ws-view-scroll knowledge-scroll">
        <Show when={error()}>
          {(message) => (
            <p class="knowledge-alert" role="alert">
              {message()}{" "}
              <Button type="button" size="sm" variant="ghost" onClick={() => void load(spaceId(), query())}>
                {t("common.retry")}
              </Button>
            </p>
          )}
        </Show>
        <Show when={tab() === "decisions" && knowledge()}>
          <Show
            when={decisions().length > 0}
            fallback={
              <p class="ws-view-empty">
                {query().trim() ? t("workspace.knowledge.noMatch") : t("workspace.knowledge.noDecisions")}
              </p>
            }
          >
            <ol class="knowledge-list">
              <For each={decisions()}>
                {(decision) => (
                  <DecisionRow
                    decision={decision}
                    by={agentName(decision.agentId)}
                    when={when(decision.createdAt)}
                    outcomeWhen={decision.outcomeAt ? when(decision.outcomeAt) : undefined}
                    busy={busy() === decision.id}
                    onRemove={() => void remove({ kind: "decision", id: decision.id })}
                  />
                )}
              </For>
            </ol>
          </Show>
        </Show>
        <Show when={tab() === "memory" && knowledge()}>
          <fieldset class="knowledge-filters" aria-label={t("workspace.knowledge.filter")}>
            <For each={["all", ...SPACE_ENTITY_TYPES] as const}>
              {(value) => (
                <Button
                  type="button"
                  size="sm"
                  variant={filter() === value ? "secondary" : "ghost"}
                  aria-pressed={filter() === value ? "true" : "false"}
                  onClick={() => setFilter(value)}
                >
                  {value === "all" ? t("workspace.knowledge.type.all") : t(TYPE_LABEL[value])}
                </Button>
              )}
            </For>
          </fieldset>
          <Show
            when={entities().length > 0}
            fallback={
              <p class="ws-view-empty">
                {query().trim() ? t("workspace.knowledge.noMatch") : t("workspace.knowledge.noMemory")}
              </p>
            }
          >
            <ul class="knowledge-list">
              <For each={entities()}>
                {(entity) => (
                  <EntityRow
                    entity={entity}
                    type={t(TYPE_LABEL[entity.type])}
                    when={when(entity.updatedAt)}
                    busy={busy()}
                    onRemove={() => void remove({ kind: "entity", id: entity.id })}
                    onRemoveFact={(factId) => void remove({ kind: "fact", id: factId, entityId: entity.id })}
                  />
                )}
              </For>
            </ul>
          </Show>
        </Show>
      </div>
    </section>
  );
}

function DecisionRow(props: {
  decision: SpaceDecision;
  by: string;
  when: string;
  outcomeWhen: string | undefined;
  busy: boolean;
  onRemove: () => void;
}) {
  const { t } = useText();
  return (
    <li class="knowledge-card">
      <div class="knowledge-card-head">
        <h3 class="knowledge-card-title">{props.decision.decision}</h3>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          class="knowledge-remove"
          aria-label={t("workspace.knowledge.removeDecision")}
          title={t("workspace.knowledge.removeDecision")}
          loading={props.busy}
          onClick={props.onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <p class="knowledge-text">{props.decision.why}</p>
      <Show when={props.decision.alternatives}>
        {(alternatives) => (
          <p class="knowledge-text">
            <span class="knowledge-label">{t("workspace.knowledge.alternatives")}</span> {alternatives()}
          </p>
        )}
      </Show>
      <Show when={props.decision.outcome}>
        {(outcome) => (
          <p class="knowledge-outcome">
            <span class="knowledge-label">{t("workspace.knowledge.outcome")}</span> {outcome()}
            <Show when={props.outcomeWhen}>{(at) => <span class="knowledge-meta"> · {at()}</span>}</Show>
          </p>
        )}
      </Show>
      <p class="knowledge-meta">{t("workspace.knowledge.decidedBy", { name: props.by, date: props.when })}</p>
    </li>
  );
}

function EntityRow(props: {
  entity: SpaceEntity;
  type: string;
  when: string;
  busy: string | null;
  onRemove: () => void;
  onRemoveFact: (factId: string) => void;
}) {
  const { t } = useText();
  return (
    <li class="knowledge-card">
      <div class="knowledge-card-head">
        <h3 class="knowledge-card-title">
          {props.entity.name} <span class="knowledge-type">{props.type}</span>
        </h3>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          class="knowledge-remove"
          aria-label={t("workspace.knowledge.removeEntity", { name: props.entity.name })}
          title={t("workspace.knowledge.removeEntity", { name: props.entity.name })}
          loading={props.busy === props.entity.id}
          onClick={props.onRemove}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <ul class="knowledge-facts">
        <For each={props.entity.facts}>
          {(fact) => (
            <li class="knowledge-fact">
              <span>{fact.text}</span>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                class="knowledge-remove"
                aria-label={t("workspace.knowledge.removeFact")}
                title={t("workspace.knowledge.removeFact")}
                loading={props.busy === fact.id}
                onClick={() => props.onRemoveFact(fact.id)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          )}
        </For>
      </ul>
      <p class="knowledge-meta">{t("workspace.knowledge.updated", { date: props.when })}</p>
    </li>
  );
}
