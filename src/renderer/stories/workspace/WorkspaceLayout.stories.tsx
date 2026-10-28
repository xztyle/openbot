import { WorkspaceLayout } from "@openbot/ui/features/workspace/WorkspaceLayout";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import {
  CakemakerComposer,
  CakemakerHeader,
  CakemakerMessages,
  CakemakerSidebar,
  CakemakerThread,
  CakemakerTyping,
  LIGHT,
  StoryFrame,
} from "./workspace-story";

/*
 * The whole Slack-style workspace assembled from the presentational kit: sidebar, #cakemaker with
 * its messages and composer, and the open thread in the right panel.
 */

function Workspace(props: { phonePane?: "sidebar" | "main" | "panel"; width?: string; thread?: boolean }) {
  return (
    <StoryFrame width={props.width}>
      <WorkspaceLayout
        phonePane={props.phonePane}
        sidebar={<CakemakerSidebar />}
        main={
          <>
            <CakemakerHeader onBack={fn()} />
            <CakemakerMessages />
            <CakemakerTyping />
            <CakemakerComposer />
          </>
        }
        panel={props.thread === false ? undefined : <CakemakerThread onBack={fn()} />}
        onSidebarWidthChange={fn()}
        onPanelWidthChange={fn()}
      />
    </StoryFrame>
  );
}

const meta = {
  title: "Workspace/Layout",
  component: WorkspaceLayout,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspaceLayout>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dark: Story = { render: () => <Workspace /> };
export const Light: Story = { ...LIGHT, render: () => <Workspace /> };
export const WithoutPanel: Story = { render: () => <Workspace thread={false} /> };
export const PhoneSidebar: Story = { render: () => <Workspace width="390px" phonePane="sidebar" /> };
export const PhoneChannel: Story = { render: () => <Workspace width="390px" phonePane="main" /> };
export const PhoneThreadLight: Story = { ...LIGHT, render: () => <Workspace width="390px" phonePane="panel" /> };
