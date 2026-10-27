import { useEffect, useRef, useState } from "react";
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type PDFDocumentLoadingTask, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import s from "./FilePreview.module.css";

GlobalWorkerOptions.workerSrc = workerUrl;
/** Canvas-only PDF.js: no annotation layer, forms, document scripts, actions or external links. */
export function FilePdfPreview({ blob }: { blob: Blob }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState("");
  const [rendering, setRendering] = useState(false), [pageText, setPageText] = useState("");
  useEffect(() => {
    let cancelled = false, task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      try {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (cancelled) return;
        // PDF.js 6 removed eval-based glyph compilation. Only local bytes/local worker are used.
        task = getDocument({ data, enableXfa: false, useWasm: false, useWorkerFetch: false, useSystemFonts: true, disableFontFace: true, stopAtErrors: true, maxImageSize: 20_000_000, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
        const next = await task.promise;if (!cancelled) { setRendering(true);setDocument(next); }
      } catch { if (!cancelled) setError("Не удалось открыть PDF. Файл можно скачать."); }
    })();
    return () => { cancelled = true;void task?.destroy().catch(() => {}); };
  }, [blob]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let cancelled = false, render: RenderTask | undefined;const target = canvas.current;
    void (async () => {
      try {
        const pdfPage = await document.getPage(page);if (cancelled) return;
        const base = pdfPage.getViewport({ scale: 1 });
        const scale = Math.min(1.5, 1200 / base.width, Math.sqrt(2_000_000 / (base.width * base.height)));
        const viewport = pdfPage.getViewport({ scale });target.width = Math.ceil(viewport.width);target.height = Math.ceil(viewport.height);
        render = pdfPage.render({ canvas: target, viewport, annotationMode: AnnotationMode.DISABLE });await render.promise;
        const text = await pdfPage.getTextContent();
        if (!cancelled) { setPageText(text.items.map(item => "str" in item ? item.str : "").join(" "));setRendering(false); }
      } catch { if (!cancelled) { setError("Не удалось показать страницу PDF. Файл можно скачать.");setRendering(false); } }
    })();
    return () => { cancelled = true;render?.cancel();target.width = 0;target.height = 0; };
  }, [document, page]);
  const changePage = (next: number) => { setRendering(true);setPageText("");setError("");setPage(next); };
  return <div className={s.pdf}>
    {error ? <p role="alert">{error}</p> : !document ? <p role="status">Открываем PDF…</p> : <>
      <nav className={s.pdfControls} aria-label="Страницы PDF"><button type="button" disabled={page <= 1 || rendering} onClick={() => changePage(page - 1)}>Предыдущая</button><span>Страница {page} из {document.numPages}</span><button type="button" disabled={page >= document.numPages || rendering} onClick={() => changePage(page + 1)}>Следующая</button></nav>
      {rendering && <p role="status">Рисуем страницу…</p>}
    </>}
    <canvas ref={canvas} className={s.pdfCanvas} role="img" aria-label={`Страница PDF ${page}`} hidden={!document || !!error} data-rendered={!!pageText && !rendering} />
    {pageText && <p className={s.srOnly} aria-label="Текст страницы PDF">{pageText}</p>}
  </div>;
}
