import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebFileSaver, SAVED_FILE_URL_MS } from "./web-file-download";

describe("createWebFileSaver", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("revokes a saved file's URL a while after its click, not only at sign-out", () => {
    vi.useFakeTimers();
    const revoked: string[] = [];
    let made = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      made += 1;
      return `blob:file-${made}`;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => revoked.push(url));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const dispose = createRoot((dispose) => {
      const save = createWebFileSaver();
      save({ name: "informe café.pdf", base64: "AQID" });
      return dispose;
    });
    vi.advanceTimersByTime(SAVED_FILE_URL_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(["blob:file-1"]);
    dispose();
    expect(revoked).toEqual(["blob:file-1"]);
  });
});
