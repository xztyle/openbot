import type { ServerSummary } from "@openbot/contracts/ipc";
import type { ConnectorDetail } from "@openbot/ui/features/connectors/ConnectorDetailPanel";
import { fn } from "storybook/test";
import type { ConnectorController } from "../src/features/connectors/connector-controller";
import {
  type ConnectorRegistry,
  type ConnectorSet,
  createConnectorRegistry,
} from "../src/features/connectors/connector-registry";

const workspace = {
  agents: [],
  connections: [],
  busy: false,
  onConnectWorkspace: fn(),
  onDisconnectWorkspace: fn(),
  onReconnect: fn(),
  onSetEnabled: fn(),
  onAddOrchestrator: fn(),
};

/** GitHub is connected; Slack, Discord and Telegram are not set up. */
export const STORY_CONNECTOR_DETAILS: readonly ConnectorDetail[] = [
  { id: "slack", props: { ...workspace, platform: "slack" } },
  { id: "discord", props: { ...workspace, platform: "discord" } },
  {
    id: "telegram",
    props: {
      agents: [],
      connections: [],
      busy: false,
      onConnectChat: fn(async () => true),
      onDisconnectChat: fn(),
      onReconnect: fn(),
      onSetEnabled: fn(),
      onAddOrchestrator: fn(),
    },
  },
  {
    id: "github",
    props: {
      status: {
        available: true,
        state: "connected",
        login: "octocat",
        avatarUrl: null,
        userCode: null,
        verificationUri: null,
        error: null,
      },
      busy: false,
      repositories: {
        repositories: [
          { fullName: "octocat/hello-world", private: false },
          { fullName: "octocat/private-notes", private: true },
        ],
        total: 2,
      },
      repositoriesError: null,
      onConnect: fn(),
      onCancel: fn(),
      onDisconnect: fn(),
      onOpenVerification: fn(),
      onOpenInstall: fn(),
    },
  },
];

/** A controller over fixed props. Its actions only record the call. */
function storyConnector(detail: ConnectorDetail): ConnectorController {
  return {
    id: detail.id,
    ready: () => true,
    available: () => true,
    busy: () => false,
    detail,
    connect:
      detail.id === "github"
        ? detail.props.onConnect
        : detail.id === "slack" || detail.id === "discord"
          ? detail.props.onConnectWorkspace
          : undefined,
    reload: fn(),
    watch: () => () => undefined,
  };
}

export function storyConnectorSet(details: readonly ConnectorDetail[] = STORY_CONNECTOR_DETAILS): ConnectorSet {
  return Object.fromEntries(details.map((detail) => [detail.id, storyConnector(detail)]));
}

/** The connectors of `server`. Call it inside a component. */
export function storyConnectorRegistry(
  server: ServerSummary | undefined,
  set: ConnectorSet = storyConnectorSet(),
): ConnectorRegistry {
  return createConnectorRegistry(() => server, { computer: set, server: set });
}
