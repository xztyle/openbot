import { channelKind, type DraftAttachment } from "@openbot/contracts/ipc";
import { Button, ConfirmDialog, IconButton, X } from "@openbot/ui";
import { AttachmentReferenceVisual } from "@openbot/ui/features/conversation/AttachmentReference";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import type { ComposerTextFormat } from "@openbot/ui/features/conversation/composer-format";
import { MessageComposer } from "@openbot/ui/features/workspace/MessageComposer";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { usePlatform } from "../../platform";
import { deviceSendShortcut } from "../../send-shortcut-preference";
import { PartialAttachmentImportError } from "../channels/channels-port";
import { composerToolbar, useComposerSources } from "./workspace-composer-sources";
import { useWorkspace } from "./workspace-context";
import { draftKey } from "./workspace-controller";
import { broadcastAudience, draftBroadcast, previewText } from "./workspace-model";
import type { OutboxMessage } from "./workspace-outbox";
import { useSecretHygiene } from "./workspace-secret-offer";

/**
 * A broadcast that would notify this many people or more asks first, as Slack does in a channel of
 * six or more members. Agents do not count: they answer only when they are mentioned.
 */
const BROADCAST_CONFIRM_AUDIENCE = 5;

/** The composer the reader used last. A file the desktop imports from a drop or a paste goes there. */
let lastComposer: symbol | null = null;

export interface WorkspaceComposerProps {
  channelId: string;
  /** Set in a thread: the reply goes to this root. */
  threadRootId?: string | null;
  /** "Message #general", "Reply…". */
  placeholder: string;
  label: string;
  /** In a thread of a channel: the name for "Also send to #name". */
  alsoSendTo?: string | undefined;
  /**
   * Only for a conversation the reader cannot write in, such as an archived one. The connection
   * never locks the box: typing always lands, and a message sent while it is away waits in the outbox.
   */
  disabled?: boolean;
  /** Asks the editor for the focus, such as when the conversation opens. */
  focusRequest?: number;
}

/**
 * The Slack message box of a conversation or a thread: formatting, mentions of people, agents,
 * `@channel` and `@here`, channel links, emoji by short code, files, drafts per conversation, ↑ to
 * edit the last message. On a computer the edit happens in place in the message; on a phone, as in
 * Slack's app, in this box.
 */
