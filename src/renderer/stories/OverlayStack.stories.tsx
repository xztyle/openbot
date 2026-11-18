import {
  ActionSheet,
  Button,
  ConfirmDialog,
  Copy,
  Dialog,
  DropdownMenu,
  Input,
  Link,
  MessageSquareReply,
  Pencil,
  Popover,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Toaster,
  Trash2,
  toast,
} from "@openbot/ui";
import { createSignal, createStore, For } from "solid-js";
import type { Meta, StoryObj } from "storybook-solidjs-vite";

const meta = {
  title: "Foundations/Overlay stack",
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const ROLES = ["Owner", "Editor", "Viewer"];
interface OverlayStoryState {
  details: boolean;
  nested: boolean;
  confirm: boolean;
  name: string;
  role: string;
  log: string[];
}

const NAME_IDEAS = Array.from({ length: 30 }, (_, index) => `Idea ${index + 1}`);

/**
 * Every way one surface opens another: a dialog from a menu item, a menu, a select and a popover
 * inside a dialog, a dialog from a dialog, a confirmation from a dialog, and a toast while a dialog
 * is open. Each control writes what it did to the log, so a person or a script can see that the
 * surface on top took the press. `scripts/overlay-stack-e2e.ts` drives this story.
 */
export const NestedSurfaces: Story = {
  render: () => {
    const [state, setState] = createStore<OverlayStoryState>({
      details: false,
      nested: false,
      confirm: false,
      name: "Research",
      role: "Editor",
      log: [],
    });
    const note = (entry: string) =>
      setState((draft) => {
        draft.log.push(entry);
      });
    return (
      <main class="foundation-story foundation-interaction-stage">
        <Toaster />
        <DropdownMenu.Root>
          <DropdownMenu.Trigger as={Button} variant="secondary">
            Agent actions
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content>
              <DropdownMenu.Item
                onSelect={() =>
                  setState((draft) => {
                    draft.details = true;
                  })
                }
              >
                <Pencil aria-hidden="true" />
                Edit details
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="ui-action-menu-danger"
                onSelectAfterClose={() =>
                  setState((draft) => {
                    draft.confirm = true;
                  })
                }
              >
                <Trash2 aria-hidden="true" />
                Delete agent
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <ol aria-label="Overlay log">
          <For each={state.log} keyed={false}>
            {(entry) => <li>{entry()}</li>}
          </For>
        </ol>

        <Dialog.Root
          open={state.details}
          onOpenChange={(open) =>
            setState((draft) => {
              draft.details = open;
            })
          }
        >
          <Dialog.Portal>
            <Dialog.Overlay>
              <Dialog.Content class="ws-dialog">
                <header class="ws-dialog-header">
                  <Dialog.Title class="ws-dialog-title">Edit details</Dialog.Title>
                </header>
                <div class="ws-dialog-body">
                  <Input
                    aria-label="Agent name"
                    value={state.name}
                    onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) => {
                      const value = event.currentTarget.value;
                      setState((draft) => {
                        draft.name = value;
                      });
                    }}
                  />
                  <Select<string>
                    options={ROLES}
                    value={state.role}
                    onChange={(role) => {
                      if (!role) return;
                      setState((draft) => {
                        draft.role = role;
                      });
                      note(`role ${role}`);
                    }}
                    itemComponent={(props) => <SelectItem item={props.item}>{props.item.rawValue}</SelectItem>}
                  >
                    <SelectTrigger aria-label="Role">
                      <SelectValue<string>>{(select) => select.selectedOption()}</SelectValue>
                    </SelectTrigger>
                    <SelectContent />
                  </Select>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger as={Button} variant="ghost">
                      More actions
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item onSelect={() => note("duplicated")}>Duplicate</DropdownMenu.Item>
                        <DropdownMenu.Item
                          onSelectAfterClose={() =>
                            setState((draft) => {
                              draft.nested = true;
                            })
                          }
                        >
                          Change avatar
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                  <Popover.Root>
                    <Popover.Trigger as={Button} variant="ghost">
                      Help
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content class="ui-action-menu overlay-story-popover">
                        <Popover.Title>Names</Popover.Title>
                        <Input
                          aria-label="Search names"
                          onInput={(event: InputEvent & { currentTarget: HTMLInputElement }) =>
                            note(`search ${event.currentTarget.value}`)
                          }
                        />
                        <ul aria-label="Name ideas" class="overlay-story-scroll">
                          <For each={NAME_IDEAS}>
                            {(idea) => (
                              <li>
                                <Button variant="link" onClick={() => note(`idea ${idea}`)}>
                                  {idea}
                                </Button>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                  <Button
                    variant="ghost"
                    onClick={() => toast("Draft saved", { action: { label: "Undo", onClick: () => note("undo") } })}
                  >
                    Save draft
                  </Button>
                </div>
                <footer class="ws-dialog-footer">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      setState((draft) => {
                        draft.nested = true;
                      })
                    }
                  >
                    Open avatar dialog
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() =>
                      setState((draft) => {
                        draft.confirm = true;
                      })
                    }
                  >
                    Delete
                  </Button>
                  <Button
                    onClick={() => {
                      note(`saved ${state.name} ${state.role}`);
                      setState((draft) => {
                        draft.details = false;
                      });
                    }}
                  >
                    Save
                  </Button>
                </footer>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>

        <Dialog.Root
          open={state.nested}
          onOpenChange={(open) =>
            setState((draft) => {
              draft.nested = open;
            })
          }
        >
          <Dialog.Portal>
            <Dialog.Overlay>
              <Dialog.Content class="ws-dialog">
                <header class="ws-dialog-header">
                  <Dialog.Title class="ws-dialog-title">Change avatar</Dialog.Title>
                </header>
                <div class="ws-dialog-body">
                  <Input aria-label="Avatar letter" value="R" />
                </div>
                <footer class="ws-dialog-footer">
                  <Button
                    onClick={() => {
                      note("avatar changed");
                      setState((draft) => {
                        draft.nested = false;
                      });
                    }}
                  >
                    Use avatar
                  </Button>
                </footer>
              </Dialog.Content>
            </Dialog.Overlay>
          </Dialog.Portal>
        </Dialog.Root>

        <ConfirmDialog
          open={state.confirm}
          title="Delete Research?"
          description="Its chats stay on this computer."
          confirmLabel="Delete"
          onCancel={() =>
            setState((draft) => {
              draft.confirm = false;
            })
          }
          onConfirm={() => {
            note("deleted");
            setState((draft) => {
              draft.confirm = false;
            });
          }}
        />
      </main>
    );
  },
};

