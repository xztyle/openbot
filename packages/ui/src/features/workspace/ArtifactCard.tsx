import { Dynamic, type JSX } from "@solidjs/web";
import { createSignal, Match, Show, Switch } from "solid-js";
import { Button } from "../../button";
import { AppWindow, ExternalLink, File, FileText, Globe2, LayoutDashboard, Presentation } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MemberAvatar } from "./WorkspaceAvatar";
import { useCost, useWorkspaceDuration } from "./workspace-format";
import type { ArtifactKind, WorkspaceArtifact } from "./workspace-types";

const KIND = {
  website: { label: "workspace.artifact.kind.website", icon: Globe2 },
  app: { label: "workspace.artifact.kind.app", icon: AppWindow },
  doc: { label: "workspace.artifact.kind.doc", icon: FileText },
  deck: { label: "workspace.artifact.kind.deck", icon: Presentation },
  dashboard: { label: "workspace.artifact.kind.dashboard", icon: LayoutDashboard },
  file: { label: "workspace.artifact.kind.file", icon: File },
} as const satisfies Record<ArtifactKind, { label: string; icon: typeof File }>;

/** The text key of an artifact kind, for filters. */
export function artifactKindLabelKey(kind: ArtifactKind) {
  return KIND[kind].label;
}

export interface ArtifactCardProps {
  artifact: WorkspaceArtifact;
  onOpen?: (() => void) | undefined;
  /** A row without the thumbnail, for a message in a narrow thread. */
  compact?: boolean | undefined;
  class?: string;
}

/**
 * A deliverable as a card: thumbnail, kind, title, description, the agent that built it, and its
 * cost and time. "Open" goes to the app, the site or the file.
 */
export function ArtifactCard(props: ArtifactCardProps): JSX.Element {
  const { t } = useText();
  const duration = useWorkspaceDuration();
  const cost = useCost();
  const [thumbnailFailed, setThumbnailFailed] = createSignal(false);
  const kind = () => KIND[props.artifact.kind];
  const host = () => {
    if (!props.artifact.url) return undefined;
    try {
      return new URL(props.artifact.url).host;
    } catch {
      return props.artifact.url;
    }
  };
  const facts = () =>
    [
      props.artifact.costUsd === undefined ? undefined : cost(props.artifact.costUsd),
      props.artifact.durationMs === undefined ? undefined : duration(props.artifact.durationMs),
    ].filter((fact): fact is string => fact !== undefined);
  return (
    <article
      class={cx("ws-artifact", props.class)}
      data-kind={props.artifact.kind}
      data-compact={props.compact ? "" : undefined}
      aria-label={t("workspace.artifact.label", { kind: t(kind().label), title: props.artifact.title })}
    >
      <Show when={!props.compact}>
        <div
          class="ws-artifact-thumb"
          data-placeholder={props.artifact.thumbnailUrl && !thumbnailFailed() ? undefined : ""}
        >
          <Show
            when={props.artifact.thumbnailUrl && !thumbnailFailed() ? props.artifact.thumbnailUrl : null}
            fallback={
              <span class="ws-artifact-thumb-fallback" aria-hidden="true">
                <ArtifactSketch kind={props.artifact.kind} icon={kind().icon} />
                <Show when={host()}>{(value) => <span class="ws-artifact-thumb-host">{value()}</span>}</Show>
              </span>
            }
          >
            {(url) => <img src={url()} alt="" loading="lazy" onError={() => setThumbnailFailed(true)} />}
          </Show>
        </div>
      </Show>
      <div class="ws-artifact-body">
        <div class="ws-artifact-kind">
          <Dynamic component={kind().icon} aria-hidden="true" />
          <span>{t(kind().label)}</span>
          <Show when={host()}>
            {(value) => (
              <>
                <span aria-hidden="true">·</span>
                <span class="ws-truncate">{value()}</span>
              </>
            )}
          </Show>
        </div>
        <h3 class="ws-artifact-title">{props.artifact.title}</h3>
        <Show when={props.artifact.description}>
          <p class="ws-artifact-description">{props.artifact.description}</p>
        </Show>
        <div class="ws-artifact-footer">
          <Show when={props.artifact.agent}>
            {(agent) => (
              <span class="ws-artifact-agent">
                <MemberAvatar member={agent()} size="xs" />
                <span class="ws-truncate">{t("workspace.artifact.by", { name: agent().name })}</span>
              </span>
            )}
          </Show>
          <Show when={facts().length > 0}>
            <span class="ws-artifact-facts">{facts().join(" · ")}</span>
          </Show>
          <Show when={props.onOpen}>
            {(open) => (
              <Button variant="secondary" size="xs" class="ws-artifact-open" onClick={() => open()()}>
                {t("workspace.artifact.open")}
                <ExternalLink aria-hidden="true" />
              </Button>
            )}
          </Show>
        </div>
      </div>
    </article>
  );
}

/**
 * A drawing of the kind while the artifact has no thumbnail: a page in a browser for a site or an
 * app, lines of text for a document, a slide for a deck, bars for a dashboard, an icon for a file.
 */
function ArtifactSketch(props: { kind: ArtifactKind; icon: typeof File }): JSX.Element {
  const lines = (count: number) => Array.from({ length: count }, () => <i />);
  return (
    <span class="ws-artifact-sketch" data-kind={props.kind}>
      <Switch fallback={<Dynamic component={props.icon} class="ws-artifact-sketch-icon" />}>
        <Match when={props.kind === "website" || props.kind === "app"}>
          <span class="ws-artifact-sketch-bar">{lines(3)}</span>
          <span class="ws-artifact-sketch-hero" />
          <span class="ws-artifact-sketch-lines">{lines(3)}</span>
        </Match>
        <Match when={props.kind === "doc"}>
          <span class="ws-artifact-sketch-lines" data-dense="">
            {lines(7)}
          </span>
        </Match>
        <Match when={props.kind === "deck"}>
          <span class="ws-artifact-sketch-slide">
            <i />
            <i />
          </span>
        </Match>
        <Match when={props.kind === "dashboard"}>
          <span class="ws-artifact-sketch-chart">{lines(6)}</span>
        </Match>
      </Switch>
    </span>
  );
}
