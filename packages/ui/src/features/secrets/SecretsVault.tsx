import {
  SECRET_KINDS,
  type SecretKind,
  type SecretOverview,
  type SecretRequest,
  type SecretSummary,
  type SecretVaultCall,
  type SecretVaultResult,
  secretHealth,
  secretSpaceScope,
  WORKSPACE_SECRET_NAME_PATTERN,
} from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import {
  ArchiveRestore,
  ChevronRight,
  CircleCheck,
  Download,
  Eye,
  EyeOff,
  Inbox,
  KeyRound,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Upload,
  X,
} from "../../icons";
import { SettingsGroup, SettingsHelp, SettingsRow } from "../../settings";
import { useText } from "../../text";
import { toast } from "../../toast";
import { cx, PHONE_LAYOUT_QUERY } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { MemberAvatar } from "../workspace/WorkspaceAvatar";
import { WorkspacePaneHeader } from "../workspace/WorkspacePaneHeader";
import { WorkspaceSelect } from "../workspace/WorkspaceSelect";
import type { WorkspaceMember } from "../workspace/workspace-types";
import { SecretDetail } from "./SecretDetail";
import { SecretTypeIcon, StatusBadge, useSecretText } from "./SecretParts";
import {
  displayName,
  EMPTY_FILTERS,
  filtersActive,
  groupSecrets,
  matchesSecret,
  type SecretFilters,
  type SecretGrouping,
  secretStats,
} from "./secrets-vault-model";

export interface SecretsVaultProps {
  /** Null while the list loads. */
  overview: SecretOverview | null;
  /** The list could not load: the reason, in the reader's language. */
  loadError?: string | null | undefined;
  onRetry?: (() => void) | undefined;
  agents: readonly WorkspaceMember[];
  spaces: readonly { id: string; name: string }[];
  /** The server's owner: shows and copies values, sets who may use a key, moves keys to another server. */
  owner: boolean;
  /** One call to the host. A failure throws, with the reason as its message. */
  call: (call: SecretVaultCall) => Promise<SecretVaultResult>;
  /** Writes the clipboard in the tap, from a value the host sends after it (Safari asks for that). */
  copyValue: (value: Promise<string>, name: string) => Promise<void>;
  /** Reads the keys again after a change. */
  refresh: () => void;
  onBack?: (() => void) | undefined;
  /** More settings under the keys: the links of chat apps and the agents' mailboxes. */
  footer?: JSX.Element;
  class?: string;
}

const SCOPE_FILTER_KEYS = {
  all: "secrets.filter.all",
  shared: "secrets.filter.shared",
  space: "secrets.filter.space",
  agent: "secrets.filter.agent",
} as const;

/** Whether the window is phone width now; it follows a rotation or a resize. */
function createPhoneLayout(): () => boolean {
  const query = typeof window === "undefined" ? undefined : window.matchMedia?.(PHONE_LAYOUT_QUERY);
  const [phone, setPhone] = createSignal(query?.matches ?? false);
  if (query) {
    const change = (event: MediaQueryListEvent) => setPhone(event.matches);
    query.addEventListener("change", change);
    onCleanup(() => query.removeEventListener("change", change));
  }
  return phone;
}

/**
 * The keys and passwords screen: an overview of their health, what agents ask for, a searchable list
 * grouped by who uses each key, and a page for each key. Values stay on the host until the owner shows
 * or copies one.
 */