export function WorkspaceComposer(props: WorkspaceComposerProps) {
  const { t, errorMessage } = useText();
  const secrets = useSecretHygiene();
  const ws = useWorkspace();
  const platform = usePlatform();
  const id = Symbol("composer");
  const key = () => draftKey(props.channelId, props.threadRootId);
  // The files belong to the draft of the conversation or thread, so a switch away and back keeps them.
  const attachments = () => ws.draftFiles(key());
  const setAttachments = (
    next: readonly DraftAttachment[] | ((current: readonly DraftAttachment[]) => readonly DraftAttachment[]),
    target = key(),
  ) => ws.setDraftFiles(target, typeof next === "function" ? next(ws.draftFiles(target)) : next);
  const [sending, setSending] = createSignal(false);
  /**
   * The drafts with files on their way up, one entry per upload. Send waits for them, as in Slack:
   * a message sent meanwhile would leave without the photo, which would then land in an empty box.
   */
  const [uploads, setUploads] = createSignal<readonly string[]>([]);
  // The port reports progress only once files are chosen: a chooser left open, or one that Safari
  // closes without a word, holds nothing up.
  const uploading = () => uploads().includes(key()) && Boolean(ws.channels.port().importProgress?.());
  async function upload(target: string, files: () => Promise<readonly DraftAttachment[]>) {
    setUploads((current) => [...current, target]);
    try {
      addFiles(await files(), target);
    } catch (cause) {
      if (cause instanceof PartialAttachmentImportError) addFiles(cause.attachments, target);
      setError(errorMessage(cause, t("workspace.app.composer.attachFailed")));
    } finally {
      setUploads((current) => {
        const index = current.indexOf(target);
        return index < 0 ? current : [...current.slice(0, index), ...current.slice(index + 1)];
      });
    }
  }
  const [error, setError] = createSignal<string | null>(null);
  const [alsoSend, setAlsoSend] = createSignal(false);
  const [format, setFormat] = createSignal<{ id: number; format: ComposerTextFormat } | undefined>();
  const [focus, setFocus] = createSignal(untrack(() => props.focusRequest ?? 0));
  const [editText, setEditText] = createSignal("");
  const [textRequest, setTextRequest] = createSignal<{ id: number; text: string } | undefined>();
  const [broadcastConfirm, setBroadcastConfirm] = createSignal<{ kind: "channel" | "here"; count: number } | null>(
    null,
  );
  createEffect(
    () => props.focusRequest ?? 0,
    (request) => {
      if (request) setFocus(request);
    },
  );

  /** The edit of a message in this box: only on a phone. A computer edits the message in place. */
  const editing = createMemo(() => {
    const current = ws.state.editing;
    return ws.env.phone() &&
      current &&
      current.channelId === props.channelId &&
      current.threadRootId === (props.threadRootId ?? null)
      ? current
      : null;
  });
  createEffect(editing, (current) => {
    if (!current) return;
    const message = untrack(() => findMessage(current.messageId));
    setEditText(message?.message.text ?? "");
    setFocus((value) => value + 1);
  });
  const value = () => (editing() ? editText() : ws.draft(key()));
  const setValue = (text: string) => {
    if (editing()) setEditText(text);
    else {
      // Only an edit counts as typing, not the editor saying again what the draft holds.
      const edited = text !== ws.draft(key());
      ws.setDraft(key(), text);
      if (edited) ws.noteTyping(props.channelId, props.threadRootId ?? null, text.trim().length > 0);
    }
  };
  // Leaving the conversation or the thread ends the typing there.
  createEffect(
    () => ({ channelId: props.channelId, threadRootId: props.threadRootId ?? null }),
    (_current, previous) => {
      if (previous) ws.noteTyping(previous.channelId, previous.threadRootId, false);
    },
  );
  onCleanup(() => ws.noteTyping(props.channelId, props.threadRootId ?? null, false));

  function transcript() {
    if (props.threadRootId) {
      const page = ws.state.thread?.page;
      return page?.channel.id === props.channelId ? page.messages : [];
    }
    const page = ws.channels.state.page;
    return page?.channel.id === props.channelId ? page.messages : [];
  }
  function findMessage(messageId: string) {
    return transcript().find((entry) => entry.id === messageId);
  }

  const { people, mentionAgents, channelLinks, isChannel, emojiSearch } = useComposerSources(() => props.channelId);
  const toolbar = composerToolbar(props.threadRootId ? "thread" : "main");

  /** `target` is the draft that asked for the files: a picker can close after the reader moved on. */
  function addFiles(files: readonly DraftAttachment[], target = key()) {
    if (!files.length) return;
    setAttachments(
      (current) => [...current, ...files.filter((file) => !current.some((item) => item.id === file.id))],
      target,
    );
  }

  async function attach() {
    lastComposer = id;
    setError(null);
    // The chooser opens in this call, inside the tap: nothing is awaited before it.
    const chosen = ws.channels.port().agent.chooseAttachments({ filter: "all" });
    await upload(key(), () => chosen);
  }

  function removeFile(file: DraftAttachment) {
    setAttachments((current) => current.filter((item) => item.id !== file.id));
    void ws.channels
      .port()
      .agent.discardDraftAttachment?.(file.id)
      ?.catch(() => undefined);
  }

  onSettled(() => {
    const port = ws.channels.port();
    const unsubscribe = port.onAttachmentImport?.((event) => {
      if (event.type === "completed" && lastComposer === id) addFiles(event.attachments);
      if (event.type === "error" && lastComposer === id) setError(event.message);
    });
    return () => unsubscribe?.();
  });
  onCleanup(() => {
    if (lastComposer === id) lastComposer = null;
  });

  /** Uploads pasted files on the web; the desktop preload imports them and reports them above. */
  const pasteFiles = () => {
    const importer = ws.channels.port().importAttachments;
    if (!importer) return undefined;
    return (files: File[]) => {
      void upload(key(), () => importer(files));
      return undefined;
    };
  };

  /** A message with files may lose its text in an edit; the files stay. */
  const editedHasFiles = () => {
    const current = editing();
    return current ? Boolean(findMessage(current.messageId)?.message.attachments?.length) : false;
  };
  const canSend = () =>
    !sending() &&
    (editing() !== null || !uploading()) &&
    (value().trim().length > 0 || (editing() ? editedHasFiles() : attachments().length > 0));

  /** The broadcast in the draft that needs a confirmation before it goes, or null. */
  function pendingBroadcast(): { kind: "channel" | "here"; count: number } | null {
    const summary = ws.summary(props.channelId);
    if (!summary || channelKind(summary) !== "channel") return null;
    const kind = draftBroadcast(value());
    if (!kind) return null;
    const people = ws.env.people().map((person) => person.id);
    const count = broadcastAudience(ws.directory(), summary, people);
    return count >= BROADCAST_CONFIRM_AUDIENCE ? { kind, count } : null;
  }

  async function submit(broadcastConfirmed = false) {
    if (!canSend() || props.disabled) return;
    if (!editing() && !broadcastConfirmed) {
      const broadcast = pendingBroadcast();
      if (broadcast) {
        setBroadcastConfirm(broadcast);
        return;
      }
    }
    setError(null);
    const current = editing();
    if (current) {
      const scanned = secrets.scan(value().trim());
      const text = scanned.text;
      if (!text && !editedHasFiles()) return;
      setSending(true);
      try {
        await ws.editMessage(current.channelId, current.messageId, text);
        secrets.offer(scanned.found);
      } catch (cause) {
        setError(errorMessage(cause, t("workspace.app.error.edit")));
      } finally {
        setSending(false);
      }
      return;
    }
    const files = attachments();
    // A pasted key or password never reaches the host: a marker takes its place, and a notice
    // offers to save it in Secrets.
    const scanned = secrets.scan(value().trim());
    const body = scanned.text;
    // The message goes to the outbox, which sends it now or once the connection is back: the box
    // is free for the next one at once, and nothing the reader wrote waits on the network.
    const sentKey = key();
    ws.send({
      channelId: props.channelId,
      text: body,
      attachments: files,
      threadRootId: props.threadRootId ?? null,
      alsoToChannel: alsoSend(),
    });
    ws.setDraft(sentKey, "");
    ws.noteTyping(props.channelId, props.threadRootId ?? null, false, true);
    setAttachments([], sentKey);
    setAlsoSend(false);
    setFocus((request) => request + 1);
    secrets.offer(scanned.found);
  }

  /** ↑ in an empty box edits the reader's last message, as in Slack. Escape ends an edit. */
  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    // Escape ends an edit: in this box on a phone, or in place on a computer.
    if (event.key === "Escape" && (editing() || ws.state.editing)) {
      event.preventDefault();
      ws.stopEditing();
      return;
    }
    if (event.key !== "ArrowUp" || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (value() || editing()) return;
    const own = [...transcript()]
      .reverse()
      .find(
        (entry) =>
          entry.author.kind === "member" &&
          !entry.externalAuthor &&
          !entry.deletedAt &&
          entry.message.text.trim() &&
          ws.env.isReader(entry.author.id) &&
          (props.threadRootId ? entry.id !== props.threadRootId : !entry.threadRootId),
      );
    if (!own) return;
    event.preventDefault();
    // The editor of this box hears the key after this frame; it must not take the focus back from
    // the edit that opens in the message.
    event.stopPropagation();
    ws.startEditing(props.channelId, own.id, props.threadRootId ?? null);
  }

  return (
    <div
      class="ws-composer-frame"
      data-picker-mount=""
      ref={(element) => {
        // The editor owns the keys; the frame only hears the ones it lets through.
        element.addEventListener("focusin", () => {
          lastComposer = id;
        });
        element.addEventListener("keydown", keyDown);
      }}
    >
      <Show when={!editing() && ws.outbox.of(key()).length > 0}>
        <OutboxList
          messages={ws.outbox.of(key())}
          online={ws.env.connectionReady()}
          onRetry={(message) => ws.outbox.retry(message.id)}
          onDiscard={(message) => {
            ws.outbox.discard(message.id);
            // Its files were uploads for this message only.
            for (const fileId of message.attachmentDraftIds)
              void ws.channels
                .port()
                .agent.discardDraftAttachment?.(fileId)
                ?.catch(() => undefined);
          }}
          onEdit={
            value().trim()
              ? undefined
              : (message) => {
                  ws.outbox.discard(message.id);
                  setValue(message.text);
                  // The files go back with the text, and "Also send to" as it was.
                  addFiles(message.attachments ?? []);
                  if (message.alsoToChannel) setAlsoSend(true);
                  setFocus((request) => request + 1);
                }
          }
        />
      </Show>
      <MessageComposer
        label={props.label}
        class={editing() ? "ws-composer-editing" : undefined}
        notice={
          <>
            <Show when={editing()}>
              <div class="ws-composer-edit-notice">
                <span>{t("workspace.app.composer.editing")}</span>
                <Button variant="link" size="xs" onClick={() => ws.stopEditing()}>
                  {t("workspace.app.composer.cancelEdit")}
                </Button>
              </div>
            </Show>
            <Show when={error()}>
              {(message) => (
                <p class="ws-composer-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={!editing() && uploading()}>
              <p class="ws-composer-upload" role="status">
                {t("composer.upload.progress", {
                  current: ws.channels.port().importProgress?.()?.current ?? 0,
                  total: ws.channels.port().importProgress?.()?.total ?? 0,
                })}
              </p>
            </Show>
          </>
        }
        attachments={
          <Show when={!editing() && attachments().length > 0}>
            <ul class="ws-composer-files">
              <For each={attachments()} keyed={(file) => file.id}>
                {(file) => (
                  <li class="ws-composer-file">
                    <AttachmentReferenceVisual name={file().name} />
                    <span class="ws-composer-file-name">{file().name}</span>
                    <IconButton
                      variant="ghost"
                      size="icon-xs"
                      label={t("workspace.app.composer.removeFile", { name: file().name })}
                      onClick={() => removeFile(file())}
                    >
                      <X />
                    </IconButton>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        }
        editor={
          <div class="ws-composer-editor-anchor" data-picker-anchor="">
            <ComposerEditor
              agentId={key()}
              agents={mentionAgents()}
              members={people()}
              broadcasts={isChannel()}
              channels={channelLinks()}
              attachments={[...attachments()]}
              value={value()}
              placeholder={props.placeholder}
              ariaLabel={props.label}
              disabled={props.disabled === true}
              focusRequest={focus()}
              formatRequest={format()}
              textRequest={textRequest()}
              formatShortcuts
              codeFenceLines
              emojiSearch={emojiSearch}
              // The user's send key on a desktop. On a phone Return adds a line and only Send sends.
              sendShortcut={deviceSendShortcut(platform.appInfo()?.platform)}
              onValueChange={setValue}
              onSubmit={() => void submit()}
              onPasteFiles={pasteFiles()}
            />
          </div>
        }
        onFormat={(next) => setFormat((current) => ({ id: (current?.id ?? 0) + 1, format: next }))}
        toolbarShown={toolbar.shown()}
        onToolbarShownChange={toolbar.setShown}
        onAttach={editing() ? undefined : () => void attach()}
        emojiPicker={{
          onPick: (emoji) => {
            ws.noteEmoji(emoji);
            setTextRequest((current) => ({ id: (current?.id ?? 0) + 1, text: emoji }));
          },
          recent: ws.state.emoji.recent,
          skinTone: ws.state.emoji.skinTone,
          onSkinToneChange: (tone) => ws.setSkinTone(tone),
        }}
        onSend={() => void submit()}
        canSend={canSend()}
        sending={sending()}
        disabled={props.disabled}
        alsoSendTo={
          props.threadRootId && props.alsoSendTo && !editing()
            ? { channelName: props.alsoSendTo, checked: alsoSend(), onChange: setAlsoSend }
            : undefined
        }
      />
      <ConfirmDialog
        open={broadcastConfirm() !== null}
        tone="default"
        title={t("workspace.app.composer.broadcast.title", { count: broadcastConfirm()?.count ?? 0 })}
        description={t(
          broadcastConfirm()?.kind === "here"
            ? "workspace.app.composer.broadcast.here"
            : "workspace.app.composer.broadcast.channel",
          { channel: ws.summary(props.channelId)?.name ?? "" },
        )}
        confirmLabel={t("workspace.app.composer.broadcast.send")}
        onCancel={() => {
          setBroadcastConfirm(null);
          setFocus((request) => request + 1);
        }}
        onConfirm={() => {
          setBroadcastConfirm(null);
          void submit(true);
        }}
      />
    </div>
  );
}

/**
 * The reader's messages that the host has not taken yet, under the conversation as Slack shows
 * them: one that waits for the connection says so, one on its way says Sending, and one the host
 * refused offers Retry. Edit takes it back into an empty box.
 */
function OutboxList(props: {
  messages: readonly OutboxMessage[];
  online: boolean;
  onRetry: (message: OutboxMessage) => void;
  onDiscard: (message: OutboxMessage) => void;
  onEdit: ((message: OutboxMessage) => void) | undefined;
}) {
  const { t } = useText();
  return (
    <ul class="ws-outbox" aria-label={t("workspace.app.outbox.label")}>
      <For each={props.messages} keyed={(message) => message.id}>
        {(message) => (
          <li class="ws-outbox-message" data-state={message().state} data-online={props.online ? "" : undefined}>
            <p class="ws-outbox-text">
              {previewText(message().text, 400) ||
                t("workspace.app.outbox.files", { count: message().attachmentDraftIds.length })}
            </p>
            <div class="ws-outbox-status" role="status">
              <span>
                {message().state === "failed"
                  ? (message().error ?? t("workspace.app.outbox.failed"))
                  : message().state === "sending" || props.online
                    ? t("workspace.app.outbox.sending")
                    : t("workspace.app.outbox.waiting")}
              </span>
              <Show when={message().state === "failed"}>
                <Button variant="link" size="xs" onClick={() => props.onRetry(message())}>
                  {t("workspace.app.outbox.retry")}
                </Button>
              </Show>
              <Show when={message().state !== "sending" && props.onEdit}>
                {(edit) => (
                  <Button variant="link" size="xs" onClick={() => edit()(message())}>
                    {t("workspace.app.outbox.edit")}
                  </Button>
                )}
              </Show>
              <Show when={message().state !== "sending"}>
                <Button variant="link" size="xs" onClick={() => props.onDiscard(message())}>
                  {t("workspace.app.outbox.discard")}
                </Button>
              </Show>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}
