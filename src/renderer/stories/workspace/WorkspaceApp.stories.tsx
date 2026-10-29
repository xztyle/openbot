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
