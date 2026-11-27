import type { AgentMailboxesState } from "@openbot/contracts/team-protocol/agent-mailboxes-v1";
import { SecretsVault } from "@openbot/ui/features/secrets/SecretsVault";
import { MailboxesSection } from "@openbot/ui/features/workspace/MailboxesSection";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { NOW } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const HOUR = 60 * 60_000;
const AGENTS = [
  { id: "a1", name: "Lucía" },
  { id: "a2", name: "Data & Money" },
];

/** The Worker is linked, and two addresses of the space go to Lucía. */
export const MAILBOXES: AgentMailboxesState = {
  gateway: { listening: true, publicUrl: "https://connect.example.com" },
  inboxUrl: "https://connect.example.com/hooks/mail_3f9a",
  workerUrl: "https://atelier-mail.example.workers.dev",
  hasSecret: true,
  lastMailAt: NOW - HOUR,
  lastStatus: 202,
  mailboxes: [
    {
      id: "m1",
      address: "ventas@aprendivo.com",
      displayName: "Lucía de Aprendivo",
      agentId: "a1",
      agentName: "Lucía",
      spaceId: "uo",
      mode: "reply",
      createdAt: NOW - 50 * HOUR,
      lastMailAt: NOW - HOUR,
      received: 14,
      sentToday: 3,
      ownerApprovesEverySend: false,
    },
    {
      id: "m2",
      address: "hola@aprendivo.com",
      displayName: "",
      agentId: "a1",
      agentName: "Lucía",
      spaceId: "uo",
      mode: "write-first",
      createdAt: NOW - 20 * HOUR,
      lastMailAt: null,
      received: 0,
      sentToday: 0,
      ownerApprovesEverySend: true,
    },
  ],
};

const view = (width: string, state: AgentMailboxesState) => () => (
  <StoryFrame width={width}>
    <SecretsVault
      overview={{ secrets: [], trash: [], requests: [] }}
      agents={[]}
      spaces={[]}
      owner
      call={async () => ({ kind: "done" })}
      copyValue={async () => undefined}
      refresh={() => undefined}
      footer={
        <MailboxesSection
          state={state}
          spaceId="uo"
          agents={AGENTS}
          onSave={async () => undefined}
          onRemove={async () => undefined}
          onSetWorker={async () => undefined}
          onNewSecret={async () => "ams_example"}
          onCopy={async () => undefined}
        />
      }
    />
  </StoryFrame>
);

const meta = {
  title: "Workspace/Mailboxes",
  component: MailboxesSection,
  args: {
    state: MAILBOXES,
    spaceId: "uo",
    agents: AGENTS,
    onSave: fn(),
    onRemove: fn(),
    onSetWorker: fn(),
    onNewSecret: async () => "ams_example",
    onCopy: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MailboxesSection>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Under Secrets, after the connections: the Worker link, then the addresses of this space. */
export const Dark: Story = { render: view("720px", MAILBOXES) };
export const Light: Story = { ...LIGHT, render: view("720px", MAILBOXES) };
export const Phone: Story = { render: view("390px", MAILBOXES) };
/** Nothing set up yet: the gateway is off and no Worker is linked. */
export const NotSetUp: Story = {
  render: view("390px", {
    ...MAILBOXES,
    gateway: { listening: false, publicUrl: null },
    inboxUrl: null,
    workerUrl: null,
    hasSecret: false,
    lastMailAt: null,
    mailboxes: [],
  }),
};
