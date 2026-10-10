import type { MarketplaceSkillSummary } from "@openbot/contracts/ipc";
import { Button, buttonVariants, Check, ChevronDown, ConfirmDialog, DropdownMenu, Text } from "@openbot/ui";
import { AgentAvatar } from "@openbot/ui/features/agents/AgentAvatar";
import { useText } from "@openbot/ui/text";
import { createSignal, For, Show } from "solid-js";
import { MenuCheck } from "./MarketplaceParts";
import type { MarketplaceAgent } from "./marketplace-model";
import type { MarketplaceScope } from "./marketplace-view";

/** The agents that have the skill, in any state. */
export function skillAgents(scope: MarketplaceScope, skill: MarketplaceSkillSummary): MarketplaceAgent[] {
  return scope.model.agents().filter((agent) => scope.model.installedSkill(agent.id, skill.id));
}

/**
 * The agents whose copy of the skill is older than the one on offer. A modified skill is left out:
 * an update would replace the user's changes, so it stays until the user chooses to replace it.
 */
export function outdatedAgentIds(scope: MarketplaceScope, skill: MarketplaceSkillSummary): string[] {
  return skillAgents(scope, skill)
    .filter((agent) => {
      const installed = scope.model.installedSkill(agent.id, skill.id);
      return (
        installed?.state === "update-available" ||
        (installed?.state === "installed" && installed.installedVersion < skill.version)
      );
    })
    .map((agent) => agent.id);
}

/**
 * The menu that installs something on agents. The button says which agents have it. Its menu lists
 * the user's agents, with "All agents" first; a check installs on that agent and a clear removes it.
 * A skill and the skills of a plugin use the same menu.
 */
