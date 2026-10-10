import { PublishAgentDialog } from "@openbot/ui/features/agents/PublishAgentDialog";
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { STORY_AGENT_TEMPLATE_PUBLICATION, storyAgentTemplatePreview } from "../../preview/agent-template-fixtures";

function renderPublished(onUnpublish: () => Promise<void>) {
  return render(() => (
    <PublishAgentDialog
      open
      onOpenChange={vi.fn()}
      preview={storyAgentTemplatePreview("dr-eggbot", STORY_AGENT_TEMPLATE_PUBLICATION)}
      loading={false}
      onPublish={vi.fn(async () => undefined)}
      onUnpublish={onUnpublish}
      onCopyLink={vi.fn(async () => undefined)}
    />
  ));
}

describe("PublishAgentDialog", () => {
  it("states what is published and who can open the link", async () => {
    renderPublished(vi.fn(async () => undefined));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Its instructions, skills and routines are published\./)).toBeVisible();
    expect(within(dialog).getByText(/Anyone who has the link can read this/)).toBeVisible();
  });

  it("asks before it unpublishes and says what that does to the link", async () => {
    const onUnpublish = vi.fn(async () => undefined);
    renderPublished(onUnpublish);

    await fireEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
    const question = await screen.findByRole("alertdialog");
    expect(within(question).getByText(/The link stops working for everyone who has it\./)).toBeInTheDocument();
    expect(onUnpublish).not.toHaveBeenCalled();

    await fireEvent.click(within(question).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(onUnpublish).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole("button", { name: "Unpublish" }));
    await fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Unpublish" }));
    await waitFor(() => expect(onUnpublish).toHaveBeenCalledOnce());
  });

  it("keeps the question open and shows the reason when unpublishing fails", async () => {
    const onUnpublish = vi.fn(async () => {
      throw new Error("The server is not reachable.");
    });
    renderPublished(onUnpublish);

    await fireEvent.click(await screen.findByRole("button", { name: "Unpublish" }));
    const question = await screen.findByRole("alertdialog");
    await fireEvent.click(within(question).getByRole("button", { name: "Unpublish" }));
    expect(await within(question).findByText("The server is not reachable.")).toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
