import type { ConnectorAccessState } from "@openbot/contracts/team-protocol/connector-access-v1";
import { ConnectionsSection } from "@openbot/ui/features/workspace/ConnectionsSection";
import { SecretsView } from "@openbot/ui/features/workspace/SecretsView";
import { fn } from "storybook/test";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { NOW } from "./workspace-fixtures";
import { LIGHT, StoryFrame } from "./workspace-story";

const HOUR = 60 * 60_000;

/** One access link in use, and two webhook routines of the space: Hotmart sales and a Stripe one. */
export const CONNECTIONS: ConnectorAccessState = {
  gateway: { listening: true, publicUrl: "https://connect.example.com" },
  tokens: [{ id: "t1", label: "Claude on my phone", createdAt: NOW - 50 * HOUR, lastUsedAt: NOW - 2 * HOUR }],
  inboxes: [
    {
      routeId: "r1",
      ownerKind: "agent",
      ownerId: "a1",
      ownerName: "Data & Money",
      routineName: "Hotmart sale",
      spaceId: "uo",
      scheme: "hotmart",
      hasSecret: true,
      lastEventAt: NOW - HOUR,
      lastStatus: 202,
    },
    {
      routeId: "r2",
      ownerKind: "channel",
      ownerId: "c1",
      ownerName: "nicho-cocina",
      routineName: "Stripe checkout",
      spaceId: "uo",
      scheme: "openbot",
      hasSecret: false,
      lastEventAt: null,
      lastStatus: null,
    },
  ],
};

const view = (width: string, state: ConnectorAccessState) => () => (
  <StoryFrame width={width}>
    <SecretsView
      groups={[]}
      scopes={[]}
      namePattern={/^[A-Z][A-Z0-9_]*$/u}
      onReveal={async () => ""}
      onCopy={async () => undefined}
      onSave={async () => undefined}
      onRemove={async () => undefined}
      footer={
        <ConnectionsSection
          state={state}
          spaceId="uo"
          onCreateToken={async () => ({ token: "atm_x", url: "https://connect.example.com/mcp/atm_x" })}
          onRevokeToken={async () => undefined}
          onSetSender={async () => undefined}
          onCopy={async () => undefined}
        />
      }
    />
  </StoryFrame>
);

const meta = {
  title: "Workspace/Connections",
  component: ConnectionsSection,
  args: {
    state: CONNECTIONS,
    spaceId: "uo",
    onCreateToken: async () => ({ token: "atm_x", url: null }),
    onRevokeToken: fn(),
    onSetSender: fn(),
    onCopy: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionsSection>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Under Secrets: the chat app links, then the webhooks of this space. */
export const Dark: Story = { render: view("720px", CONNECTIONS) };
export const Light: Story = { ...LIGHT, render: view("720px", CONNECTIONS) };
export const Phone: Story = { render: view("390px", CONNECTIONS) };
/** The operator has not opened the connector door yet: links work once it is. */
export const GatewayOff: Story = {
  render: view("390px", { ...CONNECTIONS, gateway: { listening: false, publicUrl: null }, tokens: [], inboxes: [] }),
};
