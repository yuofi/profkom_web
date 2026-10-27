// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { mountWorkspace, settle } from "../../test/workspace";
const mock = vi.hoisted(() => ({ getDocument: vi.fn(), worker: { workerSrc: "" } }));
vi.mock("pdfjs-dist", () => ({ getDocument: mock.getDocument, GlobalWorkerOptions: mock.worker, AnnotationMode: { DISABLE: 0 } }));
vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min.mjs" }));
import { FilePdfPreview } from "./FilePdfPreview";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.clearAllMocks(); });
it("PDF pages use only bounded canvas rendering and local bytes without script/link/form layers", async () => {
  const cancel = vi.fn(), destroy = vi.fn(async () => {}), render = vi.fn((parameters: unknown) => { void parameters;return { promise: Promise.resolve(), cancel }; });
  const getPage = vi.fn(async (number: number) => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render, getTextContent: async () => ({ items: [{ str: `Synthetic PDF ${number}` }] }) }));
  mock.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage }), destroy });
  const blob = new Blob(["%PDF synthetic"]);Object.defineProperty(blob, "arrayBuffer", { value: async () => new TextEncoder().encode("%PDF synthetic").buffer });
  page = await mountWorkspace(<FilePdfPreview blob={blob} />);await settle();
  const options = mock.getDocument.mock.calls[0][0];
  expect(options.data).toBeInstanceOf(Uint8Array);expect(options.url).toBeUndefined();
  expect(options).toMatchObject({ enableXfa: false, useWasm: false, useWorkerFetch: false, disableFontFace: true, stopAtErrors: true, maxImageSize: 20_000_000 });
  expect(options.cMapUrl).toBeUndefined();expect(options.standardFontDataUrl).toBeUndefined();
  expect(mock.worker.workerSrc).toContain("pdf.worker.min.mjs");
  expect(render.mock.calls[0][0]).toMatchObject({ annotationMode: 0, canvas: expect.any(HTMLCanvasElement) });
  const canvas = page.container.querySelector("canvas")!;expect(canvas.width * canvas.height).toBeLessThanOrEqual(2_002_000);
  expect(page.container.querySelector("iframe, embed, object, a, input, script")).toBeNull();
  expect(page.container.textContent).toContain("Страница 1 из 2");expect(page.container.querySelector('[aria-label="Текст страницы PDF"]')?.textContent).toBe("Synthetic PDF 1");
  const next = [...page.container.querySelectorAll("button")].find(node => node.textContent === "Следующая")!;await act(async () => next.click());await settle();
  expect(getPage).toHaveBeenLastCalledWith(2);expect(page.container.textContent).toContain("Страница 2 из 2");
  await page.cleanup();page = undefined;expect(destroy).toHaveBeenCalledTimes(1);expect(cancel).toHaveBeenCalled();
});
it("a malformed PDF produces a safe fallback message without loading a browser plugin", async () => {
  mock.getDocument.mockImplementation(() => ({ promise: Promise.reject(Error("Invalid PDF")), destroy: vi.fn(async () => {}) }));
  const blob = new Blob(["invalid"]);Object.defineProperty(blob, "arrayBuffer", { value: async () => new ArrayBuffer(7) });
  page = await mountWorkspace(<FilePdfPreview blob={blob} />);await settle();
  expect(page.container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось открыть PDF");expect(page.container.querySelector("iframe, embed, object")).toBeNull();
});
