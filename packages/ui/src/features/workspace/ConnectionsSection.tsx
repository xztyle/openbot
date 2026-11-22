import {
  CONNECTOR_INBOX_SCHEMES,
  type ConnectorAccessState,
  type ConnectorInbox,
  type ConnectorInboxScheme,
} from "@openbot/contracts/team-protocol/connector-access-v1";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Copy, Pencil, Trash2 } from "../../icons";
import { useText } from "../../text";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { PaneHeaderAction } from "./WorkspacePaneHeader";
import { WorkspaceSelect } from "./WorkspaceSelect";

export interface ConnectionsSectionProps {
  state: ConnectorAccessState;
  /** The space whose webhook routines show. */
  spaceId: string;
  onCreateToken: (label: string) => Promise<{ token: string; url: string | null }>;
  onRevokeToken: (id: string) => Promise<void>;
  onSetSender: (input: { routeId: string; scheme: ConnectorInboxScheme; secret?: string }) => Promise<void>;
  onCopy: (text: string) => Promise<void>;
}

const SCHEME_LABEL = {
  openbot: "workspace.connections.scheme.openbot",
  stripe: "workspace.connections.scheme.stripe",
  hotmart: "workspace.connections.scheme.hotmart",
  youtube: "workspace.connections.scheme.youtube",
} as const satisfies Record<ConnectorInboxScheme, AppTextKey>;

const SCHEME_HINT = {
  openbot: "workspace.connections.hint.openbot",
  stripe: "workspace.connections.hint.stripe",
  hotmart: "workspace.connections.hint.hotmart",
  youtube: "workspace.connections.hint.youtube",
} as const satisfies Record<ConnectorInboxScheme, AppTextKey>;

/**
 * The connector gateway for the owner, under Secrets: access links that let a chat app such as
 * Claude or ChatGPT reach the agents, and who sends to each webhook routine of this space.
 */
