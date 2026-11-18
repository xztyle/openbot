import {
  createFirstAgentDraft,
  FIRST_AGENT_SUGGESTIONS,
  type FirstAgentDraft,
} from "@openbot/ui/features/agents/FirstAgentSetup";
import { NewAgentDialog, type NewAgentDialogProps } from "@openbot/ui/features/agents/NewAgentDialog";
import { createSignal } from "solid-js";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_AGENT_STATUS, STORY_MODELS } from "./fixtures";
import { PHONE, PHONE_VIEWPORTS } from "./workspace/workspace-story";

// The first face, as the app picks one at random. Story args are made before a provider renders, so
// the default name is English.
const DRAFT = createFirstAgentDraft(() => 0);

/** The dialog keeps its own draft, as the app's agent context does. */
function ControlledNewAgentDialog(props: NewAgentDialogProps) {
  const [draft, setDraft] = createSignal<FirstAgentDraft>({ ...props.value });
  return (
    <NewAgentDialog
      {...props}
      value={draft()}
      onChange={(value) => {
        setDraft(value);
        props.onChange(value);
      }}
    />
  );
}

const args: NewAgentDialogProps = {
  open: true,
  value: DRAFT,
  suggestions: FIRST_AGENT_SUGGESTIONS,
  modelOptions: STORY_MODELS,
  agentStatus: STORY_AGENT_STATUS,
  onManageProviders: fn(),
  onOpenChange: fn(),
  onChange: fn(),
  onSubmit: fn(),
};

/*
 * A new agent on a server that has agents: the same `FormDialog` as a new channel, a new message and
 * a new space. The first agent of a server keeps its page (Setup/FirstAgentSetup).
 */
const meta = {
  title: "Agents/New agent dialog",
  component: NewAgentDialog,
  args,
  parameters: { layout: "fullscreen", ...PHONE_VIEWPORTS },
  render: (storyArgs) => <ControlledNewAgentDialog {...storyArgs} />,
} satisfies Meta<typeof NewAgentDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** On an iPhone: a full screen sheet; the faces and the ideas scroll sideways. */
export const Phone: Story = { ...PHONE };

/** Create runs: the fields and Cancel are off, and the dialog cannot close. */
export const Creating: Story = { args: { submitting: true } };

/** The host refused the agent: the reason shows above the footer, and the form stays filled. */
export const Failed: Story = {
  args: { error: "The server has reached its agent limit. Delete an agent and try again." },
};
