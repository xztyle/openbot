import { describe, expect, it } from "vitest";
import { createWebArtifactThumbnails } from "./web-artifact-thumbnails";

const LIMIT = 120;
const PNG = { name: "thumbnail.png", mimeType: "image/png", base64: "iVBORw0KGgo=" };

function setup() {
  const reads: string[] = [];
  let made = 0;
  const thumbnails = createWebArtifactThumbnails(
    {
      artifactThumbnail: async (artifactId) => {
        reads.push(artifactId);
        return PNG;
      },
    },
    () => "host",
    {
      create: () => {
        made += 1;
        return `blob:${made}`;
      },
      revoke: () => {},
    },
  );
  const record = (id: string) => ({
    id,
    kind: "website" as const,
    source: "site" as const,
    title: id,
    thumbnailVersion: "1",
    createdAt: 0,
    updatedAt: 0,
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Asks for each card in turn and waits until its image is read. */
  const show = async (ids: string[]) => {
    for (const id of ids) {
      thumbnails.url(record(id));
      await settle();
    }
  };
  return { thumbnails, record, reads, show };
}

const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `artifact-${from + index}`);

describe("createWebArtifactThumbnails", () => {
  it("reads an image again when its card shows after the cache let it go", async () => {
    const { thumbnails, record, reads, show } = setup();
    await show(ids(0, LIMIT + 1));
    expect(thumbnails.url(record("artifact-0"))).toBeUndefined();
    await show(["artifact-0"]);
    expect(reads.filter((id) => id === "artifact-0")).toHaveLength(2);
    expect(thumbnails.url(record("artifact-0"))).toBeDefined();
  });

  it("lets the least recently shown image go first", async () => {
    const { thumbnails, record, show } = setup();
    await show(ids(0, LIMIT));
    // The first card shows again, so the second one is now the oldest.
    expect(thumbnails.url(record("artifact-0"))).toBeDefined();
    await show([`artifact-${LIMIT}`]);
    expect(thumbnails.url(record("artifact-0"))).toBeDefined();
    expect(thumbnails.url(record("artifact-1"))).toBeUndefined();
  });
});
