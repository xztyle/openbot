import { CreateChannelDialog } from "@openbot/ui/features/workspace/CreateChannelDialog";
import { NewMessageDialog } from "@openbot/ui/features/workspace/NewMessageDialog";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AGENTS, fonikad } from "./workspace-fixtures";
import { LIGHT, PHONE, PHONE_VIEWPORTS } from "./workspace-story";

const candidates = [fonikad, ...AGENTS];

/*
 * The create flows of the workspace on the shared `FormDialog`: a dialog on a computer, a full screen
 * sheet on a phone. The new agent and new space flows use the same frame (Agents/New agent dialog,
 * Workspace/Spaces).
 */
const meta = {
  title: "Workspace/Dialogs",
  component: CreateChannelDialog,
  parameters: { layout: "fullscreen", ...PHONE_VIEWPORTS },
} satisfies Meta<typeof CreateChannelDialog>;
export default meta;
type Story = StoryObj<typeof meta>;

const create = () => (
  <CreateChannelDialog
    open
    onOpenChange={fn()}
    candidates={candidates}
    existingNames={["general", "cakemaker", "leadership"]}
    onCreate={fn()}
  />
);
const newMessage = () => <NewMessageDialog open onOpenChange={fn()} candidates={candidates} onStart={fn()} />;
const failingMessage = () => (
  <NewMessageDialog
    open
    onOpenChange={fn()}
    candidates={candidates}
    onStart={() => Promise.reject(new Error("The host did not answer. Try again."))}
  />
);

export const CreateChannelDark: Story = { render: create };
export const CreateChannelLight: Story = { ...LIGHT, render: create };
/** On an iPhone the flow is a full screen sheet; the footer stays above the home indicator. */
export const CreateChannelPhone: Story = { ...PHONE, render: create };
export const NewMessageDark: Story = { render: newMessage };
export const NewMessageLight: Story = { ...LIGHT, render: newMessage };
export const NewMessagePhone: Story = { ...PHONE, render: newMessage };
/** Pick someone and press Start DM: the failure shows above the footer, and the dialog stays open. */
export const NewMessageFails: Story = { render: failingMessage };
