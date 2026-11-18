import type { JSX } from "@solidjs/web";
import { createEffect, createStore, Show } from "solid-js";
import { Field, Input, Textarea } from "../../form";
import { FormDialog } from "../../form-dialog";
import { Hash, Lock } from "../../icons";
import { SwitchField } from "../../switch";
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
  /** The name the field starts with, such as the text of Jump to's "Create #name". */
  initialName?: string | undefined;
  /** Creates the channel and opens it. A rejected promise shows its message in the dialog. */
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
  const [state, setState] = createStore<CreateState>({ ...INITIAL });
  const taken = () => props.existingNames?.includes(state.name) ?? false;
  const nameError = () => (taken() ? t("workspace.create.nameTaken", { name: state.name }) : null);
  const canContinue = () => state.name.length > 0 && !taken();
  // A dialog that opens with a name starts from it.
  createEffect(
    () => (props.open ? (props.initialName ?? "") : null),
    (name) => {
      if (name)
        setState((draft) => {
          if (!draft.name) draft.name = slugChannelName(name);
        });
    },
  );

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

  const details = () => state.step === "details";

  return (
    <FormDialog
      open={props.open}
      onOpenChange={close}
      title={details() ? t("workspace.create.title") : t("workspace.create.addTitle", { name: state.name })}
      description={details() ? t("workspace.create.description") : t("workspace.create.addDescription")}
      step={{ current: details() ? 1 : 2, total: 2 }}
      error={state.error}
      busy={state.busy}
      submitLabel={details() ? t("common.next") : t("workspace.create.create")}
      submitDisabled={!canContinue()}
      secondaryLabel={details() ? undefined : t("common.back")}
      onSecondary={
        details()
          ? undefined
          : () =>
              setState((draft) => {
                draft.step = "details";
                draft.error = null;
              })
      }
      onSubmit={() => {
        if (state.step === "members") void create();
        else
          setState((draft) => {
            draft.step = "members";
          });
      }}
    >
      <Show
        when={details()}
        fallback={
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
        }
      >
        <Field
          label={t("workspace.create.name")}
          required
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
              class="ws-name-field-input"
              value={state.name}
              maxlength={CHANNEL_NAME_MAX}
              autocomplete="off"
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
        <SwitchField
          label={t("workspace.create.private")}
          description={t("workspace.create.privateHint")}
          checked={state.visibility === "private"}
          onChange={(checked: boolean) =>
            setState((draft) => {
              draft.visibility = checked ? "private" : "public";
            })
          }
        />
      </Show>
    </FormDialog>
  );
}
