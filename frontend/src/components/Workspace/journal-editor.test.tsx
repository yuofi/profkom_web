// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { getByLabelText, getByRole } from "@testing-library/dom";
import { JournalEditor, JournalPreview } from "./JournalEditor";
import { importJournal, journalSource, newJournalBlock } from "./journalEditorModel";
import { createFixtures } from "../../mocks/fixtures";
import { materialsApi } from "../../utils/api/materials.api";
import { filesApi } from "../../utils/api/files.api";
import type { Material, MaterialText } from "../../utils/api/contract";
import { change, mountWorkspace, settle } from "../../test/workspace";

// Reader has its own security/render tests; this suite observes the exact preview
// source/title and protects debounce/race behavior independently of HTML rendering.
vi.mock("./JournalGuide", () => ({ JournalGuide: ({ content, title }: { content: MaterialText; title: string }) => <article data-preview-source={content.body}><h1>{title}</h1>{content.body}</article> }));
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
const material = (): Material => ({ ...createFixtures("chair").materials[0], kind: "guide", capabilities: ["edit_material", "edit_html_material", "publish_material"] });
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });
function Editor({ source, permitted = true }: { source: string; permitted?: boolean }) {
  const [body, setBody] = useState(source), [busy, setBusy] = useState(false), [generation, setGeneration] = useState(0);
  const data = material();if (!permitted) data.capabilities = ["edit_material"];
  return <><JournalEditor key={generation} material={data} title="Гайд по трекеру" value={body} onChange={setBody} disabled={busy} onBusyChange={setBusy} /><output data-source>{body}</output><output data-busy>{String(busy)}</output><button type="button" onClick={() => setGeneration(generation + 1)}>Переоткрыть сохранённый</button></>;
}
const sourceNow = () => page!.container.querySelector("[data-source]")!.textContent!;
async function click(element: HTMLElement) { await act(async () => element.click());await settle(); }
async function debounce() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });await settle(); }

it("edits a persisted note through fields, reopens it and preserves its ID and all hidden blocks", async () => {
  const document = importJournal("## Раздел\nТекст", "markdown"), note = newJournalBlock("note");document.sections[0].blocks.push(note);
  const preview = vi.spyOn(materialsApi, "preview");page = await mountWorkspace(<Editor source={journalSource(document)} />);
  await click(getByRole(page.container, "button", { name: "Плашка Обратите внимание" }));
  await change(getByLabelText(page.container, "Заголовок плашки") as HTMLInputElement, "Сначала проверьте");
  await change(getByLabelText(page.container, "Текст плашки") as HTMLTextAreaElement, "**Сохраните** результат");
  await change(getByLabelText(page.container, "Оформление плашки") as HTMLSelectElement, "warning");
  const saved = sourceNow();await click(getByRole(page.container, "button", { name: "Переоткрыть сохранённый" }));
  await click(getByRole(page.container, "button", { name: "Плашка Сначала проверьте" }));
  expect((getByLabelText(page.container, "Текст плашки") as HTMLTextAreaElement).value).toBe("**Сохраните** результат");
  const result = JSON.parse(sourceNow());expect(sourceNow()).toBe(saved);expect(result.sections[0].blocks[0]).toEqual(document.sections[0].blocks[0]);expect(result.sections[0].blocks[1]).toMatchObject({ id: note.id, title: "Сначала проверьте", tone: "warning" });
  await debounce();expect(preview).not.toHaveBeenCalled();
});

it("reorders without changing anchors, duplicates with fresh IDs and undoes/redoes edits", async () => {
  const document = importJournal("## Первая\nТекст\n## Вторая\nДругой текст", "markdown");page = await mountWorkspace(<Editor source={journalSource(document)} />);
  await click(getByRole(page.container, "button", { name: "01 Первая" }));
  await click(getByRole(page.container, "button", { name: "Переместить раздел вниз" }));
  expect(JSON.parse(sourceNow()).sections[1].id).toBe("section-1");
  expect((getByLabelText(page.container, "Ссылка на раздел") as HTMLInputElement).value).toBe("#section-1");
  await click(getByRole(page.container, "button", { name: "Дублировать раздел" }));
  const duplicated = sourceNow();expect(JSON.parse(duplicated).sections).toHaveLength(3);
  await click(getByRole(page.container, "button", { name: "Отменить" }));expect(JSON.parse(sourceNow()).sections).toHaveLength(2);
  await click(getByRole(page.container, "button", { name: "Повторить" }));expect(sourceNow()).toBe(duplicated);
});

