import { CreateChannelDialog } from "@openbot/ui/features/workspace/CreateChannelDialog";
import { NewMessageDialog } from "@openbot/ui/features/workspace/NewMessageDialog";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { AGENTS, fonikad } from "./workspace-fixtures";
import { LIGHT } from "./workspace-story";

const candidates = [fonikad, ...AGENTS];

const meta = {
  title: "Workspace/Dialogs",
  component: CreateChannelDialog,
  parameters: { layout: "fullscreen" },
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

export const CreateChannelDark: Story = { render: create };
export const CreateChannelLight: Story = { ...LIGHT, render: create };
export const NewMessageDark: Story = { render: newMessage };
export const NewMessageLight: Story = { ...LIGHT, render: newMessage };
