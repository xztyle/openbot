import type { AgentTemplateDetail } from "@openbot/contracts/ipc";
import { FormDialog, Heading, LoadingState, Text } from "@openbot/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";
import { AgentAvatar } from "./AgentAvatar";
import { TemplateInstructions, TemplateRoutines, TemplateSkills } from "./AgentTemplateSections";

export interface AgentTemplateInstallDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The template a link named. Null while it loads. */
  detail: AgentTemplateDetail | null;
  loading: boolean;
  onInstall: () => Promise<void>;
  /** Opens a link from the instructions. */
  onOpenLink: (url: string) => void;
}

/**
 * What an `openbot://agents/<id>` link opens. It shows all of what the agent will follow before
 * anything is installed: a link alone never adds an agent.
 */
export function AgentTemplateInstallDialog(props: AgentTemplateInstallDialogProps) {
  const { t, errorMessage } = useText();
  const [installing, setInstalling] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function install(): Promise<void> {
    setInstalling(true);
    setError(null);
    try {
      await props.onInstall();
    } catch (failure) {
      // The dialog stays open with the reason, as every create flow does.
      setError(errorMessage(failure, t("agentTemplate.install.failed")));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
      size="lg"
      title={t("agentTemplate.install.title", {
        name: props.detail?.name ?? t("agentTemplate.install.nameFallback"),
      })}
      description={t("agentTemplate.install.description")}
      error={error()}
      busy={installing()}
      submitLabel={t("agentTemplate.install.action")}
      submitDisabled={!props.detail}
      onSubmit={() => void install()}
    >
      <Show
        when={props.detail}
        fallback={
          <Show when={props.loading}>
            <LoadingState rows={3} label={t("agentTemplate.install.loading")} />
          </Show>
        }
      >
        {(detail) => (
          <>
            <header class="agent-template-identity">
              <AgentAvatar
                seed={detail().avatarSeed}
                hue={detail().avatarHue}
                url={detail().avatarUrl}
                motion="idle"
                class="agent-template-avatar"
              />
              <Heading as="h3" size="md" class="agent-template-name">
                {detail().name}
              </Heading>
              <Text tone="muted" variant="caption">
                {t("agentTemplate.creator", { name: detail().creatorName })}
              </Text>
            </header>
            <div class="agent-template-detail">
              <TemplateInstructions
                title={detail().title}
                description={detail().description}
                onOpenLink={props.onOpenLink}
              />
              <TemplateSkills skills={detail().skills} expandable />
              <TemplateRoutines routines={detail().routines} labelled />
            </div>
          </>
        )}
      </Show>
    </FormDialog>
  );
}
