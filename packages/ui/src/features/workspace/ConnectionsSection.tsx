import {
  CONNECTOR_INBOX_SCHEMES,
  type ConnectorAccessState,
  type ConnectorInbox,
  type ConnectorInboxScheme,
} from "@openbot/contracts/team-protocol/connector-access-v1";
import type { AppTextKey } from "@openbot/i18n";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, For, Show } from "solid-js";
import { Badge } from "../../badge";
import { Button, IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Copy, Pencil, Plus, Trash2 } from "../../icons";
import { SettingsGroup, SettingsRow } from "../../settings";
import { useText } from "../../text";
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
  const [revokeError, setRevokeError] = createSignal<string | null>(null);
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

  const gatewayReady = () => props.state.gateway.listening && Boolean(props.state.gateway.publicUrl);

  return (
    <>
      <SettingsGroup
        title={t("workspace.connections.chatTitle")}
        description={t("workspace.connections.chatDescription")}
        actions={
          <Button variant="outline" size="sm" disabled={!gatewayReady()} onClick={() => setCreating(true)}>
            <Plus />
            {t("workspace.connections.newLink")}
          </Button>
        }
      >
        <Show when={!gatewayReady()}>
          <SettingsRow
            label={t("workspace.connections.gatewayStatus")}
            description={t("workspace.connections.gatewayOff")}
            help={
              <details class="ws-technical">
                <summary>{t("workspace.connections.technical")}</summary>
                <span>{t("workspace.connections.gatewayOffDetails")}</span>
              </details>
            }
          >
            <Badge variant="warning-light">{t("workspace.connections.statusOff")}</Badge>
          </SettingsRow>
        </Show>
        <Show
          when={props.state.tokens.length > 0}
          fallback={<SettingsRow label={t("workspace.connections.noLinks")} />}
        >
          <For each={props.state.tokens} keyed={(token) => token.id}>
            {(token) => (
              <SettingsRow
                layout="inline"
                label={token().label}
                description={
                  token().lastUsedAt === null
                    ? t("workspace.connections.neverUsed", { time: when(token().createdAt) })
                    : t("workspace.connections.lastUsed", { time: when(token().lastUsedAt ?? 0) })
                }
              >
                <IconButton
                  variant="ghost"
                  size="icon-sm"
                  label={t("workspace.connections.revoke")}
                  onClick={() => {
                    setRevokeError(null);
                    setRevoking(token().id);
                  }}
                >
                  <Trash2 />
                </IconButton>
              </SettingsRow>
            )}
          </For>
        </Show>
      </SettingsGroup>
      <SettingsGroup
        title={t("workspace.connections.hooksTitle")}
        description={t("workspace.connections.hooksDescription")}
      >
        <Show when={inboxes().length > 0} fallback={<SettingsRow label={t("workspace.connections.hooksEmpty")} />}>
          <For each={inboxes()} keyed={(inbox) => inbox.routeId}>
            {(inbox) => (
              <SettingsRow
                layout="inline"
                label={inbox().routineName}
                description={t("workspace.connections.inboxLine", {
                  owner: inbox().ownerName,
                  sender: t(SCHEME_LABEL[inbox().scheme]),
                })}
                help={
                  <Show when={inbox().lastEventAt}>
                    {(time) =>
                      t("workspace.connections.lastEvent", {
                        time: when(time()),
                        status: String(inbox().lastStatus ?? ""),
                      })
                    }
                  </Show>
                }
              >
                <Show when={hookUrl(inbox())}>
                  {(url) => (
                    <IconButton
                      variant="ghost"
                      size="icon-sm"
                      label={t("workspace.connections.copyUrl")}
                      onClick={() => void props.onCopy(url())}
                    >
                      <Copy />
                    </IconButton>
                  )}
                </Show>
                <IconButton
                  variant="ghost"
                  size="icon-sm"
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
              </SettingsRow>
            )}
          </For>
        </Show>
      </SettingsGroup>
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
        error={revokeError()}
        onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          const id = revoking();
          // A refused revoke keeps the dialog open with the reason: the link still works.
          try {
            if (id) await props.onRevokeToken(id);
            setRevoking(null);
          } catch (cause) {
            setRevokeError(errorMessage(cause, t("workspace.connections.failed")));
          }
        }}
      />
    </>
  );
}
