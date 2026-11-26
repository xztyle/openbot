import { Button, ChevronLeft, ChevronRight, Input, Minus, Plus, Search, Spinner } from "@openbot/ui";
import { createEffect, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { useText } from "../../text";

// pdf.js reads the file in its worker and draws each page on a canvas. Nothing in a PDF runs: the
// display layer here has no scripting, forms or annotations, only the drawn page.
type PdfModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
type PdfDocument = Awaited<ReturnType<PdfModule["getDocument"]>["promise"]>;

let pdfModule: Promise<PdfModule> | undefined;
function loadPdf(): Promise<PdfModule> {
  pdfModule ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(([pdf, worker]) => {
    pdf.GlobalWorkerOptions.workerSrc = worker.default;
    return pdf;
  });
  return pdfModule;
}

/** A page at 100% is this wide at most, so a page on a wide screen reads as a page. */
const PAGE_WIDTH = 880;
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export interface PdfViewerProps {
  /** The file's bytes, or else `url`. */
  bytes?: Uint8Array | null | undefined;
  url?: string | null | undefined;
  name: string;
  /** `slides`: one page at a time with a rail of thumbnails, as a deck shows. */
  layout: "pages" | "slides";
}

/** A PDF, or an Office file the host turned into one: pages to scroll, or slides to step through. */
export default function PdfViewer(props: PdfViewerProps) {
  const { t, format } = useText();
  const [document, setDocument] = createSignal<PdfDocument | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [page, setPage] = createSignal(1);
  const [zoom, setZoom] = createSignal(1);
  const [query, setQuery] = createSignal("");
  const [matches, setMatches] = createSignal<number[] | null>(null);
  const [match, setMatch] = createSignal(0);
  const [width, setWidth] = createSignal(0);
  const [height, setHeight] = createSignal(0);
  let scroller: HTMLDivElement | undefined;
  let root: HTMLDivElement | undefined;
  let texts: Promise<string[]> | null = null;
  const pageCount = () => document()?.numPages ?? 0;
  const slides = () => props.layout === "slides";

  createEffect(
    () => ({ bytes: props.bytes, url: props.url }),
    ({ bytes, url }) => {
      let live = true;
      let task: { destroy(): Promise<void> } | null = null;
      setDocument(null);
      setFailed(false);
      setPage(1);
      texts = null;
      void loadPdf()
        .then((pdf) => {
          // pdf.js takes the buffer it is given, so it gets its own copy.
          const loading = pdf.getDocument(bytes ? { data: new Uint8Array(bytes) } : { url: url ?? "" });
          task = loading;
          if (!live) void loading.destroy();
          return loading.promise;
        })
        .then(
          (opened) => {
            if (live) setDocument(opened);
          },
          () => {
            if (live) setFailed(true);
          },
        );
      return () => {
        live = false;
        void task?.destroy();
      };
    },
  );

  // The viewer's own keys: a listener, so a key anywhere in the viewer steps the slides.
  onSettled(() => {
    const element = root;
    if (!element) return;
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  });

  onSettled(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      setWidth(entry.contentRect.width);
      setHeight(entry.contentRect.height);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  });

  const goTo = (target: number) => {
    const next = Math.min(Math.max(1, target), Math.max(1, pageCount()));
    setPage(next);
    if (!slides()) scroller?.querySelector(`[data-pdf-page="${next}"]`)?.scrollIntoView({ block: "start" });
  };
  const onScroll = () => {
    if (slides() || !scroller) return;
    const top = scroller.getBoundingClientRect().top;
    for (const element of scroller.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
      const box = element.getBoundingClientRect();
      if (box.bottom - top > box.height / 3) {
        setPage(Number(element.dataset.pdfPage));
        return;
      }
    }
  };

  const pageTexts = (opened: PdfDocument) => {
    texts ??= Promise.all(
      Array.from({ length: opened.numPages }, async (_, index) => {
        const content = await (await opened.getPage(index + 1)).getTextContent();
        return content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ")
          .toLocaleLowerCase();
      }),
    );
    return texts;
  };
  const search = async (step: 1 | -1 | 0) => {
    const opened = document();
    const wanted = query().trim().toLocaleLowerCase();
    if (!opened || !wanted) {
      setMatches(null);
      return;
    }
    let found = matches();
    if (step === 0 || !found) {
      const all = await pageTexts(opened);
      found = all.flatMap((text, index) => (text.includes(wanted) ? [index + 1] : []));
      setMatches(found);
      setMatch(0);
      if (found[0]) goTo(found[0]);
      return;
    }
    if (!found.length) return;
    const next = (match() + step + found.length) % found.length;
    setMatch(next);
    goTo(found[next] ?? 1);
  };

  /** Arrows step through slides, and through pages when nothing else on the page takes them. */
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || (slides() && event.key === " ")) {
      if (!slides() && event.key === "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      goTo(page() + 1);
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      if (!slides() && event.key === "ArrowLeft") return;
      event.preventDefault();
      event.stopPropagation();
      goTo(page() - 1);
    }
  };

  const zoomIndex = () => ZOOM_STEPS.indexOf(zoom());
  const pages = createMemo(() => Array.from({ length: pageCount() }, (_, index) => index + 1));

  return (
    <div
      class="pdf-viewer"
      data-layout={props.layout}
      ref={(element) => {
        root = element;
      }}
    >
      <div class="pdf-viewer-toolbar" role="toolbar" aria-label={t("preview.pdf.toolbar")}>
        <Button
          variant="ghost"
          type="button"
          class="browser-toolbar-button"
          aria-label={slides() ? t("preview.pdf.previousSlide") : t("preview.pdf.previousPage")}
          disabled={page() <= 1}
          onClick={() => goTo(page() - 1)}
        >
          <ChevronLeft class="browser-toolbar-icon" />
        </Button>
        <span class="pdf-viewer-page" aria-live="polite">
          {t("preview.pdf.pageOf", { page: format.number(page()), count: format.number(pageCount()) })}
        </span>
        <Button
          variant="ghost"
          type="button"
          class="browser-toolbar-button"
          aria-label={slides() ? t("preview.pdf.nextSlide") : t("preview.pdf.nextPage")}
          disabled={page() >= pageCount()}
          onClick={() => goTo(page() + 1)}
        >
          <ChevronRight class="browser-toolbar-icon" />
        </Button>
        <Show when={!slides()}>
          <Button
            variant="ghost"
            type="button"
            class="browser-toolbar-button"
            aria-label={t("preview.pdf.zoomOut")}
            disabled={zoomIndex() <= 0}
            onClick={() => setZoom(ZOOM_STEPS[Math.max(0, zoomIndex() - 1)] ?? 1)}
          >
            <Minus class="browser-toolbar-icon" />
          </Button>
          <Button
            variant="ghost"
            type="button"
            class="pdf-viewer-zoom"
            aria-label={t("preview.pdf.zoomReset")}
            onClick={() => setZoom(1)}
          >
            {format.number(zoom(), { style: "percent" })}
          </Button>
          <Button
            variant="ghost"
            type="button"
            class="browser-toolbar-button"
            aria-label={t("preview.pdf.zoomIn")}
            disabled={zoomIndex() >= ZOOM_STEPS.length - 1}
            onClick={() => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomIndex() + 1)] ?? 1)}
          >
            <Plus class="browser-toolbar-icon" />
          </Button>
        </Show>
        <div class="pdf-viewer-search">
          <Search class="browser-toolbar-icon" aria-hidden="true" />
          <Input
            type="search"
            value={query()}
            placeholder={t("preview.pdf.search")}
            aria-label={t("preview.pdf.search")}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setMatches(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void search(matches() === null ? 0 : event.shiftKey ? -1 : 1);
            }}
          />
          <Show when={matches()}>
            {(found) => (
              <span class="pdf-viewer-matches" aria-live="polite">
                {found().length
                  ? t("preview.pdf.matchOf", {
                      match: format.number(match() + 1),
                      count: format.number(found().length),
                    })
                  : t("preview.pdf.noMatches")}
              </span>
            )}
          </Show>
        </div>
      </div>
      <div class="pdf-viewer-body">
        <Show when={slides() && document()}>
          {(opened) => (
            <nav class="pdf-viewer-rail" aria-label={t("preview.pdf.slides")}>
              <For each={pages()}>
                {(number) => (
                  <Button
                    variant="ghost"
                    type="button"
                    class="pdf-viewer-thumb"
                    aria-label={t("preview.pdf.goToSlide", { page: format.number(number) })}
                    aria-current={page() === number ? "true" : undefined}
                    onClick={() => goTo(number)}
                  >
                    <PdfPageCanvas document={opened()} page={number} width={120} lazy />
                  </Button>
                )}
              </For>
            </nav>
          )}
        </Show>
        <div
          class="pdf-viewer-pages"
          ref={(element) => {
            scroller = element;
          }}
          tabindex="0"
          onScroll={onScroll}
        >
          <Show
            when={document()}
            fallback={
              <div class="pdf-viewer-status" role={failed() ? "alert" : "status"}>
                <Show when={failed()} fallback={<Spinner />}>
                  {t("preview.pdf.failed")}
                </Show>
              </div>
            }
          >
            {(opened) => (
              <Show
                when={slides()}
                fallback={
                  <For each={pages()}>
                    {(number) => (
                      <div class="pdf-viewer-page-frame" data-pdf-page={number}>
                        <PdfPageCanvas
                          document={opened()}
                          page={number}
                          width={Math.max(200, Math.min(width() - 24, PAGE_WIDTH) * zoom())}
                          lazy
                        />
                      </div>
                    )}
                  </For>
                }
              >
                <div class="pdf-viewer-slide" data-pdf-page={page()}>
                  <PdfPageCanvas
                    document={opened()}
                    page={page()}
                    width={Math.max(200, width() - 24)}
                    maxHeight={Math.max(160, height() - 24)}
                  />
                </div>
              </Show>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

/** One page drawn at `width` CSS pixels, sharp on the screen's pixel ratio. `lazy` waits until it shows. */
function PdfPageCanvas(props: {
  document: PdfDocument;
  page: number;
  width: number;
  maxHeight?: number | undefined;
  lazy?: boolean;
}) {
  const [visible, setVisible] = createSignal(!untrack(() => props.lazy));
  const [ratio, setRatio] = createSignal(Math.SQRT2);
  const [drawn, setDrawn] = createSignal(false);
  let frame: HTMLDivElement | undefined;
  onSettled(() => {
    if (!frame || visible()) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px" },
    );
    observer.observe(frame);
    return () => observer.disconnect();
  });
  createEffect(
    () => ({ document: props.document, page: props.page, width: props.width, max: props.maxHeight, on: visible() }),
    ({ document, page, width, max, on }) => {
      const holder = frame;
      if (!on || !holder || width <= 0) return;
      let task: { cancel(): void; promise: Promise<void> } | null = null;
      let live = true;
      // A new canvas for each drawing: pdf.js refuses a canvas that a cancelled drawing still holds.
      const target = window.document.createElement("canvas");
      void document.getPage(page).then((loaded) => {
        if (!live) return;
        const base = loaded.getViewport({ scale: 1 });
        setRatio(base.height / base.width);
        const fit = max ? Math.min(width / base.width, max / base.height) : width / base.width;
        const pixels = window.devicePixelRatio || 1;
        const viewport = loaded.getViewport({ scale: fit * pixels });
        target.width = Math.floor(viewport.width);
        target.height = Math.floor(viewport.height);
        target.style.width = `${Math.floor(viewport.width / pixels)}px`;
        target.style.height = `${Math.floor(viewport.height / pixels)}px`;
        task = loaded.render({ canvas: target, viewport });
        task.promise.then(
          () => {
            if (!live) return;
            holder.replaceChildren(target);
            setDrawn(true);
          },
          () => undefined,
        );
      });
      return () => {
        live = false;
        task?.cancel();
      };
    },
  );
  return (
    <div
      class="pdf-page"
      ref={(element) => {
        frame = element;
      }}
      style={{ "min-height": drawn() ? undefined : `${Math.round(props.width * ratio())}px` }}
    />
  );
}
