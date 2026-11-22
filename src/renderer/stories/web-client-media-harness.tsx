/*
 * The web client on a mock host whose #general has images, a PDF and a CSV, read through the host
 * connection as the browser client reads them: the `ChannelMedia` story, for `scripts/web-media-e2e.ts`.
 * A file the reader attaches uploads as a draft at once, and `window.harnessUploads` lists the names
 * of the files that went up.
 */
import { Toaster } from "@openbot/ui";
import { render } from "@solidjs/web";
import { WebWorkspace } from "../src/features/web-client/WebWorkspace";
import type { WebRuntimeFactory } from "../src/features/web-client/web-client-context";
import { StaticI18nProvider } from "../src/i18n-context";
import { ChannelMedia } from "./WebWorkspace.stories";
import "../src/styles.css";
import "../src/features/web-client/web-client.css";

declare global {
  interface Window {
    harnessUploads?: string[];
  }
}

const media = ChannelMedia.args?.createRuntime;
const runtime: WebRuntimeFactory = (...args) => {
  if (!media) throw new Error("The ChannelMedia story has no runtime.");
  const uploads: string[] = [];
  window.harnessUploads = uploads;
  return {
    ...media(...args),
    upload: async (file: File) => {
      uploads.push(file.name);
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
            appearance="light"
            onChangeAppearance={() => {}}
          />
        </div>
      </StaticI18nProvider>
    ),
    root,
  );
