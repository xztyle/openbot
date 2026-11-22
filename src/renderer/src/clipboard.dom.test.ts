import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardTextLater } from "./clipboard";

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function stubClipboard(clipboard: {
  write?: (items: FakeClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}) {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("writeClipboardTextLater", () => {
  it("starts the write before the text arrives, so Safari keeps the tap", async () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const written: FakeClipboardItem[] = [];
    const write = vi.fn(async (items: FakeClipboardItem[]) => {
      written.push(...items);
      await items[0]?.items["text/plain"];
    });
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard({ write, writeText });
    let resolve: (value: string) => void = () => undefined;
    const text = new Promise<string>((done) => {
      resolve = done;
    });

    const copied = writeClipboardTextLater(text);
    // The clipboard is asked while the secret is still being read.
    expect(write).toHaveBeenCalledTimes(1);
    resolve("s3cret");
    await copied;

    expect(await written[0]?.items["text/plain"]?.then((blob) => blob.text())).toBe("s3cret");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("falls back to a plain write when the browser refuses the item", async () => {
    vi.stubGlobal("ClipboardItem", FakeClipboardItem);
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard({
      write: vi.fn(async () => {
        throw new DOMException("denied", "NotAllowedError");
      }),
      writeText,
    });

    await writeClipboardTextLater(Promise.resolve("token"));

    expect(writeText).toHaveBeenCalledWith("token");
  });

  it("throws the read's own failure", async () => {
    vi.stubGlobal("ClipboardItem", undefined);
    const writeText = vi.fn(async (_text: string) => undefined);
    stubClipboard({ writeText });
    const failure = new Error("read failed");

    await expect(writeClipboardTextLater(Promise.reject(failure))).rejects.toBe(failure);
    expect(writeText).not.toHaveBeenCalled();
  });
});
