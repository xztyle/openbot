import { Button } from "@openbot/ui";
import { createSignal, Show } from "solid-js";
import { useText } from "../../text";

const SPEEDS = [1, 1.25, 1.5, 2, 0.5, 0.75];

export function MediaFilePreview(props: {
  kind: "audio" | "video" | null;
  src: string;
  name: string;
  class?: string;
  preload?: "none" | "metadata";
  /** Plays at once: the user asked for it with the click that loaded the file. */
  autoplay?: boolean;
  /** A playback speed button under the player, for the viewer. */
  speedControl?: boolean;
}) {
  const { t, format } = useText();
  const [speed, setSpeed] = createSignal(1);
  let media: HTMLMediaElement | undefined;
  const nextSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed()) + 1) % SPEEDS.length] ?? 1;
    setSpeed(next);
    if (media) media.playbackRate = next;
  };
  const keep = (element: HTMLMediaElement) => {
    media = element;
  };
  return (
    <>
      <Show when={props.kind === "audio"}>
        <audio
          ref={keep}
          class={props.class}
          controls
          autoplay={props.autoplay}
          preload={props.preload}
          src={props.src}
          aria-label={props.name}
        >
          {/* Local files do not provide caption tracks. */}
          <track kind="captions" />
        </audio>
      </Show>
      <Show when={props.kind === "video"}>
        <video
          ref={keep}
          class={props.class}
          controls
          playsinline
          autoplay={props.autoplay}
          preload={props.preload}
          src={props.src}
          aria-label={props.name}
        >
          <track kind="captions" />
        </video>
      </Show>
      <Show when={props.speedControl && props.kind}>
        <div class="media-preview-controls">
          <Button
            variant="outline"
            type="button"
            class="media-preview-speed"
            aria-label={t("preview.media.speed", { speed: format.number(speed()) })}
            onClick={nextSpeed}
          >
            {t("preview.media.speedValue", { speed: format.number(speed()) })}
          </Button>
        </div>
      </Show>
    </>
  );
}
