import { Button, Dialog, Input, Pencil, Plus, Trash2 } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { SAVED_REPLY_LIMIT, SAVED_REPLY_MAX_LENGTH } from "./saved-reply-limits";

export interface SavedRepliesProps {
  /** The replies to offer, in order. */
  replies: readonly string[];
  /** A reply is a normal message, so sending it needs an agent that can receive one. */
  disabled?: boolean | undefined;
  /** Sends one reply as a message. */
  onSend: (reply: string) => void;
  /** Saves the edited list. An empty list is allowed: the edit button stays, so replies can come back. */
  onChange: (replies: string[]) => void;
  /** Goes back to the replies OpenBot ships. Absent when the list already is that. */
  onReset?: (() => void) | undefined;
}

/**
 * Saved replies for common steering: a row of chips above the composer, each one a message that
 * the user would otherwise type again. A chip sends at once, like Send does. The pencil opens the
 * list for editing. The component keeps no storage: where the list lives is the caller's decision.
 */
export function SavedReplies(props: SavedRepliesProps) {
  const { t } = useText();
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal<string[]>([]);

  function openEditor() {
    setDraft([...props.replies]);
    setEditing(true);
  }
  function save() {
    // Blank lines go; the rest keep their order. A repeat adds nothing a second chip would.
    const cleaned = draft()
      .map((reply) => reply.trim().slice(0, SAVED_REPLY_MAX_LENGTH))
      .filter((reply, index, all) => reply !== "" && all.indexOf(reply) === index)
      .slice(0, SAVED_REPLY_LIMIT);
    props.onChange(cleaned);
    setEditing(false);
  }

  return (
    <>
      <fieldset class="saved-replies" aria-label={t("composer.savedReplies.label")}>
        <div class="saved-replies-chips">
          <For each={props.replies}>
            {(reply) => (
              <Button
                variant="outline"
                size="xs"
                type="button"
                class="saved-reply-chip"
                title={reply}
                disabled={props.disabled}
                onClick={() => props.onSend(reply)}
              >
                <span class="saved-reply-text">{reply}</span>
              </Button>
            )}
          </For>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          class="saved-replies-edit"
          aria-label={t("composer.savedReplies.edit")}
          onClick={openEditor}
        >
          <Pencil aria-hidden="true" />
        </Button>
      </fieldset>
      <Dialog.Root open={editing()} onOpenChange={setEditing}>
        <Dialog.Portal>
          <Dialog.Overlay class="saved-replies-backdrop">
            <Dialog.Content class="saved-replies-dialog" as="section">
              <header class="saved-replies-header">
                <Dialog.Title class="saved-replies-title">{t("composer.savedReplies.title")}</Dialog.Title>
                <Dialog.Description class="saved-replies-description">
                  {t("composer.savedReplies.description")}
                </Dialog.Description>
              </header>
              <form
                class="saved-replies-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  save();
                }}
              >
                <ul class="saved-replies-list">
                  {/* Not keyed by value: a row must stay mounted while its text changes. */}
                  <For each={draft()} keyed={false}>
                    {(reply, index) => (
                      <li class="saved-replies-row">
                        <Input
                          value={reply()}
                          maxlength={SAVED_REPLY_MAX_LENGTH}
                          aria-label={t("composer.savedReplies.item", { number: index + 1 })}
                          onValueChange={(value) =>
                            setDraft((current) => current.map((item, at) => (at === index ? value : item)))
                          }
                        />
                        <Button
                          variant="destructive-ghost"
                          size="icon-sm"
                          type="button"
                          aria-label={t("composer.savedReplies.remove", { number: index + 1 })}
                          onClick={() => setDraft((current) => current.filter((_, at) => at !== index))}
                        >
                          <Trash2 aria-hidden="true" />
                        </Button>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={draft().length === 0}>
                  <p class="saved-replies-empty">{t("composer.savedReplies.empty")}</p>
                </Show>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  class="saved-replies-add"
                  disabled={draft().length >= SAVED_REPLY_LIMIT}
                  onClick={() => setDraft((current) => [...current, ""])}
                >
                  <Plus aria-hidden="true" />
                  {t("composer.savedReplies.add")}
                </Button>
                <footer class="saved-replies-actions">
                  <Show when={props.onReset}>
                    {(reset) => (
                      <Button
                        variant="ghost"
                        type="button"
                        class="saved-replies-reset"
                        onClick={() => {
                          reset()();
                          setEditing(false);
                        }}
                      >
                        {t("composer.savedReplies.reset")}
                      </Button>
                    )}
                  </Show>
                  <Button variant="ghost" type="button" onClick={() => setEditing(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button variant="default" type="submit">
                    {t("common.save")}
                  </Button>
                </footer>
              </form>
            </Dialog.Content>
          </Dialog.Overlay>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
