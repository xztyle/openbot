import type { FilePreview } from "@openbot/contracts/ipc";
import { Button, Dialog, Download, File, Spinner, X } from "@openbot/ui";
import type { AgentProfile } from "@openbot/ui/data";
import { useText } from "@openbot/ui/text";
import { Loading, lazy, Match, Switch } from "solid-js";

const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));

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
  onClose: () => void;
}) {
  const { t } = useText();
  return (
    <Dialog.Root open onOpenChange={(open) => !open && props.onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay class="file-preview-dialog-backdrop" />
        <Dialog.Content class="file-preview-dialog" data-dialog-surface="unstyled">
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
                    onClose={props.onClose}
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
