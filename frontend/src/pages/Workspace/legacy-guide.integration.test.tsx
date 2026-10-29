// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { act } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import axios from "axios";
import { liveLogin, liveParticipant, livePassword, liveLegacyGuide } from "../../test/liveApi";
import { mountWorkspace, waitForPage, change, submit } from "../../test/workspace";
import { materialsApi } from "../../utils/api/materials.api";
import { api } from "../../utils/api";
import { LegacyMaterialRedirect } from "./LegacyMaterialRedirect";
import { MaterialPage } from "./MaterialPages";
import { openMaterialEditor } from "../../test/materialEditor";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
function Location() {
  return <output aria-label="Текущий путь">{useLocation().pathname}</output>;
}
const until = (predicate: () => boolean) => waitForPage(page!, predicate);
const publishButton = () => Array.from(page!.container.querySelectorAll("button")).find(b => b.textContent === "Опубликовать сохранённый черновик");
function form(label: string) {
  const button = Array.from(page!.container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(button).toBeDefined();
  return button!.closest("form")!;
}
async function finishEditing() {
  const done = [...page!.container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Готово")!;
  expect(done).toBeDefined();await act(async () => done.click());await until(() => !page!.container.querySelector("textarea"));
}

it.each(["/docs/:id", "/docs/:id/edit", "/guides/:id"])("L2: real old URL %s opens the current material, saves a private draft, then publishes separately", async oldPath => {
  const reader = await liveParticipant("legacy-reader");
  const session = await liveLogin();
  const oldBody = "**Старая публикация L2**\n\nТекст и [ссылка](https://example.com/guide).";
  const newBody = "**Новая публикация L2**\n\n- Один\n- Два\n\nСохранённый перенос.";
  const guide = await liveLegacyGuide({ title: "Старый гайд — L2", owner_block: "none", text: oldBody });
  expect(guide.material_id).toBeTruthy();
  const materialId = guide.material_id!;
  const readonly = axios.create({ baseURL: api.defaults.baseURL, timeout: 10000 });
  const login = await readonly.post("/auth/login", { email: reader.email, password: livePassword });
  readonly.defaults.headers.common.Authorization = `Bearer ${login.data.access_token}`;
  const mount = () => mountWorkspace(<><Location /><Routes>
    <Route path={oldPath} element={<LegacyMaterialRedirect />} />
    <Route path="/materials/:id" element={<MaterialPage />} />
  </Routes></>, { path: oldPath.replace(":id", String(guide.guide_id)), session });
  page = await mount();
  await openMaterialEditor(page);
  expect(page.container.querySelector('[aria-label="Текущий путь"]')?.textContent).toBe(`/materials/${materialId}`);
  expect(page.container.textContent).toContain("Сохраните изменения в черновик");
  expect(page.container.textContent).not.toContain("изменения сразу видны читателям");
  await change(page.container.querySelector("textarea")!, newBody);
  await submit(form("Сохранить черновик"));
  // The publish button is always rendered; it becomes enabled once the saved draft exists.
  await until(() => page!.container.textContent!.includes("Изменения сохранены") && publishButton()?.disabled === false);
  const draft = await materialsApi.get(materialId);
  expect(draft.draft_content?.body).toBe(newBody);
  expect(draft.published_content?.body).toBe(oldBody);
  const readerDraft = (await readonly.get(`/materials/${materialId}`)).data;
  expect(readerDraft.published_content.body).toBe(oldBody);
  expect(readerDraft).not.toHaveProperty("draft_content");
  expect((await readonly.get(`/materials/legacy-guides/${guide.guide_id}`)).data.material_id).toBe(materialId);
  await finishEditing();
  expect(page.container.textContent).toContain("Старая публикация L2");
  await openMaterialEditor(page);
  const publication = form("Опубликовать сохранённый черновик");
  await submit(publication);
  await until(() => !!publication.textContent?.includes("Изменения сохранены"));
  expect((await materialsApi.get(materialId)).published_content?.body).toBe(newBody);
  expect((await readonly.get(`/materials/legacy-guides/${guide.guide_id}`)).data.material_id).toBe(materialId);
  expect((await readonly.get(`/materials/${materialId}`)).data.published_content.body).toBe(newBody);
  await finishEditing();expect(page.container.textContent).toContain("Новая публикация L2");
  await page.cleanup(); page = await mount();
  await openMaterialEditor(page);
  expect(page.container.querySelector('[aria-label="Текущий путь"]')?.textContent).toBe(`/materials/${materialId}`);
  expect(page.container.querySelector("textarea")!.value).toBe(newBody);
  expect(page.container.textContent).toContain("Новая публикация L2");
  expect((await materialsApi.resolveLegacyGuide(guide.guide_id)).material_id).toBe(materialId);
});
