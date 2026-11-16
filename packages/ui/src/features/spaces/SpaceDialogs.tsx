import type { AvatarHue } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { createStore, createUniqueId, For, Show } from "solid-js";
import { AVATAR_HUE_CHOICES, avatarHueSwatch } from "../../bloub-avatar";
import { Button, IconButton } from "../../button";
import { Dialog } from "../../complex";
import { ConfirmDialog } from "../../confirm-dialog";
import { Field, Input } from "../../form";
import { SmilePlus, X } from "../../icons";
import { useText } from "../../text";
import { AVATAR_HUE_LABEL } from "../agents/avatar-hue-label";
import { EmojiPickerPopover } from "../workspace/EmojiPicker";
import { WorkspaceSelect } from "../workspace/WorkspaceSelect";
import { SpaceMark } from "./SpaceRail";

/** The most characters of a space name. The host keeps the same limit. */
export const SPACE_NAME_MAX = 60;

export interface SpaceDraft {
  name: string;
  icon: string | null;
  hue: AvatarHue | null;
}

export interface SpaceDialogProps {
  open: boolean;
  /** The space to change; null makes a new one. */
  initial: SpaceDraft | null;
  onOpenChange: (open: boolean) => void;
  /** A rejected promise shows its message in the dialog. */
  onSave: (draft: SpaceDraft) => Promise<void> | void;
}

interface DialogState extends SpaceDraft {
  emojiOpen: boolean;
  busy: boolean;
  error: string | null;
}