it("retains malformed source visibly and can undo it without replacing the document", async () => {
  const source = journalSource(importJournal("## Первая\nТекст", "markdown"));page = await mountWorkspace(<Editor source={source} />);
  await click(getByRole(page.container, "button", { name: "Исходник" }));
  await change(getByLabelText(page.container, "Исходник журнала") as HTMLTextAreaElement, source.slice(0, -1));
  expect(sourceNow()).toBe(source.slice(0, -1));expect(getByRole(page.container, "alert").textContent).toContain("Ваш текст не потерян");
  await click(getByRole(page.container, "button", { name: "Отменить" }));expect(sourceNow()).toBe(source);
});

it("preserves cover line breaks and the unselected variant when reopening a switcher", async () => {
  const document = importJournal("## Примеры\nТекст", "markdown"), switcher = newJournalBlock("switcher");
  document.cover = { kind: "poster", eyebrow: "Встреча", title: "Новички", caption: "22 ноября\nАудитория 646", tone: "mint" };document.sections[0].blocks.push(switcher);
  page = await mountWorkspace(<Editor source={journalSource(document)} />);
  expect((getByLabelText(page.container, "Подпись обложки") as HTMLTextAreaElement).value).toBe("22 ноября\nАудитория 646");
  await change(getByLabelText(page.container, "Главная мысль обложки") as HTMLInputElement, "Встреча новичков");
  await click(getByRole(page.container, "button", { name: "Варианты примера Выберите пример" }));
  await change(getByLabelText(page.container, "Название варианта 2") as HTMLInputElement, "Назначены исполнители");
  await change(getByLabelText(page.container, "Текст варианта 2") as HTMLTextAreaElement, "**Анна и Илья**, новая задача");
  await click(getByRole(page.container, "button", { name: "Переоткрыть сохранённый" }));
  await click(getByRole(page.container, "button", { name: "Варианты примера Выберите пример" }));
  expect((getByLabelText(page.container, "Текст варианта 2") as HTMLTextAreaElement).value).toBe("**Анна и Илья**, новая задача");
  const result = JSON.parse(sourceNow());expect(result.cover).toEqual({ ...document.cover, title: "Встреча новичков" });
  if (switcher.type !== "switcher") throw Error("Wrong fixture");
  expect(result.sections[0].blocks[1].options[0]).toEqual(switcher.options[0]);expect(result.sections[0].blocks[1].options[1].id).toBe(switcher.options[1].id);
});

it("allows inspecting a persisted journal without granting formatting writes", async () => {
  const source = journalSource(importJournal("## Начало\nТекст", "markdown"));page = await mountWorkspace(<Editor source={source} permitted={false} />);
  expect((getByRole(page.container, "button", { name: "Добавить раздел" }) as HTMLButtonElement).disabled).toBe(true);
  await change(getByLabelText(page.container, "Вступление") as HTMLTextAreaElement, "Недопустимая запись");expect(sourceNow()).toBe(source);
  await click(getByRole(page.container, "button", { name: "Исходник" }));
  expect((getByLabelText(page.container, "Исходник журнала") as HTMLTextAreaElement).disabled).toBe(true);
});

