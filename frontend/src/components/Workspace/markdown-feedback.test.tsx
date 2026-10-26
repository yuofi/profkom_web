// @vitest-environment jsdom
import { act, useState } from "react";
import { fireEvent } from "@testing-library/dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { MarkdownContent } from "./MarkdownContent";
import { mountWorkspace } from "../../test/workspace";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })));
afterEach(async () => { vi.useRealTimers();await page?.cleanup();page = undefined;vi.unstubAllGlobals(); });
function Editor({ initial = "текст" }: { initial?: string }) {
  const [body, setBody] = useState(initial);
  return <MarkdownEditor context="comment" value={body} onChange={setBody} />;
}
function button(label: string) { const found = page!.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);if (!found) throw Error(`Missing action ${label}`);return found; }
async function click(label: string) { await act(async () => button(label).click()); }
async function key(node: HTMLElement, key: string, extra = {}) { const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });await act(async () => node.dispatchEvent(event));return event; }

it("comment editor has no permanent help/footer and uses distinct link and undo/redo icons", async () => {
  page = await mountWorkspace(<Editor />);
  expect(page.container.querySelector("details, small")).toBeNull();
  expect(page.container.textContent).not.toContain("Markdown ·");
  for (const [label, icon] of [["Ссылка", "link"], ["Отменить", "undo"], ["Повторить", "redo"]]) expect(button(label).querySelector(`[data-editor-icon="${icon}"]`)).not.toBeNull();
  expect(page.container.querySelector('[data-icon="share"]')).toBeNull();
  expect(button("Ссылка").getAttribute("title")).toBeNull();
});
it("formatting hints appear after sustained hover, disappear on leave, and describe keyboard focus", async () => {
  page = await mountWorkspace(<Editor />);
  vi.useFakeTimers();const link = button("Ссылка");
  await act(async () => fireEvent.mouseOver(link));expect(page.container.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => { vi.advanceTimersByTime(649); });expect(page.container.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); });expect(page.container.querySelector('[role="tooltip"]')?.textContent).toContain("Ссылка");
  expect(link.getAttribute("aria-describedby")).toBe(page.container.querySelector('[role="tooltip"]')!.id);
  await act(async () => fireEvent.mouseOut(link));expect(page.container.querySelector('[role="tooltip"]')).toBeNull();
  await act(async () => link.focus());expect(page.container.querySelector('[role="tooltip"]')?.textContent).toContain("Cmd/Ctrl+K");
  await key(link, "Escape");expect(page.container.querySelector('[role="tooltip"]')).toBeNull();
});
it("heading menu selects six levels/plain text without stacking prefixes or touching later fences", async () => {
  const rest = "\n\n```chip\nИмя: пример\n```";
  page = await mountWorkspace(<Editor initial={"текст" + rest} />);
  const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 5);
  for (const level of [1, 6, 3, 3]) {
    await click("Заголовок");expect(page.container.querySelectorAll('[role="menuitem"]')).toHaveLength(7);
    await click(`Заголовок ${level}`);expect(input.value).toBe("#".repeat(level) + " текст" + rest);expect(document.activeElement).toBe(input);
  }
  await click("Заголовок");await click("Текст");expect(input.value).toBe("текст" + rest);
  await click("Отменить");expect(input.value).toBe("### текст" + rest);
});
it("menus support arrows/Escape/outside click and replace list styles with stable indentation", async () => {
  page = await mountWorkspace(<Editor initial={"первый\nвторой\nдальше"} />);
  const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 14);
  await key(button("Заголовок"), "ArrowDown");expect(document.activeElement?.getAttribute("aria-label")).toBe("Текст");
  await key(document.activeElement as HTMLElement, "End");expect(document.activeElement?.getAttribute("aria-label")).toBe("Заголовок 6");
  await key(document.activeElement as HTMLElement, "Escape");expect(page.container.querySelector('[role="menu"]')).toBeNull();expect(document.activeElement).toBe(button("Заголовок"));
  await click("Список");await click("Маркированный список");expect(input.value).toBe("- первый\n- второй\nдальше");
  await click("Список");await click("Нумерованный список");expect(input.value).toBe("1. первый\n2. второй\nдальше");
  await click("Список");await click("Увеличить отступ");expect(input.value).toBe("1. первый\n2. второй\nдальше");
  input.setSelectionRange(input.value.indexOf("2. второй"), input.value.indexOf("\nдальше"));
  await click("Список");await click("Увеличить отступ");expect(input.value).toBe("1. первый\n    1. второй\nдальше");
  await click("Список");await click("Уменьшить отступ");expect(input.value).toBe("1. первый\n2. второй\nдальше");
  await click("Список");await act(async () => fireEvent.pointerDown(input));expect(page.container.querySelector('[role="menu"]')).toBeNull();
});
it("physical shortcuts support heading/list/indent, ignore IME, and preserve plain Tab navigation", async () => {
  page = await mountWorkspace(<Editor />);const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 5);
  await key(input, "3", { code: "Digit3", metaKey: true, altKey: true });expect(input.value).toBe("### текст");
  await click("Отменить");input.setSelectionRange(0, 5);
  await key(input, "ь", { code: "KeyM", ctrlKey: true, shiftKey: true });expect(input.value).toBe("1. текст");
  const tab = await key(input, "Tab");expect(tab.defaultPrevented).toBe(true);expect(input.value).toBe("1. текст");
  await key(input, "Tab", { shiftKey: true });expect(input.value).toBe("1. текст");
  const before = input.value;await key(input, "2", { code: "Digit2", ctrlKey: true, altKey: true, isComposing: true });expect(input.value).toBe(before);
  await page.cleanup();page = await mountWorkspace(<Editor />);const plain = page.container.querySelector("textarea")!;plain.focus();plain.setSelectionRange(1, 1);
  expect((await key(plain, "Tab")).defaultPrevented).toBe(false);
});
it("checklist changes exact nested/duplicate/quoted/numbered source tokens and preserves literal code", async () => {
  const source = "```text\n- [ ] одинаково\n```\n\n- [ ] одинаково\n  - [x] одинаково\n\n> - [ ] цитата\n\n1. [X] номер\n";
  const changed = vi.fn();page = await mountWorkspace(<MarkdownContent body={source} onChecklistChange={changed} />);
  const boxes = [...page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];expect(boxes).toHaveLength(4);expect(boxes.every(box => !box.disabled)).toBe(true);
  await act(async () => boxes[1].click());expect(changed).toHaveBeenLastCalledWith(source.replace("  - [x] одинаково", "  - [ ] одинаково"));
  await act(async () => boxes[2].click());expect(changed).toHaveBeenLastCalledWith(source.replace("> - [ ] цитата", "> - [x] цитата"));
  await act(async () => boxes[3].click());expect(changed).toHaveBeenLastCalledWith(source.replace("1. [X] номер", "1. [ ] номер"));
  expect(page.container.querySelector("pre")!.textContent).toBe("- [ ] одинаково\n");
});
it("checklist stays read-only without explicit callback and while its save is pending", async () => {
  const changed = vi.fn();page = await mountWorkspace(<><MarkdownContent body="- [ ] тест" /><MarkdownContent body="- [x] тест" onChecklistChange={changed} checklistDisabled /></>);
  const boxes = [...page.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];expect(boxes.every(box => box.disabled)).toBe(true);
  await act(async () => boxes.forEach(box => box.click()));expect(changed).not.toHaveBeenCalled();
});
it("declared code languages are locally highlighted, markup escaped, and unknown languages stay plain", async () => {
  const source = '```typescript\nconst count: number = 42;\n```\n\n```python\ndef total(x):\n  return x + 1\n```\n\n```html\n<script>alert("literal")</script>\n```\n\n```unknown-synthetic\nconst plain = 1\n```';
  page = await mountWorkspace(<MarkdownContent body={source} />);
  expect(page.container.querySelector("code.language-typescript .hljs-keyword")?.textContent).toBe("const");
  expect(page.container.querySelector("code.language-python .hljs-keyword")?.textContent).toBe("def");
  expect(page.container.querySelector("code.language-html")?.textContent).toBe('<script>alert("literal")</script>\n');
  expect(page.container.querySelector("script")).toBeNull();expect(page.container.querySelector("code.language-unknown-synthetic span")).toBeNull();
});