export function ConnectionsSection(props: ConnectionsSectionProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const [creating, setCreating] = createSignal(false);
  const [label, setLabel] = createSignal("");
  const [created, setCreated] = createSignal<{ token: string; url: string | null } | null>(null);
  const [revoking, setRevoking] = createSignal<string | null>(null);
  const [editing, setEditing] = createSignal<ConnectorInbox | null>(null);
  const [scheme, setScheme] = createSignal<ConnectorInboxScheme>("openbot");
  const [secret, setSecret] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const inboxes = createMemo(() => props.state.inboxes.filter((inbox) => inbox.spaceId === props.spaceId));
  const when = (time: number) => format.date(time, { dateStyle: "medium", timeStyle: "short" });
  const hookUrl = (inbox: ConnectorInbox) =>
    props.state.gateway.publicUrl ? `${props.state.gateway.publicUrl}/hooks/${inbox.routeId}` : null;
  // A provider needs its secret unless the saved one belongs to the same provider.
  const secretNeeded = () => {
    const inbox = editing();
    return scheme() !== "openbot" && !(inbox?.scheme === scheme() && inbox.hasSecret) && secret().trim() === "";
  };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause, t("workspace.connections.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section class="ws-secrets-group">
        <h3 class="ws-secrets-group-title">{t("workspace.connections.chatTitle")}</h3>
        <p class="ws-muted">{t("workspace.connections.chatDescription")}</p>
        <Show when={!props.state.gateway.listening || !props.state.gateway.publicUrl}>
          <p class="ws-muted">{t("workspace.connections.gatewayOff")}</p>
        </Show>
        <WorkspaceList>
          <For each={props.state.tokens} keyed={(token) => token.id}>
            {(token) => (
              <WorkspaceListRow
                title={token().label}
                actions={
                  <IconButton
                    variant="ghost"
                    size="icon-xs"
                    label={t("workspace.connections.revoke")}
                    onClick={() => setRevoking(token().id)}
                  >
                    <Trash2 />
                  </IconButton>
                }
              >
                <span class="ws-muted">
                  {token().lastUsedAt === null
                    ? t("workspace.connections.neverUsed", { time: when(token().createdAt) })
                    : t("workspace.connections.lastUsed", { time: when(token().lastUsedAt ?? 0) })}
                </span>
              </WorkspaceListRow>
            )}
          </For>
        </WorkspaceList>
        <PaneHeaderAction label={t("workspace.connections.newLink")} onClick={() => setCreating(true)} />
      </section>
      <section class="ws-secrets-group">
        <h3 class="ws-secrets-group-title">{t("workspace.connections.hooksTitle")}</h3>
        <p class="ws-muted">{t("workspace.connections.hooksDescription")}</p>
        <Show when={inboxes().length > 0} fallback={<p class="ws-muted">{t("workspace.connections.hooksEmpty")}</p>}>
          <WorkspaceList>
            <For each={inboxes()} keyed={(inbox) => inbox.routeId}>
              {(inbox) => (
                <WorkspaceListRow
                  title={inbox().routineName}
                  actions={
                    <>
                      <Show when={hookUrl(inbox())}>
                        {(url) => (
                          <IconButton
                            variant="ghost"
                            size="icon-xs"
                            label={t("workspace.connections.copyUrl")}
                            onClick={() => void props.onCopy(url())}
                          >
                            <Copy />
                          </IconButton>
                        )}
                      </Show>
                      <IconButton
                        variant="ghost"
                        size="icon-xs"
                        label={t("workspace.connections.sender")}
                        onClick={() => {
                          setEditing(inbox());
                          setScheme(inbox().scheme);
                          setSecret("");
                          setError(null);
                        }}
                      >
                        <Pencil />
                      </IconButton>
                    </>
                  }
                >
                  <span class="ws-muted">
                    {t("workspace.connections.inboxLine", {
                      owner: inbox().ownerName,
                      sender: t(SCHEME_LABEL[inbox().scheme]),
                    })}
                  </span>
                  <Show when={inbox().lastEventAt}>
                    {(time) => (
                      <span class="ws-muted">
                        {t("workspace.connections.lastEvent", {
                          time: when(time()),
                          status: String(inbox().lastStatus ?? ""),
                        })}
                      </span>
                    )}
                  </Show>
                </WorkspaceListRow>
              )}
            </For>
          </WorkspaceList>
        </Show>
      </section>
      <FormDialog
        open={creating()}
        onOpenChange={(open) => {
          if (open) return;
          setCreating(false);
          setLabel("");
          setError(null);
        }}
        title={t("workspace.connections.newLink")}
        description={t("workspace.connections.newLinkDescription")}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("workspace.connections.create")}
        submitDisabled={label().trim() === ""}
        onSubmit={() =>
          void run(async () => {
            setCreated(await props.onCreateToken(label().trim()));
            setCreating(false);
            setLabel("");
          })
        }
      >
        <Field label={t("workspace.connections.label")} required>
          <Input
            value={label()}
            maxlength={60}
            placeholder={t("workspace.connections.labelPlaceholder")}
            onValueChange={setLabel}
          />
        </Field>
      </FormDialog>
      <FormDialog
        open={created() !== null}
        onOpenChange={(open) => {
          if (!open) setCreated(null);
        }}
        title={t("workspace.connections.createdTitle")}
        description={t("workspace.connections.createdDescription")}
        size="sm"
        submitLabel={t("workspace.connections.copyLink")}
        onSubmit={() => {
          const shown = created();
          if (shown) void props.onCopy(shown.url ?? shown.token);
        }}
      >
        <Field label={created()?.url ? t("workspace.connections.link") : t("workspace.connections.token")}>
          <Input readonly value={created()?.url ?? created()?.token ?? ""} class="ws-secrets-mono" />
        </Field>
      </FormDialog>
      <FormDialog
        open={editing() !== null}
        onOpenChange={(open) => {
          if (open) return;
          setEditing(null);
          setSecret("");
          setError(null);
        }}
        title={t("workspace.connections.sender")}
        description={editing()?.routineName}
        size="sm"
        busy={busy()}
        error={error()}
        submitLabel={t("workspace.connections.save")}
        submitDisabled={secretNeeded()}
        onSubmit={() =>
          void run(async () => {
            const inbox = editing();
            if (!inbox) return;
            await props.onSetSender({
              routeId: inbox.routeId,
              scheme: scheme(),
              ...(secret().trim() ? { secret: secret().trim() } : {}),
            });
            setEditing(null);
            setSecret("");
          })
        }
      >
        <Field label={t("workspace.connections.sender")}>
          <WorkspaceSelect
            value={scheme()}
            options={CONNECTOR_INBOX_SCHEMES.map((value) => ({
              value,
              label: t(SCHEME_LABEL[value]),
            }))}
            label={t("workspace.connections.sender")}
            onChange={(value) => setScheme(value)}
          />
        </Field>
        <p class="ws-muted">{t(SCHEME_HINT[scheme()])}</p>
        <Show when={scheme() !== "openbot"}>
          <Field label={t("workspace.connections.secret")} required={secretNeeded()}>
            <Input
              type="password"
              value={secret()}
              autocomplete="new-password"
              class="ws-secrets-mono"
              placeholder={editing()?.hasSecret ? t("workspace.connections.secretKept") : undefined}
              onValueChange={setSecret}
            />
          </Field>
        </Show>
      </FormDialog>
      <ConfirmDialog
        open={revoking() !== null}
        tone="destructive"
        title={t("workspace.connections.revokeTitle")}
        description={t("workspace.connections.revokeDescription")}
        confirmLabel={t("workspace.connections.revoke")}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const id = revoking();
          if (id) await props.onRevokeToken(id);
          setRevoking(null);
        }}
      />
    </>
  );
}
