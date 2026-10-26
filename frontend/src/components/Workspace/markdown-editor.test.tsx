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
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true, ...options })));
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
  const italic = [...page.container.querySelectorAll("button")].find((element) => element.textContent === "Курсив")!;
  await act(async () => italic.click()); expect(input.value).toBe("*Текст*" + custom);
  const preview = [...page.container.querySelectorAll("button")].find((element) => element.textContent === "Предпросмотр")!;
  await act(async () => preview.click()); expect(page.container.querySelector("textarea")).toBeNull();
  expect(page.container.querySelector("em")!.textContent).toBe("Текст");
});
it("Cmd/Ctrl S invokes the draft save once", async () => {
  const save = vi.fn(async () => {}); page = await mountWorkspace(<Editor save={save} />);
  await key(page.container.querySelector("textarea")!, "s"); await settle(); expect(save).toHaveBeenCalledTimes(1);
});
