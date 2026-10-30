// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { change, mountWorkspace, settle } from "../../test/workspace";
const mock = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: "" } }));
vi.mock("pdfjs-dist", () => ({ getDocument: mock.getDocument, GlobalWorkerOptions: mock.worker, AnnotationMode: { DISABLE: 0 } }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));
import { FilePdfPreview } from "./FilePdfPreview";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.clearAllMocks();vi.restoreAllMocks();vi.unstubAllGlobals(); });
const blob = () => { const value = new Blob(["%PDF synthetic"]);Object.defineProperty(value, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF synthetic").buffer });return value; };
function fixture(count = 100) {
  const cancel = vi.fn(), destroy = vi.fn(async () => {}), cleanup = vi.fn();
  const render = vi.fn((parameters: unknown) => { void parameters;return { promise: Promise.resolve(), cancel }; });
  const getPage = vi.fn(async (number: number) => ({ cleanup, getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render, getTextContent: async () => ({ items: [{ str: `Synthetic PDF ${number}` }] }) }));
  mock.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: count, getPage }), destroy });
  return { getPage, render, cancel, cleanup, destroy };
}
function observer() {
  let receive!: IntersectionObserverCallback;
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { receive = callback; }
    observe() {} unobserve() {} disconnect = disconnect;
  });
  return { disconnect, emit: async (numbers: number[], visible = true) => {
    await act(async () => receive(numbers.map(number => ({ target: page!.container.querySelector(`[data-pdf-page="${number}"]`)!, isIntersecting: visible })) as IntersectionObserverEntry[], {} as IntersectionObserver));await settle();
  } };
}

it("lays out every page continuously but holds only nearby canvas/text resources, using private local bytes", async () => {
  const view = observer(), pdf = fixture();
  page = await mountWorkspace(<FilePdfPreview blob={blob()} />);await settle();
  const options = mock.getDocument.mock.calls[0][0];
  expect(options.data).toBeInstanceOf(Uint8Array);expect(options.url).toBeUndefined();
  expect(options).toMatchObject({ enableXfa: false, useWasm: false, useWorkerFetch: false, disableFontFace: true, stopAtErrors: true, maxImageSize: 20_000_000 });
  expect(options.cMapUrl).toBeUndefined();expect(options.standardFontDataUrl).toBeUndefined();
  expect(mock.worker.workerSrc).toContain("pdf.worker.min.mjs");
  expect(pdf.render.mock.calls[0][0]).toMatchObject({ annotationMode: 0, canvas: expect.any(HTMLCanvasElement) });
  expect(page.container.querySelectorAll("[data-pdf-page]")).toHaveLength(100);
  expect(page.container.querySelectorAll("canvas")).toHaveLength(1);
  expect(page.container.querySelector('[aria-label="Текст страницы PDF 1"]')?.textContent).toBe("Synthetic PDF 1");
  const oldCanvas = page.container.querySelector("canvas")!;
  await view.emit([40, 41, 42, 43, 44]);
  expect(page.container.querySelectorAll("canvas")).toHaveLength(3);
  expect(pdf.getPage.mock.calls.map(call => call[0])).toEqual([1, 40, 41, 42]);
  expect(oldCanvas.width).toBe(0);expect(pdf.cleanup).toHaveBeenCalled();
  expect(page.container.querySelector('[aria-label="Текст страницы PDF 1"]')).toBeNull();
  expect(page.container.querySelector("iframe, embed, object, a, input, script")).toBeNull();
  expect(page.container.textContent).not.toContain("Следующая");
  await page.cleanup();page = undefined;expect(pdf.destroy).toHaveBeenCalledTimes(1);expect(pdf.cancel).toHaveBeenCalled();expect(view.disconnect).toHaveBeenCalled();
});

it("renders at viewport width and screen density, rerenders on zoom/resize and caps canvas memory", async () => {
  fixture(2);vi.stubGlobal("devicePixelRatio", 2);
  const measured = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1000);
  page = await mountWorkspace(<FilePdfPreview blob={blob()} />);await settle();await settle();
  let canvas = page.container.querySelector("canvas")!;
  expect(canvas.width).toBe(2000);expect(canvas.height).toBe(2666);
  expect(page.container.querySelector<HTMLElement>('[data-pdf-page="1"]')?.style.width).toBe("1000px");
  await change(page.container.querySelector("select")!, "2");await settle();
  canvas = page.container.querySelector("canvas")!;expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_000_000);expect(canvas.width).toBeGreaterThan(2000);
  measured.mockReturnValue(800);await act(async () => window.dispatchEvent(new Event("resize")));await settle();
  expect(page.container.querySelector<HTMLElement>('[data-pdf-page="1"]')?.style.width).toBe("1600px");
  expect(page.container.querySelector("canvas")!.width * page.container.querySelector("canvas")!.height).toBeLessThanOrEqual(8_000_000);
});

it("cancels an unfinished render on unmount and does not report cancellation as a file error", async () => {
  const pdf = fixture(2);let refuse!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { refuse = reject; });
  pdf.cancel.mockImplementation(() => refuse(Error("RenderingCancelledException")));
  pdf.render.mockImplementation(() => ({ promise: pending, cancel: pdf.cancel }));
  page = await mountWorkspace(<FilePdfPreview blob={blob()} />);await settle();
  const canvas = page.container.querySelector("canvas")!;
  await page.cleanup();page = undefined;expect(canvas.width).toBe(0);expect(pdf.cancel).toHaveBeenCalled();expect(pdf.destroy).toHaveBeenCalled();expect(document.querySelector('[role="alert"]')).toBeNull();
});

it("a changed blob removes the previous document immediately and destroys its loader", async () => {
  const pdf = fixture(2);let replace!: (blob: Blob) => void;
  function Holder() { const [source, setSource] = useState(blob);replace = setSource;return <FilePdfPreview blob={source} />; }
  page = await mountWorkspace(<Holder />);await settle();expect(page.container.querySelector("canvas")).not.toBeNull();
  mock.getDocument.mockReturnValue({ promise: new Promise(() => {}), destroy: vi.fn(async () => {}) });
  await act(async () => replace(blob()));await settle();
  expect(pdf.destroy).toHaveBeenCalledTimes(1);expect(page.container.querySelector("canvas")).toBeNull();expect(page.container.textContent).toContain("Открываем PDF");
});

it("a malformed PDF produces a safe fallback without loading a browser plugin", async () => {
  mock.getDocument.mockImplementation(() => ({ promise: Promise.reject(Error("Invalid PDF")), destroy: vi.fn(async () => {}) }));
  page = await mountWorkspace(<FilePdfPreview blob={blob()} />);await settle();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось открыть PDF");expect(page.container.querySelector("iframe, embed, object")).toBeNull();
});
