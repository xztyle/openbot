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
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, For, Show } from "solid-js";
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
      <div class="flex flex-col gap-3">
        <ItemGroup class="settings-modal-card">
          <Item class="settings-modal-row">
            <ItemContent>
              <ItemTitle>{path() || t("backups.cloud.folderRoot")}</ItemTitle>
            </ItemContent>
            <Show when={path()}>
              <ItemActions>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending()}
                  onClick={() => void open(parentOf(path()))}
                >
                  {t("backups.cloud.folderUp")}
                </Button>
              </ItemActions>
            </Show>
          </Item>
          <Show when={listing()?.folders.length === 0}>
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemDescription>{t("backups.cloud.folderEmpty")}</ItemDescription>
              </ItemContent>
            </Item>
          </Show>
          <For each={listing()?.folders ?? []}>
            {(folder) => (
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemTitle>{folder}</ItemTitle>
                </ItemContent>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending()}
                    onClick={() => void open(path() ? `${path()}/${folder}` : folder)}
                  >
                    {t("backups.cloud.browsePick", { name: folder })}
                  </Button>
                </ItemActions>
              </Item>
            )}
          </For>
        </ItemGroup>
        <div class="flex items-end gap-2">
          <Field label={t("backups.cloud.folderNew")} class="flex-1">
            <Input value={name()} onValueChange={setName} />
          </Field>
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
        </div>
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
          <div class="flex items-center gap-2">
            <Checkbox id="cloud-folder-move" checked={mode() === "move"} onChange={() => setMode("move")} />
            <label for="cloud-folder-move">{t("backups.cloud.folderMove")}</label>
          </div>
          <p class="text-muted-foreground">{t("backups.cloud.folderMoveHint")}</p>
          <div class="flex items-center gap-2">
            <Checkbox id="cloud-folder-start" checked={mode() === "use"} onChange={() => setMode("use")} />
            <label for="cloud-folder-start">{t("backups.cloud.folderStart")}</label>
          </div>
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
      </div>
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
    <div class="flex items-center gap-2">
      <Checkbox
        id={`cloud-restore-${value}`}
        checked={kind() === value}
        onChange={() => {
          setKind(value);
          if (value === "files" && entries() === null) void open("/");
        }}
      />
      <label for={`cloud-restore-${value}`}>{label}</label>
    </div>
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
      <div class="flex flex-col gap-3">
        <p>{t("backups.cloud.restoreWhat")}</p>
        {choice("whole", t("backups.cloud.restoreWhole"))}
        {choice("some", t("backups.cloud.restoreSome"))}
        <Show when={kind() === "some"}>
          <div class="flex flex-col gap-2 ps-6">
            <For each={available()}>
              {(group) => (
                <div class="flex items-center gap-2">
                  <Checkbox
                    id={`cloud-restore-group-${group}`}
                    checked={groups().includes(group)}
                    onChange={(event) =>
                      setGroups((current) =>
                        event.currentTarget.checked ? [...current, group] : current.filter((item) => item !== group),
                      )
                    }
                  />
                  <label for={`cloud-restore-group-${group}`}>{t(GROUP_TEXT[group][0])}</label>
                </div>
              )}
            </For>
          </div>
        </Show>
        {choice("files", t("backups.cloud.restoreFiles"))}
        <Show when={kind() === "files"}>
          <ItemGroup class="settings-modal-card">
            <Item class="settings-modal-row">
              <ItemContent>
                <ItemTitle>{path()}</ItemTitle>
                <Show when={picked().length > 0}>
                  <ItemDescription>{t("backups.cloud.browsePicked", { count: picked().length })}</ItemDescription>
                </Show>
              </ItemContent>
              <Show when={path() !== "/"}>
                <ItemActions>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={pending()}
                    onClick={() => void open(parentOf(path()) || "/")}
                  >
                    {t("backups.cloud.browseUp")}
                  </Button>
                </ItemActions>
              </Show>
            </Item>
            <Show when={entries()?.length === 0}>
              <Item class="settings-modal-row">
                <ItemContent>
                  <ItemDescription>{t("backups.cloud.browseEmpty")}</ItemDescription>
                </ItemContent>
              </Item>
            </Show>
            <For each={entries() ?? []}>
              {(entry) => (
                <Item class="settings-modal-row">
                  <Checkbox
                    id={`cloud-pick-${entry.path}`}
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
                  <ItemContent>
                    <Show
                      when={entry.dir}
                      fallback={
                        <>
                          <ItemTitle>{entry.name}</ItemTitle>
                          <ItemDescription>{format.fileSize(entry.bytes)}</ItemDescription>
                        </>
                      }
                    >
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={pending()}
                        onClick={() => void open(entry.path)}
                      >
                        {entry.name}/
                      </Button>
                    </Show>
                  </ItemContent>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>
      </div>
    </FormDialog>
  );
}
