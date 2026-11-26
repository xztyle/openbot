import type { FilePreview } from "@openbot/contracts/ipc";
import { Button, Dialog, Download, File, Spinner, X } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { useText } from "@openbot/ui/text";
import { Loading, lazy, Match, Switch } from "solid-js";
import type { FilePreviewMeta } from "./FilePreviewPanel";

const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));

/** A swipe goes this far before it closes the viewer or turns to the next file. */
const SWIPE_DISTANCE = 72;
/** Inside these a finger scrolls or plays, so a swipe there is not a gesture of the viewer. */
const OWN_GESTURES =
  "input, textarea, video, audio, .pdf-viewer-rail, .spreadsheet-file-preview, .csv-preview, .file-preview-text";

/** The file that the viewer shows: while it is read, once it is here, or when it cannot be read. */
export type FilePreviewDialogState =
  | { status: "loading"; name: string }
  /** `sourceUrl`: a URL the viewer can point at instead of the bytes, as a desktop attachment has. */
  | { status: "ready"; name: string; preview: FilePreview; sourceUrl?: string | null | undefined }
  | { status: "failed"; name: string; message: string };

/**
 * A file of a message in a viewer over the app, as Slack shows one: a PDF in the browser's viewer,
 * text and code as text, audio and video in a player. It opens at once and says that the file is
 * on its way, so a click never seems to do nothing.
 */
export function FilePreviewDialog(props: {
  state: FilePreviewDialogState;
  agents: AgentProfile[];
  onOpenLink: (url: string) => void;
  onDownload: () => void;
  /** Opens the file in another app. Absent in a browser, which has none. */
  onOpenExternally?: (() => void) | undefined;
  /** Opens an image in the annotator. Absent, or for a file that is not an image, there is no Annotate. */
  onAnnotate?: (() => void) | undefined;
  onClose: () => void;
  meta?: FilePreviewMeta | undefined;
  onCopyLink?: (() => void) | undefined;
  /** Opens one file of an archive in the viewer. */
  onOpenArchiveEntry?: ((path: string) => void) | undefined;
  /** Goes back from a file of an archive to its listing. */
  onBack?: (() => void) | undefined;
  /** The other files of the message. Arrows and a sideways swipe step through them. */
  siblings?: { index: number; count: number; previous: () => void; next: () => void } | undefined;
}) {
  const { t } = useText();
  let swipe: { x: number; y: number; id: number; down: boolean; sideways: boolean } | null = null;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || !props.siblings || props.siblings.count < 2) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "ArrowLeft") props.siblings.previous();
    else if (event.key === "ArrowRight") props.siblings.next();
    else return;
    event.preventDefault();
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || !(event.target instanceof Element)) {
      swipe = null;
      return;
    }
    const content = event.target.closest(".file-preview-content, .pdf-viewer-pages");
    swipe = {
      x: event.clientX,
      y: event.clientY,
      id: event.pointerId,
      // Down closes only from the top of the content, so a scroll back up is not a close.
      down: !content || content.scrollTop <= 0,
      sideways: !event.target.closest(OWN_GESTURES),
    };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = swipe;
    swipe = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (start.down && dy > SWIPE_DISTANCE && Math.abs(dx) < dy / 2) props.onClose();
    else if (
      start.sideways &&
      props.siblings &&
      props.siblings.count > 1 &&
      Math.abs(dx) > SWIPE_DISTANCE &&
      Math.abs(dy) < Math.abs(dx) / 2
    )
      dx < 0 ? props.siblings.next() : props.siblings.previous();
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="file-preview-dialog-backdrop" />
        <Dialog.Content
          class="file-preview-dialog"
          data-dialog-surface="unstyled"
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={() => {
            swipe = null;
          }}
        >
          <Dialog.Title class="sr-only">{props.state.name}</Dialog.Title>
          <Switch>
            <Match when={props.state.status === "ready" && props.state}>
              {(ready) => (
                <Loading fallback={<FileWaiting name={ready().name} onClose={props.onClose} />}>
                  <FilePreviewPanel
                    presentation="dialog"
                    preview={ready().preview}
                    sourceUrl={ready().sourceUrl ?? null}
                    agents={props.agents}
                    readWidth={(fallback) => fallback}
                    onResizeEnd={() => undefined}
                    onResetWidth={() => undefined}
                    readWrapLines={() => false}
                    onWrapLinesChange={() => undefined}
                    defaultWidth={() => 0}
                    maxWidth={() => 0}
                    onWidthChange={() => undefined}
                    onOpenLink={props.onOpenLink}
                    onOpenSharedFile={() => undefined}
                    onOpenExternally={props.onOpenExternally ?? props.onDownload}
                    allowExternalOpen={props.onOpenExternally !== undefined}
                    onDownload={props.onDownload}
                    onAnnotate={props.onAnnotate}
                    onClose={props.onClose}
                    meta={props.meta}
                    onCopyLink={props.onCopyLink}
                    onOpenArchiveEntry={props.onOpenArchiveEntry}
                    onBack={props.onBack}
                    siblings={props.siblings}
                  />
                </Loading>
              )}
            </Match>
            <Match when={props.state.status === "failed" && props.state}>
              {(failed) => (
                <section class="file-preview-panel file-preview-dialog-surface">
                  <FileDialogHeader name={failed().name} onClose={props.onClose} />
                  <div class="file-preview-unsupported" role="alert">
                    <File />
                    <strong>{failed().message}</strong>
                    <Button variant="outline" type="button" onClick={props.onDownload}>
                      <Download aria-hidden="true" />
                      {t("common.download")}
                    </Button>
                  </div>
                </section>
              )}
            </Match>
            <Match when={props.state.status === "loading"}>
              <FileWaiting name={props.state.name} onClose={props.onClose} />
            </Match>
          </Switch>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FileWaiting(props: { name: string; onClose: () => void }) {
  const { t } = useText();
  return (
    <section class="file-preview-panel file-preview-dialog-surface" aria-busy="true">
      <FileDialogHeader name={props.name} onClose={props.onClose} />
      <div class="file-preview-dialog-waiting" role="status">
        <Spinner />
        <span>{t("attachment.opening", { name: props.name })}</span>
      </div>
    </section>
  );
}

function FileDialogHeader(props: { name: string; onClose: () => void }) {
  const { t } = useText();
  return (
    <header class="file-preview-header">
      <File class="file-preview-file-icon" />
      <h2 title={props.name}>{props.name}</h2>
      <Button
        variant="ghost"
        type="button"
        class="browser-toolbar-button"
        aria-label={t("preview.panel.close")}
        data-cuelume-tap="close"
        onClick={props.onClose}
      >
        <X class="browser-toolbar-icon" />
      </Button>
    </header>
  );
}
