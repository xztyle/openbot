import type {
  CloudConnectInput,
  CloudConnectResult,
  CloudGroup,
  CloudInterval,
  CloudPlan,
  CloudProblem,
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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  NativeSelect,
  SettingsSection,
  SwitchField,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { actionToast } from "../../action-toast";

/** The `host-cloud-backups-v1` calls of one server's host. */
export interface HostCloudBackupsCalls {
  overview: (serverId: string) => Promise<HostCloudBackupsOverview>;
  connect: (input: CloudConnectInput, serverId: string) => Promise<CloudConnectResult>;
  disconnect: (id: string, serverId: string) => Promise<HostCloudBackupsOverview>;
  savePlan: (plan: CloudPlan, serverId: string) => Promise<HostCloudBackupsOverview>;
  passwordSaved: (serverId: string) => Promise<HostCloudBackupsOverview>;
  run: (kind: "backup" | "test", serverId: string) => Promise<HostCloudBackupsOverview>;
  snapshots: (serverId: string) => Promise<CloudSnapshotsResult>;
  restore: (snapshot: string, serverId: string) => Promise<HostCloudBackupsOverview>;
  prepareRestore: (restoreId: string, serverId: string) => Promise<{ backupId: string }>;
}

type Ready = Extract<HostCloudBackupsOverview, { available: true }>;

const BUSY_POLL_MS = 5000;
const IDLE_POLL_MS = 60_000;

const PROBLEM_TEXT = {
  "two-factor": "backups.cloud.problem.twoFactor",
  "mailbox-password": "backups.cloud.problem.mailboxPassword",
  credentials: "backups.cloud.problem.credentials",
  verification: "backups.cloud.problem.verification",
  "rate-limited": "backups.cloud.problem.rateLimited",
  relogin: "backups.cloud.problem.relogin",
  "repository-password": "backups.cloud.problem.repositoryPassword",
  "drive-full": "backups.cloud.problem.driveFull",
  network: "backups.cloud.problem.network",
  busy: "backups.cloud.problem.busy",
  "restore-test": "backups.cloud.problem.restoreTest",
  unavailable: "backups.cloud.problem.unavailable",
  other: "backups.cloud.problem.other",
} as const satisfies Record<CloudProblem, string>;

const INTERVAL_TEXT = {
  "15m": "backups.cloud.interval.quarter",
  "1h": "backups.cloud.interval.hourly",
  "6h": "backups.cloud.interval.sixHours",
  daily: "backups.cloud.interval.daily",
} as const satisfies Record<CloudInterval, string>;

const GROUP_TEXT = {
  database: ["backups.cloud.group.database", "backups.cloud.group.databaseHint"],
  conversations: ["backups.cloud.group.conversations", "backups.cloud.group.conversationsHint"],
  agents: ["backups.cloud.group.agents", "backups.cloud.group.agentsHint"],
  settings: ["backups.cloud.group.settings", "backups.cloud.group.settingsHint"],
  motion: ["backups.cloud.group.motion", "backups.cloud.group.motionHint"],
  work: ["backups.cloud.group.work", "backups.cloud.group.workHint"],
} as const satisfies Record<CloudGroup, readonly [string, string]>;

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
}) {
  const { t, errorMessage, format } = useText();
  const [overview, setOverview] = createSignal<HostCloudBackupsOverview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [plan, setPlan] = createSignal<CloudPlan | null>(null);
  const [planDirty, setPlanDirty] = createSignal(false);
  const [connectOpen, setConnectOpen] = createSignal(false);
  const [password, setPassword] = createSignal<string | null>(null);
  const [passwordKept, setPasswordKept] = createSignal(false);
  const [disconnecting, setDisconnecting] = createSignal(false);
  const [snapshots, setSnapshots] = createSignal<CloudSnapshot[] | null>(null);
  const [snapshotsError, setSnapshotsError] = createSignal<string | null>(null);
  const [restoring, setRestoring] = createSignal<CloudSnapshot | null>(null);
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
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

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void read(), ready()?.running || loadError() ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  async function read(): Promise<void> {
    const current = generation;
    try {
      const next = await props.calls.overview(props.serverId);
      if (current !== generation) return;
      accept(next);
      setLoadError(null);
    } catch (error) {
      if (current !== generation) return;
      setLoadError(errorMessage(error, t("backups.cloud.loadFailed")));
    }
    if (current === generation) schedule();
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
      accept(await run());
      if (done) actionToast.success(done);
      schedule();
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

  async function restore(): Promise<void> {
    const snapshot = restoring();
    if (!snapshot) return;
    setRestoreError(null);
    try {
      accept(await props.calls.restore(snapshot.id, props.serverId));
      setRestoring(null);
      actionToast.success(t("backups.cloud.restoreStarted"));
      schedule();
    } catch (error) {
      setRestoreError(errorMessage(error, t("backups.cloud.problem.other")));
    }
  }

  async function prepare(restoreId: string): Promise<void> {
    if (busy()) return;
    setBusy(`prepare:${restoreId}`);
    try {
      await props.calls.prepareRestore(restoreId, props.serverId);
      actionToast.success(t("backups.cloud.prepared"));
      props.onPrepared?.();
      void read();
    } catch (error) {
      actionToast.error(t("backups.cloud.prepareFailed"), {
        description: errorMessage(error, t("backups.cloud.prepareFailed")),
      });
    } finally {
      setBusy(null);
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
                        ? t("backups.cloud.warning.full")
                        : t("backups.cloud.warning.testFailed")}
                  </AlertDescription>
                </AlertContent>
              </Alert>
            )}
          </For>

          <ItemGroup class="settings-modal-card" aria-label={t("backups.cloud.destinations")}>
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemTitle>{t("backups.cloud.destinations")}</ItemTitle>
                <Show when={!props.canManage}>
                  <ItemDescription>{t("backups.cloud.ownerOnly")}</ItemDescription>
                </Show>
              </ItemContent>
            </Item>
            <Show
              when={value().destinations[0]}
              fallback={
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>{t("backups.cloud.provider.proton")}</ItemTitle>
                    <ItemDescription>{t("backups.cloud.notConnected")}</ItemDescription>
                  </ItemContent>
                  <Show when={props.canManage}>
                    <ItemActions>
                      <Button type="button" size="sm" disabled={manageDisabled()} onClick={() => setConnectOpen(true)}>
                        {t("backups.cloud.connectProton")}
                      </Button>
                    </ItemActions>
                  </Show>
                </Item>
              }
            >
              {(drive) => (
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>
                      {t("backups.cloud.provider.proton")}{" "}
                      <Show when={drive().status === "relogin"}>
                        <Badge variant="destructive-light">{t("backups.cloud.relogin")}</Badge>
                      </Show>
                    </ItemTitle>
                    <ItemDescription>
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
                    </ItemDescription>
                  </ItemContent>
                  <Show when={props.canManage}>
                    <ItemActions>
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
                    </ItemActions>
                  </Show>
                </Item>
              )}
            </Show>
            <For each={["googleDrive", "onedrive"] as const}>
              {(provider) => (
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemTitle>
                      {provider === "googleDrive"
                        ? t("backups.cloud.provider.googleDrive")
                        : t("backups.cloud.provider.onedrive")}{" "}
                      <Badge variant="secondary">{t("backups.cloud.soon")}</Badge>
                    </ItemTitle>
                  </ItemContent>
                </Item>
              )}
            </For>
          </ItemGroup>

          <Show when={value().destinations[0]}>
            <ItemGroup class="settings-modal-card" aria-label={t("backups.cloud.status")}>
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>
                    {value().lastSuccessAt
                      ? t("backups.cloud.lastCopy", { ago: ago(value().lastSuccessAt) })
                      : t("backups.cloud.never")}
                  </ItemTitle>
                  <ItemDescription aria-live="polite">
                    <Show when={value().running}>
                      {(job) => (
                        <>
                          {job().kind === "test"
                            ? t("backups.cloud.running.test")
                            : job().kind === "restore"
                              ? t("backups.cloud.running.restore")
                              : t("backups.cloud.running.backup")}{" "}
                        </>
                      )}
                    </Show>
                    <Show when={value().lastBackup?.ok ? value().lastBackup : null}>
                      {(run) => (
                        <>
                          {t("backups.cloud.lastCopyDetail", {
                            size: format.fileSize(run().totalBytes),
                            added: format.fileSize(run().addedBytes),
                            duration: duration(run().seconds),
                          })}{" "}
                        </>
                      )}
                    </Show>
                    <Show when={value().lastBackup && !value().lastBackup?.ok ? value().lastBackup : null}>
                      {(run) => (
                        <>
                          {t("backups.cloud.lastFailed", { ago: ago(run().finishedAt) })}{" "}
                          {t(PROBLEM_TEXT[run().problem ?? "other"])}{" "}
                        </>
                      )}
                    </Show>
                    {value().plan.enabled
                      ? value().nextRunAt
                        ? t("backups.cloud.next", {
                            time: format.date(new Date(value().nextRunAt ?? ""), { timeStyle: "short" }),
                          })
                        : ""
                      : t("backups.cloud.paused")}
                  </ItemDescription>
                  <Show when={value().typical}>
                    {(typical) => (
                      <ItemDescription>
                        {t("backups.cloud.typical", {
                          duration: duration(typical().seconds),
                          size: format.fileSize(typical().addedBytes),
                        })}
                      </ItemDescription>
                    )}
                  </Show>
                  <ItemDescription>
                    {value().lastTest
                      ? value().lastTest?.ok
                        ? t("backups.cloud.testOk", { ago: ago(value().lastTest?.finishedAt) })
                        : `${t("backups.cloud.testFailed", { ago: ago(value().lastTest?.finishedAt) })} ${t(PROBLEM_TEXT[value().lastTest?.problem ?? "other"])}`
                      : t("backups.cloud.testNever")}
                  </ItemDescription>
                  <Show when={[value().lastBackup, value().lastTest].find((run) => run?.detail)?.detail}>
                    {(detail) => (
                      <details>
                        <summary>{t("backups.cloud.technical")}</summary>
                        <p class="text-muted-foreground">{detail()}</p>
                      </details>
                    )}
                  </Show>
                </ItemContent>
                <ItemActions>
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
                </ItemActions>
              </Item>
            </ItemGroup>

            <Show when={plan()}>
              {(draft) => (
                <ItemGroup class="settings-modal-card" aria-label={t("backups.cloud.plan")}>
                  <Item class="settings-modal-row">
                    <ItemContent class="flex flex-col gap-3">
                      <ItemTitle>{t("backups.cloud.plan")}</ItemTitle>
                      <SwitchField
                        label={t("backups.cloud.plan.enabled")}
                        checked={draft().enabled}
                        disabled={manageDisabled()}
                        onChange={(checked: boolean) => editPlan((next) => (next.enabled = checked))}
                      />
                      <Field label={t("backups.cloud.plan.frequency")}>
                        <NativeSelect
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
                      </Field>
                      <Show when={draft().interval === "daily"}>
                        <Field label={t("backups.cloud.plan.time", { zone: draft().timezone })}>
                          <Input
                            type="time"
                            size="sm"
                            value={draft().dailyTime}
                            disabled={manageDisabled()}
                            onValueChange={(time) => editPlan((next) => (next.dailyTime = time))}
                          />
                        </Field>
                      </Show>
                      <ItemTitle>{t("backups.cloud.plan.what")}</ItemTitle>
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
                      <ItemTitle>{t("backups.cloud.plan.keep")}</ItemTitle>
                      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <For each={RETENTION_FIELDS}>
                          {([key, label]) => (
                            <Field label={t(label)}>
                              <Input
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
                            </Field>
                          )}
                        </For>
                        <Field label={t("backups.cloud.plan.largeFiles")}>
                          <Input
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
                        </Field>
                      </div>
                      <Show when={props.canManage}>
                        <div>
                          <Button
                            type="button"
                            size="sm"
                            loading={busy() === "plan"}
                            disabled={manageDisabled() || !planDirty()}
                            onClick={() =>
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
                          >
                            {t("backups.cloud.plan.save")}
                          </Button>
                        </div>
                      </Show>
                    </ItemContent>
                  </Item>
                </ItemGroup>
              )}
            </Show>

            <ItemGroup class="settings-modal-card" aria-label={t("backups.cloud.restoreTitle")}>
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{t("backups.cloud.restoreTitle")}</ItemTitle>
                  <ItemDescription>{t("backups.cloud.restoreDescription")}</ItemDescription>
                  <Show when={snapshotsError()}>
                    {(error) => <ItemDescription class="text-destructive">{error()}</ItemDescription>}
                  </Show>
                </ItemContent>
                <ItemActions>
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
                </ItemActions>
              </Item>
              <For each={value().restores.slice().reverse()}>
                {(row) => (
                  <Item class="settings-modal-row">
                    <ItemContent>
                      <ItemDescription>
                        {row.status === "ok"
                          ? t("backups.cloud.restoreReady", { when: when(row.finishedAt) })
                          : t("backups.cloud.restoreFailedRow", { when: when(row.finishedAt) })}
                      </ItemDescription>
                    </ItemContent>
                    <Show when={row.status === "ok" && props.canManage}>
                      <ItemActions>
                        <Show
                          when={!row.preparedAs}
                          fallback={<Badge variant="success-light">{t("backups.cloud.preparedBadge")}</Badge>}
                        >
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            loading={busy() === `prepare:${row.id}`}
                            disabled={manageDisabled() || value().running !== null}
                            onClick={() => void prepare(row.id)}
                          >
                            {t("backups.cloud.prepare")}
                          </Button>
                        </Show>
                      </ItemActions>
                    </Show>
                  </Item>
                )}
              </For>
              <Show when={snapshots()?.length === 0 && !snapshotsError()}>
                <Item class="settings-modal-row">
                  <ItemContent>
                    <ItemDescription>{t("backups.cloud.noCopies")}</ItemDescription>
                  </ItemContent>
                </Item>
              </Show>
              <For each={snapshots() ?? []}>
                {(snapshot) => (
                  <Item class="settings-modal-row">
                    <ItemContent>
                      <ItemTitle>{when(snapshot.time)}</ItemTitle>
                      <ItemDescription>{format.fileSize(snapshot.bytes)}</ItemDescription>
                    </ItemContent>
                    <Show when={props.canManage}>
                      <ItemActions>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={manageDisabled() || value().running !== null}
                          onClick={() => {
                            setRestoreError(null);
                            setRestoring(snapshot);
                          }}
                        >
                          {t("backups.cloud.restore")}
                        </Button>
                      </ItemActions>
                    </Show>
                  </Item>
                )}
              </For>
            </ItemGroup>
          </Show>

          <ProtonConnectDialog
            open={connectOpen()}
            email={value().destinations[0]?.account ?? ""}
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
            <div class="flex flex-col gap-3">
              <Input size="sm" readonly value={password() ?? ""} aria-label={t("backups.cloud.password.title")} />
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
              <div class="flex items-center gap-2">
                <Checkbox
                  id="cloud-backups-password-kept"
                  checked={passwordKept()}
                  onChange={(event) => setPasswordKept(event.currentTarget.checked)}
                />
                <label for="cloud-backups-password-kept">{t("backups.cloud.password.confirm")}</label>
              </div>
            </div>
          </FormDialog>

          <ConfirmDialog
            open={disconnecting()}
            onCancel={() => setDisconnecting(false)}
            tone="destructive"
            title={t("backups.cloud.disconnectTitle")}
            description={t("backups.cloud.disconnectDescription")}
            confirmLabel={t("backups.cloud.disconnect")}
            onConfirm={async () => {
              const id = value().destinations[0]?.id;
              setDisconnecting(false);
              if (id) await act("disconnect", () => props.calls.disconnect(id, props.serverId));
            }}
          />

          <ConfirmDialog
            open={restoring() !== null}
            onCancel={() => setRestoring(null)}
            icon={<History />}
            title={t("backups.cloud.restoreConfirmTitle", { when: when(restoring()?.time ?? "") })}
            description={t("backups.cloud.restoreConfirmDescription")}
            confirmLabel={t("backups.cloud.restoreConfirm")}
            error={restoreError() ?? undefined}
            onConfirm={() => restore()}
          />
        </SettingsSection>
      )}
    </Show>
  );
}