export function SecretsVault(props: SecretsVaultProps): JSX.Element {
  const { t } = useText();
  const text = useSecretText();
  const phone = createPhoneLayout();
  const [filters, setFilters] = createSignal<SecretFilters>(EMPTY_FILTERS);
  const [grouping, setGrouping] = createSignal<SecretGrouping>("scope");
  const [selected, setSelected] = createSignal<{ scope: string; name: string } | null>(null);
  const [creating, setCreating] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  const now = () => Date.now();

  const secrets = () => props.overview?.secrets ?? [];
  const scopeLabel = (secret: SecretSummary) => text.scope(secret.scope, secret.access, props.agents, props.spaces);
  const stats = createMemo(() => secretStats(secrets(), now()));
  const shown = createMemo(() =>
    secrets().filter((secret) => matchesSecret(secret, filters(), scopeLabel(secret), now())),
  );
  const groups = createMemo(() =>
    groupSecrets(shown(), grouping(), {
      scope: (scope) =>
        text.scope(scope, secrets().find((secret) => secret.scope === scope)?.access, props.agents, props.spaces),
      type: (type) => text.type(type),
      noFolder: t("secrets.group.noFolder"),
    }),
  );
  const isSelected = (secret: SecretSummary) => {
    const current = selected();
    return current !== null && current.scope === secret.scope && current.name === secret.name;
  };
  const setFilter = (change: Partial<SecretFilters>) => setFilters({ ...filters(), ...change });

  return (
    <section
      class={cx("ws-view ws-secrets sv-root", props.class)}
      data-detail={selected() ? "open" : undefined}
      aria-label={t("secrets.title")}
    >
      <WorkspacePaneHeader
        icon={<KeyRound aria-hidden="true" />}
        title={t("secrets.title")}
        subtitle={props.overview ? t("secrets.subtitle", { count: secrets().length }) : undefined}
        onBack={props.onBack}
        actions={
          <Button size="sm" aria-label={t("secrets.new")} onClick={() => setCreating(true)}>
            <Plus />
            <span class="sv-new-label">{t("secrets.new")}</span>
          </Button>
        }
      />
      <div class="sv-layout">
        <div class="sv-main ws-view-scroll">
          <Show
            when={props.overview}
            fallback={
              <Show when={props.loadError} fallback={<LoadingState label={t("secrets.loading")} />}>
                {(reason) => (
                  <ErrorState title={t("secrets.loadFailed")} description={reason()} onRetry={props.onRetry} />
                )}
              </Show>
            }
          >
            {(overview) => (
              <div class="sv-content">
                <p class="sv-intro">{t("secrets.description")}</p>
                <Requests
                  requests={overview().requests}
                  agents={props.agents}
                  call={props.call}
                  refresh={props.refresh}
                />
                <Show when={secrets().length > 0}>
                  <Overview
                    stats={stats()}
                    active={filters().status}
                    onFilter={(status) => setFilter({ status: filters().status === status ? "any" : status })}
                  />
                </Show>
                <Show
                  when={secrets().length > 0}
                  fallback={
                    <EmptyState
                      icon={<KeyRound />}
                      title={t("secrets.empty")}
                      description={t("secrets.emptyHint")}
                      action={
                        <Button size="sm" onClick={() => setCreating(true)}>
                          <Plus />
                          {t("secrets.new")}
                        </Button>
                      }
                    />
                  }
                >
                  <div class="sv-toolbar">
                    <div class="sv-search">
                      <Search aria-hidden="true" />
                      <Input
                        type="search"
                        aria-label={t("secrets.search")}
                        placeholder={t("secrets.searchPlaceholder")}
                        value={filters().query}
                        onInput={(event) => setFilter({ query: event.currentTarget.value })}
                      />
                    </div>
                    <fieldset class="sv-chips">
                      <legend class="sr-only">{t("secrets.filter.scope")}</legend>
                      <For each={["all", "shared", "space", "agent"] as const}>
                        {(scope) => (
                          <Button
                            class="sv-chip"
                            variant={filters().scope === scope ? "secondary" : "ghost"}
                            size="sm"
                            aria-pressed={filters().scope === scope ? "true" : "false"}
                            onClick={() => setFilter({ scope })}
                          >
                            {t(SCOPE_FILTER_KEYS[scope])}
                          </Button>
                        )}
                      </For>
                    </fieldset>
                    <div class="sv-toolbar-end">
                      <WorkspaceSelect
                        label={t("secrets.filter.status")}
                        value={filters().status}
                        options={[
                          { value: "any", label: t("secrets.filter.anyStatus") },
                          { value: "attention", label: t("secrets.filter.attention") },
                          { value: "unused", label: t("secrets.filter.unused") },
                          { value: "never-rotated", label: t("secrets.filter.neverRotated") },
                        ]}
                        onChange={(status) => setFilter({ status })}
                      />
                      <WorkspaceSelect
                        label={t("secrets.group.by")}
                        prefix={t("secrets.group.by")}
                        value={grouping()}
                        options={[
                          { value: "scope", label: t("secrets.group.scope") },
                          { value: "folder", label: t("secrets.group.folder") },
                          { value: "type", label: t("secrets.group.type") },
                        ]}
                        onChange={setGrouping}
                      />
                    </div>
                  </div>
                  <Show
                    when={groups().length > 0}
                    fallback={
                      <EmptyState
                        icon={<Search />}
                        title={t("secrets.noMatch")}
                        description={t("secrets.noMatchHint")}
                        action={
                          <Show when={filtersActive(filters())}>
                            <Button variant="outline" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
                              {t("secrets.clearFilters")}
                            </Button>
                          </Show>
                        }
                      />
                    }
                  >
                    <For each={groups()} keyed={(group) => group.id}>
                      {(group) => (
                        <SettingsGroup
                          class="sv-group"
                          title={
                            <span class="sv-group-title">
                              <Show when={group().scope}>
                                {(scope) => {
                                  const agent = () => props.agents.find((candidate) => candidate.id === scope());
                                  return (
                                    <Show when={agent()}>
                                      {(member) => <MemberAvatar member={member()} size="xs" />}
                                    </Show>
                                  );
                                }}
                              </Show>
                              {group().title}
                              <span class="sv-group-count">{group().secrets.length}</span>
                            </span>
                          }
                        >
                          <div class="sv-table-head" aria-hidden="true">
                            <span>{t("secrets.column.name")}</span>
                            <span>{t("secrets.column.scope")}</span>
                            <span>{t("secrets.column.used")}</span>
                            <span>{t("secrets.column.changed")}</span>
                            <span>{t("secrets.column.status")}</span>
                          </div>
                          <ul class="sv-rows">
                            <For each={group().secrets} keyed={(secret) => `${secret.scope}/${secret.name}`}>
                              {(secret) => (
                                <SecretRow
                                  secret={secret()}
                                  scope={scopeLabel(secret())}
                                  selected={isSelected(secret())}
                                  onOpen={() => setSelected({ scope: secret().scope, name: secret().name })}
                                />
                              )}
                            </For>
                          </ul>
                        </SettingsGroup>
                      )}
                    </For>
                  </Show>
                </Show>
                <Trash items={overview().trash} owner={props.owner} call={props.call} refresh={props.refresh} />
                <SettingsGroup title={t("secrets.transfer.title")} description={t("secrets.transfer.description")}>
                  <SettingsRow
                    label={t("secrets.transfer.export")}
                    description={t("secrets.transfer.exportDescription")}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!props.owner || secrets().length === 0}
                      onClick={() => setExporting(true)}
                    >
                      <Download />
                      {t("secrets.transfer.export")}
                    </Button>
                  </SettingsRow>
                  <SettingsRow
                    label={t("secrets.transfer.import")}
                    description={t("secrets.transfer.importDescription")}
                  >
                    <Button variant="outline" size="sm" disabled={!props.owner} onClick={() => setImporting(true)}>
                      <Upload />
                      {t("secrets.transfer.import")}
                    </Button>
                  </SettingsRow>
                  <Show when={!props.owner}>
                    <SettingsHelp>{t("secrets.transfer.ownerOnly")}</SettingsHelp>
                  </Show>
                </SettingsGroup>
                <Show when={props.footer}>
                  <div class="sv-footer">{props.footer}</div>
                </Show>
              </div>
            )}
          </Show>
        </div>
        <Show when={selected()} keyed>
          {(current) => (
            <aside class="sv-side ws-view-scroll">
              <SecretDetail
                scope={current.scope}
                name={current.name}
                owner={props.owner}
                agents={props.agents}
                spaces={props.spaces}
                call={props.call}
                copyValue={props.copyValue}
                phone={phone()}
                onChanged={props.refresh}
                onClose={() => setSelected(null)}
              />
            </aside>
          )}
        </Show>
      </div>
      <CreateDialog
        open={creating()}
        onOpenChange={setCreating}
        agents={props.agents}
        spaces={props.spaces}
        existing={secrets()}
        onCreate={async (input) => {
          await props.call({ kind: "save", ...input });
          toast.success(t("secrets.create.done", { name: input.label || input.name }));
          props.refresh();
          setSelected({ scope: input.scope, name: input.name });
        }}
      />
      <ExportDialog open={exporting()} onOpenChange={setExporting} call={props.call} />
      <ImportDialog open={importing()} onOpenChange={setImporting} call={props.call} refresh={props.refresh} />
    </section>
  );
}

