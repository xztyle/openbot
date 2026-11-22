import type { ChannelMessage } from "@openbot/contracts/ipc";
import { ComposerEditor } from "@openbot/ui/features/conversation/ComposerEditor";
import type { ComposerTextFormat } from "@openbot/ui/features/conversation/composer-format";
import { MessageComposer } from "@openbot/ui/features/workspace/MessageComposer";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled, Show, untrack } from "solid-js";
import { composerToolbar, useComposerSources } from "./workspace-composer-sources";
import { useWorkspace } from "./workspace-context";
import { useSecretHygiene } from "./workspace-secret-offer";

/**
 * Slack's edit in place: the message becomes a message box with its text, Enter saves and Escape
 * cancels (Shift+Enter adds a line), as do Save and Cancel. Saving no text, on a message with no
 * files, asks to delete the message instead.
 */
export function WorkspaceMessageEditor(props: {
  channelId: string;
  entry: ChannelMessage;
  /** The thread the message is in, for the delete dialog; null in the channel transcript. */
  threadRootId: string | null;
}) {
  const { t, errorMessage } = useText();
  const ws = useWorkspace();
  const secrets = useSecretHygiene();
  const original = untrack(() => props.entry.message.text);
  const [text, setText] = createSignal(original);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [format, setFormat] = createSignal<{ id: number; format: ComposerTextFormat } | undefined>();
  const [textRequest, setTextRequest] = createSignal<{ id: number; text: string } | undefined>();
  // The editor takes the focus once it is on the page, as Slack's does, with the caret at the end.
  const [focus, setFocus] = createSignal(0);
  onSettled(() => {
    setFocus(1);
  });
  const { people, mentionAgents, channelLinks, isChannel, emojiSearch } = useComposerSources(() => props.channelId);
  const toolbar = composerToolbar(props.threadRootId ? "thread" : "main");
  const hasFiles = () => Boolean(props.entry.message.attachments?.length);
  const cancel = () => ws.stopEditing();

  async function save() {
    if (saving()) return;
    const body = text().trim();
    if (!body && !hasFiles()) {
      // Slack: an edit to no text is a delete, which asks first.
      ws.stopEditing();
      ws.openDialog({
        kind: "delete-message",
        channelId: props.channelId,
        messageId: props.entry.id,
        threadRootId: props.threadRootId,
      });
      return;
    }
    if (body === original.trim()) {
      ws.stopEditing();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // A pasted key or password never reaches the host, as in the message box.
      const scanned = secrets.scan(body);
      await ws.editMessage(props.channelId, props.entry.id, scanned.text);
      secrets.offer(scanned.found);
    } catch (cause) {
      setError(errorMessage(cause, t("workspace.app.error.edit")));
      return;
    } finally {
      setSaving(false);
    }
    // The box takes keys while the save is on its way; what was typed meanwhile is saved too.
    const latest = text().trim();
    if (latest && latest !== body) await save();
  }

  return (
    <div
      class="ws-composer-frame ws-message-edit"
      data-picker-mount=""
      ref={(element) => {
        // The editor and its pickers take their own Escape first; this one ends the edit.
        element.addEventListener("keydown", (event) => {
          if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          cancel();
        });
      }}
    >
      <MessageComposer
        label={t("workspace.app.edit.label")}
        notice={
          <Show when={error()}>
            {(message) => (
              <p class="ws-composer-error" role="alert">
                {message()}
              </p>
            )}
          </Show>
        }
        editor={
          <div class="ws-composer-editor-anchor" data-picker-anchor="">
            <ComposerEditor
              agentId={`edit:${props.entry.id}`}
              agents={mentionAgents()}
              members={people()}
              broadcasts={isChannel()}
              channels={channelLinks()}
              value={text()}
              placeholder={t("workspace.app.edit.hint")}
              ariaLabel={t("workspace.app.edit.label")}
              disabled={false}
              focusRequest={focus()}
              formatRequest={format()}
              textRequest={textRequest()}
              formatShortcuts
              codeFenceLines
              emojiSearch={emojiSearch}
              sendShortcut="enter"
              onValueChange={setText}
              onSubmit={() => void save()}
            />
          </div>
        }
        onFormat={(next) => setFormat((current) => ({ id: (current?.id ?? 0) + 1, format: next }))}
        toolbarShown={toolbar.shown()}
        onToolbarShownChange={toolbar.setShown}
        emojiPicker={{
          onPick: (emoji) => {
            ws.noteEmoji(emoji);
            setTextRequest((current) => ({ id: (current?.id ?? 0) + 1, text: emoji }));
          },
          recent: ws.state.emoji.recent,
          skinTone: ws.state.emoji.skinTone,
          onSkinToneChange: (tone) => ws.setSkinTone(tone),
        }}
        onSend={() => void save()}
        canSend={!saving() && (text().trim().length > 0 || hasFiles() || original.trim().length > 0)}
        sending={saving()}
        edit={{ onCancel: cancel }}
      />
      <p class="ws-message-edit-hint" aria-hidden="true">
        {t("workspace.app.edit.hint")}
      </p>
    </div>
  );
}
