// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { Route, Routes, useLocation } from "react-router-dom";
import axios from "axios";
import { liveLogin, liveParticipant, livePassword } from "../../test/liveApi";
import { mountWorkspace, settle, change, submit } from "../../test/workspace";
import { guidesApi } from "../../utils/api/guides.api";
import { materialsApi } from "../../utils/api/materials.api";
import { api } from "../../utils/api";
import { DocEditPage } from "../DocEditPage/DocEditPage";
import { MaterialPage } from "./MaterialPages";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup(); page = undefined; });
function Location() {
  return <output aria-label="Текущий путь">{useLocation().pathname}</output>;
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100 && !predicate(); i++) await settle();
  expect(predicate()).toBe(true);
}
function form(label: string) {
  const button = Array.from(page!.container.querySelectorAll("button")).find(b => b.textContent === label);
  expect(button).toBeDefined();
  return button!.closest("form")!;
}

it("L2: a real legacy URL opens its material, saves a private draft, then publishes separately", async () => {
  const reader = await liveParticipant("legacy-reader");
  const session = await liveLogin();
  const oldBody = "**Старая публикация L2**\n\nТекст и [ссылка](https://example.com/guide).";
  const newBody = "**Новая публикация L2**\n\n- Один\n- Два\n\nСохранённый перенос.";
  const guide = await guidesApi.create({ title: "Старый гайд — L2", owner_block: "none", text: oldBody });
  expect(guide.material_id).toBeTruthy();
  const materialId = guide.material_id!;
  const readonly = axios.create({ baseURL: api.defaults.baseURL, timeout: 10000 });
  const login = await readonly.post("/auth/login", { email: reader.email, password: livePassword });
  readonly.defaults.headers.common.Authorization = `Bearer ${login.data.access_token}`;
  const mount = () => mountWorkspace(<><Location /><Routes>
    <Route path="/docs/:id/edit" element={<DocEditPage />} />
    <Route path="/materials/:id" element={<MaterialPage />} />
  </Routes></>, { path: `/docs/${guide.guide_id}/edit`, session });
  page = await mount();
  await until(() => !!page!.container.querySelector("textarea"));
  expect(page.container.querySelector('[aria-label="Текущий путь"]')?.textContent).toBe(`/materials/${materialId}`);
  expect(page.container.textContent).toContain("Изменения сохраняются в черновик");
  expect(page.container.textContent).not.toContain("изменения сразу видны читателям");
  await change(page.container.querySelector("textarea")!, newBody);
  await submit(form("Сохранить черновик"));
  await until(() => page!.container.textContent!.includes("Опубликовать сохранённый черновик"));
  const draft = await materialsApi.get(materialId);
  expect(draft.draft_content?.body).toBe(newBody);
  expect(draft.published_content?.body).toBe(oldBody);
  const readerDraft = (await readonly.get(`/materials/${materialId}`)).data;
  expect(readerDraft.published_content.body).toBe(oldBody);
  expect(readerDraft).not.toHaveProperty("draft_content");
  expect((await readonly.get(`/guides/${guide.guide_id}`)).data.text).toBe(oldBody);
  expect(page.container.textContent).toContain("Старая публикация L2");
  await submit(form("Опубликовать сохранённый черновик"));
  await until(() => !page!.container.textContent!.includes("Опубликовать сохранённый черновик"));
  expect((await materialsApi.get(materialId)).published_content?.body).toBe(newBody);
  expect((await readonly.get(`/guides/${guide.guide_id}`)).data.text).toBe(newBody);
  expect((await readonly.get(`/materials/${materialId}`)).data.published_content.body).toBe(newBody);
  await page.cleanup(); page = await mount();
  await until(() => !!page!.container.querySelector("textarea"));
  expect(page.container.querySelector('[aria-label="Текущий путь"]')?.textContent).toBe(`/materials/${materialId}`);
  expect(page.container.querySelector("textarea")!.value).toBe(newBody);
  expect(page.container.textContent).toContain("Новая публикация L2");
  expect((await guidesApi.getById(guide.guide_id)).material_id).toBe(materialId);
});
