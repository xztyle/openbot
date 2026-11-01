import type { JSX } from "@solidjs/web";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { Button } from "../../button";
import { ConfirmDialog } from "../../confirm-dialog";
import { Input } from "../../form";
import { Copy, Eye, EyeOff, KeyRound, Pencil, Plus, Trash2 } from "../../icons";
import { useText } from "../../text";
import { cx } from "../../utils";
import { MemberAvatar } from "./WorkspaceAvatar";
import { WorkspacePaneHeader } from "./WorkspacePaneHeader";
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
  /** Where a new key can go: the shared keys and each agent. */
  scopes: readonly WorkspaceSelectOption<string>[];
  namePattern: RegExp;
  onReveal: (scope: string, name: string) => Promise<string>;
  onCopy: (scope: string, name: string) => Promise<void>;
  onSave: (input: { scope: string; name: string; value: string }) => Promise<void>;
  onRemove: (scope: string, name: string) => Promise<void>;
  onBack?: (() => void) | undefined;
  class?: string;
}

/** How long a shown value stays on the screen. */
const REVEAL_MS = 30_000;

/**
 * The agent key store for the server owner: the keys that agents read as files, shared or one
 * agent's. Values stay hidden until the person shows or copies one.
 */
export function SecretsView(props: SecretsViewProps): JSX.Element {
  const { t, format } = useText();
  const [adding, setAdding] = createSignal(false);
  const [draft, setDraft] = createSignal({ scope: "shared", name: "", value: "" });
  const [busy, setBusy] = createSignal(false);
  const [removing, setRemoving] = createSignal<{ scope: string; name: string } | null>(null);
  const nameValid = () => props.namePattern.test(draft().name);

  async function add() {
    const current = draft();
    if (!nameValid() || current.value.trim() === "" || busy()) return;
    setBusy(true);
    try {
      await props.onSave(current);
      setDraft({ scope: current.scope, name: "", value: "" });
      setAdding(false);
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
        actions={
          <Show when={!adding()}>
            <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              {t("workspace.secrets.add")}
            </Button>
          </Show>
        }
      />
      <div class="ws-view-scroll">
        <Show when={adding()}>
          <form
            class="ws-secrets-form"
            onSubmit={(event) => {
              event.preventDefault();
              void add();
            }}
          >
            <label class="ws-secrets-field">
              <span>{t("workspace.secrets.name")}</span>
              <Input
                value={draft().name}
                autocomplete="off"
                spellcheck={false}
                class="ws-secrets-mono"
                onInput={(event) =>
                  setDraft((current) => ({
                    ...current,
                    name: event.currentTarget.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
                  }))
                }
              />
              <Show when={draft().name !== "" && !nameValid()}>
                <small class="ws-secrets-error">{t("workspace.secrets.invalidName")}</small>
              </Show>
            </label>
            <div class="ws-secrets-field">
              <span>{t("workspace.secrets.scope")}</span>
              <WorkspaceSelect
                value={draft().scope}
                options={props.scopes}
                label={t("workspace.secrets.scope")}
                onChange={(scope) => setDraft((current) => ({ ...current, scope }))}
              />
            </div>
            <label class="ws-secrets-field">
              <span>{t("workspace.secrets.value")}</span>
              <Input
                type="password"
                value={draft().value}
                autocomplete="new-password"
                class="ws-secrets-mono"
                onInput={(event) => setDraft((current) => ({ ...current, value: event.currentTarget.value }))}
              />
            </label>
            <div class="ws-secrets-form-actions">
              <Button variant="ghost" size="sm" type="button" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" type="submit" loading={busy()} disabled={!nameValid() || draft().value.trim() === ""}>
                {t("workspace.secrets.save")}
              </Button>
            </div>
          </form>
        </Show>
        <Show
          when={props.groups?.some((group) => group.secrets.length > 0)}
          fallback={
            <p class="ws-view-empty">
              {props.groups === null ? t("workspace.secrets.loading") : t("workspace.secrets.empty")}
            </p>
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
                <ul class="ws-secrets-list">
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
                </ul>
              </section>
            )}
          </For>
        </Show>
      </div>
      <ConfirmDialog
        open={removing() !== null}
        tone="destructive"
        title={t("workspace.secrets.deleteTitle", { name: removing()?.name ?? "" })}
        description={t("workspace.secrets.deleteBody")}
        confirmLabel={t("workspace.secrets.delete")}
        onCancel={() => setRemoving(null)}
        onConfirm={async () => {
          const target = removing();
          if (!target) return;
          await props.onRemove(target.scope, target.name).catch(() => undefined);
          setRemoving(null);
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
  const { t } = useText();
  const [value, setValue] = createSignal<string | null>(null);
  const [replacing, setReplacing] = createSignal(false);
  const [replacement, setReplacement] = createSignal("");
  const [busy, setBusy] = createSignal(false);
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
    try {
      await props.onSave({ scope: props.scope, name: props.name, value: replacement() });
      setReplacement("");
      setReplacing(false);
      setValue(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li class="ws-secret">
      <div class="ws-secret-head">
        <span class="ws-secret-copy">
          <code class="ws-secret-name">{props.name}</code>
          <span class="ws-muted">{t("workspace.secrets.updated", { time: props.updated })}</span>
        </span>
        <span class="ws-secret-actions">
          <Button
            variant="ghost"
            size="xs"
            aria-label={value() === null ? t("workspace.secrets.show") : t("workspace.secrets.hide")}
            onClick={() => void toggle().catch(() => undefined)}
          >
            <Show when={value() === null} fallback={<EyeOff aria-hidden="true" />}>
              <Eye aria-hidden="true" />
            </Show>
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t("workspace.secrets.copy")}
            onClick={() => void props.onCopy(props.scope, props.name).catch(() => undefined)}
          >
            <Copy aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            aria-label={t("workspace.secrets.replace")}
            onClick={() => setReplacing((open) => !open)}
          >
            <Pencil aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="xs" aria-label={t("workspace.secrets.delete")} onClick={() => props.onRemove()}>
            <Trash2 aria-hidden="true" />
          </Button>
        </span>
      </div>
      <Show when={value()}>{(shown) => <code class="ws-secret-value">{shown()}</code>}</Show>
      <Show when={replacing()}>
        <form
          class="ws-secret-replace"
          onSubmit={(event) => {
            event.preventDefault();
            void replace().catch(() => undefined);
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
      </Show>
    </li>
  );
}
