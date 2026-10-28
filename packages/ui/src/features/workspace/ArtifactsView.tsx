import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { LayoutDashboard } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { ArtifactCard, artifactKindLabelKey } from "./ArtifactCard";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";
import type { ArtifactKind, WorkspaceArtifact } from "./workspace-types";

const KINDS: readonly ArtifactKind[] = ["website", "app", "doc", "deck", "dashboard", "file"];
const ALL = "all";

export interface ArtifactsViewProps {
  artifacts: readonly WorkspaceArtifact[];
  onOpen: (artifactId: string) => void;
  /** The channel that the view is limited to. Without it the view covers the workspace. */
  channelName?: string | undefined;
  onBack?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  class?: string;
}

/** A gallery of what the agents built, with filters by kind, agent and channel. */
export function ArtifactsView(props: ArtifactsViewProps): JSX.Element {
  const { t } = useText();
  const [kind, setKind] = createSignal<string>(ALL);
  const [agent, setAgent] = createSignal<string>(ALL);
  const [channel, setChannel] = createSignal<string>(ALL);
  const agents = () => {
    const byId = new Map(
      props.artifacts.flatMap((artifact) => (artifact.agent ? [[artifact.agent.id, artifact.agent.name]] : [])),
    );
    return [...byId].map(([value, label]) => ({ value, label }));
  };
  const channels = () => {
    const names = new Set(props.artifacts.flatMap((artifact) => (artifact.channelName ? [artifact.channelName] : [])));
    return [...names].map((name) => ({ value: name, label: `#${name}` }));
  };
  const shown = () =>
    props.artifacts.filter(
      (artifact) =>
        (kind() === ALL || artifact.kind === kind()) &&
        (agent() === ALL || artifact.agent?.id === agent()) &&
        (channel() === ALL || artifact.channelName === channel()),
    );
  const filtered = () => kind() !== ALL || agent() !== ALL || channel() !== ALL;
  return (
    <section class={cx("ws-view ws-artifacts", props.class)} aria-label={t("workspace.view.artifacts")}>
      <WorkspacePaneHeader
        icon={<LayoutDashboard aria-hidden="true" />}
        title={t("workspace.view.artifacts")}
        subtitle={props.channelName ? `#${props.channelName}` : undefined}
        onBack={props.onBack}
        onClose={props.onClose}
      />
      <Show when={props.artifacts.length > 0}>
        <div class="ws-view-toolbar">
          <WorkspaceSelect
            label={t("workspace.artifacts.kind")}
            prefix={t("workspace.artifacts.kind")}
            value={kind()}
            options={[
              { value: ALL, label: t("workspace.artifacts.any") },
              ...KINDS.map((value) => ({ value, label: t(artifactKindLabelKey(value)) })),
            ]}
            onChange={setKind}
          />
          <WorkspaceSelect
            label={t("workspace.artifacts.agent")}
            prefix={t("workspace.artifacts.agent")}
            value={agent()}
            options={[{ value: ALL, label: t("workspace.artifacts.any") }, ...agents()]}
            onChange={setAgent}
          />
          <Show when={!props.channelName}>
            <WorkspaceSelect
              label={t("workspace.artifacts.channel")}
              prefix={t("workspace.artifacts.channel")}
              value={channel()}
              options={[{ value: ALL, label: t("workspace.artifacts.any") }, ...channels()]}
              onChange={setChannel}
            />
          </Show>
          <Show when={filtered()}>
            <Button
              variant="link"
              size="xs"
              onClick={() => {
                setKind(ALL);
                setAgent(ALL);
                setChannel(ALL);
              }}
            >
              {t("workspace.artifacts.clear")}
            </Button>
          </Show>
        </div>
      </Show>
      <div class="ws-view-scroll">
        <Show
          when={shown().length > 0}
          fallback={
            <div class="ws-empty">
              <span class="ws-empty-icon" aria-hidden="true">
                <LayoutDashboard />
              </span>
              <p class="ws-empty-title">
                {filtered() ? t("workspace.artifacts.noMatch") : t("workspace.artifacts.emptyTitle")}
              </p>
              <Show when={!filtered()}>
                <p class="ws-empty-text">{t("workspace.artifacts.emptyText")}</p>
              </Show>
            </div>
          }
        >
          <ul class="ws-artifact-grid">
            <For each={shown()} keyed={(artifact) => artifact.id}>
              {(artifact) => (
                <li>
                  <ArtifactCard artifact={artifact()} onOpen={() => props.onOpen(artifact().id)} />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </section>
  );
}
