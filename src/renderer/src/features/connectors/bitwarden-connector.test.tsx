import type { BitwardenConnectorStatus, OpenBotDesktopApi } from "@openbot/contracts/ipc";
import { BitwardenConnectorPanel } from "@openbot/ui/features/settings/BitwardenConnectorPanel";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { createBitwardenConnector } from "./bitwarden-connector";

type Port = OpenBotDesktopApi["bitwardenConnector"];

const OFF: BitwardenConnectorStatus = { connected: false };
const ON: BitwardenConnectorStatus = { connected: true };

function stubPort(overrides: Partial<Port> = {}): Port {
  return {
    status: vi.fn(async () => OFF),
    connect: vi.fn(async () => ON),
    disconnect: vi.fn(async () => OFF),
    onChanged: vi.fn(() => () => undefined),
    ...overrides,
  };
}

/** Types a key and presses Connect once the button has taken the key. */
async function connectWith(key: string) {
  fireEvent.input(await screen.findByLabelText("Bitwarden session key"), { target: { value: key } });
  const button = screen.getByRole("button", { name: "Connect Bitwarden" });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

/** The panel on the connector that the Marketplace and Server settings share. */
function renderPanel(port: Port) {
  return render(() => {
    const connector = createBitwardenConnector(() => port);
    return (
      <BitwardenConnectorPanel
        status={connector.status}
        busy={connector.busy}
        statusFailed={connector.statusFailed}
        onConnect={connector.onConnect}
        onDisconnect={connector.onDisconnect}
        onCancel={connector.onCancel}
        onRetryStatus={connector.onRetryStatus}
      />
    );
  });
}

describe("Bitwarden connector panel", () => {
  it("keeps the key that the vault refused, so the user fixes it instead of typing it again", async () => {
    const connect = vi.fn<Port["connect"]>().mockRejectedValueOnce(new Error("Bitwarden refused the key."));
    renderPanel(stubPort({ connect }));
    await connectWith("session-key");

    await waitFor(() => expect(connect).toHaveBeenCalledWith("session-key"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Connect Bitwarden" })).toBeEnabled());
    expect(screen.getByLabelText("Bitwarden session key")).toHaveValue("session-key");
  });

  it("stops a connect that waits and leaves the panel ready for another try", async () => {
    const connect = vi.fn<Port["connect"]>(() => new Promise<BitwardenConnectorStatus>(() => undefined));
    renderPanel(stubPort({ connect }));
    await connectWith("session-key");
    await waitFor(() => expect(connect).toHaveBeenCalled());

    // The field waits with the attempt, and Cancel leaves the panel ready for another try.
    expect(screen.getByLabelText("Bitwarden session key")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByLabelText("Bitwarden session key")).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("asks before it disconnects a connection that stands", async () => {
    const disconnect = vi.fn<Port["disconnect"]>(async () => OFF);
    renderPanel(stubPort({ status: vi.fn(async () => ON), disconnect }));
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Bitwarden" }));

    const confirm = await screen.findByRole("alertdialog");
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Bitwarden" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Disconnect Bitwarden" }),
    );
    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  });

  it("says that the status could not be read instead of Not connected", async () => {
    const status = vi.fn<Port["status"]>().mockRejectedValueOnce(new Error("No answer.")).mockResolvedValue(ON);
    renderPanel(stubPort({ status }));

    expect(await screen.findByText("Could not read status")).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Could not read status")).toBeNull();
  });
});
