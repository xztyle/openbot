import type {
  CloudBrowseResult,
  CloudConnectInput,
  CloudConnectResult,
  CloudFolderList,
  CloudGroup,
  CloudInterval,
  CloudPlan,
  CloudSnapshot,
  CloudSnapshotsResult,
  HostCloudBackupsOverview,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import { CLOUD_GROUPS, CLOUD_INTERVALS } from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  FormDialog,
  History,
  Input,
  NativeSelect,
  Progress,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  SwitchField,
  Text,
  TriangleAlert,
} from "@openbot/ui";
import { SettingsSaveBar } from "@openbot/ui/features/settings/SettingsDialogShell";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { GROUP_TEXT, PROBLEM_TEXT } from "./cloud-backups-text";
import { CloudFolderDialog, CloudRestoreDialog } from "./ServerCloudBackupsDialogs";

/** The `host-cloud-backups-v1` calls of one server's host. */
export interface HostCloudBackupsCalls {
  overview: (serverId: string) => Promise<HostCloudBackupsOverview>;
  connect: (input: CloudConnectInput, serverId: string) => Promise<CloudConnectResult>;
  disconnect: (id: string, serverId: string) => Promise<HostCloudBackupsOverview>;
  savePlan: (plan: CloudPlan, serverId: string) => Promise<HostCloudBackupsOverview>;
  passwordSaved: (serverId: string) => Promise<HostCloudBackupsOverview>;
  run: (kind: "backup" | "test", serverId: string) => Promise<HostCloudBackupsOverview>;
  snapshots: (serverId: string) => Promise<CloudSnapshotsResult>;
  restore: (
    snapshot: string,
    pick: { groups?: CloudGroup[]; paths?: string[] },
    serverId: string,
  ) => Promise<HostCloudBackupsOverview>;
  prepareRestore: (restoreId: string, serverId: string) => Promise<{ backupId: string }>;
  folders: (path: string, create: boolean, serverId: string) => Promise<CloudFolderList>;
  changeFolder: (
    folder: string,
    mode: "move" | "use",
    repositoryPassword: string | undefined,
    serverId: string,
  ) => Promise<CloudConnectResult>;
  browse: (snapshot: string, path: string, serverId: string) => Promise<CloudBrowseResult>;
  apply: (restoreId: string, serverId: string) => Promise<{ started: boolean; backupId: string }>;
}

type Ready = Extract<HostCloudBackupsOverview, { available: true }>;

const BUSY_POLL_MS = 5000;
const IDLE_POLL_MS = 60_000;

const INTERVAL_TEXT = {
  "15m": "backups.cloud.interval.quarter",
  "1h": "backups.cloud.interval.hourly",
  "6h": "backups.cloud.interval.sixHours",
  daily: "backups.cloud.interval.daily",
} as const satisfies Record<CloudInterval, string>;

const RETENTION_FIELDS = [
  ["allWithinHours", "backups.cloud.plan.keepAll"],
  ["daily", "backups.cloud.plan.keepDaily"],
  ["weekly", "backups.cloud.plan.keepWeekly"],
  ["monthly", "backups.cloud.plan.keepMonthly"],
] as const;

const copyPlan = (plan: CloudPlan): CloudPlan => ({
  ...plan,
  groups: { ...plan.groups },
  retention: { ...plan.retention },
});

/**
 * Server settings > Backups > Copy in the cloud: the owner's drive (Proton Drive today), the plan
 * (how often, what, how long), the status with the weekly restore test, and a restore that only
 * downloads a copy into its own folder on the server. The host's backup broker does the work.
 */
