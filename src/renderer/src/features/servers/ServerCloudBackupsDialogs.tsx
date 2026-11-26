import type {
  CloudBrowseResult,
  CloudConnectResult,
  CloudEntry,
  CloudFolderList,
  CloudGroup,
  CloudSnapshot,
} from "@openbot/contracts/team-protocol/host-cloud-backups-v1";
import {
  Alert,
  AlertContent,
  AlertDescription,
  Button,
  Checkbox,
  Field,
  FormDialog,
  Input,
  SettingsGroup,
  SettingsHelp,
  SettingsRow,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createUniqueId, For, Show } from "solid-js";
import { GROUP_TEXT, PROBLEM_TEXT } from "./cloud-backups-text";

const parentOf = (path: string): string => path.split("/").slice(0, -1).join("/");

/**
 * Picks the drive folder for the copies: browse, make a folder, then move the copies there or start
 * there (its own copies if it has some, new ones if not).
 */
export function CloudFolderDialog(props: {
  open: boolean;
  /** The folder the copies are in now. */
  current: string;
  list: (path: string, create: boolean) => Promise<CloudFolderList>;
  choose: (folder: string, mode: "move" | "use", repositoryPassword?: string) => Promise<CloudConnectResult>;
  onClose: () => void;
  onChanged: (result: CloudConnectResult, mode: "move" | "use") => void;
}) {
  const { t, errorMessage } = useText();
  const ids = createUniqueId();
  const [path, setPath] = createSignal("");
  const [listing, setListing] = createSignal<CloudFolderList | null>(null);
  const [name, setName] = createSignal("");
  const [mode, setMode] = createSignal<"move" | "use">("move");
  const [repository, setRepository] = createSignal("");
  const [askRepository, setAskRepository] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  async function open(next: string, create = false): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await props.list(next, create);
      setListing(result);
      setPath(result.path);
      if (!result.ok) setError(t(PROBLEM_TEXT[result.problem ?? "other"]));
      if (result.hasCopies) setMode("use");
    } catch (failure) {
      setError(errorMessage(failure, t("backups.cloud.problem.other")));
    } finally {
      setPending(false);
    }
  }

  createEffect(
    () => props.open,
    (isOpen) => {
      if (!isOpen) return;
      setName("");
      setRepository("");
      setAskRepository(false);
      setMode("move");
      void open(parentOf(props.current));
    },
  );

  async function submit(): Promise<void> {
    if (pending() || !path() || path() === props.current) return;
    setPending(true);
    setError(null);
    try {
      const chosen = listing()?.hasCopies ? "use" : mode();
      const result = await props.choose(path(), chosen, repository().trim() || undefined);
      if (result.ok) {
        props.onChanged(result, chosen);
        return;
      }
      if (result.problem === "repository-password") setAskRepository(true);
      setError(t(PROBLEM_TEXT[result.problem]));
    } catch (failure) {
      setError(errorMessage(failure, t("backups.cloud.problem.other")));
    } finally {
      setPending(false);
    }
  }

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending()) props.onClose();
      }}
      dismissible={false}
      title={t("backups.cloud.folderTitle")}
      description={t("backups.cloud.folderDescription")}
      submitLabel={t("backups.cloud.folderUse")}
      submitDisabled={!path() || path() === props.current}
      busy={pending()}
      error={error()}
      onSubmit={() => void submit()}
    >
      <SettingsGroup label={t("backups.cloud.folderTitle")}>
        <SettingsRow label={path() || t("backups.cloud.folderRoot")} layout="inline">
          <Show when={path()}>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending()}
              onClick={() => void open(parentOf(path()))}
            >
              {t("backups.cloud.folderUp")}
            </Button>
          </Show>
        </SettingsRow>
        <Show when={listing() === null && pending()}>
          <SettingsHelp>{t("backups.cloud.connect.busy")}</SettingsHelp>
        </Show>
        <Show when={listing()?.folders.length === 0}>
          <SettingsRow label={t("backups.cloud.folderEmpty")} />
        </Show>
        <For each={listing()?.folders ?? []}>
          {(folder) => (
            <SettingsRow label={folder} layout="inline">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={pending()}
                onClick={() => void open(path() ? `${path()}/${folder}` : folder)}
              >
                {t("backups.cloud.browsePick", { name: folder })}
              </Button>
            </SettingsRow>
          )}
        </For>
      </SettingsGroup>
      <SettingsRow label={t("backups.cloud.folderNew")} controlId={`${ids}-folder-name`} layout="stack">
        <Input id={`${ids}-folder-name`} value={name()} onValueChange={setName} />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={pending() || !name().trim() || name().includes("/")}
          onClick={() => {
            const next = path() ? `${path()}/${name().trim()}` : name().trim();
            setName("");
            void open(next, true);
          }}
        >
          {t("backups.cloud.folderCreate")}
        </Button>
      </SettingsRow>
      <Show
        when={!listing()?.hasCopies}
        fallback={
          <Alert tone="neutral" role="status">
            <AlertContent>
              <AlertDescription>{t("backups.cloud.folderHasCopies")}</AlertDescription>
            </AlertContent>
          </Alert>
        }
      >
        <SettingsGroup label={t("backups.cloud.folderUse")}>
          <SettingsRow
            layout="inline"
            label={t("backups.cloud.folderMove")}
            description={t("backups.cloud.folderMoveHint")}
            controlId={`${ids}-move`}
          >
            <Checkbox id={`${ids}-move`} checked={mode() === "move"} onChange={() => setMode("move")} />
          </SettingsRow>
          <SettingsRow layout="inline" label={t("backups.cloud.folderStart")} controlId={`${ids}-start`}>
            <Checkbox id={`${ids}-start`} checked={mode() === "use"} onChange={() => setMode("use")} />
          </SettingsRow>
        </SettingsGroup>
        <Show when={mode() === "use"}>
          <Alert tone="warning" role="status">
            <AlertContent>
              <AlertDescription>{t("backups.cloud.folderStartWarning")}</AlertDescription>
            </AlertContent>
          </Alert>
        </Show>
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