it("debounces full preview and aborts old requests; late response cannot overwrite the new source", async () => {
  let oldResolve!: (value: MaterialText) => void, newResolve!: (value: MaterialText) => void;
  const preview = vi.spyOn(materialsApi, "preview").mockImplementationOnce(() => new Promise(resolve => { oldResolve = resolve; })).mockImplementationOnce(() => new Promise(resolve => { newResolve = resolve; }));
  function Harness() { const [source, setSource] = useState("old");return <><button onClick={() => setSource("new")}>Изменить</button><JournalPreview material={material()} source={source} title="Текущее название" /></>; }
  page = await mountWorkspace(<Harness />);await debounce();expect(preview).toHaveBeenCalledTimes(1);
  await click(getByRole(page.container, "button", { name: "Изменить" }));expect(preview.mock.calls[0][2]?.aborted).toBe(true);await debounce();
  await act(async () => newResolve({ format: "journal-v1", body: "new" }));await settle();
  await act(async () => oldResolve({ format: "journal-v1", body: "old" }));await settle();
  expect(page.container.querySelector("[data-preview-source]")?.getAttribute("data-preview-source")).toBe("new");expect(getByRole(page.container, "heading", { name: "Текущее название" })).toBeDefined();
});

it("takes a compiler diagnostic back to the corresponding editable block and focuses its fields", async () => {
  const document = importJournal("## Начало\nТекст", "markdown"), note = newJournalBlock("note");document.sections[0].blocks.push(note);
  vi.spyOn(materialsApi, "preview").mockImplementation(async (_id, request) => ({ ...request.content, render: { schema_version: 2, policy_version: 1, source_hash: "0".repeat(64), document: null, legacy: [], file_ids: [], image_file_ids: [], diagnostics: [{ code: "bad_body", line: 1, block_id: note.id, message: "Добавьте текст плашки." }] } }));
  page = await mountWorkspace(<Editor source={journalSource(document)} />);await click(getByRole(page.container, "button", { name: "Предпросмотр" }));await debounce();
  await click(getByRole(page.container, "button", { name: "Исправить: Добавьте текст плашки." }));
  const title = getByLabelText(page.container, "Заголовок плашки");expect(window.document.activeElement).toBe(title);expect(getByLabelText(page.container, "Текст плашки")).toBeDefined();
});

it("uploads images in the material context atomically and releases the busy guard", async () => {
  const document = importJournal("Текст", "markdown"), picture = newJournalBlock("image");document.sections[0].blocks.push(picture);
  const upload = vi.spyOn(filesApi, "upload").mockResolvedValue({ file_id: "image-one", name: "picture.png", mime_type: "image/png", size_bytes: 4 });
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:journal") });Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Image", class { src = "";naturalWidth = 1600;naturalHeight = 900;decode = async () => {}; });
  page = await mountWorkspace(<Editor source={journalSource(document)} />);await click(getByRole(page.container, "button", { name: "Изображение" }));
  const input = getByLabelText(page.container, "Файл изображения") as HTMLInputElement;Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "picture.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  expect(upload.mock.calls[0][1]).toEqual({ owner_kind: "material", owner_id: material().material_id, purpose: "material" });
  expect(JSON.parse(sourceNow()).sections[0].blocks[1]).toMatchObject({ id: picture.id, file_id: "image-one", width: 1280, height: 720 });expect(page.container.querySelector("[data-busy]")!.textContent).toBe("false");
});

it("cancels uploads outside the disabled fieldset and ignores late completion", async () => {
  let finish!: (value: Awaited<ReturnType<typeof filesApi.upload>>) => void;
  const upload = vi.spyOn(filesApi, "upload").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:journal") });Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Image", class { src = "";naturalWidth = 100;naturalHeight = 100;decode = async () => {}; });
  const document = importJournal("Текст", "markdown");document.sections[0].blocks.push(newJournalBlock("image"));const source = journalSource(document);
  page = await mountWorkspace(<Editor source={source} />);await click(getByRole(page.container, "button", { name: "Изображение" }));
  const input = getByLabelText(page.container, "Файл изображения") as HTMLInputElement;Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "picture.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  const cancel = getByRole(window.document.body, "button", { name: "Отменить загрузку" });expect((cancel as HTMLButtonElement).disabled).toBe(false);await click(cancel);
  expect(upload.mock.calls[0][3]?.aborted).toBe(true);await act(async () => finish({ file_id: "late", name: "picture.png", mime_type: "image/png", size_bytes: 4 }));
  expect(sourceNow()).toBe(source);expect(page.container.querySelector("[data-busy]")!.textContent).toBe("false");
});
