import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Copy, Eye, EyeOff, KeyRound, Pencil, Trash2 } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { EmptyState, ErrorState, LoadingState } from "../../view-state";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspaceList, WorkspaceListRow } from "./WorkspaceList";
import { PaneHeaderAction, WorkspacePaneHeader } from "./WorkspacePaneHeader";
import { WorkspaceSelect, type WorkspaceSelectOption } from "./WorkspaceSelect";
import type { WorkspaceMember } from "./workspace-types";

/** The keys of one scope: the shared ones, or one agent's. */
export interface SecretsGroup {
  scope: string;
  /** Absent for the shared keys. */
  agent?: WorkspaceMember | undefined;
  secrets: readonly { name: string; updatedAt: number }[];
}

export interface SecretsViewProps {
  /** Null while the list loads. */
  groups: readonly SecretsGroup[] | null;
  /** The list could not load: the reason, in the reader's language. */
  loadError?: string | null | undefined;
  /** Reads the list again after a failure. */
  onRetry?: (() => void) | undefined;
  /** Where a new key can go: the shared keys and each agent. */
  scopes: readonly WorkspaceSelectOption<string>[];
  namePattern: RegExp;
  onReveal: (scope: string, name: string) => Promise<string>;
  onCopy: (scope: string, name: string) => Promise<void>;
  onSave: (input: { scope: string; name: string; value: string }) => Promise<void>;
  onRemove: (scope: string, name: string) => Promise<void>;
  onBack?: (() => void) | undefined;
  /** More settings under the keys, such as the connector access links. */
  footer?: JSX.Element;
  class?: string;
}

/** How long a shown value stays on the screen. */
const REVEAL_MS = 30_000;

/**
 * The agent key store for the server owner: the keys that agents read as files, shared or one
 * agent's. Values stay hidden until the person shows or copies one.
 */
