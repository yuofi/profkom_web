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
  // The first section's title, then its first card: titled one level below (D-09).
  const first = page.container.querySelector("h3")!;expect(first.closest("details")).toBeNull();expect(first.textContent).not.toContain("заготовка");
  expect(page.container.querySelector("h2")?.textContent).toBe("КМБ · 1");expect(first.textContent).toBe("КМБ");
});

const sections = () => [...page!.container.querySelectorAll("h2")].filter(heading => !heading.closest('[class*="grid"] > section')).map(heading => heading.textContent);
const cardsOf = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>('[class*="grid"] > section')];

it("D-09: «Все материалы» groups the cards under section titles with counts; a chosen section has none", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const template = mock.state.materials.find(m => m.kind === "kmb")!;
  mock.state.materials.push(
    { ...template, material_id: "general-b", kind: "general", title: "Б: шаблоны", description: "" },
    { ...template, material_id: "general-a", kind: "general", title: "А: регламент", description: "Очень длинное описание документа ".repeat(8).trim() },
    // A kind the list does not know reads as a document, as its badge does: it is not lost.
    { ...template, material_id: "other-kind", kind: "other", title: "В: другое", description: "Описание" },
  );
  page = await mountWorkspace(routes, { path: "/materials" });await waitForPage(page);
  expect(sections()).toEqual(["КМБ · 1", "Общие документы · 3", "Гайды блоков · 1"]);
  // Each section's cards are a group named by its title; the order and the sort by title stay.
  const groups = [...page.container.querySelectorAll<HTMLElement>('[role="group"]')];
  expect(groups.map(group => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["КМБ · 1", "Общие документы · 3", "Гайды блоков · 1"]);
  expect(cardsOf(groups[1]).map(card => card.querySelector("h3")?.textContent)).toEqual(["А: регламент", "Б: шаблоны", "В: другое"]);
  expect(cardsOf(groups[1]).map(card => card.querySelector('[class*="badges"]')?.textContent)).toEqual(["Документ", "Документ", "Документ"]);
  // The guide keeps its audience badge beside the kind.
  expect(cardsOf(groups[2])[0].querySelector('[class*="badges"]')?.textContent).toBe("ГайдДля участников блока");
  await change(page.container.querySelector("select")!, "general");
  expect(sections()).toEqual([]);expect(page.container.querySelector('[role="group"]')).toBeNull();
  expect(cardsOf(page.container).map(card => card.querySelector("h2")?.textContent)).toEqual(["А: регламент", "Б: шаблоны"]);
});

it("D-09: the title is the card's only link, without «Открыть», and it opens the material", async () => {
  mock = installMockTransport("organizer", { delay: 0 });
  const long = "Очень длинное описание документа, которое на карточке обрезается одной строкой ".repeat(4).trim();
  mock.state.materials.push({ ...mock.state.materials.find(m => m.kind === "kmb")!, material_id: "general-long", kind: "general", title: "Регламент", description: long });
  mock.state.materials.push({ ...mock.state.materials.find(m => m.kind === "kmb")!, material_id: "general-empty", kind: "general", title: "Шаблоны", description: "" });
  page = await mountWorkspace(routes, { path: "/materials" });await waitForPage(page);
  expect(page.container.textContent).not.toContain("Открыть");
  for (const card of cardsOf(page.container)) {
    const links = [...card.querySelectorAll("a, button")];
    expect(links).toHaveLength(1);expect(links[0].parentElement?.tagName).toBe("H3");expect(links[0].getAttribute("href")).toMatch(/^\/materials\//);
  }
  const card = cardsOf(page.container).find(item => item.querySelector("h3")?.textContent === "Регламент")!;
  // The description keeps its full text for assistive technology; the card clips it to a line.
  const link = card.querySelector<HTMLAnchorElement>("h3 a")!, meta = document.getElementById(link.getAttribute("aria-describedby")!)!;
  expect(card.contains(meta)).toBe(true);expect(meta.querySelector("p")?.textContent).toBe(long);expect(meta.querySelector("p")?.className).toMatch(/description/);
  // An empty description leaves no empty line.
  expect(cardsOf(page.container).find(item => item.querySelector("h3")?.textContent === "Шаблоны")!.querySelector("p")).toBeNull();
  await act(async () => link.click());await waitForPage(page);
  expect(page.container.querySelector("h1")?.textContent).toBe("Регламент");
  expect(page.container.textContent).toContain(long);
});

it("asks for every missing field at once in the main form and clears each mark on its edit", async () => {
  mock = installMockTransport("chair", { delay: 0 });const create = vi.spyOn(materialsApi, "create");
  // The editor is a lazy module: wait for its form, not only for a quiet cache.
  page = await mountWorkspace(routes, { path: "/materials/new" });await waitForPage(page, () => !!page!.container.querySelector('form button[type="submit"]'));
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

it("places a shared guide in general documents without changing its type, link or audience", async () => {
  mock = installMockTransport("chair", { delay: 0 });
  const original = mock.state.materials.find(m => m.kind === "guide")!;
  const moved = { ...original, material_id: "shared-handbook", title: "Общее руководство", catalog_section: "general" as const, audience: "leadership" as const, placeholder: false };
  mock.state.materials.push(moved);
  page = await mountWorkspace(routes, { path: "/materials" });await waitForPage(page);
  const general = [...page.container.querySelectorAll<HTMLElement>('[role="group"]')].find(group => document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent === "Общие документы · 1")!;
  expect(general.querySelector('a[href="/materials/shared-handbook"]')?.textContent).toBe(moved.title);
  expect(general.textContent).toContain("Для руководителей и заместителей");
  await change(page.container.querySelector("select")!, "guide");
  expect(page.container.querySelector('a[href="/materials/shared-handbook"]')).toBeNull();
  expect(page.container.querySelector(`a[href="/materials/${original.material_id}"]`)).not.toBeNull();
  await change(page.container.querySelector("select")!, "general");
  expect(page.container.querySelector('a[href="/materials/shared-handbook"]')).not.toBeNull();
  expect(page.container.querySelector(`a[href="/materials/${original.material_id}"]`)).toBeNull();
  await change(page.container.querySelector<HTMLInputElement>("input")!, "общее");
  expect(page.container.querySelector('a[href="/materials/shared-handbook"]')).not.toBeNull();
});
