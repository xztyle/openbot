import { WorkspaceSidebar } from "@openbot/ui/features/workspace/WorkspaceSidebar";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { CakemakerSidebar, LIGHT, StoryFrame } from "./workspace-story";

const meta = {
  title: "Workspace/Sidebar",
  component: WorkspaceSidebar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspaceSidebar>;
export default meta;
type Story = StoryObj<typeof meta>;

const frame = (activeView?: "fleet") => (
  <StoryFrame width="280px">
    <div style={{ height: "100%", background: "var(--openbot-bg-sidebar)" }}>
      <CakemakerSidebar activeView={activeView} />
    </div>
  </StoryFrame>
);

export const Dark: Story = { render: () => frame() };
export const Light: Story = { ...LIGHT, render: () => frame() };
export const FleetActive: Story = { render: () => frame("fleet") };