/** Sign in to Proton: email and password, the 2FA code once, and the mailbox password of two-password accounts. */
function ProtonConnectDialog(props: {
  open: boolean;
  email: string;
  onClose: () => void;
  connect: (input: CloudConnectInput) => Promise<CloudConnectResult>;
  onConnected: (result: CloudConnectResult) => void;
}) {
  const { t, errorMessage } = useText();
  const [email, setEmail] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [code, setCode] = createSignal("");
  const [twoPasswords, setTwoPasswords] = createSignal(false);
  const [mailbox, setMailbox] = createSignal("");
  const [repository, setRepository] = createSignal("");
  const [askRepository, setAskRepository] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  createEffect(
    () => props.open,
    (open) => {
      if (!open) return;
      setEmail(props.email);
      setPassword("");
      setCode("");
      setMailbox("");
      setRepository("");
      setProblem(null);
    },
  );

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
      });
      if (result.ok) {
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
        if (!open && !pending()) props.onClose();
      }}
      title={t("backups.cloud.connect.title")}
      description={t("backups.cloud.connect.description")}
      submitLabel={pending() ? t("backups.cloud.connect.busy") : t("backups.cloud.connect.submit")}
      submitDisabled={!email().trim() || !password()}
      busy={pending()}
      error={problem()}
      onSubmit={() => void submit()}
    >
      <div class="flex flex-col gap-3">
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
        <Field label={t("backups.cloud.connect.twoFactor")} description={t("backups.cloud.connect.twoFactorHint")}>
          <Input
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength={8}
            value={code()}
            onValueChange={setCode}
          />
        </Field>
        <div class="flex items-center gap-2">
          <Checkbox
            id="cloud-backups-two-passwords"
            checked={twoPasswords()}
            onChange={(event) => setTwoPasswords(event.currentTarget.checked)}
          />
          <label for="cloud-backups-two-passwords">{t("backups.cloud.connect.twoPasswords")}</label>
        </div>
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
      </div>
    </FormDialog>
  );
}
