// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { GuideEmbeds } from "./GuideEmbeds";
import { MaterialContent } from "./MaterialContent";
import { MarkdownContent } from "./MarkdownContent";
import { guideHref, validGuideRender } from "./guideEmbedPolicy";
import type { GuideNode, GuideRender, MaterialText } from "../../utils/api/contract";
import { mountWorkspace, waitForPage } from "../../test/workspace";
import { wireIssues } from "../../test/wireContract";
import corpus from "../../test/fixtures/guide-embeds.json";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
const text = (value: string): GuideNode => ({ tag: "text", text: value, attrs: {}, children: [] });
const node = (tag: string, children: GuideNode[] = [], attrs: GuideNode["attrs"] = {}): GuideNode => ({ tag, text: "", attrs, children });
function fixture(nodes: GuideNode[] = [node("section", [node("h2", [text("Шаг первый")], { anchor: "embed-test-heading-1" }), node("p", [text("Содержимое плашки")])], { classes: ["guide-card", "guide-gradient-info"] })]): MaterialText & { render: GuideRender } {
  const source = "<section>Синтетический исходник</section>\n";
  return { format: "markdown-embeds-v1", body: `## Начало\n\n\`\`\`profkom-html id=embed-test\n${source}\`\`\`\n\n## Конец`, render: { schema_version: 1, policy_version: 1, source_hash: "a".repeat(64), blocks: [{ id: "embed-test", source, nodes, text: "Текст вставки" }], diagnostics: [], file_ids: [] } };
}
it("renders only explicit extended-format fences, keeps ordinary HTML/code inert", async () => {
  const content = fixture();
  page = await mountWorkspace(<><GuideEmbeds content={content} materialId="guide-test" /><MarkdownContent body={content.body + '\n<script>alert(1)</script>'} /></>);
  expect(page.container.querySelectorAll('[data-guide-embed]')).toHaveLength(1);
  expect(page.container.querySelectorAll('h2')).toHaveLength(5);
  expect(page.container.querySelector('script')).toBeNull();
  expect(page.container.querySelector('[class*="guide-gradient-info"]')).not.toBeNull();
  expect(page.container.textContent).toContain("<section>Синтетический исходник</section>");
});
it("includes compiled headings in TOC and retains stable material-scoped anchors", async () => {
  page = await mountWorkspace(<MaterialContent materialId="abc" content={fixture()} />);
  await waitForPage(page, () => !!page!.container.querySelector('[data-guide-embed]'));
  expect(page.container.querySelector('#guide-abc-section-1')?.textContent).toBe("Начало");
  expect(page.container.querySelector('#guide-abc-embed-test-heading-1')?.textContent).toBe("Шаг первый");
  expect(page.container.querySelector('#guide-abc-section-2')?.textContent).toBe("Конец");
  expect(page.container.querySelector('nav a[href="#guide-abc-embed-test-heading-1"]')).not.toBeNull();
});
it("uses native navigation, accessible table overflow, private images and native disclosure", async () => {
  const content = fixture([
    node("a", [text("К разделу")], { href: "#section-1", classes: ["guide-button"] }),
    node("a", [text("Другой гайд")], { href: "/materials/other" }),
    node("a", [text("Внешний сайт")], { href: "https://example.org/guide" }),
    node("table", [node("caption", [text("Сравнение")]), node("tbody", [node("tr", [node("th", [text("Параметр")], { scope: "row" }), node("td", [text("Значение")])])])]),
    node("img", [], { src: "file:file-photo", alt: "Схема", width: 800, height: 600 }),
    node("details", [node("summary", [text("Подробнее")]), node("p", [text("Ответ")])]),
  ]);
  content.render!.file_ids = ["file-photo"];
  page = await mountWorkspace(<GuideEmbeds content={content} materialId="abc" />);
  expect(page.container.querySelector('a[href="#guide-abc-section-1"]')).not.toBeNull();
  expect(page.container.querySelector('a[href="/materials/other"]')).not.toBeNull();
  const external = page.container.querySelector('a[href^="https:"]')!;
  expect(external.getAttribute('rel')).toBe('noopener noreferrer');
  expect(external.getAttribute('target')).toBe('_blank');
  expect(page.container.querySelector('[role="region"] table caption')?.textContent).toBe('Сравнение');
  expect(page.container.querySelector('th')?.getAttribute('scope')).toBe('row');
  const image = page.container.querySelector('img')!;
  expect(image.getAttribute('src')).toMatch(/\/api\/files\/file-photo\/content$/);
  expect(image.width).toBe(800);expect(image.height).toBe(600);expect(image.getAttribute('decoding')).toBe('async');
  await act(async () => image.dispatchEvent(new Event('error')));
  expect(page.container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Схема');
  expect(page.container.querySelector('details summary')?.textContent).toBe('Подробнее');
});
it.each(['javascript:alert(1)', 'data:text/html,x', '//example.org', '/api/session', '/x/../api/session', '/%61pi/session', '/%252fapi/session', '/\\evil', 'https://x/a%0ab', 'https://u:p@example.org', '#login'])('rejects unsafe navigation %s', href => {
  expect(guideHref(href)).toBe(false);
  expect(validGuideRender(fixture([node('a', [text('X')], { href })]).render)).toBe(false);
});
it.each(['https://example.org/a?x=1&y=2', '/materials/abc', '#section-1', '#embed-test-heading-2'])('accepts supported navigation %s', href => expect(guideHref(href)).toBe(true));
it.each(['script', 'iframe', 'style', 'svg', 'form', 'button', 'custom-x'])('rejects forbidden tree tag %s', tag => expect(validGuideRender(fixture([node(tag)]).render)).toBe(false));
it("rejects arbitrary attributes, unsafe images, deep trees and incompatible policies", () => {
  const supplied = node('p');(supplied.attrs as Record<string, unknown>).onClick = 'alert(1)';
  expect(validGuideRender(fixture([supplied]).render)).toBe(false);
  expect(validGuideRender(fixture([node('img', [], { src: 'https://example.org/photo', alt: 'X', width: 20, height: 20 })]).render)).toBe(false);
  let deep = text('x');for(let i=0;i<13;i++) deep = node('div', [deep]);
  expect(validGuideRender(fixture([deep]).render)).toBe(false);
  const render = fixture().render!;render.policy_version = 999;expect(validGuideRender(render)).toBe(false);
});
it("shows a safe local fallback for stale source and still renders surrounding Markdown", async () => {
  const content = fixture();content.render!.blocks[0].source = "different";
  page = await mountWorkspace(<GuideEmbeds content={content} materialId="abc" />);
  expect(page.container.querySelector('[data-guide-embed]')).toBeNull();
  expect(page.container.textContent).toContain('не прошла проверку');
  expect(page.container.textContent).toContain('Начало');expect(page.container.textContent).toContain('Конец');
});
it("keeps a valid insert visible beside a broken fence without an id", async () => {
  const content = fixture();content.body = '```profkom-html\n<p>Неверная вставка</p>\n```\n\n' + content.body;
  content.render!.diagnostics = [{ block_id: 'invalid-1', line: 1, code: 'block_id', message: 'Нужен id вставки' }];
  content.render!.blocks.unshift({ id: 'invalid-1', source: '<p>Неверная вставка</p>\n', nodes: [], text: '' });
  page = await mountWorkspace(<GuideEmbeds content={content} materialId="abc" />);
  expect(page.container.querySelectorAll('[data-guide-embed]')).toHaveLength(1);
  expect(page.container.textContent).toContain('Содержимое плашки');
  expect(page.container.textContent).toContain('не прошла проверку');
});
it("resolves material-owned files in ordinary Markdown outside inserts", async () => {
  const content = fixture();content.body += '\n\n![Рисунок](file:file-photo)\n\n[Файл](file:file-document)';
  page = await mountWorkspace(<GuideEmbeds content={content} materialId="abc" />);
  expect(page.container.querySelector('img')?.getAttribute('src')).toMatch(/\/api\/files\/file-photo\/content$/);
  expect(page.container.querySelector('a')?.getAttribute('href')).toMatch(/\/api\/files\/file-document\/content$/);
});
it("preserves existing gallery files when a guide opts into inserts", async () => {
  const content = fixture();content.body += '\n\n```gallery\nfile:file-gallery | Снимок\n```';
  page = await mountWorkspace(<GuideEmbeds content={content} materialId="abc" />);
  await waitForPage(page, () => !!page!.container.querySelector('img'));
  expect(page.container.querySelector('img')?.getAttribute('src')).toMatch(/\/api\/files\/file-gallery\/content$/);
});
it("declares the exact compiled wire shape, including a deeply nested valid tree", () => {
  let deep = text('x');for(let i=0;i<12;i++) deep = node('div', [deep]);
  const value = fixture([deep]);expect(validGuideRender(value.render)).toBe(true);
  expect(wireIssues('MaterialText', value)).toEqual([]);
  expect(wireIssues('GuideRender', { ...value.render as GuideRender, unexpected: true })).not.toEqual([]);
});
it.each(corpus)("renders actual Python compiler output: $name", async example => {
  expect(example.render.diagnostics).toEqual([]);
  expect(validGuideRender(example.render)).toBe(true);
  expect(wireIssues("GuideRender", example.render)).toEqual([]);
  page = await mountWorkspace(<GuideEmbeds content={{ format: "markdown-embeds-v1", body: example.body, render: example.render as GuideRender }} materialId="corpus" />);
  expect(page.container.querySelectorAll('[data-guide-embed]')).toHaveLength(example.render.blocks.length);
  expect(page.container.textContent).not.toContain('не прошла проверку');
});
