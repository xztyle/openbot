import type { JSX } from "@solidjs/web";
import { createStore, Show } from "solid-js";
import { Button, IconButton } from "../../button";
import { Dialog } from "../../complex";
import { X } from "../../icons";
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
              <Dialog.Title class="ws-dialog-title">{t("workspace.newMessage.title")}</Dialog.Title>
              <IconButton variant="ghost" label={t("common.close")} onClick={() => close(false)}>
                <X />
              </IconButton>
            </header>
            <div class="ws-dialog-body">
              <Dialog.Description class="ws-dialog-description">
                {t("workspace.newMessage.description")}
              </Dialog.Description>
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
            </div>
            <Show when={state.error}>
              {(message) => (
                <p class="ws-dialog-error" role="alert">
                  {message()}
                </p>
              )}
            </Show>
            <footer class="ws-dialog-footer">
              <Button loading={state.busy} disabled={state.memberIds.length === 0} onClick={() => void start()}>
                {state.memberIds.length > 1 ? t("workspace.newMessage.startGroup") : t("workspace.newMessage.start")}
              </Button>
            </footer>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
