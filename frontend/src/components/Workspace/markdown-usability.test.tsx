// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";
import { MarkdownEditor } from "./MarkdownEditor";
import { mountWorkspace } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })));
afterEach(async () => { await page?.cleanup();page = undefined;vi.unstubAllGlobals(); });

it("code blocks display canonical language captions; inline code has no caption and source stays literal", async () => {
  const source = '`inline code`\n\n```js\nconst value = 42;\n```\n\n```python\ndef total(x):\n  return x\n```\n\n```\nplain block\n```';
  page = await mountWorkspace(<MarkdownContent body={source} />);
  expect([...page.container.querySelectorAll('figure[aria-label^="Блок кода:"] > figcaption')].map(node => node.textContent)).toEqual(["JavaScript", "Python", "Текст"]);
  expect(page.container.querySelector("p > code")?.textContent).toBe("inline code");
  expect(page.container.querySelector("p > code")?.closest("figure")).toBeNull();
  expect(page.container.querySelector("pre code.language-js .hljs-keyword")?.textContent).toBe("const");
  expect(page.container.querySelector("figure pre")?.textContent).toBe("const value = 42;\n");
});
it("unknown fence labels are escaped text and unsupported syntax remains literal", async () => {
  const language = 'unknown<svg/onload=alert(1)>';
  page = await mountWorkspace(<MarkdownContent body={'```' + language + '\n<script>alert("literal")</script>\n```'} />);
  expect(page.container.querySelector("figcaption")?.textContent).toBe(language);
  expect(page.container.querySelector("script, svg, iframe, object")).toBeNull();
  expect(page.container.querySelector("pre code")?.textContent).toBe('<script>alert("literal")</script>\n');
  expect(page.container.querySelector("pre code span")).toBeNull();
});
it("gallery and contact fences retain their custom rendering without a code language wrapper", async () => {
  page = await mountWorkspace(<MarkdownContent body={'```gallery\n/avatars/sun.svg | Подпись\n```\n\n```chip\nФамилия: Пример\nИмя: Тест\n```'} />);
  expect(page.container.querySelector('figure[aria-label^="Блок кода:"]')).toBeNull();
  expect(page.container.querySelector("pre")).toBeNull();
  expect(page.container.querySelector('img[alt="Подпись"]')).not.toBeNull();
  expect(page.container.textContent).toContain("Пример");
});
it("the large-cell table icon still inserts a complete Markdown table and supports undo", async () => {
  function Editor() { const [value, setValue] = useState("Текст");return <MarkdownEditor value={value} onChange={setValue} context="comment" />; }
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(5, 5);
  const table = page.container.querySelector<HTMLButtonElement>('button[aria-label="Таблица"]')!;
  expect(table.querySelector('svg[data-editor-icon="table"] rect')).not.toBeNull();
  expect(table.textContent).not.toContain("▦");
  await act(async () => table.click());
  expect(input.value).toContain("| Заголовок 1 | Заголовок 2 | Заголовок 3 |");
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Предпросмотр"]')!.click());
  expect(page.container.querySelectorAll("th")).toHaveLength(3);expect(page.container.querySelectorAll("td")).toHaveLength(6);
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Редактирование"]')!.click());
  await act(async () => page!.container.querySelector<HTMLButtonElement>('button[aria-label="Отменить"]')!.click());
  expect(page.container.querySelector("textarea")!.value).toBe("Текст");
});
