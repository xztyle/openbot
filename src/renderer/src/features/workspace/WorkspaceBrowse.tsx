/*
 * Browse channels (⌘⇧L), as Slack's channel directory: the public channels of the space and the
 * private ones the reader is in, with their member count and topic, a sort, a type filter and
 * "Hide my channels". A click on a row opens the channel to read before joining (the pane offers
 * Join); the row's own button joins or leaves at once.
 */

import { channelKind, channelVisibility } from "@openbot/contracts/ipc";
import { Button, FormDialog, Hash, Input, Lock, Plus, Search, Switch } from "@openbot/ui";
import { WorkspaceSelect } from "@openbot/ui/features/workspace/WorkspaceSelect";
import { useText } from "@openbot/ui/text";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useWorkspace } from "./workspace-context";
import { channelMembers, readerJoined } from "./workspace-model";

type BrowseSort = "name" | "name-desc" | "members" | "members-asc" | "newest" | "oldest";
type BrowseType = "all" | "public" | "private";

export function ChannelBrowser(props: { onClose: () => void }) {
  const { t } = useText();
  const ws = useWorkspace();
  const [query, setQuery] = createSignal("");
  const [sort, setSort] = createSignal<BrowseSort>("name");
  const [type, setType] = createSignal<BrowseType>("all");
  const [hideMine, setHideMine] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const count = (channel: Parameters<typeof channelMembers>[1]) => channelMembers(ws.directory(), channel).length;
  const channels = createMemo(() => {
    const text = query().trim().toLocaleLowerCase();
    const list = ws.channels.state.channels.filter((channel) => {
      if (channel.archived || channelKind(channel) !== "channel" || !ws.spaces.channelInCurrent(channel.id))
        return false;
      const joined = readerJoined(ws.directory(), channel);
      const visibility = channelVisibility(channel);
      if (visibility === "private" && !joined) return false;
      if (type() !== "all" && visibility !== type()) return false;
      if (hideMine() && joined) return false;
      return (
        !text ||
        channel.name.toLocaleLowerCase().includes(text) ||
        (channel.topic ?? "").toLocaleLowerCase().includes(text) ||
        (channel.description ?? "").toLocaleLowerCase().includes(text)
      );
    });
    const order = sort();
    return list.sort((left, right) => {
      if (order === "members" || order === "members-asc") {
        const difference = count(right) - count(left);
        if (difference) return order === "members" ? difference : -difference;
      }
      if (order === "newest" || order === "oldest") {
        const difference = right.createdAt.localeCompare(left.createdAt);
        if (difference) return order === "newest" ? difference : -difference;
      }
      return order === "name-desc" ? right.name.localeCompare(left.name) : left.name.localeCompare(right.name);
    });
  });
  const act = async (channelId: string, action: () => unknown) => {
    setBusy(channelId);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };
  return (
    <FormDialog
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title={t("workspace.app.browse.title")}
    >
      <div class="ws-switcher-field">
        <Search aria-hidden="true" />
        <Input
          ref={(element) => {
            requestAnimationFrame(() => element.focus());
          }}
          value={query()}
          onValueChange={setQuery}
          placeholder={t("workspace.app.browse.search")}
          aria-label={t("workspace.app.browse.search")}
        />
      </div>
      <div class="ws-browse-filters">
        <WorkspaceSelect<BrowseType>
          label={t("workspace.browse.type")}
          value={type()}
          onChange={setType}
          options={[
            { value: "all", label: t("workspace.browse.allChannels") },
            { value: "public", label: t("workspace.browse.public") },
            { value: "private", label: t("workspace.browse.private") },
          ]}
        />
        <WorkspaceSelect<BrowseSort>
          label={t("workspace.browse.sort")}
          prefix={t("workspace.browse.sortPrefix")}
          value={sort()}
          onChange={setSort}
          options={[
            { value: "name", label: t("workspace.browse.sortName") },
            { value: "name-desc", label: t("workspace.browse.sortNameDesc") },
            { value: "members", label: t("workspace.browse.sortMembers") },
            { value: "members-asc", label: t("workspace.browse.sortMembersAsc") },
            { value: "newest", label: t("workspace.browse.sortNewest") },
            { value: "oldest", label: t("workspace.browse.sortOldest") },
          ]}
        />
        <span class="ws-inline-switch">
          <span aria-hidden="true">{t("workspace.browse.hideMine")}</span>
          <Switch
            size="sm"
            aria-label={t("workspace.browse.hideMine")}
            checked={hideMine()}
            onChange={(checked: boolean) => setHideMine(checked)}
          />
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            props.onClose();
            ws.openDialog({ kind: "create-channel", name: query().trim() || undefined });
          }}
        >
          <Plus aria-hidden="true" />
          {t("workspace.app.browse.create")}
        </Button>
      </div>
      <ul class="ws-browse-list" aria-label={t("workspace.app.browse.title")}>
        <For each={channels()} fallback={<li class="ws-details-empty">{t("workspace.app.browse.empty")}</li>}>
          {(channel) => {
            const joined = () => readerJoined(ws.directory(), channel);
            return (
              <li class="ws-browse-item">
                <Button
                  variant="ghost"
                  class="ws-browse-open"
                  aria-label={t("workspace.browse.preview", { name: channel.name })}
                  onClick={() => {
                    props.onClose();
                    ws.openChannel(channel.id);
                  }}
                >
                  <span class="ws-browse-glyph" aria-hidden="true">
                    <Show when={channelVisibility(channel) === "private"} fallback={<Hash />}>
                      <Lock />
                    </Show>
                  </span>
                  <span class="ws-browse-copy">
                    <span class="ws-browse-name">
                      <strong>{channel.name}</strong>
                      <Show when={joined()}>
                        <span class="ws-search-tag">{t("workspace.browse.joined")}</span>
                      </Show>
                    </span>
                    <span class="ws-muted">
                      {t("workspace.app.browse.members", { count: count(channel) })}
                      <Show when={channel.topic || channel.description}>{(about) => ` · ${about()}`}</Show>
                    </span>
                  </span>
                </Button>
                <Show
                  when={joined()}
                  fallback={
                    <Button
                      size="xs"
                      loading={busy() === channel.id}
                      onClick={() =>
                        void act(channel.id, async () => {
                          await ws.join(channel.id);
                          props.onClose();
                        })
                      }
                    >
                      {t("workspace.app.channel.join")}
                    </Button>
                  }
                >
                  <Show when={channel.name !== "general"}>
                    <Button
                      variant="outline"
                      size="xs"
                      loading={busy() === channel.id}
                      onClick={() => void act(channel.id, () => ws.requestLeave(channel.id))}
                    >
                      {t("workspace.browse.leave")}
                    </Button>
                  </Show>
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
    </FormDialog>
  );
}