function SecretRow(props: { secret: SecretSummary; scope: string; selected: boolean; onOpen: () => void }) {
  const { t } = useText();
  const text = useSecretText();
  const health = () => secretHealth(props.secret, Date.now());
  return (
    <li class="sv-row-item">
      <Button
        variant="ghost"
        class="sv-row"
        data-selected={props.selected ? "true" : undefined}
        data-health={health()}
        aria-label={t("secrets.row.open", { name: displayName(props.secret) })}
        aria-current={props.selected ? "true" : undefined}
        onClick={props.onOpen}
      >
        <SecretTypeIcon type={props.secret.type} />
        <span class="sv-row-name">
          <span class="sv-row-title">{displayName(props.secret)}</span>
          <span class="sv-row-sub">
            <Show when={props.secret.label}>
              <span class="sv-mono">{props.secret.name}</span>
            </Show>
            <Show when={props.secret.folder}>{(folder) => <span class="sv-folder-chip">{folder()}</span>}</Show>
            <For each={props.secret.tags.slice(0, 3)}>{(tag) => <span class="sv-tag">#{tag}</span>}</For>
          </span>
        </span>
        <span class="sv-row-cell sv-row-scope">{props.scope}</span>
        <span class="sv-row-cell sv-row-used">
          {props.secret.lastUsedAt !== undefined
            ? t("secrets.row.used", { time: text.ago(props.secret.lastUsedAt) })
            : t("secrets.row.neverUsed")}
        </span>
        <span class="sv-row-cell sv-row-changed">
          {props.secret.rotatedAt !== undefined
            ? t("secrets.row.changed", { time: text.ago(props.secret.rotatedAt) })
            : t("secrets.row.neverChanged")}
        </span>
        <span class="sv-row-cell sv-row-status">
          <StatusBadge health={health()} />
        </span>
        <ChevronRight class="sv-row-chevron" aria-hidden="true" />
      </Button>
    </li>
  );
}

function Overview(props: {
  stats: ReturnType<typeof secretStats>;
  active: SecretFilters["status"];
  onFilter: (status: Exclude<SecretFilters["status"], "any">) => void;
}) {
  const { t } = useText();
  const healthy = () => props.stats.attention === 0;
  return (
    <div class="sv-overview">
      <div class="sv-health" data-tone={healthy() ? "ok" : "attention"} role="status">
        {healthy() ? <ShieldCheck aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
        <span>
          {healthy() ? t("secrets.health.ok") : t("secrets.health.attention", { count: props.stats.attention })}
        </span>
      </div>
      <div class="sv-stats">
        <div class="sv-stat">
          <span class="sv-stat-value">{props.stats.total}</span>
          <span class="sv-stat-label">{t("secrets.stat.total")}</span>
        </div>
        <Button
          variant="ghost"
          class="sv-stat"
          data-tone={props.stats.attention > 0 ? "attention" : undefined}
          aria-pressed={props.active === "attention" ? "true" : "false"}
          onClick={() => props.onFilter("attention")}
        >
          <span class="sv-stat-value">{props.stats.attention}</span>
          <span class="sv-stat-label">{t("secrets.stat.attention")}</span>
        </Button>
        <Button
          variant="ghost"
          class="sv-stat"
          aria-pressed={props.active === "unused" ? "true" : "false"}
          onClick={() => props.onFilter("unused")}
        >
          <span class="sv-stat-value">{props.stats.unused}</span>
          <span class="sv-stat-label">{t("secrets.stat.unused")}</span>
        </Button>
        <Button
          variant="ghost"
          class="sv-stat"
          aria-pressed={props.active === "never-rotated" ? "true" : "false"}
          onClick={() => props.onFilter("never-rotated")}
        >
          <span class="sv-stat-value">{props.stats.neverRotated}</span>
          <span class="sv-stat-label">{t("secrets.stat.neverRotated")}</span>
        </Button>
      </div>
    </div>
  );
}

function Requests(props: {
  requests: readonly SecretRequest[];
  agents: readonly WorkspaceMember[];
  call: SecretsVaultProps["call"];
  refresh: () => void;
}) {
  const { t, errorMessage } = useText();
  const [filling, setFilling] = createSignal<string | null>(null);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal<string | null>(null);
  const agentOf = (id: string) => props.agents.find((agent) => agent.id === id);
  async function answer(request: SecretRequest, call: SecretVaultCall, done: string) {
    setBusy(request.requestId);
    try {
      await props.call(call);
      toast.success(done);
      setFilling(null);
      setValue("");
      props.refresh();
    } catch (error) {
      toast.error(errorMessage(error, t("secrets.requests.failed")));
    } finally {
      setBusy(null);
    }
  }
  return (
    <Show when={props.requests.length > 0}>
      <SettingsGroup
        class="sv-requests"
        title={t("secrets.requests.title")}
        description={t("secrets.requests.description")}
      >
        <For each={props.requests} keyed={(request) => request.requestId}>
          {(request) => {
            const agent = () => agentOf(request().agentId);
            const agentName = () => agent()?.name ?? t("secrets.scope.unknownAgent");
            const label = () => {
              const item = request();
              if (item.kind === "approve")
                return t("secrets.requests.approve", {
                  agent: agentName(),
                  name: item.name,
                  site: siteName(item.site),
                });
              return t(item.shared ? "secrets.requests.fillShared" : "secrets.requests.fill", {
                agent: agentName(),
                name: item.name,
              });
            };
            return (
              <SettingsRow
                class="sv-request"
                layout={filling() === request().requestId ? "stack" : undefined}
                label={
                  <span class="sv-inline-member">
                    <Show when={agent()} fallback={<Inbox aria-hidden="true" />}>
                      {(member) => <MemberAvatar member={member()} size="sm" />}
                    </Show>
                    {label()}
                  </span>
                }
              >
                <Show
                  when={request().kind === "fill"}
                  fallback={
                    <div class="sv-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy() !== null}
                        onClick={() =>
                          void answer(
                            request(),
                            { kind: "approve", requestId: request().requestId, decision: "decline" },
                            t("secrets.requests.answered"),
                          )
                        }
                      >
                        {t("secrets.requests.deny")}
                      </Button>
                      <Button
                        size="sm"
                        loading={busy() === request().requestId}
                        disabled={busy() !== null}
                        onClick={() =>
                          void answer(
                            request(),
                            { kind: "approve", requestId: request().requestId, decision: "accept" },
                            t("secrets.requests.answered"),
                          )
                        }
                      >
                        {t("secrets.requests.allow")}
                      </Button>
                    </div>
                  }
                >
                  <Show
                    when={filling() === request().requestId}
                    fallback={
                      <Button size="sm" onClick={() => setFilling(request().requestId)}>
                        {t("secrets.requests.fillAction")}
                      </Button>
                    }
                  >
                    <form
                      class="sv-fill"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (value().trim())
                          void answer(
                            request(),
                            { kind: "fill", requestId: request().requestId, value: value().trim() },
                            t("secrets.requests.filled", { name: request().name }),
                          );
                      }}
                    >
                      <Input
                        type="password"
                        class="sv-mono"
                        autocomplete="off"
                        aria-label={t("secrets.requests.fillLabel", { name: request().name })}
                        value={value()}
                        onInput={(event) => setValue(event.currentTarget.value)}
                      />
                      <IconButton
                        variant="ghost"
                        size="icon-sm"
                        label={t("common.cancel")}
                        onClick={() => {
                          setFilling(null);
                          setValue("");
                        }}
                      >
                        <X />
                      </IconButton>
                      <Button
                        type="submit"
                        size="sm"
                        disabled={value().trim() === ""}
                        loading={busy() === request().requestId}
                      >
                        {t("secrets.requests.save")}
                      </Button>
                    </form>
                  </Show>
                </Show>
              </SettingsRow>
            );
          }}
        </For>
      </SettingsGroup>
    </Show>
  );
}