export function ServerCloudBackupsPanel(props: {
  calls: HostCloudBackupsCalls;
  serverId: string;
  /** The owner connects, changes the plan and restores; an admin sees the status and starts a copy. */
  canManage: boolean;
  actionsAvailable: boolean;
  /** A cloud copy became a local backup: the list above reads again. */
  onPrepared?: () => void;
  /** The server's name, for the default drive folder "Atelier Backups/<name>". */
  hostName?: string;
}) {
  /** The prefix of the ids that tie each plan row's label to its field. */
  const ids = createUniqueId();
  const { t, errorMessage, format } = useText();
  const [overview, setOverview] = createSignal<HostCloudBackupsOverview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [plan, setPlan] = createSignal<CloudPlan | null>(null);
  const [planDirty, setPlanDirty] = createSignal(false);
  // The sign-in form outlives a redraw or a remount of this panel (`connectDrafts`).
  const [connectOpen, setConnectOpenState] = createSignal(untrack(() => connectDraft(props.serverId).open));
  const setConnectOpen = (open: boolean) => {
    connectDraft(props.serverId).open = open;
    setConnectOpenState(open);
  };
  const [password, setPassword] = createSignal<string | null>(null);
  const [passwordKept, setPasswordKept] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [snapshots, setSnapshots] = createSignal<CloudSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal<CloudSnapshot | null>(null);
  const [folderOpen, setFolderOpen] = createSignal(false);
  const [applying, setApplying] = createSignal<{ id: string; finishedAt: string } | null>(null);
  const [applyUnderstood, setApplyUnderstood] = createSignal(false);
  const [applyError, setApplyError] = createSignal<string | null>(null);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ready = (): Ready | null => {
    const value = overview();
    return value?.available ? value : null;
  };

  function accept(next: HostCloudBackupsOverview): void {
    setOverview(next);
    if (next.available && !planDirty()) setPlan(copyPlan(next.plan));
  }

  /** `busy` comes from the answer just read: a signal written now still reads its old value. */
  function schedule(busy = Boolean(untrack(ready)?.running || untrack(loadError))): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void read(), busy ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  /** A dialog is open: the owner is typing or reading, so the host is not read until it closes. */
  const dialogOpen = () =>
    connectOpen() ||
    password() !== null ||
    disconnecting() ||
    restoring() !== null ||
    folderOpen() ||
    applying() !== null;

  async function read(): Promise<void> {
    const current = generation;
    if (untrack(dialogOpen)) return schedule();
    try {
      const next = await props.calls.overview(props.serverId);
      if (current !== generation) return;
      accept(next);
      setLoadError(null);
      schedule(next.available && next.running !== null);
    } catch (error) {
      if (current !== generation) return;
      setLoadError(errorMessage(error, t("backups.cloud.loadFailed")));
      schedule(true);
    }
  }

  createEffect(
    () => props.serverId,
    () => {
      generation += 1;
      setOverview(null);
      setPlanDirty(false);
      setSnapshots(null);
      void untrack(read);
    },
  );
  onCleanup(() => {
    generation += 1;
    if (timer) clearTimeout(timer);
  });

  async function act(name: string, run: () => Promise<HostCloudBackupsOverview>, done?: string): Promise<void> {
    if (busy()) return;
    setBusy(name);
    try {
      const next = await run();
      accept(next);
      if (done) actionToast.success(done);
      // A job just started: read again soon.
      schedule(true);
    } catch (error) {
      actionToast.error(t("backups.cloud.startFailed"), {
        description: errorMessage(error, t("backups.cloud.problem.other")),
      });
    } finally {
      setBusy(null);
    }
  }

  const ago = (iso: string | null | undefined): string => {
    const at = iso ? Date.parse(iso) : Number.NaN;
    if (!Number.isFinite(at)) return "";
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
    if (minutes < 1) return t("backups.cloud.ago.now");
    if (minutes < 60) return t("backups.cloud.ago.minutes", { count: minutes });
    if (minutes < 48 * 60) return t("backups.cloud.ago.hours", { count: Math.round(minutes / 60) });
    return t("backups.cloud.ago.days", { count: Math.round(minutes / 1440) });
  };
  const duration = (seconds: number): string =>
    seconds < 90
      ? t("backups.cloud.duration.seconds", { count: Math.max(1, Math.round(seconds)) })
      : t("backups.cloud.duration.minutes", { count: Math.round(seconds / 60) });
  const when = (iso: string): string => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : format.date(date, { dateStyle: "medium", timeStyle: "short" });
  };
  const sizeOf = (group: CloudGroup): number | null => ready()?.sizes.find((row) => row.group === group)?.bytes ?? null;
  /** "Next copy at 15:00" while the plan runs, "paused" while it does not; nothing until the host knows. */
  const nextRun = (value: Ready): string | null =>
    value.plan.enabled
      ? value.nextRunAt
        ? t("backups.cloud.next", { time: format.date(new Date(value.nextRunAt), { timeStyle: "short" }) })
        : null
      : t("backups.cloud.paused");
  const typical = (value: Ready): string | undefined =>
    value.typical
      ? t("backups.cloud.typical", {
          duration: duration(value.typical.seconds),
          size: format.fileSize(value.typical.addedBytes),
        })
      : undefined;
  /** The technical text of a failed run, behind a closed "technical details" the owner opens. */
  const technical = (detail: string | null | undefined) =>
    detail ? (
      <details>
        <summary>{t("backups.cloud.technical")}</summary>
        <Text as="p" variant="caption" tone="muted">
          {detail}
        </Text>
      </details>
    ) : undefined;

  async function loadSnapshots(): Promise<void> {
    setSnapshotsError(null);
    setBusy("snapshots");
    try {
      const result = await props.calls.snapshots(props.serverId);
      setSnapshots(result.snapshots);
      if (!result.ok) setSnapshotsError(t(PROBLEM_TEXT[result.problem]));
    } catch (error) {
      setSnapshotsError(errorMessage(error, t("backups.cloud.copiesFailed")));
    } finally {
      setBusy(null);
    }
  }

  async function restore(pick: { groups?: CloudGroup[]; paths?: string[] }): Promise<void> {
    const snapshot = restoring();
    if (!snapshot) return;
    accept(await props.calls.restore(snapshot.id, pick, props.serverId));
    setRestoring(null);
    actionToast.success(t("backups.cloud.restoreStarted"));
    schedule(true);
  }

  async function apply(): Promise<void> {
    const target = applying();
    if (!target || !applyUnderstood()) return;
    setApplyError(null);
    try {
      await props.calls.apply(target.id, props.serverId);
      setApplying(null);
      actionToast.success(t("backups.cloud.applyStarted"));
      props.onPrepared?.();
    } catch (error) {
      setApplyError(errorMessage(error, t("backups.cloud.problem.other")));
    }
  }

  const editPlan = (change: (draft: CloudPlan) => void) => {
    const current = plan();
    if (!current) return;
    const draft = copyPlan(current);
    change(draft);
    setPlan(draft);
    setPlanDirty(true);
  };
  const disabled = () => !props.actionsAvailable || Boolean(busy());
  const manageDisabled = () => disabled() || !props.canManage;

  return (
    <>
      <Show when={ready()}>
        {(value) => (
          <SettingsSection title={t("backups.cloud.title")} description={t("backups.cloud.description")}>
            <Show when={loadError()}>
              {(error) => (
                <Alert tone="danger" role="alert">
                  <AlertIcon>
                    <TriangleAlert />
                  </AlertIcon>
                  <AlertContent>
                    <AlertDescription>{error()}</AlertDescription>
                  </AlertContent>
                </Alert>
              )}
            </Show>
            <Show when={value().warnings.includes("password-not-saved")}>
              <Alert tone="warning" role="status">
                <AlertContent>
                  <AlertDescription>{t("backups.cloud.warning.passwordNotSaved")}</AlertDescription>
                </AlertContent>
                <Show when={props.canManage}>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={disabled()}
                    onClick={() => void act("saved", () => props.calls.passwordSaved(props.serverId))}
                  >
                    {t("backups.cloud.warning.passwordSaved")}
                  </Button>
                </Show>
              </Alert>
            </Show>
            <Show when={value().warnings.includes("relogin")}>
              <Alert tone="danger" role="alert">
                <AlertContent>
                  <AlertDescription>{t("backups.cloud.problem.relogin")}</AlertDescription>
                </AlertContent>
                <Show when={props.canManage}>
                  <Button type="button" size="sm" disabled={disabled()} onClick={() => setConnectOpen(true)}>
                    {t("backups.cloud.relogin")}
                  </Button>
                </Show>
              </Alert>
            </Show>
            <For
              each={value().warnings.filter(
                (warning) => warning === "stale" || warning === "drive-nearly-full" || warning === "test-failed",
              )}
            >
              {(warning) => (
                <Alert tone="warning" role="status">
                  <AlertContent>
                    <AlertDescription>
                      {warning === "stale"
                        ? t("backups.cloud.warning.stale")
                        : warning === "drive-nearly-full"
                          ? value().plan.retention.keepAll
                            ? t("backups.cloud.warning.fullSaveSpace")
                            : t("backups.cloud.warning.full")
                          : t("backups.cloud.warning.testFailed")}
                    </AlertDescription>
                  </AlertContent>
                </Alert>
              )}
            </For>

            <SettingsGroup
              title={t("backups.cloud.destinations")}
              description={props.canManage ? undefined : t("backups.cloud.ownerOnly")}
            >
              <Show
                when={value().destinations[0]}
                fallback={
                  <SettingsRow label={t("backups.cloud.provider.proton")} description={t("backups.cloud.notConnected")}>
                    <Show when={props.canManage}>
                      <Button type="button" size="sm" disabled={manageDisabled()} onClick={() => setConnectOpen(true)}>
                        {t("backups.cloud.connectProton")}
                      </Button>
                    </Show>
                  </SettingsRow>
                }
              >
                {(drive) => (
                  <SettingsRow
                    label={
                      <>
                        {t("backups.cloud.provider.proton")}
                        <Show when={drive().status === "relogin"}>
                          {" "}
                          <Badge variant="destructive-light">{t("backups.cloud.relogin")}</Badge>
                        </Show>
                      </>
                    }
                    description={
                      <>
                        {drive().account}
                        <Show when={drive().space}>
                          {(space) => (
                            <>
                              {" · "}
                              {space().freeBytes === null
                                ? t("backups.cloud.spaceUsed", { used: format.fileSize(space().usedBytes) })
                                : t("backups.cloud.space", {
                                    used: format.fileSize(space().usedBytes),
                                    free: format.fileSize(space().freeBytes ?? 0),
                                  })}
                            </>
                          )}
                        </Show>
                      </>
                    }
                    help={drive().folder ? t("backups.cloud.folder", { folder: drive().folder ?? "" }) : undefined}
                  >
                    <Show when={props.canManage}>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={manageDisabled() || value().running !== null || drive().status !== "ok"}
                        onClick={() => setFolderOpen(true)}
                      >
                        {t("backups.cloud.changeFolder")}
                      </Button>
                      <Show when={drive().status === "relogin"}>
                        <Button
                          type="button"
                          size="sm"
                          disabled={manageDisabled()}
                          onClick={() => setConnectOpen(true)}
                        >
                          {t("backups.cloud.relogin")}
                        </Button>
                      </Show>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={manageDisabled()}
                        onClick={() => setDisconnecting(true)}
                      >
                        {t("backups.cloud.disconnect")}
                      </Button>
                    </Show>
                  </SettingsRow>
                )}
              </Show>
              <For each={["googleDrive", "onedrive"] as const}>
                {(provider) => (
                  <SettingsRow
                    label={
                      provider === "googleDrive"
                        ? t("backups.cloud.provider.googleDrive")
                        : t("backups.cloud.provider.onedrive")
                    }
                    layout="inline"
                  >
                    <Badge variant="secondary">{t("backups.cloud.soon")}</Badge>
                  </SettingsRow>
                )}
              </For>
            </SettingsGroup>

            <Show when={value().destinations[0]}>
              <SettingsGroup title={t("backups.cloud.status")} description={t("backups.cloud.incremental")}>
                <SettingsRow
                  label={
                    value().lastSuccessAt
                      ? t("backups.cloud.lastCopy", { ago: ago(value().lastSuccessAt) })
                      : t("backups.cloud.never")
                  }
                  description={
                    <Show when={value().lastBackup}>
                      {(run) =>
                        run().ok
                          ? t("backups.cloud.lastCopyDetail", {
                              size: format.fileSize(run().totalBytes),
                              added: format.fileSize(run().addedBytes),
                              duration: duration(run().seconds),
                            })
                          : `${t("backups.cloud.lastFailed", { ago: ago(run().finishedAt) })} ${t(PROBLEM_TEXT[run().problem ?? "other"])}`
                      }
                    </Show>
                  }
                  help={technical(value().lastBackup?.detail)}
                >
                  <Button
                    type="button"
                    size="sm"
                    loading={busy() === "backup" || value().running?.kind === "backup"}
                    disabled={disabled() || value().running !== null}
                    onClick={() =>
                      void act("backup", () => props.calls.run("backup", props.serverId), t("backups.cloud.started"))
                    }
                  >
                    {t("backups.backUpNow")}
                  </Button>
                </SettingsRow>
                <Show when={value().running}>
                  {(job) => (
                    <SettingsRow
                      layout="stack"
                      aria-live="polite"
                      label={
                        job().kind === "test"
                          ? t("backups.cloud.running.test")
                          : job().kind === "restore"
                            ? t("backups.cloud.running.restore")
                            : job().kind === "move"
                              ? t("backups.cloud.running.move")
                              : t("backups.cloud.running.backup")
                      }
                      description={
                        <Show when={job().progress}>
                          {(progress) =>
                            progress().totalBytes > 0
                              ? t("backups.cloud.progress", {
                                  done: format.fileSize(progress().bytesDone),
                                  total: format.fileSize(progress().totalBytes),
                                  speed: format.fileSize(progress().bytesPerSecond),
                                  left: duration(progress().secondsRemaining),
                                })
                              : t("backups.cloud.progressNoTotal", {
                                  done: format.fileSize(progress().bytesDone),
                                  speed: format.fileSize(progress().bytesPerSecond),
                                })
                          }
                        </Show>
                      }
                    >
                      <Show when={job().progress}>
                        {(progress) => (
                          <Progress
                            value={progress().bytesDone}
                            maxValue={Math.max(progress().totalBytes, progress().bytesDone, 1)}
                            aria-label={t("backups.cloud.running.backup")}
                          />
                        )}
                      </Show>
                    </SettingsRow>
                  )}
                </Show>
                <Show when={nextRun(value()) || value().typical}>
                  <SettingsRow
                    label={nextRun(value()) ?? typical(value())}
                    description={nextRun(value()) ? typical(value()) : undefined}
                  />
                </Show>
                <SettingsRow
                  label={
                    value().lastTest
                      ? value().lastTest?.ok
                        ? t("backups.cloud.testOk", { ago: ago(value().lastTest?.finishedAt) })
                        : t("backups.cloud.testFailed", { ago: ago(value().lastTest?.finishedAt) })
                      : t("backups.cloud.testNever")
                  }
                  description={
                    value().lastTest && !value().lastTest?.ok
                      ? t(PROBLEM_TEXT[value().lastTest?.problem ?? "other"])
                      : undefined
                  }
                  help={technical(value().lastTest?.detail)}
                >
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busy() === "test" || value().running?.kind === "test"}
                    disabled={disabled() || value().running !== null}
                    onClick={() =>
                      void act("test", () => props.calls.run("test", props.serverId), t("backups.cloud.testStarted"))
                    }
                  >
                    {t("backups.cloud.testNow")}
                  </Button>
                </SettingsRow>
              </SettingsGroup>

              <Show when={plan()}>
                {(draft) => (
                  <>
                    <SettingsGroup title={t("backups.cloud.plan")}>
                      <SwitchField
                        label={t("backups.cloud.plan.enabled")}
                        checked={draft().enabled}
                        disabled={manageDisabled()}
                        onChange={(checked: boolean) => editPlan((next) => (next.enabled = checked))}
                      />
                      <SettingsRow label={t("backups.cloud.plan.frequency")} controlId={`${ids}-frequency`}>
                        <NativeSelect
                          id={`${ids}-frequency`}
                          value={draft().interval}
                          disabled={manageDisabled()}
                          onChange={(event) => {
                            const interval = CLOUD_INTERVALS.find((item) => item === event.currentTarget.value);
                            if (interval) editPlan((next) => (next.interval = interval));
                          }}
                        >
                          <For each={["15m", "1h", "6h", "daily"] as const}>
                            {(interval) => <option value={interval}>{t(INTERVAL_TEXT[interval])}</option>}
                          </For>
                        </NativeSelect>
                      </SettingsRow>
                      <Show when={draft().interval === "daily"}>
                        <SettingsRow
                          label={t("backups.cloud.plan.time", { zone: draft().timezone })}
                          controlId={`${ids}-time`}
                        >
                          <Input
                            id={`${ids}-time`}
                            type="time"
                            size="sm"
                            value={draft().dailyTime}
                            disabled={manageDisabled()}
                            onValueChange={(time) => editPlan((next) => (next.dailyTime = time))}
                          />
                        </SettingsRow>
                      </Show>
                    </SettingsGroup>
                    <SettingsGroup title={t("backups.cloud.plan.what")}>
                      <For each={CLOUD_GROUPS}>
                        {(group) => (
                          <SwitchField
                            label={t(GROUP_TEXT[group][0])}
                            description={`${t(GROUP_TEXT[group][1])} ${
                              sizeOf(group) === null
                                ? t("backups.cloud.sizeUnknown")
                                : t("backups.cloud.groupSize", { size: format.fileSize(sizeOf(group) ?? 0) })
                            }`}
                            checked={draft().groups[group]}
                            disabled={manageDisabled()}
                            onChange={(checked: boolean) => editPlan((next) => (next.groups[group] = checked))}
                          />
                        )}
                      </For>
                    </SettingsGroup>
                    <SettingsGroup title={t("backups.cloud.plan.keep")}>
                      <SwitchField
                        label={t("backups.cloud.plan.saveSpace")}
                        description={t("backups.cloud.plan.saveSpaceHint")}
                        checked={!draft().retention.keepAll}
                        disabled={manageDisabled()}
                        onChange={(checked: boolean) => editPlan((next) => (next.retention.keepAll = !checked))}
                      />
                      <For each={draft().retention.keepAll ? [] : RETENTION_FIELDS}>
                        {([key, label]) => (
                          <SettingsRow label={t(label)} controlId={`${ids}-${key}`}>
                            <Input
                              id={`${ids}-${key}`}
                              class="settings-cloud-number"
                              type="number"
                              size="sm"
                              inputmode="numeric"
                              min="0"
                              value={String(draft().retention[key])}
                              disabled={manageDisabled()}
                              onValueChange={(raw) =>
                                editPlan((next) => (next.retention[key] = Math.max(0, Math.round(Number(raw) || 0))))
                              }
                            />
                          </SettingsRow>
                        )}
                      </For>
                      <SettingsRow label={t("backups.cloud.plan.largeFiles")} controlId={`${ids}-large`}>
                        <Input
                          id={`${ids}-large`}
                          class="settings-cloud-number"
                          type="number"
                          size="sm"
                          inputmode="numeric"
                          min="0"
                          value={String(draft().largeFileMb)}
                          disabled={manageDisabled()}
                          onValueChange={(raw) =>
                            editPlan((next) => (next.largeFileMb = Math.max(0, Math.round(Number(raw) || 0))))
                          }
                        />
                      </SettingsRow>
                      <Show when={props.canManage && planDirty()}>
                        <SettingsSaveBar
                          label={t("backups.cloud.plan")}
                          saving={busy() === "plan"}
                          saveDisabled={manageDisabled()}
                          resetDisabled={Boolean(busy())}
                          onReset={() => {
                            const current = ready();
                            if (!current) return;
                            setPlan(copyPlan(current.plan));
                            setPlanDirty(false);
                          }}
                          onSave={() =>
                            void act(
                              "plan",
                              async () => {
                                const next = await props.calls.savePlan(draft(), props.serverId);
                                setPlanDirty(false);
                                return next;
                              },
                              t("backups.cloud.plan.saved"),
                            )
                          }
                        />
                      </Show>
                    </SettingsGroup>
                  </>
                )}
              </Show>

              <Show when={snapshotsError()}>
                {(error) => (
                  <Alert tone="danger" role="alert">
                    <AlertIcon>
                      <TriangleAlert />
                    </AlertIcon>
                    <AlertContent>
                      <AlertDescription>{error()}</AlertDescription>
                    </AlertContent>
                  </Alert>
                )}
              </Show>
              <SettingsGroup
                title={t("backups.cloud.restoreTitle")}
                description={t("backups.cloud.restoreDescription")}
                actions={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    loading={busy() === "snapshots"}
                    disabled={disabled()}
                    onClick={() => void loadSnapshots()}
                  >
                    {t("backups.cloud.showCopies")}
                  </Button>
                }
              >
                <For each={value().restores.slice().reverse()}>
                  {(row) => (
                    <SettingsRow
                      label={
                        row.status !== "ok"
                          ? t("backups.cloud.restoreFailedRow", { when: when(row.finishedAt) })
                          : row.partial
                            ? t("backups.cloud.restorePartialReady", { when: when(row.finishedAt) })
                            : t("backups.cloud.restoreReady", { when: when(row.finishedAt) })
                      }
                    >
                      <Show when={row.status === "ok" && props.canManage}>
                        <Show
                          when={!row.preparedAs}
                          fallback={<Badge variant="success-light">{t("backups.cloud.preparedBadge")}</Badge>}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={manageDisabled() || value().running !== null}
                            onClick={() => {
                              setApplyUnderstood(false);
                              setApplyError(null);
                              setApplying({ id: row.id, finishedAt: row.finishedAt });
                            }}
                          >
                            {t("backups.cloud.apply")}
                          </Button>
                        </Show>
                      </Show>
                    </SettingsRow>
                  )}
                </For>
                <Show when={snapshots()?.length === 0 && !snapshotsError()}>
                  <SettingsRow label={t("backups.cloud.noCopies")} />
                </Show>
                <For each={snapshots() ?? []}>
                  {(snapshot) => (
                    <SettingsRow
                      label={when(snapshot.time)}
                      description={`${format.fileSize(snapshot.bytes)} · ${
                        snapshot.groups.length
                          ? t("backups.cloud.copyGroups", {
                              groups: format.list(snapshot.groups.map((group) => t(GROUP_TEXT[group][0]))),
                            })
                          : t("backups.cloud.copyAll")
                      }`}
                    >
                      <Show when={props.canManage}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={manageDisabled() || value().running !== null}
                          onClick={() => setRestoring(snapshot)}
                        >
                          {t("backups.cloud.restore")}
                        </Button>
                      </Show>
                    </SettingsRow>
                  )}
                </For>
                <SettingsRow
                  label={t("backups.cloud.otherServerTitle")}
                  description={t("backups.cloud.otherServerDescription", {
                    folder: value().destinations[0]?.folder ?? "",
                  })}
                />
              </SettingsGroup>
            </Show>
          </SettingsSection>
        )}
      </Show>
      {/* The dialogs live outside the section that each poll redraws. */}
      <ProtonConnectDialog
        open={connectOpen()}
        serverId={props.serverId}
        account={ready()?.destinations[0]?.account ?? ""}
        folder={
          ready()?.destinations[0]?.folder || (props.hostName ? `Atelier Backups/${props.hostName}` : "Atelier Backups")
        }
        onClose={() => setConnectOpen(false)}
        connect={(input) => props.calls.connect(input, props.serverId)}
        onConnected={(result) => {
          setConnectOpen(false);
          if (!result.ok) return;
          accept(result.overview);
          actionToast.success(t("backups.cloud.connected"));
          if (result.repositoryPassword) {
            setPasswordKept(false);
            setPassword(result.repositoryPassword);
          }
        }}
      />

      <FormDialog
        open={password() !== null}
        onOpenChange={() => undefined}
        title={t("backups.cloud.password.title")}
        description={t("backups.cloud.password.description")}
        submitLabel={t("backups.cloud.password.done")}
        submitDisabled={!passwordKept()}
        hideSecondary
        onSubmit={() => {
          setPassword(null);
          void act("saved", () => props.calls.passwordSaved(props.serverId));
        }}
      >
        <Field label={t("backups.cloud.password.title")}>
          <Input size="sm" readonly value={password() ?? ""} />
        </Field>
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(password() ?? "")
                .then(() => actionToast.success(t("backups.cloud.password.copied")));
            }}
          >
            {t("backups.cloud.password.copy")}
          </Button>
        </div>
        <SettingsRow layout="inline" label={t("backups.cloud.password.confirm")} controlId={`${ids}-password-kept`}>
          <Checkbox
            id={`${ids}-password-kept`}
            checked={passwordKept()}
            onChange={(event) => setPasswordKept(event.currentTarget.checked)}
          />
        </SettingsRow>
      </FormDialog>

      <ConfirmDialog
        open={disconnecting()}
        onCancel={() => setDisconnecting(false)}
        tone="destructive"
        title={t("backups.cloud.disconnectTitle")}
        description={t("backups.cloud.disconnectDescription")}
        confirmLabel={t("backups.cloud.disconnect")}
        onConfirm={async () => {
          const id = ready()?.destinations[0]?.id;
          setDisconnecting(false);
          if (id) await act("disconnect", () => props.calls.disconnect(id, props.serverId));
        }}
      />

      <CloudRestoreDialog
        snapshot={restoring()}
        when={when}
        browse={(snapshot, path) => props.calls.browse(snapshot, path, props.serverId)}
        restore={restore}
        onClose={() => setRestoring(null)}
      />

      <CloudFolderDialog
        open={folderOpen()}
        current={ready()?.destinations[0]?.folder ?? ""}
        list={(path, create) => props.calls.folders(path, create, props.serverId)}
        choose={(folder, mode, repositoryPassword) =>
          props.calls.changeFolder(folder, mode, repositoryPassword, props.serverId)
        }
        onClose={() => setFolderOpen(false)}
        onChanged={(result, mode) => {
          setFolderOpen(false);
          if (result.ok) accept(result.overview);
          actionToast.success(mode === "move" ? t("backups.cloud.folderMoving") : t("backups.cloud.folderChanged"));
          schedule(true);
        }}
      />

      <ConfirmDialog
        open={applying() !== null}
        onCancel={() => setApplying(null)}
        tone="destructive"
        icon={<History />}
        title={t("backups.cloud.applyTitle", { when: when(applying()?.finishedAt ?? "") })}
        description={t("backups.cloud.applyDescription", { when: when(applying()?.finishedAt ?? "") })}
        confirmLabel={t("backups.cloud.applyConfirm")}
        error={applyError() ?? undefined}
        onConfirm={() => apply()}
      >
        <SettingsRow layout="inline" label={t("backups.cloud.applyUnderstand")} controlId={`${ids}-apply-understood`}>
          <Checkbox
            id={`${ids}-apply-understood`}
            checked={applyUnderstood()}
            onChange={(event) => setApplyUnderstood(event.currentTarget.checked)}
          />
        </SettingsRow>
      </ConfirmDialog>
    </>
  );
}

