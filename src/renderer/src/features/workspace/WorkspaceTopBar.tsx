/*
 * The top bar of the workspace on a computer, as Slack's: the search field of the space in the
 * middle and the keyboard shortcuts at the end. A phone has no top bar; its search is a view.
 */

import {
  type SearchSuggestion,
  WorkspaceSearchBar,
  type WorkspaceSearchBarApi,
} from "@openbot/ui/features/workspace/WorkspaceSearchBar";
import { useText } from "@openbot/ui/text";
import { onCleanup, Show } from "solid-js";
import { currentDevicePlatform } from "../../send-shortcut-preference";
import { useJumpEntries } from "./WorkspaceSwitcher";
import { useWorkspace } from "./workspace-context";
import { shortcutKeys } from "./workspace-shortcuts";

export function WorkspaceTopBar() {
  const ws = useWorkspace();
  const { t } = useText();
  const jump = useJumpEntries();
  let element: HTMLDivElement | undefined;
  let api: WorkspaceSearchBarApi | undefined;
  onCleanup(
    ws.search.attachBar({
      focus: (text) => api?.focus(text),
      visible: () => Boolean(element?.isConnected && element.offsetParent !== null),
    }),
  );
  const scope = () =>
    ws.spaces.available() ? (ws.spaces.space(ws.spaces.current())?.name ?? ws.env.serverName()) : ws.env.serverName();
  const suggestions = (text: string): SearchSuggestion[] =>
    jump
      .entries(text, 6)
      .filter((entry) => entry.kind !== "view" && entry.kind !== "create")
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        kind: entry.kind === "channel" || entry.kind === "dm" || entry.kind === "agent" ? entry.kind : "person",
        private: entry.private,
        member: entry.member,
      }));
  return (
    <Show when={!ws.env.phone() && ws.search.supported()}>
      <div class="ws-topbar" ref={(div) => (element = div)}>
        <WorkspaceSearchBar
          ref={(next) => (api = next)}
          placeholder={t("workspace.search.placeholderIn", { name: scope() })}
          shortcut={shortcutKeys(["mod"], "G", currentDevicePlatform() === "darwin").join(
            currentDevicePlatform() === "darwin" ? "" : "+",
          )}
          query={(() => {
            const route = ws.route();
            return route.kind === "view" && route.view === "search" ? ws.search.state.query : "";
          })()}
          recent={ws.search.state.recent}
          suggestions={suggestions}
          onSubmit={(query) => ws.openSearch(query)}
          onOpenSuggestion={(id) => {
            if (id.startsWith("person:")) ws.messageMember(id.slice("person:".length));
            else ws.openConversation(id);
          }}
          onShortcuts={() => ws.openDialog({ kind: "shortcuts" })}
          shortcutsLabel={t("workspace.shortcuts.title")}
        />
      </div>
    </Show>
  );
}
