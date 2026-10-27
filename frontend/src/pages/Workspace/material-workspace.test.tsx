// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MaterialCreatePage, MaterialPage, MaterialsPage } from "./MaterialPages";
import { UnsavedChangesProvider } from "../../components/Workspace/UnsavedChanges";
import { forgetOwnChanges } from "../../components/Workspace/ownRevisions";
import { installMockTransport } from "../../mocks/transport";
import { createFixtures } from "../../mocks/fixtures";
import { SessionContext } from "../../utils/session";
import { materialsApi } from "../../utils/api/materials.api";
import { ApiError } from "../../utils/api/request";
import { richText } from "../../utils/api/contract";
import { workspaceQueryCache } from "../../utils/api/invalidation";
import { change, field, mountWorkspace, settle, submit, waitForPage } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
let dataPage: Awaited<ReturnType<typeof mountGuarded>> | undefined;
let mock: ReturnType<typeof installMockTransport> | undefined;
beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});
afterEach(async () => { await page?.cleanup();page = undefined;await dataPage?.cleanup();dataPage = undefined;mock?.restore();mock = undefined;vi.restoreAllMocks(); });
const form = (root: ParentNode, label: string) => Array.from(root.querySelectorAll<HTMLFormElement>("form")).find(item => item.querySelector('button[type="submit"]')?.textContent === label)!;
const button = (root: ParentNode, label: string) => Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;
async function click(element: HTMLElement) { expect(element).toBeDefined();await act(async () => element.click());await settle(); }
async function open() {
  page = await mountWorkspace(<Routes><Route path="/materials" element={<MaterialsPage />} /><Route path="/materials/new" element={<MaterialCreatePage />} /><Route path="/materials/:id" element={<MaterialPage />} /></Routes>, { path: "/materials/material-1" });
  await waitForPage(page);return page;
}
async function mountGuarded(path = "/materials/material-1") {
  const container = document.createElement("div");document.body.append(container);
  const root = createRoot(container), client = new QueryClient({ queryCache: workspaceQueryCache(), defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const router = createMemoryRouter([{ element: <UnsavedChangesProvider><Outlet /></UnsavedChangesProvider>, children: [
    { path: "/materials", element: <MaterialsPage /> }, { path: "/materials/new", element: <MaterialCreatePage /> }, { path: "/materials/:id", element: <MaterialPage /> },
  ] }], { initialEntries: [path] });
  await act(async () => root.render(<QueryClientProvider client={client}><SessionContext.Provider value={{ session: createFixtures("chair").session, loading: false, error: null, refresh: () => {} }}><RouterProvider router={router} /></SessionContext.Provider></QueryClientProvider>));
  const result = { container, client, router, cleanup: async () => { await act(async () => root.unmount());router.dispose();client.clear();forgetOwnChanges(client);container.remove(); } };
  await waitForPage(result);return result;
}

it("opens published content read-only and only the pencil reveals the stored editing source", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const m = mock.state.materials[0];m.published_content = richText("ОПУБЛИКОВАННЫЙ ТЕКСТ");m.draft_content = richText("СЫРОЙ ЧЕРНОВИК [файл](file:local-source)");
  await open();
  expect(page!.container.querySelector("form")).toBeNull();
  expect(page!.container.textContent).toContain("ОПУБЛИКОВАННЫЙ ТЕКСТ");
  expect(page!.container.textContent).not.toContain("СЫРОЙ ЧЕРНОВИК");
  await click(button(page!.container, "Редактировать материал"));
  expect(field(page!.container, "body").value).toBe(m.draft_content.body);
  expect(page!.container.textContent).not.toContain("Справка по Markdown");
  const publication = form(page!.container, "Опубликовать сохранённый черновик");
  await change(field(page!.container, "body"), "НЕСОХРАНЁННЫЙ ВВОД");
  await submit(publication);
  expect(m.published_content?.body).toBe("СЫРОЙ ЧЕРНОВИК [файл](file:local-source)");
  expect(field(page!.container, "body").value).toBe("НЕСОХРАНЁННЫЙ ВВОД");
});

it("creates a source draft on a separate page and never publishes it implicitly", async () => {
  mock = installMockTransport("chair", { delay: 0 });dataPage = await mountGuarded("/materials");
  expect(dataPage.container.querySelector('[name="title"]')).toBeNull();
  await click(dataPage.container.querySelector<HTMLAnchorElement>('a[href="/materials/new"]')!);
  await waitForPage(dataPage);
  expect(dataPage.router.state.location.pathname).toBe("/materials/new");
  expect(field(dataPage.container, "body").value).toBe("");
  await change(field(dataPage.container, "title"), "Новый исходник");
  await change(field(dataPage.container, "description"), "Памятка команды");
  await change(field(dataPage.container, "kind"), "general");
  await change(field(dataPage.container, "body"), "# Черновик\n\n- [ ] Проверить");
  const publish = vi.spyOn(materialsApi, "publish");
  await submit(form(dataPage.container, "Создать черновик"));await waitForPage(dataPage);
  const created = mock.state.materials.find(item => item.title === "Новый исходник")!;
  expect(created.draft_content?.body).toBe("# Черновик\n\n- [ ] Проверить");
  expect(created.published_content).toBeNull();expect(publish).not.toHaveBeenCalled();
  expect(dataPage.router.state.location.pathname).toBe(`/materials/${created.material_id}`);
  expect(dataPage.container.querySelector("form")).toBeNull();
  expect(dataPage.container.querySelector("dialog")).toBeNull();
});

it.each(["edit_material", "publish_material", "edit_audience", "delete_material", "manage_material_editors"])("keeps the editor entry for the independent capability %s", async capability => {
  mock = installMockTransport("chair", { delay: 0 });
  const m = mock.state.materials[0];m.capabilities = capability === "manage_material_editors" ? [] : [capability];
  m.owner_block_id = capability === "manage_material_editors" ? null : "block-it";
  await open();expect(page!.container.querySelector("form")).toBeNull();
  await click(button(page!.container, "Редактировать материал"));
  expect(page!.container.querySelector('[name="body"]') !== null).toBe(capability === "edit_material");
  if (capability === "publish_material") expect(form(page!.container, "Опубликовать сохранённый черновик")).toBeDefined();
  if (capability === "edit_audience") expect(field(page!.container, "audience")).toBeDefined();
  if (capability === "delete_material") expect(form(page!.container, "Удалить материал")).toBeDefined();
  if (capability === "manage_material_editors") expect(form(page!.container, "Установить состав редакторов")).toBeDefined();
});

it("hides cached names and private source after a denied refetch and returns to read-only on recovery", async () => {
  mock = installMockTransport("chair", { delay: 0 });await open();
  const m = mock.state.materials[0];await click(button(page!.container, "Редактировать материал"));
  await change(field(page!.container, "body"), "ЛОКАЛЬНЫЙ СЕКРЕТНЫЙ ЧЕРНОВИК");
  const get = vi.spyOn(materialsApi, "get").mockRejectedValue(new ApiError("Доступ закрыт", 403));
  await act(async () => { await page!.client.invalidateQueries({ queryKey: ["materials", m.material_id] }); });await waitForPage(page!);
  expect(page!.container.querySelector("form")).toBeNull();expect(page!.container.textContent).not.toContain(m.title);
  expect(page!.container.textContent).not.toContain("ЛОКАЛЬНЫЙ СЕКРЕТНЫЙ ЧЕРНОВИК");
  get.mockRestore();await act(async () => { await page!.client.invalidateQueries({ queryKey: ["materials", m.material_id] }); });await waitForPage(page!);
  expect(page!.container.querySelector("form")).toBeNull();expect(button(page!.container, "Редактировать материал")).toBeDefined();
});

it.each(["discard", "save"])("guards leaving edit mode and can %s without publishing", async choice => {
  mock = installMockTransport("chair", { delay: 0 });dataPage = await mountGuarded();
  await click(button(dataPage.container, "Редактировать материал"));
  const before = mock.state.materials[0].description;
  await change(field(dataPage.container, "description"), "Новая метаинформация");
  const update = vi.spyOn(materialsApi, "update"), publish = vi.spyOn(materialsApi, "publish");
  await click(button(dataPage.container, "Готово"));expect(dataPage.container.querySelector("dialog[open]")).not.toBeNull();
  await click(button(dataPage.container, "Остаться"));expect(field(dataPage.container, "description").value).toBe("Новая метаинформация");
  await click(button(dataPage.container, "Готово"));await click(button(dataPage.container, choice === "save" ? "Сохранить и перейти" : "Уйти без сохранения"));await waitForPage(dataPage);
  expect(dataPage.container.querySelector("form")).toBeNull();expect(publish).not.toHaveBeenCalled();
  expect(mock.state.materials[0].description).toBe(choice === "save" ? "Новая метаинформация" : before);
  expect(update).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
});

it("does not delete an unsaved draft before the scoped exit choice", async () => {
  mock = installMockTransport("chair", { delay: 0 });dataPage = await mountGuarded();
  await click(button(dataPage.container, "Редактировать материал"));await change(field(dataPage.container, "body"), "Ещё не сохранено");
  const remove = vi.spyOn(materialsApi, "remove");
  await submit(form(dataPage.container, "Удалить материал"));expect(remove).not.toHaveBeenCalled();
  expect(dataPage.container.querySelector("dialog[open]")).not.toBeNull();
  await click(button(dataPage.container, "Остаться"));expect(remove).not.toHaveBeenCalled();
  await submit(form(dataPage.container, "Удалить материал"));await click(button(dataPage.container, "Уйти без сохранения"));await waitForPage(dataPage);
  expect(remove).toHaveBeenCalledTimes(1);expect(dataPage.router.state.location.pathname).toBe("/materials");
});

it("deletes a clean material without an unrelated unsaved confirmation", async () => {
  mock = installMockTransport("chair", { delay: 0 });dataPage = await mountGuarded();
  await click(button(dataPage.container, "Редактировать материал"));
  const remove = vi.spyOn(materialsApi, "remove");
  await submit(form(dataPage.container, "Удалить материал"));await waitForPage(dataPage);
  expect(remove).toHaveBeenCalledTimes(1);expect(dataPage.router.state.location.pathname).toBe("/materials");
  expect(dataPage.container.querySelector("dialog")).toBeNull();
});