const RESTORABLE: CloudGroup[] = ["database", "conversations", "agents", "settings", "motion", "work"];

/**
 * Restores one copy into its own folder on the server: the whole copy, some of its parts, or files and
 * folders picked inside it.
 */
export function CloudRestoreDialog(props: {
  snapshot: CloudSnapshot | null;
  when: (iso: string) => string;
  browse: (snapshot: string, path: string) => Promise<CloudBrowseResult>;
  restore: (pick: { groups?: CloudGroup[]; paths?: string[] }) => Promise<void>;
  onClose: () => void;
}) {
  const { t, format, errorMessage } = useText();
  const ids = createUniqueId();
  const [kind, setKind] = createSignal<"whole" | "some" | "files">("whole");
  const [groups, setGroups] = createSignal<CloudGroup[]>([]);
  const [path, setPath] = createSignal("/");
  const [entries, setEntries] = createSignal<CloudEntry[] | null>(null);
  const [picked, setPicked] = createSignal<string[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [pending, setPending] = createSignal(false);

  createEffect(
    () => props.snapshot?.id,
    (id) => {
      if (!id) return;
      setKind("whole");
      setGroups([]);
      setPicked([]);
      setEntries(null);
      setPath("/");
      setError(null);
    },
  );

  const available = () => {
    const held = props.snapshot?.groups ?? [];
    return held.length ? RESTORABLE.filter((group) => held.includes(group)) : RESTORABLE;
  };

  async function open(next: string): Promise<void> {
    const snapshot = props.snapshot;
    if (!snapshot) return;
    setPending(true);
    setError(null);
    try {
      const result = await props.browse(snapshot.id, next);
      setEntries(result.entries);
      setPath(next);
      if (!result.ok) setError(t(PROBLEM_TEXT[result.problem ?? "other"]));
    } catch (failure) {
      setError(errorMessage(failure, t("backups.cloud.problem.other")));
    } finally {
      setPending(false);
    }
  }

  async function submit(): Promise<void> {
    if (pending()) return;
    setPending(true);
    setError(null);
    try {
      await props.restore(kind() === "some" ? { groups: groups() } : kind() === "files" ? { paths: picked() } : {});
    } catch (failure) {
      setError(errorMessage(failure, t("backups.cloud.problem.other")));
    } finally {
      setPending(false);
    }
  }

  const choice = (value: "whole" | "some" | "files", label: string) => (
    <SettingsRow layout="inline" label={label} controlId={`${ids}-${value}`}>
      <Checkbox
        id={`${ids}-${value}`}
        checked={kind() === value}
        onChange={() => {
          setKind(value);
          if (value === "files" && entries() === null) void open("/");
        }}
      />
    </SettingsRow>
  );

  return (
    <FormDialog
      open={props.snapshot !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen && !pending()) props.onClose();
      }}
      dismissible={false}
      title={t("backups.cloud.restoreConfirmTitle", { when: props.when(props.snapshot?.time ?? "") })}
      description={t("backups.cloud.restoreConfirmDescription")}
      submitLabel={t("backups.cloud.restoreConfirm")}
      submitDisabled={(kind() === "some" && groups().length === 0) || (kind() === "files" && picked().length === 0)}
      busy={pending()}
      error={error()}
      onSubmit={() => void submit()}
    >
      <SettingsGroup title={t("backups.cloud.restoreWhat")}>
        {choice("whole", t("backups.cloud.restoreWhole"))}
        {choice("some", t("backups.cloud.restoreSome"))}
        <Show when={kind() === "some"}>
          <For each={available()}>
            {(group) => (
              <SettingsRow
                layout="inline"
                label={t(GROUP_TEXT[group][0])}
                description={t(GROUP_TEXT[group][1])}
                controlId={`${ids}-group-${group}`}
              >
                <Checkbox
                  id={`${ids}-group-${group}`}
                  checked={groups().includes(group)}
                  onChange={(event) =>
                    setGroups((current) =>
                      event.currentTarget.checked ? [...current, group] : current.filter((item) => item !== group),
                    )
                  }
                />
              </SettingsRow>
            )}
          </For>
        </Show>
        {choice("files", t("backups.cloud.restoreFiles"))}
      </SettingsGroup>
      <Show when={kind() === "files"}>
        <SettingsGroup label={t("backups.cloud.restoreFiles")}>
          <SettingsRow
            layout="inline"
            label={path()}
            description={picked().length > 0 ? t("backups.cloud.browsePicked", { count: picked().length }) : undefined}
          >
            <Show when={path() !== "/"}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={pending()}
                onClick={() => void open(parentOf(path()) || "/")}
              >
                {t("backups.cloud.browseUp")}
              </Button>
            </Show>
          </SettingsRow>
          <Show when={entries() === null && pending()}>
            <SettingsHelp>{t("backups.cloud.connect.busy")}</SettingsHelp>
          </Show>
          <Show when={entries()?.length === 0}>
            <SettingsRow label={t("backups.cloud.browseEmpty")} />
          </Show>
          <For each={entries() ?? []}>
            {(entry) => (
              <SettingsRow
                layout="inline"
                label={
                  <Show when={entry.dir} fallback={entry.name}>
                    <Button
                      type="button"
                      size="sm"
                      variant="link"
                      disabled={pending()}
                      onClick={() => void open(entry.path)}
                    >
                      {entry.name}/
                    </Button>
                  </Show>
                }
                description={entry.dir ? undefined : format.fileSize(entry.bytes)}
                controlId={entry.dir ? undefined : `${ids}-pick-${entry.path}`}
              >
                <Checkbox
                  id={`${ids}-pick-${entry.path}`}
                  aria-label={t("backups.cloud.browsePick", { name: entry.name })}
                  checked={picked().includes(entry.path)}
                  onChange={(event) =>
                    setPicked((current) =>
                      event.currentTarget.checked
                        ? [...current, entry.path]
                        : current.filter((item) => item !== entry.path),
                    )
                  }
                />
              </SettingsRow>
            )}
          </For>
        </SettingsGroup>
      </Show>
    </FormDialog>
  );
}
