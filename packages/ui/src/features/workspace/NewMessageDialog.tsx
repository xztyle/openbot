import type { JSX } from "@solidjs/web";
import { createStore } from "solid-js";
import { FormDialog } from "../../form-dialog";
import { useText } from "../../text";
import { MemberPicker } from "./MemberPicker";
import type { WorkspaceMember } from "./workspace-types";

/** A group DM has the reader and two to eight others. */
export const GROUP_DM_MAX_OTHERS = 8;

export interface NewMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** People and agents, without the reader. */
  candidates: readonly WorkspaceMember[];
  /** Opens or creates the DM (one id) or the group DM (several). A rejected promise shows its message. */
  onStart: (memberIds: string[]) => Promise<void> | void;
}

interface NewMessageState {
  memberIds: string[];
  busy: boolean;
  error: string | null;
}

/** Start a DM with one person or agent, or a group DM with several. */
export function NewMessageDialog(props: NewMessageDialogProps): JSX.Element {
  const { t, errorMessage } = useText();
  const [state, setState] = createStore<NewMessageState>({ memberIds: [], busy: false, error: null });

  function close(open: boolean): void {
    if (!open) setState(() => ({ memberIds: [], busy: false, error: null }));
    props.onOpenChange(open);
  }

  async function start(): Promise<void> {
    if (state.busy || state.memberIds.length === 0) return;
    setState((draft) => {
      draft.busy = true;
      draft.error = null;
    });
    try {
      await props.onStart([...state.memberIds]);
      close(false);
    } catch (error) {
      setState((draft) => {
        draft.busy = false;
        draft.error = errorMessage(error, t("workspace.newMessage.failed"));
      });
    }
  }

  return (
    <FormDialog
      open={props.open}
      onOpenChange={close}
      title={t("workspace.newMessage.title")}
      description={t("workspace.newMessage.description")}
      error={state.error}
      busy={state.busy}
      submitLabel={state.memberIds.length > 1 ? t("workspace.newMessage.startGroup") : t("workspace.newMessage.start")}
      submitDisabled={state.memberIds.length === 0}
      onSubmit={() => void start()}
    >
      <MemberPicker
        autofocus
        label={t("workspace.newMessage.to")}
        candidates={props.candidates}
        selectedIds={state.memberIds}
        max={GROUP_DM_MAX_OTHERS}
        onChange={(ids) =>
          setState((draft) => {
            draft.memberIds = ids;
          })
        }
      />
    </FormDialog>
  );
}
