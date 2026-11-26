import { attachmentFileExtension } from "@openbot/contracts/attachment-files";
import { type FileViewKind, fileViewKind } from "@openbot/contracts/file-view-kind";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import type { AudioWaveform } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import {
  Archive,
  AudioLines,
  Button,
  Code,
  Download,
  File,
  FileText,
  Film,
  Maximize2,
  Pause,
  Play,
  Presentation,
  Table2,
} from "@openbot/ui";
import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import type { AttachmentMediaSource } from "./AttachmentCards";
import { audioWaveform, thumbnailUrl } from "./attachment-renditions";

interface InlineProps {
  attachment: AttachmentSummary;
  source: AttachmentMediaSource | undefined;
  /** Opens the file in the viewer. `origin` is the clicked element. */
  onOpen: (attachment: AttachmentSummary, origin: HTMLElement) => void;
  onDownload: (attachment: AttachmentSummary) => void;
}

/** The icon of a kind of file, for a card that has no picture. */
export function FileKindIcon(props: { kind: FileViewKind; class?: string }): JSX.Element {
  switch (props.kind) {
    case "video":
      return <Film class={props.class} aria-hidden="true" />;
    case "audio":
      return <AudioLines class={props.class} aria-hidden="true" />;
    case "slides":
      return <Presentation class={props.class} aria-hidden="true" />;
    case "sheet":
    case "csv":
      return <Table2 class={props.class} aria-hidden="true" />;
    case "archive":
      return <Archive class={props.class} aria-hidden="true" />;
    case "code":
      return <Code class={props.class} aria-hidden="true" />;
    case "pdf":
    case "document":
    case "markdown":
      return <FileText class={props.class} aria-hidden="true" />;
    default:
      return <File class={props.class} aria-hidden="true" />;
  }
}

/** The short type label on a card: PDF, PPTX, ZIP. */
export function fileTypeLabel(name: string): string {
  return (attachmentFileExtension(name) ?? "file").slice(0, 5).toUpperCase();
}

/** A thumbnail of the first page, slide or frame, once the host has made it. */
function useThumbnail(props: () => { attachment: AttachmentSummary; source: AttachmentMediaSource | undefined }) {
  const [url, setUrl] = createSignal<string | null>(null);
  const [broken, setBroken] = createSignal(false);
  createEffect(props, ({ attachment, source }) => {
    let live = true;
    setUrl(null);
    setBroken(false);
    void thumbnailUrl(attachment, source).then((made) => {
      if (live) setUrl(made);
    });
    return () => {
      live = false;
    };
  });
  return { url: () => (broken() ? null : url()), fail: () => setBroken(true) };
}

/** The playable URL of an audio or video file: its own URL, a stream from the host, or a loaded copy. */
async function playableUrl(attachment: AttachmentSummary, source: AttachmentMediaSource | undefined) {
  if (attachment.previewUrl) return attachment.previewUrl;
  if (!source) return null;
  const stream = await source.streamUrl?.(attachment).catch(() => null);
  if (stream) return stream;
  if (attachment.size > source.mediaLimit) return null;
  return (await source.load(attachment)) ? (source.url(attachment.id) ?? null) : null;
}

function CardMeta(props: { attachment: AttachmentSummary; label?: string | undefined }) {
  const { format } = useText();
  return (
    <span class="attachment-file-copy">
      <strong title={props.attachment.name}>{props.attachment.name}</strong>
      <small>
        <Show when={props.label}>{(label) => <span class="attachment-type-label">{label()} · </span>}</Show>
        {format.fileSize(props.attachment.size)}
      </small>
    </span>
  );
}

function DownloadButton(props: { attachment: AttachmentSummary; onDownload: (attachment: AttachmentSummary) => void }) {
  const { t } = useText();
  return (
    <Button
      variant="ghost"
      type="button"
      class="attachment-open-button"
      aria-label={t("attachment.download", { name: props.attachment.name })}
      onClick={() => props.onDownload(props.attachment)}
    >
      <Download />
    </Button>
  );
}

