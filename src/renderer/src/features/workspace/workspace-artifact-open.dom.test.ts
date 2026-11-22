import { toast } from "@openbot/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ArtifactOpener, openArtifact } from "./workspace-artifact-open";

function workspace(openAttachment: () => Promise<void>, fileActions: "native" | "browser" = "native"): ArtifactOpener {
  return {
    artifacts: { artifacts: () => [] },
    artifactRecord: () => ({ file: { id: "file-1", name: "plan.pdf", size: 10, mimeType: "application/pdf" } }),
    channels: { port: () => ({ openUrl: async () => undefined, fileActions, agent: { openAttachment } }) },
  };
}

let toastError = vi.fn();
beforeEach(() => {
  toastError = vi.fn(() => "toast");
  vi.spyOn(toast, "error").mockImplementation(toastError);
});

describe("openArtifact", () => {
  it("says when the file does not open", async () => {
    openArtifact(
      workspace(() => Promise.reject(new TypeError("Cannot read properties of undefined"))),
      "artifact-1",
    );
    await vi.waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Could not open or save this attachment. Try again.");
  });

  it("stays quiet when it opens", async () => {
    const open = vi.fn(async () => undefined);
    openArtifact(workspace(open), "artifact-1");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalled();
  });

  it("shows the file in the viewer on a browser", () => {
    const open = vi.fn(async () => undefined);
    const view = vi.fn();
    openArtifact(workspace(open, "browser"), "artifact-1", undefined, view);
    expect(view).toHaveBeenCalledWith(expect.objectContaining({ id: "file-1", previewKind: "pdf" }));
    expect(open).not.toHaveBeenCalled();
  });
});
