import { useEffect, useRef, useState, type RefObject } from "react";
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import s from "./FilePreview.module.css";

GlobalWorkerOptions.workerSrc = workerUrl;
const RESIDENT_PAGES = 3, CANVAS_PIXELS = 8_000_000;

/** Canvas-only PDF.js: local private bytes, no annotation/forms/scripts/action layer. */
export function FilePdfPreview({ blob }: { blob: Blob }) {
  const [loaded, setLoaded] = useState<{ blob: Blob; document: PDFDocumentProxy } | null>(null);
  const [failure, setFailure] = useState<{ blob: Blob; text: string } | null>(null);
  useEffect(() => {
    let cancelled = false, task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        // PDF.js 6 does not compile glyphs with eval. No external font/CMap URLs
        // or document-provided links/actions are ever passed to the renderer.
        task = getDocument({ data, enableXfa: false, useWasm: false, useWorkerFetch: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true, maxImageSize: 20_000_000, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
        const document = await task.promise;
        if (!cancelled) setLoaded({ blob, document });
      } catch { if (!cancelled) setFailure({ blob, text: "Не удалось открыть PDF. Файл можно скачать." }); }
    })();
    return () => { cancelled = true;void task?.destroy().catch(() => {}); };
  }, [blob]);
  const document = loaded?.blob === blob ? loaded.document : null;
  if (failure?.blob === blob) return <p role="alert">{failure.text}</p>;
  return document ? <PdfPages document={document} /> : <p role="status">Открываем PDF…</p>;
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/(auto|scroll)/.test(`${style.overflow} ${style.overflowY}`)) return parent;
  }
  return null;
}
function usePageVisibility(host: RefObject<HTMLDivElement | null>, count: number) {
  const [active, setActive] = useState<number[]>([1]);
  useEffect(() => {
    const node = host.current;if (!node) return;
    const sections = [...node.querySelectorAll<HTMLElement>("[data-pdf-page]")], root = scrollParent(node);
    const update = (candidates: HTMLElement[]) => {
      const bounds = root?.getBoundingClientRect(), center = bounds ? (bounds.top + bounds.bottom) / 2 : window.innerHeight / 2;
      const next = candidates.map(element => { const rect = element.getBoundingClientRect();return { number: Number(element.dataset.pdfPage), distance: Math.abs((rect.top + rect.bottom) / 2 - center) }; })
        .sort((a, b) => a.distance - b.distance).slice(0, RESIDENT_PAGES).map(item => item.number).sort((a, b) => a - b);
      setActive(previous => previous.join(",") === next.join(",") ? previous : next);
    };
    if (typeof IntersectionObserver === "function") {
      const near = new Set<HTMLElement>();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) { if (entry.isIntersecting) near.add(entry.target as HTMLElement);else near.delete(entry.target as HTMLElement); }
        update([...near]);
      }, { root, rootMargin: "600px 0px", threshold: 0 });
      sections.forEach(element => observer.observe(element));
      return () => observer.disconnect();
    }
    // Older browsers still get continuous reading. The fallback checks only on
    // a scheduled scroll/resize and retains the same resident-canvas bound.
    let timer: number | undefined;
    const measure = () => {
      timer = undefined;
      const bounds = root?.getBoundingClientRect(), top = (bounds?.top ?? 0) - 600, bottom = (bounds?.bottom ?? window.innerHeight) + 600;
      const visible = sections.filter(element => { const rect = element.getBoundingClientRect();return rect.height > 0 && rect.bottom > top && rect.top < bottom; });
      if (visible.length) update(visible);
    };
    const schedule = () => { if (timer === undefined) timer = window.setTimeout(measure, 16); };
    window.addEventListener("scroll", schedule, true);window.addEventListener("resize", schedule);schedule();
    return () => { window.clearTimeout(timer);window.removeEventListener("scroll", schedule, true);window.removeEventListener("resize", schedule); };
  }, [host, count]);
  return { active, activate: (page: number) => setActive([page]) };
}