function siteName(site: string): string {
  try {
    return new URL(site).hostname;
  } catch {
    return site;
  }
}

function Trash(props: {
  items: SecretOverview["trash"];
  owner: boolean;
  call: SecretsVaultProps["call"];
  refresh: () => void;
}) {
  const { t, errorMessage } = useText();
  const text = useSecretText();
  const [purging, setPurging] = createSignal<{ scope: string; name: string; label: string } | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  return (
    <Show when={props.items.length > 0}>
      <SettingsGroup class="sv-trash" title={t("secrets.trash.title")} description={t("secrets.trash.description")}>
        <For each={props.items} keyed={(item) => `${item.scope}/${item.name}`}>
          {(item) => (
            <SettingsRow
              label={item().label || item().name}
              description={t("secrets.trash.deleted", { time: text.ago(item().deletedAt) })}
            >
              <div class="sv-actions">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    try {
                      await props.call({ kind: "restore", scope: item().scope, name: item().name });
                      toast.success(t("secrets.trash.restored", { name: item().label || item().name }));
                      props.refresh();
                    } catch (failure) {
                      toast.error(errorMessage(failure, t("secrets.failed")));
                    }
                  }}
                >
                  <ArchiveRestore />
                  {t("secrets.trash.restore")}
                </Button>
                <Show when={props.owner}>
                  <IconButton
                    variant="destructive-ghost"
                    size="icon-sm"
                    label={t("secrets.trash.purge")}
                    onClick={() =>
                      setPurging({ scope: item().scope, name: item().name, label: item().label || item().name })
                    }
                  >
                    <Trash2 />
                  </IconButton>
                </Show>
              </div>
            </SettingsRow>
          )}
        </For>
      </SettingsGroup>
      <ConfirmDialog
        open={purging() !== null}
        tone="destructive"
        title={t("secrets.trash.purgeTitle", { name: purging()?.label ?? "" })}
        description={t("secrets.trash.purgeDescription")}
        confirmLabel={t("secrets.trash.purge")}
        error={error() ?? undefined}
        onCancel={() => {
          setPurging(null);
          setError(null);
        }}
        onConfirm={async () => {
          const item = purging();
          if (!item) return;
          try {
            await props.call({ kind: "purge", scope: item.scope, name: item.name });
            toast.success(t("secrets.trash.purged", { name: item.label }));
            setPurging(null);
            props.refresh();
          } catch (failure) {
            setError(errorMessage(failure, t("secrets.failed")));
          }
        }}
      />
    </Show>
  );
}

