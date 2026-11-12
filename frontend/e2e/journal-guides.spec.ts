import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";
import type { Material, MaterialText } from "../src/utils/api/contract";
import type { JournalRender } from "../src/utils/api/journal";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const localPython = resolve(repository, ".local/env/py312/bin/python");
const python = process.env.PROFKOM_PYTHON || (existsSync(localPython) ? localPython : "python3");
const source = readFileSync(resolve(repository, "frontend/src/test/fixtures/journal-tracker.json"), "utf8");
const compile = (body: string): MaterialText => ({ format: "journal-v1", body, render: JSON.parse(execFileSync(
  python, ["-I", resolve(repository, "backend/journal.py"), "--compile"], { input: JSON.stringify(body), encoding: "utf8" },
)) as JournalRender });
const title = "От «кто возьмёт?» до готовой афиши.";

test("journal reads as a page, navigates stable sections and switches examples without requests", async ({ page, baseURL, external }, info) => {
  const fixture = createFixtures("chair"), errors: string[] = [], requests: string[] = [];
  const content = compile(source);
  expect(content.render?.diagnostics).toEqual([]);
  const material: Material = {
    ...fixture.materials[0], material_id: "material-journal-browser", title,
    description: "Работа в команде", published_content: content, source_content: content, draft_content: undefined,
    audience: "everyone", published_at: "2026-11-12T10:00:00Z", capabilities: ["edit_material", "publish_material", "edit_html_material"],
  };
  const empty = { items: [], next_cursor: null };
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-journal-browser-only", url: baseURL! }]);
  await page.route(/\/api\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    requests.push(`${route.request().method()} ${path}`);
    if (path === "/files/file-journal-task/content") {
      await route.fulfill({ body: readFileSync(resolve(repository, "docs/user-guides/images/tracker-task.png")), contentType: "image/png" }); return;
    }
    const responses: Record<string, unknown> = {
      "/session": fixture.session, "/profile/me": fixture.profile,
      "/materials": { items: [material], next_cursor: null }, [`/materials/${material.material_id}`]: material,
      "/blocks": fixture.blocks, "/notifications/unread-count": { count: 0 },
      "/notifications": empty, "/events": empty, "/seasons": empty,
    };
    await route.fulfill({ json: responses[path] ?? empty });
  });
  await page.goto(`/materials/${material.material_id}`);
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("heading", { name: "Сначала — результат.", exact: true })).toBeVisible();
  expect(requests.filter(request => request.includes("/files/"))).toEqual([]);
  const tabs = page.getByRole("tablist");
  await expect(tabs).toBeVisible();
  const beforeSwitch = requests.length;
  await tabs.getByRole("tab", { name: "Анна и Илья", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Никого не выбрали", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("Все участники чата", { exact: true })).toBeVisible();
  expect(requests.length).toBe(beforeSwitch);
  await page.getByRole("link", { name: /Сначала — результат/ }).first().click();
  await expect(page).toHaveURL(/#guide-material-journal-browser-create$/);
  await expect(page.getByRole("heading", { name: "Сначала — результат.", exact: true })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("journal-reader.png"), fullPage: true });

  const picture = page.getByRole("img", { name: "Карточка задачи с исполнителями, сроком и комментариями", exact: true });
  await expect(picture).toHaveCount(0);
  await page.locator("summary", { hasText: "Посмотреть настоящую карточку задачи" }).click();
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1360);
  expect(requests.filter(request => request.includes("/files/"))).toEqual(["GET /files/file-journal-task/content"]);
  await page.screenshot({ path: info.outputPath("journal-picture.png"), fullPage: true });
  const zoom = page.getByRole("button", { name: "Увеличить изображение: Карточка задачи с исполнителями, сроком и комментариями", exact: true });
  await zoom.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Масштаб 100%", exact: true }).click();
  await expect(dialog.getByRole("region", { name: "Изображение в полном размере: прокрутите для просмотра" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);await expect(zoom).toBeFocused();
  await page.getByRole("tab", { name: "Анна и Илья", exact: true }).click();
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.getByText("Все участники чата", { exact: true })).toBeVisible();
  await expect(page.locator('[data-journal-guide] summary', { hasText: "Бот не отправил сообщение?" })).toHaveCSS("color", "rgb(17, 17, 17)");
  await expect(page.locator('[data-journal-guide] summary').first()).toHaveCSS("color", "rgb(68, 68, 68)");
  expect(requests.some(request => request.startsWith("POST ") || request.startsWith("PATCH "))).toBe(false);
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("journal authoring converts, previews, saves, reopens and publishes separately", async ({ page, baseURL, external }, info) => {
  const fixture = createFixtures("chair"), mutations: string[] = [], errors: string[] = [];
  const original: MaterialText = { format: "markdown", body: "## План\n\nСоберите команду." };
  let material: Material = { ...fixture.materials[0], material_id: "material-journal-editor", title: "Гайд для команды", kind: "guide", published_content: original, source_content: original, draft_content: undefined, capabilities: ["edit_material", "publish_material", "edit_html_material"] };
  page.on("pageerror", error => errors.push(error.message));
  await page.context().addCookies([{ name: "access_token", value: "synthetic-journal-editor-only", url: baseURL! }]);
  const empty = { items: [], next_cursor: null };
  await page.route(/\/api\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, ""), method = route.request().method();
    if (path === `/materials/${material.material_id}/preview`) {
      await route.fulfill({ json: compile((route.request().postDataJSON() as { content: MaterialText }).content.body) });return;
    }
    if (path === `/materials/${material.material_id}` && method === "PATCH") {
      const value = route.request().postDataJSON() as { title: string; description: string; content: MaterialText };
      mutations.push("save");
      material = { ...material, title: value.title, description: value.description, revision: material.revision + 1, draft_content: compile(value.content.body), source_content: value.content };
      await route.fulfill({ json: material });return;
    }
    if (path === `/materials/${material.material_id}/publish`) {
      mutations.push("publish");
      material = { ...material, revision: material.revision + 1, published_content: material.draft_content!, draft_content: undefined };
      await route.fulfill({ json: material });return;
    }
    const responses: Record<string, unknown> = {
      "/session": fixture.session, "/profile/me": fixture.profile,
      "/materials": { items: [material], next_cursor: null }, [`/materials/${material.material_id}`]: material,
      "/blocks": fixture.blocks, "/notifications/unread-count": { count: 0 },
      "/notifications": empty, "/events": empty, "/seasons": empty,
    };
    await route.fulfill({ json: responses[path] ?? empty });
  });
  await page.goto(`/materials/${material.material_id}`);
  await page.getByRole("button", { name: "Редактировать материал", exact: true }).click();
  await page.getByRole("button", { name: "Перейти к Журналу", exact: true }).click();
  await page.getByRole("checkbox", { name: "Преобразовать сохранённый текст в Журнал" }).check();
  await page.getByRole("button", { name: "Преобразовать в Журнал", exact: true }).click();
  const editor = page.getByRole("region", { name: "Редактор журнала", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole("textbox", { name: "Вступление", exact: true }).fill("Как договориться о результате.");
  await editor.getByRole("combobox", { name: "Обложка", exact: true }).selectOption("poster");
  await editor.getByRole("textbox", { name: "Главная мысль обложки", exact: true }).fill("Одна команда.");
  await editor.getByRole("navigation", { name: "Структура журнала" }).getByRole("button", { name: /План/ }).click();
  await editor.getByRole("textbox", { name: "Название раздела", exact: true }).fill("Договоритесь о результате");
  const anchor = await editor.getByRole("textbox", { name: "Ссылка на раздел", exact: true }).inputValue();
  await editor.getByRole("combobox", { name: "Новый блок", exact: true }).selectOption("note");
  await editor.getByRole("button", { name: "Добавить блок", exact: true }).click();
  await editor.getByRole("textbox", { name: "Заголовок плашки", exact: true }).fill("Согласуйте срок");
  await editor.getByRole("textbox", { name: "Текст плашки", exact: true }).fill("Назовите дату и время.");
  await editor.getByRole("button", { name: "Предпросмотр", exact: true }).click();
  const preview = page.getByRole("region", { name: "Предпросмотр всего журнала", exact: true });
  await expect(preview.getByRole("heading", { name: "Согласуйте срок", exact: true })).toBeVisible();
  await preview.getByRole("combobox", { name: "Ширина предпросмотра", exact: true }).selectOption("390");
  await expect(preview.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("journal-author-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  await expect.poll(() => mutations).toEqual(["save"]);
  expect(material.published_content).toEqual(original);
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Редактировать материал", exact: true }).click();
  await editor.getByRole("navigation", { name: "Структура журнала" }).getByRole("button", { name: /Договоритесь о результате/ }).click();
  await expect(editor.getByRole("textbox", { name: "Ссылка на раздел", exact: true })).toHaveValue(anchor);
  await editor.getByRole("navigation", { name: "Структура журнала" }).getByRole("button", { name: /Плашка Согласуйте срок/ }).click();
  await expect(editor.getByRole("textbox", { name: "Текст плашки", exact: true })).toHaveValue("Назовите дату и время.");
  await page.screenshot({ path: info.outputPath("journal-author-fields.png"), fullPage: true });
  await page.getByRole("button", { name: "Опубликовать сохранённый черновик", exact: true }).click();
  await expect.poll(() => mutations).toEqual(["save", "publish"]);
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Согласуйте срок", exact: true })).toBeVisible();
  expect(material.published_content?.format).toBe("journal-v1");
  expect(errors).toEqual([]);expect(external).toEqual([]);
});
