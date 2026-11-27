import {
  isSecretTag,
  normalizeSecretFolder,
  SECRET_KINDS,
  type SecretAccess,
  type SecretActor,
  type SecretDetail as SecretDetailData,
  type SecretKind,
  type SecretVaultCall,
  type SecretVaultResult,
  secretHealth,
  secretScopeKind,
  secretUnused,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { Badge } from "../../badge";
import { Button, IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input, Textarea } from "../../form";
import { FormDialog } from "../../form-dialog";
import {
  ArrowLeft,
  Copy,
  Eye,
  EyeOff,
  History,
  LockKeyhole,
  RotateCcw,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  X,
} from "../../icons";
import { SettingsGroup, SettingsHelp, SettingsRow } from "../../settings";
import { Switch } from "../../switch";
import { useText } from "../../text";
import { toast } from "../../toast";
import { ErrorState, LoadingState } from "../../view-state";
import { MemberAvatar } from "../workspace/WorkspaceAvatar";
import { WorkspaceSelect } from "../workspace/WorkspaceSelect";
import type { WorkspaceMember } from "../workspace/workspace-types";
import { SecretTypeIcon, StatusBadge, useSecretText } from "./SecretParts";
import { dateInputTime, dateInputValue, displayName, parseTags } from "./secrets-vault-model";

/** How long a shown value stays on the screen. */
export const REVEAL_SECONDS = 10;
/** The first entry of an add picker: a prompt, not a choice. */
const ADD = "add";
const ROTATION_DAYS = ["0", "30", "60", "90", "180", "365"] as const;

export interface SecretDetailProps {
  scope: string;
  name: string;
  owner: boolean;
  agents: readonly WorkspaceMember[];
  spaces: readonly { id: string; name: string }[];
  call: (call: SecretVaultCall) => Promise<SecretVaultResult>;
  copyValue: (value: Promise<string>, name: string) => Promise<void>;
  /** A change was saved: the list reads the keys again. */
  onChanged: () => void;
  onClose: () => void;
  /** Back on a phone, Close beside the list on a computer. */
  phone: boolean;
}

const ACTION_KEYS = {
  created: "secrets.history.created",
  changed: "secrets.history.changed",
  "rolled-back": "secrets.history.rolledBack",
  revealed: "secrets.history.revealed",
  copied: "secrets.history.copied",
  used: "secrets.history.used",
  blocked: "secrets.history.blocked",
  "access-changed": "secrets.history.accessChanged",
  "settings-changed": "secrets.history.settingsChanged",
  deleted: "secrets.history.deleted",
  restored: "secrets.history.restored",
  purged: "secrets.history.purged",
  expired: "secrets.history.expired",
  exported: "secrets.history.exported",
  imported: "secrets.history.imported",
  requested: "secrets.history.requested",
  reminded: "secrets.history.reminded",
} as const;

/** One key: its value behind a confirm, who may use it, its dates, use, details, versions and history. */
export function SecretDetail(props: SecretDetailProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const text = useSecretText();
  const [detail, setDetail] = createSignal<SecretDetailData | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [revealed, setRevealed] = createSignal<{ value: string; version?: number; left: number } | null>(null);
  const [confirming, setConfirming] = createSignal<
    { kind: "show" | "copy"; version?: number } | { kind: "rollback"; version: number } | { kind: "delete" } | null
  >(null);
  const [confirmError, setConfirmError] = createSignal<string | null>(null);
  const [changing, setChanging] = createSignal(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => {
    if (timer) clearInterval(timer);
  });

  async function load() {
    try {
      const result = await props.call({ kind: "detail", scope: props.scope, name: props.name });
      if (result.kind === "detail") {
        setDetail(result.detail);
        setLoadError(null);
      }
    } catch (error) {
      if (!detail()) setLoadError(errorMessage(error, t("secrets.detail.loadFailed")));
      else toast.error(errorMessage(error, t("secrets.failed")));
    }
  }
  onSettled(() => {
    void load();
  });

  /** A change, then the key and the list again. A failure is thrown on to the form or confirm. */
  async function change(call: SecretVaultCall, done?: string) {
    await props.call(call);
    if (done) toast.success(done);
    props.onChanged();
    await load();
  }

  function hide() {
    if (timer) clearInterval(timer);
    timer = undefined;
    setRevealed(null);
  }

  async function reveal(version?: number) {
    const result = await props.call({
      kind: "reveal",
      scope: props.scope,
      name: props.name,
      purpose: "show",
      ...(version ? { version } : {}),
    });
    if (result.kind !== "value") return;
    if (timer) clearInterval(timer);
    setRevealed({ value: result.value, left: REVEAL_SECONDS, ...(version ? { version } : {}) });
    timer = setInterval(() => {
      const shown = revealed();
      if (!shown || shown.left <= 1) hide();
      else setRevealed({ ...shown, left: shown.left - 1 });
    }, 1000);
    void load();
  }

  function copy(version?: number) {
    const read = props
      .call({ kind: "reveal", scope: props.scope, name: props.name, purpose: "copy", ...(version ? { version } : {}) })
      .then((result) => {
        if (result.kind !== "value") throw new Error(t("secrets.failed"));
        return result.value;
      });
    // The clipboard is written in the tap, from the value the host sends after it.
    const copied = props.copyValue(read, displayName(detail()?.secret ?? { name: props.name }));
    void copied.finally(() => void load());
    return copied;
  }

  async function confirm() {
    const action = confirming();
    if (!action) return;
    setConfirmError(null);
    try {
      if (action.kind === "show") await reveal(action.version);
      else if (action.kind === "copy") await copy(action.version);
      else if (action.kind === "rollback")
        await change(
          { kind: "rollback", scope: props.scope, name: props.name, version: action.version },
          t("secrets.versions.restored", { version: action.version }),
        );
      else {
        await props.call({ kind: "delete", scope: props.scope, name: props.name });
        toast.success(t("secrets.delete.done", { name: displayName(detail()?.secret ?? { name: props.name }) }));
        props.onChanged();
        props.onClose();
      }
      setConfirming(null);
    } catch (error) {
      setConfirmError(errorMessage(error, t("secrets.failed")));
    }
  }

  const who = (actor: SecretActor | undefined) => text.actor(actor, props.agents);
  const rotatedText = (at: number | undefined) =>
    at === undefined ? t("secrets.row.neverChanged") : format.date(at, { dateStyle: "medium", timeStyle: "short" });
  const secretName = () => displayName(detail()?.secret ?? { name: props.name });

  return (
    <section class="sv-detail" aria-label={secretName()}>
      <header class="sv-detail-header">
        <Show
          when={props.phone}
          fallback={
            <IconButton
              class="sv-detail-close"
              variant="ghost"
              size="icon-sm"
              label={t("secrets.detail.close")}
              onClick={props.onClose}
            >
              <X />
            </IconButton>
          }
        >
          <Button class="sv-detail-back" variant="ghost" size="sm" onClick={props.onClose}>
            <ArrowLeft />
            {t("secrets.detail.back")}
          </Button>
        </Show>
      </header>
      <Show
        when={detail()}
        fallback={
          <Show when={loadError()} fallback={<LoadingState label={props.name} />}>
            {(reason) => (
              <ErrorState title={t("secrets.detail.loadFailed")} description={reason()} onRetry={() => void load()} />
            )}
          </Show>
        }
      >
        {(loaded) => {
          const secret = () => loaded().secret;
          const health = () => secretHealth(secret(), Date.now());
          return (
            <div class="sv-detail-body">
              <div class="sv-detail-hero">
                <SecretTypeIcon type={secret().type} size="lg" />
                <div class="sv-detail-hero-copy">
                  <h2 class="sv-detail-title">{displayName(secret())}</h2>
                  <span class="sv-mono sv-detail-name">{secret().name}</span>
                  <div class="sv-detail-chips">
                    <StatusBadge health={health()} />
                    <Badge variant="secondary">{text.type(secret().type)}</Badge>
                    <span class="sv-scope-chip">
                      <ScopeAvatar scope={secret().scope} agents={props.agents} />
                      {text.scope(secret().scope, secret().access, props.agents, props.spaces)}
                    </span>
                    <Show when={secret().folder}>{(folder) => <span class="sv-folder-chip">{folder()}</span>}</Show>
                    <For each={secret().tags}>{(tag) => <span class="sv-tag">#{tag}</span>}</For>
                  </div>
                </div>
              </div>

              <Show when={health() === "expired" && secret().expiresAt}>
                {(at) => (
                  <div class="sv-notice" data-tone="danger" role="status">
                    <TriangleAlert aria-hidden="true" />
                    <span>
                      {t("secrets.rotation.expiredNotice", { date: format.date(at(), { dateStyle: "medium" }) })}
                    </span>
                  </div>
                )}
              </Show>

              <SettingsGroup title={t("secrets.value.title")}>
                <SettingsRow
                  label={
                    <Show
                      when={revealed()}
                      fallback={
                        <span class="sv-masked">
                          <span class="sr-only">{t("secrets.value.masked")}</span>
                          <LockKeyhole aria-hidden="true" />
                          <span aria-hidden="true">••••••••••••</span>
                        </span>
                      }
                    >
                      {(shown) => <code class="sv-mono sv-revealed">{shown().value}</code>}
                    </Show>
                  }
                  description={
                    <Show
                      when={revealed()}
                      fallback={
                        props.owner
                          ? t("secrets.versions.item", { version: secret().version })
                          : t("secrets.value.ownerOnly")
                      }
                    >
                      {(shown) => <span aria-live="polite">{t("secrets.value.hidesIn", { count: shown().left })}</span>}
                    </Show>
                  }
                  layout="stack"
                >
                  <div class="sv-actions">
                    <Show when={props.owner}>
                      <Show
                        when={revealed()}
                        fallback={
                          <Button variant="outline" size="sm" onClick={() => setConfirming({ kind: "show" })}>
                            <Eye />
                            {t("secrets.value.show")}
                          </Button>
                        }
                      >
                        <Button variant="outline" size="sm" onClick={hide}>
                          <EyeOff />
                          {t("secrets.value.hide")}
                        </Button>
                      </Show>
                      <Button variant="outline" size="sm" onClick={() => setConfirming({ kind: "copy" })}>
                        <Copy />
                        {t("secrets.value.copy")}
                      </Button>
                    </Show>
                    <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
                      <RotateCcw />
                      {t("secrets.value.change")}
                    </Button>
                  </div>
                </SettingsRow>
              </SettingsGroup>

              <AccessGroup
                scope={secret().scope}
                access={secret().access}
                owner={props.owner}
                agents={props.agents}
                spaces={props.spaces}
                onChange={(access) =>
                  change(
                    { kind: "update", scope: props.scope, name: props.name, access },
                    t("secrets.access.saved"),
                  ).catch((error: unknown) => toast.error(errorMessage(error, t("secrets.failed"))))
                }
              />

              <SettingsGroup title={t("secrets.rotation.title")}>
                <SettingsRow
                  label={t("secrets.rotation.rotateBy")}
                  description={t("secrets.rotation.rotateByDescription")}
                  controlId="sv-rotate-by"
                >
                  <DateControl
                    id="sv-rotate-by"
                    value={secret().rotateBy}
                    onChange={(at) =>
                      change(
                        { kind: "update", scope: props.scope, name: props.name, rotateBy: at },
                        t("secrets.rotation.saved"),
                      ).catch((error: unknown) => toast.error(errorMessage(error, t("secrets.failed"))))
                    }
                  />
                </SettingsRow>
                <SettingsRow label={t("secrets.rotation.every")} description={t("secrets.rotation.everyDescription")}>
                  <WorkspaceSelect
                    label={t("secrets.rotation.every")}
                    value={String(secret().rotateEveryDays ?? 0)}
                    options={ROTATION_DAYS.map((days) => ({
                      value: days,
                      label:
                        days === "0"
                          ? t("secrets.rotation.never")
                          : t("secrets.rotation.days", { count: Number(days) }),
                    }))}
                    onChange={(days) =>
                      change(
                        {
                          kind: "update",
                          scope: props.scope,
                          name: props.name,
                          rotateEveryDays: days === "0" ? null : Number(days),
                        },
                        t("secrets.rotation.saved"),
                      ).catch((error: unknown) => toast.error(errorMessage(error, t("secrets.failed"))))
                    }
                  />
                </SettingsRow>
                <SettingsRow
                  label={t("secrets.rotation.expiresAt")}
                  description={t("secrets.rotation.expiresDescription")}
                  controlId="sv-expires-at"
                >
                  <DateControl
                    id="sv-expires-at"
                    value={secret().expiresAt}
                    onChange={(at) =>
                      change(
                        { kind: "update", scope: props.scope, name: props.name, expiresAt: at },
                        t("secrets.rotation.saved"),
                      ).catch((error: unknown) => toast.error(errorMessage(error, t("secrets.failed"))))
                    }
                  />
                </SettingsRow>
                <SettingsRow label={t("secrets.rotation.lastChanged")} description={rotatedText(secret().rotatedAt)} />
              </SettingsGroup>

              <SettingsGroup title={t("secrets.usage.title")} description={t("secrets.usage.description")}>
                <Show when={secretUnused(secret(), Date.now())}>
                  <SettingsRow label={t("secrets.status.unused")} description={t("secrets.usage.unused")} />
                </Show>
                <Show when={secret().usedBy.length > 0} fallback={<SettingsRow label={t("secrets.usage.none")} />}>
                  <For each={secret().usedBy}>
                    {(use) => {
                      const agent = () => props.agents.find((candidate) => candidate.id === use.agentId);
                      return (
                        <SettingsRow
                          class="sv-usage-row"
                          label={
                            <span class="sv-inline-member">
                              <Show when={agent()}>{(member) => <MemberAvatar member={member()} size="xs" />}</Show>
                              {agent()?.name ?? t("secrets.scope.unknownAgent")}
                            </span>
                          }
                          description={t("secrets.usage.lastUsed", { time: text.ago(use.at) })}
                        />
                      );
                    }}
                  </For>
                </Show>
              </SettingsGroup>

              <DetailsGroup
                secret={secret()}
                onSave={(settings) =>
                  change(
                    { kind: "update", scope: props.scope, name: props.name, ...settings },
                    t("secrets.details.saved"),
                  )
                }
              />

              <SettingsGroup title={t("secrets.versions.title")} description={t("secrets.versions.description")}>
                <For each={loaded().versions} keyed={(version) => version.version}>
                  {(version) => (
                    <SettingsRow
                      class="sv-version-row"
                      label={
                        <span class="sv-version-label">
                          {t("secrets.versions.item", { version: version().version })}
                          <Show when={version().current}>
                            <Badge variant="success-light">{t("secrets.versions.current")}</Badge>
                          </Show>
                        </span>
                      }
                      description={t("secrets.versions.by", {
                        date: format.date(version().createdAt, { dateStyle: "medium", timeStyle: "short" }),
                        who: who(version().by),
                      })}
                    >
                      <Show when={!version().current}>
                        <div class="sv-actions">
                          <Show when={props.owner}>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirming({ kind: "show", version: version().version })}
                            >
                              <Eye />
                              {t("secrets.versions.show")}
                            </Button>
                          </Show>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setConfirming({ kind: "rollback", version: version().version })}
                          >
                            <History />
                            {t("secrets.versions.restore")}
                          </Button>
                        </div>
                      </Show>
                    </SettingsRow>
                  )}
                </For>
              </SettingsGroup>

              <SettingsGroup title={t("secrets.history.title")} description={t("secrets.history.description")}>
                <Show when={loaded().audit.length > 0} fallback={<SettingsRow label={t("secrets.history.empty")} />}>
                  <ol class="sv-audit" aria-label={t("secrets.history.title")}>
                    <For each={loaded().audit}>
                      {(row) => (
                        <li class="sv-audit-row" data-action={row.action}>
                          <span class="sv-audit-dot" aria-hidden="true" />
                          <span class="sv-audit-copy">
                            <span class="sv-audit-text">{t(ACTION_KEYS[row.action], { who: who(row.actor) })}</span>
                            <span class="sv-audit-meta">
                              {format.date(row.at, { dateStyle: "medium", timeStyle: "short" })}
                              <Show when={auditDetail(row.detail)}>{(extra) => <> · {extra()}</>}</Show>
                            </span>
                          </span>
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </SettingsGroup>

              <SettingsGroup title={t("secrets.danger.title")} class="sv-danger">
                <SettingsRow label={t("secrets.delete.action")} description={t("secrets.delete.description")}>
                  <Button variant="destructive" size="sm" onClick={() => setConfirming({ kind: "delete" })}>
                    <Trash2 />
                    {t("secrets.delete.action")}
                  </Button>
                </SettingsRow>
              </SettingsGroup>

              <ChangeValueDialog
                open={changing()}
                name={displayName(secret())}
                onOpenChange={setChanging}
                onSave={async (value) => {
                  await change(
                    { kind: "save", scope: props.scope, name: props.name, value },
                    t("secrets.change.done", { name: displayName(secret()) }),
                  );
                  setChanging(false);
                }}
              />
            </div>
          );
        }}
      </Show>
      <ConfirmDialog
        open={confirming() !== null}
        onCancel={() => {
          setConfirming(null);
          setConfirmError(null);
        }}
        onConfirm={confirm}
        error={confirmError() ?? undefined}
        tone={confirming()?.kind === "delete" ? "destructive" : "default"}
        icon={confirming()?.kind === "delete" ? undefined : <ShieldAlert />}
        title={confirmTitle(confirming(), secretName(), t)}
        description={confirmDescription(confirming(), t)}
        confirmLabel={confirmLabel(confirming(), t)}
      />
    </section>
  );
}

type Translate = ReturnType<typeof useText>["t"];
type Confirming =
  | { kind: "show" | "copy"; version?: number }
  | { kind: "rollback"; version: number }
  | { kind: "delete" }
  | null;

function confirmTitle(action: Confirming, name: string, t: Translate): string {
  if (!action) return "";
  if (action.kind === "show") return t("secrets.reveal.title", { name });
  if (action.kind === "copy") return t("secrets.copy.title", { name });
  if (action.kind === "rollback") return t("secrets.versions.restoreTitle", { version: action.version });
  return t("secrets.delete.title", { name });
}

function confirmDescription(action: Confirming, t: Translate): string {
  if (!action) return "";
  if (action.kind === "show") return t("secrets.reveal.description");
  if (action.kind === "copy") return t("secrets.copy.description");
  if (action.kind === "rollback") return t("secrets.versions.restoreDescription");
  return t("secrets.delete.description");
}

function confirmLabel(action: Confirming, t: Translate): string {
  if (!action) return "";
  if (action.kind === "show") return t("secrets.reveal.confirm");
  if (action.kind === "copy") return t("secrets.copy.confirm");
  if (action.kind === "rollback") return t("secrets.versions.restoreConfirm");
  return t("secrets.delete.confirm");
}

/** A version number or a site from the log; nothing technical beyond that. */
function auditDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  const version = /^version (\d+)$/u.exec(detail);
  if (version) return `v${version[1]}`;
  const site = /^filled on (https?:\/\/\S+)$/u.exec(detail);
  if (site?.[1]) {
    try {
      return new URL(site[1]).hostname;
    } catch {
      return null;
    }
  }
  return null;
}

function ScopeAvatar(props: { scope: string; agents: readonly WorkspaceMember[] }): JSX.Element {
  const agent = () =>
    secretScopeKind(props.scope) === "agent"
      ? props.agents.find((candidate) => candidate.id === props.scope)
      : undefined;
  return <Show when={agent()}>{(member) => <MemberAvatar member={member()} size="xs" />}</Show>;
}

function DateControl(props: { id: string; value: number | undefined; onChange: (at: number | null) => void }) {
  const { t } = useText();
  return (
    <div class="sv-date">
      <Input
        id={props.id}
        type="date"
        value={dateInputValue(props.value)}
        onChange={(event) => {
          const at = dateInputTime(event.currentTarget.value);
          if (at !== null && at !== props.value) props.onChange(at);
        }}
      />
      <Show when={props.value !== undefined}>
        <Button variant="ghost" size="sm" onClick={() => props.onChange(null)}>
          {t("secrets.rotation.clear")}
        </Button>
      </Show>
    </div>
  );
}

function AccessGroup(props: {
  scope: string;
  access: SecretAccess;
  owner: boolean;
  agents: readonly WorkspaceMember[];
  spaces: readonly { id: string; name: string }[];
  onChange: (access: SecretAccess) => void;
}) {
  const { t } = useText();
  const kind = () => secretScopeKind(props.scope);
  const scopeName = () =>
    kind() === "agent"
      ? (props.agents.find((agent) => agent.id === props.scope)?.name ?? t("secrets.scope.unknownAgent"))
      : (props.spaces.find((space) => `space:${space.id}` === props.scope)?.name ?? t("secrets.scope.unknownSpace"));
  const description = () =>
    kind() === "shared"
      ? t("secrets.access.sharedScope")
      : kind() === "space"
        ? t("secrets.access.spaceScope", { name: scopeName() })
        : t("secrets.access.agentScope", { name: scopeName() });
  const listed = () => !(kind() === "shared" && props.access.everyone);
  const agentOptions = () =>
    props.agents.filter((agent) => agent.id !== props.scope && !props.access.agents.includes(agent.id));
  const spaceOptions = () =>
    props.spaces.filter((space) => `space:${space.id}` !== props.scope && !props.access.spaces.includes(space.id));
  return (
    <SettingsGroup title={t("secrets.access.title")} description={description()}>
      <Show when={kind() === "shared"}>
        <SettingsRow
          label={t("secrets.access.everyone")}
          description={t("secrets.access.everyoneDescription")}
          layout="inline"
        >
          <Switch
            checked={props.access.everyone}
            disabled={!props.owner}
            aria-label={t("secrets.access.everyone")}
            onChange={(everyone: boolean) => props.onChange({ ...props.access, everyone })}
          />
        </SettingsRow>
      </Show>
      <Show when={listed()}>
        <SettingsRow label={t("secrets.access.agents")} layout="stack">
          <div class="sv-access-list">
            <For each={props.access.agents}>
              {(agentId) => {
                const agent = () => props.agents.find((candidate) => candidate.id === agentId);
                return (
                  <span class="sv-access-chip">
                    <Show when={agent()}>{(member) => <MemberAvatar member={member()} size="xs" />}</Show>
                    {agent()?.name ?? t("secrets.scope.unknownAgent")}
                    <Show when={props.owner}>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("secrets.access.remove", { name: agent()?.name ?? agentId })}
                        onClick={() =>
                          props.onChange({
                            ...props.access,
                            agents: props.access.agents.filter((id) => id !== agentId),
                          })
                        }
                      >
                        <X />
                      </IconButton>
                    </Show>
                  </span>
                );
              }}
            </For>
            <Show when={props.access.agents.length === 0}>
              <span class="sv-access-empty">{t("secrets.access.none")}</span>
            </Show>
            <Show when={props.owner && agentOptions().length > 0}>
              <WorkspaceSelect
                label={t("secrets.access.addAgent")}
                value={ADD}
                options={[
                  { value: ADD, label: t("secrets.access.addAgent") },
                  ...agentOptions().map((agent) => ({ value: agent.id, label: agent.name })),
                ]}
                onChange={(id) => {
                  if (id !== ADD) props.onChange({ ...props.access, agents: [...props.access.agents, id] });
                }}
              />
            </Show>
          </div>
        </SettingsRow>
        <SettingsRow label={t("secrets.access.spaces")} layout="stack">
          <div class="sv-access-list">
            <For each={props.access.spaces}>
              {(spaceId) => {
                const space = () => props.spaces.find((candidate) => candidate.id === spaceId);
                return (
                  <span class="sv-access-chip">
                    {space()?.name ?? t("secrets.scope.unknownSpace")}
                    <Show when={props.owner}>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("secrets.access.remove", { name: space()?.name ?? spaceId })}
                        onClick={() =>
                          props.onChange({
                            ...props.access,
                            spaces: props.access.spaces.filter((id) => id !== spaceId),
                          })
                        }
                      >
                        <X />
                      </IconButton>
                    </Show>
                  </span>
                );
              }}
            </For>
            <Show when={props.access.spaces.length === 0}>
              <span class="sv-access-empty">{t("secrets.access.none")}</span>
            </Show>
            <Show when={props.owner && spaceOptions().length > 0}>
              <WorkspaceSelect
                label={t("secrets.access.addSpace")}
                value={ADD}
                options={[
                  { value: ADD, label: t("secrets.access.addSpace") },
                  ...spaceOptions().map((space) => ({ value: space.id, label: space.name })),
                ]}
                onChange={(id) => {
                  if (id !== ADD) props.onChange({ ...props.access, spaces: [...props.access.spaces, id] });
                }}
              />
            </Show>
          </div>
        </SettingsRow>
      </Show>
      <SettingsHelp>{props.owner ? t("secrets.access.blockedNote") : t("secrets.access.ownerOnly")}</SettingsHelp>
    </SettingsGroup>
  );
}