interface CreateInput {
  scope: string;
  name: string;
  value: string;
  type: SecretKind;
  label?: string;
  folder?: string;
}

function CreateDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: readonly WorkspaceMember[];
  spaces: readonly { id: string; name: string }[];
  existing: readonly SecretSummary[];
  onCreate: (input: CreateInput) => Promise<void>;
}) {
  const { t, errorMessage } = useText();
  const text = useSecretText();
  const blank: { scope: string; name: string; value: string; type: SecretKind; label: string; folder: string } = {
    scope: "shared",
    name: "",
    value: "",
    type: "key",
    label: "",
    folder: "",
  };
  const [draft, setDraft] = createSignal(blank);
  const [typed, setTyped] = createSignal(false);
  const [shown, setShown] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const nameValid = () => WORKSPACE_SECRET_NAME_PATTERN.test(draft().name);
  const taken = () => props.existing.some((secret) => secret.scope === draft().scope && secret.name === draft().name);
  const nameError = () => {
    if (!draft().name) return undefined;
    if (!nameValid()) return t("secrets.create.nameInvalid");
    return taken() ? t("secrets.create.nameTaken") : undefined;
  };
  const close = (open: boolean) => {
    if (!open) {
      setDraft(blank);
      setTyped(false);
      setShown(false);
      setError(null);
    }
    props.onOpenChange(open);
  };
  const scopes = () => [
    { value: "shared", label: t("secrets.create.scopeShared") },
    ...props.spaces.map((space) => ({
      value: secretSpaceScope(space.id),
      label: t("secrets.create.scopeSpace", { name: space.name }),
    })),
    ...props.agents.map((agent) => ({ value: agent.id, label: t("secrets.create.scopeAgent", { name: agent.name }) })),
  ];
  return (
    <FormDialog
      open={props.open}
      onOpenChange={close}
      dismissible={false}
      title={t("secrets.create.title")}
      description={t("secrets.create.description")}
      submitLabel={t("secrets.create.submit")}
      submitDisabled={!nameValid() || taken() || draft().value.trim() === ""}
      busy={busy()}
      error={error()}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const current = draft();
          await props.onCreate({
            scope: current.scope,
            name: current.name,
            value: current.value.trim(),
            type: current.type,
            ...(current.label.trim() ? { label: current.label.trim() } : {}),
            ...(current.folder.trim() ? { folder: current.folder.trim() } : {}),
          });
          close(false);
        } catch (failure) {
          setError(errorMessage(failure, t("secrets.failed")));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field
        label={t("secrets.create.name")}
        description={t("secrets.create.nameDescription")}
        error={nameError()}
        required
      >
        <Input
          class="sv-mono"
          autocomplete="off"
          spellcheck={false}
          value={draft().name}
          placeholder={t("secrets.create.namePlaceholder")}
          onInput={(event) => {
            const name = event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/gu, "_");
            setDraft({ ...draft(), name, ...(typed() ? {} : { type: guessType(name) }) });
          }}
        />
      </Field>
      <Field label={t("secrets.create.value")} required>
        <div class="sv-secret-input">
          <Input
            type={shown() ? "text" : "password"}
            class="sv-mono"
            autocomplete="off"
            spellcheck={false}
            value={draft().value}
            onInput={(event) => setDraft({ ...draft(), value: event.currentTarget.value })}
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
      <Field label={t("secrets.create.scope")}>
        <WorkspaceSelect
          label={t("secrets.create.scope")}
          value={draft().scope}
          options={scopes()}
          onChange={(scope) => setDraft({ ...draft(), scope })}
        />
      </Field>
      <Field label={t("secrets.create.type")}>
        <WorkspaceSelect
          label={t("secrets.create.type")}
          value={draft().type}
          options={SECRET_KINDS.map((type) => ({ value: type, label: text.type(type) }))}
          onChange={(type) => {
            setTyped(true);
            setDraft({ ...draft(), type });
          }}
        />
      </Field>
      <Field label={t("secrets.create.label")}>
        <Input
          value={draft().label}
          maxlength={80}
          onInput={(event) => setDraft({ ...draft(), label: event.currentTarget.value })}
        />
      </Field>
      <Field label={t("secrets.create.folder")} description={t("secrets.details.folderDescription")}>
        <Input
          value={draft().folder}
          maxlength={160}
          placeholder={t("secrets.create.folderPlaceholder")}
          onInput={(event) => setDraft({ ...draft(), folder: event.currentTarget.value })}
        />
      </Field>
    </FormDialog>
  );
}