/** The phone form of a menu. A long press on a workspace message opens it with these rows. */
export const PhoneActionSheet: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
  render: () => {
    const [open, setOpen] = createSignal(true);
    return (
      <main class="foundation-story foundation-interaction-stage">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open the sheet
        </Button>
        <ActionSheet
          open={open()}
          onOpenChange={setOpen}
          title="Message actions"
          header={
            <For each={["👍", "❤️", "😂", "🎉", "👀", "✅"]}>
              {(emoji) => (
                <Button variant="ghost" size="icon-sm" aria-label={`React with ${emoji}`}>
                  {emoji}
                </Button>
              )}
            </For>
          }
          items={[
            {
              id: "reply",
              label: "Reply in thread",
              icon: <MessageSquareReply aria-hidden="true" />,
              onSelect: () => {},
            },
            { id: "copy", label: "Copy text", icon: <Copy aria-hidden="true" />, onSelect: () => {} },
            { id: "link", label: "Copy link", icon: <Link aria-hidden="true" />, onSelect: () => {} },
            { id: "edit", label: "Edit message", icon: <Pencil aria-hidden="true" />, onSelect: () => {} },
            {
              id: "delete",
              label: "Delete message",
              icon: <Trash2 aria-hidden="true" />,
              danger: true,
              onSelect: () => {},
            },
          ]}
        />
      </main>
    );
  },
};