interface ConnectDraft {
  open: boolean;
  folder: string;
  email: string;
  password: string;
  code: string;
  twoPasswords: boolean;
  mailbox: string;
  repository: string;
  askRepository: boolean;
  problem: string | null;
}

/**
 * The sign-in form of each server, outside any component: a redraw or a remount of the settings page
 * (each poll, a reconnect) keeps what the owner typed. It is cleared after a sign-in and on Cancel.
 */
const connectDrafts = new Map<string, ConnectDraft>();
const emptyDraft = (): ConnectDraft => ({
  open: false,
  folder: "",
  email: "",
  password: "",
  code: "",
  twoPasswords: false,
  mailbox: "",
  repository: "",
  askRepository: false,
  problem: null,
});
function connectDraft(serverId: string): ConnectDraft {
  let draft = connectDrafts.get(serverId);
  if (!draft) {
    draft = emptyDraft();
    connectDrafts.set(serverId, draft);
  }
  return draft;
}

/** Sign in to Proton: email and password, the 2FA code once, and the mailbox password of two-password accounts. */
function ProtonConnectDialog(props: {
  open: boolean;
  serverId: string;
  /** The connected account, as the email to start from. */
  account: string;
  /** The drive folder to start from. */
  folder: string;
  onClose: () => void;
  connect: (input: CloudConnectInput) => Promise<CloudConnectResult>;
  onConnected: (result: CloudConnectResult) => void;
}) {
  const { t, errorMessage } = useText();
  const ids = createUniqueId();
  const [form, setForm] = createStore<ConnectDraft>({ ...untrack(() => connectDraft(props.serverId)) });
  const [pending, setPending] = createSignal(false);
  /** One field changed: the store redraws it, and the draft keeps it. */
  function set<K extends keyof ConnectDraft>(key: K, value: ConnectDraft[K]): void {
    setForm((state) => {
      state[key] = value;
    });
    connectDraft(props.serverId)[key] = value;
  }
  const email = () => form.email;
  const password = () => form.password;
  const code = () => form.code;
  const twoPasswords = () => form.twoPasswords;
  const mailbox = () => form.mailbox;
  const repository = () => form.repository;
  const askRepository = () => form.askRepository;
  const problem = () => form.problem;
  const setEmail = (value: string) => set("email", value);
  const setPassword = (value: string) => set("password", value);
  const setCode = (value: string) => set("code", value);
  const setTwoPasswords = (value: boolean) => set("twoPasswords", value);
  const setMailbox = (value: string) => set("mailbox", value);
  const setRepository = (value: string) => set("repository", value);
  const setAskRepository = (value: boolean) => set("askRepository", value);
  const setProblem = (value: string | null) => set("problem", value);

  // Opening starts from the connected account's email, unless the owner already typed one.
  createEffect(
    () => [props.open, props.account] as const,
    ([open, account]) => {
      if (open && !form.email && account) setEmail(account);
      if (open && !form.folder)
        set(
          "folder",
          untrack(() => props.folder),
        );
    },
  );
  function clear(): void {
    const keep = connectDraft(props.serverId).open;
    connectDrafts.set(props.serverId, { ...emptyDraft(), open: keep });
    setForm(() => ({ ...emptyDraft(), open: keep }));
  }

  async function submit(): Promise<void> {
    if (pending() || !email().trim() || !password()) return;
    setPending(true);
    setProblem(null);
    try {
      const result = await props.connect({
        provider: "proton",
        email: email().trim(),
        password: password(),
        ...(code().trim() ? { twoFactorCode: code().trim() } : {}),
        ...(twoPasswords() && mailbox() ? { mailboxPassword: mailbox() } : {}),
        ...(repository().trim() ? { repositoryPassword: repository().trim() } : {}),
        ...(form.folder.trim() ? { folder: form.folder.trim() } : {}),
      });
      if (result.ok) {
        clear();
        props.onConnected(result);
        return;
      }
      if (result.problem === "mailbox-password") setTwoPasswords(true);
      if (result.problem === "repository-password") setAskRepository(true);
      setProblem(t(PROBLEM_TEXT[result.problem]));
    } catch (error) {
      setProblem(errorMessage(error, t("backups.cloud.problem.other")));
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (open || pending()) return;
        clear();
        props.onClose();
      }}
      // A password manager's autofill popup is outside the dialog: a click on it must not close the form.
      dismissible={false}
      title={t("backups.cloud.connect.title")}
      description={t("backups.cloud.connect.description")}
      submitLabel={pending() ? t("backups.cloud.connect.busy") : t("backups.cloud.connect.submit")}
      submitDisabled={!email().trim() || !password()}
      busy={pending()}
      error={problem()}
      onSubmit={() => void submit()}
    >
      <Field label={t("backups.cloud.connect.email")}>
        <Input type="email" autocomplete="username" value={email()} onValueChange={setEmail} />
      </Field>
      <Field label={t("backups.cloud.connect.password")}>
        <Input
          type="password"
          autocomplete="current-password"
          value={password()}
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
      </Field>
      <Field label={t("backups.cloud.connect.folder")} description={t("backups.cloud.connect.folderHint")}>
        <Input value={form.folder} onValueChange={(value) => set("folder", value)} />
      </Field>
      <Field label={t("backups.cloud.connect.twoFactor")} description={t("backups.cloud.connect.twoFactorHint")}>
        <Input inputmode="numeric" autocomplete="one-time-code" maxlength={8} value={code()} onValueChange={setCode} />
      </Field>
      <SettingsRow layout="inline" label={t("backups.cloud.connect.twoPasswords")} controlId={`${ids}-two-passwords`}>
        <Checkbox
          id={`${ids}-two-passwords`}
          checked={twoPasswords()}
          onChange={(event) => setTwoPasswords(event.currentTarget.checked)}
        />
      </SettingsRow>
      <Show when={twoPasswords()}>
        <Field label={t("backups.cloud.connect.mailboxPassword")}>
          <Input type="password" value={mailbox()} onInput={(event) => setMailbox(event.currentTarget.value)} />
        </Field>
      </Show>
      <Show when={askRepository()}>
        <Field
          label={t("backups.cloud.connect.repositoryPassword")}
          description={t("backups.cloud.connect.repositoryPasswordHint")}
        >
          <Input type="password" value={repository()} onInput={(event) => setRepository(event.currentTarget.value)} />
        </Field>
      </Show>
    </FormDialog>
  );
}