/** A video: its first frame with a play button. It plays in the message; the viewer enlarges it. */
export function VideoAttachmentPreview(props: InlineProps) {
  const { t } = useText();
  const thumbnail = useThumbnail(() => ({ attachment: props.attachment, source: props.source }));
  const [src, setSrc] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const play = async () => {
    if (loading()) return;
    setLoading(true);
    const url = await playableUrl(props.attachment, props.source);
    setLoading(false);
    if (url) setSrc(url);
    else setFailed(true);
  };
  return (
    <div class="message-attachment attachment-rich" data-view="video">
      <div class="attachment-video-frame">
        <Show
          when={src()}
          fallback={
            <Button
              variant="ghost"
              type="button"
              class="attachment-poster-button attachment-preview-button"
              data-attachment-id={props.attachment.id}
              aria-label={t("attachment.play", { name: props.attachment.name })}
              aria-busy={loading() ? "true" : undefined}
              disabled={failed()}
              onClick={() => void play()}
            >
              <Show when={thumbnail.url()} fallback={<Film class="attachment-poster-icon" aria-hidden="true" />}>
                {(url) => (
                  <img class="attachment-rendition" src={url()} alt="" decoding="async" onError={thumbnail.fail} />
                )}
              </Show>
              <span class="attachment-play-badge" aria-hidden="true">
                <Play />
              </span>
            </Button>
          }
        >
          {(url) => (
            <video class="attachment-video-player" src={url()} controls autoplay playsinline preload="metadata">
              <track kind="captions" />
            </video>
          )}
        </Show>
      </div>
      <div class="attachment-rich-footer">
        <CardMeta attachment={props.attachment} label={failed() ? t("attachment.cannotPlay") : undefined} />
        <Button
          variant="ghost"
          type="button"
          class="attachment-open-button"
          aria-label={t("attachment.enlarge", { name: props.attachment.name })}
          onClick={(event) => props.onOpen(props.attachment, event.currentTarget)}
        >
          <Maximize2 />
        </Button>
        <DownloadButton attachment={props.attachment} onDownload={props.onDownload} />
      </div>
    </div>
  );
}

const FLAT_WAVEFORM: AudioWaveform = { peaks: Array.from({ length: 48 }, () => 0.35), duration: 0 };

