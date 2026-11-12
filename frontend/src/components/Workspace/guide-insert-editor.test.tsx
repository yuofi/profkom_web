// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { GuideInsertEditor, GuideSourcePreview } from "./GuideInsertEditor";
import { createFixtures } from "../../mocks/fixtures";
import { materialsApi } from "../../utils/api/materials.api";
import { filesApi } from "../../utils/api/files.api";
import type { Material, MaterialText } from "../../utils/api/contract";
import { change, mountWorkspace, settle } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
const material = (): Material => ({ ...createFixtures("chair").materials[0], kind: "guide", source_content: { format: "markdown", body: "## Начало\n\nОбычный текст" }, capabilities: ["edit_material", "edit_html_material", "publish_material"] });
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function(this: HTMLDialogElement) { this.open = true;this.querySelector<HTMLElement>("input,button")?.focus(); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function(this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });
function Editor({ data = material(), initialFormat = "markdown" }: { data?: Material; initialFormat?: MaterialText["format"] }) {
  const [body, setBody] = useState(data.source_content!.body), [format, setFormat] = useState(initialFormat), [busy, setBusy] = useState(false);
  return <><GuideInsertEditor material={data} value={body} format={format} onChange={setBody} onFormatChange={setFormat} disabled={busy} onBusyChange={setBusy} /><output data-format>{format}</output></>;
}
async function click(element: HTMLElement) { await act(async () => element.click());await settle(); }
async function open(kind: string) {
  await click(getByRole(page!.container, "button", { name: "Вставить оформленный блок" }));
  await click(getByRole(page!.container, "menuitem", { name: kind }));
  return getByRole(document.body, "dialog");
}
async function enable(dialog: HTMLElement) { await click(getByRole(dialog, "checkbox", { name: "Включить оформленные вставки в этом гайде" })); }
async function debounce() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });await settle(); }
function compiled(content: MaterialText, label = "Проверенная вставка"): MaterialText {
  const match = /profkom-html id=([a-z0-9-]+)\n([\s\S]*?)\n`{3,}/.exec(content.body)!;
  return { ...content, render: { schema_version: 1, policy_version: 1, source_hash: "0".repeat(64), diagnostics: [], file_ids: [], blocks: match ? [{ id: match[1], source: match[2], text: label, nodes: [{ tag: "p", text: "", attrs: {}, children: [{ tag: "text", text: label, attrs: {}, children: [] }] }] }] : [] } };
}

it("inserts a styled panel only after explicit format opt-in and preserves undo/caret", async () => {
  page = await mountWorkspace(<Editor />);
  const textarea = getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement;
  textarea.focus();textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  const initial = textarea.value, dialog = await open("Плашка");
  await change(getByLabelText(dialog, "Заголовок") as HTMLInputElement, "Перед началом");
  await click(getByRole(dialog, "button", { name: "Мятная" }));
  await click(getByRole(dialog, "checkbox", { name: "Мягкий градиент" }));
  await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  expect(dialog.textContent).toContain("Подтвердите включение");expect(textarea.value).toBe(initial);
  await enable(dialog);await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  expect(document.body.querySelector("dialog")).toBeNull();expect(textarea.value).toContain("guide-gradient-success");
  expect(textarea.value).toMatch(/```profkom-html id=embed-[a-f0-9-]+/);expect(page.container.querySelector("output")!.textContent).toBe("markdown-embeds-v1");
  expect(document.activeElement).toBe(textarea);
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
  expect(textarea.value).toBe(initial);expect(textarea.selectionStart).toBe(initial.length);
  await act(async () => textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })));
  expect(textarea.value).toContain("Перед началом");
});

it("does not compile or list guides until the corresponding explicit action", async () => {
  const preview = vi.spyOn(materialsApi, "preview").mockImplementation(async (_id, request) => compiled(request.content));
  const list = vi.spyOn(materialsApi, "list").mockResolvedValue({ items: [], next_cursor: null });
  page = await mountWorkspace(<Editor />);await debounce();expect(preview).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
  const dialog = await open("Кнопка-ссылка");await debounce();expect(preview).not.toHaveBeenCalled();expect(list).not.toHaveBeenCalled();
  await change(getByLabelText(dialog, "Куда ведёт кнопка") as HTMLSelectElement, "guide");expect(list).toHaveBeenCalledTimes(1);
  await click(getByRole(dialog, "button", { name: "Предпросмотр вставки" }));await debounce();expect(preview).toHaveBeenCalledTimes(1);
});

