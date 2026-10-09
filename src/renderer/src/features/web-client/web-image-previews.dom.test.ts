import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { flush } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWebImagePreviews } from "./web-image-previews";

const image = (id: string, size: number): AttachmentSummary => ({
  id,
  name: `${id}.png`,
  size,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: null,
});

let notify: ((records: Array<{ target: Element; isIntersecting: boolean }>) => void) | undefined;
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (records: Array<{ target: Element; isIntersecting: boolean }>) => void) {
        notify = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.unstubAllGlobals());

function card(id: string): HTMLElement {
  const button = document.createElement("button");
  button.className = "attachment-preview-button";
  button.dataset.attachmentId = id;
  return button;
}

describe("web image previews", () => {
  it("fetches a small image when its card scrolls into view, skips a large one, and revokes on reset", async () => {
    const attachments = new Map([
      ["small", image("small", 1_000)],
      ["large", image("large", 9 * 1024 * 1024)],
    ]);
    const download = vi.fn(async () => ({ name: "small.png", mimeType: "image/png", base64: btoa("png") }));
    const previews = createWebImagePreviews({ download, find: (id) => attachments.get(id), online: () => true });
    const root = document.createElement("div");
    const small = card("small");
    const large = card("large");
    root.append(small, large);
    previews.observe(root);

    notify?.([
      { target: small, isIntersecting: true },
      { target: large, isIntersecting: true },
    ]);
    await vi.waitFor(() => expect(previews.url("small")).not.toBeNull());
    expect(download).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledWith("small");
    expect(previews.url("large")).toBeNull();

    previews.reset();
    flush();
    expect(previews.url("small")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
  });
});