/** An audio file: play and pause, its waveform as the progress bar, and the time. */
export function AudioAttachmentPreview(props: InlineProps) {
  const { t } = useText();
  const [waveform, setWaveform] = createSignal<AudioWaveform>(FLAT_WAVEFORM);
  const [playing, setPlaying] = createSignal(false);
  const [position, setPosition] = createSignal(0);
  const [duration, setDuration] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let audio: HTMLAudioElement | undefined;
  createEffect(
    () => ({ attachment: props.attachment, source: props.source }),
    ({ attachment, source }) => {
      let live = true;
      void audioWaveform(attachment, source).then((made) => {
        if (live && made) setWaveform(made);
      });
      return () => {
        live = false;
      };
    },
  );
  // Fewer bars on a narrow card keep each bar visible.
  const bars = createMemo(() => {
    const peaks = waveform().peaks;
    const count = 48;
    return Array.from({ length: count }, (_, index) => peaks[Math.floor((index / count) * peaks.length)] ?? 0);
  });
  const total = () => duration() || waveform().duration;
  const progress = () => (total() > 0 ? Math.min(1, position() / total()) : 0);
  const clock = (seconds: number) => {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  };
  const ensureSource = async () => {
    if (!audio) return false;
    if (audio.src) return true;
    setLoading(true);
    const url = await playableUrl(props.attachment, props.source);
    setLoading(false);
    if (!url) {
      setFailed(true);
      return false;
    }
    audio.src = url;
    return true;
  };
  const toggle = async () => {
    if (!audio) return;
    if (playing()) return audio.pause();
    if (await ensureSource()) void audio.play().catch(() => setFailed(true));
  };
  const seek = async (event: MouseEvent & { currentTarget: HTMLElement }) => {
    const box = event.currentTarget.getBoundingClientRect();
    const share = Math.min(1, Math.max(0, (event.clientX - box.left) / Math.max(1, box.width)));
    if (!audio || !(await ensureSource())) return;
    const length = audio.duration || total();
    if (length > 0) audio.currentTime = share * length;
    if (!playing()) void audio.play().catch(() => setFailed(true));
  };
  return (
    <div class="message-attachment attachment-rich" data-view="audio">
      <div class="attachment-audio">
        <Button
          variant="ghost"
          type="button"
          class="attachment-audio-toggle"
          data-attachment-id={props.attachment.id}
          aria-label={
            playing()
              ? t("attachment.pause", { name: props.attachment.name })
              : t("attachment.play", { name: props.attachment.name })
          }
          aria-busy={loading() ? "true" : undefined}
          disabled={failed()}
          onClick={() => void toggle()}
        >
          <Show when={playing()} fallback={<Play />}>
            <Pause />
          </Show>
        </Button>
        <Button
          variant="ghost"
          type="button"
          class="attachment-waveform"
          aria-label={t("attachment.seek", { name: props.attachment.name })}
          onClick={(event) => void seek(event)}
        >
          <For each={bars()}>
            {(peak, index) => (
              <span
                class="attachment-waveform-bar"
                data-played={index() / bars().length < progress() ? "true" : undefined}
                style={{ height: `${Math.round(12 + peak * 88)}%` }}
              />
            )}
          </For>
        </Button>
        <span class="attachment-audio-time">{playing() || position() > 0 ? clock(position()) : clock(total())}</span>
        <audio
          ref={(element) => {
            audio = element;
          }}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setPosition(0);
          }}
          onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)}
          onError={() => {
            if (audio?.src) setFailed(true);
          }}
        >
          <track kind="captions" />
        </audio>
      </div>
      <div class="attachment-rich-footer">
        <CardMeta attachment={props.attachment} label={failed() ? t("attachment.cannotPlay") : undefined} />
        <Button
          variant="ghost"
          type="button"
          class="attachment-open-button"
          aria-label={t("attachment.enlarge", { name: props.attachment.name })}
          onClick={(event) => props.onOpen(props.attachment, event.currentTarget)}
        >
          <Maximize2 />
        </Button>
        <DownloadButton attachment={props.attachment} onDownload={props.onDownload} />
      </div>
    </div>
  );
}

/**
 * A PDF, slide deck, document or spreadsheet: a picture of its first page, its type and size. A tap
 * opens the viewer.
 */
export function DocumentAttachmentPreview(props: InlineProps) {
  const { t } = useText();
  const kind = createMemo(() => fileViewKind(props.attachment.name, props.attachment.mimeType));
  const thumbnail = useThumbnail(() => ({ attachment: props.attachment, source: props.source }));
  return (
    <div class="message-attachment attachment-rich" data-view={kind()}>
      <Button
        variant="ghost"
        type="button"
        class="attachment-page-button attachment-preview-button"
        data-attachment-id={props.attachment.id}
        data-view={kind()}
        aria-label={t("attachment.preview", { name: props.attachment.name })}
        data-cuelume-tap="open"
        onClick={(event) => props.onOpen(props.attachment, event.currentTarget)}
      >
        <Show
          when={thumbnail.url()}
          fallback={
            <span class="attachment-page-placeholder" aria-hidden="true">
              <FileKindIcon kind={kind()} />
            </span>
          }
        >
          {(url) => <img class="attachment-rendition" src={url()} alt="" decoding="async" onError={thumbnail.fail} />}
        </Show>
        <span class="attachment-type-badge" data-view={kind()} aria-hidden="true">
          {fileTypeLabel(props.attachment.name)}
        </span>
      </Button>
      <div class="attachment-rich-footer">
        <CardMeta attachment={props.attachment} />
        <DownloadButton attachment={props.attachment} onDownload={props.onDownload} />
      </div>
    </div>
  );
}
