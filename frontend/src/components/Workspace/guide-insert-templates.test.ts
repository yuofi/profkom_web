import { expect, it } from "vitest";
import { guideHeadingChoices, guideInsertFence, guideInsertHtml, guideInsertKinds, guideNavigationProblem, initialGuideInsert } from "./guideInsertTemplates";
import type { GuideRender } from "../../utils/api/contract";

it("escapes visual-field text and link attributes while preserving paragraphs", () => {
  const fields = { ...initialGuideInsert(), title: '<img src=x onerror="run()">', text: "Первый абзац\nвторая строка\n\nВторой абзац" };
  const html = guideInsertHtml("panel", fields);
  expect(html).toContain("&lt;img src=x onerror=&quot;run()&quot;&gt;");
  expect(html).not.toContain("<img");
  expect(html).toContain("<p>Первый абзац<br>вторая строка</p>\n<p>Второй абзац</p>");
  expect(guideInsertHtml("button", { ...fields, href: 'https://example.org/?q="&value=2' })).toContain('href="https://example.org/?q=&quot;&amp;value=2"');
});

it.each(guideInsertKinds.map(item => item.kind))("generates a stable fence for %s without rewriting source", kind => {
  const html = guideInsertHtml(kind, { ...initialGuideInsert(), caption: "Что взять", fileId: "file-image", alt: "Схема", href: "/blocks" });
  const source = guideInsertFence("embed-example", html);
  expect(source).toContain("profkom-html id=embed-example\n");
  expect(source).toContain(html);
  expect(html).not.toMatch(/(?:<script|\sstyle=|\sonclick=)/);
});

it("uses a longer outer fence when manual HTML contains a Markdown code example", () => {
  expect(guideInsertFence("embed-manual", "<pre>```sample```</pre>")).toBe("````profkom-html id=embed-manual\n<pre>```sample```</pre>\n````");
});

it("keeps native table semantics, mandatory captions and declared image dimensions", () => {
  const fields = { ...initialGuideInsert(), caption: "Комплект", fileId: "file-sample", alt: "Схема входа", width: 640, height: 480 };
  expect(guideInsertHtml("table", fields)).toContain('<caption>Комплект</caption>\n<thead><tr><th scope="col">');
  expect(guideInsertHtml("image", fields)).toContain('<img src="file:file-sample" alt="Схема входа" width="640" height="480">');
  expect(guideInsertHtml("faq", fields)).toMatch(/<details[^>]*>\n<summary>/);
});

it.each(["javascript:alert(1)", "data:text/html,x", "//example.org", "/api/files/key", "https://name:password@example.org", "https://example.org/\nnext", "/\\example.org"])("explains a refused navigation URL: %s", href => {
  expect(guideNavigationProblem(href)).toBeTruthy();
});

it.each(["https://example.org/guide", "/blocks", "/materials/guide-1", "#section-1", "#embed-sample-heading-2"])("accepts a normal navigation destination: %s", href => {
  expect(guideNavigationProblem(href)).toBeNull();
});

it("heading choices parse Markdown, include setext/formatting and ignore headings inside code", async () => {
  const render: GuideRender = { schema_version: 1, policy_version: 1, source_hash: "0".repeat(64), diagnostics: [], file_ids: [], blocks: [{ id: "embed-steps", source: "", text: "", nodes: [{ tag: "h3", text: "", attrs: { anchor: "embed-steps-heading-1" }, children: [{ tag: "text", text: "Из вставки", attrs: {}, children: [] }] }] }] };
  const choices = await guideHeadingChoices("## **Начало**\n\n```text\n# Не раздел\n```\n\nПродолжение\n---\n", render);
  expect(choices).toEqual([{ value: "#section-1", label: "Начало" }, { value: "#section-2", label: "Продолжение" }, { value: "#embed-steps-heading-1", label: "Из вставки" }]);
});
