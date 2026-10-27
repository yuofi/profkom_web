// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Attachments } from "./Attachments";
import { filesApi } from "../../utils/api/files.api";
import { api } from "../../utils/api";
import { ApiError } from "../../utils/api/request";
import { SessionContext } from "../../utils/session";
import { createFixtures } from "../../mocks/fixtures";
import type { FileRef } from "../../utils/api/contract";
import { mountWorkspace, settle, waitForPage } from "../../test/workspace";

vi.mock("./FilePdfPreview", () => ({ FilePdfPreview: () => <p>PDF canvas viewer</p> }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
const ref = (name: string, mime_type: string, size_bytes = 16): FileRef => ({ file_id: "file-preview-1", name, mime_type, size_bytes });
function blob(text: string, type = "text/plain") {
  const value = new Blob([text], { type });
  Object.defineProperty(value, "arrayBuffer", { value: async () => new TextEncoder().encode(text).buffer });
  return value;
}
function button(label: string) { const node = page!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);if (!node) throw Error(`Missing ${label}`);return node; }
async function open(file: FileRef) { page = await mountWorkspace(<Attachments files={[file]} />);await act(async () => button(`Открыть ${file.name}`).click());await waitForPage(page!); }
beforeEach(() => { vi.spyOn(filesApi, "download").mockResolvedValue({ download_url: "/api/files/file-preview-1/content", expires_at: null });vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:synthetic-preview");vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {}); });
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });

it("opens code in a dialog through checked API bytes rather than triggering a download", async () => {
  const get = vi.spyOn(filesApi, "content").mockResolvedValue(blob('const value = "safe";', "text/javascript"));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  await open(ref("script.js", "text/javascript"));
  expect(page!.container.querySelector("dialog[open]")).not.toBeNull();
  expect(get).toHaveBeenCalledWith("file-preview-1", expect.any(AbortSignal));
  expect(page!.container.querySelector("pre code .hljs-keyword")?.textContent).toBe("const");
  expect(page!.container.querySelector("figcaption")?.textContent).toBe("JavaScript");
  expect(click).not.toHaveBeenCalled();
});
it("HTML/SVG/JavaScript attachments stay escaped source and cannot create executable frames or nodes", async () => {
  const source = '<svg onload="alert(1)"><script>window.bad = true</script></svg>';
  vi.spyOn(filesApi, "content").mockResolvedValue(blob(source, "image/svg+xml"));
  await open(ref("unsafe.svg", "image/svg+xml"));
  expect(page!.container.querySelector("pre code")?.textContent).toBe(source);
  expect(page!.container.querySelector("script, svg, iframe, object, embed")).toBeNull();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("oversized text and unsupported binary formats have an explicit download fallback without fetching bytes", async () => {
  const content = vi.spyOn(filesApi, "content");await open(ref("large.txt", "text/plain", 1024 * 1024 + 1));
  expect(page!.container.textContent).toContain("слишком большой для предпросмотра");expect(content).not.toHaveBeenCalled();
  await page!.cleanup();page = undefined;await open(ref("archive.zip", "application/zip"));
  expect(page!.container.textContent).toContain("Для этого формата предпросмотр недоступен");expect(content).not.toHaveBeenCalled();
});
it("raster preview revokes its object URL on close and restores the opening button's focus", async () => {
  vi.spyOn(filesApi, "content").mockResolvedValue(blob("synthetic image", "image/png"));await open(ref("image.png", "image/png"));
  expect(page!.container.querySelector('dialog img')?.getAttribute("src")).toBe("blob:synthetic-preview");
  await act(async () => button("Закрыть просмотр файла").click());
  expect(page!.container.querySelector("dialog")).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-preview");
});
it("permission loss on refetch removes cached bytes and revokes the local URL", async () => {
  vi.spyOn(filesApi, "content").mockResolvedValue(blob("synthetic image", "image/png"));await open(ref("image.png", "image/png"));
  vi.mocked(filesApi.download).mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["files"] }); });await settle();
  expect(page!.container.querySelector("dialog img")).toBeNull();expect(page!.container.textContent).toContain("Нет доступа");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-preview");
});
it("window focus rechecks access before retaining the visible preview", async () => {
  vi.spyOn(filesApi, "content").mockResolvedValue(blob("synthetic image", "image/png"));await open(ref("image.png", "image/png"));
  vi.mocked(filesApi.download).mockRejectedValue(new ApiError("Not found", 404, "not_found"));
  await act(async () => window.dispatchEvent(new Event("focus")));await waitForPage(page!);
  expect(page!.container.querySelector("dialog img")).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-preview");
});
it("changing the session access fingerprint discards the previous account's visible bytes", async () => {
  vi.spyOn(filesApi, "content").mockResolvedValue(blob("synthetic image", "image/png"));
  function Harness() {
    const initial = createFixtures("chair").session, [session, setSession] = useState(initial);
    return <SessionContext.Provider value={{ session, loading: false, error: null, refresh() {} }}><button onClick={() => setSession({ ...initial, user_id: initial.user_id + 1, access_revision: "changed" })}>Сменить сессию</button><Attachments files={[ref("image.png", "image/png")]} /></SessionContext.Provider>;
  }
  page = await mountWorkspace(<Harness />);await act(async () => button("Открыть image.png").click());await waitForPage(page);
  vi.mocked(filesApi.download).mockRejectedValue(new ApiError("Forbidden", 403, "forbidden"));
  await act(async () => [...page!.container.querySelectorAll("button")].find(node => node.textContent === "Сменить сессию")!.click());await waitForPage(page);
  expect(page.container.querySelector("dialog img")).toBeNull();expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-preview");
});
it("closing during a byte fetch aborts it and ignores a late response", async () => {
  let finish: (value: Blob) => void = () => {};let signal: AbortSignal | undefined;
  vi.spyOn(filesApi, "content").mockImplementation((_id, next) => { signal = next;return new Promise(resolve => { finish = resolve; }); });
  await open(ref("image.png", "image/png"));expect(signal?.aborted).toBe(false);
  await act(async () => button("Закрыть просмотр файла").click());expect(signal?.aborted).toBe(true);
  await act(async () => finish(blob("late image", "image/png")));expect(URL.createObjectURL).not.toHaveBeenCalled();
});
it("explicit download rejects external and data addresses instead of following them", async () => {
  const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  page = await mountWorkspace(<Attachments files={[ref("report.pdf", "application/pdf")]} />);
  for (const url of ["https://external.invalid/file", "data:text/html,unsafe"]) {
    vi.mocked(filesApi.download).mockResolvedValue({ download_url: url, expires_at: null });
    await act(async () => button("Скачать report.pdf").click());await settle();expect(page.container.textContent).toContain("Недопустимая ссылка");
  }
  expect(clicked).not.toHaveBeenCalled();
});
it("content API uses the authenticated client, canonical endpoint, blob response and caller cancellation", async () => {
  const data = blob("safe");const get = vi.spyOn(api, "get").mockResolvedValue({ data });const controller = new AbortController();
  expect(await filesApi.content("file/id", controller.signal)).toBe(data);
  expect(get).toHaveBeenCalledWith("/files/file%2Fid/content", { responseType: "blob", signal: controller.signal });
});
