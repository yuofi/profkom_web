// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownContent } from "./MarkdownContent";
import { ActionForm } from "./ActionForm";
import { mountWorkspace } from "../../test/workspace";

let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })));
afterEach(async () => { await page?.cleanup(); page = undefined; vi.unstubAllGlobals(); });
function Editor({ initial = "", save = async () => {} }: { initial?: string; save?: () => Promise<void> }) {
  const [body, setBody] = useState(initial);
  return <ActionForm fields={[]} externalState={body} onSubmit={save}>
    <MarkdownEditor value={body} onChange={setBody} label="Новый комментарий" name="body" rows={8} context="comment" />
  </ActionForm>;
}
async function click(label: string) {
  const button = Array.from(page!.container.querySelectorAll("button")).find(element => element.getAttribute("aria-label") === label);
  if (!button) throw Error(`Missing Markdown command: ${label}`);
  await act(async () => button.click());
}

it("the eye is the first toolbar action; preview renders tables and math without sending or losing the caret", async () => {
  const source = "# Итог\n\n| Работа | Часы |\n| --- | --- |\n| Тест | 2 |\n\n$E=mc^2$\n\n$$\n\\frac{1}{2}\n$$";
  const save = vi.fn(async () => {});
  page = await mountWorkspace(<Editor initial={source} save={save} />);
  const first = page.container.querySelector('[role="toolbar"] button')!;
  expect(first.getAttribute("aria-label")).toBe("Предпросмотр");
  expect(first.querySelector('[data-icon="visibility"]')).not.toBeNull();
  const input = page.container.querySelector("textarea")!;
  expect(input.rows).toBe(8); expect(input.name).toBe("body"); input.focus(); input.setSelectionRange(2, 5);
  await click("Предпросмотр");
  expect(page.container.querySelector("textarea")).toBeNull();
  expect(page.container.querySelectorAll("table")).toHaveLength(1);
  expect(page.container.querySelectorAll(".katex")).toHaveLength(2);
  expect(page.container.querySelectorAll("math")).toHaveLength(2);
  await click("Редактирование");
  const restored = page.container.querySelector("textarea")!;
  expect(restored.value).toBe(source);
  expect([restored.selectionStart, restored.selectionEnd]).toEqual([2, 5]);
  expect(save).not.toHaveBeenCalled();
  expect(page.container.textContent).not.toContain("публикация");
});

it("inserts an editable table and formulas, and undo restores the original custom source", async () => {
  const custom = "```gallery\n/avatars/sun.svg | Подпись\n```\n";
  page = await mountWorkspace(<Editor initial={custom} />);
  const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 0);
  await click("Таблица");
  expect(input.value).toContain("| Заголовок 1 | Заголовок 2 | Заголовок 3 |");
  expect(input.value.endsWith(custom)).toBe(true);
  await click("Предпросмотр");
  expect(page.container.querySelectorAll("th")).toHaveLength(3);
  expect(page.container.querySelectorAll("td")).toHaveLength(6);
  await click("Редактирование"); await click("Отменить");
  expect(page.container.querySelector("textarea")!.value).toBe(custom);
  await click("Формула в строке");
  expect(page.container.querySelector("textarea")!.value.startsWith("$x^2$")).toBe(true);
  await click("Предпросмотр");
  expect(page.container.querySelectorAll(".katex")).toHaveLength(1);
});

it("formats selected lines without rewriting later fences", async () => {
  const rest = "\n\n```chip\nФамилия: Тест\n```";
  page = await mountWorkspace(<Editor initial={"один\nдва" + rest} />);
  const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 8);
  await click("Нумерованный список");
  expect(input.value).toBe("1. один\n2. два" + rest);
  await click("Отменить");expect(input.value).toBe("один\nдва" + rest);
  input.setSelectionRange(0, 8);await click("Чеклист");
  expect(input.value).toBe("- [ ] один\n- [ ] два" + rest);
});

it("renders GFM and bounded LaTeX while rejecting raw HTML, script links and math external commands", async () => {
  page = await mountWorkspace(<MarkdownContent body={String.raw`~~Удалено~~

- [x] Готово

<script>alert("x")</script>

[Опасная ссылка](javascript:alert(1))

$\href{javascript:alert(1)}{unsafe}$

$\includegraphics{https://example.com/tracker.png}$

$\def\loop{\loop}\loop$`} />);
  expect(page.container.querySelector("del")?.textContent).toBe("Удалено");
  expect(page.container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true);
  expect(page.container.querySelector("script, iframe, object, img")).toBeNull();
  expect(page.container.querySelector('a[href^="javascript:"]')).toBeNull();
  expect(page.container.querySelector(".katex-error")).not.toBeNull();
});

it("keeps code literal and does not share LaTeX macro definitions between comments", async () => {
  page = await mountWorkspace(<>
    <section data-case="code"><MarkdownContent body={'`$x^2$`\n\n```latex\n$$x^2$$\n```'} /></section>
    <section data-case="first"><MarkdownContent body={String.raw`$\gdef\privateMacro{42}\privateMacro$`} /></section>
    <section data-case="second"><MarkdownContent body={String.raw`$\privateMacro$`} /></section>
  </>);
  expect(page.container.querySelector('[data-case="code"] .katex')).toBeNull();
  expect(page.container.querySelector('[data-case="first"] .katex')).not.toBeNull();
  const second = page.container.querySelector('[data-case="second"]')!;
  expect(second.querySelector("mtext")?.textContent).toBe("\\privateMacro");
  expect(second.textContent).not.toContain("42");
});
