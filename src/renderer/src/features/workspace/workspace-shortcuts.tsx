/*
 * The keyboard shortcuts of the workspace, as Slack's, with the platform's modifier (⌘ on macOS,
 * Ctrl elsewhere), and the ⌘/ sheet that lists them. A key that the app already takes elsewhere
 * keeps its owner: ⌘. stops every agent and ⌘1–9 picks a server on the desktop, so the right pane
 * and the spaces have no key here; in the owner's chat with an agent, ⌘F and ⌘G search that chat.
 * A browser keeps ⌘N, ⌘T and ⌘⇧T for itself, so those work only in the desktop app.
 */

import { ConfirmDialog } from "@openbot/ui";
import { type ShortcutGroup, ShortcutsSheet } from "@openbot/ui/features/workspace/ShortcutsSheet";
import { useText } from "@openbot/ui/text";
import { createSignal, onSettled } from "solid-js";
import { actionToast } from "../../action-toast";
import { currentDevicePlatform } from "../../send-shortcut-preference";
import { useWorkspace } from "./workspace-context";

/** Whether a key press comes from a field the reader types in. */
export function typingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT")
  );
}

type Modifier = "mod" | "shift" | "alt";

/** The keys of a chord as the platform writes them: ⌘ ⇧ K on macOS, Ctrl Shift K elsewhere. */
export function shortcutKeys(modifiers: readonly Modifier[], key: string, mac = currentDevicePlatform() === "darwin") {
  const names: Record<Modifier, string> = mac
    ? { mod: "⌘", shift: "⇧", alt: "⌥" }
    : { mod: "Ctrl", shift: "Shift", alt: "Alt" };
  return [...modifiers.map((modifier) => names[modifier]), key];
}

/** The groups of the ⌘/ sheet. Only keys that the workspace listens for are listed. */
export function workspaceShortcutGroups(t: ReturnType<typeof useText>["t"], mac: boolean): ShortcutGroup[] {
  const keys = (modifiers: readonly Modifier[], key: string) => shortcutKeys(modifiers, key, mac);
  return [
    {
      title: t("workspace.shortcuts.navigation"),
      items: [
        { label: t("workspace.shortcuts.jump"), keys: keys(["mod"], "K") },
        { label: t("workspace.shortcuts.search"), keys: keys(["mod"], "G") },
        { label: t("workspace.shortcuts.searchHere"), keys: keys(["mod"], "F") },
        { label: t("workspace.shortcuts.previous"), keys: keys(["alt"], "↑") },
        { label: t("workspace.shortcuts.next"), keys: keys(["alt"], "↓") },
        { label: t("workspace.shortcuts.previousUnread"), keys: keys(["alt", "shift"], "↑") },
        { label: t("workspace.shortcuts.nextUnread"), keys: keys(["alt", "shift"], "↓") },
        { label: t("workspace.shortcuts.regions"), keys: ["F6"] },
      ],
    },
    {
      title: t("workspace.shortcuts.views"),
      items: [
        { label: t("workspace.view.unreads"), keys: keys(["mod", "shift"], "A") },
        { label: t("workspace.view.threads"), keys: keys(["mod", "shift"], "T") },
        { label: t("workspace.view.activity"), keys: keys(["mod", "shift"], "M") },
        { label: t("workspace.view.dms"), keys: keys(["mod", "shift"], "K") },
        { label: t("workspace.view.later"), keys: keys(["mod", "shift"], "S") },
        { label: t("workspace.shortcuts.browse"), keys: keys(["mod", "shift"], "L") },
        { label: t("workspace.shortcuts.details"), keys: keys(["mod", "shift"], "I") },
        { label: t("workspace.sidebar.newMessage"), keys: keys(["mod"], "N") },
      ],
    },
    {
      title: t("workspace.shortcuts.reading"),
      items: [
        { label: t("workspace.shortcuts.firstUnread"), keys: keys(["mod"], "J") },
        { label: t("workspace.shortcuts.markRead"), keys: ["Esc"] },
        { label: t("workspace.shortcuts.markAllRead"), keys: keys(["shift"], "Esc") },
        { label: t("workspace.shortcuts.closePanel"), keys: ["Esc"] },
        { label: t("workspace.shortcuts.editLast"), keys: ["↑"] },
        { label: t("workspace.shortcuts.sheet"), keys: keys(["mod"], "/") },
      ],
    },
  ];
}

/** The regions that F6 moves between, as Slack's: the sidebar, the main pane and the right panel. */
const REGIONS = [".ws-sidebar", ".ws-topbar", ".ws-layout-main", ".ws-layout-panel"] as const;
const FOCUSABLE =
  'textarea:not([disabled]), [contenteditable="true"], input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function moveRegion(step: 1 | -1) {
  const regions = REGIONS.flatMap((selector) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element && element.offsetParent !== null ? [element] : [];
  });
  if (!regions.length) return;
  const current = regions.findIndex((region) => region.contains(document.activeElement));
  const next = regions[(current + step + regions.length) % regions.length];
  // A pane lands on its composer when it has one, as Slack's message pane does.
  const target =
    next?.querySelector<HTMLElement>('[contenteditable="true"], textarea') ??
    next?.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus();
}

/**
 * Listens for the workspace shortcuts and mounts the ⌘/ sheet and the Shift+Escape confirm. The
 * chords listen first (capture), so a field does not keep them; Escape listens last, so a dialog,
 * a menu or a field takes its own Escape first.
 */
