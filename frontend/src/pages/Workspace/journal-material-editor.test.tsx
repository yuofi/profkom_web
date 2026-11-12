// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { getByLabelText, getByRole, queryByRole } from "@testing-library/dom";
import { MaterialEditor } from "./MaterialEditor";
import { createFixtures } from "../../mocks/fixtures";
import type { Material, MaterialText } from "../../utils/api/contract";
import { materialsApi } from "../../utils/api/materials.api";
import { filesApi } from "../../utils/api/files.api";
import { importJournal, journalSource, newJournalBlock } from "../../components/Workspace/journalEditorModel";
import { change, mountWorkspace, settle, waitForPage } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;vi.restoreAllMocks();vi.unstubAllGlobals(); });
const guide = (content: MaterialText): Material => ({ ...createFixtures("chair").materials[0], kind: "guide", source_content: content, draft_content: content, capabilities: ["edit_material", "edit_html_material", "publish_material"] });
async function click(element: HTMLElement) { await act(async () => element.click());await settle(); }

it("requires explicit conversion, preserves the exact old source until save and never publishes implicitly", async () => {
  const source = "## Гайд\n\n```profkom-html id=example\n<p>Пример</p>\n```\n";
  const publish = vi.spyOn(materialsApi, "publish"), update = vi.spyOn(materialsApi, "update");
  page = await mountWorkspace(<MaterialEditor material={guide({ format: "markdown-embeds-v1", body: source })} />);
  await click(getByRole(page.container, "button", { name: "Перейти к Журналу" }));
  const convert = getByRole(page.container, "button", { name: "Преобразовать в Журнал" });expect((convert as HTMLButtonElement).disabled).toBe(true);
  await click(getByRole(page.container, "checkbox", { name: "Преобразовать сохранённый текст в Журнал" }));await click(convert);
  await waitForPage(page, () => !!queryByRole(page!.container, "region", { name: "Редактор журнала" }));
  await click(getByRole(page.container, "button", { name: "Исходник" }));
  const document = JSON.parse((getByLabelText(page.container, "Исходник журнала") as HTMLTextAreaElement).value);
  expect(document.sections[0].blocks[0]).toMatchObject({ type: "legacy", body: source });
  await click(getByRole(page.container, "button", { name: "Вернуть текст до преобразования" }));
  await waitForPage(page, () => !!page!.container.querySelector('[name="body"]'));
  expect((page.container.querySelector('[name="body"]') as HTMLTextAreaElement).value).toBe(source);
  expect(update).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled();
});

it("keeps malformed journal source editable and prevents publication of its saved draft", async () => {
  const content: MaterialText = { format: "journal-v1", body: '{"unfinished":', render: { schema_version: 2, policy_version: 1, source_hash: "0".repeat(64), document: null, legacy: [], diagnostics: [{ code: "invalid_json", block_id: null, line: 1, message: "Проверьте JSON." }], file_ids: [], image_file_ids: [] } };
  page = await mountWorkspace(<MaterialEditor material={guide(content)} />);
  await waitForPage(page, () => !!queryByRole(page!.container, "region", { name: "Редактор журнала" }));
  const input = getByLabelText(page.container, "Исходник журнала") as HTMLTextAreaElement;
  expect(input.value).toBe(content.body);await change(input, '{"still":');expect(input.value).toBe('{"still":');
  expect((getByRole(page.container, "button", { name: "Опубликовать сохранённый черновик" }) as HTMLButtonElement).disabled).toBe(true);
  expect((getByRole(page.container, "button", { name: "Сохранить черновик" }) as HTMLButtonElement).disabled).toBe(false);
});

it("does not offer journal conversion without the dedicated formatting capability", async () => {
  const data = guide({ format: "markdown", body: "Обычный гайд" });data.capabilities = ["edit_material"];
  page = await mountWorkspace(<MaterialEditor material={data} />);
  expect(queryByRole(page.container, "button", { name: "Перейти к Журналу" })).toBeNull();
});

it("keeps upload cancellation reachable while ActionForm disables its whole fieldset", async () => {
  const source = importJournal("Текст", "markdown");source.sections[0].blocks.push(newJournalBlock("image"));
  let finish!: (value: Awaited<ReturnType<typeof filesApi.upload>>) => void;
  const upload = vi.spyOn(filesApi, "upload").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:journal") });Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  vi.stubGlobal("Image", class { src = "";naturalWidth = 100;naturalHeight = 100;decode = async () => {}; });
  page = await mountWorkspace(<MaterialEditor material={guide({ format: "journal-v1", body: journalSource(source) })} />);
  await waitForPage(page, () => !!queryByRole(page!.container, "region", { name: "Редактор журнала" }));
  await click(getByRole(page.container, "button", { name: "Изображение" }));
  const input = getByLabelText(page.container, "Файл изображения") as HTMLInputElement;Object.defineProperty(input, "files", { configurable: true, value: [new File(["test"], "picture.png", { type: "image/png" })] });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));await settle();
  expect(input.matches(":disabled")).toBe(true);
  const cancel = getByRole(document.body, "button", { name: "Отменить загрузку" });expect(cancel.matches(":disabled")).toBe(false);await click(cancel);
  expect(upload.mock.calls[0][3]?.aborted).toBe(true);expect(input.matches(":disabled")).toBe(false);
  await act(async () => finish({ file_id: "late", name: "picture.png", mime_type: "image/png", size_bytes: 4 }));await settle();
  await click(getByRole(page.container, "button", { name: "Исходник" }));expect((getByLabelText(page.container, "Исходник журнала") as HTMLTextAreaElement).value).toBe(journalSource(source));
});
