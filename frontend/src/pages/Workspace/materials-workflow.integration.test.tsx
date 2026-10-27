// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import axios from "axios";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { change, field, mountWorkspace, submit, waitForPage } from "../../test/workspace";
import { openMaterialEditor } from "../../test/materialEditor";
import { api } from "../../utils/api";
import { materialsApi } from "../../utils/api/materials.api";
import { richText } from "../../utils/api/contract";
import { MaterialsPage, MaterialCreatePage, MaterialPage } from "./MaterialPages";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
function Location() { return <output aria-label="Текущий путь материала">{useLocation().pathname}</output>; }
const routes = <><Location /><Routes><Route path="/materials" element={<MaterialsPage />} /><Route path="/materials/new" element={<MaterialCreatePage />} /><Route path="/materials/:id" element={<MaterialPage />} /></Routes></>;
const until = (condition: () => boolean) => waitForPage(page!, condition);
const path = () => page!.container.querySelector('[aria-label="Текущий путь материала"]')?.textContent ?? "";
function form(label: string) {
  const result = [...page!.container.querySelectorAll<HTMLFormElement>("form")].find(item => item.querySelector('button[type="submit"]')?.textContent === label);
  expect(result, label).toBeDefined();return result!;
}
async function command<T>(run: () => Promise<T>) { let result!: T;await act(async () => { result = await run(); });return result; }
async function click(label: string) {
  const button = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);expect(button, label).toBeDefined();
  await act(async () => button!.click());await waitForPage(page!);
}
async function readerClient(email: string) {
  const client = axios.create({ baseURL: api.defaults.baseURL, timeout: 10000, validateStatus: () => true });
  const response = await client.post("/auth/login", { email, password: livePassword });expect(response.status).toBe(200);
  client.defaults.headers.common.Authorization = `Bearer ${response.data.access_token}`;return client;
}
it("creates from a blank material page, opens readonly, and publishes a saved draft only through the pencil", async () => {
  const reader = await liveParticipant("canvas-reader"), readonly = await readerClient(reader.email), session = await liveLogin();
  page = await mountWorkspace(routes, { path: "/materials", session });await waitForPage(page);
  expect(page.container.querySelector('input[name="title"],textarea[name="body"]')).toBeNull();
  const create = page.container.querySelector<HTMLAnchorElement>('a[href="/materials/new"]')!;expect(create).not.toBeNull();
  await act(async () => create.click());await until(() => !!page!.container.querySelector('textarea[name="body"]'));
  expect(path()).toBe("/materials/new");expect(field(page.container, "title").value).toBe("");expect(field(page.container, "description").value).toBe("");expect(field(page.container, "body").value).toBe("");
  const title = `Материал canvas ${crypto.randomUUID()}`, first = "## Частный черновик\n\nПервый текст", next = "## Опубликованный результат\n\n- [x] Проверено";
  await change(field(page.container, "title"), title);await change(field(page.container, "description"), "Описание из правой колонки");await change(field(page.container, "kind"), "general");await change(field(page.container, "body"), first);
  await submit(form("Создать черновик"));await until(() => path().startsWith("/materials/") && path() !== "/materials/new" && !page!.container.querySelector("textarea"));
  const id = path().split("/").pop()!;expect(document.querySelector("dialog[open]")).toBeNull();
  let material = await command(() => materialsApi.get(id));expect(material.source_content?.body).toBe(first);expect(material.draft_content?.body).toBe(first);expect(material.published_content).toBeNull();
  expect((await readonly.get(`/materials/${id}`)).status).toBe(404);expect(page.container.textContent).not.toContain("Редакторы общего материала");expect(page.container.textContent).not.toContain("Удалить материал");
  await openMaterialEditor(page);expect(page.container.textContent).toContain("Редакторы общего материала");expect(page.container.textContent).toContain("Удалить материал");
  await change(field(page.container, "body"), next);await change(field(page.container, "description"), "Обновлённая правая колонка");
  const save = form("Сохранить черновик");await submit(save);await until(() => !!save.textContent?.includes("Изменения сохранены"));
  material = await command(() => materialsApi.get(id));expect(material.description).toBe("Обновлённая правая колонка");expect(material.source_content?.body).toBe(next);expect((await readonly.get(`/materials/${id}`)).status).toBe(404);
  const publication = form("Опубликовать сохранённый черновик");await submit(publication);await until(() => !!publication.textContent?.includes("Изменения сохранены"));
  const published = await readonly.get(`/materials/${id}`);expect(published.status).toBe(200);expect(published.data.published_content.body).toBe(next);expect(published.data).not.toHaveProperty("source_content");
  await click("Готово");await until(() => !page!.container.querySelector("textarea"));expect(page.container.textContent).toContain("Опубликованный результат");expect(page.container.querySelector('button[aria-label="Редактировать материал"]')).not.toBeNull();
});
it("keeps management behind the pencil, deletes a clean material without a false leave guard, and preserves it through restoration", async () => {
  const editor = await liveParticipant("canvas-editor"), session = await liveLogin();
  let material = await materialsApi.create({ kind: "general", title: `Удаление canvas ${crypto.randomUUID()}`, description: "Сохранённый материал", content: richText("Сохраняемая публикация") });
  material = { ...material, ...await materialsApi.editors(material.material_id, [editor.user_id], { expected_revision: material.revision }) };material = await materialsApi.publish(material.material_id, { expected_revision: material.revision });
  page = await mountWorkspace(routes, { path: `/materials/${material.material_id}`, session });await waitForPage(page);
  expect(page.container.querySelector("form,textarea")).toBeNull();expect(page.container.textContent).not.toContain("Редакторы общего материала");
  await openMaterialEditor(page);expect(page.container.textContent).toContain("Редакторы общего материала");
  const deletion = [...page.container.querySelectorAll<HTMLElement>("summary")].find(item => item.textContent === "Удалить материал")!;expect(deletion).toBeDefined();await act(async () => deletion.click());
  await submit(form("Удалить материал"));await until(() => path() === "/materials");expect(document.querySelector("dialog[open]")).toBeNull();
  const deleted = (await command(() => materialsApi.deleted())).items.find(item => item.material_id === material.material_id)!;expect(deleted).toBeDefined();
  await page.cleanup();page = undefined;
  const restored = await materialsApi.restore(material.material_id, { expected_revision: deleted.revision });expect(restored.editor_user_ids).toContain(editor.user_id);expect(restored.published_content?.body).toBe("Сохраняемая публикация");
  page = await mountWorkspace(routes, { path: `/materials/${material.material_id}`, session });await waitForPage(page);expect(page.container.querySelector("form,textarea")).toBeNull();expect(page.container.textContent).toContain("Сохраняемая публикация");
});
