import { MessageComposer } from "@openbot/ui/features/workspace/MessageComposer";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CakemakerComposer, LIGHT } from "./workspace-story";

function Composers() {
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "32px",
        "max-width": "720px",
        padding: "32px 0",
        background: "var(--openbot-bg-canvas)",
      }}
    >
      <CakemakerComposer />
      <div style={{ "max-width": "400px" }}>
        <CakemakerComposer thread />
      </div>
    </div>
  );
}

const meta = {
  title: "Workspace/MessageComposer",
  component: MessageComposer,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MessageComposer>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Composers /> };
export const Light: Story = { ...LIGHT, render: () => <Composers /> };
