import type { ChannelDraft } from "@openbot/contracts/ipc";
import { Checkbox, ErrorReference, Field, FormDialog, Input, Search, UsersRound } from "@openbot/ui";
import { createScrollFades } from "@openbot/ui/components/createScrollFades";
import { ChannelMemberRow } from "@openbot/ui/features/channels/ChannelMemberRow";
import { useText } from "@openbot/ui/text";
import { createEffect, createSignal, createStore, For, onSettled, Show, snapshot } from "solid-js";
import { useChannels } from "./channels-context";
import { emptyChannelDraft, matchesAgentSearch, toggleChannelMember } from "./channels-draft";

/**
 * Creation asks for the two things that cannot be guessed - a name and the agents - and leaves the
 * purpose and the lead to Channel settings. The lead is the first selected member until settings
 * changes it. It is the channel form of a server without the workspace (an older version); the
 * workspace has its own `CreateChannelDialog`. Both use the same `FormDialog`.
 */
export function ChannelCreateDialog() {
  const channels = useChannels();
  const { t, sourceText } = useText();
  const agentList = channels.agents;
  const channelId = crypto.randomUUID();
  const [draft, setDraft] = createStore<ChannelDraft>(emptyChannelDraft());
  const [view, setView] = createStore({ search: "" });
  const filtered = () => agentList().filter((agent) => matchesAgentSearch(agent, view.search));
  // `.t-resize` tweens between two explicit heights, so the list gets its measured content height
  // after every filter change. The stylesheet's `max-height` still caps how tall it can grow.
  let listBody: HTMLDivElement | undefined;
  const [listHeight, setListHeight] = createSignal<string>();
  const listFades = createScrollFades();
  onSettled(() => listFades.stop);
  createEffect(
    () => filtered(),
    () => {
      const height = listBody?.getBoundingClientRect().height;
      if (height) setListHeight(`${height}px`);
      // A filter changes what overflows without always changing the element's own height, which
      // is the one case the bound resize observer cannot see.
      listFades.remeasure();
    },
  );
  const toggle = (agentId: string, checked: boolean) =>
    setDraft((state) => {
      toggleChannelMember(state, agentId, checked);
    });
  const canCreate = () => Boolean(draft.name.trim()) && draft.members.length > 0;
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open) channels.closeEditor();
      }}
      class="channel-create-dialog"
      title={t("sidebar.new.channel")}
      error={
        channels.state.error ? (
          <>
            {sourceText(channels.state.error)}
            <ErrorReference reference={channels.state.errorReference} />
          </>
        ) : null
      }
      busy={channels.state.pending}
      submitLabel={t("channel.create.submit")}
      submitDisabled={!canCreate()}
      onSubmit={() =>
        void channels.command({
          type: "save",
          operationId: crypto.randomUUID(),
          channelId,
          draft: snapshot(draft),
        })
      }
    >
      <Field label={t("channel.form.name")} required>
        <Input
          placeholder={t("channel.form.namePlaceholder")}
          autocomplete="off"
          value={draft.name}
          onValueChange={(name) =>
            setDraft((state) => {
              state.name = name;
            })
          }
        />
      </Field>
      <fieldset class="channel-picker">
        <legend>{t("channel.create.addAgents")}</legend>
        <label class="search-field channel-member-search">
          <span class="sr-only">{t("channel.create.searchAgents")}</span>
          <Search class="channel-search-icon" aria-hidden="true" />
          <Input
            type="search"
            aria-label={t("channel.create.searchAgents")}
            placeholder={t("channel.create.searchAgents")}
            value={view.search}
            onValueChange={(search) =>
              setView((state) => {
                state.search = search;
              })
            }
          />
        </label>
        <div
          ref={listFades.bind}
          class={["channel-picker-list t-resize", listFades.classes()]}
          style={{ height: listHeight() }}
          onScroll={listFades.measure}
        >
          <div ref={listBody} class="channel-picker-body">
            <For each={filtered()}>
              {(agent) => (
                // The label stays the outer element, so pointing anywhere on the row
                // selects the agent, and the row still names the checkbox it holds.
                <label class="channel-picker-entry" for={`channel-member-${agent.id}`}>
                  <ChannelMemberRow
                    agent={agent}
                    fallbackName={agent.name}
                    description={agent.description}
                    leading={
                      <Checkbox
                        id={`channel-member-${agent.id}`}
                        checked={draft.members.some((member) => member.agentId === agent.id)}
                        onChange={(event) => toggle(agent.id, event.currentTarget.checked)}
                      />
                    }
                  />
                </label>
              )}
            </For>
            <Show when={!filtered().length}>
              <div class="channel-picker-empty">
                <Show when={!agentList().length}>
                  <UsersRound aria-hidden="true" />
                </Show>
                <p>{agentList().length ? t("channel.create.noMatches") : t("sidebar.empty.noAgents")}</p>
                <Show when={!agentList().length}>
                  <span>{t("channel.create.noAgentsHint")}</span>
                </Show>
              </div>
            </Show>
          </div>
        </div>
      </fieldset>
    </FormDialog>
  );
}
