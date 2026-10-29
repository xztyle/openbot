import { channelKind, channelVisibility, type DraftAttachment } from "@openbot/contracts/ipc";
import { Button, IconButton, X } from "@openbot/ui";
import { AttachmentReferenceVisual } from "@openbot/ui/features/conversation/AttachmentReference";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import type { ComposerTextFormat } from "@openbot/ui/features/conversation/composer-format";
import type { ComposerChannel, ComposerMember } from "@openbot/ui/features/conversation/composer-picker";
import { MessageComposer } from "@openbot/ui/features/workspace/MessageComposer";
import { useText } from "@openbot/ui/text";
import { createEffect, createMemo, createSignal, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { PartialAttachmentImportError } from "../channels/channels-port";
import { useWorkspace } from "./workspace-context";
import { draftKey } from "./workspace-controller";
import { readerJoined } from "./workspace-model";

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
 * `@channel` and `@here`, channel links, files, drafts per conversation, ↑ to edit the last message.
 */
export function WorkspaceComposer(props: WorkspaceComposerProps) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const id = Symbol("composer");
  const key = () => draftKey(props.channelId, props.threadRootId);
  const [attachments, setAttachments] = createSignal<DraftAttachment[]>([]);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [alsoSend, setAlsoSend] = createSignal(false);
  const [format, setFormat] = createSignal<{ id: number; format: ComposerTextFormat } | undefined>();
  const [focus, setFocus] = createSignal(untrack(() => props.focusRequest ?? 0));
  const [editText, setEditText] = createSignal("");
  const [textRequest, setTextRequest] = createSignal<{ id: number; text: string } | undefined>();
  createEffect(
    () => props.focusRequest ?? 0,
    (request) => {
      if (request) setFocus(request);
    },
  );

  const editing = createMemo(() => {
    const current = ws.state.editing;
    return current && current.channelId === props.channelId && current.threadRootId === (props.threadRootId ?? null)
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
      ws.setDraft(key(), text);
      ws.noteTyping(props.channelId, props.threadRootId ?? null, text.trim().length > 0);
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

  const people = createMemo((): ComposerMember[] =>
    ws.env
      .people()
      .filter((person) => !ws.env.isReader(person.id))
      .map((person) => ({ id: person.id, name: person.name, avatarUrl: person.avatarUrl })),
  );
  const channelLinks = createMemo((): ComposerChannel[] =>
    ws.channels.state.channels
      .filter(
        (channel) =>
          !channel.archived &&
          channelKind(channel) === "channel" &&
          (channelVisibility(channel) === "public" || readerJoined(ws.directory(), channel)),
      )
      .map((channel) => ({ id: channel.id, name: channel.name, private: channelVisibility(channel) === "private" })),
  );
  const isChannel = () => {
    const summary = ws.summary(props.channelId);
    return summary ? channelKind(summary) !== "dm" : true;
  };

  function addFiles(files: readonly DraftAttachment[]) {
    if (!files.length) return;
    setAttachments((current) => [...current, ...files.filter((file) => !current.some((item) => item.id === file.id))]);
  }

  async function attach() {
    lastComposer = id;
    setError(null);
    try {
      addFiles(await ws.channels.port().agent.chooseAttachments({ filter: "all" }));
    } catch (cause) {
      if (cause instanceof PartialAttachmentImportError) addFiles(cause.attachments);
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
      void importer(files)
        .then(addFiles)
        .catch((cause: unknown) => {
          if (cause instanceof PartialAttachmentImportError) addFiles(cause.attachments);
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

  async function submit() {
    if (!canSend() || props.disabled) return;
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
    setSending(true);
    ws.setDraft(key(), "");
    ws.noteTyping(props.channelId, props.threadRootId ?? null, false, true);
    setAttachments([]);
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
      if (!ws.draft(key())) ws.setDraft(key(), text);
      setAttachments((current) => (current.length ? current : files));
      setError(errorMessage(cause, t("workspace.app.composer.sendFailed")));
    } finally {
      setSending(false);
      setFocus((request) => request + 1);
    }
  }

  /** ↑ in an empty box edits the reader's last message, as in Slack. Escape ends an edit. */
  function keyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && editing()) {
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
              agents={ws.env.agents()}
              members={people()}
              broadcasts={isChannel()}
              channels={channelLinks()}
              attachments={attachments()}
              value={value()}
              placeholder={props.placeholder}
              ariaLabel={props.label}
              disabled={props.disabled === true}
              focusRequest={focus()}
              formatRequest={format()}
              textRequest={textRequest()}
              formatShortcuts
              onValueChange={setValue}
              onSubmit={() => void submit()}
              onPasteFiles={pasteFiles()}
            />
          </div>
        }
        onFormat={(next) => setFormat((current) => ({ id: (current?.id ?? 0) + 1, format: next }))}
        defaultToolbarHidden={Boolean(props.threadRootId)}
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
    </div>
  );
}
