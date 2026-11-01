// @vitest-environment jsdom
import { act } from "react";
import { Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { installMockTransport } from "../../mocks/transport";
import { change, field, mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";
import { LegacyMaterialRedirect } from "./LegacyMaterialRedirect";
import { MaterialCreatePage, MaterialPage, MaterialsPage } from "./MaterialPages";
import { materialsApi } from "../../utils/api/materials.api";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined, mock: ReturnType<typeof installMockTransport> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const routes = <Routes>
  <Route path="/materials" element={<MaterialsPage />} /><Route path="/materials/new" element={<MaterialCreatePage />} /><Route path="/materials/:id" element={<MaterialPage />} />
  <Route path="/docs/:id" element={<LegacyMaterialRedirect />} /><Route path="/guides/:id" element={<LegacyMaterialRedirect />} />
</Routes>;

it("keeps the way back on a closed material and sends old links to the material or a clear dead end", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  page = await mountWorkspace(routes, { path: "/materials/material-absent" });await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Материал недоступен");
  expect(page.container.textContent).toContain("Материал не найден или доступ к нему закрыт.");
  expect(page.container.querySelector('a[href="/materials"]')).not.toBeNull();expect(page.container.textContent).not.toContain("Обновить данные");
  await page.cleanup();
  page = await mountWorkspace(routes, { path: "/docs/material-kmb" });await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe(mock.state.materials.find(m => m.material_id === "material-kmb")!.title);
  await page.cleanup();
  page = await mountWorkspace(routes, { path: "/guides/987654" });await waitForPage(page);
  expect(page.container.textContent).toContain("Материал не найден или больше недоступен.");
  expect(page.container.textContent).not.toContain("Проверьте введённые данные");expect([...page.container.querySelectorAll('a[href="/materials"]')].some(link => link.textContent === "Все материалы")).toBe(true);
});

it("puts finished materials first, folds guides in preparation and keeps the search in the URL", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const template = mock.state.materials[0];
  mock.state.materials = [
    ...Array.from({ length: 3 }, (_, i) => ({ ...template, material_id: `placeholder-${i}`, kind: "guide", placeholder: true, title: `Гайд заготовка ${i}`, description: "Материалы блока" })),
    ...mock.state.materials.map(m => ({ ...m, placeholder: false })),
  ];
  page = await mountWorkspace(routes, { path: "/materials?q=заготовка" });await waitForPage(page);
  const preparing = [...page.container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.startsWith("Гайды блоков в подготовке"))!;
  expect(preparing.querySelector("summary")?.textContent).toBe("Гайды блоков в подготовке · 3");expect(preparing.open).toBe(true);
  expect(page.container.querySelector<HTMLInputElement>("input")?.value).toBe("заготовка");
  await change(page.container.querySelector<HTMLInputElement>("input")!, "");
  const folded = [...page.container.querySelectorAll("details")].find(item => item.querySelector("summary")?.textContent?.startsWith("Гайды блоков в подготовке"))!;
  expect(folded.open).toBe(false);
  const first = page.container.querySelector("h2")!;expect(first.closest("details")).toBeNull();expect(first.textContent).not.toContain("заготовка");
});

it("asks for every missing field at once in the main form and clears each mark on its edit", async () => {
  mock = installMockTransport("chair", { delay: 0 });const create = vi.spyOn(materialsApi, "create");
  page = await mountWorkspace(routes, { path: "/materials/new" });await waitForPage(page);
  const form = [...page.container.querySelectorAll("form")].find(item => item.querySelector('button[type="submit"]')?.textContent === "Создать черновик")!;
  // Description and link stand in the main form, before its button (GL-43).
  const description = field(form, "description"), button = form.querySelector('button[type="submit"]')!;
  expect(description.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(field(form, "original")).toBeDefined();
  expect(field(form, "title").tagName).toBe("TEXTAREA");
  await submit(form);await settle();
  expect(create).not.toHaveBeenCalled();
  for (const name of ["title", "description", "kind"]) expect(field(page.container, name).getAttribute("aria-invalid")).toBe("true");
  await change(field(page.container, "title"), "Новый\nматериал");
  expect(field(page.container, "title").value).toBe("Новый материал");expect(field(page.container, "title").hasAttribute("aria-invalid")).toBe(false);
  expect(field(page.container, "description").getAttribute("aria-invalid")).toBe("true");
  await act(async () => {});
});
