import type { JSX } from "@solidjs/web";
import { createEffect, createStore } from "solid-js";
import { Field, Input } from "../../form";
import { FormDialog } from "../../form-dialog";
import { useText } from "../../text";

/** The most characters of a section name. The host keeps the same limit. */
export const SIDEBAR_SECTION_NAME_MAX = 80;

export interface SidebarSectionDialogProps {
  open: boolean;
  /** The name of the section to rename; null makes a new section. */
  initialName: string | null;
  /** The names of the reader's other sections: a section name is used once. */
  takenNames: readonly string[];
  onOpenChange: (open: boolean) => void;
  /** A rejected promise shows its message in the dialog. */
  onSave: (name: string) => Promise<void> | void;
}

interface DialogState {
  name: string;
  busy: boolean;
  error: string | null;
}

/** Makes a sidebar section, as Slack's "Create a section", or renames one. */
export function SidebarSectionDialog(props: SidebarSectionDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<DialogState>({ name: "", busy: false, error: null });
  const taken = () => {
    const name = state.name.trim().toLocaleLowerCase();
    return (
      name.length > 0 &&
      name !== props.initialName?.trim().toLocaleLowerCase() &&
      props.takenNames.some((other) => other.trim().toLocaleLowerCase() === name)
    );
  };
  const valid = () => state.name.trim().length > 0 && !taken();
  // A dialog that is open from its first render starts from `initialName`.
  createEffect(
    () => ({ open: props.open, initialName: props.initialName }),
    (current, previous) => {
      if (current.open && !previous?.open)
        setState(() => ({ name: current.initialName ?? "", busy: false, error: null }));
    },
  );
  async function save(): Promise<void> {
    if (state.busy || !valid()) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await props.onSave(state.name.trim());
      props.onOpenChange(false);
    } catch (error) {
      setState((draft) => {
        draft.error = errorMessage(error, t("workspace.sidebar.section.saveFailed"));
      });
    } finally {
      setState((draft) => {
        draft.busy = false;
      });
    }
  }
  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="sm"
      title={t(
        props.initialName === null ? "workspace.sidebar.section.createTitle" : "workspace.sidebar.section.renameTitle",
      )}
      description={t("workspace.sidebar.section.description")}
      error={state.error}
      busy={state.busy}
      submitLabel={t(props.initialName === null ? "workspace.sidebar.section.create" : "common.save")}
      submitDisabled={!valid()}
      onSubmit={() => void save()}
    >
      <Field
        label={t("workspace.sidebar.section.name")}
        required
        error={taken() ? t("workspace.sidebar.section.nameTaken", { name: state.name.trim() }) : undefined}
      >
        <Input
          value={state.name}
          maxlength={SIDEBAR_SECTION_NAME_MAX}
          autocomplete="off"
          placeholder={t("workspace.sidebar.section.namePlaceholder")}
          onValueChange={(value) =>
            setState((draft) => {
              draft.name = value;
            })
          }
        />
      </Field>
    </FormDialog>
  );
}
