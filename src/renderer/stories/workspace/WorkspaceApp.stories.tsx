import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { App } from "../../src/App";
import { OpenBotPlayground } from "../../src/preview/OpenBotPlayground";
import { seeds } from "./workspace-app-seeds";

const meta = {
  title: "Workspace/App",
  component: App,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof App>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Workspace: Story = {
  render: () => <OpenBotPlayground options={{ channels: seeds() }} />,
};

/** A workspace with no channel yet: the welcome, with "Create #general with your team". */
export const EmptyWorkspace: Story = {
  render: () => <OpenBotPlayground options={{ channels: [] }} />,
};

/** A server with spaces: Trading holds Research and #cakemaker; the rail switches between them. */
export const Spaces: Story = {
  render: () => (
    <OpenBotPlayground
      options={{
        channels: seeds(),
        spaces: [
          {
            space: { id: "trading", name: "Trading", icon: "📈", hue: 215 },
            agentIds: ["research"],
            channelIds: ["cakemaker"],
          },
          { space: { id: "piks", name: "Piks", icon: null, hue: 150 } },
        ],
      }}
    />
  ),
};
