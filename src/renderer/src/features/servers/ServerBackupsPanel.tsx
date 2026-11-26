import type {
  HostBackup,
  HostBackupsOverview,
  HostRestoreCheck,
} from "@openbot/contracts/team-protocol/host-backups-v1";
import {
  Alert,
  AlertContent,
  AlertDescription,
  AlertIcon,
  AlertTitle,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  History,
  Info,
  Input,
  SettingsGroup,
  SettingsRow,
  SettingsSection,
  Text,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createUniqueId, For, onCleanup, Show, untrack } from "solid-js";
import { actionToast } from "../../action-toast";
import { type HostCloudBackupsCalls, ServerCloudBackupsPanel } from "./ServerCloudBackupsPanel";

/** The `host-backups-v1` calls of one server's host. Only the web client passes them today. */
export interface HostBackupsCalls {
  overview: (serverId: string) => Promise<HostBackupsOverview>;
  create: (serverId: string) => Promise<HostBackupsOverview>;
  check: (id: string, spaces: boolean, serverId: string) => Promise<HostRestoreCheck>;
  restore: (id: string, confirm: string, spaces: boolean, serverId: string) => Promise<{ started: boolean }>;
}

export interface ServerBackupsOptions {
  calls: HostBackupsCalls;
  /** Copies to the owner's cloud drive (`host-cloud-backups-v1`), shown below the server's own backups. */
  cloud?: HostCloudBackupsCalls | undefined;
  /** Only the owner restores; an admin lists, backs up and runs the check. */
  canRestore: boolean;
}

/** While a backup or restore runs the list is read often; otherwise once a minute while open. */
const BUSY_POLL_MS = 4000;
const IDLE_POLL_MS = 60_000;

type Ready = Extract<HostBackupsOverview, { available: true }>;

/**
 * Server settings > Backups: the host's nightly and manual backups (database, settings, keys, vault,
 * provider accounts, agent workspaces, spaces and the Motion board), and a restore with a dry run and
 * a typed confirmation. The host's backup broker does the work; this only asks it.
 */
