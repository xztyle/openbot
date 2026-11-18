import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { Button } from "../../button";
import { FormDialog, FormSection } from "../../form-dialog";
import { useText } from "../../text";
import { AgentAvatar } from "./AgentAvatar";
import {
  AgentAppearanceFields,
  AgentDetailsFields,
  type AgentDraftEditorProps,
  createAgentDraftEditor,
  type FirstAgentDraft,
} from "./FirstAgentSetup";

export interface NewAgentDialogProps extends AgentDraftEditorProps {
  open: boolean;
  /** Close and Cancel. Not called while the agent is being created. */
  onOpenChange: (open: boolean) => void;
  /** The last failure, as English source text or a translated message. */
  error?: string | null | undefined;
  /** Creates the agent and opens its chat. */
  onSubmit: (value: FirstAgentDraft) => void | Promise<void>;
}

/**
 * A new agent when the server has agents already: the same `FormDialog` as a new channel or a new
 * space, with the fields of the first-agent page. The first agent of a server keeps its page, as
 * part of setting up the server.
 */
export function NewAgentDialog(props: NewAgentDialogProps): JSX.Element {
  const { t, sourceText } = useText();
  const editor = createAgentDraftEditor(props);
  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      size="lg"
      class="new-agent-dialog"
      title={t("agent.setup.titleAdditional")}
      description={t("agent.setup.descriptionAdditional")}
      error={props.error ? sourceText(props.error) : null}
      busy={props.submitting}
      submitLabel={t("agent.setup.create")}
      submitDisabled={!editor.canSubmit()}
      onSubmit={() => void props.onSubmit(props.value)}
    >
      <div class="new-agent-identity" data-avatar-seed={props.value.avatarSeed}>
        <span class="new-agent-preview" aria-hidden="true">
          <AgentAvatar seed={props.value.avatarSeed} hue={props.value.avatarHue} motion="idle" animationOffset={0.4} />
        </span>
        <div class="new-agent-appearance">
          <AgentAppearanceFields value={props.value} submitting={props.submitting} editor={editor} />
        </div>
      </div>
      <AgentDetailsFields {...props} editor={editor} />
      <FormSection title={t("agent.setup.suggestions")} class="new-agent-ideas">
        <ul class="new-agent-idea-list">
          <For each={props.suggestions}>
            {(suggestion) => (
              <li>
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  class="new-agent-idea"
                  aria-pressed={props.value.suggestionId === suggestion.id ? "true" : "false"}
                  aria-label={t("agent.setup.suggestion.label", {
                    name: t(suggestion.nameKey),
                    description: t(suggestion.descriptionKey),
                  })}
                  disabled={props.submitting}
                  onClick={() => editor.selectSuggestion(suggestion)}
                >
                  <AgentAvatar seed={suggestion.avatarSeed} hue={suggestion.avatarHue} motion="idle" />
                  <span>{t(suggestion.nameKey)}</span>
                </Button>
              </li>
            )}
          </For>
        </ul>
      </FormSection>
    </FormDialog>
  );
}
