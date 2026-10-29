import {
  STORAGE_HYGIENE_CLASSES,
  type StorageHygieneArea,
  type StorageHygieneBreakdown,
  type StorageHygieneClass,
  type StorageHygieneCleanupResult,
  type StorageHygieneItem,
  type StorageHygieneReport,
  type StorageHygieneRule,
  type StorageHygieneSkipReason,
  storageHygieneSelectedBytes,
} from "@openbot/contracts/ipc";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { Button } from "../../button";
import { Checkbox } from "../../checkbox";
import { ConfirmDialog } from "../../confirm-dialog";
import { Bot, ChevronDown, ChevronRight, Folder, HardDrive, RefreshCw, Settings, TriangleAlert } from "../../icons";
import { Progress } from "../../progress";
import { useText } from "../../text";
import { cx } from "../../utils";
import { groupStoragePlan, type StoragePlanRule, selectionState, toggleSelection } from "./storage-plan";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { useRecentTime, useWorkspaceDuration } from "./workspace-format";

export type StorageViewPhase = "loading" | "ready" | "error" | "unsupported";

export interface StorageViewProps {
  phase: StorageViewPhase;
  report: StorageHygieneReport | null;
  /** A scan runs on the host; `scanEntries` is how far it got. */
  scanning: boolean;
  scanEntries?: number | undefined;
  cleaning: boolean;
  lastCleanup: StorageHygieneCleanupResult | null;
  /** A cleanup keeps anything changed in the last minutes. */
  recentMinutes: number;
  staleIdleHours: number;
  evidenceDeleteAfterDays: number;
  /** The name of a project folder, or of the agent of an agent workspace. */
  areaName: (area: StorageHygieneArea) => string;
  onRescan: () => void;
  onCleanup: (itemIds: string[]) => Promise<void>;
  /** Opens Server settings > Storage, where the automatic rules are. */
  onOpenRules?: (() => void) | undefined;
  onBack?: (() => void) | undefined;
  class?: string;
}

const CLASS_LABEL = {
  real: "storageHygiene.class.real",
  regenerable: "storageHygiene.class.regenerable",
  stale: "storageHygiene.class.stale",
  evidence: "storageHygiene.class.evidence",
} as const satisfies Record<StorageHygieneClass, AppTextKey>;

const RULE_LABEL = {
  "cargo-target": "storageHygiene.rule.cargo-target",
  "node-modules": "storageHygiene.rule.node-modules",
  "godot-cache": "storageHygiene.rule.godot-cache",
  "build-output": "storageHygiene.rule.build-output",
  "repo-copy": "storageHygiene.rule.repo-copy",
  "build-export": "storageHygiene.rule.build-export",
  "stale-worktree": "storageHygiene.rule.stale-worktree",
  "stale-copy": "storageHygiene.rule.stale-copy",
  "evidence-media": "storageHygiene.rule.evidence-media",
} as const satisfies Record<StorageHygieneRule, AppTextKey>;

const SKIP_LABEL = {
  busy: "storageHygiene.skip.busy",
  recent: "storageHygiene.skip.recent",
  changed: "storageHygiene.skip.changed",
  missing: "storageHygiene.skip.missing",
  failed: "storageHygiene.skip.failed",
  unplanned: "storageHygiene.skip.unplanned",
} as const satisfies Record<StorageHygieneSkipReason, AppTextKey>;

/** The items of one rule and area that the view lists before "N more items". */
const ITEM_ROWS = 25;
const SKIPPED_ROWS = 10;

/**
 * The workspace Storage view: the disk, what each project and agent workspace holds by class, the
 * largest folders, the cleanup plan with a checkbox per rule and per project, and the last cleanup.
 */