export function ServerBackupsPanel(
  props: ServerBackupsOptions & { serverId: string; hostName: string; actionsAvailable: boolean },
) {
  const { t, errorMessage, format } = useText();
  const ids = createUniqueId();
  const [overview, setOverview] = createSignal<HostBackupsOverview | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [target, setTarget] = createSignal<HostBackup | null>(null);
  const [check, setCheck] = createSignal<HostRestoreCheck | null>(null);
  const [checkError, setCheckError] = createSignal<string | null>(null);
  const [spaces, setSpaces] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [restoreError, setRestoreError] = createSignal<string | null>(null);
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ready = (): Ready | null => {
    const value = overview();
    return value?.available ? value : null;
  };
  const working = () => {
    const value = ready();
    if (!value) return false;
    const restore = value.lastRestore?.status;
    return value.running !== null || restore === "starting" || restore === "running";
  };

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void read(), working() || loadError() ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  async function read(): Promise<void> {
    const current = generation;
    try {
      const next = await props.calls.overview(props.serverId);
      if (current !== generation) return;
      setOverview(next);
      setLoadError(null);
    } catch (error) {
      if (current !== generation) return;
      // A restore stops the host: the read fails until it is back, and the poll keeps trying.
      setLoadError(errorMessage(error, t("backups.loadFailed", { name: props.hostName })));
    }
    if (current === generation) schedule();
  }

  createEffect(
    () => props.serverId,
    () => {
      generation += 1;
      setOverview(null);
      setLoadError(null);
      void untrack(read);
    },
  );
  onCleanup(() => {
    generation += 1;
    if (timer) clearTimeout(timer);
  });

  async function backUpNow(): Promise<void> {
    if (busy()) return;
    setBusy("create");
    try {
      setOverview(await props.calls.create(props.serverId));
      schedule();
    } catch (error) {
      actionToast.error(t("backups.createFailed"), { description: errorMessage(error, t("backups.createFailed")) });
    } finally {
      setBusy(null);
    }
  }

  async function runCheck(backup: HostBackup, withSpaces: boolean): Promise<void> {
    setCheck(null);
    setCheckError(null);
    try {
      const result = await props.calls.check(backup.id, withSpaces, props.serverId);
      if (target()?.id === backup.id) setCheck(result);
    } catch (error) {
      if (target()?.id === backup.id) setCheckError(errorMessage(error, t("backups.checkFailed")));
    }
  }

  function openRestore(backup: HostBackup): void {
    setTarget(backup);
    setSpaces(false);
    setTyped("");
    setRestoreError(null);
    void runCheck(backup, false);
  }

  async function restore(): Promise<void> {
    const backup = target();
    const result = check();
    if (!backup || !result?.ok || typed().trim() !== result.confirm) return;
    setRestoreError(null);
    try {
      await props.calls.restore(backup.id, result.confirm, spaces(), props.serverId);
      setTarget(null);
      actionToast.success(t("backups.restoreStarted", { name: props.hostName }));
      void read();
    } catch (error) {
      setRestoreError(errorMessage(error, t("backups.restoreFailed")));
    }
  }

  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : format.date(date, { dateStyle: "medium", timeStyle: "short" });
  };
  const reasonLabel = (backup: HostBackup) =>
    backup.reason === "nightly"
      ? t("backups.reason.nightly")
      : backup.reason === "manual"
        ? t("backups.reason.manual")
        : backup.reason === "pre-restore"
          ? t("backups.reason.preRestore")
          : t("backups.reason.other");
  const skipped = (backup: HostBackup) =>
    backup.components
      .filter((item) => item.status !== "ok")
      .map((item) => item.name.replace(/^(space|workspace):/u, ""));
  const statusBadge = (backup: HostBackup) => (
    <Badge
      variant={
        backup.status === "ok" ? "success-light" : backup.status === "partial" ? "warning-light" : "destructive-light"
      }
    >
      {backup.status === "ok"
        ? t("backups.status.ok")
        : backup.status === "partial"
          ? t("backups.status.partial")
          : backup.status === "running"
            ? t("backups.status.running")
            : t("backups.status.failed")}
    </Badge>
  );

  return (
    <>
      <SettingsSection title={t("backups.title", { name: props.hostName })} description={t("backups.description")}>
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
        <Show when={overview()?.available === false}>
          <Alert tone="neutral" role="status">
            <AlertIcon>
              <Info />
            </AlertIcon>
            <AlertContent>
              <AlertTitle>{t("backups.notSetUpTitle")}</AlertTitle>
              <AlertDescription>{t("backups.notSetUpDescription")}</AlertDescription>
            </AlertContent>
          </Alert>
        </Show>
        <Show when={ready()}>
          {(value) => (
            <>
              <Show when={value().lastRestore}>
                {(last) => (
                  <Alert
                    tone={last().status === "ok" ? "success" : last().status === "failed" ? "danger" : "neutral"}
                    role="status"
                  >
                    <AlertContent>
                      <AlertTitle>
                        {last().status === "ok"
                          ? t("backups.lastRestoreOk", { id: last().id })
                          : last().status === "failed"
                            ? t("backups.lastRestoreFailed", { id: last().id })
                            : t("backups.restoring", { id: last().id })}
                      </AlertTitle>
                      <AlertDescription>
                        {last().steps.at(-1)?.text ?? ""}
                        <Show when={last().safetyBackup}>
                          {(safety) => <> {t("backups.safetyBackup", { id: safety() })}</>}
                        </Show>
                      </AlertDescription>
                    </AlertContent>
                  </Alert>
                )}
              </Show>
              <SettingsGroup label={t("backups.title", { name: props.hostName })}>
                <SettingsRow
                  label={t("backups.schedule", { time: value().nightly })}
                  description={`${t("backups.retention", { daily: value().retention.daily, weekly: value().retention.weekly })} ${t(
                    "backups.disk",
                    {
                      free: format.fileSize(value().disk.freeBytes),
                      total: format.fileSize(value().disk.totalBytes),
                    },
                  )} ${value().offsite ? t("backups.offsiteOn") : t("backups.offsiteOff")}`}
                >
                  <Button
                    type="button"
                    size="sm"
                    loading={busy() === "create" || value().running?.kind === "backup"}
                    disabled={!props.actionsAvailable || Boolean(busy()) || working()}
                    onClick={() => void backUpNow()}
                  >
                    {t("backups.backUpNow")}
                  </Button>
                </SettingsRow>
                {/* A restore shows in the notice above. */}
                <Show when={value().running?.kind === "restore" ? null : value().running}>
                  {(job) => (
                    <SettingsRow
                      aria-live="polite"
                      label={job().kind === "restore" ? t("backups.restoring", { id: job().id }) : t("backups.running")}
                      description={job().phase}
                    />
                  )}
                </Show>
                <Show when={value().backups.length === 0}>
                  <SettingsRow label={t("backups.empty")} />
                </Show>
                <For each={value().backups}>
                  {(backup) => (
                    <SettingsRow
                      label={
                        <>
                          {when(backup.createdAt)} {statusBadge(backup)}
                        </>
                      }
                      description={
                        backup.status === "failed"
                          ? `${reasonLabel(backup)} · ${backup.error ?? t("backups.status.failed")}`
                          : [
                              t("backups.row", {
                                reason: reasonLabel(backup),
                                size: format.fileSize(backup.bytes),
                                added: format.fileSize(backup.newBytes),
                              }),
                              ...(skipped(backup).length > 0
                                ? [t("backups.skipped", { parts: format.list(skipped(backup)) })]
                                : []),
                            ].join(" · ")
                      }
                    >
                      <Show when={props.canRestore && backup.status !== "failed" && backup.status !== "running"}>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={!props.actionsAvailable || working()}
                          onClick={() => openRestore(backup)}
                        >
                          {t("backups.restore")}
                        </Button>
                      </Show>
                    </SettingsRow>
                  )}
                </For>
              </SettingsGroup>
            </>
          )}
        </Show>
        <ConfirmDialog
          open={target() !== null}
          onCancel={() => setTarget(null)}
          // The check can take a while on a busy host; Cancel stays available.
          dismissWhilePending
          tone="destructive"
          icon={<History />}
          title={t("backups.restoreTitle", { name: props.hostName })}
          description={t("backups.restoreDescription", { when: when(target()?.createdAt ?? "") })}
          confirmLabel={t("backups.restoreConfirm")}
          pendingLabel={t("backups.restoreStarting")}
          pending={check() === null && checkError() === null}
          error={restoreError() ?? checkError() ?? undefined}
          onConfirm={() => {
            if (!check()?.ok || typed().trim() !== check()?.confirm) {
              setRestoreError(check()?.ok ? t("backups.typeToConfirm", { id: check()?.confirm ?? "" }) : null);
              return;
            }
            return restore();
          }}
        >
          <Show when={check() === null && checkError() === null}>
            <Text as="p" variant="body-sm" tone="muted">
              {t("backups.checking")}
            </Text>
          </Show>
          <Show when={check()}>
            {(result) => (
              <>
                <Show when={result().problems.length + result().warnings.length + result().counts.length > 0}>
                  <ul>
                    <For each={result().problems}>
                      {(problem) => (
                        <li>
                          <Text variant="body-sm" tone="danger">
                            {problem}
                          </Text>
                        </li>
                      )}
                    </For>
                    <For each={result().warnings}>{(warning) => <li>{warning}</li>}</For>
                    <Show when={result().counts.length > 0}>
                      <li>
                        {format.list(
                          result().counts.map((row) =>
                            t("backups.countRow", {
                              table: row.table.replace(/^projection_/u, "").replaceAll("_", " "),
                              now: format.number(row.now),
                              backup: format.number(row.backup),
                            }),
                          ),
                        )}
                      </li>
                    </Show>
                  </ul>
                </Show>
                <SettingsGroup label={t("backups.restoreConfirm")}>
                  <SettingsRow layout="inline" label={t("backups.includeSpaces")} controlId={`${ids}-spaces`}>
                    <Checkbox
                      id={`${ids}-spaces`}
                      checked={spaces()}
                      onChange={(event) => {
                        const next = event.currentTarget.checked;
                        setSpaces(next);
                        const backup = target();
                        if (backup) void runCheck(backup, next);
                      }}
                    />
                  </SettingsRow>
                  <Show when={result().ok}>
                    <SettingsRow
                      layout="stack"
                      label={t("backups.typeToConfirm", { id: result().confirm })}
                      controlId={`${ids}-confirm`}
                    >
                      <Input
                        id={`${ids}-confirm`}
                        size="sm"
                        value={typed()}
                        autocomplete="off"
                        spellcheck={false}
                        onValueChange={setTyped}
                      />
                    </SettingsRow>
                  </Show>
                </SettingsGroup>
              </>
            )}
          </Show>
        </ConfirmDialog>
      </SettingsSection>
      <Show when={props.cloud}>
        {(cloud) => (
          <ServerCloudBackupsPanel
            calls={cloud()}
            serverId={props.serverId}
            canManage={props.canRestore}
            hostName={props.hostName}
            actionsAvailable={props.actionsAvailable}
            onPrepared={() => void read()}
          />
        )}
      </Show>
    </>
  );
}
