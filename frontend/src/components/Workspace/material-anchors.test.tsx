// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { MaterialContent } from "./MaterialContent";
import { MarkdownContent } from "./MarkdownContent";
import type { MaterialText } from "../../utils/api/contract";
import { mountWorkspace, waitForPage } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
afterEach(async () => { await page?.cleanup();page = undefined; });
const links = '[К продолжению](#section-2)\n\n[Внешний сайт](https://example.org/help#section-2)\n\n[Другой гайд](/materials/other#section-2)\n\n[Трекер](/tasks)\n\n[Другой якорь](#custom)';
function content(extended: boolean): MaterialText {
  const source = '<h3>Совет</h3>\n';
  const insert = extended ? `\n\n[К совету](#embed-hint-heading-1)\n\n\`\`\`profkom-html id=embed-hint\n${source}\`\`\`` : '';
  return { format: extended ? "markdown-embeds-v1" : "markdown", body: `${links}\n\n## Начало${insert}\n\n## Продолжение`, ...(extended ? { render: {
    schema_version: 1, policy_version: 1, source_hash: "a".repeat(64), diagnostics: [], file_ids: [], blocks: [{ id: "embed-hint", source, text: "Совет", nodes: [{ tag: "h3", text: "", attrs: { anchor: "embed-hint-heading-1" }, children: [{ tag: "text", text: "Совет", attrs: {}, children: [] }] }] }],
  } } : {}) };
}
it.each([false, true])("resolves Markdown TOC links to the current material and focuses their headings (extended=%s)", async extended => {
  page = await mountWorkspace(<MaterialContent materialId="first" content={content(extended)} />);
  await waitForPage(page, () => !!page!.container.querySelector('#guide-first-section-2'));
  const anchor = [...page.container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent === "К продолжению")!;
  expect(anchor.getAttribute("href")).toBe("#guide-first-section-2");
  await act(async () => anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  expect(document.activeElement).toBe(page.container.querySelector('#guide-first-section-2'));
  if (extended) {
    const hint = [...page.container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent === "К совету")!;
    expect(hint.getAttribute("href")).toBe("#guide-first-embed-hint-heading-1");
    await act(async () => hint.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(document.activeElement).toBe(page.container.querySelector('#guide-first-embed-hint-heading-1'));
  }
  for (const href of ["https://example.org/help#section-2", "/materials/other#section-2", "/tasks", "#custom"]) expect(page.container.querySelector(`a[href="${href}"]`)).not.toBeNull();
});
it("keeps readers independent and does not rewrite anchors outside a material", async () => {
  page = await mountWorkspace(<><MaterialContent materialId="first" content={content(false)} /><MaterialContent materialId="second" content={content(false)} /><MarkdownContent body="[Обычная ссылка](#section-2)" /></>);
  await waitForPage(page, () => !!page!.container.querySelector('#guide-second-section-2'));
  const second = [...page.container.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent === "К продолжению" && link.getAttribute("href") === "#guide-second-section-2")!;
  await act(async () => second.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
  expect(document.activeElement).toBe(page.container.querySelector('#guide-second-section-2'));
  expect(page.container.querySelector('a[href="#section-2"]')?.textContent).toBe("Обычная ссылка");
});