it("indenting an ordered item produces a rendered nested list, preserves selection undo and outdents to its parent level", async () => {
  const source = "1. Первый\n2. Второй\n3. Третий";
  page = await mountWorkspace(<Editor initial={source} />);
  const input = page.container.querySelector("textarea")!;
  const start = source.indexOf("2. Второй"), end = source.indexOf("\n3.");input.focus();input.setSelectionRange(start, end);
  await click("Список");await click("Увеличить отступ");
  expect(input.value).toBe("1. Первый\n    1. Второй\n3. Третий");
  await click("Предпросмотр");
  const nested = page.container.querySelector("ol > li > ol");expect(nested).not.toBeNull();expect(nested?.textContent).toContain("Второй");
  expect(page.container.querySelector("pre")).toBeNull();
  await click("Редактирование");await click("Отменить");
  const restored = page.container.querySelector("textarea")!;expect(restored.value).toBe(source);expect([restored.selectionStart, restored.selectionEnd]).toEqual([start, end]);
  await click("Повторить");await click("Список");await click("Уменьшить отступ");expect(restored.value).toBe(source);
  await click("Предпросмотр");expect(page.container.querySelector("ol > li > ol")).toBeNull();expect(page.container.querySelectorAll("ol > li")).toHaveLength(3);
});
it("Tab nests selected ordered siblings starting at one and Shift-Tab restores their level", async () => {
  const source = "1. Первый\n2. Второй\n3. Третий";
  page = await mountWorkspace(<Editor initial={source} />);const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(source.indexOf("2."), source.length);
  await key(input, "Tab");expect(input.value).toBe("1. Первый\n    1. Второй\n    2. Третий");
  await click("Предпросмотр");expect(page.container.querySelectorAll("ol > li > ol > li")).toHaveLength(2);
  await click("Редактирование");const nestedInput = page.container.querySelector("textarea")!;
  await key(nestedInput, "Tab", { shiftKey: true });expect(nestedInput.value).toBe(source);
});
it("nesting preserves bullet and checked-task markers in the actual Markdown preview", async () => {
  const source = "- Родитель\n- [x] Готово\n- Третий";
  page = await mountWorkspace(<Editor initial={source} />);const input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(source.indexOf("- [x]"), source.indexOf("\n- Третий"));
  await click("Список");await click("Увеличить отступ");expect(input.value).toBe("- Родитель\n    - [x] Готово\n- Третий");
  await click("Предпросмотр");expect(page.container.querySelector("ul > li > ul > li")?.textContent).toContain("Готово");expect(page.container.querySelector<HTMLInputElement>("ul > li > ul input")?.checked).toBe(true);
  await click("Редактирование");await click("Список");await click("Уменьшить отступ");expect(page.container.querySelector("textarea")!.value).toBe(source);
});
it("a first list item cannot turn into a code block; plain text still has predictable two-space indentation", async () => {
  page = await mountWorkspace(<Editor initial={"1. Первый\n2. Второй"} />);let input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 9);
  await click("Список");await click("Увеличить отступ");expect(input.value).toBe("1. Первый\n2. Второй");
  await click("Предпросмотр");expect(page.container.querySelector("pre")).toBeNull();expect(page.container.querySelectorAll("ol > li")).toHaveLength(2);
  await page.cleanup();page = await mountWorkspace(<Editor initial="Строка" />);input = page.container.querySelector("textarea")!;input.focus();input.setSelectionRange(0, 6);
  await click("Список");await click("Увеличить отступ");expect(input.value).toBe("  Строка");
  await click("Список");await click("Уменьшить отступ");expect(input.value).toBe("Строка");
});
