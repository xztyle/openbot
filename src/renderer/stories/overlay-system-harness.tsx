/*
 * The overlays alone, over a page with text and colour, for `scripts/overlay-system-e2e.ts`: a
 * confirmation, a form dialog (a sheet on a phone), an action sheet and the image viewer of a message
 * with images, each behind a button. The script checks that every one dims and blurs the page the
 * same way, traps the focus, locks the scroll, closes on Escape and leaves no copy behind, and that
 * the viewer copies and hands an image to the editor hook.
 *
 * Query: `scheme=light|dark` (dark), `theme=craft|modern|riso` (craft), `locale=en|es` (en).
 */
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { ActionSheet, Bubble, BubbleContent, Button, ConfirmDialog, FormDialog, Input, Toaster } from "@openbot/ui";
import type { AgentMessage } from "@openbot/ui/data";
import { MessageBody } from "@openbot/ui/features/conversation/MessageRendering";
import { render } from "@solidjs/web";
import { createSignal, For } from "solid-js";
import { StaticI18nProvider } from "../src/i18n-context";
import { STORY_AGENTS } from "./fixtures";
import "../src/styles.css";

const query = new URLSearchParams(location.search);
const scheme = query.get("scheme") === "light" ? "light" : "dark";
const theme = (["craft", "modern", "riso"] as const).find((name) => name === query.get("theme")) ?? "craft";
const locale = query.get("locale") === "es" ? "es" : "en";
document.documentElement.dataset.openbotColorScheme = scheme;
document.documentElement.dataset.atelierTheme = theme;

/* Gradients of different sizes, so the gallery has aspect ratios to balance. */
function image(id: string, width: number, height: number, hue: number): AttachmentSummary {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${height}'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='hsl(${hue} 70% 58%)'/><stop offset='1' stop-color='hsl(${hue + 50} 65% 32%)'/></linearGradient></defs><rect width='100%' height='100%' fill='url(#g)'/></svg>`;
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

const IMAGES = [
  image("dashboard", 1600, 1000, 210),
  image("mobile-home", 780, 1688, 280),
  image("chart", 1200, 1200, 20),
];

const MESSAGE: AgentMessage = {
  id: "gallery",
  author: "agent",
  body: "Here are the three screens after the change.",
  time: "10:00",
  attachments: IMAGES,
};

const LINES = Array.from({ length: 40 }, (_, index) => `Line ${index + 1} of the page under the overlay.`);

function Harness() {
  const [confirm, setConfirm] = createSignal(false);
  const [form, setForm] = createSignal(false);
  const [sheet, setSheet] = createSignal(false);
  const noop = () => undefined;
  return (
    <div class="web-app" style={{ "min-height": "100dvh", background: "var(--openbot-bg-canvas)" }}>
      <main style={{ padding: "24px", display: "grid", gap: "16px", "max-width": "720px", margin: "0 auto" }}>
        <div style={{ display: "flex", gap: "8px", "flex-wrap": "wrap" }}>
          <Button variant="secondary" type="button" onClick={() => setConfirm(true)}>
            Open confirm
          </Button>
          <Button variant="secondary" type="button" onClick={() => setForm(true)}>
            Open form
          </Button>
          <Button variant="secondary" type="button" onClick={() => setSheet(true)}>
            Open sheet
          </Button>
        </div>
        <div class="message-entry message-entry-agent">
          <Bubble align="start" variant="muted" data-author="assistant">
            <BubbleContent>
              <MessageBody
                message={MESSAGE}
                agents={STORY_AGENTS}
                onSelectAgent={noop}
                onOpenLink={noop}
                onPreview={noop}
                onAttachmentAction={noop}
                onDownload={noop}
                onAnnotateImage={(attachment, url) => {
                  document.body.dataset.annotated = attachment.id;
                  document.body.dataset.annotatedUrl = url.slice(0, 40);
                }}
              />
            </BubbleContent>
          </Bubble>
        </div>
        <div
          style={{
            height: "160px",
            "border-radius": "16px",
            background: "linear-gradient(120deg, hsl(20 80% 55%), hsl(210 80% 55%))",
          }}
        />
        <For each={LINES}>{(line) => <p style={{ margin: 0, color: "var(--openbot-text-primary)" }}>{line}</p>}</For>
      </main>
      <ConfirmDialog
        open={confirm()}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
        }}
        title="Delete the channel?"
        description="Its messages go with it. People lose it from their lists."
        confirmLabel="Delete"
      />
      <FormDialog
        open={form()}
        onOpenChange={setForm}
        title="New channel"
        description="A place for one topic."
        submitLabel="Create channel"
        onSubmit={() => setForm(false)}
      >
        <Input aria-label="Name" placeholder="Name" />
      </FormDialog>
      <ActionSheet
        open={sheet()}
        onOpenChange={setSheet}
        title="Message actions"
        items={[
          { id: "reply", label: "Reply", onSelect: noop },
          { id: "copy", label: "Copy text", onSelect: noop },
          { id: "delete", label: "Delete", danger: true, onSelect: noop },
        ]}
      />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  render(
    () => (
      <StaticI18nProvider locale={locale}>
        <Harness />
        <Toaster />
      </StaticI18nProvider>
    ),
    root,
  );