export function StorageView(props: StorageViewProps): JSX.Element {
  const { t, format } = useText();
  const recent = useRecentTime();
  const duration = useWorkspaceDuration();
  // The choice belongs to one plan: a new scan selects its recommended items again.
  const [choice, setChoice] = createSignal<{ scannedAt: number; ids: ReadonlySet<string> } | null>(null);
  const recommended = createMemo(
    (): ReadonlySet<string> =>
      new Set(props.report?.items.filter((item) => item.recommended).map((item) => item.id) ?? []),
  );
  const selected = (): ReadonlySet<string> => {
    const current = choice();
    return current && current.scannedAt === props.report?.scannedAt ? current.ids : recommended();
  };
  const setSelected = (update: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
    setChoice({ scannedAt: props.report?.scannedAt ?? 0, ids: update(selected()) });
  const [confirming, setConfirming] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const plan = createMemo(() => groupStoragePlan(props.report?.items ?? [], props.report?.areas ?? []));
  const total = createMemo(() => storageHygieneSelectedBytes(props.report?.items ?? [], selected()));
  const busy = () => props.scanning || props.cleaning;
  const subtitle = () => {
    const report = props.report;
    if (props.cleaning) return t("storageHygiene.cleaning");
    if (props.scanning)
      return props.scanEntries
        ? t("storageHygiene.scanning", { count: props.scanEntries })
        : t("storageHygiene.scanningStart");
    return report
      ? t("storageHygiene.scanned", { time: recent(report.scannedAt), duration: duration(report.durationMs) })
      : undefined;
  };
  const largestArea = () => Math.max(1, ...(props.report?.areas.map((area) => area.bytes) ?? []));

  async function cleanup(): Promise<void> {
    setError(null);
    try {
      await props.onCleanup([...selected()]);
      setConfirming(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }

  return (
    <section class={cx("ws-view ws-storage", props.class)} aria-label={t("storageHygiene.title")}>
      <WorkspacePaneHeader
        icon={<HardDrive aria-hidden="true" />}
        title={t("storageHygiene.title")}
        subtitle={subtitle()}
        onBack={props.onBack}
        actions={
          <>
            <Show when={props.onOpenRules}>
              {(open) => (
                <Button size="xs" variant="ghost" onClick={() => open()()}>
                  <Settings aria-hidden="true" />
                  {t("storageHygiene.rules")}
                </Button>
              )}
            </Show>
            <Show when={props.phase === "ready" || props.phase === "error"}>
              <Button size="xs" variant="secondary" disabled={busy()} onClick={() => props.onRescan()}>
                <RefreshCw aria-hidden="true" />
                {props.report ? t("storageHygiene.scanAgain") : t("storageHygiene.scan")}
              </Button>
            </Show>
          </>
        }
      />
      <div class="ws-view-scroll ws-storage-scroll">
        <Show when={props.scanning || props.cleaning}>
          <Progress
            class="ws-storage-progress"
            value={0}
            indeterminate
            aria-label={props.cleaning ? t("storageHygiene.cleaning") : t("storageHygiene.scanningStart")}
          />
        </Show>
        <Show when={props.phase === "unsupported"}>
          <p class="ws-view-empty">{t("storageHygiene.unsupported")}</p>
        </Show>
        <Show when={props.phase === "error"}>
          <p class="ws-storage-alert" role="alert">
            <TriangleAlert aria-hidden="true" />
            {t("storageHygiene.loadFailed")}
          </p>
        </Show>
        <Show when={props.phase === "ready" && !props.report && !props.scanning}>
          <p class="ws-view-empty">{t("storageHygiene.empty")}</p>
        </Show>
        <Show when={props.report}>
          {(report) => (
            <>
              <DiskGauge report={report()} />
              <Show when={report().truncated}>
                <p class="ws-storage-alert" role="status">
                  <TriangleAlert aria-hidden="true" />
                  {t("storageHygiene.truncated")}
                </p>
              </Show>
              <ClassLegend />
              <section class="ws-storage-section" aria-label={t("storageHygiene.areas.title")}>
                <h3 class="ws-storage-heading">{t("storageHygiene.areas.title")}</h3>
                <Show
                  when={report().areas.length > 0}
                  fallback={<p class="ws-storage-muted">{t("storageHygiene.areas.empty")}</p>}
                >
                  <ul class="ws-storage-rows">
                    <For each={report().areas} keyed={(area) => area.id}>
                      {(area) => (
                        <li class="ws-storage-row">
                          <span class="ws-storage-row-name">
                            {area().kind === "agent" ? <Bot aria-hidden="true" /> : <Folder aria-hidden="true" />}
                            <span class="ws-truncate">{props.areaName(area())}</span>
                            <Show when={area().kind === "agent"}>
                              <span class="ws-storage-tag">{t("storageHygiene.areas.agent")}</span>
                            </Show>
                            <Show when={!area().complete}>
                              <span class="ws-storage-tag">{t("storageHygiene.areas.incomplete")}</span>
                            </Show>
                          </span>
                          <span class="ws-storage-row-size">{format.fileSize(area().bytes)}</span>
                          <ClassBar breakdown={area().breakdown} scale={area().bytes / largestArea()} />
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </section>
              <Show when={report().folders.length > 0}>
                <section class="ws-storage-section" aria-label={t("storageHygiene.folders.title")}>
                  <h3 class="ws-storage-heading">{t("storageHygiene.folders.title")}</h3>
                  <ul class="ws-storage-rows">
                    <For each={report().folders.slice(0, 12)} keyed={(folder) => `${folder.areaId}/${folder.path}`}>
                      {(folder) => {
                        const area = () => report().areas.find((candidate) => candidate.id === folder().areaId);
                        return (
                          <li class="ws-storage-row">
                            <span class="ws-storage-row-name ws-storage-path">
                              <span class="ws-truncate">
                                {areaLabel(props.areaName, area(), "")}
                                {area() ? "/" : ""}
                                {folder().path}
                              </span>
                            </span>
                            <span class="ws-storage-row-size">{format.fileSize(folder().bytes)}</span>
                            <ClassBar breakdown={folder().breakdown} scale={folder().bytes / largestArea()} />
                          </li>
                        );
                      }}
                    </For>
                  </ul>
                </section>
              </Show>
              <section class="ws-storage-section" aria-label={t("storageHygiene.plan.title")}>
                <h3 class="ws-storage-heading">{t("storageHygiene.plan.title")}</h3>
                <p class="ws-storage-muted">{t("storageHygiene.plan.description", { minutes: props.recentMinutes })}</p>
                <Show
                  when={plan().length > 0}
                  fallback={<p class="ws-storage-muted">{t("storageHygiene.plan.empty")}</p>}
                >
                  <ul class="ws-storage-plan">
                    <For each={plan()} keyed={(group) => group.rule}>
                      {(group) => (
                        <PlanRule
                          group={group()}
                          selected={selected()}
                          disabled={busy()}
                          staleIdleHours={props.staleIdleHours}
                          evidenceDeleteAfterDays={props.evidenceDeleteAfterDays}
                          areaName={props.areaName}
                          onToggle={(items, on) => setSelected((current) => toggleSelection(current, items, on))}
                        />
                      )}
                    </For>
                  </ul>
                  <Show when={report().itemsTruncated}>
                    <p class="ws-storage-muted">{t("storageHygiene.plan.truncated")}</p>
                  </Show>
                  <div class="ws-storage-actions">
                    <Button
                      variant="destructive"
                      disabled={busy() || total().count === 0}
                      onClick={() => {
                        setError(null);
                        setConfirming(true);
                      }}
                    >
                      {t("storageHygiene.cleanup.button", { size: format.fileSize(total().bytes) })}
                    </Button>
                    <span class="ws-storage-muted">{t("storageHygiene.plan.items", { count: total().count })}</span>
                  </div>
                </Show>
              </section>
            </>
          )}
        </Show>
        <Show when={props.lastCleanup}>{(result) => <LastCleanup result={result()} />}</Show>
      </div>
      <ConfirmDialog
        open={confirming()}
        onCancel={() => setConfirming(false)}
        onConfirm={cleanup}
        title={t("storageHygiene.cleanup.confirmTitle", { size: format.fileSize(total().bytes) })}
        description={t("storageHygiene.cleanup.confirmDescription", {
          count: total().count,
          minutes: props.recentMinutes,
        })}
        confirmLabel={t("storageHygiene.cleanup.confirm")}
        pendingLabel={t("storageHygiene.cleanup.pending")}
        error={error() ?? undefined}
      />
    </section>
  );
}

function areaLabel(
  name: (area: StorageHygieneArea) => string,
  area: StorageHygieneArea | undefined,
  fallback: string,
): string {
  return area ? name(area) : fallback;
}

function DiskGauge(props: { report: StorageHygieneReport }): JSX.Element {
  const { t, format } = useText();
  const disk = () => props.report.disk;
  const used = () => {
    const { totalBytes, freeBytes } = disk();
    return totalBytes !== null && freeBytes !== null ? Math.max(0, totalBytes - freeBytes) : null;
  };
  const percent = () => {
    const total = disk().totalBytes;
    const value = used();
    return total && value !== null ? Math.min(100, (value / total) * 100) : null;
  };
  return (
    <section class="ws-storage-disk" aria-label={t("storageHygiene.disk.label")}>
      <Show when={percent() !== null} fallback={<p class="ws-storage-muted">{t("storageHygiene.disk.unknown")}</p>}>
        <div class="ws-storage-disk-copy">
          <span class="ws-storage-disk-percent">
            {format.percent((percent() ?? 0) / 100, { maximumFractionDigits: 0 })}
          </span>
          <span class="ws-storage-muted">
            {t("storageHygiene.disk.summary", {
              used: format.fileSize(used() ?? 0),
              total: format.fileSize(disk().totalBytes ?? 0),
              free: format.fileSize(disk().freeBytes ?? 0),
            })}
          </span>
        </div>
        <Progress
          class="ws-storage-gauge"
          data-level={(percent() ?? 0) >= 95 ? "danger" : (percent() ?? 0) >= 85 ? "warning" : undefined}
          value={percent() ?? 0}
          aria-label={t("storageHygiene.disk.label")}
        />
      </Show>
    </section>
  );
}

function ClassLegend(): JSX.Element {
  const { t } = useText();
  return (
    <ul class="ws-storage-legend">
      <For each={STORAGE_HYGIENE_CLASSES}>
        {(kind) => (
          <li class="ws-storage-legend-item" data-class={kind}>
            <span class="ws-storage-swatch" aria-hidden="true" />
            {t(CLASS_LABEL[kind])}
          </li>
        )}
      </For>
    </ul>
  );
}

/** One stacked bar of the four classes. `scale` is its width against the largest row. */
function ClassBar(props: { breakdown: StorageHygieneBreakdown; scale: number }): JSX.Element {
  const { t, format } = useText();
  const label = () =>
    STORAGE_HYGIENE_CLASSES.map((kind) => `${t(CLASS_LABEL[kind])} ${format.fileSize(props.breakdown[kind])}`).join(
      ", ",
    );
  return (
    <span class="ws-storage-bar" role="img" aria-label={label()}>
      <span class="ws-storage-bar-fill" style={{ width: `${Math.max(2, Math.round(props.scale * 100))}%` }}>
        <For each={STORAGE_HYGIENE_CLASSES}>
          {(kind) => (
            <Show when={props.breakdown[kind] > 0}>
              <span
                class="ws-storage-bar-segment"
                data-class={kind}
                style={{ "flex-grow": String(props.breakdown[kind]) }}
              />
            </Show>
          )}
        </For>
      </span>
    </span>
  );
}

/** A checkbox that shows "some" as the mixed state. */
function GroupCheckbox(props: {
  state: "all" | "some" | "none";
  label: string;
  disabled: boolean;
  onChange: (on: boolean) => void;
}): JSX.Element {
  let input: HTMLInputElement | undefined;
  createEffect(
    () => props.state,
    (state) => {
      if (input) input.indeterminate = state === "some";
    },
  );
  return (
    <Checkbox
      ref={(element: HTMLInputElement) => {
        input = element;
        element.indeterminate = props.state === "some";
      }}
      checked={props.state === "all"}
      aria-checked={props.state === "some" ? "mixed" : props.state === "all" ? "true" : "false"}
      aria-label={props.label}
      disabled={props.disabled}
      onChange={(event) => props.onChange(event.currentTarget.checked)}
    />
  );
}

function PlanRule(props: {
  group: StoragePlanRule;
  selected: ReadonlySet<string>;
  disabled: boolean;
  staleIdleHours: number;
  evidenceDeleteAfterDays: number;
  areaName: (area: StorageHygieneArea) => string;
  onToggle: (items: readonly StorageHygieneItem[], on: boolean) => void;
}): JSX.Element {
  const { t, format } = useText();
  const [open, setOpen] = createSignal(false);
  const description = () => {
    switch (props.group.rule) {
      case "cargo-target":
        return t("storageHygiene.rule.cargo-target.description");
      case "node-modules":
        return t("storageHygiene.rule.node-modules.description");
      case "godot-cache":
        return t("storageHygiene.rule.godot-cache.description");
      case "build-output":
        return t("storageHygiene.rule.build-output.description");
      case "repo-copy":
        return t("storageHygiene.rule.repo-copy.description");
      case "build-export":
        return t("storageHygiene.rule.build-export.description");
      case "stale-worktree":
        return t("storageHygiene.rule.stale-worktree.description", { hours: props.staleIdleHours });
      case "stale-copy":
        return t("storageHygiene.rule.stale-copy.description", { hours: props.staleIdleHours });
      case "evidence-media":
        return t("storageHygiene.rule.evidence-media.description", { days: props.evidenceDeleteAfterDays });
    }
  };
  return (
    <li class="ws-storage-rule" data-class={props.group.rule === "evidence-media" ? "evidence" : undefined}>
      <div class="ws-storage-rule-header">
        <GroupCheckbox
          state={selectionState(props.group.items, props.selected)}
          label={t(RULE_LABEL[props.group.rule])}
          disabled={props.disabled}
          onChange={(on) => props.onToggle(props.group.items, on)}
        />
        <span class="ws-storage-rule-copy">
          <span class="ws-storage-rule-title">{t(RULE_LABEL[props.group.rule])}</span>
          <span class="ws-storage-muted">{description()}</span>
        </span>
        <span class="ws-storage-row-size">{format.fileSize(props.group.bytes)}</span>
        <Button
          size="xs"
          variant="ghost"
          aria-expanded={open() ? "true" : "false"}
          onClick={() => setOpen((value) => !value)}
        >
          {open() ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          {t("storageHygiene.plan.items", { count: props.group.items.length })}
        </Button>
      </div>
      <ul class="ws-storage-rule-areas">
        <For each={props.group.areas} keyed={(area) => area.areaId}>
          {(area) => (
            <li class="ws-storage-rule-area">
              <div class="ws-storage-rule-area-header">
                <GroupCheckbox
                  state={selectionState(area().items, props.selected)}
                  label={`${t(RULE_LABEL[props.group.rule])}: ${areaLabel(props.areaName, area().area, area().areaId)}`}
                  disabled={props.disabled}
                  onChange={(on) => props.onToggle(area().items, on)}
                />
                <span class="ws-truncate">{areaLabel(props.areaName, area().area, area().areaId)}</span>
                <span class="ws-storage-muted">{t("storageHygiene.plan.items", { count: area().items.length })}</span>
                <span class="ws-storage-row-size">{format.fileSize(area().bytes)}</span>
              </div>
              <Show when={open()}>
                <ul class="ws-storage-items">
                  <For each={area().items.slice(0, ITEM_ROWS)} keyed={(item) => item.id}>
                    {(item) => <PlanItem item={item()} />}
                  </For>
                  <Show when={area().items.length > ITEM_ROWS}>
                    <li class="ws-storage-muted">
                      {t("storageHygiene.plan.more", { count: area().items.length - ITEM_ROWS })}
                    </li>
                  </Show>
                </ul>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </li>
  );
}

function PlanItem(props: { item: StorageHygieneItem }): JSX.Element {
  const { t, format } = useText();
  const recent = useRecentTime();
  return (
    <li class="ws-storage-item">
      <span class="ws-storage-path ws-truncate" title={props.item.path}>
        {props.item.path}
      </span>
      <span class="ws-storage-muted">
        {props.item.nestedIn
          ? t("storageHygiene.plan.nested")
          : t("storageHygiene.plan.changed", { time: recent(props.item.modifiedAt) })}
      </span>
      <span class="ws-storage-row-size">{format.fileSize(props.item.bytes)}</span>
    </li>
  );
}

function LastCleanup(props: { result: StorageHygieneCleanupResult }): JSX.Element {
  const { t, format } = useText();
  const recent = useRecentTime();
  return (
    <section class="ws-storage-section ws-storage-last" aria-label={t("storageHygiene.last.title")}>
      <h3 class="ws-storage-heading">{t("storageHygiene.last.title")}</h3>
      <p>
        {t("storageHygiene.last.summary", {
          size: format.fileSize(props.result.freedBytes + props.result.convertedSavedBytes),
          time: recent(props.result.finishedAt),
        })}
      </p>
      <p class="ws-storage-muted">
        {[
          t("storageHygiene.last.deleted", { count: props.result.deleted }),
          ...(props.result.skippedCount
            ? [t("storageHygiene.last.skipped", { count: props.result.skippedCount })]
            : []),
          ...(props.result.converted ? [t("storageHygiene.last.converted", { count: props.result.converted })] : []),
          props.result.trigger === "automatic"
            ? t("storageHygiene.last.automatic")
            : t("storageHygiene.last.manual", { name: props.result.actor ?? "" }),
        ].join(" · ")}
      </p>
      <Show when={props.result.skipped.length > 0}>
        <ul class="ws-storage-items">
          <For each={props.result.skipped.slice(0, SKIPPED_ROWS)}>
            {(skip) => (
              <li class="ws-storage-item">
                <span class="ws-storage-path ws-truncate" title={skip.path}>
                  {skip.path}
                </span>
                <span class="ws-storage-muted">{t(RULE_LABEL[skip.rule])}</span>
                <span class="ws-storage-skip">{t(SKIP_LABEL[skip.reason])}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
