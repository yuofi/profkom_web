// @vitest-environment jsdom
import { act, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MarkdownEditor } from "./MarkdownEditor";
import { ActionForm } from "./ActionForm";
import { mountWorkspace, settle } from "../../test/workspace";
let page: Awaited<ReturnType<typeof mountWorkspace>> | undefined;
beforeEach(() => vi.stubGlobal("matchMedia", (media: string) => ({ matches: false, media, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })));
afterEach(async () => { await page?.cleanup(); page = undefined; vi.unstubAllGlobals(); });
const custom = "\n\n```gallery\n/avatars/sun.svg | Подпись\n```\n\n```chip\nФамилия: Пример\nИмя: Тест\n```\n";
function Editor({ save = async () => {} }: { save?: () => Promise<void> }) {
  const [body, setBody] = useState("Текст" + custom);
  return <ActionForm fields={[]} externalState={body} onSubmit={save}><MarkdownEditor value={body} onChange={setBody} /></ActionForm>;
}
async function key(input: HTMLTextAreaElement, key: string, options = {}) {
  const event = new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...options });
  await act(async () => input.dispatchEvent(event));
  return event;
}
it("formats selection with Cmd/Ctrl shortcuts, preserves fences and restores cursor", async () => {
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!; input.focus(); input.setSelectionRange(0, 5);
  await key(input, "b", { ctrlKey: false, metaKey: true });
  expect(input.value).toBe("**Текст**" + custom); expect(input.selectionStart).toBe(2); expect(input.selectionEnd).toBe(7);
  await key(input, "z"); expect(input.value).toBe("Текст" + custom);
  await key(input, "z", { shiftKey: true }); expect(input.value).toBe("**Текст**" + custom);
});
it("toolbar and keyboard use the same insertion and preview shows draft", async () => {
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!; input.focus(); input.setSelectionRange(0, 5);
  const italic = [...page.container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "Курсив")!;
  await act(async () => italic.click()); expect(input.value).toBe("*Текст*" + custom);
  const preview = [...page.container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === "Предпросмотр")!;
  await act(async () => preview.click()); expect(page.container.querySelector("textarea")).toBeNull();
  expect(page.container.querySelector("em")!.textContent).toBe("Текст");
});
it("Cmd/Ctrl S invokes the draft save once", async () => {
  const save = vi.fn(async () => {}); page = await mountWorkspace(<Editor save={save} />);
  await key(page.container.querySelector("textarea")!, "s"); await settle(); expect(save).toHaveBeenCalledTimes(1);
});

it.each([
  ["и", "KeyB", "**Текст**"],
  ["ш", "KeyI", "*Текст*"],
  ["л", "KeyK", "[Текст](https://example.com)"],
])("formats with the physical shortcut in a Russian layout: %s", async (letter, code, expected) => {
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!; input.focus(); input.setSelectionRange(0, 5);
  const event = await key(input, letter, { code, ctrlKey: false, metaKey: true });
  expect(input.value).toBe(expected + custom);
  expect(event.defaultPrevented).toBe(true);
});
it("Russian-layout save submits the draft exactly once and prevents browser Save", async () => {
  const save = vi.fn(async () => {}); page = await mountWorkspace(<Editor save={save} />);
  const event = await key(page.container.querySelector("textarea")!, "ы", { code: "KeyS" });
  await settle();
  expect(save).toHaveBeenCalledTimes(1);
  expect(event.defaultPrevented).toBe(true);
});
it("does not treat composing input as a formatting or save shortcut", async () => {
  const save = vi.fn(async () => {}); page = await mountWorkspace(<Editor save={save} />);
  const input = page.container.querySelector("textarea")!; input.setSelectionRange(0, 5);
  const formatting = await key(input, "b", { code: "KeyB", isComposing: true });
  const saving = await key(input, "s", { code: "KeyS", isComposing: true });
  await settle();
  expect(input.value).toBe("Текст" + custom);
  expect(save).not.toHaveBeenCalled();
  expect(formatting.defaultPrevented).toBe(false);
  expect(saving.defaultPrevented).toBe(false);
});
it("undo restores the caret before ordinary text input", async () => {
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!; input.focus(); input.setSelectionRange(0, 0);
  await act(async () => {
    input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: "Я", bubbles: true, cancelable: true }));
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "ЯТекст" + custom);
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new InputEvent("input", { inputType: "insertText", data: "Я", bubbles: true }));
  });
  expect(input.value).toBe("ЯТекст" + custom);
  await key(input, "z");
  expect(input.value).toBe("Текст" + custom);
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(0);
});
it("Russian-layout undo and redo restore the same Markdown draft", async () => {
  page = await mountWorkspace(<Editor />);
  const input = page.container.querySelector("textarea")!; input.focus(); input.setSelectionRange(0, 5);
  await key(input, "и", { code: "KeyB" });
  await key(input, "я", { code: "KeyZ" });
  expect(input.value).toBe("Текст" + custom);
  await key(input, "н", { code: "KeyY" });
  expect(input.value).toBe("**Текст**" + custom);
});