function DetailsGroup(props: {
  secret: SecretDetailData["secret"];
  onSave: (settings: {
    label: string;
    type: SecretKind;
    folder: string;
    tags: string[];
    note: string;
  }) => Promise<void>;
}) {
  const { t, errorMessage } = useText();
  const text = useSecretText();
  const saved = () => ({
    label: props.secret.label ?? "",
    type: props.secret.type,
    folder: props.secret.folder ?? "",
    tags: props.secret.tags.join(", "),
    note: props.secret.note ?? "",
  });
  const [draft, setDraft] = createSignal(saved());
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const dirty = () => JSON.stringify(draft()) !== JSON.stringify(saved());
  const folderError = () =>
    normalizeSecretFolder(draft().folder) === null ? t("secrets.details.folderInvalid") : null;
  const tagsError = () => (parseTags(draft().tags).every(isSecretTag) ? null : t("secrets.details.tagsInvalid"));
  const set = (field: keyof ReturnType<typeof saved>, value: string) => setDraft({ ...draft(), [field]: value });

  async function save() {
    if (busy() || folderError() || tagsError()) return;
    setBusy(true);
    setError(null);
    try {
      const current = draft();
      await props.onSave({
        label: current.label.trim(),
        type: current.type,
        folder: normalizeSecretFolder(current.folder) ?? "",
        tags: parseTags(current.tags),
        note: current.note.trim(),
      });
    } catch (failure) {
      setError(errorMessage(failure, t("secrets.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SettingsGroup title={t("secrets.details.title")}>
      <SettingsRow label={t("secrets.details.name")} description={<span class="sv-mono">{props.secret.name}</span>} />
      <SettingsRow
        label={t("secrets.details.label")}
        description={t("secrets.details.labelDescription")}
        controlId="sv-label"
      >
        <Input
          id="sv-label"
          value={draft().label}
          maxlength={80}
          onInput={(event) => set("label", event.currentTarget.value)}
        />
      </SettingsRow>
      <SettingsRow label={t("secrets.details.type")}>
        <WorkspaceSelect
          label={t("secrets.details.type")}
          value={draft().type}
          options={SECRET_KINDS.map((type) => ({ value: type, label: text.type(type) }))}
          onChange={(type) => setDraft({ ...draft(), type })}
        />
      </SettingsRow>
      <SettingsRow
        label={t("secrets.details.folder")}
        description={t("secrets.details.folderDescription")}
        help={folderError() ? <span data-tone="danger">{folderError()}</span> : undefined}
        controlId="sv-folder"
      >
        <Input
          id="sv-folder"
          value={draft().folder}
          maxlength={160}
          onInput={(event) => set("folder", event.currentTarget.value)}
        />
      </SettingsRow>
      <SettingsRow
        label={t("secrets.details.tags")}
        description={t("secrets.details.tagsDescription")}
        help={tagsError() ? <span data-tone="danger">{tagsError()}</span> : undefined}
        controlId="sv-tags"
      >
        <Input id="sv-tags" value={draft().tags} onInput={(event) => set("tags", event.currentTarget.value)} />
      </SettingsRow>
      <SettingsRow label={t("secrets.details.note")} layout="stack" controlId="sv-note">
        <Textarea
          id="sv-note"
          value={draft().note}
          maxlength={500}
          rows={3}
          onInput={(event) => set("note", event.currentTarget.value)}
        />
      </SettingsRow>
      <Show when={dirty()}>
        <div class="sv-save-row" role="status">
          <span class="sv-save-note">{error() ?? t("secrets.details.unsaved")}</span>
          <Button variant="ghost" size="sm" disabled={busy()} onClick={() => setDraft(saved())}>
            {t("secrets.details.reset")}
          </Button>
          <Button
            size="sm"
            disabled={Boolean(folderError() || tagsError())}
            loading={busy()}
            onClick={() => void save()}
          >
            {t("secrets.details.save")}
          </Button>
        </div>
      </Show>
    </SettingsGroup>
  );
}

function ChangeValueDialog(props: {
  open: boolean;
  name: string;
  onOpenChange: (open: boolean) => void;
  onSave: (value: string) => Promise<void>;
}) {
  const { t, errorMessage } = useText();
  const [value, setValue] = createSignal("");
  const [shown, setShown] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const close = (open: boolean) => {
    if (!open) {
      setValue("");
      setShown(false);
      setError(null);
    }
    props.onOpenChange(open);
  };
  return (
    <FormDialog
      open={props.open}
      onOpenChange={close}
      size="sm"
      dismissible={false}
      title={t("secrets.change.title", { name: props.name })}
      description={t("secrets.change.description")}
      submitLabel={t("secrets.change.submit")}
      submitDisabled={value().trim() === ""}
      busy={busy()}
      error={error()}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          await props.onSave(value().trim());
          close(false);
        } catch (failure) {
          setError(errorMessage(failure, t("secrets.failed")));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={t("secrets.change.value")}>
        <div class="sv-secret-input">
          <Input
            type={shown() ? "text" : "password"}
            class="sv-mono"
            autocomplete="off"
            spellcheck={false}
            value={value()}
            onInput={(event) => setValue(event.currentTarget.value)}
          />
          <IconButton
            variant="ghost"
            size="icon-sm"
            label={shown() ? t("secrets.value.hide") : t("secrets.value.show")}
            onClick={() => setShown(!shown())}
          >
            {shown() ? <EyeOff /> : <Eye />}
          </IconButton>
        </div>
      </Field>
    </FormDialog>
  );
}