it("chooses a real document section and compiles its button preview with the target context", async () => {
  const preview = vi.spyOn(materialsApi, "preview").mockImplementation(async (_id, request) => compiled(request.content));
  page = await mountWorkspace(<Editor />);const dialog = await open("Кнопка-ссылка");
  await change(getByLabelText(dialog, "Куда ведёт кнопка") as HTMLSelectElement, "section");
  await settle();await change(getByLabelText(dialog, "Раздел") as HTMLSelectElement, "#section-1");
  await click(getByRole(dialog, "button", { name: "Предпросмотр вставки" }));await debounce();
  const request = preview.mock.calls.at(-1)![1];expect(request.content.body).toContain("## Начало");expect(request.content.body).toContain('href="#section-1"');
  await enable(dialog);await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  expect((getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value).toContain('href="#section-1"');
});

it("requires a table caption and keeps user-entered table cells escaped", async () => {
  page = await mountWorkspace(<Editor />);const dialog = await open("Таблица");await enable(dialog);
  await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));expect(dialog.textContent).toContain("Добавьте название таблицы");
  await change(getByLabelText(dialog, "Название таблицы") as HTMLInputElement, "План встречи");
  await change(getByLabelText(dialog, "Строка 1, столбец 1") as HTMLInputElement, "<script>example</script>");
  await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  const body = (getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value;
  expect(body).toContain("<caption>План встречи</caption>");expect(body).toContain("&lt;script&gt;example&lt;/script&gt;");
});

it("manual HTML is preserved and cannot be silently overwritten by fields", async () => {
  page = await mountWorkspace(<Editor />);const dialog = await open("Плашка");
  await click(getByRole(dialog, "button", { name: "HTML" }));
  const html = '<section class="guide-grid-2"><p>Моя композиция</p></section>';
  await change(getByLabelText(dialog, "HTML вставки") as HTMLTextAreaElement, html);
  expect((getByRole(dialog, "button", { name: "Поля" }) as HTMLButtonElement).disabled).toBe(true);
  await enable(dialog);await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  expect((getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value).toContain(html);
});

it("keeps insertion unavailable without the separate HTML editing capability", async () => {
  const data = material();data.capabilities = ["edit_material"];
  page = await mountWorkspace(<Editor data={data} />);
  expect(queryByRole(page.container, "button", { name: "Вставить оформленный блок" })).toBeNull();
});

it("cancels a preview on source change, hides stale output immediately and ignores its late response", async () => {
  let resolveOld!: (value: MaterialText) => void, resolveNew!: (value: MaterialText) => void;
  const preview = vi.spyOn(materialsApi, "preview").mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockImplementationOnce(() => new Promise(resolve => { resolveNew = resolve; }));
  const old = { format: "markdown-embeds-v1" as const, body: '```profkom-html id=embed-one\n<p>Первое</p>\n```' }, next = { ...old, body: old.body.replace("Первое", "Второе") };
  function Preview() { const [content, setContent] = useState(old);return <><button onClick={() => setContent(next)}>Изменить исходник</button><GuideSourcePreview material={material()} content={content} /></>; }
  page = await mountWorkspace(<Preview />);await debounce();expect(preview).toHaveBeenCalledTimes(1);
  await click(getByRole(page.container, "button", { name: "Изменить исходник" }));expect(preview.mock.calls[0][2]!.aborted).toBe(true);
  expect(page.container.textContent).toContain("Проверяем оформление");await debounce();
  await act(async () => resolveNew(compiled(next, "НОВЫЙ РЕЗУЛЬТАТ")));await debounce();
  await act(async () => resolveOld(compiled(old, "СТАРЫЙ РЕЗУЛЬТАТ")));await settle();
  expect(page.container.textContent).toContain("НОВЫЙ РЕЗУЛЬТАТ");expect(page.container.textContent).not.toContain("СТАРЫЙ РЕЗУЛЬТАТ");
});

it("focuses a new insert inside its own bounded preview without scrolling the dialog or page", async () => {
  const content: MaterialText = { format: "markdown-embeds-v1", body: '## Старый гайд\n\nДлинный предыдущий текст\n\n```profkom-html id=embed-new\n<p>Новая вставка</p>\n```' };
  vi.spyOn(materialsApi, "preview").mockResolvedValue(compiled(content, "Новая вставка"));
  const windowScroll = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const top = this.dataset.guideEmbed ? 800 : this.dataset.guidePreviewScroll ? 100 : 0;
    return { top, left: 0, bottom: top + 100, right: 400, width: 400, height: 100, x: 0, y: top, toJSON: () => ({}) };
  });
  page = await mountWorkspace(<GuideSourcePreview material={material()} content={content} focusEmbedId="embed-new" />);
  await debounce();
  const viewport = page.container.querySelector<HTMLElement>('[data-guide-preview-scroll="insert"]')!;
  expect(viewport.scrollTop).toBe(684);
  expect(document.documentElement.scrollTop).toBe(0);expect(document.body.scrollTop).toBe(0);expect(windowScroll).not.toHaveBeenCalled();
  expect(viewport.querySelector('[data-guide-embed="embed-new"]')).not.toBeNull();
});

