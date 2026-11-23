import type { ServerSummary } from "@openbot/contracts/ipc";
import { buttonVariants, ChevronsUpDown, ContextMenu, DropdownMenu, Moon } from "@openbot/ui";
import { SwapLabel } from "@openbot/ui/components/SwapLabel";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { type ServerActionCallbacks, ServerActionItems } from "./ServerActionItems";
import { ServerMark, serverHostedSleep } from "./ServerMark";

export interface ServerMenuProps extends ServerActionCallbacks {
  servers: ServerSummary[];
  serverName: string;
  /** The compact sidebar hides the server name. */
  compact?: boolean;
}

function isContextMenuKey(event: KeyboardEvent): boolean {
  return event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");
}

/**
 * The server name on the sidebar title. Its menu holds the actions of the server that this app runs on:
 * mute, notifications, settings and the hosted server actions.
 */
export function ServerMenu(props: ServerMenuProps) {
  const { t } = useText();
  const [menuOpen, setMenuOpen] = createSignal(false);
  // The context menu of the server name opens from this hidden anchor.
  let anchor: HTMLElement | undefined;
  let trigger: HTMLElement | undefined;
  const activeServer = () => props.servers.find((server) => server.active);
  const activeSleep = () => {
    const server = activeServer();
    return server ? serverHostedSleep(server) : null;
  };
  /** The name, or why the server does not answer while it sleeps or wakes. */
  const triggerTitle = () => {
    const sleep = activeSleep();
    if (sleep === "sleeping") return t("server.sleep.tooltipSleeping", { name: props.serverName });
    if (sleep === "waking") return t("server.sleep.tooltipWaking", { name: props.serverName });
    return props.serverName;
  };

  function openActions(clientX: number, clientY: number): void {
    anchor?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY }));
  }

  return (
    <>
      <DropdownMenu.Root open={menuOpen()} onOpenChange={setMenuOpen} placement="bottom-start" gutter={6}>
        <DropdownMenu.Trigger
          ref={(element) => (trigger = element)}
          class={buttonVariants({
            variant: "ghost",
            size: "sm",
            class: "sidebar-server-name no-drag",
          })}
          aria-label={[
            t("server.menu.open", { name: props.serverName }),
            ...(activeSleep() === "sleeping" ? [t("server.state.sleeping")] : []),
            ...(activeSleep() === "waking" ? [t("server.state.waking")] : []),
          ].join(", ")}
          aria-hidden={props.compact ? "true" : undefined}
          aria-keyshortcuts="Shift+F10"
          tabindex={props.compact ? -1 : 0}
          title={triggerTitle()}
          onContextMenu={(event) => {
            event.preventDefault();
            openActions(event.clientX, event.clientY);
          }}
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            openActions(bounds.left, bounds.bottom);
          }}
        >
          <Show when={activeServer()}>
            {(server) => (
              <span class="server-menu-mark sidebar-server-name-mark" aria-hidden="true">
                <ServerMark server={server()} />
              </span>
            )}
          </Show>
          <SwapLabel class="sidebar-server-name-label" text={props.serverName} />
          <Show when={activeSleep()}>
            {(sleep) => <Moon class="sidebar-server-name-sleep" data-state={sleep()} aria-hidden="true" />}
          </Show>
          <ChevronsUpDown class="sidebar-server-name-chevron" aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="agent-context-menu server-menu" aria-label={t("server.menu.label")}>
            <Show when={activeServer()}>
              {(server) => (
                <ServerActionItems
                  menu={DropdownMenu}
                  server={server()}
                  trigger={() => trigger ?? null}
                  onSetMuted={props.onSetMuted}
                  onSetNotificationLevel={props.onSetNotificationLevel}
                  onOpenSettings={props.onOpenSettings}
                  onLeave={props.onLeave}
                  onDelete={props.onDelete}
                  canDelete={props.canDelete}
                  onRestart={props.onRestart}
                  canRestart={props.canRestart}
                  onRemove={props.onRemove}
                  canRemove={props.canRemove}
                />
              )}
            </Show>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {/* A sibling, not a parent: inside a menu root, Kobalte makes the dropdown a submenu without a focus trap. */}
      <ContextMenu.Root modal={false}>
        <ContextMenu.Trigger
          hidden
          ref={(element) => (anchor = element)}
          onContextMenu={(event) => {
            if (!activeServer()) event.preventDefault();
          }}
        />
        <ContextMenu.Portal>
          <ContextMenu.Content class="agent-context-menu" aria-label={t("server.rail.actions")}>
            <Show when={activeServer()}>
              {(server) => (
                <ServerActionItems
                  menu={ContextMenu}
                  server={server()}
                  trigger={() => trigger ?? null}
                  onSetMuted={props.onSetMuted}
                  onSetNotificationLevel={props.onSetNotificationLevel}
                  onOpenSettings={props.onOpenSettings}
                  onLeave={props.onLeave}
                  onDelete={props.onDelete}
                  canDelete={props.canDelete}
                  onRestart={props.onRestart}
                  canRestart={props.canRestart}
                  onRemove={props.onRemove}
                  canRemove={props.canRemove}
                />
              )}
            </Show>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </>
  );
}
