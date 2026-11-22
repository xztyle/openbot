import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { createRoot, createSignal, flush } from "solid-js";
import { describe, expect, it } from "vitest";
import { createWebAttachmentMedia } from "./web-attachment-media";

const PHOTO: AttachmentSummary = {
  id: "photo",
  name: "foto.png",
  size: 3,
  kind: "image",
  mimeType: "image/png",
  previewKind: "image",
  previewUrl: null,
};

describe("createWebAttachmentMedia", () => {
  it("reads an image again when the connection that cut its read comes back", async () => {
    const [online, setOnline] = createSignal(true);
    let connected = false;
    let reads = 0;
    const { media, dispose } = createRoot((dispose) => ({
      dispose,
      media: createWebAttachmentMedia(
        {
          download: async () => {
            reads += 1;
            if (!connected) throw new Error("The connection was lost.");
            return { name: PHOTO.name, mimeType: "image/png", base64: "AQID" };
          },
        },
        () => "host",
        { create: () => "blob:photo", revoke: () => {} },
        online,
      ),
    }));
    flush();
    setOnline(false);
    flush();
    expect(await media.load(PHOTO)).toBe(false);
    flush();
    expect(media.failed?.(PHOTO.id)).toBe(true);
    connected = true;
    setOnline(true);
    flush();
    expect(media.failed?.(PHOTO.id)).toBe(false);
    expect(await media.load(PHOTO)).toBe(true);
    flush();
    expect(media.url(PHOTO.id)).toBe("blob:photo");
    expect(reads).toBe(2);
    dispose();
  });
});
