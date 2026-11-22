/*
 * The image viewer alone, open on the first of two large images, for `scripts/web-phone-gestures-e2e.ts`:
 * a finger drags, pinches and swipes it with no conversation around it.
 */
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { ImageLightbox } from "@openbot/ui/features/conversation/ImageLightbox";
import { render } from "@solidjs/web";
import { StaticI18nProvider } from "../src/i18n-context";
import "../src/styles.css";

function image(id: string, width: number, height: number, hue: number): AttachmentSummary {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><rect width='100%' height='100%' fill='hsl(${hue} 70% 50%)'/></svg>`;
  return {
    id,
    name: `${id}.png`,
    size: 240_000,
    kind: "image",
    mimeType: "image/png",
    previewKind: "image",
    previewUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
  };
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale="en">
        <ImageLightbox
          opening={{ images: [image("first", 1600, 1000, 210), image("second", 1200, 1200, 20)], index: 0 }}
          onDownload={() => undefined}
          onClose={() => document.body.setAttribute("data-lightbox-closed", "")}
        />
      </StaticI18nProvider>
    ),
    root,
  );