export function SecretsView(props: SecretsViewProps): JSX.Element {
  const { t, format, errorMessage } = useText();
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal({ scope: "shared", name: "", value: "" });
  const [busy, setBusy] = createSignal(false);
  const [removing, setRemoving] = createSignal<{ scope: string; name: string } | null>(null);
  const [formError, setFormError] = createSignal<string | null>(null);
  const [removeError, setRemoveError] = createSignal<string | null>(null);
  const nameValid = () => props.namePattern.test(draft().name);

  async function add() {
    const current = draft();
    if (!nameValid() || current.value.trim() === "" || busy()) return;
    setBusy(true);
    setFormError(null);
    try {
      await props.onSave(current);
      setDraft({ scope: current.scope, name: "", value: "" });
      setAdding(false);
    } catch (error) {
      // The form stays filled; the reason shows under it.
      setFormError(errorMessage(error, t("workspace.secrets.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section class={cx("ws-view ws-secrets", props.class)} aria-label={t("workspace.view.secrets")}>
      <WorkspacePaneHeader
        icon={<KeyRound aria-hidden="true" />}
        title={t("workspace.view.secrets")}
        subtitle={t("workspace.secrets.description")}
        onBack={props.onBack}
        actions={<PaneHeaderAction label={t("workspace.secrets.add")} onClick={() => setAdding(true)} />}
      />
      <div class="ws-view-scroll">
        <Show
          when={props.groups?.some((group) => group.secrets.length > 0)}
          fallback={
            <Show
              when={!props.loadError}
              fallback={
                <ErrorState
                  title={t("workspace.secrets.loadFailed")}
                  description={props.loadError}
                  onRetry={props.onRetry}
                />
              }
            >
              <Show when={props.groups !== null} fallback={<LoadingState label={t("workspace.view.secrets")} />}>
                <EmptyState
                  icon={<KeyRound />}
                  title={t("workspace.secrets.empty")}
                  description={t("workspace.secrets.emptyHint")}
                  action={<PaneHeaderAction label={t("workspace.secrets.add")} onClick={() => setAdding(true)} />}
                />
              </Show>
            </Show>
          }
        >
          <For each={(props.groups ?? []).filter((group) => group.secrets.length > 0)} keyed={(group) => group.scope}>
            {(group) => (
              <section class="ws-secrets-group">
                <h3 class="ws-secrets-group-title">
                  <Show when={group().agent} fallback={t("workspace.secrets.shared")}>
                    {(agent) => (
                      <>
                        <MemberAvatar member={agent()} size="xs" />
                        <span class="ws-truncate">{agent().name}</span>
                      </>
                    )}
                  </Show>
                </h3>
                <WorkspaceList>
                  <For each={group().secrets} keyed={(secret) => secret.name}>
                    {(secret) => (
                      <SecretRow
                        scope={group().scope}
                        name={secret().name}
                        updated={format.date(secret().updatedAt, { dateStyle: "medium", timeStyle: "short" })}
                        onReveal={props.onReveal}
                        onCopy={props.onCopy}
                        onSave={props.onSave}
                        onRemove={() => setRemoving({ scope: group().scope, name: secret().name })}
                      />
                    )}
                  </For>
                </WorkspaceList>
              </section>
            )}
          </For>
        </Show>
        {props.footer}
      </div>
      {/* A create flow is the shared form dialog: a sheet on a phone (docs/ux/standard.md § 2). */}
      <FormDialog
        open={adding()}
        onOpenChange={(open) => {
          if (open) return;
          setAdding(false);
          setFormError(null);
          setDraft({ scope: "shared", name: "", value: "" });
        }}
        title={t("workspace.secrets.add")}
        description={t("workspace.secrets.description")}
        size="sm"
        busy={busy()}
        error={formError()}
        submitLabel={t("workspace.secrets.add")}
        submitDisabled={!nameValid() || draft().value.trim() === ""}
        onSubmit={() => void add()}
      >
        <Field
          label={t("workspace.secrets.name")}
          required
          error={draft().name !== "" && !nameValid() ? t("workspace.secrets.invalidName") : undefined}
        >
          <Input
            value={draft().name}
            autocomplete="off"
            autocapitalize="characters"
            spellcheck={false}
            class="ws-secrets-mono"
            onInput={(event) =>
              setDraft((current) => ({
                ...current,
                name: event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
              }))
            }
          />
        </Field>
        <Field label={t("workspace.secrets.scope")}>
          <WorkspaceSelect
            value={draft().scope}
            options={props.scopes}
            label={t("workspace.secrets.scope")}
            onChange={(scope) => setDraft((current) => ({ ...current, scope }))}
          />
        </Field>
        <Field label={t("workspace.secrets.value")} required>
          <Input
            type="password"
            value={draft().value}
            autocomplete="new-password"
            class="ws-secrets-mono"
            onInput={(event) => setDraft((current) => ({ ...current, value: event.currentTarget.value }))}
          />
        </Field>
      </FormDialog>
      <ConfirmDialog
        open={removing() !== null}
        tone="destructive"
        title={t("workspace.secrets.deleteTitle", { name: removing()?.name ?? "" })}
        description={t("workspace.secrets.deleteBody")}
        confirmLabel={t("workspace.secrets.delete")}
        error={removeError() ?? undefined}
        onCancel={() => {
          setRemoving(null);
          setRemoveError(null);
        }}
        onConfirm={async () => {
          const target = removing();
          if (!target) return;
          setRemoveError(null);
          try {
            await props.onRemove(target.scope, target.name);
            setRemoving(null);
          } catch (error) {
            setRemoveError(errorMessage(error, t("workspace.secrets.failed")));
          }
        }}
      />
    </section>
  );
}

function SecretRow(props: {
  scope: string;
  name: string;
  updated: string;
  onReveal: SecretsViewProps["onReveal"];
  onCopy: SecretsViewProps["onCopy"];
  onSave: SecretsViewProps["onSave"];
  onRemove: () => void;
}): JSX.Element {
  const { t, errorMessage } = useText();
  const [value, setValue] = createSignal<string | null>(null);
  const [replacing, setReplacing] = createSignal(false);
  const [replacement, setReplacement] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(hideTimer));

  async function toggle() {
    if (value() !== null) {
      clearTimeout(hideTimer);
      setValue(null);
      return;
    }
    setValue(await props.onReveal(props.scope, props.name));
    hideTimer = setTimeout(() => setValue(null), REVEAL_MS);
  }

  async function replace() {
    if (replacement().trim() === "" || busy()) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSave({ scope: props.scope, name: props.name, value: replacement() });
      setReplacement("");
      setReplacing(false);
      setValue(null);
    } catch (failure) {
      setError(errorMessage(failure, t("workspace.secrets.failed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <WorkspaceListRow
      title={<code class="ws-secret-name">{props.name}</code>}
      actions={
        <>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={value() === null ? t("workspace.secrets.show") : t("workspace.secrets.hide")}
            onClick={() => void toggle().catch(() => undefined)}
          >
            <Show when={value() === null} fallback={<EyeOff />}>
              <Eye />
            </Show>
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t("workspace.secrets.copy")}
            onClick={() => void props.onCopy(props.scope, props.name).catch(() => undefined)}
          >
            <Copy />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t("workspace.secrets.replace")}
            onClick={() => setReplacing((open) => !open)}
          >
            <Pencil />
          </IconButton>
          <IconButton
            variant="ghost"
            size="icon-xs"
            label={t("workspace.secrets.delete")}
            onClick={() => props.onRemove()}
          >
            <Trash2 />
          </IconButton>
        </>
      }
    >
      <span class="ws-muted">{t("workspace.secrets.updated", { time: props.updated })}</span>
      <Show when={value()}>{(shown) => <code class="ws-secret-value">{shown()}</code>}</Show>
      <Show when={replacing()}>
        <form
          class="ws-secret-replace"
          onSubmit={(event) => {
            event.preventDefault();
            void replace();
          }}
        >
          <Input
            type="password"
            value={replacement()}
            autocomplete="new-password"
            placeholder={t("workspace.secrets.newValue")}
            class="ws-secrets-mono"
            aria-label={t("workspace.secrets.newValue")}
            onInput={(event) => setReplacement(event.currentTarget.value)}
          />
          <Button size="sm" type="submit" loading={busy()} disabled={replacement().trim() === ""}>
            {t("workspace.secrets.save")}
          </Button>
        </form>
        <Show when={error()}>
          {(message) => (
            <p class="ws-secrets-error" role="alert">
              {message()}
            </p>
          )}
        </Show>
      </Show>
    </WorkspaceListRow>
  );
}
