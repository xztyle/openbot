import { attachmentMimeTypeForName, playableMediaKind } from "@openbot/contracts/attachment-files";
import { fileViewKind, hasThumbnailViewKind } from "@openbot/contracts/file-view-kind";
import { type AttachmentSummary, canPreviewAttachment } from "@openbot/contracts/ipc";
import type { AttachmentRenditionKind } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { Button, Download, ExternalLink, LabelTooltip, LabelTooltipTrigger, Play } from "@openbot/ui";
import { createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import {
  AudioAttachmentPreview,
  DocumentAttachmentPreview,
  FileKindIcon,
  VideoAttachmentPreview,
} from "./AttachmentInlinePreviews";
import { attachmentReferenceTone } from "./AttachmentReference";
import { MediaFilePreview } from "./MediaFilePreview";

/**
 * Reads attachments that have no `previewUrl`: the browser client gets none. Absent (desktop), a card
 * shows only what its `previewUrl` gives.
 */
export interface AttachmentMediaSource {
  /** The loaded URL of an attachment. Reactive. */
  url(attachmentId: string): string | undefined;
  /** Loads the file for inline display. Resolves false when it cannot show inline. */
  load(attachment: AttachmentSummary): Promise<boolean>;
  /** An image up to this size loads when its card shows. */
  thumbnailLimit: number;
  /** Audio or video up to this size loads on a click. Above it, the card offers only the download. */
  mediaLimit: number;
  /**
   * Whether an image shows inline in its message, from a small copy that `load` reads. Absent: the
   * image shows as a card.
   */
  inlineImage?(attachment: AttachmentSummary): boolean;
  /** Whether `load` failed for an attachment. Reactive. */
  failed?(attachmentId: string): boolean;
  /** The full-size image for the viewer, once `loadFull` has read it. Reactive. */
  fullUrl?(attachmentId: string): string | undefined;
  /** Reads the full-size image for the viewer. Resolves false when it cannot. */
  loadFull?(attachment: AttachmentSummary): Promise<boolean>;
  /**
   * Reads a file the host makes from the attachment for display (`attachment-renditions-v1`).
   * Absent: the rendition is read from the attachment's `previewUrl`.
   */
  rendition?(
    attachment: AttachmentSummary,
    kind: AttachmentRenditionKind,
    path?: string,
  ): Promise<{ bytes: Uint8Array; mimeType: string } | null>;
  /** A URL that plays the original audio or video as it arrives, without reading it whole first. */
  streamUrl?(attachment: AttachmentSummary): Promise<string | null>;
  /** Names the host, so files kept for one host are not shown for another. */
  cacheKey?(): string;
}

export function AttachmentCards(props: {
  attachments: AttachmentSummary[];
  mediaSource?: AttachmentMediaSource | undefined;
  /** `origin` is the clicked card, for a viewer that zooms out of it. */
  onPreview: (attachment: AttachmentSummary, origin: HTMLElement) => void;
  onAction: (attachment: AttachmentSummary, action: "open" | "reveal" | "download") => void;
}) {
  const { t, format } = useText();
  // An image whose preview does not load was deleted from the host, or never arrived. The card
  // keeps its place in the message and says so, instead of an empty frame.
  const [missing, setMissing] = createSignal<ReadonlySet<string>>(new Set());
  const mediaKind = (attachment: AttachmentSummary) =>
    playableMediaKind(attachment.mimeType || attachmentMimeTypeForName(attachment.name));
  const isMissing = (attachment: AttachmentSummary) => missing().has(attachment.id);
  const markMissing = (attachment: AttachmentSummary) => setMissing((current) => new Set(current).add(attachment.id));
  const [loadingMedia, setLoadingMedia] = createSignal<ReadonlySet<string>>(new Set());
  const [playRequested, setPlayRequested] = createSignal<ReadonlySet<string>>(new Set());
  const sourceUrl = (attachment: AttachmentSummary) =>
    attachment.previewUrl ? undefined : props.mediaSource?.url(attachment.id);
  const imageUrl = (attachment: AttachmentSummary) => attachment.previewUrl ?? sourceUrl(attachment);
  const canLoadMedia = (attachment: AttachmentSummary) =>
    !attachment.previewUrl &&
    Boolean(mediaKind(attachment)) &&
    props.mediaSource !== undefined &&
    attachment.size <= props.mediaSource.mediaLimit &&
    !sourceUrl(attachment);
  const loadMedia = async (attachment: AttachmentSummary) => {
    const source = props.mediaSource;
    if (!source || loadingMedia().has(attachment.id)) return;
    setLoadingMedia((current) => new Set(current).add(attachment.id));
    try {
      if (await source.load(attachment)) setPlayRequested((current) => new Set(current).add(attachment.id));
    } finally {
      setLoadingMedia((current) => {
        const next = new Set(current);
        next.delete(attachment.id);
        return next;
      });
    }
  };

  return (
    <div class="message-attachments">
      <For each={props.attachments}>
        {(attachment) => {
          const source = props.mediaSource;
          if (
            source &&
            !attachment.previewUrl &&
            attachment.previewKind === "image" &&
            attachment.size <= source.thumbnailLimit
          )
            void source.load(attachment);
          const view = fileViewKind(attachment.name, attachment.mimeType);
          const inline = {
            attachment,
            source: props.mediaSource,
            onOpen: props.onPreview,
            onDownload: (file: AttachmentSummary) => props.onAction(file, "download"),
          };
          if (view === "video") return <VideoAttachmentPreview {...inline} />;
          if (view === "audio") return <AudioAttachmentPreview {...inline} />;
          if (hasThumbnailViewKind(view)) return <DocumentAttachmentPreview {...inline} />;
          return (
            <div
              class="message-attachment"
              data-view={view}
              data-media={mediaKind(attachment) ?? undefined}
              data-status={isMissing(attachment) ? "missing" : undefined}
            >
              <Button
                variant="ghost"
                type="button"
                class="attachment-preview-button"
                disabled={isMissing(attachment) || !canPreviewAttachment(attachment)}
                aria-label={t("attachment.preview", { name: attachment.name })}
                data-attachment-id={attachment.id}
                data-cuelume-tap="open"
                onClick={(event) => props.onPreview(attachment, event.currentTarget)}
              >
                <Show
                  when={attachment.previewKind === "image" && imageUrl(attachment) && !isMissing(attachment)}
                  fallback={
                    <span
                      class="attachment-file-visual"
                      data-file-tone={attachmentReferenceTone(attachment.name)}
                      aria-hidden="true"
                    >
                      <Show when={view !== "unknown"} fallback={<AttachmentFileIcon />}>
                        <FileKindIcon kind={view} />
                      </Show>
                    </span>
                  }
                >
                  <span
                    class="attachment-file-visual attachment-file-image"
                    data-file-tone={attachmentReferenceTone(attachment.name)}
                  >
                    <img
                      src={imageUrl(attachment) ?? ""}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      // A loaded copy exists, so its error does not mean that the host lost the file.
                      onError={() => {
                        if (attachment.previewUrl) markMissing(attachment);
                      }}
                    />
                  </span>
                </Show>
                <span class="attachment-file-copy">
                  <strong title={attachment.name}>{attachment.name}</strong>
                  <small>{isMissing(attachment) ? t("attachment.notFound") : format.fileSize(attachment.size)}</small>
                </span>
              </Button>
              <Show when={!isMissing(attachment)}>
                <Show when={canLoadMedia(attachment)}>
                  <Button
                    variant="ghost"
                    type="button"
                    class="attachment-open-button"
                    aria-label={t("attachment.loadMedia", { name: attachment.name })}
                    disabled={loadingMedia().has(attachment.id)}
                    aria-busy={loadingMedia().has(attachment.id) ? "true" : undefined}
                    onClick={() => void loadMedia(attachment)}
                  >
                    <Play />
                  </Button>
                </Show>
                <Button
                  variant="ghost"
                  type="button"
                  class="attachment-open-button"
                  aria-label={t("attachment.download", { name: attachment.name })}
                  onClick={() => props.onAction(attachment, "download")}
                >
                  <Download />
                </Button>
                <LabelTooltip content={t("attachment.openFile")}>
                  <LabelTooltipTrigger
                    as={Button}
                    variant="ghost"
                    type="button"
                    class="attachment-open-button"
                    aria-label={t("attachment.open", { name: attachment.name })}
                    onClick={() => props.onAction(attachment, "open")}
                  >
                    <ExternalLink />
                  </LabelTooltipTrigger>
                </LabelTooltip>
              </Show>
              <Show when={(attachment.previewUrl ?? sourceUrl(attachment)) && !isMissing(attachment)}>
                <MediaFilePreview
                  kind={mediaKind(attachment)}
                  src={attachment.previewUrl ?? sourceUrl(attachment) ?? ""}
                  name={attachment.name}
                  class="attachment-media-player"
                  preload={attachment.previewUrl ? "none" : "metadata"}
                  autoplay={playRequested().has(attachment.id)}
                />
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

export function fileBadge(attachment: AttachmentSummary): string {
  if (attachment.previewKind === "pdf") return "PDF";
  if (attachment.previewKind === "text") return "TXT";
  return attachment.name.split(".").at(-1)?.slice(0, 4).toUpperCase() || "FILE";
}

function AttachmentFileIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M5.5 2.75h5.75l3.25 3.5v11H5.5z" />
      <path d="M11.25 2.75v3.5h3.25M7.75 10h4.5M7.75 13h4.5" />
    </svg>
  );
}