it("uploads an image in its own material context and inserts only a completed stable file ID", async () => {
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue({ file_id: "file-picture", name: "scheme.png", mime_type: "image/png", size_bytes: 4 });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:local-image") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Image", class { src = "";naturalWidth = 1600;naturalHeight = 900;decode = async () => {}; });
  page = await mountWorkspace(<Editor />);const dialog = await open("Изображение");
  const input = getByLabelText(dialog, "Файл изображения") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "scheme.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  expect(upload.mock.calls[0][1]).toEqual({ owner_kind: "material", owner_id: material().material_id, purpose: "material" });
  await change(getByLabelText(dialog, "Описание изображения") as HTMLInputElement, "Схема входа");
  await enable(dialog);await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  const body = (getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value;
  expect(body).toContain('src="file:file-picture"');expect(body).toContain('width="1280" height="720"');expect(body).not.toContain("blob:");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local-image");
});

it("leaves the source unchanged on an upload failure and explains the refusal", async () => {
  const upload = vi.spyOn(filesApi, "upload");page = await mountWorkspace(<Editor />);const dialog = await open("Изображение");
  const input = getByLabelText(dialog, "Файл изображения") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "bad.svg", { type: "image/svg+xml" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  expect(upload).not.toHaveBeenCalled();expect(dialog.textContent).toContain("неподдерживаемый формат");
  await enable(dialog);await click(getByRole(dialog, "button", { name: "Вставить в гайд" }));
  expect(dialog.textContent).toContain("Выберите и загрузите изображение");
  expect((getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value).toBe(material().source_content!.body);
});

it("cancels a slow upload, releases the editor and ignores a completed late result", async () => {
  let finish!: (file: Awaited<ReturnType<typeof filesApi.upload>>) => void;
  const upload = vi.spyOn(filesApi, "upload").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:local-image") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Image", class { src = "";naturalWidth = 640;naturalHeight = 480;decode = async () => {}; });
  page = await mountWorkspace(<Editor />);const dialog = await open("Изображение");
  const input = getByLabelText(dialog, "Файл изображения") as HTMLInputElement;
  Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "scheme.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  expect((getByRole(dialog, "button", { name: "Закрыть вставку" }) as HTMLButtonElement).disabled).toBe(true);
  await click(getByRole(dialog, "button", { name: "Отменить загрузку" }));
  expect(upload.mock.calls[0][3]!.aborted).toBe(true);
  expect((getByRole(dialog, "button", { name: "Закрыть вставку" }) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => finish({ file_id: "file-late", name: "scheme.png", mime_type: "image/png", size_bytes: 4 }));
  expect(dialog.textContent).not.toContain("Загружено");
  await click(getByRole(dialog, "button", { name: "Закрыть вставку" }));
  expect(document.body.querySelector("dialog")).toBeNull();
  expect(document.activeElement).toBe(getByRole(page.container, "button", { name: "Вставить оформленный блок" }));
  expect((getByRole(page.container, "textbox", { name: "Текст материала" }) as HTMLTextAreaElement).value).not.toContain("file-late");
});
