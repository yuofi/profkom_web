import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures";
import { createFixtures } from "../src/mocks/fixtures";
import type { GuideRender, Material, MaterialText } from "../src/utils/api/contract";
const corpus = JSON.parse(readFileSync(new URL("../src/test/fixtures/guide-embeds.json", import.meta.url), "utf8")) as { name: string; body: string; render: GuideRender }[];

// Synthetic API responses, compiled by the real pure Python compiler. The separate
// HTTP integration suite checks authorization/storage; this covers the production
// browser build, keyboard interaction and its desktop/mobile layout.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const localPython = resolve(repository, ".local/env/py312/bin/python");
const python = process.env.PROFKOM_PYTHON || (existsSync(localPython) ? localPython : "python3");
const compile = (body: string): MaterialText => ({ format: "markdown-embeds-v1", body, render: JSON.parse(execFileSync(
  python, ["-I", resolve(repository, "backend/guide_embeds.py"), "--compile"],
  { input: JSON.stringify(body), encoding: "utf8" },
)) as GuideRender });
const selected = ["navigation", "panel", "table", "image", "faq", "nested_quote", "nested_list"];
const columns = '```profkom-html id=embed-columns\n<div class="guide-grid-2"><section class="guide-card guide-tone-success"><h3>Первый день</h3><p>Познакомьтесь с командой.</p></section><section class="guide-card guide-tone-warning"><h3>Первая неделя</h3><p>Выберите небольшую задачу.</p></section></div>\n```';
const body = [...selected.map(name => corpus.find(item => item.name === name)!.body), columns].join("\n\n");
const content = compile(body);
const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFzQAAAAASUVORK5CYII=", "base64");

