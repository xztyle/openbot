import type { AvatarHue } from "@openbot/contracts/ipc";
import type { JSX } from "@solidjs/web";
import { For, Show } from "solid-js";
import { avatarHueSwatch } from "../../bloub-avatar";
import { buttonVariants } from "../../button";
import { ArrowDown, ArrowUp, Bot, Pencil, Plus, Trash2 } from "../../icons";
import { useText } from "../../text";
import { LabelTooltip, LabelTooltipTrigger } from "../../tooltip";
import { WorkspaceContextMenu } from "../workspace/WorkspaceContextMenu";
import type { WorkspaceMenuItem } from "../workspace/workspace-types";

/** One space on the rail. */
export interface SpaceRailItem {
  id: string;
  name: string;
  icon: string | null;
  hue: AvatarHue | null;
  /** A conversation of the space has messages the reader has not read. */
  unread: boolean;
  /** Mentions of the reader in the space that are not read. */
  mentionCount: number;
  /** The space that every host has. It cannot be deleted. */
  general: boolean;
}

export interface SpaceRailProps {
  spaces: readonly SpaceRailItem[];
  activeId: string;
  onSelect: (spaceId: string) => void;
  /** Opens the list of the space's agents. */
  onOpenAgents: (spaceId: string) => void;
  /** Present for an owner or an admin: they make, change, order and delete spaces. */
  manage?:
    | {
        onCreate: () => void;
        onEdit: (spaceId: string) => void;
        onDelete: (spaceId: string) => void;
        onMove: (spaceId: string, direction: -1 | 1) => void;
      }
    | undefined;
}

/** The first letters of the words of a name, for a space without an emoji. */
export function spaceInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  const letters = words.length > 1 ? words.slice(0, 2).map((word) => word[0]) : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toLocaleUpperCase();
}

/** The mark of a space: its emoji, or its initials on its color. */
export function SpaceMark(props: { name: string; icon: string | null; hue: AvatarHue | null; class?: string }) {
  return (
    <span
      class={["space-mark", props.class, { "space-mark-emoji": Boolean(props.icon) }]}
      style={props.hue === null ? undefined : { "--space-hue": avatarHueSwatch(props.hue) }}
      data-hue={props.hue === null ? undefined : ""}
      aria-hidden="true"
    >
      {props.icon ?? spaceInitials(props.name)}
    </span>
  );
}

/**
 * The spaces of the server as a column of marks, like the servers of Discord. The one that shows has
 * a bar beside it; a space with unread messages has a dot, and one with mentions their count.
 */
export function SpaceRail(props: SpaceRailProps): JSX.Element {
  const { t } = useText();
  const items = (space: SpaceRailItem, index: number): WorkspaceMenuItem[] => {
    const manage = props.manage;
    return [
      {
        id: "agents",
        label: t("workspace.spaces.agents"),
        icon: <Bot aria-hidden="true" />,
        onSelect: () => props.onOpenAgents(space.id),
      },
      ...(manage
        ? [
            {
              id: "edit",
              label: t("workspace.spaces.edit"),
              icon: <Pencil aria-hidden="true" />,
              onSelect: () => manage.onEdit(space.id),
            },
            {
              id: "move-up",
              label: t("workspace.sidebar.moveUp"),
              icon: <ArrowUp aria-hidden="true" />,
              disabled: index === 0,
              onSelect: () => manage.onMove(space.id, -1),
            },
            {
              id: "move-down",
              label: t("workspace.sidebar.moveDown"),
              icon: <ArrowDown aria-hidden="true" />,
              disabled: index === props.spaces.length - 1,
              onSelect: () => manage.onMove(space.id, 1),
            },
            ...(space.general
              ? []
              : [
                  {
                    id: "delete",
                    label: t("workspace.spaces.delete"),
                    icon: <Trash2 aria-hidden="true" />,
                    danger: true,
                    onSelect: () => manage.onDelete(space.id),
                  },
                ]),
          ]
        : []),
    ];
  };
  return (
    <nav class="space-rail" aria-label={t("workspace.spaces.label")}>
      <ul class="space-rail-list">
        <For each={props.spaces} keyed={(space) => space.id}>
          {(space, index) => (
            <li class="space-rail-item">
              <WorkspaceContextMenu
                items={() => items(space(), index())}
                label={t("workspace.spaces.menu", { name: space().name })}
              >
                <LabelTooltip content={space().name} placement="right">
                  <LabelTooltipTrigger
                    as="button"
                    type="button"
                    class={buttonVariants({ variant: "ghost", class: "space-rail-button" })}
                    aria-label={
                      space().mentionCount > 0
                        ? t("workspace.spaces.buttonMentions", { name: space().name, count: space().mentionCount })
                        : space().unread
                          ? t("workspace.spaces.buttonUnread", { name: space().name })
                          : space().name
                    }
                    aria-pressed={props.activeId === space().id ? "true" : "false"}
                    aria-keyshortcuts={props.manage ? "Alt+ArrowUp Alt+ArrowDown" : undefined}
                    onClick={() => props.onSelect(space().id)}
                    onKeyDown={(event: KeyboardEvent) => {
                      if (!props.manage || !event.altKey) return;
                      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                      event.preventDefault();
                      props.manage.onMove(space().id, event.key === "ArrowUp" ? -1 : 1);
                    }}
                  >
                    <span class="space-rail-bar" aria-hidden="true" />
                    <SpaceMark name={space().name} icon={space().icon} hue={space().hue} />
                    <Show
                      when={space().mentionCount > 0}
                      fallback={
                        <Show when={space().unread && props.activeId !== space().id}>
                          <span class="space-rail-dot" aria-hidden="true" />
                        </Show>
                      }
                    >
                      <span class="space-rail-count" aria-hidden="true">
                        {space().mentionCount > 99 ? "99+" : space().mentionCount}
                      </span>
                    </Show>
                  </LabelTooltipTrigger>
                </LabelTooltip>
              </WorkspaceContextMenu>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.manage}>
        {(manage) => (
          <LabelTooltip content={t("workspace.spaces.create")} placement="right">
            <LabelTooltipTrigger
              as="button"
              type="button"
              class={buttonVariants({ variant: "ghost", class: "space-rail-button space-rail-add" })}
              aria-label={t("workspace.spaces.create")}
              onClick={() => manage().onCreate()}
            >
              <span class="space-mark space-mark-add" aria-hidden="true">
                <Plus />
              </span>
            </LabelTooltipTrigger>
          </LabelTooltip>
        )}
      </Show>
    </nav>
  );
}
