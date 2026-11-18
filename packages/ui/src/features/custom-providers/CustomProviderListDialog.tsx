import type { CustomProviderSummary } from "@openbot/contracts/ipc";
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FormDialog,
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
  SlidersHorizontal,
  Text,
  Trash2,
} from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";

interface CustomProviderListDialogProps {
  open: boolean;
  providers: readonly CustomProviderSummary[];
  /** The ID being removed, so only that row's button is busy. */
  removing: string | null;
  /** The last outcome of a removal, shown here while this dialog holds the screen. */
  note: string | null;
  /**
   * Without it the rows are listed but not removable, which is what a remote server shows. It runs
   * only after the user accepts the removal question this dialog asks.
   */
  onDelete?: ((provider: CustomProviderSummary) => void) | undefined;
  onClose: () => void;
}

/**
 * The endpoints the user has saved, and the only place they are removed.
 *
 * The list left the AI providers section for this dialog because it repeated what the Custom
 * provider row already says and grew without limit inside a section of fixed rows.
 *
 * Removing the last endpoint leaves this open on its empty state rather than closing by itself: a
 * dialog that vanishes under the hand reads as a crash, and the outcome message is here. The count
 * button that opened it is gone by then, so focus falls back to the document after the close - which
 * is cheaper to accept than a focus handle on the picker for this one case.
 */
export function CustomProviderListDialog(props: CustomProviderListDialogProps) {
  const { t } = useText();
  const busy = () => props.removing !== null;
  // The endpoint the removal question asks about. Both hosts use this dialog, so the sentence is here
  // once and cannot drift between Settings and onboarding.
  const [confirming, setConfirming] = createSignal<CustomProviderSummary | null>(null);

  function confirmRemoval(): void {
    const provider = confirming();
    setConfirming(null);
    if (provider) props.onDelete?.(provider);
  }

  return (
    <>
      <FormDialog
        open={props.open}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        title={t("customProvider.list.title")}
        description={t("customProvider.list.description")}
        submitLabel={t("common.done")}
        hideSecondary
        onSubmit={props.onClose}
        footerStart={
          <Show when={props.note}>
            {(message) => (
              <Text tone="muted" variant="caption" role="status">
                {message()}
              </Text>
            )}
          </Show>
        }
      >
        <Show
          when={props.providers.length > 0}
          fallback={<EmptyState size="compact" icon={<SlidersHorizontal />} title={t("customProvider.list.empty")} />}
        >
          <ItemGroup surface="subtle" aria-label={t("customProvider.list.label")}>
            <For each={props.providers}>
              {(provider) => (
                <Item>
                  <ItemContent>
                    <ItemTitle>{provider.name}</ItemTitle>
                    <ItemDescription>
                      {provider.baseUrl}
                      {provider.hasApiKey ? ` · ${t("customProvider.list.apiKeySaved")}` : ""}
                    </ItemDescription>
                  </ItemContent>
                  <Show when={props.onDelete}>
                    <ItemActions>
                      <Button
                        variant="destructive-ghost"
                        size="sm"
                        aria-label={t("customProvider.list.deleteLabel", { name: provider.name })}
                        disabled={busy()}
                        loading={props.removing === provider.id}
                        onClick={() => setConfirming(provider)}
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        {t("common.delete")}
                      </Button>
                    </ItemActions>
                  </Show>
                </Item>
              )}
            </For>
          </ItemGroup>
        </Show>
      </FormDialog>
      <ConfirmDialog
        open={props.open && confirming() !== null}
        title={t("customProvider.list.confirmTitle", { name: confirming()?.name ?? "" })}
        description={t("customProvider.list.confirmDescription")}
        confirmLabel={t("common.delete")}
        onCancel={() => setConfirming(null)}
        onConfirm={confirmRemoval}
      />
    </>
  );
}