export function AgentMenu(props: {
  agents: readonly MarketplaceAgent[];
  /** What is installed, in the words of the button: a skill's name, or "Linear skills". */
  name: string;
  has: (agentId: string) => boolean;
  /** An agent whose list did not load may have it already, changed by the user: leave it alone. */
  known: (agentId: string) => boolean;
  /** An agent whose copy has local changes, which a removal would delete. */
  modified?: ((agentId: string) => boolean) | undefined;
  busy: boolean;
  activeAgentId: string;
  emphasis?: boolean | undefined;
  onOpen: () => void;
  /** `removeModified` is set when the user confirmed the removal of changed files. */
  onChange: (agentIds: readonly string[], on: boolean, options?: { removeModified: boolean }) => void;
}) {
  const { t, format } = useText();
  const [open, setOpen] = createSignal(false);
  /** A removal that waits for the user's answer: from several agents, or of files the user changed. */
  const [removal, setRemoval] = createSignal<{ agentIds: readonly string[]; modified: boolean } | null>(null);
  const change = (agentIds: readonly string[], on: boolean) => {
    if (on) {
      props.onChange(agentIds, true);
      return;
    }
    const modified = agentIds.some((id) => props.modified?.(id) === true);
    if (agentIds.length <= 1 && !modified) {
      props.onChange(agentIds, false);
      return;
    }
    // The menu is modal: a confirmation over it would not take a press.
    setOpen(false);
    setRemoval({ agentIds, modified });
  };
  const removalNames = () => {
    const ids = removal()?.agentIds ?? [];
    return props.agents.filter((agent) => ids.includes(agent.id)).map((agent) => agent.name);
  };
  const have = () => props.agents.filter((agent) => props.has(agent.id));
  const all = () => have().length > 0 && have().length === props.agents.length;
  const label = () => {
    const first = have()[0];
    if (!first) return t("marketplace.skill.installMenu.install");
    if (have().length === 1) return first.name;
    if (all()) return t("marketplace.skill.installMenu.allAgents");
    return t("marketplace.skill.installMenu.agents", { count: have().length });
  };
  return (
    <>
      <DropdownMenu.Root
        placement="bottom-end"
        gutter={4}
        open={open()}
        onOpenChange={(next: boolean) => {
          setOpen(next);
          if (next) props.onOpen();
        }}
      >
        <DropdownMenu.Trigger
          class={`${buttonVariants({
            variant: have().length === 0 && props.emphasis ? "default" : "outline",
            size: props.emphasis ? "default" : "sm",
          })} marketplace-install-trigger`}
          disabled={props.busy}
          aria-busy={props.busy ? "true" : undefined}
          aria-label={
            have().length === 0
              ? t("marketplace.skill.installMenu.installNamed", { name: props.name })
              : t("marketplace.skill.installMenu.change", {
                  count: have().length,
                  label: label(),
                  name: props.name,
                })
          }
        >
          <Show when={have().length > 0}>
            <Check aria-hidden="true" />
          </Show>
          <span class="marketplace-install-label">{label()}</span>
          <ChevronDown aria-hidden="true" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content class="marketplace-menu marketplace-install-menu">
            <DropdownMenu.CheckboxItem
              checked={all()}
              closeOnSelect={false}
              disabled={props.busy}
              onChange={(on: boolean) =>
                change(
                  props.agents
                    .filter((agent) => props.known(agent.id) && props.has(agent.id) !== on)
                    .map((agent) => agent.id),
                  on,
                )
              }
            >
              <MenuCheck on={all()} />
              {t("marketplace.skill.installMenu.allAgents")}
            </DropdownMenu.CheckboxItem>
            <DropdownMenu.Separator />
            <For each={props.agents}>
              {(agent) => (
                <DropdownMenu.CheckboxItem
                  checked={props.has(agent.id)}
                  closeOnSelect={false}
                  disabled={props.busy || !props.known(agent.id)}
                  onChange={(on: boolean) => change([agent.id], on)}
                >
                  <MenuCheck on={props.has(agent.id)} />
                  <span class="marketplace-avatar" data-size="xs">
                    <AgentAvatar agent={agent} motion="idle" />
                  </span>
                  {agent.name}
                  <Show when={agent.id === props.activeAgentId}>
                    <span class="ui-menu-trailing">{t("marketplace.skill.installMenu.here")}</span>
                  </Show>
                </DropdownMenu.CheckboxItem>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <ConfirmDialog
        open={removal() !== null}
        initialFocus="cancel"
        title={
          removalNames().length > 1
            ? t("marketplace.skill.remove.titleMany", { name: props.name, agents: format.list(removalNames()) })
            : t("skill.confirm.removeTitle")
        }
        description={
          removal()?.modified
            ? t(
                removalNames().length > 1
                  ? "marketplace.skill.remove.modifiedMany"
                  : "skill.confirm.removeModifiedBody",
              )
            : t("marketplace.skill.remove.many", { name: props.name })
        }
        confirmLabel={t("skill.confirm.remove")}
        onCancel={() => setRemoval(null)}
        onConfirm={() => {
          const request = removal();
          setRemoval(null);
          if (request) props.onChange(request.agentIds, false, { removeModified: request.modified });
        }}
      />
    </>
  );
}

/** The one install control of a skill. */
export function InstallSkill(props: { scope: MarketplaceScope; skill: MarketplaceSkillSummary; emphasis?: boolean }) {
  const model = () => props.scope.model;
  return (
    <AgentMenu
      agents={model().agents()}
      name={props.skill.name}
      has={(id) => Boolean(model().installedSkill(id, props.skill.id))}
      known={(id) => model().skillRead(id) === "loaded"}
      modified={(id) => model().installedSkill(id, props.skill.id)?.state === "modified"}
      busy={model().skillBusy(props.skill.id)}
      activeAgentId={model().activeAgentId()}
      emphasis={props.emphasis}
      onOpen={() => model().readSkills()}
      onChange={(agentIds, on, options) => void model().setSkill(props.skill, agentIds, on, options)}
    />
  );
}

/**
 * The skill page action: the install menu, and "Update" beside it while an agent has an older
 * version. The update goes to each of those agents.
 */
export function SkillAction(props: { scope: MarketplaceScope; skill: MarketplaceSkillSummary }) {
  const { t } = useText();
  const model = () => props.scope.model;
  const outdated = () => outdatedAgentIds(props.scope, props.skill);
  return (
    <Show when={model().agents().length > 0}>
      <div class="marketplace-head-actions">
        <Show when={outdated().length > 0}>
          <Button
            type="button"
            variant="outline"
            loading={model().skillBusy(props.skill.id)}
            onClick={() => void model().setSkill(props.skill, outdated(), true)}
          >
            {t("marketplace.skill.update")}
          </Button>
        </Show>
        <InstallSkill scope={props.scope} skill={props.skill} emphasis />
      </div>
    </Show>
  );
}

/**
 * Says how many installed skills have a newer version, and updates them all at once. It counts what
 * the agents hold, not the page of the catalog that is loaded, so a skill on a later page is counted
 * too. Skills the user changed are not counted: an update would replace the changes.
 */
export function SkillUpdates(props: { scope: MarketplaceScope }) {
  const { t } = useText();
  const model = () => props.scope.model;
  return (
    <Show when={model().outdatedSkills().length > 0}>
      <section class="marketplace-update" aria-label={t("marketplace.skill.updates.label")}>
        <Text as="p" variant="body-sm">
          {t("marketplace.skill.updates.count", { count: model().outdatedSkills().length })}
        </Text>
        <Button
          type="button"
          size="sm"
          loading={model().skillsUpdating()}
          onClick={() => void model().updateAllSkills()}
        >
          {t("marketplace.skill.updates.all")}
        </Button>
      </section>
    </Show>
  );
}
