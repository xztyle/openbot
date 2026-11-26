/*
 * The web client on the media host (`ChannelMedia`), for `scripts/web-image-annotator-e2e.ts`. Every
 * file the reader attaches goes up as a draft at once, and `window.harnessImageUploads` lists each
 * one with its size and, for an image, its pixel size: the check compares an annotated image with
 * the original. `visual.appearance` in localStorage picks light or dark, as the visual harness does.
 */
import type { AppAppearance } from "@openbot/contracts/app-appearance";
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { syncColorScheme } from "../src/color-scheme";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { ChannelMedia } from "./WebWorkspace.stories";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

export interface HarnessImageUpload {
  name: string;
  type: string;
  size: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    harnessImageUploads?: HarnessImageUpload[];
  }
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
const APPEARANCE: AppAppearance =
  (["light", "dark", "system"] as const).find((value) => value === stored("visual.appearance")) ?? "light";

syncColorScheme(() => APPEARANCE);

const media = ChannelMedia.args?.createRuntime;
const runtime: WebRuntimeFactory = (...args) => {
  if (!media) throw new Error("The ChannelMedia story has no runtime.");
  const uploads: HarnessImageUpload[] = [];
  window.harnessImageUploads = uploads;
  return {
    ...media(...args),
    upload: async (file: File) => {
      let width = 0;
      let height = 0;
      if (file.type.startsWith("image/")) {
        const bitmap = await createImageBitmap(file).catch(() => null);
        width = bitmap?.width ?? 0;
        height = bitmap?.height ?? 0;
        bitmap?.close();
      }
      uploads.push({ name: file.name, type: file.type, size: file.size, width, height });
      return {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        kind: file.type.startsWith("image/") ? "image" : "file",
        mimeType: file.type || "application/octet-stream",
        previewKind: "none",
        previewUrl: null,
      };
    },
    discard: async () => {},
  };
};
const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <div class="web-app">
          <Toaster />
          <WebWorkspace
            accountId="preview-account"
            accountEmail="you@example.com"
            accountName="Preview User"
            accountFetch={fetch}
            onSessionCheck={async () => {}}
            onLogout={async () => {}}
            createRuntime={runtime}
            language="system"
            onChangeLanguage={() => {}}
            appearance={APPEARANCE}
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