test("guide inserts render, navigate and edit on desktop and phone", async ({ page, baseURL, external }, info) => {
  const fixture = createFixtures("chair"), errors: string[] = [];
  const mutations: string[] = [];
  let previewCalls = 0;
  page.on("pageerror", error => errors.push(error.message));
  let material: Material = {
    ...fixture.materials[0], material_id: "material-html-browser", title: "Первый шаг в профкоме",
    description: "Локальный пример оформления гайда", published_content: content, source_content: content,
    draft_content: undefined, audience: "everyone", published_at: "2026-11-10T10:00:00Z",
    capabilities: ["edit_material", "publish_material", "edit_html_material"],
  };
  const empty = { items: [], next_cursor: null };
  await page.context().addCookies([{ name: "access_token", value: "synthetic-guide-browser-only", url: baseURL! }]);
  await page.route(/\/api\//, async route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, ""), method = route.request().method();
    if (path.startsWith("/files/") && path.endsWith("/content")) {
      await route.fulfill({ body: image, contentType: "image/png" });return;
    }
    if (path === `/materials/${material.material_id}/preview`) {
      previewCalls++;
      await route.fulfill({ json: compile((route.request().postDataJSON() as { content: MaterialText }).content.body) });return;
    }
    if (path === `/materials/${material.material_id}` && method === "PATCH") {
      const value = route.request().postDataJSON() as { title: string; description: string; content: MaterialText };
      mutations.push("save");
      material = { ...material, title: value.title, description: value.description, revision: material.revision + 1, draft_content: compile(value.content.body), source_content: { format: value.content.format, body: value.content.body } };
      await route.fulfill({ json: material });return;
    }
    if (path === `/materials/${material.material_id}/publish`) {
      mutations.push("publish");
      material = { ...material, revision: material.revision + 1, published_content: material.draft_content!, draft_content: undefined };
      await route.fulfill({ json: material });return;
    }
    const responses: Record<string, unknown> = {
      "/session": fixture.session, "/profile/me": fixture.profile,
      "/materials": { items: [material, { ...fixture.materials[0], material_id: "another-guide", title: "Другой гайд" }], next_cursor: null },
      [`/materials/${material.material_id}`]: material,
      "/blocks": fixture.blocks, "/notifications/unread-count": { count: 0 },
      "/notifications": empty, "/events": empty, "/seasons": empty,
    };
    await route.fulfill({ json: responses[path] ?? empty });
  });
  await page.goto(`/materials/${material.material_id}`);
  await expect(page.getByRole("heading", { name: material.title })).toBeVisible();
  await expect(page.locator("[data-guide-embed]")).toHaveCount(8);
  // The shared Markdown stylesheet must not turn semantic insert tables into
  // block elements, which would detach the caption from the columns on phones.
  await expect(page.locator('[data-guide-embed="embed-table"] table')).toHaveCSS("display", "table");
  await expect(page.getByText("Вставка не прошла проверку.", { exact: false })).toHaveCount(0);
  const picture = page.getByRole("img", { name: "Синтетическая иллюстрация" });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const question = page.locator("summary", { hasText: "Как начать?" });
  await question.focus();await page.keyboard.press("Enter");
  await expect(question.locator("..")).toHaveAttribute("open", "");
  await page.keyboard.press("Enter");
  await expect(question.locator("..")).not.toHaveAttribute("open", "");
  await page.getByRole("link", { name: "В начало", exact: true }).click();
  await expect(page).toHaveURL(/#guide-material-html-browser-section-1$/);
  await expect(page.getByRole("heading", { name: "Начало", exact: true })).toBeFocused();
  await expect(page.getByRole("link", { name: /На сайт/ })).toHaveAttribute("target", "_blank");
  await expect(page.getByRole("link", { name: /На сайт/ })).toHaveAttribute("rel", /noopener/);
  await expect(page.getByRole("link", { name: "Другой гайд", exact: true })).toHaveAttribute("href", "/materials/example");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("guide-reader.png"), fullPage: true });
  expect(previewCalls).toBe(0);

  await page.getByRole("button", { name: "Редактировать материал", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Текст материала", exact: true })).toHaveValue(body);
  await page.getByRole("button", { name: "Вставить оформленный блок" }).click();
  await expect(page.getByRole("menuitem", { name: "Плашка", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("guide-insert-menu.png"), fullPage: true });
  await page.getByRole("menuitem", { name: "Плашка", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Плашка", exact: true });
  await dialog.getByRole("textbox", { name: "Заголовок", exact: true }).fill("Совет для первого дня");
  await dialog.getByRole("textbox", { name: "Текст", exact: true }).fill("Начните с небольшой задачи и задавайте вопросы команде.");
  await dialog.getByRole("button", { name: "Мятная", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Мягкий градиент" }).check();
  await dialog.getByRole("button", { name: "Предпросмотр вставки", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Совет для первого дня", exact: true })).toBeVisible();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("guide-panel-preview.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Вставить в гайд", exact: true }).click();
  const source = page.getByRole("textbox", { name: "Текст материала", exact: true });
  await expect(source).toHaveValue(/guide-gradient-success/);
  await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  await expect.poll(() => mutations).toEqual(["save"]);
  await expect(page.getByRole("button", { name: "Опубликовать сохранённый черновик", exact: true })).toBeEnabled();
  // Saving or previewing must not publish, even if a reader's previous version exists.
  expect(material.published_content?.body).toBe(body);
  await page.getByRole("button", { name: "Предпросмотр", exact: true }).click();
  const preview = page.getByRole("region", { name: "Предпросмотр гайда", exact: true });
  await expect(preview.getByRole("heading", { name: "Совет для первого дня", exact: true })).toBeVisible();
  await preview.getByRole("combobox", { name: "Ширина", exact: true }).selectOption("390");
  const previewGrid = preview.locator('[data-guide-embed="embed-columns"] > div');
  // A phone-width preview must stack its cards even inside a desktop viewport.
  await expect.poll(() => previewGrid.evaluate(node => getComputedStyle(node).gridTemplateColumns.split(/\s+/).length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("guide-editor-preview.png"), fullPage: true });
  await page.getByRole("button", { name: "Опубликовать сохранённый черновик", exact: true }).click();
  await expect.poll(() => mutations).toEqual(["save", "publish"]);
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Совет для первого дня", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
