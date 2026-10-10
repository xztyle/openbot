import { prefersReducedMotion } from "@openbot/ui/utils";
import { onCleanup, onSettled } from "solid-js";

interface SmoothHeightResizeOptions {
  container: () => HTMLElement | undefined;
  content: () => HTMLElement | undefined;
  enabled?: () => boolean;
  skip?: () => boolean;
}

export function createSmoothHeightResize(options: SmoothHeightResizeOptions): void {
  let animation: Animation | undefined;
  let previousHeight: number | undefined;

  const finishAnimation = (current?: Animation) => {
    if (current && animation !== current) return;
    animation = undefined;
    options.container()?.removeAttribute("data-resizing");
  };

  const cancelAnimation = () => {
    animation?.cancel();
    finishAnimation();
  };

  onSettled(() => {
    const observer = new ResizeObserver(() => {
      const container = options.container();
      const content = options.content();
      if (!container || !content) return;
      const nextHeight = content.getBoundingClientRect().height;
      const previous = previousHeight;
      previousHeight = nextHeight;
      if (
        previous === undefined ||
        previous === nextHeight ||
        options.enabled?.() === false ||
        prefersReducedMotion()
      ) {
        return;
      }
      if (options.skip?.()) {
        cancelAnimation();
        return;
      }

      const animatedHeight = Number.parseFloat(getComputedStyle(container).height);
      const startHeight = animation && Number.isFinite(animatedHeight) ? animatedHeight : previous;
      animation?.cancel();
      container.setAttribute("data-resizing", "true");
      const current = container.animate([{ height: `${startHeight}px` }, { height: `${nextHeight}px` }], {
        ...resizeTiming(),
      });
      animation = current;
      void current.finished.then(() => finishAnimation(current)).catch(() => undefined);
    });
    const content = options.content();
    if (content) observer.observe(content);
    return () => observer.disconnect();
  });

  onCleanup(cancelAnimation);
}

/** One read of the computed style of the root for both values: each read of it can force a recalculation. */
function resizeTiming(): { duration: number; easing: string } {
  const style = getComputedStyle(document.documentElement);
  const value = style.getPropertyValue("--openbot-duration-overlay").trim();
  let duration = 240;
  if (value.endsWith("ms")) duration = Number.parseFloat(value) || 240;
  else if (value.endsWith("s")) duration = (Number.parseFloat(value) || 0.24) * 1_000;
  return {
    duration,
    easing: style.getPropertyValue("--openbot-ease-out").trim() || "cubic-bezier(0.23, 1, 0.32, 1)",
  };
}