/** Makes a space, or changes the name, the emoji and the color of one. */
export function SpaceDialog(props: SpaceDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const formId = createUniqueId();
  const fresh = (): DialogState => ({
    name: props.initial?.name ?? "",
    icon: props.initial?.icon ?? null,
    hue: props.initial?.hue ?? null,
    emojiOpen: false,
    busy: false,
    error: null,
  });
  const [state, setState] = createStore<DialogState>(fresh());
  const valid = () => state.name.trim().length > 0;

  function close(open: boolean): void {
    if (open) setState(() => fresh());
    props.onOpenChange(open);
  }

  async function save(): Promise<void> {
    if (state.busy || !valid()) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await props.onSave({ name: state.name.trim(), icon: state.icon, hue: state.hue });
      props.onOpenChange(false);
    } catch (error) {
      setState((draft) => {
        draft.error = errorMessage(error, t("workspace.spaces.saveFailed"));
      });
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content
            as="section"
            class="ws-dialog space-dialog"
            onOpenAutoFocus={(event: Event) => {
              event.preventDefault();
              setState(() => fresh());
            }}
          >
            <header class="ws-dialog-header">
              <Dialog.Title class="ws-dialog-title">
                {props.initial ? t("workspace.spaces.editTitle") : t("workspace.spaces.createTitle")}
              </Dialog.Title>
              <IconButton variant="ghost" label={t("common.close")} onClick={() => close(false)}>
                <X />
              </IconButton>
            </header>
            <form
              id={formId}
              class="ws-dialog-body"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Dialog.Description class="ws-dialog-description">
                {t("workspace.spaces.dialogDescription")}
              </Dialog.Description>
              <div class="space-dialog-identity">
                <SpaceMark name={state.name || "?"} icon={state.icon} hue={state.hue} class="space-mark-large" />
                <Field label={t("workspace.spaces.name")} class="space-dialog-name">
                  <Input
                    ref={(element) => requestAnimationFrame(() => element.focus())}
                    value={state.name}
                    maxlength={SPACE_NAME_MAX}
                    placeholder={t("workspace.spaces.namePlaceholder")}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.name = value;
                      })
                    }
                  />
                </Field>
              </div>
              <div class="space-dialog-row">
                <span class="space-dialog-label">{t("workspace.spaces.emoji")}</span>
                <EmojiPickerPopover
                  open={state.emojiOpen}
                  onOpenChange={(open) =>
                    setState((draft) => {
                      draft.emojiOpen = open;
                    })
                  }
                  trigger={
                    <Show when={state.icon} fallback={<SmilePlus />}>
                      {(icon) => <span>{icon()}</span>}
                    </Show>
                  }
                  triggerLabel={t("workspace.spaces.pickEmoji")}
                  placement="bottom-start"
                  onPick={(emoji) =>
                    setState((draft) => {
                      draft.icon = emoji;
                    })
                  }
                />
                <Show when={state.icon}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setState((draft) => {
                        draft.icon = null;
                      })
                    }
                  >
                    {t("workspace.spaces.removeEmoji")}
                  </Button>
                </Show>
              </div>
              <fieldset class="space-dialog-colors" aria-label={t("workspace.spaces.color")}>
                <legend class="space-dialog-label">{t("workspace.spaces.color")}</legend>
                <Button
                  variant="ghost"
                  type="button"
                  class={["space-dialog-color", { "space-dialog-color-selected": state.hue === null }]}
                  aria-label={t("workspace.spaces.noColor")}
                  aria-pressed={state.hue === null ? "true" : "false"}
                  onClick={() =>
                    setState((draft) => {
                      draft.hue = null;
                    })
                  }
                >
                  <span class="space-dialog-swatch space-dialog-swatch-none" />
                </Button>
                <For each={AVATAR_HUE_CHOICES}>
                  {(choice) => (
                    <Button
                      variant="ghost"
                      type="button"
                      class={["space-dialog-color", { "space-dialog-color-selected": state.hue === choice.hue }]}
                      aria-label={t(AVATAR_HUE_LABEL[choice.hue])}
                      aria-pressed={state.hue === choice.hue ? "true" : "false"}
                      onClick={() =>
                        setState((draft) => {
                          draft.hue = choice.hue;
                        })
                      }
                    >
                      <span class="space-dialog-swatch" style={{ background: avatarHueSwatch(choice.hue) }} />
                    </Button>
                  )}
                </For>
              </fieldset>
            </form>
            <Show when={state.error}>
              {(message) => (
                <p class="ws-dialog-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <footer class="ws-dialog-footer">
              <Button variant="ghost" onClick={() => close(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="submit" form={formId} loading={state.busy} disabled={!valid()}>
                {props.initial ? t("common.save") : t("workspace.spaces.createButton")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The space that the reader picked, and the reason the last try failed. */
interface ChoiceState {
  target: string;
  error: string | null;
}

export interface SpaceOption {
  id: string;
  name: string;
}

export interface MoveToSpaceDialogProps {
  open: boolean;
  /** What moves, such as an agent's name or "3 agents". */
  subject: string;
  /** The space it is in now. */
  currentId: string;
  spaces: readonly SpaceOption[];
  onOpenChange: (open: boolean) => void;
  onMove: (spaceId: string) => Promise<void> | void;
}

/** Moves an agent, a channel or several agents to another space. */
export function MoveToSpaceDialog(props: MoveToSpaceDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const others = () => props.spaces.filter((space) => space.id !== props.currentId);
  const [state, setState] = createStore<ChoiceState>({ target: "", error: null });
  const target = () => state.target || others()[0]?.id || "";
  return (
    <ConfirmDialog
      open={props.open}
      tone="default"
      title={t("workspace.spaces.moveTitle", { name: props.subject })}
      description={t("workspace.spaces.moveDescription")}
      confirmLabel={t("workspace.spaces.moveButton")}
      error={state.error ?? undefined}
      onCancel={() => {
        setState((draft) => {
          draft.error = null;
          draft.target = "";
        });
        props.onOpenChange(false);
      }}
      onConfirm={async () => {
        if (!target()) return;
        try {
          await props.onMove(target());
          setState((draft) => {
            draft.error = null;
            draft.target = "";
          });
          props.onOpenChange(false);
        } catch (error) {
          setState((draft) => {
            draft.error = errorMessage(error, t("workspace.spaces.moveFailed"));
          });
        }
      }}
    >
      <Show when={others().length > 0} fallback={<p class="space-dialog-note">{t("workspace.spaces.noOther")}</p>}>
        <WorkspaceSelect
          label={t("workspace.spaces.moveTo")}
          prefix={t("workspace.spaces.moveTo")}
          value={target()}
          options={others().map((space) => ({ value: space.id, label: space.name }))}
          onChange={(value) =>
            setState((draft) => {
              draft.target = value;
            })
          }
        />
      </Show>
    </ConfirmDialog>
  );
}

export interface DeleteSpaceDialogProps {
  open: boolean;
  name: string;
  /** How many agents and channels are in the space. */
  agentCount: number;
  channelCount: number;
  /** Where its agents and channels can go: every other space. */
  spaces: readonly SpaceOption[];
  onOpenChange: (open: boolean) => void;
  /** `moveTo` is set when the space is not empty. */
  onDelete: (moveTo: string | undefined) => Promise<void> | void;
}

/** Deletes a space. One that holds agents or channels moves them to the space the reader picks first. */
export function DeleteSpaceDialog(props: DeleteSpaceDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<ChoiceState>({ target: "", error: null });
  const empty = () => props.agentCount === 0 && props.channelCount === 0;
  const target = () => state.target || props.spaces[0]?.id || "";
  const reset = () =>
    setState((draft) => {
      draft.error = null;
      draft.target = "";
    });
  return (
    <ConfirmDialog
      open={props.open}
      title={t("workspace.spaces.deleteTitle", { name: props.name })}
      description={
        empty()
          ? t("workspace.spaces.deleteEmpty")
          : t("workspace.spaces.deleteMoves", { agents: props.agentCount, channels: props.channelCount })
      }
      confirmLabel={t("workspace.spaces.deleteButton")}
      error={state.error ?? undefined}
      onCancel={() => {
        reset();
        props.onOpenChange(false);
      }}
      onConfirm={async () => {
        try {
          await props.onDelete(empty() ? undefined : target());
          reset();
          props.onOpenChange(false);
        } catch (error) {
          setState((draft) => {
            draft.error = errorMessage(error, t("workspace.spaces.deleteFailed"));
          });
        }
      }}
    >
      <Show when={!empty()}>
        <WorkspaceSelect
          label={t("workspace.spaces.moveTo")}
          prefix={t("workspace.spaces.moveTo")}
          value={target()}
          options={props.spaces.map((space) => ({ value: space.id, label: space.name }))}
          onChange={(value) =>
            setState((draft) => {
              draft.target = value;
            })
          }
        />
      </Show>
    </ConfirmDialog>
  );
}
