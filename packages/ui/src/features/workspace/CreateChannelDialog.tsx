import type { JSX } from "@solidjs/web";
import { createStore, createUniqueId, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Dialog } from "../../complex";
import { Field, Input, Textarea } from "../../form";
import { Hash, Lock, X } from "../../icons";
import { Switch } from "../../switch";
import { useText } from "../../text";
import { MemberPicker } from "./MemberPicker";
import { CHANNEL_NAME_MAX, slugChannelName } from "./workspace-format";
import type { ChannelVisibility, WorkspaceMember } from "./workspace-types";

export interface CreateChannelInput {
  name: string;
  description: string;
  visibility: ChannelVisibility;
  memberIds: string[];
}

export interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** People and agents who can be added. */
  candidates: readonly WorkspaceMember[];
  /** Names that are taken, so the dialog can say so before it sends. */
  existingNames?: readonly string[] | undefined;
  /** Creates the channel. A rejected promise shows its message in the dialog. */
  onCreate: (input: CreateChannelInput) => Promise<void> | void;
}

interface CreateState {
  step: "details" | "members";
  name: string;
  description: string;
  visibility: ChannelVisibility;
  memberIds: string[];
  busy: boolean;
  error: string | null;
}

const INITIAL: CreateState = {
  step: "details",
  name: "",
  description: "",
  visibility: "public",
  memberIds: [],
  busy: false,
  error: null,
};

/** Create a channel in two steps: name, description and privacy; then the people and agents to add. */
export function CreateChannelDialog(props: CreateChannelDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const formId = createUniqueId();
  const [state, setState] = createStore<CreateState>({ ...INITIAL });
  const taken = () => props.existingNames?.includes(state.name) ?? false;
  const nameError = () => (taken() ? t("workspace.create.nameTaken", { name: state.name }) : null);
  const canContinue = () => state.name.length > 0 && !taken();

  function close(open: boolean): void {
    if (!open) setState(() => ({ ...INITIAL }));
    props.onOpenChange(open);
  }

  async function create(): Promise<void> {
    if (state.busy || !canContinue()) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await props.onCreate({
        name: state.name,
        description: state.description.trim(),
        visibility: state.visibility,
        memberIds: [...state.memberIds],
      });
      close(false);
    } catch (error) {
      setState((draft) => {
        draft.busy = false;
        draft.error = errorMessage(error, t("workspace.create.failed"));
      });
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Overlay>
          <Dialog.Content
            as="section"
            class="ws-dialog"
            onOpenAutoFocus={(event: Event) => {
              // The first field takes the focus, not the close button in the corner.
              event.preventDefault();
            }}
          >
            <header class="ws-dialog-header">
              <Dialog.Title class="ws-dialog-title">
                {state.step === "details"
                  ? t("workspace.create.title")
                  : t("workspace.create.addTitle", { name: state.name })}
              </Dialog.Title>
              <IconButton variant="ghost" label={t("common.close")} onClick={() => close(false)}>
                <X />
              </IconButton>
            </header>
            <Show
              when={state.step === "details"}
              fallback={
                <div class="ws-dialog-body">
                  <Dialog.Description class="ws-dialog-description">
                    {t("workspace.create.addDescription")}
                  </Dialog.Description>
                  <MemberPicker
                    autofocus
                    label={t("workspace.create.addLabel")}
                    candidates={props.candidates}
                    selectedIds={state.memberIds}
                    onChange={(ids) =>
                      setState((draft) => {
                        draft.memberIds = ids;
                      })
                    }
                  />
                </div>
              }
            >
              <form
                id={formId}
                class="ws-dialog-body"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (canContinue())
                    setState((draft) => {
                      draft.step = "members";
                    });
                }}
              >
                <Dialog.Description class="ws-dialog-description">
                  {t("workspace.create.description")}
                </Dialog.Description>
                <Field
                  label={t("workspace.create.name")}
                  description={nameError() ? undefined : t("workspace.create.nameHint")}
                  error={nameError() ?? undefined}
                >
                  <div class="ws-name-field" data-invalid={nameError() ? "" : undefined}>
                    <span class="ws-name-field-prefix" aria-hidden="true">
                      <Show when={state.visibility === "private"} fallback={<Hash />}>
                        <Lock />
                      </Show>
                    </span>
                    <Input
                      ref={(element) => requestAnimationFrame(() => element.focus())}
                      class="ws-name-field-input"
                      value={state.name}
                      maxlength={CHANNEL_NAME_MAX}
                      placeholder={t("workspace.create.namePlaceholder")}
                      onValueChange={(value) =>
                        setState((draft) => {
                          draft.name = slugChannelName(value);
                        })
                      }
                    />
                  </div>
                </Field>
                <Field label={t("workspace.create.descriptionLabel")}>
                  <Textarea
                    rows="2"
                    value={state.description}
                    placeholder={t("workspace.create.descriptionPlaceholder")}
                    onValueChange={(value) =>
                      setState((draft) => {
                        draft.description = value;
                      })
                    }
                  />
                </Field>
                <div class="ws-details-setting">
                  <span class="ws-details-setting-icon">
                    <Lock aria-hidden="true" />
                  </span>
                  <span class="ws-details-setting-copy">
                    <span class="ws-details-setting-label">{t("workspace.create.private")}</span>
                    <span class="ws-details-setting-description">{t("workspace.create.privateHint")}</span>
                  </span>
                  <Switch
                    aria-label={t("workspace.create.private")}
                    checked={state.visibility === "private"}
                    onChange={(checked: boolean) =>
                      setState((draft) => {
                        draft.visibility = checked ? "private" : "public";
                      })
                    }
                  />
                </div>
              </form>
            </Show>
            <Show when={state.error}>
              {(message) => (
                <p class="ws-dialog-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <footer class="ws-dialog-footer">
              <Show
                when={state.step === "details"}
                fallback={
                  <>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setState((draft) => {
                          draft.step = "details";
                        })
                      }
                    >
                      {t("workspace.dialog.back")}
                    </Button>
                    <Button loading={state.busy} onClick={() => void create()}>
                      {state.memberIds.length > 0 ? t("workspace.create.create") : t("workspace.create.skip")}
                    </Button>
                  </>
                }
              >
                <span class="ws-dialog-step">{t("workspace.create.step", { step: 1, total: 2 })}</span>
                <Button type="submit" form={formId} disabled={!canContinue()}>
                  {t("workspace.dialog.next")}
                </Button>
              </Show>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