export function WorkspaceKeyboard() {
  const ws = useWorkspace();
  const { t } = useText();
  const mac = currentDevicePlatform() === "darwin";
  const [marking, setMarking] = createSignal(false);

  const unreadInSpace = () =>
    ws.channels.state.channels
      .filter((channel) => channel.unreadCount > 0 && ws.spaces.channelInCurrent(channel.id))
      .map((channel) => channel.id);

  /** Alt+Shift+↑ and ↓: the previous and next conversation with unread messages, in sidebar order. */
  function moveUnread(step: 1 | -1) {
    const rows = [...ws.sidebarChannels(), ...ws.sidebarDirectMessages()];
    const unread = rows.filter((row) => (row.unread && !row.muted) || (row.mentionCount ?? 0) > 0);
    if (!unread.length) return;
    const order = rows.map((row) => row.id);
    const current = order.indexOf(ws.activeConversationId() ?? "");
    const after = (id: string) => (order.indexOf(id) - current + order.length) % order.length;
    const sorted = [...unread].sort((left, right) => after(left.id) - after(right.id));
    const next = step === 1 ? sorted.find((row) => row.id !== ws.activeConversationId()) : sorted.at(-1);
    if (next) ws.openConversation(next.id);
  }

  /** ⌘G and /: the top bar's field on a computer, the search view on a phone. */
  function startSearch(text?: string) {
    if (ws.search.focusBar(text)) return;
    ws.openSearch();
  }

  onSettled(() => {
    const capture = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key?.toLocaleLowerCase() ?? "";
      const route = ws.route();
      const take = (action: () => void) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
      };
      if (mod && !event.altKey && !event.shiftKey) {
        if (key === "k")
          // The switcher takes ⌘K from the message search, which stays in the workspace menu.
          return take(() => ws.openDialog(ws.state.dialog?.kind === "switcher" ? null : { kind: "switcher" }));
        if (ws.state.dialog || document.querySelector('[aria-modal="true"]')) return;
        // The owner's chat with an agent keeps ⌘F and ⌘G for its own search.
        if (key === "g" && route.kind !== "agent") return take(() => startSearch());
        if (key === "f" && route.kind === "channel") {
          const name = ws.summary(route.channelId)?.name;
          return take(() => startSearch(name ? `in:#${name} ` : undefined));
        }
        if (key === "/" && !(route.kind === "view" && route.view === "routines"))
          return take(() => ws.openDialog({ kind: "shortcuts" }));
        if (key === "n") return take(() => ws.openDialog({ kind: "new-message" }));
        return;
      }
      if (mod && event.shiftKey && !event.altKey) {
        if (ws.state.dialog || document.querySelector('[aria-modal="true"]')) return;
        const view =
          key === "a"
            ? "unreads"
            : key === "t"
              ? "threads"
              : key === "m"
                ? "activity"
                : key === "k"
                  ? "dms"
                  : key === "s" && ws.viewAvailable("later")
                    ? "later"
                    : null;
        if (view) return take(() => ws.openView(view));
        if (key === "l") return take(() => ws.openDialog({ kind: "browse" }));
        if (key === "i" && route.kind === "channel") return take(() => ws.openDetails(route.channelId));
        return;
      }
      if (event.altKey && !mod && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        const step = event.key === "ArrowUp" ? -1 : 1;
        return take(() => (event.shiftKey ? moveUnread(step) : ws.moveConversation(step)));
      }
      if (event.key === "F6" && !mod && !event.altKey) return take(() => moveRegion(event.shiftKey ? -1 : 1));
    };
    const bubble = (event: KeyboardEvent) => {
      if (event.defaultPrevented || ws.state.dialog) return;
      // A dialog or a menu of the app takes its own keys.
      if (document.querySelector('[aria-modal="true"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "/" && !mod && !event.altKey && !typingTarget(event.target)) {
        event.preventDefault();
        startSearch();
        return;
      }
      if (event.key !== "Escape" || mod || event.altKey) return;
      if (event.shiftKey) {
        if (unreadInSpace().length) {
          event.preventDefault();
          ws.openDialog({ kind: "mark-all-read" });
        }
        return;
      }
      if (ws.state.panel) {
        event.preventDefault();
        ws.closePanel();
        return;
      }
      if (!typingTarget(event.target) || ws.channels.state.unread) ws.markRead();
    };
    window.addEventListener("keydown", capture, true);
    window.addEventListener("keydown", bubble);
    return () => {
      window.removeEventListener("keydown", capture, true);
      window.removeEventListener("keydown", bubble);
    };
  });

  return (
    <>
      <ShortcutsSheet
        open={ws.state.dialog?.kind === "shortcuts"}
        onOpenChange={(open) => {
          if (!open) ws.openDialog(null);
        }}
        groups={workspaceShortcutGroups(t, mac)}
      />
      <ConfirmDialog
        open={ws.state.dialog?.kind === "mark-all-read"}
        onCancel={() => ws.openDialog(null)}
        title={t("workspace.shortcuts.markAllTitle")}
        description={t("workspace.shortcuts.markAllDescription")}
        confirmLabel={t("workspace.shortcuts.markAllConfirm")}
        tone="default"
        pending={marking()}
        onConfirm={async () => {
          setMarking(true);
          try {
            await ws.channels.markAllRead(unreadInSpace());
            void ws.refreshActivity();
            ws.openDialog(null);
          } catch {
            actionToast.error(t("workspace.shortcuts.markAllFailed"));
          } finally {
            setMarking(false);
          }
        }}
      />
    </>
  );
}