function guessType(name: string): SecretKind {
  if (/PASSWORD|PASSWD|_PASS$|PIN$/u.test(name)) return "password";
  if (/TOTP|2FA|MFA|OTP/u.test(name)) return "code";
  if (/TOKEN|BEARER|SESSION|COOKIE/u.test(name)) return "token";
  if (/KEY|SECRET/u.test(name)) return "key";
  return "other";
}

function ExportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: SecretsVaultProps["call"];
}) {
  const { t, errorMessage } = useText();
  const [passphrase, setPassphrase] = createSignal("");
  const [repeat, setRepeat] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const mismatch = () => repeat() !== "" && repeat() !== passphrase();
  const close = (open: boolean) => {
    if (!open) {
      setPassphrase("");
      setRepeat("");
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
      title={t("secrets.export.title")}
      description={t("secrets.export.dialogDescription")}
      submitLabel={t("secrets.export.submit")}
      submitDisabled={passphrase().length < 8 || passphrase() !== repeat()}
      busy={busy()}
      error={error()}
      onSubmit={async () => {
        setBusy(true);
        setError(null);
        try {
          const result = await props.call({ kind: "export", passphrase: passphrase() });
          if (result.kind !== "bundle") throw new Error(t("secrets.failed"));
          saveFile(t("secrets.export.fileName"), result.bundle);
          toast.success(t("secrets.export.done", { count: result.count }));
          close(false);
        } catch (failure) {
          setError(errorMessage(failure, t("secrets.failed")));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={t("secrets.export.passphrase")} description={t("secrets.export.passphraseDescription")} required>
        <Input
          type="password"
          autocomplete="new-password"
          value={passphrase()}
          onInput={(event) => setPassphrase(event.currentTarget.value)}
        />
      </Field>
      <Field label={t("secrets.export.repeat")} error={mismatch() ? t("secrets.export.mismatch") : undefined} required>
        <Input
          type="password"
          autocomplete="new-password"
          value={repeat()}
          onInput={(event) => setRepeat(event.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}

function saveFile(name: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function ImportDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  call: SecretsVaultProps["call"];
  refresh: () => void;
}) {
  const { t, errorMessage } = useText();
  const [file, setFile] = createSignal<{ name: string; text: string } | null>(null);
  const [passphrase, setPassphrase] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let picker: HTMLInputElement | undefined;
  const close = (open: boolean) => {
    if (!open) {
      setFile(null);
      setPassphrase("");
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
      title={t("secrets.import.title")}
      description={t("secrets.import.dialogDescription")}
      submitLabel={t("secrets.import.submit")}
      submitDisabled={!file() || passphrase().length < 8}
      busy={busy()}
      error={error()}
      onSubmit={async () => {
        const chosen = file();
        if (!chosen) return;
        setBusy(true);
        setError(null);
        try {
          const result = await props.call({ kind: "import", bundle: chosen.text.trim(), passphrase: passphrase() });
          if (result.kind !== "imported") throw new Error(t("secrets.failed"));
          toast.success(t("secrets.import.done", result));
          props.refresh();
          close(false);
        } catch (failure) {
          setError(errorMessage(failure, t("secrets.failed")));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label={t("secrets.import.file")} required>
        <div class="sv-file">
          <Button variant="outline" size="sm" onClick={() => picker?.click()}>
            <Upload />
            {t("secrets.import.choose")}
          </Button>
          <Show when={file()}>
            {(chosen) => (
              <span class="sv-file-name">
                <CircleCheck aria-hidden="true" />
                {t("secrets.import.chosen", { name: chosen().name })}
              </span>
            )}
          </Show>
          <Input
            ref={(element) => {
              picker = element;
            }}
            class="sr-only"
            type="file"
            tabindex={-1}
            aria-label={t("secrets.import.choose")}
            accept=".atelierkeys,text/plain,application/octet-stream"
            onChange={async (event) => {
              const chosen = event.currentTarget.files?.[0];
              if (chosen) setFile({ name: chosen.name, text: await chosen.text() });
            }}
          />
        </div>
      </Field>
      <Field label={t("secrets.import.passphrase")} required>
        <Input
          type="password"
          autocomplete="off"
          value={passphrase()}
          onInput={(event) => setPassphrase(event.currentTarget.value)}
        />
      </Field>
    </FormDialog>
  );
}
