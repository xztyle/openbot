import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { FormDialog } from "../../form-dialog";
import { Kbd } from "../../surface";
import { useText } from "../../text";

export interface ShortcutItem {
  label: string;
  /** The keys, pressed together: ["⌘", "K"]. Alternatives are separate items. */
  keys: readonly string[];
}

export interface ShortcutGroup {
  title: string;
  items: readonly ShortcutItem[];
}

export interface ShortcutsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: readonly ShortcutGroup[];
}

/** The keyboard shortcuts of the workspace, as Slack's ⌘/ sheet, in groups. */
export function ShortcutsSheet(props: ShortcutsSheetProps): JSX.Element {
  const { t } = useText();
  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="lg"
      title={t("workspace.shortcuts.title")}
      description={t("workspace.shortcuts.description")}
    >
      <div class="ws-shortcuts">
        <For each={props.groups}>
          {(group) => (
            <section class="ws-shortcuts-group">
              <h3 class="ws-shortcuts-title">{group.title}</h3>
              <dl class="ws-shortcuts-list">
                <For each={group.items}>
                  {(item) => (
                    <div class="ws-shortcuts-row">
                      <dt>{item.label}</dt>
                      <dd>
                        <For each={item.keys}>{(key) => <Kbd>{key}</Kbd>}</For>
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </section>
          )}
        </For>
      </div>
    </FormDialog>
  );
}