function PdfPages({ document }: { document: PDFDocumentProxy }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, ratio: typeof window === "undefined" ? 1 : window.devicePixelRatio || 1 });
  const [zoom, setZoom] = useState(1);
  const { active, activate } = usePageVisibility(host, document.numPages);
  useEffect(() => {
    const node = host.current;if (!node) return;
    const measure = () => {
      const width = node.clientWidth || node.getBoundingClientRect().width || 600, ratio = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
      setSize(previous => previous.width === width && previous.ratio === ratio ? previous : { width, ratio });
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);window.addEventListener("resize", measure);window.visualViewport?.addEventListener("resize", measure);
    const timer = window.setTimeout(measure, 0);
    return () => { window.clearTimeout(timer);observer?.disconnect();window.removeEventListener("resize", measure);window.visualViewport?.removeEventListener("resize", measure); };
  }, []);
  const width = Math.max(1, Math.floor(size.width * zoom));
  return <div ref={host} className={s.pdf}>
    <div className={s.pdfControls}><span>Страниц: {document.numPages}</span><label>Масштаб<select aria-label="Масштаб PDF" value={zoom} onChange={event => setZoom(Number(event.target.value))}>
      <option value={0.75}>75%</option><option value={1}>По ширине</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option>
    </select></label></div>
    <div className={s.pdfPages} aria-label="Страницы PDF — непрерывная прокрутка">
      {Array.from({ length: document.numPages }, (_, index) => <PdfPage key={index + 1} document={document} number={index + 1} width={width} ratio={size.ratio} active={active.includes(index + 1)} onFocus={() => activate(index + 1)} />)}
    </div>
  </div>;
}
function PdfPage({ document, number, width, ratio, active, onFocus }: {
  document: PDFDocumentProxy; number: number; width: number; ratio: number; active: boolean; onFocus: () => void;
}) {
  const [aspect, setAspect] = useState(Math.SQRT2);
  return <section className={s.pdfPage} data-pdf-page={number} style={{ width }} tabIndex={0} aria-label={`Страница ${number} из ${document.numPages}`} onFocus={onFocus}>
    <div className={s.pdfSheet} style={{ aspectRatio: String(1 / aspect) }}>
      {active ? <PdfPageCanvas document={document} number={number} width={width} ratio={ratio} onAspect={setAspect} /> : <span className={s.pdfPlaceholder}>Страница {number}</span>}
    </div><small className={s.pdfCaption}>Страница {number} из {document.numPages}</small>
  </section>;
}
function PdfPageCanvas({ document, number, width, ratio, onAspect }: {
  document: PDFDocumentProxy; number: number; width: number; ratio: number; onAspect: (aspect: number) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), generation = useRef(0);
  const [state, setState] = useState<{ rendering: boolean; text: string; error: string }>({ rendering: true, text: "", error: "" });
  useEffect(() => {
    const target = canvas.current;if (!target) return;
    const current = ++generation.current;
    let cancelled = false, render: RenderTask | undefined, page: PDFPageProxy | undefined;
    const cleanupIfCurrent = () => { if (generation.current === current) page?.cleanup(); };
    void (async () => {
      try {
        page = await document.getPage(number);if (cancelled) { if (generation.current === current) page.cleanup();return; }
        setState({ rendering: true, text: "", error: "" });
        const base = page.getViewport({ scale: 1 }), cssScale = width / base.width, height = base.height * cssScale;
        onAspect(base.height / base.width);
        // Match CSS width and screen density; retain a hard per-canvas memory
        // limit for large/zoomed pages, independent of the document length.
        const outputScale = Math.min(ratio, Math.sqrt(CANVAS_PIXELS / (width * height)));
        const viewport = page.getViewport({ scale: cssScale * outputScale });
        target.width = Math.max(1, Math.floor(viewport.width));target.height = Math.max(1, Math.floor(viewport.height));
        render = page.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE });await render.promise;
        const text = await page.getTextContent();
        if (!cancelled) setState({ rendering: false, text: text.items.map(item => "str" in item ? item.str : "").join(" "), error: "" });
      } catch { if (!cancelled) setState({ rendering: false, text: "", error: "Не удалось показать страницу PDF. Файл можно скачать." }); }
    })();
    return () => {
      cancelled = true;render?.cancel();target.width = 0;target.height = 0;
      // A subsequent zoom render may use the same page proxy. Never clean its
      // resources while that newer render is using them.
      void (render?.promise ?? Promise.resolve()).catch(() => {}).then(cleanupIfCurrent);
    };
  }, [document, number, width, ratio, onAspect]);
  return <>
    <canvas ref={canvas} className={s.pdfCanvas} role="img" aria-label={`Страница PDF ${number}`} data-rendered={!state.rendering && !state.error} />
    {state.rendering && <span className={s.pdfPlaceholder} role="status">Рисуем страницу {number}…</span>}
    {state.error && <p className={s.pdfPageError} role="alert">{state.error}</p>}
    {state.text && <p className={s.srOnly} aria-label={`Текст страницы PDF ${number}`}>{state.text}</p>}
  </>;
}
