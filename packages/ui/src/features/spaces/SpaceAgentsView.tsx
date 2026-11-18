import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Checkbox } from "../../checkbox";
import { ConfirmDialog } from "../../confirm-dialog";
import { Input } from "../../form";
import { ArrowLeftRight, Bot, MessageSquare, Search, Trash2 } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState } from "../../view-state";
import { AiBadge, MemberAvatar } from "../workspace/WorkspaceAvatar";
import { PaneHeaderAction, WorkspacePaneHeader } from "../workspace/WorkspacePaneHeader";
import { useRecentTime } from "../workspace/workspace-format";
import type { WorkspaceMember } from "../workspace/workspace-types";

/** One agent of a space, as its list shows it. */
export interface SpaceAgentRow {
  member: WorkspaceMember;
  title: string;
  /** The provider and the model, such as "Codex · gpt-6-luna". */
  model: string;
  /** Epoch milliseconds of its last message or turn; null when it has none. */
  lastActivityAt: number | null;
}

export interface SpaceAgentsViewProps {
  spaceName: string;
  agents: readonly SpaceAgentRow[];
  onOpenChat: (agentId: string) => void;
  /** Present when the reader may move agents: it opens the move of these agents. */
  onMove?: ((agentIds: string[]) => void) | undefined;
  /** Present when the reader may delete agents. A rejected promise shows its message. */
  onDelete?: ((agentIds: string[]) => Promise<void>) | undefined;
  onAddAgent?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** The agents of one space: search, open a chat, move to another space, delete one or several. */
export function SpaceAgentsView(props: SpaceAgentsViewProps): JSX.Element {
  const { t, errorMessage } = useText();
  const recent = useRecentTime();
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = createSignal<string[] | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const shown = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    return [...props.agents]
      .filter(
        (agent) =>
          !text ||
          agent.member.name.toLocaleLowerCase().includes(text) ||
          agent.title.toLocaleLowerCase().includes(text) ||
          agent.model.toLocaleLowerCase().includes(text),
      )
      .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0));
  });
  /** The selection keeps only agents that are still in the list. */
  const chosen = createMemo(() => props.agents.map((agent) => agent.member.id).filter((id) => selected().has(id)));
  const toggle = (agentId: string, on: boolean) => {
    const next = new Set(selected());
    if (on) next.add(agentId);
    else next.delete(agentId);
    setSelected(next);
  };
  const allShownSelected = () => shown().length > 0 && shown().every((agent) => selected().has(agent.member.id));
  const names = (ids: readonly string[]) =>
    ids.map((id) => props.agents.find((agent) => agent.member.id === id)?.member.name ?? id);
  return (
    <section
      class={cx("ws-view space-agents", props.class)}
      aria-label={t("workspace.spaces.agentsOf", { name: props.spaceName })}
    >
      <WorkspacePaneHeader
        icon={<Bot aria-hidden="true" />}
        title={t("workspace.spaces.agentsOf", { name: props.spaceName })}
        subtitle={t("workspace.spaces.agentCount", { count: props.agents.length })}
        onBack={props.onBack}
        actions={
          <Show when={props.onAddAgent}>
            {(add) => <PaneHeaderAction label={t("workspace.fleet.addAgent")} onClick={() => add()()} />}
          </Show>
        }
      />
      <div class="ws-view-toolbar">
        <Show when={props.onDelete || props.onMove}>
          <Checkbox
            aria-label={t("workspace.spaces.selectAll")}
            checked={allShownSelected()}
            onChange={(event) => {
              const on = event.currentTarget.checked;
              const next = new Set(selected());
              for (const agent of shown()) {
                if (on) next.add(agent.member.id);
                else next.delete(agent.member.id);
              }
              setSelected(next);
            }}
          />
        </Show>
        <div class="ws-view-search">
          <Search aria-hidden="true" />
          <Input
            size="sm"
            value={query()}
            aria-label={t("workspace.spaces.searchAgents")}
            placeholder={t("workspace.spaces.searchAgents")}
            onValueChange={setQuery}
          />
        </div>
        <Show when={chosen().length > 0}>
          <span class="space-agents-selection">{t("workspace.spaces.selected", { count: chosen().length })}</span>
          <Show when={props.onMove}>
            {(move) => (
              <Button variant="secondary" size="xs" onClick={() => move()(chosen())}>
                <ArrowLeftRight aria-hidden="true" />
                {t("workspace.spaces.moveSelected")}
              </Button>
            )}
          </Show>
          <Show when={props.onDelete}>
            <Button variant="destructive" size="xs" onClick={() => setDeleting(chosen())}>
              <Trash2 aria-hidden="true" />
              {t("workspace.spaces.deleteSelected")}
            </Button>
          </Show>
        </Show>
      </div>
      <div class="ws-view-scroll">
        <Show
          when={shown().length > 0}
          fallback={
            <Show
              when={props.agents.length > 0}
              fallback={
                <EmptyState
                  icon={<Bot />}
                  title={t("workspace.spaces.noAgents")}
                  description={t("workspace.fleet.noAgentsHint")}
                  action={
                    <Show when={props.onAddAgent}>
                      {(add) => <PaneHeaderAction label={t("workspace.fleet.addAgent")} onClick={() => add()()} />}
                    </Show>
                  }
                />
              }
            >
              <EmptyState
                size="compact"
                icon={<Search />}
                title={t("workspace.view.noMatch")}
                description={t("workspace.view.noMatchHint")}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                    {t("workspace.view.clearFilters")}
                  </Button>
                }
              />
            </Show>
          }
        >
          <ul class="space-agents-list">
            <For each={shown()} keyed={(agent) => agent.member.id}>
              {(agent) => (
                <li class="space-agents-row" data-selected={selected().has(agent().member.id) ? "" : undefined}>
                  <Show when={props.onDelete || props.onMove}>
                    <Checkbox
                      aria-label={t("workspace.spaces.selectAgent", { name: agent().member.name })}
                      checked={selected().has(agent().member.id)}
                      onChange={(event) => toggle(agent().member.id, event.currentTarget.checked)}
                    />
                  </Show>
                  <MemberAvatar member={agent().member} size="md" />
                  <span class="space-agents-copy">
                    <span class="space-agents-name">
                      {agent().member.name}
                      <AiBadge />
                    </span>
                    <span class="space-agents-meta">
                      <Show when={agent().title}>
                        <span>{agent().title}</span>
                      </Show>
                      <span>{agent().model}</span>
                    </span>
                  </span>
                  <span class="space-agents-activity">
                    {agent().lastActivityAt === null
                      ? t("workspace.spaces.noActivity")
                      : recent(agent().lastActivityAt ?? 0)}
                  </span>
                  <span class="space-agents-actions">
                    <IconButton
                      variant="ghost"
                      size="icon-xs"
                      label={t("workspace.spaces.openChat", { name: agent().member.name })}
                      onClick={() => props.onOpenChat(agent().member.id)}
                    >
                      <MessageSquare />
                    </IconButton>
                    <Show when={props.onMove}>
                      {(move) => (
                        <IconButton
                          variant="ghost"
                          size="icon-xs"
                          label={t("workspace.spaces.moveAgent", { name: agent().member.name })}
                          onClick={() => move()([agent().member.id])}
                        >
                          <ArrowLeftRight />
                        </IconButton>
                      )}
                    </Show>
                    <Show when={props.onDelete}>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("workspace.spaces.deleteAgent", { name: agent().member.name })}
                        onClick={() => setDeleting([agent().member.id])}
                      >
                        <Trash2 />
                      </IconButton>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <ConfirmDialog
        open={deleting() !== null}
        title={t("workspace.spaces.deleteAgentsTitle", { count: deleting()?.length ?? 0 })}
        description={t("workspace.spaces.deleteAgentsDescription")}
        confirmLabel={t("workspace.spaces.deleteAgentsButton", { count: deleting()?.length ?? 0 })}
        error={error() ?? undefined}
        onCancel={() => {
          setDeleting(null);
          setError(null);
        }}
        onConfirm={async () => {
          const ids = deleting();
          if (!ids || !props.onDelete) return;
          try {
            await props.onDelete(ids);
            setSelected(new Set<string>());
            setDeleting(null);
            setError(null);
          } catch (failure) {
            setError(errorMessage(failure, t("workspace.spaces.deleteAgentsFailed")));
          }
        }}
      >
        <ul class="space-agents-delete-list">
          <For each={names(deleting() ?? [])}>{(name) => <li>{name}</li>}</For>
        </ul>
      </ConfirmDialog>
    </section>
  );
}
