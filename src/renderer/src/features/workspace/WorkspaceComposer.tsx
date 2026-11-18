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
import { broadcastAudience, draftBroadcast } from "./workspace-model";

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
  /** The agents a mention offers first: the members of the conversation. */
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
    const target = key();
    try {
      addFiles(await ws.channels.port().agent.chooseAttachments({ filter: "all" }), target);
    } catch (cause) {
      if (cause instanceof PartialAttachmentImportError) addFiles(cause.attachments, target);
      setError(errorMessage(cause, t("workspace.app.composer.attachFailed")));
    }
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
      const target = key();
      void importer(files)
        .then((imported) => addFiles(imported, target))
        .catch((cause: unknown) => {
          if (cause instanceof PartialAttachmentImportError) addFiles(cause.attachments, target);
          setError(errorMessage(cause, t("workspace.app.composer.attachFailed")));
        });
      return undefined;
    };
  };

  /** A message with files may lose its text in an edit; the files stay. */
  const editedHasFiles = () => {
    const current = editing();
    return current ? Boolean(findMessage(current.messageId)?.message.attachments?.length) : false;
  };
  const canSend = () =>
    !sending() && (value().trim().length > 0 || (editing() ? editedHasFiles() : attachments().length > 0));

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
      const text = value().trim();
      if (!text && !editedHasFiles()) return;
      setSending(true);
      try {
        await ws.editMessage(current.channelId, current.messageId, text);
      } catch (cause) {
        setError(errorMessage(cause, t("workspace.app.error.edit")));
      } finally {
        setSending(false);
      }
      return;
    }
    const text = value();
    const files = attachments();
    const body = text.trim();
    // The answer can come after the reader opened another conversation; the draft is this one's.
    const sentKey = key();
    setSending(true);
    ws.setDraft(sentKey, "");
    ws.noteTyping(props.channelId, props.threadRootId ?? null, false, true);
    setAttachments([], sentKey);
    try {
      await ws.send({
        channelId: props.channelId,
        text: body,
        attachmentDraftIds: files.map((file) => file.id),
        threadRootId: props.threadRootId ?? null,
        alsoToChannel: alsoSend(),
      });
      setAlsoSend(false);
    } catch (cause) {
      // The message stays in the box, so nothing the reader wrote is lost.
      if (!ws.draft(sentKey)) ws.setDraft(sentKey, text);
      setAttachments((current) => (current.length ? current : files), sentKey);
      setError(errorMessage(cause, t("workspace.app.composer.sendFailed")));
    } finally {
      setSending(false);
      setFocus((request) => request + 1);
    }
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
